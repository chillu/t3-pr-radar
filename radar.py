#!/usr/bin/env python3
"""pr-radar: a local to-do list built from open pull requests across a GitHub org.

Two halves, two cadences:
  * refresh (no model): sweep every open PR in the org, score it against the user's profile,
    diff it against the last refresh and record events (CI passed, review requested, ...).
    The local server runs this every few minutes; the page's Refresh button runs it on demand.
  * triage (Claude): read T3 threads and review comments for PRs that moved, write a note per PR,
    choose the picks. Driven by the pr-radar skill; writes through the note/picks subcommands.

Everything lives in users/<login>/radar.db (SQLite, gitignored). profile.json holds the scoring
weights and config.json the rhythm, refresh cadence and notifications.

Subcommands: refresh, serve, todo, ingest-threads, link-thread, thread-scan, note, picks,
board, rhythm, stats. Run `radar.py <cmd> --help`.
"""
import argparse
import datetime as dt
import fnmatch
import http.server
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
from collections import Counter, defaultdict
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.abspath(__file__))


def now():
    return dt.datetime.now(dt.timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(ts):
    return dt.datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None


def days_since(ts, ref=None):
    t = parse(ts)
    return round(((ref or now()) - t).total_seconds() / 86400, 1) if t else None


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


# ---------------------------------------------------------------- storage

SCHEMA = """
create table if not exists prs (
  key text primary key,          -- Owner/repo#123, GitHub's casing
  open integer not null,
  updated_at text,
  item text not null,            -- JSON: the PR with its computed signals
  raw text,                      -- JSON: the flattened GitHub PR the item was scored from
  fp text,                       -- fingerprint from the light poll; a change triggers a full fetch
  first_seen text, last_seen text
);
create table if not exists events (
  id integer primary key autoincrement,
  at text not null, key text not null, kind text not null, text text not null
);
create table if not exists threads (
  key text not null,             -- lowercased owner/repo#123
  thread_id text not null, title text, link text, updated_at text, status text,
  primary key (key, thread_id)
);
create table if not exists notes (
  key text primary key, basis text, next text, left_ text, question text, why text, at text
);
create table if not exists triage (
  key text primary key, action text not null, until text, at text not null
);
create table if not exists meta (k text primary key, v text);
create table if not exists sweeps (
  id integer primary key autoincrement,
  started_at text not null, finished_at text, reason text, status text,  -- running | ok | error
  summary text, cost_usd real, turns integer, log_path text
);
"""


class User:
    def __init__(self, login):
        self.login = login
        self.dir = os.path.join(ROOT, "users", login)
        self.profile_path = os.path.join(self.dir, "profile.json")
        self.config_path = os.path.join(self.dir, "config.json")
        self.db_path = os.path.join(self.dir, "radar.db")
        if not os.path.isdir(self.dir):
            sys.exit(f"no user folder at {self.dir}; run the pr-radar-setup skill first")

    @property
    def profile(self):
        return load_json(self.profile_path, None) or sys.exit(f"missing {self.profile_path}")

    @property
    def config(self):
        return load_json(self.config_path, {})

    def db(self):
        con = sqlite3.connect(self.db_path, timeout=30)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        return con


def meta_get(con, k, default=None):
    r = con.execute("select v from meta where k=?", (k,)).fetchone()
    return json.loads(r["v"]) if r else default


def meta_set(con, k, v):
    con.execute("insert into meta(k, v) values(?, ?) on conflict(k) do update set v=excluded.v",
                (k, json.dumps(v)))


# ---------------------------------------------------------------- GitHub

def gql(query, **variables):
    args = ["gh", "api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        if v is not None:
            args += ["-F" if isinstance(v, int) else "-f", f"{k}={v}"]
    out = subprocess.run(args, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"gh api graphql failed: {out.stderr.strip()[:500]}")
    data = json.loads(out.stdout)
    if data.get("errors"):
        raise RuntimeError(f"graphql errors: {json.dumps(data['errors'])[:500]}")
    return data["data"]


def search_all(q, fields, page=20):
    query = """
    query($q: String!, $after: String, $n: Int!) {
      rateLimit { cost remaining }
      search(query: $q, type: ISSUE, first: $n, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { %s } }
      }
    }""" % fields
    after, nodes, cost, remaining = None, [], 0, None
    while True:
        d = gql(query, q=q, after=after, n=page)
        cost += d["rateLimit"]["cost"]
        remaining = d["rateLimit"]["remaining"]
        nodes += [n for n in d["search"]["nodes"] if n]
        if not d["search"]["pageInfo"]["hasNextPage"] or len(nodes) >= 1000:
            return nodes, {"cost": cost, "remaining": remaining}
        after = d["search"]["pageInfo"]["endCursor"]


LIGHT_FIELDS = """
  id number updatedAt isDraft mergeable reviewDecision headRefOid
  repository { nameWithOwner }
  author { login __typename }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
"""

FULL_EVERY_HOURS = 6  # a full fetch now and then catches anything the fingerprint misses


def fingerprint(n):
    commit = (n["commits"]["nodes"] or [{}])[0].get("commit") or {}
    return json.dumps([n["updatedAt"], n["isDraft"], n["mergeable"], n["reviewDecision"], n["headRefOid"],
                       (commit.get("statusCheckRollup") or {}).get("state")])


def fetch_full(ids):
    """Full PR details for node ids, 20 per query."""
    out = []
    for i in range(0, len(ids), 20):
        batch = ",".join(json.dumps(x) for x in ids[i:i + 20])
        d = gql("query { rateLimit { cost remaining } nodes(ids: [%s]) { ... on PullRequest { %s } } }"
                % (batch, PR_FIELDS))
        out += [n for n in d["nodes"] if n]
    return out


PR_FIELDS = """
  id number title url isDraft createdAt updatedAt additions deletions changedFiles
  mergeable reviewDecision headRefOid
  repository { nameWithOwner }
  author { login __typename }
  labels(first: 10) { nodes { name } }
  reviewRequests(first: 10) { nodes { requestedReviewer {
    ... on User { login } ... on Team { slug } } } }
  reviews(last: 30) { nodes { author { login } state submittedAt } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  reviewThreads(first: 60) { nodes { isResolved
    comments(last: 1) { nodes { author { login } createdAt } } } }
  comments(last: 10) { nodes { author { login } createdAt } }
  files(first: 100) { nodes { path } }
  readyAt: timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) {
    nodes { ... on ReadyForReviewEvent { createdAt } } }
"""

BOT = re.compile(r"\[bot\]$|^(dependabot|renovate|github-actions|copilot)", re.I)


def is_bot(login):
    return bool(login and BOT.search(login))


def flatten(n):
    commit = (n["commits"]["nodes"] or [{}])[0].get("commit") or {}
    users, teams = [], []
    for r in n["reviewRequests"]["nodes"]:
        rr = r.get("requestedReviewer") or {}
        if "login" in rr:
            users.append(rr["login"])
        elif "slug" in rr:
            teams.append(rr["slug"])
    ready = (n["readyAt"]["nodes"] or [{}])[0].get("createdAt")
    return {
        "key": f"{n['repository']['nameWithOwner']}#{n['number']}",
        "repo": n["repository"]["nameWithOwner"],
        "number": n["number"],
        "title": n["title"],
        "url": n["url"],
        "author": (n["author"] or {}).get("login"),
        "authorIsBot": (n["author"] or {}).get("__typename") == "Bot",
        "draft": n["isDraft"],
        "createdAt": n["createdAt"],
        "updatedAt": n["updatedAt"],
        "readyAt": ready or n["createdAt"],
        "lastCommitAt": commit.get("committedDate"),
        "headSha": n["headRefOid"],
        "size": n["additions"] + n["deletions"],
        "changedFiles": n["changedFiles"],
        "mergeable": n["mergeable"],
        "decision": n["reviewDecision"],
        "ci": (commit.get("statusCheckRollup") or {}).get("state"),
        "labels": [l["name"] for l in n["labels"]["nodes"]],
        "requestedUsers": users,
        "requestedTeams": teams,
        "reviews": [{"by": (r["author"] or {}).get("login"), "state": r["state"], "at": r["submittedAt"]}
                    for r in n["reviews"]["nodes"]],
        "threads": [{"resolved": t["isResolved"],
                     "lastBy": ((t["comments"]["nodes"] or [{}])[0].get("author") or {}).get("login"),
                     "lastAt": (t["comments"]["nodes"] or [{}])[0].get("createdAt")}
                    for t in n["reviewThreads"]["nodes"]],
        "comments": [{"by": (c["author"] or {}).get("login"), "at": c["createdAt"]}
                     for c in n["comments"]["nodes"]],
        "files": [f["path"] for f in n["files"]["nodes"]],
    }


# ---------------------------------------------------------------- scoring

def human_reviews(pr):
    return [r for r in pr["reviews"] if r["by"] and r["by"] != pr["author"] and not is_bot(r["by"])]


def last_activity_by_others(pr):
    a = pr["author"]
    stamps = [r["at"] for r in human_reviews(pr)]
    stamps += [t["lastAt"] for t in pr["threads"] if t["lastBy"] not in (a, None) and not is_bot(t["lastBy"])]
    stamps += [c["at"] for c in pr["comments"] if c["by"] not in (a, None) and not is_bot(c["by"])]
    stamps = [s for s in stamps if s]
    return max(stamps) if stamps else None


QUICK_ACTIONS = {"Approved: merge it", "Ask someone to review", "Nudge your reviewer",
                 "Abandoned? Close or revive", "Waiting on review"}
DEEP_LINES, DEEP_FILES = 300, 15
STALL_WINDOW = 45  # days; older PRs are abandoned rather than stalled


def mine_signals(pr, me):
    open_threads = [t for t in pr["threads"] if not t["resolved"]]
    waiting_on_me = [t for t in open_threads if t["lastBy"] and t["lastBy"] != me]
    idle = days_since(pr["updatedAt"])
    reviewed = bool(human_reviews(pr))
    flags = []
    if pr["mergeable"] == "CONFLICTING":
        flags.append("merge conflict")
    if pr["ci"] in ("FAILURE", "ERROR"):
        flags.append("CI failing")
    if waiting_on_me:
        flags.append(f"{len(waiting_on_me)} review thread(s) waiting on you")
    if pr["decision"] == "CHANGES_REQUESTED":
        flags.append("changes requested")
    if idle and idle > 60:
        action, urgency = "Abandoned? Close or revive", 15
    elif pr["draft"]:
        action, urgency = ("Stale draft: finish or close", 35) if idle and idle > 14 else ("Draft in progress", 30)
    elif pr["decision"] == "CHANGES_REQUESTED" or waiting_on_me:
        action, urgency = "Answer review comments", 90
    elif pr["mergeable"] == "CONFLICTING":
        action, urgency = "Resolve the merge conflict", 80
    elif pr["ci"] in ("FAILURE", "ERROR"):
        action, urgency = "Fix failing CI", 75
    elif pr["decision"] == "APPROVED":
        action, urgency = "Approved: merge it", 95
    elif not pr["requestedUsers"] and not pr["requestedTeams"] and not reviewed:
        action, urgency = "Ask someone to review", 70
    elif idle and idle > 3:
        action, urgency = "Nudge your reviewer", 60
    else:
        action, urgency = "Waiting on review", 20
    big = pr["size"] >= DEEP_LINES or pr["changedFiles"] >= DEEP_FILES
    effort = "quick" if action in QUICK_ACTIONS else ("deep" if big or action == "Answer review comments" else "quick")
    return {
        "action": action, "urgency": urgency, "flags": flags, "effort": effort,
        "openThreads": len(open_threads), "threadsWaitingOnMe": len(waiting_on_me),
        "idleDays": idle, "ageDays": days_since(pr["createdAt"]),
        "reviewers": sorted({r["by"] for r in human_reviews(pr)}),
        "requested": pr["requestedUsers"] + ["@" + t for t in pr["requestedTeams"]],
        "lastOtherAt": last_activity_by_others(pr),
    }


def area_matches(pr, profile):
    hits, title = [], pr["title"].lower()
    for area in profile.get("areas", []):
        globs = area.get("paths", [])
        n = sum(1 for f in pr["files"] if any(fnmatch.fnmatch(f, g) for g in globs))
        kw = any(k.lower() in title for k in area.get("keywords", []))
        if n or kw:
            frac = n / max(1, len(pr["files"]))
            hits.append((area["name"], area.get("weight", 1) * (0.5 * kw + min(1.0, 0.3 + frac) * bool(n))))
    return sorted(hits, key=lambda h: -h[1])


def review_signals(pr, me, profile):
    my_reviews = [r for r in pr["reviews"] if r["by"] == me]
    my_last = max((r["at"] for r in my_reviews), default=None)
    pushed_since = bool(my_last and pr["lastCommitAt"] and pr["lastCommitAt"] > my_last)
    approvals = sorted({r["by"] for r in human_reviews(pr) if r["state"] == "APPROVED"})
    areas = area_matches(pr, profile)
    relevance = round(sum(w for _, w in areas), 2)
    people_w = profile.get("people", {}).get(pr["author"], 0)
    requested_me = me in pr["requestedUsers"]
    requested_team = sorted(set(profile.get("teams", [])) & set(pr["requestedTeams"]))
    waiting = days_since(last_activity_by_others(pr) or pr["readyAt"])
    score = (100 * requested_me + 35 * bool(requested_team) + (30 if pushed_since else 0)
             + 12 * relevance + 8 * profile.get("repos", {}).get(pr["repo"], 0) + 6 * people_w
             + min(15, 2 * (waiting or 0)) + (5 if pr["size"] < 200 else 0)
             - (25 if approvals else 0) - (40 if my_reviews and not pushed_since else 0))
    reasons = []
    if requested_me:
        reasons.append("review requested from you")
    if requested_team:
        reasons.append("requested from " + ", ".join(requested_team))
    if pushed_since:
        reasons.append("new commits since your review")
    if areas:
        reasons.append("touches " + ", ".join(a for a, _ in areas[:3]))
    if people_w >= 0.6:
        reasons.append(f"you often review {pr['author']}")
    return {"score": round(score, 1), "requestedMe": requested_me, "requestedTeams": requested_team,
            "reviewedByMe": bool(my_reviews), "pushedSinceMyReview": pushed_since, "approvals": approvals,
            "areas": [a for a, _ in areas], "relevance": relevance, "waitingDays": waiting, "reasons": reasons}


def team_signals(pr):
    """Close to done but stalled, or None."""
    if pr["draft"] or pr["mergeable"] == "CONFLICTING" or pr["ci"] in ("FAILURE", "ERROR"):
        return None
    idle = days_since(pr["updatedAt"])
    if idle is not None and idle > STALL_WINDOW:
        return None
    reviewed = bool(human_reviews(pr))
    waiting = days_since(last_activity_by_others(pr) or pr["readyAt"])
    if pr["decision"] == "APPROVED" and idle and idle >= 2:
        return {"stall": "Approved and green, not merged", "days": idle, "score": 50 + 3 * min(idle, 20)}
    if not reviewed and waiting and waiting >= 3:
        return {"stall": "No review yet", "days": waiting, "score": 45 + 3 * min(waiting, 20)}
    if reviewed and pr["decision"] != "CHANGES_REQUESTED" and waiting and waiting >= 5:
        return {"stall": "Reviewed, then quiet", "days": waiting, "score": 25 + 2 * min(waiting, 20)}
    return None


def score_pr(pr, me, profile):
    """The stored item: slim PR fields plus whichever signals apply to this user."""
    keep = ("key", "repo", "number", "title", "url", "author", "draft", "createdAt", "updatedAt", "ci",
            "decision", "mergeable", "size", "changedFiles", "labels", "headSha")
    item = {k: pr[k] for k in keep}
    if pr["author"] == me:
        item["mine"] = mine_signals(pr, me)
        return item
    rs = review_signals(pr, me, profile)
    big = pr["size"] >= DEEP_LINES or pr["changedFiles"] >= DEEP_FILES
    rs["effort"] = "deep" if big else "quick"
    item["review"] = rs
    ts = team_signals(pr)
    if ts:
        ts["effort"] = "quick" if ts["stall"].startswith("Approved") else rs["effort"]
        ts["areas"] = rs["areas"]
    item["team"] = ts
    return item


# ---------------------------------------------------------------- events

def diff_events(old, new, me, profile):
    """Human-sized changes between two refreshes of one PR, as (kind, text)."""
    ev = []
    if old is None:
        if "mine" in new:
            ev.append(("opened", "You opened this PR"))
        elif new["review"]["requestedMe"]:
            ev.append(("review_requested", f"{new['author']} asked you to review"))
        elif new["review"]["requestedTeams"]:
            ev.append(("team_requested", f"{new['author']} asked @{', @'.join(new['review']['requestedTeams'])}"))
        return ev
    if new["ci"] != old["ci"] and new["ci"] in ("SUCCESS", "FAILURE", "ERROR"):
        if "mine" in new or new.get("review", {}).get("reviewedByMe"):
            ev.append(("ci_passed" if new["ci"] == "SUCCESS" else "ci_failed",
                       "CI passed" if new["ci"] == "SUCCESS" else "CI failed"))
    if "mine" in new:
        m, o = new["mine"], old.get("mine") or {}
        if new["decision"] != old["decision"] and new["decision"] in ("APPROVED", "CHANGES_REQUESTED"):
            who = ", ".join(m["reviewers"]) or "a reviewer"
            ev.append(("approved", f"Approved by {who}") if new["decision"] == "APPROVED"
                      else ("changes_requested", f"Changes requested by {who}"))
        if m["threadsWaitingOnMe"] > o.get("threadsWaitingOnMe", 0):
            ev.append(("comments", f"{m['threadsWaitingOnMe']} review thread(s) waiting on you"))
        elif (m.get("lastOtherAt") or "") > (o.get("lastOtherAt") or "") and new["decision"] == old["decision"]:
            ev.append(("activity", "New comment or review"))
        if new["mergeable"] == "CONFLICTING" and old["mergeable"] != "CONFLICTING":
            ev.append(("conflict", "Merge conflict"))
        if old["draft"] and not new["draft"]:
            ev.append(("ready", "Marked ready for review"))
    else:
        r, o = new["review"], old.get("review") or {}
        if r["requestedMe"] and not o.get("requestedMe"):
            ev.append(("review_requested", f"{new['author']} asked you to review"))
        elif r["requestedTeams"] and not o.get("requestedTeams"):
            ev.append(("team_requested", f"{new['author']} asked @{', @'.join(r['requestedTeams'])}"))
        if r["pushedSinceMyReview"] and not o.get("pushedSinceMyReview"):
            ev.append(("pushed", "New commits since your review"))
    return ev


def closed_state(key):
    owner_repo, num = key.split("#")
    owner, repo = owner_repo.split("/")
    try:
        d = gql("query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){state}}}",
                o=owner, r=repo, n=int(num))
        return d["repository"]["pullRequest"]["state"]
    except Exception:
        return "CLOSED"


def notify(title, text):
    subprocess.run(["osascript", "-e",
                    f'display notification {json.dumps(text)} with title {json.dumps(title)} sound name "Glass"'],
                   capture_output=True)


# ---------------------------------------------------------------- refresh

def refresh(user, send_notifications=False, full=False):
    """Light poll every open PR's fingerprint (about 2 GraphQL points), fetch full details only
    for PRs whose fingerprint moved, rescore everything, diff, record events."""
    profile, config = user.profile, user.config
    me, org = profile["login"], profile["org"]
    con = user.db()
    for col in ("raw", "fp"):  # databases created before these columns existed
        try:
            con.execute(f"alter table prs add column {col} text")
        except sqlite3.OperationalError:
            pass
    last_full = meta_get(con, "lastFullRefresh")
    full = full or not last_full or (now() - parse(last_full)).total_seconds() > FULL_EVERY_HOURS * 3600
    light, rate = search_all(f"org:{org} is:pr is:open archived:false", LIGHT_FIELDS, page=100)
    t = iso(now())
    ignore = set(profile.get("ignoreRepos", []))
    stored = {r["key"]: r for r in con.execute("select key, item, raw, fp from prs where open=1")}
    bots, todo_ids, fps = Counter(), [], {}
    for n in light:
        repo = n["repository"]["nameWithOwner"]
        if repo in ignore:
            continue
        a = n["author"] or {}
        if a.get("__typename") == "Bot" or is_bot(a.get("login")):
            bots[repo] += 1
            continue
        key = f"{repo}#{n['number']}"
        fps[key] = fingerprint(n)
        row = stored.get(key)
        if full or row is None or row["raw"] is None or row["fp"] != fps[key]:
            todo_ids.append(n["id"])
    fetched = {}
    for n in fetch_full(todo_ids):
        pr = flatten(n)
        fetched[pr["key"]] = pr
    first_refresh = not meta_get(con, "lastRefresh")
    new_events = []
    for key, fp in fps.items():
        row = stored.get(key)
        pr = fetched.get(key) or (json.loads(row["raw"]) if row and row["raw"] else None)
        if pr is None:
            continue
        item = score_pr(pr, me, profile)
        prev = json.loads(row["item"]) if row else None
        if not first_refresh:
            for kind, text in diff_events(prev, item, me, profile):
                new_events.append((t, key, kind, text, item))
        con.execute("""insert into prs(key, open, updated_at, item, raw, fp, first_seen, last_seen)
                       values(?,1,?,?,?,?,?,?)
                       on conflict(key) do update set open=1, updated_at=excluded.updated_at, item=excluded.item,
                       raw=excluded.raw, fp=excluded.fp, last_seen=excluded.last_seen""",
                    (key, item["updatedAt"], json.dumps(item), json.dumps(pr), fp, t, t))
    for key, row in stored.items():
        if key in fps:
            continue
        con.execute("update prs set open=0, last_seen=? where key=?", (t, key))
        prev = json.loads(row["item"])
        if "mine" in prev:
            state = closed_state(key)
            new_events.append((t, key, state.lower(), "Merged" if state == "MERGED" else "Closed", prev))
    for at, key, kind, text, _ in new_events:
        con.execute("insert into events(at, key, kind, text) values(?,?,?,?)", (at, key, kind, text))
    con.execute("delete from events where at < ?", (iso(now() - dt.timedelta(days=14)),))
    meta_set(con, "lastRefresh", t)
    if full:
        meta_set(con, "lastFullRefresh", t)
    meta_set(con, "botPRsByRepo", dict(bots.most_common()))
    con.commit()
    con.close()
    if send_notifications:
        wanted = set(config.get("notify", {}).get("kinds", []))
        for _, key, kind, text, item in new_events:
            if kind in wanted:
                notify(f"{key.split('/')[1]}: {text}", item["title"])
    return {"open": len(light), "full": full, "fetched": len(todo_ids),
            "events": [(k, kind, text) for _, k, kind, text, _ in new_events], "remaining": rate["remaining"]}


def cmd_refresh(a):
    out = refresh(User(a.user), send_notifications=a.notify, full=a.full)
    print(json.dumps(out, indent=2))


# ---------------------------------------------------------------- rhythm

def rhythm_now(config, at=None):
    """The user's current block from config.rhythm: deep, quick, or off (with the next block)."""
    r = config.get("rhythm")
    if not r:
        return None
    local = (at or now()).astimezone(ZoneInfo(r["timezone"]))
    hm, workdays = local.strftime("%H:%M"), r.get("workdays", [1, 2, 3, 4, 5])
    blocks = sorted(r.get("blocks", []), key=lambda b: b["from"])
    if local.isoweekday() in workdays:
        for b in blocks:
            if b["from"] <= hm < b["to"]:
                return {**b, "localTime": local.strftime("%a %H:%M")}
    for add in range(0, 8):
        day = local + dt.timedelta(days=add)
        if day.isoweekday() in workdays:
            for b in blocks:
                if add > 0 or b["from"] > hm:
                    return {"mode": "off", "label": "Outside working hours",
                            "localTime": local.strftime("%a %H:%M"), "next": {**b, "day": day.strftime("%a")}}
    return {"mode": "off", "label": "Outside working hours", "localTime": local.strftime("%a %H:%M")}


def cmd_rhythm(a):
    print(json.dumps(rhythm_now(User(a.user).config), indent=2))


# ---------------------------------------------------------------- board

def hidden(item, tri):
    if not tri:
        return False
    if tri["action"] == "snooze":
        return (tri["until"] or "") > iso(now())
    if tri["action"] == "done":
        return item["updatedAt"] <= tri["at"]
    return False


def t3_thread_url(environment_id, thread_id):
    """A link the T3 Code desktop app opens straight to the thread (t3code://threads/<env>/<thread>)."""
    q = lambda v: urllib.parse.quote(v, safe="")
    return f"t3code://threads/{q(environment_id)}/{q(thread_id)}"


def build_board(user):
    profile, config = user.profile, user.config
    con = user.db()
    rows = [json.loads(r["item"]) for r in con.execute("select item from prs where open=1")]
    threads = defaultdict(list)
    default_env = config.get("t3", {}).get("environmentId")
    for r in con.execute("select * from threads order by updated_at desc"):
        m = re.search(r"t3-thread://v2/([^/]+)/", r["link"] or "")
        env = m.group(1) if m else default_env
        threads[r["key"]].append({"id": r["thread_id"], "title": r["title"], "link": r["link"],
                                  "updatedAt": r["updated_at"], "status": r["status"],
                                  "openUrl": t3_thread_url(env, r["thread_id"]) if env else None})
    notes = {r["key"]: {"basis": r["basis"], "next": r["next"], "left": r["left_"], "question": r["question"],
                        "why": r["why"], "at": r["at"]} for r in con.execute("select * from notes")}
    tri = {r["key"]: dict(r) for r in con.execute("select * from triage")}
    last_seen = meta_get(con, "lastViewed", "")
    events = [dict(r) | {"new": r["at"] > last_seen} for r in
              con.execute("select * from events order by id desc limit 60")]
    by_key = {i["key"]: i for i in rows}
    for e in events:
        it = by_key.get(e["key"])
        e["title"] = it["title"] if it else ""
        e["url"] = it["url"] if it else f"https://github.com/{e['key'].replace('#', '/pull/')}"

    def flat(item, section, signals):
        out = {k: v for k, v in item.items() if k not in ("mine", "review", "team")}
        out.update(signals)
        out["section"] = section
        out["id"] = re.sub(r"[^A-Za-z0-9_\-.]", "_", item["key"])
        out["note"] = notes.get(item["key"])
        out["threads"] = threads.get(item["key"].lower(), [])
        out["triage"] = tri.get(item["key"])
        out["hidden"] = hidden(item, tri.get(item["key"]))
        out["events"] = [e["text"] for e in events if e["key"] == item["key"]][:3]
        return out

    mine = sorted((flat(i, "mine", i["mine"]) for i in rows if "mine" in i), key=lambda x: -x["urgency"])
    candidates = sorted((flat(i, "review", i["review"]) for i in rows if "review" in i and not i["draft"]),
                        key=lambda x: -x["score"])
    top = [r for r in candidates if r["score"] >= profile.get("minReviewScore", 20)][: profile.get("maxReview", 10)]
    top_keys = {r["key"] for r in top}
    # PRs you're already part of stay on the list even when the score dropped them
    involved = [r for r in candidates if r["key"] not in top_keys and (r["requestedMe"] or r["reviewedByMe"])]
    review = top + involved
    for r in review:
        r["participation"] = ("requested" if r["requestedMe"] else "reviewed" if r["reviewedByMe"]
                              else "team" if r["requestedTeams"] else "suggested")
    rkeys = {r["key"] for r in review}
    team = sorted((flat(i, "team", i["team"]) for i in rows
                   if i.get("team") and i["key"] not in rkeys), key=lambda x: -x["score"])[: profile.get("maxTeam", 8)]
    picks = meta_get(con, "picks", [])
    for p in picks:
        p["id"] = re.sub(r"[^A-Za-z0-9_\-.]", "_", p["key"])
    board = {
        "login": profile["login"], "org": profile["org"],
        "refreshedAt": meta_get(con, "lastRefresh"), "triagedAt": meta_get(con, "triagedAt"),
        "headline": meta_get(con, "headline", ""), "picks": picks,
        "rhythm": rhythm_now(config),
        "refreshMinutes": refresh_minutes(config),
        "totals": {"open": len(rows), "mine": len(mine)},
        "botPRsByRepo": meta_get(con, "botPRsByRepo", {}),
        "events": events, "lastViewed": last_seen,
        "sweeps": [dict(r) for r in con.execute("select * from sweeps order by id desc limit 8")],
        "mine": mine, "review": review, "team": team,
    }
    con.close()
    return board


def cmd_board(a):
    b = build_board(User(a.user))
    if a.json:
        print(json.dumps(b, indent=2))
        return
    print(board_markdown(b))


def board_markdown(b):
    def line(i):
        tag = i.get("action") or i.get("stall") or ", ".join(i.get("reasons", [])[:2])
        bits = [f"[{i['repo'].split('/')[1]}#{i['number']}]({i['url']}) {i['title']}", f"*{tag}* [{i.get('effort')}]"]
        n = i.get("note") or {}
        for k in ("question", "next", "left", "why"):
            if n.get(k):
                bits.append(("Waiting on you: " if k == "question" else "") + n[k])
        return "- " + " — ".join(bits)

    out = [f"# PR radar for {b['login']}", f"Refreshed {b['refreshedAt']}, triaged {b['triagedAt']}.", ""]
    rh = b.get("rhythm") or {}
    if rh:
        out += [f"Now: {rh.get('label')} ({rh.get('localTime')})", ""]
    if b["headline"]:
        out += [b["headline"], ""]
    for sec, title in (("mine", "Your pull requests"), ("review", "Reviewing"),
                       ("team", "Stalled near the finish")):
        items = [i for i in b[sec] if not i["hidden"]]
        out += [f"## {title} ({len(items)})"] + ([line(i) for i in items] or ["- nothing right now"]) + [""]
    return "\n".join(out)


# ---------------------------------------------------------------- triage-side bookkeeping (the agent's writes)

def cmd_todo(a):
    """Own PRs whose PR or linked thread moved since their note was written."""
    user = User(a.user)
    b = build_board(user)
    todo = []
    for pr in b["mine"]:
        basis = pr["updatedAt"] + "|" + ",".join(sorted(t["updatedAt"] or "" for t in pr["threads"]))
        if (pr["note"] or {}).get("basis") != basis:
            todo.append({"key": pr["key"], "title": pr["title"], "action": pr["action"], "effort": pr["effort"],
                         "flags": pr["flags"], "requested": pr["requested"], "basis": basis,
                         "threads": pr["threads"], "recentEvents": pr["events"]})
    print(json.dumps({"mine": todo}, indent=2))


def cmd_note(a):
    con = User(a.user).db()
    con.execute("""insert into notes(key, basis, next, left_, question, why, at) values(?,?,?,?,?,?,?)
                   on conflict(key) do update set basis=excluded.basis, next=excluded.next, left_=excluded.left_,
                   question=excluded.question, why=excluded.why, at=excluded.at""",
                (a.pr, a.basis, a.next, a.left, a.question, a.why, iso(now())))
    con.commit()


def cmd_picks(a):
    picks = []
    for s in a.pick or []:
        k, _, why = s.partition("=")
        picks.append({"key": k, "why": why})
    con = User(a.user).db()
    meta_set(con, "picks", picks)
    meta_set(con, "headline", a.headline or "")
    meta_set(con, "triagedAt", iso(now()))
    con.commit()


def upsert_thread(con, key, tid, title, link, updated, status):
    con.execute("""insert into threads(key, thread_id, title, link, updated_at, status) values(?,?,?,?,?,?)
                   on conflict(key, thread_id) do update set title=excluded.title, link=excluded.link,
                   updated_at=excluded.updated_at, status=excluded.status""",
                (key.lower(), tid, title, link, updated, status))


def cmd_link_thread(a):
    con = User(a.user).db()
    upsert_thread(con, a.pr, a.thread_id, a.title, a.link, a.updated_at, a.status)
    con.commit()


def cmd_ingest_threads(a):
    """Record PR links from saved t3_thread_list results."""
    con = User(a.user).db()
    since = meta_get(con, "lastThreadScan", "") or ""
    newest, oldest, linked, next_cursor = since, None, 0, None
    for path in a.files:
        d = load_json(path, {})
        next_cursor = d.get("nextCursor")
        for t in d.get("threads", []):
            if t.get("parentThreadId") or t.get("threadId") == a.skip:
                continue
            up = t.get("updatedAt", "")
            newest, oldest = max(newest, up), up if oldest is None else min(oldest, up)
            for pr in t.get("pullRequests", []):
                if pr.get("host", "github.com") != "github.com":
                    continue
                upsert_thread(con, f"{pr['repository']}#{pr['number']}", t["threadId"], t.get("title", ""),
                              t.get("link", ""), up, t.get("status", ""))
                linked += 1
    if a.commit:
        meta_set(con, "lastThreadScan", newest)
    con.commit()
    print(json.dumps({"linked": linked, "oldestThreadInPages": oldest, "nextCursor": next_cursor,
                      "keepPaging": bool(next_cursor) and (oldest or "") > max(since, a.floor or ""),
                      "lastThreadScan": meta_get(con, "lastThreadScan")}, indent=2))


def cmd_thread_scan(a):
    con = User(a.user).db()
    if a.set:
        meta_set(con, "lastThreadScan", a.set)
        con.commit()
    print(meta_get(con, "lastThreadScan") or "never")


# ---------------------------------------------------------------- server


# ---------------------------------------------------------------- sweeps (Claude, headless)

SWEEP_TOOLS = [
    "Read", "Skill", "ToolSearch",
    "Bash(python3 radar.py:*)", "Bash(gh pr view:*)", "Bash(gh api user:*)",
    "mcp__t3__t3_thread_list", "mcp__t3__t3_thread_read", "mcp__t3__t3_thread_search",
]
SWEEP_DEFAULTS = {"enabled": True, "minIntervalMinutes": 30, "maxPerDay": 16, "maxBudgetUsd": 3.0,
                  "keepLogDays": 7, "timeoutMinutes": 20, "mcpConfig": None, "model": None}
URGENT_KINDS = {"review_requested", "team_requested", "ci_failed", "changes_requested", "comments",
                "conflict", "approved"}


def sweep_config(config):
    return {**SWEEP_DEFAULTS, **config.get("sweep", {})}


def own_prs_needing_notes(board):
    out = []
    for pr in board["mine"]:
        basis = pr["updatedAt"] + "|" + ",".join(sorted(t["updatedAt"] or "" for t in pr["threads"]))
        if (pr["note"] or {}).get("basis") != basis:
            out.append(pr["key"])
    return out


def sweep_reason(user, force=False):
    """Why a sweep should run now, or None. Cheap: reads only the database."""
    cfg = sweep_config(user.config)
    con = user.db()
    last = con.execute("select * from sweeps where status != 'running' order by id desc limit 1").fetchone()
    running = con.execute("select 1 from sweeps where status='running' and started_at > ?",
                          (iso(now() - dt.timedelta(minutes=cfg["timeoutMinutes"] + 5)),)).fetchone()
    today = con.execute("select count(*) from sweeps where started_at > ?",
                        (iso(now() - dt.timedelta(hours=24)),)).fetchone()[0]
    since = last["started_at"] if last else ""
    urgent = [r["text"] for r in con.execute("select text, kind from events where at > ?", (since,))
              if r["kind"] in URGENT_KINDS]
    last_block = meta_get(con, "lastSweepBlock")
    con.close()
    if running:
        return None
    if force:
        return "asked for from the page"
    if not cfg["enabled"] or today >= cfg["maxPerDay"]:
        return None
    rh = rhythm_now(user.config)
    if rh and rh["mode"] == "off":
        return None
    if last and (now() - parse(last["started_at"])).total_seconds() < 60 * cfg["minIntervalMinutes"]:
        return None
    if not last:
        return "first sweep"
    block = rh["label"] if rh else None
    if block and block != last_block:
        return f"now in {block}"
    if urgent:
        return "new: " + "; ".join(dict.fromkeys(urgent))[:200]
    moved = own_prs_needing_notes(build_board(user))
    if moved:
        return f"{len(moved)} of your PRs moved"
    return None


def sweep_prompt(user, reason, has_t3):
    return (
        f"Run a pr-radar sweep for {user.login}, following .agents/skills/pr-radar/SKILL.md exactly. "
        f"This sweep was triggered because: {reason}. "
        "This is a headless run started by radar.py: nobody can answer questions, there is no T3 thread to "
        "settle (skip step 6), and the page picks up your notes and picks on its own. "
        + ("T3's tools are available through the MCP server named t3 (tool names start with mcp__t3__); load them "
           "with ToolSearch. " if has_t3 else
           "T3's tools are not available in this run: skip step 2 and work from the threads already linked. ")
        + "End with the step 5 report and nothing else."
    )


def prune_sweep_logs(user, keep_days):
    d = os.path.join(user.dir, "logs", "sweeps")
    if not os.path.isdir(d):
        return
    cutoff = time.time() - keep_days * 86400
    for f in os.listdir(d):
        path = os.path.join(d, f)
        if os.path.getmtime(path) < cutoff:
            os.remove(path)


def run_sweep(user, reason):
    """Run one headless Claude sweep; log the transcript; record the outcome. Returns the sweeps row id."""
    cfg = sweep_config(user.config)
    log_dir = os.path.join(user.dir, "logs", "sweeps")
    os.makedirs(log_dir, exist_ok=True)
    started = now()
    log_path = os.path.join(log_dir, started.strftime("%Y%m%d-%H%M%S") + ".jsonl")
    con = user.db()
    rh = rhythm_now(user.config)
    cur = con.execute("insert into sweeps(started_at, reason, status, log_path) values(?,?,?,?)",
                      (iso(started), reason, "running", os.path.relpath(log_path, ROOT)))
    sweep_id = cur.lastrowid
    meta_set(con, "lastSweepBlock", rh["label"] if rh else None)
    con.commit()
    con.close()

    mcp = cfg["mcpConfig"] and os.path.join(ROOT, cfg["mcpConfig"])
    has_t3 = bool(mcp and os.path.exists(mcp))
    cmd = ["claude", "-p", sweep_prompt(user, reason, has_t3), "--output-format", "stream-json", "--verbose",
           "--permission-mode", "dontAsk", "--allowedTools", *SWEEP_TOOLS, "--strict-mcp-config",
           "--no-session-persistence", "--max-budget-usd", str(cfg["maxBudgetUsd"])]
    if has_t3:
        cmd += ["--mcp-config", mcp]
    if cfg["model"]:
        cmd += ["--model", cfg["model"]]
    status, summary, cost, turns = "error", "", None, None
    try:
        with open(log_path, "w") as log:
            log.write(json.dumps({"type": "radar", "reason": reason, "t3": has_t3, "startedAt": iso(started)}) + "\n")
            log.flush()
            proc = subprocess.run(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, text=True,
                                  timeout=60 * cfg["timeoutMinutes"])
        result = None
        with open(log_path) as log:
            for line in log:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if msg.get("type") == "result":
                    result = msg
        if result:
            status = "error" if result.get("is_error") or proc.returncode else "ok"
            summary = (result.get("result") or result.get("subtype") or "")[:4000]
            cost, turns = result.get("total_cost_usd"), result.get("num_turns")
        else:
            summary = f"claude exited with code {proc.returncode} and no result; see the log"
    except subprocess.TimeoutExpired:
        summary = f"timed out after {cfg['timeoutMinutes']} minutes"
    except Exception as e:
        summary = f"could not run claude: {e}"
    con = user.db()
    con.execute("update sweeps set finished_at=?, status=?, summary=?, cost_usd=?, turns=? where id=?",
                (iso(now()), status, summary, cost, turns, sweep_id))
    con.execute("delete from sweeps where started_at < ?", (iso(now() - dt.timedelta(days=cfg["keepLogDays"])),))
    con.commit()
    fails = [r["status"] for r in con.execute("select status from sweeps order by id desc limit 2")]
    con.close()
    prune_sweep_logs(user, cfg["keepLogDays"])
    if fails == ["error", "error"]:
        notify("pr-radar: sweeps are failing", summary[:120])
    return sweep_id


def cmd_t3_mcp(a):
    """Store T3 Connect's MCP URL (read from stdin) as the sweep's MCP config, readable only by you."""
    url = sys.stdin.read().strip()
    if not url.startswith(("http://", "https://")):
        sys.exit("expected T3's MCP URL on stdin, e.g. `pbpaste | python3 radar.py t3-mcp --user <login>`")
    user = User(a.user)
    path = os.path.join(user.dir, "t3-mcp.json")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"mcpServers": {"t3": {"type": "http", "url": url}}}, f)
    print(f"wrote {os.path.relpath(path, ROOT)}; sweeps will use T3's tools from the next run")


def cmd_sweep(a):
    user = User(a.user)
    reason = sweep_reason(user, force=a.force)
    if a.dry_run or not reason:
        print(json.dumps({"wouldRun": bool(reason), "reason": reason}))
        return
    sid = run_sweep(user, reason)
    con = user.db()
    print(json.dumps(dict(con.execute("select * from sweeps where id=?", (sid,)).fetchone()), indent=2))


def refresh_minutes(config):
    r = config.get("refresh", {})
    rh = rhythm_now(config)
    off = rh and rh["mode"] == "off"
    return r.get("offHoursMinutes", 60) if off else r.get("workingMinutes", 5)


class Server:
    def __init__(self, user, notify_on, sweeps_on=False):
        self.user = user
        self.notify_on = notify_on
        self.sweeps_on = sweeps_on
        self.lock = threading.Lock()
        self.refreshing = False
        self.last_error = None
        self.sweep_lock = threading.Lock()

    def start_sweep(self, force=False):
        """Run a sweep in its own thread if one is due (or forced). Returns the reason, or None."""
        if not self.sweep_lock.acquire(blocking=False):
            return None
        reason = sweep_reason(self.user, force=force)
        if not reason:
            self.sweep_lock.release()
            return None

        def go():
            try:
                run_sweep(self.user, reason)
            finally:
                self.sweep_lock.release()

        threading.Thread(target=go, daemon=True).start()
        return reason

    def do_refresh(self, background=False):
        if not self.lock.acquire(blocking=not background):
            return None
        self.refreshing = True
        try:
            out = refresh(self.user, send_notifications=self.notify_on)
            self.last_error = None
            return out
        except Exception as e:  # keep serving; show the error on the page
            self.last_error = str(e)
            return None
        finally:
            self.refreshing = False
            self.lock.release()

    def loop(self):
        while True:
            con = self.user.db()
            last = meta_get(con, "lastRefresh")
            con.close()
            due = (not last) or (now() - parse(last)).total_seconds() >= 60 * refresh_minutes(self.user.config)
            if due:
                self.do_refresh(background=True)
                if self.sweeps_on:
                    self.start_sweep()
            time.sleep(30)

    def handler(self):
        srv = self
        page = os.path.join(ROOT, "web", "index.html")

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, code, body, ctype="application/json"):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)

            def board(self):
                b = build_board(srv.user)
                b["refreshing"], b["error"] = srv.refreshing, srv.last_error
                b["sweepsEnabled"] = srv.sweeps_on
                return b

            def do_GET(self):
                if self.path in ("/", "/index.html"):
                    with open(page, "rb") as f:
                        return self.send(200, f.read(), "text/html; charset=utf-8")
                if self.path == "/api/board":
                    return self.send(200, self.board())
                self.send(404, {"error": "not found"})

            def do_POST(self):
                if self.headers.get("Origin") not in (None, f"http://127.0.0.1:{self.server.server_port}",
                                                      f"http://localhost:{self.server.server_port}"):
                    return self.send(403, {"error": "cross-origin request refused"})
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                if self.path == "/api/refresh":
                    srv.do_refresh()
                    return self.send(200, self.board())
                if self.path == "/api/triage":
                    con = srv.user.db()
                    key, action = body["key"], body["action"]
                    if action == "clear":
                        con.execute("delete from triage where key=?", (key,))
                    else:
                        until = iso(now() + dt.timedelta(days=float(body.get("days", 1)))) if action == "snooze" else None
                        con.execute("""insert into triage(key, action, until, at) values(?,?,?,?)
                                       on conflict(key) do update set action=excluded.action,
                                       until=excluded.until, at=excluded.at""", (key, action, until, iso(now())))
                    con.commit()
                    con.close()
                    return self.send(200, self.board())
                if self.path == "/api/sweep":
                    reason = srv.start_sweep(force=True)
                    return self.send(200 if reason else 409,
                                     {"started": bool(reason), "error": None if reason else "a sweep is already running"})
                if self.path == "/api/viewed":
                    con = srv.user.db()
                    meta_set(con, "lastViewed", iso(now()))
                    con.commit()
                    con.close()
                    return self.send(200, {"ok": True})
                self.send(404, {"error": "not found"})

        return H


def cmd_serve(a):
    user = User(a.user)
    port = a.port or user.config.get("port", 7424)
    srv = Server(user, notify_on=a.notify, sweeps_on=a.sweeps)
    threading.Thread(target=srv.loop, daemon=True).start()
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), srv.handler())
    print(f"pr-radar for {user.login} on http://127.0.0.1:{port}", flush=True)
    httpd.serve_forever()


# ---------------------------------------------------------------- stats (profile building)

STAT_FIELDS = """
  number title createdAt
  repository { nameWithOwner }
  author { login }
  files(first: 60) { nodes { path } }
"""


def cmd_stats(a):
    since = a.since or (now() - dt.timedelta(days=365)).strftime("%Y-%m-%d")
    authored, _ = search_all(f"org:{a.org} is:pr author:{a.login} created:>={since}", STAT_FIELDS, page=25)
    reviewed, _ = search_all(f"org:{a.org} is:pr reviewed-by:{a.login} created:>={since}", STAT_FIELDS, page=25)
    reviewed = [n for n in reviewed if (n["author"] or {}).get("login") != a.login]
    scope_re = re.compile(r"^(\w+)(?:\(([^)]+)\))?!?:")

    def summarize(prs):
        repos, scopes, dirs, authors = Counter(), Counter(), defaultdict(Counter), Counter()
        for n in prs:
            repo = n["repository"]["nameWithOwner"]
            repos[repo] += 1
            authors[(n["author"] or {}).get("login")] += 1
            m = scope_re.match(n["title"])
            if m:
                scopes[f"{m.group(1)}({m.group(2)})" if m.group(2) else m.group(1)] += 1
            touched = set()
            for f in n["files"]["nodes"]:
                parts = f["path"].split("/")
                for d in (2, 3, 4):
                    touched.add((d, "/".join(parts[:d]) if len(parts) > d else f["path"]))
            for d, path in touched:
                dirs[d][f"{repo.split('/')[1]}:{path}"] += 1
        return {"count": len(prs), "repos": repos.most_common(20), "titleScopes": scopes.most_common(40),
                "dirsDepth2": dirs[2].most_common(40), "dirsDepth3": dirs[3].most_common(50),
                "dirsDepth4": dirs[4].most_common(50), "authors": authors.most_common(20),
                "sampleTitles": [f"{n['repository']['nameWithOwner'].split('/')[1]}#{n['number']} {n['title']}"
                                 for n in prs[:80]]}

    tz = ZoneInfo(a.tz) if a.tz else dt.datetime.now().astimezone().tzinfo
    hours, weekdays = Counter(), Counter()
    for n in authored:
        t = parse(n["createdAt"]).astimezone(tz)
        hours[t.hour] += 1
        weekdays[t.strftime("%a")] += 1
    teams = subprocess.run(["gh", "api", "/user/teams", "--paginate", "-q",
                            f'.[] | select(.organization.login=="{a.org}") | .slug'],
                           capture_output=True, text=True).stdout.split()
    out = {"login": a.login, "org": a.org, "since": since, "teamsOfAuthenticatedUser": teams,
           "activity": {"timezone": str(tz), "prsOpenedByHour": [hours.get(h, 0) for h in range(24)],
                        "prsOpenedByWeekday": dict(weekdays.most_common())},
           "authored": summarize(authored), "reviewed": summarize(reviewed)}
    text = json.dumps(out, indent=2)
    if a.out:
        with open(a.out, "w") as f:
            f.write(text)
        print(a.out)
    else:
        print(text)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def cmd(name, fn, help=None):
        sp = sub.add_parser(name, help=help)
        sp.add_argument("--user", required=True, help="GitHub login; data lives in users/<login>/")
        sp.set_defaults(fn=fn)
        return sp

    sp = cmd("refresh", cmd_refresh, "sweep open PRs, score, diff, record events (no model)")
    sp.add_argument("--notify", action="store_true", help="macOS notifications for config.notify.kinds")
    sp.add_argument("--full", action="store_true", help="fetch every PR in full, not just changed ones")
    sp = cmd("serve", cmd_serve, "serve the page on 127.0.0.1 and refresh in the background")
    sp.add_argument("--port", type=int)
    sp.add_argument("--notify", action="store_true")
    sp.add_argument("--sweeps", action="store_true", help="also run Claude sweeps when the gate says one is due")
    cmd("t3-mcp", cmd_t3_mcp, "store T3 Connect's MCP URL from stdin for sweeps")
    sp = cmd("sweep", cmd_sweep, "run a headless Claude sweep if one is due (see sweep_reason)")
    sp.add_argument("--force", action="store_true", help="run even if the gate says no")
    sp.add_argument("--dry-run", action="store_true", help="only print whether a sweep would run, and why")
    cmd("todo", cmd_todo, "own PRs whose PR or thread moved since their note")
    sp = cmd("note", cmd_note, "record the judgement for one PR")
    sp.add_argument("pr", help="Owner/repo#123")
    sp.add_argument("--basis", required=True, help="the basis string `todo` printed for this PR")
    sp.add_argument("--next", help="the one next step, imperative, under 15 words")
    sp.add_argument("--left", help="what's left before merge, one or two sentences")
    sp.add_argument("--question", help="an open question waiting on the user, if any")
    sp.add_argument("--why", help="review/team items: why this person, in one sentence")
    sp = cmd("picks", cmd_picks, "record the headline and up to three picks")
    sp.add_argument("--headline")
    sp.add_argument("--pick", action="append", help="'Owner/repo#123=why now', best first")
    sp = cmd("board", cmd_board, "print the board (Markdown, or --json)")
    sp.add_argument("--json", action="store_true")
    cmd("rhythm", cmd_rhythm, "print the user's current work block")
    sp = cmd("link-thread", cmd_link_thread, "record a T3 thread that works on a PR")
    sp.add_argument("pr")
    sp.add_argument("thread_id")
    sp.add_argument("--title", required=True)
    sp.add_argument("--link", default="")
    sp.add_argument("--updated-at", required=True)
    sp.add_argument("--status", default="")
    sp = cmd("ingest-threads", cmd_ingest_threads, "record PR links from saved t3_thread_list results")
    sp.add_argument("files", nargs="+")
    sp.add_argument("--floor", help="ISO date: stop paging once threads are older than this")
    sp.add_argument("--skip", help="thread id to ignore (the one you're running in)")
    sp.add_argument("--commit", action="store_true", help="last page read: record the scan time")
    sp = cmd("thread-scan", cmd_thread_scan, "get or set the last T3 thread scan time")
    sp.add_argument("--set")

    sp = sub.add_parser("stats", help="one-off: a year of authored and reviewed PRs, for a profile")
    sp.add_argument("login")
    sp.add_argument("--org", default="Runn-Fast")
    sp.add_argument("--since")
    sp.add_argument("--tz")
    sp.add_argument("--out")
    sp.set_defaults(fn=cmd_stats)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
