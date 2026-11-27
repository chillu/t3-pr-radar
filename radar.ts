#!/usr/bin/env node
/**
 * pr-radar: a local to-do list built from open pull requests across a GitHub org.
 *
 * Two halves, two cadences:
 *   - refresh (no model): poll every open PR in the org, score it against the user's profile,
 *     diff it against the last refresh and record events (CI passed, review requested, ...).
 *     The local server runs this every few minutes; the page's Refresh button runs it on demand.
 *   - sweep (Claude): read T3 threads and review comments for PRs that moved, write a note per PR,
 *     choose the picks. Driven by the pr-radar skill; writes through the note/picks subcommands.
 *     The server starts one headless (`claude -p`) when sweepReason() says something moved.
 *
 * Everything lives in users/<login>/radar.db (SQLite, gitignored). profile.json holds the scoring
 * weights and config.json the rhythm, refresh cadence, sweeps and notifications.
 *
 * Node >= 24, no dependencies: `node radar.ts <command> --user <login>`. Run `node radar.ts --help`.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

// The scoring and bookkeeping work on loosely shaped JSON from GitHub, T3 and the database.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const ROOT = import.meta.dirname;
const DB_BUSY_TIMEOUT_MS = 30_000; // the server and the CLI both write

// ---------------------------------------------------------------- small helpers

class Exit extends Error {}

function die(message: string): never {
  throw new Exit(message);
}

const now = (): Date => new Date();
const iso = (t: Date): string => t.toISOString().replace(/\.\d{3}Z$/, "Z");
const parse = (ts: string | null | undefined): Date | null => (ts ? new Date(ts) : null);
const addMs = (t: Date, ms: number): Date => new Date(t.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Python's round(): halves go to the even neighbour. */
function pyRound(x: number, digits = 0): number {
  const f = 10 ** digits;
  const m = x * f;
  let r = Math.round(m);
  if (Math.abs(m % 1) === 0.5 && r % 2 !== 0) r -= 1;
  return r / f;
}

function daysSince(ts: string | null | undefined, ref: Date = now()): number | null {
  const t = parse(ts);
  return t ? pyRound((ref.getTime() - t.getTime()) / DAY, 1) : null;
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

const dump = (v: unknown): string => JSON.stringify(v, null, 2);

/** Counter.most_common(): highest count first, ties in insertion order. */
function mostCommon(counts: Map<string, number>, n?: number): [string, number][] {
  const out = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return n === undefined ? out : out.slice(0, n);
}

function bump(counts: Map<string, number>, k: string, by = 1): void {
  counts.set(k, (counts.get(k) ?? 0) + by);
}

/** fnmatch.fnmatch on POSIX: `*` and `?` match across `/`, `[...]` is a character class. */
function fnmatch(name: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) re += "\\[";
      else {
        let cls = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        else if (cls.startsWith("^")) cls = "\\" + cls;
        re += `[${cls}]`;
        i = end;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^(?:${re})$`, "s").test(name);
}

/** urllib.parse.quote(v, safe=""): like encodeURIComponent, but also escapes !'()*. */
const quote = (v: string): string =>
  encodeURIComponent(v).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

const docId = (key: string): string => key.replace(/[^A-Za-z0-9_\-.]/g, "_");

function run(cmd: string, args: string[], opts: { input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

// ---------------------------------------------------------------- storage

const SCHEMA = `
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
`;

class User {
  login: string;
  dir: string;
  profilePath: string;
  configPath: string;
  dbPath: string;

  constructor(login: string) {
    this.login = login;
    this.dir = path.join(ROOT, "users", login);
    this.profilePath = path.join(this.dir, "profile.json");
    this.configPath = path.join(this.dir, "config.json");
    this.dbPath = path.join(this.dir, "radar.db");
    if (!fs.existsSync(this.dir) || !fs.statSync(this.dir).isDirectory())
      die(`no user folder at ${this.dir}; run the pr-radar-setup skill first`);
  }

  get profile(): Obj {
    return loadJson<Obj | null>(this.profilePath, null) ?? die(`missing ${this.profilePath}`);
  }

  get config(): Obj {
    return loadJson<Obj>(this.configPath, {});
  }

  db(): DatabaseSync {
    const db = new DatabaseSync(this.dbPath, { timeout: DB_BUSY_TIMEOUT_MS });
    db.exec(SCHEMA);
    return db;
  }
}

/** Run fn with a database connection, closing it afterwards. */
function withDb<T>(user: User, fn: (db: DatabaseSync) => T): T {
  const db = user.db();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("begin");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}

const all = (db: DatabaseSync, sql: string, ...params: (string | number | null)[]): Obj[] =>
  db.prepare(sql).all(...params) as Obj[];
const one = (db: DatabaseSync, sql: string, ...params: (string | number | null)[]): Obj | undefined =>
  db.prepare(sql).get(...params) as Obj | undefined;
const exec = (db: DatabaseSync, sql: string, ...params: (string | number | null)[]) => db.prepare(sql).run(...params);

function metaGet<T = unknown>(db: DatabaseSync, k: string, fallback: T | null = null): T | null {
  const r = one(db, "select v from meta where k=?", k);
  return r ? (JSON.parse(r.v) as T) : fallback;
}

function metaSet(db: DatabaseSync, k: string, v: unknown): void {
  exec(db, "insert into meta(k, v) values(?, ?) on conflict(k) do update set v=excluded.v", k, JSON.stringify(v ?? null));
}

// ---------------------------------------------------------------- GitHub

async function gql(query: string, variables: Record<string, string | number | null | undefined> = {}): Promise<Obj> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    if (v !== null && v !== undefined) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  }
  const out = await run("gh", args);
  if (out.code !== 0) throw new Error(`gh api graphql failed: ${out.stderr.trim().slice(0, 500)}`);
  const data = JSON.parse(out.stdout);
  if (data.errors) throw new Error(`graphql errors: ${JSON.stringify(data.errors).slice(0, 500)}`);
  return data.data;
}

async function searchAll(q: string, fields: string, page = 20): Promise<{ nodes: Obj[]; rate: { cost: number; remaining: number | null } }> {
  const query = `
    query($q: String!, $after: String, $n: Int!) {
      rateLimit { cost remaining }
      search(query: $q, type: ISSUE, first: $n, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { ${fields} } }
      }
    }`;
  let after: string | null = null;
  const nodes: Obj[] = [];
  let cost = 0;
  let remaining: number | null = null;
  for (;;) {
    const d = await gql(query, { q, after, n: page });
    cost += d.rateLimit.cost;
    remaining = d.rateLimit.remaining;
    nodes.push(...d.search.nodes.filter((n: Obj | null) => n && Object.keys(n).length));
    if (!d.search.pageInfo.hasNextPage || nodes.length >= 1000) return { nodes, rate: { cost, remaining } };
    after = d.search.pageInfo.endCursor;
  }
}

const LIGHT_FIELDS = `
  id number updatedAt isDraft mergeable reviewDecision headRefOid
  repository { nameWithOwner }
  author { login __typename }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const FULL_EVERY_HOURS = 6; // a full fetch now and then catches anything the fingerprint misses

const firstCommit = (n: Obj): Obj => (n.commits?.nodes?.[0] ?? {}).commit ?? {};

/** The light poll's fingerprint, spelled the way Python's json.dumps spelled it so stored values still match. */
function fingerprint(n: Obj): string {
  const parts = [n.updatedAt, n.isDraft, n.mergeable, n.reviewDecision, n.headRefOid, (firstCommit(n).statusCheckRollup ?? {}).state ?? null];
  return "[" + parts.map((v) => JSON.stringify(v ?? null)).join(", ") + "]";
}

const PR_FIELDS = `
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
`;

/** Full PR details for node ids, 20 per query. */
async function fetchFull(ids: string[]): Promise<Obj[]> {
  const out: Obj[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20).map((x) => JSON.stringify(x)).join(",");
    const d = await gql(`query { rateLimit { cost remaining } nodes(ids: [${batch}]) { ... on PullRequest { ${PR_FIELDS} } } }`);
    out.push(...d.nodes.filter((n: Obj | null) => n && Object.keys(n).length));
  }
  return out;
}

const BOT = /\[bot\]$|^(dependabot|renovate|github-actions|copilot)/i;
const isBot = (login: string | null | undefined): boolean => !!login && BOT.test(login);

function flatten(n: Obj): Obj {
  const commit = firstCommit(n);
  const users: string[] = [];
  const teams: string[] = [];
  for (const r of n.reviewRequests.nodes) {
    const rr = r.requestedReviewer ?? {};
    if ("login" in rr) users.push(rr.login);
    else if ("slug" in rr) teams.push(rr.slug);
  }
  const ready = (n.readyAt.nodes[0] ?? {}).createdAt;
  return {
    key: `${n.repository.nameWithOwner}#${n.number}`,
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    author: n.author?.login ?? null,
    authorIsBot: n.author?.__typename === "Bot",
    draft: n.isDraft,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    readyAt: ready || n.createdAt,
    lastCommitAt: commit.committedDate ?? null,
    headSha: n.headRefOid,
    size: n.additions + n.deletions,
    changedFiles: n.changedFiles,
    mergeable: n.mergeable,
    decision: n.reviewDecision,
    ci: (commit.statusCheckRollup ?? {}).state ?? null,
    labels: n.labels.nodes.map((l: Obj) => l.name),
    requestedUsers: users,
    requestedTeams: teams,
    reviews: n.reviews.nodes.map((r: Obj) => ({ by: r.author?.login ?? null, state: r.state, at: r.submittedAt })),
    threads: n.reviewThreads.nodes.map((t: Obj) => {
      const last = t.comments.nodes[0] ?? {};
      return { resolved: t.isResolved, lastBy: last.author?.login ?? null, lastAt: last.createdAt ?? null };
    }),
    comments: n.comments.nodes.map((c: Obj) => ({ by: c.author?.login ?? null, at: c.createdAt })),
    files: n.files.nodes.map((f: Obj) => f.path),
  };
}

// ---------------------------------------------------------------- scoring

const humanReviews = (pr: Obj): Obj[] => pr.reviews.filter((r: Obj) => r.by && r.by !== pr.author && !isBot(r.by));

function lastActivityByOthers(pr: Obj): string | null {
  const a = pr.author;
  const stamps: (string | null)[] = humanReviews(pr).map((r) => r.at);
  for (const t of pr.threads) if (t.lastBy !== a && t.lastBy !== null && !isBot(t.lastBy)) stamps.push(t.lastAt);
  for (const c of pr.comments) if (c.by !== a && c.by !== null && !isBot(c.by)) stamps.push(c.at);
  const real = stamps.filter((s): s is string => !!s);
  return real.length ? real.reduce((m, s) => (s > m ? s : m)) : null;
}

const QUICK_ACTIONS = new Set(["Approved: merge it", "Ask someone to review", "Nudge your reviewer", "Abandoned? Close or revive", "Waiting on review"]);
const DEEP_LINES = 300;
const DEEP_FILES = 15;
const STALL_WINDOW = 45; // days; older PRs are abandoned rather than stalled
const failing = (ci: string | null) => ci === "FAILURE" || ci === "ERROR";

function mineSignals(pr: Obj, me: string): Obj {
  const openThreads = pr.threads.filter((t: Obj) => !t.resolved);
  const waitingOnMe = openThreads.filter((t: Obj) => t.lastBy && t.lastBy !== me);
  const idle = daysSince(pr.updatedAt);
  const reviewed = humanReviews(pr).length > 0;
  const flags: string[] = [];
  if (pr.mergeable === "CONFLICTING") flags.push("merge conflict");
  if (failing(pr.ci)) flags.push("CI failing");
  if (waitingOnMe.length) flags.push(`${waitingOnMe.length} review thread(s) waiting on you`);
  if (pr.decision === "CHANGES_REQUESTED") flags.push("changes requested");
  let action: string;
  let urgency: number;
  if (idle && idle > 60) [action, urgency] = ["Abandoned? Close or revive", 15];
  else if (pr.draft) [action, urgency] = idle && idle > 14 ? ["Stale draft: finish or close", 35] : ["Draft in progress", 30];
  else if (pr.decision === "CHANGES_REQUESTED" || waitingOnMe.length) [action, urgency] = ["Answer review comments", 90];
  else if (pr.mergeable === "CONFLICTING") [action, urgency] = ["Resolve the merge conflict", 80];
  else if (failing(pr.ci)) [action, urgency] = ["Fix failing CI", 75];
  else if (pr.decision === "APPROVED") [action, urgency] = ["Approved: merge it", 95];
  else if (!pr.requestedUsers.length && !pr.requestedTeams.length && !reviewed) [action, urgency] = ["Ask someone to review", 70];
  else if (idle && idle > 3) [action, urgency] = ["Nudge your reviewer", 60];
  else [action, urgency] = ["Waiting on review", 20];
  const big = pr.size >= DEEP_LINES || pr.changedFiles >= DEEP_FILES;
  const effort = QUICK_ACTIONS.has(action) ? "quick" : big || action === "Answer review comments" ? "deep" : "quick";
  return {
    action, urgency, flags, effort,
    openThreads: openThreads.length, threadsWaitingOnMe: waitingOnMe.length,
    idleDays: idle, ageDays: daysSince(pr.createdAt),
    reviewers: [...new Set(humanReviews(pr).map((r) => r.by as string))].sort(),
    requested: [...pr.requestedUsers, ...pr.requestedTeams.map((t: string) => "@" + t)],
    lastOtherAt: lastActivityByOthers(pr),
  };
}

function areaMatches(pr: Obj, profile: Obj): [string, number][] {
  const hits: [string, number][] = [];
  const title = pr.title.toLowerCase();
  for (const area of profile.areas ?? []) {
    const globs: string[] = area.paths ?? [];
    const n = pr.files.filter((f: string) => globs.some((g) => fnmatch(f, g))).length;
    const kw = (area.keywords ?? []).some((k: string) => title.includes(k.toLowerCase()));
    if (n || kw) {
      const frac = n / Math.max(1, pr.files.length);
      hits.push([area.name, (area.weight ?? 1) * (0.5 * Number(kw) + Math.min(1.0, 0.3 + frac) * Number(n > 0))]);
    }
  }
  return hits.sort((a, b) => b[1] - a[1]);
}

function reviewSignals(pr: Obj, me: string, profile: Obj): Obj {
  const myReviews = pr.reviews.filter((r: Obj) => r.by === me);
  const myLast: string | null = myReviews.reduce((m: string | null, r: Obj) => (m === null || r.at > m ? r.at : m), null);
  const pushedSince = !!(myLast && pr.lastCommitAt && pr.lastCommitAt > myLast);
  const approvals = [...new Set(humanReviews(pr).filter((r) => r.state === "APPROVED").map((r) => r.by as string))].sort();
  const areas = areaMatches(pr, profile);
  const relevance = pyRound(areas.reduce((s, [, w]) => s + w, 0), 2);
  const peopleW: number = profile.people?.[pr.author] ?? 0;
  const requestedMe: boolean = pr.requestedUsers.includes(me);
  const myTeams = new Set<string>(profile.teams ?? []);
  const requestedTeam = [...new Set<string>(pr.requestedTeams)].filter((t) => myTeams.has(t)).sort();
  const waiting = daysSince(lastActivityByOthers(pr) || pr.readyAt);
  const score =
    100 * Number(requestedMe) + 35 * Number(requestedTeam.length > 0) + (pushedSince ? 30 : 0) +
    12 * relevance + 8 * (profile.repos?.[pr.repo] ?? 0) + 6 * peopleW +
    Math.min(15, 2 * (waiting || 0)) + (pr.size < 200 ? 5 : 0) -
    (approvals.length ? 25 : 0) - (myReviews.length && !pushedSince ? 40 : 0);
  const reasons: string[] = [];
  if (requestedMe) reasons.push("review requested from you");
  if (requestedTeam.length) reasons.push("requested from " + requestedTeam.join(", "));
  if (pushedSince) reasons.push("new commits since your review");
  if (areas.length) reasons.push("touches " + areas.slice(0, 3).map(([a]) => a).join(", "));
  if (peopleW >= 0.6) reasons.push(`you often review ${pr.author}`);
  return {
    score: pyRound(score, 1), requestedMe, requestedTeams: requestedTeam,
    reviewedByMe: myReviews.length > 0, pushedSinceMyReview: pushedSince, approvals,
    areas: areas.map(([a]) => a), relevance, waitingDays: waiting, reasons,
  };
}

/** Close to done but stalled, or null. */
function teamSignals(pr: Obj): Obj | null {
  if (pr.draft || pr.mergeable === "CONFLICTING" || failing(pr.ci)) return null;
  const idle = daysSince(pr.updatedAt);
  if (idle !== null && idle > STALL_WINDOW) return null;
  const reviewed = humanReviews(pr).length > 0;
  const waiting = daysSince(lastActivityByOthers(pr) || pr.readyAt);
  if (pr.decision === "APPROVED" && idle && idle >= 2)
    return { stall: "Approved and green, not merged", days: idle, score: 50 + 3 * Math.min(idle, 20) };
  if (!reviewed && waiting && waiting >= 3) return { stall: "No review yet", days: waiting, score: 45 + 3 * Math.min(waiting, 20) };
  if (reviewed && pr.decision !== "CHANGES_REQUESTED" && waiting && waiting >= 5)
    return { stall: "Reviewed, then quiet", days: waiting, score: 25 + 2 * Math.min(waiting, 20) };
  return null;
}

/** The stored item: slim PR fields plus whichever signals apply to this user. */
function scorePr(pr: Obj, me: string, profile: Obj): Obj {
  const keep = ["key", "repo", "number", "title", "url", "author", "draft", "createdAt", "updatedAt", "ci",
    "decision", "mergeable", "size", "changedFiles", "labels", "headSha"];
  const item: Obj = Object.fromEntries(keep.map((k) => [k, pr[k]]));
  if (pr.author === me) {
    item.mine = mineSignals(pr, me);
    return item;
  }
  const rs = reviewSignals(pr, me, profile);
  const big = pr.size >= DEEP_LINES || pr.changedFiles >= DEEP_FILES;
  rs.effort = big ? "deep" : "quick";
  item.review = rs;
  const ts = teamSignals(pr);
  if (ts) {
    ts.effort = ts.stall.startsWith("Approved") ? "quick" : rs.effort;
    ts.areas = rs.areas;
  }
  item.team = ts;
  return item;
}

// ---------------------------------------------------------------- events

/** Human-sized changes between two refreshes of one PR, as [kind, text]. */
function diffEvents(old: Obj | null, cur: Obj): [string, string][] {
  const ev: [string, string][] = [];
  if (old === null) {
    if ("mine" in cur) ev.push(["opened", "You opened this PR"]);
    else if (cur.review.requestedMe) ev.push(["review_requested", `${cur.author} asked you to review`]);
    else if (cur.review.requestedTeams.length)
      ev.push(["team_requested", `${cur.author} asked @${cur.review.requestedTeams.join(", @")}`]);
    return ev;
  }
  if (cur.ci !== old.ci && ["SUCCESS", "FAILURE", "ERROR"].includes(cur.ci)) {
    if ("mine" in cur || cur.review?.reviewedByMe)
      ev.push(cur.ci === "SUCCESS" ? ["ci_passed", "CI passed"] : ["ci_failed", "CI failed"]);
  }
  if ("mine" in cur) {
    const m = cur.mine;
    const o = old.mine ?? {};
    if (cur.decision !== old.decision && (cur.decision === "APPROVED" || cur.decision === "CHANGES_REQUESTED")) {
      const who = m.reviewers.join(", ") || "a reviewer";
      ev.push(cur.decision === "APPROVED" ? ["approved", `Approved by ${who}`] : ["changes_requested", `Changes requested by ${who}`]);
    }
    if (m.threadsWaitingOnMe > (o.threadsWaitingOnMe ?? 0)) ev.push(["comments", `${m.threadsWaitingOnMe} review thread(s) waiting on you`]);
    else if ((m.lastOtherAt || "") > (o.lastOtherAt || "") && cur.decision === old.decision) ev.push(["activity", "New comment or review"]);
    if (cur.mergeable === "CONFLICTING" && old.mergeable !== "CONFLICTING") ev.push(["conflict", "Merge conflict"]);
    if (old.draft && !cur.draft) ev.push(["ready", "Marked ready for review"]);
  } else {
    const r = cur.review;
    const o = old.review ?? {};
    if (r.requestedMe && !o.requestedMe) ev.push(["review_requested", `${cur.author} asked you to review`]);
    else if (r.requestedTeams.length && !o.requestedTeams?.length) ev.push(["team_requested", `${cur.author} asked @${r.requestedTeams.join(", @")}`]);
    if (r.pushedSinceMyReview && !o.pushedSinceMyReview) ev.push(["pushed", "New commits since your review"]);
  }
  return ev;
}

async function closedState(key: string): Promise<string> {
  const [ownerRepo, num] = key.split("#");
  const [owner, repo] = ownerRepo.split("/");
  try {
    const d = await gql("query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){state}}}",
      { o: owner, r: repo, n: Number(num) });
    return d.repository.pullRequest.state;
  } catch {
    return "CLOSED";
  }
}

async function notify(title: string, text: string): Promise<void> {
  await run("osascript", ["-e", `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)} sound name "Glass"`]);
}

// ---------------------------------------------------------------- T3 projects

// The page badges each PR with its T3 project's icon. T3's own ProjectMonogram rule, decompiled
// from the app, so the badges match T3's sidebar: initials from the title, a colour from its hash.
const MONOGRAM_PALETTE = ["gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan",
  "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"];
const normName = (s: string): string => s.normalize("NFKC").trim();

function projectMonogram(name: string): string {
  const words = normName(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  const first = words[0];
  if (!first) return "PR";
  const chars = Array.from(first);
  const a = chars[0] ?? "P";
  const b = chars.slice(1).find((c) => /\p{N}/u.test(c)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : chars.at(-1)) ?? a;
  return Array.from((a + b).toUpperCase()).slice(0, 2).join("");
}

function projectColor(name: string): string {
  const s = normName(name).toLocaleLowerCase("en-US") || "project";
  let n = 0;
  for (const c of s) n = (n * 31 + (c.codePointAt(0) ?? 0)) % MONOGRAM_PALETTE.length;
  return MONOGRAM_PALETTE[n] ?? "blue";
}

/** What the badges need from t3_project_list's projects. */
function slimProjects(list: Obj[]): Obj[] {
  return list.filter((p) => !p.deletedAt && !p.archivedAt).map((p) => {
    const r = p.repositoryIdentity ?? null;
    return { title: p.title ?? "", owner: r?.owner ?? null, name: r?.name ?? null,
      atRoot: !!r && p.workspaceRoot === r.rootPath, icon: p.projectIcon ?? null, createdAt: p.createdAt ?? "" };
  });
}

const storeProjects = (db: DatabaseSync, list: Obj[]): void => metaSet(db, "t3Projects", { at: iso(now()), projects: slimProjects(list) });

/** The T3 Connect MCP URL that sweeps use, from the file `t3-mcp` writes. */
function t3McpUrl(user: User): string | null {
  const rel: string | null = sweepConfig(user.config).mcpConfig;
  const file = rel ? path.join(ROOT, rel) : path.join(user.dir, "t3-mcp.json");
  if (!fs.existsSync(file)) return null;
  return loadJson<Obj>(file, {}).mcpServers?.t3?.url ?? null;
}

/** One tool call over MCP's streamable HTTP transport: initialize, then tools/call. */
async function mcpCall(url: string, tool: string, args: Obj): Promise<Obj> {
  let session: string | null = null;
  let id = 0;
  const post = async (method: string, params: Obj, notification = false): Promise<Obj | null> => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (session) headers["Mcp-Session-Id"] = session;
    if (method !== "initialize") headers["MCP-Protocol-Version"] = "2025-06-18";
    const msg = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(15_000) });
    session = res.headers.get("mcp-session-id") ?? session;
    if (!res.ok) throw new Error(`T3 MCP ${method}: HTTP ${res.status}`);
    const text = await res.text();
    if (notification) return null;
    const replies: Obj[] = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(text)];
    const reply = replies.find((r) => r.id === id);
    if (!reply) throw new Error(`T3 MCP ${method}: no reply`);
    if (reply.error) throw new Error(`T3 MCP ${method}: ${reply.error.message}`);
    return reply.result;
  };
  await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pr-radar", version: "1" } });
  await post("notifications/initialized", {}, true);
  const result = (await post("tools/call", { name: tool, arguments: args }))!;
  const text: string | undefined = result.content?.find((c: Obj) => c.type === "text")?.text;
  if (result.isError) throw new Error(`T3 MCP ${tool}: ${text ?? "failed"}`);
  return result.structuredContent ?? JSON.parse(text ?? "{}");
}

/** T3 Code's local state database: T3_STATE_DB, else userdata/statev2.sqlite under T3CODE_HOME or ~/.t3. */
const t3StateDb = (): string => process.env.T3_STATE_DB ??
  path.join(process.env.T3CODE_HOME ?? path.join(process.env.HOME ?? "", ".t3"), "userdata", "statev2.sqlite");

/** The GitHub repo a folder belongs to, the way T3 finds it: the origin remote and the repo's top level. */
async function gitHubRepo(dir: string): Promise<Obj | null> {
  const top = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  if (top.code) return null;
  const remote = await run("git", ["-C", dir, "remote", "get-url", "origin"]);
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.stdout.trim());
  return m ? { owner: m[1], name: m[2], rootPath: top.stdout.trim() } : null;
}

/**
 * T3's projects, read-only from T3's own database, in t3_project_list's shape. T3 has no CLI or API
 * for this that works without an agent, so this reads its internal table (projection_projects), which
 * a T3 update could change. On any failure the refresh keeps the cached list.
 */
async function fetchT3Projects(): Promise<Obj[] | null> {
  const file = t3StateDb();
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  let rows: Obj[];
  try {
    rows = db.prepare(`select title, workspace_root, project_icon_json, created_at, archived_at
                       from projection_projects where deleted_at is null`).all() as Obj[];
  } finally {
    db.close();
  }
  return Promise.all(rows.map(async (r) => {
    const root = String(r.workspace_root).replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
    let icon: Obj | null = null;
    try { icon = r.project_icon_json ? JSON.parse(r.project_icon_json) : null; } catch { /* not JSON */ }
    return { title: r.title, workspaceRoot: root, repositoryIdentity: await gitHubRepo(root),
      projectIcon: icon, createdAt: r.created_at, archivedAt: r.archived_at };
  }));
}

/**
 * T3 threads snoozed right now, with the PRs each one links, or null when there's no MCP URL.
 * Snoozing a thread in T3 parks its PRs here too, until the snooze ends or you unsnooze it.
 */
async function fetchT3Snoozed(user: User): Promise<Obj[] | null> {
  const url = t3McpUrl(user);
  if (!url) return null;
  const out: Obj[] = [];
  let cursor: number | null = null;
  for (let page = 0; page < 10; page++) {
    const r: Obj = await mcpCall(url, "t3_thread_list",
      { allProjects: true, snoozed: true, limit: 100, ...(cursor === null ? {} : { cursor }) });
    for (const t of r.threads ?? []) {
      const prs = (t.pullRequests ?? [])
        .filter((pr: Obj) => (pr.host ?? "github.com") === "github.com" && pr.repository && pr.number)
        .map((pr: Obj) => `${pr.repository}#${pr.number}`.toLowerCase());
      if (t.snoozed && prs.length) out.push({ id: t.threadId, title: t.title ?? "", link: t.link ?? "", until: t.snoozedUntil ?? null, prs });
    }
    cursor = r.nextCursor ?? null;
    if (cursor === null) break;
  }
  return out;
}

/**
 * A repo's T3 badge: its project's icon if set, else T3's monogram for the project title, or for the
 * repo name when no T3 project has that repo. Several projects can share a repo (a subfolder opened
 * as its own project); the one opened at the repo root wins, then the oldest.
 */
function repoBadge(repo: string, projects: Obj[]): Obj {
  const [owner, name] = repo.toLowerCase().split("/");
  const p = projects
    .filter((x) => x.owner?.toLowerCase() === owner && x.name?.toLowerCase() === name)
    .sort((a, b) => Number(b.atRoot) - Number(a.atRoot) || String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  const label: string = p?.title || repo.split("/")[1] || repo;
  return { project: p?.title ?? null, monogram: projectMonogram(label), color: projectColor(label), icon: p?.icon ?? null };
}

// ---------------------------------------------------------------- refresh

/**
 * Light poll every open PR's fingerprint (about 2 GraphQL points), fetch full details only
 * for PRs whose fingerprint moved, rescore everything, diff, record events.
 */
async function refresh(user: User, sendNotifications = false, forceFull = false): Promise<Obj> {
  const profile = user.profile;
  const config = user.config;
  const me: string = profile.login;
  const org: string = profile.org;
  const db = user.db();
  try {
    for (const col of ["raw", "fp"]) { // databases created before these columns existed
      try { db.exec(`alter table prs add column ${col} text`); } catch { /* already there */ }
    }
    const lastFull = metaGet<string>(db, "lastFullRefresh");
    const full = forceFull || !lastFull || now().getTime() - parse(lastFull)!.getTime() > FULL_EVERY_HOURS * HOUR;
    // T3's project list for the badges, alongside GitHub; a failure keeps the cached list
    const t3Projects = fetchT3Projects().catch((e: Error) => { console.error("T3 projects:", e.message); return null; });
    // T3's snoozed threads, so their PRs park here too; a failure keeps the last list
    const t3Snoozed = fetchT3Snoozed(user).catch((e: Error) => { console.error("T3 snoozed threads:", e.message); return null; });
    const { nodes: light, rate } = await searchAll(`org:${org} is:pr is:open archived:false`, LIGHT_FIELDS, 100);
    const t = iso(now());
    const ignore = new Set<string>(profile.ignoreRepos ?? []);
    const stored = new Map<string, Obj>(all(db, "select key, item, raw, fp from prs where open=1").map((r) => [r.key, r]));
    const bots = new Map<string, number>();
    const todoIds: string[] = [];
    const fps = new Map<string, string>();
    for (const n of light) {
      const repo: string = n.repository.nameWithOwner;
      if (ignore.has(repo)) continue;
      const a = n.author ?? {};
      if (a.__typename === "Bot" || isBot(a.login)) {
        bump(bots, repo);
        continue;
      }
      const key = `${repo}#${n.number}`;
      fps.set(key, fingerprint(n));
      const row = stored.get(key);
      if (full || !row || row.raw === null || row.fp !== fps.get(key)) todoIds.push(n.id);
    }
    const fetched = new Map<string, Obj>();
    for (const n of await fetchFull(todoIds)) {
      const pr = flatten(n);
      fetched.set(pr.key, pr);
    }
    const closed = new Map<string, string>();
    for (const [key, row] of stored) {
      if (!fps.has(key) && "mine" in JSON.parse(row.item)) closed.set(key, await closedState(key));
    }
    const projects = await t3Projects;
    if (projects) storeProjects(db, projects);
    const snoozed = await t3Snoozed;
    if (snoozed) metaSet(db, "t3Snoozed", { at: iso(now()), threads: snoozed });
    const firstRefresh = !metaGet(db, "lastRefresh");
    const newEvents: [string, string, string, string, Obj][] = [];
    transaction(db, () => {
      for (const [key, fp] of fps) {
        const row = stored.get(key);
        const pr = fetched.get(key) ?? (row?.raw ? JSON.parse(row.raw) : null);
        if (!pr) continue;
        const item = scorePr(pr, me, profile);
        const prev = row ? JSON.parse(row.item) : null;
        if (!firstRefresh) for (const [kind, text] of diffEvents(prev, item)) newEvents.push([t, key, kind, text, item]);
        exec(db, `insert into prs(key, open, updated_at, item, raw, fp, first_seen, last_seen) values(?,1,?,?,?,?,?,?)
                  on conflict(key) do update set open=1, updated_at=excluded.updated_at, item=excluded.item,
                  raw=excluded.raw, fp=excluded.fp, last_seen=excluded.last_seen`,
          key, item.updatedAt, JSON.stringify(item), JSON.stringify(pr), fp, t, t);
      }
      for (const [key, row] of stored) {
        if (fps.has(key)) continue;
        exec(db, "update prs set open=0, last_seen=? where key=?", t, key);
        const state = closed.get(key);
        if (state) newEvents.push([t, key, state.toLowerCase(), state === "MERGED" ? "Merged" : "Closed", JSON.parse(row.item)]);
      }
      for (const [at, key, kind, text] of newEvents) exec(db, "insert into events(at, key, kind, text) values(?,?,?,?)", at, key, kind, text);
      exec(db, "delete from events where at < ?", iso(addMs(now(), -14 * DAY)));
      metaSet(db, "lastRefresh", t);
      if (full) metaSet(db, "lastFullRefresh", t);
      metaSet(db, "botPRsByRepo", Object.fromEntries(mostCommon(bots)));
    });
    if (sendNotifications) {
      const wanted = new Set<string>(config.notify?.kinds ?? []);
      for (const [, key, kind, text, item] of newEvents) if (wanted.has(kind)) await notify(`${key.split("/")[1]}: ${text}`, item.title);
    }
    return { open: light.length, full, fetched: todoIds.length, events: newEvents.map(([, k, kind, text]) => [k, kind, text]), remaining: rate.remaining };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- rhythm

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** The user's current block from config.rhythm: deep, quick, or off (with the next block). */
function rhythmNow(config: Obj, at: Date = now()): Obj | null {
  const r = config.rhythm;
  if (!r) return null;
  const local = Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(r.timezone);
  const hm = `${pad2(local.hour)}:${pad2(local.minute)}`;
  const localTime = `${WEEKDAYS[local.dayOfWeek - 1]} ${hm}`;
  const workdays: number[] = r.workdays ?? [1, 2, 3, 4, 5];
  const blocks: Obj[] = [...(r.blocks ?? [])].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  if (workdays.includes(local.dayOfWeek)) {
    for (const b of blocks) if (b.from <= hm && hm < b.to) return { ...b, localTime };
  }
  for (let add = 0; add < 8; add++) {
    const day = local.add({ days: add });
    if (!workdays.includes(day.dayOfWeek)) continue;
    for (const b of blocks) {
      if (add > 0 || b.from > hm)
        return { mode: "off", label: "Outside working hours", localTime, next: { ...b, day: WEEKDAYS[day.dayOfWeek - 1] } };
    }
  }
  return { mode: "off", label: "Outside working hours", localTime };
}

function refreshMinutes(config: Obj): number {
  const r = config.refresh ?? {};
  const rh = rhythmNow(config);
  return rh && rh.mode === "off" ? (r.offHoursMinutes ?? 60) : (r.workingMinutes ?? 5);
}

// ---------------------------------------------------------------- board

function hidden(item: Obj, tri: Obj | undefined): boolean {
  if (!tri) return false;
  if (tri.action === "snooze") return (tri.until || "") > iso(now());
  if (tri.action === "done") return item.updatedAt <= tri.at;
  return false;
}

/** A link the T3 Code desktop app opens straight to the thread (t3code://threads/<env>/<thread>). */
const t3ThreadUrl = (environmentId: string, threadId: string) => `t3code://threads/${quote(environmentId)}/${quote(threadId)}`;

function noteBasis(pr: Obj): string {
  return pr.updatedAt + "|" + pr.threads.map((t: Obj) => t.updatedAt || "").sort().join(",");
}

function buildBoard(user: User): Obj {
  const profile = user.profile;
  const config = user.config;
  return withDb(user, (db) => {
    const rows: Obj[] = all(db, "select item from prs where open=1").map((r) => JSON.parse(r.item));
    const threads = new Map<string, Obj[]>();
    const defaultEnv: string | undefined = config.t3?.environmentId;
    for (const r of all(db, "select * from threads order by updated_at desc")) {
      const m = /t3-thread:\/\/v2\/([^/]+)\//.exec(r.link || "");
      const env = m ? m[1] : defaultEnv;
      const list = threads.get(r.key) ?? [];
      list.push({ id: r.thread_id, title: r.title, link: r.link, updatedAt: r.updated_at, status: r.status,
        openUrl: env ? t3ThreadUrl(env, r.thread_id) : null });
      threads.set(r.key, list);
    }
    const notes = new Map<string, Obj>(all(db, "select * from notes").map((r) =>
      [r.key, { basis: r.basis, next: r.next, left: r.left_, question: r.question, why: r.why, at: r.at }]));
    const tri = new Map<string, Obj>(all(db, "select * from triage").map((r) => [r.key, { ...r }]));
    // PRs whose T3 thread is snoozed: the snooze that ends last wins; an open-ended one ("until" null) beats all
    const t3Snooze = new Map<string, Obj>();
    const nowIso = iso(now());
    for (const t of metaGet<Obj>(db, "t3Snoozed", null)?.threads ?? []) {
      if (t.until && t.until <= nowIso) continue;
      const m = /t3-thread:\/\/v2\/([^/]+)\//.exec(t.link || "");
      const env = m ? m[1] : defaultEnv;
      const s = { until: t.until, title: t.title, openUrl: env ? t3ThreadUrl(env, t.id) : null };
      for (const key of t.prs) {
        const prev = t3Snooze.get(key);
        if (!prev || (prev.until && (!s.until || s.until > prev.until))) t3Snooze.set(key, s);
      }
    }
    const lastSeen = metaGet<string>(db, "lastViewed", "") ?? "";
    const events: Obj[] = all(db, "select * from events order by id desc limit 60").map((r) => ({ ...r, new: r.at > lastSeen }));
    const byKey = new Map(rows.map((i) => [i.key, i]));
    for (const e of events) {
      const it = byKey.get(e.key);
      e.title = it ? it.title : "";
      e.url = it ? it.url : `https://github.com/${e.key.replace("#", "/pull/")}`;
    }

    const flat = (item: Obj, section: string, signals: Obj): Obj => {
      const out: Obj = {};
      for (const [k, v] of Object.entries(item)) if (!["mine", "review", "team"].includes(k)) out[k] = v;
      Object.assign(out, signals);
      out.section = section;
      out.id = docId(item.key);
      out.note = notes.get(item.key) ?? null;
      out.threads = threads.get(item.key.toLowerCase()) ?? [];
      out.triage = tri.get(item.key) ?? null;
      out.t3Snooze = t3Snooze.get(item.key.toLowerCase()) ?? null;
      out.hiddenBy = hidden(item, tri.get(item.key)) ? "radar" : out.t3Snooze ? "t3" : null;
      out.hidden = !!out.hiddenBy;
      out.events = events.filter((e) => e.key === item.key).map((e) => e.text).slice(0, 3);
      return out;
    };

    const mine = rows.filter((i) => "mine" in i).map((i) => flat(i, "mine", i.mine)).sort((a, b) => b.urgency - a.urgency);
    const candidates = rows.filter((i) => "review" in i && !i.draft).map((i) => flat(i, "review", i.review)).sort((a, b) => b.score - a.score);
    const top = candidates.filter((r) => r.score >= (profile.minReviewScore ?? 20)).slice(0, profile.maxReview ?? 10);
    const topKeys = new Set(top.map((r) => r.key));
    // PRs you're already part of stay on the list even when the score dropped them
    const involved = candidates.filter((r) => !topKeys.has(r.key) && (r.requestedMe || r.reviewedByMe));
    const review = [...top, ...involved];
    for (const r of review)
      r.participation = r.requestedMe ? "requested" : r.reviewedByMe ? "reviewed" : r.requestedTeams.length ? "team" : "suggested";
    const rkeys = new Set(review.map((r) => r.key));
    const team = rows.filter((i) => i.team && !rkeys.has(i.key)).map((i) => flat(i, "team", i.team))
      .sort((a, b) => b.score - a.score).slice(0, profile.maxTeam ?? 8);
    const picks: Obj[] = metaGet<Obj[]>(db, "picks", []) ?? [];
    for (const p of picks) p.id = docId(p.key);
    const t3Projects: Obj[] = metaGet<Obj>(db, "t3Projects", null)?.projects ?? [];
    const badges: Obj = {};
    for (const i of [...mine, ...review, ...team]) badges[i.repo] ??= repoBadge(i.repo, t3Projects);
    return {
      login: profile.login, org: profile.org,
      refreshedAt: metaGet(db, "lastRefresh"), triagedAt: metaGet(db, "triagedAt"),
      headline: metaGet(db, "headline", ""), picks,
      rhythm: rhythmNow(config),
      refreshMinutes: refreshMinutes(config),
      totals: { open: rows.length, mine: mine.length },
      botPRsByRepo: metaGet(db, "botPRsByRepo", {}),
      events, lastViewed: lastSeen,
      sweeps: all(db, "select * from sweeps order by id desc limit 8").map((r) => ({ ...r })),
      projects: badges, projectsAt: metaGet<Obj>(db, "t3Projects", null)?.at ?? null,
      mine, review, team,
    };
  });
}

const pyStr = (v: unknown): string => (v === null || v === undefined ? "None" : String(v));

function boardMarkdown(b: Obj): string {
  const line = (i: Obj): string => {
    const tag = i.action || i.stall || (i.reasons ?? []).slice(0, 2).join(", ");
    const bits = [`[${i.repo.split("/")[1]}#${i.number}](${i.url}) ${i.title}`, `*${tag}* [${pyStr(i.effort)}]`];
    const n = i.note ?? {};
    for (const k of ["question", "next", "left", "why"]) if (n[k]) bits.push((k === "question" ? "Waiting on you: " : "") + n[k]);
    return "- " + bits.join(" — ");
  };
  const out = [`# PR radar for ${b.login}`, `Refreshed ${pyStr(b.refreshedAt)}, triaged ${pyStr(b.triagedAt)}.`, ""];
  const rh = b.rhythm;
  if (rh) out.push(`Now: ${pyStr(rh.label)} (${pyStr(rh.localTime)})`, "");
  if (b.headline) out.push(b.headline, "");
  for (const [sec, title] of [["mine", "Your pull requests"], ["review", "Reviewing"], ["team", "Stalled near the finish"]]) {
    const items = b[sec].filter((i: Obj) => !i.hidden);
    out.push(`## ${title} (${items.length})`, ...(items.length ? items.map(line) : ["- nothing right now"]), "");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- sweeps (Claude, headless)

const SWEEP_TOOLS = [
  "Read", "Skill", "ToolSearch",
  "Bash(node radar.ts:*)", "Bash(gh pr view:*)", "Bash(gh api user:*)",
  "mcp__t3__t3_thread_list", "mcp__t3__t3_thread_read", "mcp__t3__t3_thread_search",
];
const SWEEP_DEFAULTS: Obj = { enabled: true, minIntervalMinutes: 30, maxPerDay: 16, maxBudgetUsd: 3.0,
  keepLogDays: 7, timeoutMinutes: 20, mcpConfig: null, model: null };
const URGENT_KINDS = new Set(["review_requested", "team_requested", "ci_failed", "changes_requested", "comments", "conflict", "approved"]);

const sweepConfig = (config: Obj): Obj => ({ ...SWEEP_DEFAULTS, ...(config.sweep ?? {}) });

const ownPrsNeedingNotes = (board: Obj): string[] =>
  board.mine.filter((pr: Obj) => (pr.note ?? {}).basis !== noteBasis(pr)).map((pr: Obj) => pr.key);

/** Why a sweep should run now, or null. Cheap: reads only the database. */
function sweepReason(user: User, force = false): string | null {
  const cfg = sweepConfig(user.config);
  const { last, running, today, urgent, lastBlock } = withDb(user, (db) => {
    const last = one(db, "select * from sweeps where status != 'running' order by id desc limit 1");
    const running = one(db, "select 1 from sweeps where status='running' and started_at > ?",
      iso(addMs(now(), -(cfg.timeoutMinutes + 5) * MIN)));
    const today = Number(one(db, "select count(*) as n from sweeps where started_at > ?", iso(addMs(now(), -DAY)))!.n);
    const since = last ? last.started_at : "";
    const urgent = all(db, "select text, kind from events where at > ?", since).filter((r) => URGENT_KINDS.has(r.kind)).map((r) => r.text as string);
    return { last, running, today, urgent, lastBlock: metaGet<string>(db, "lastSweepBlock") };
  });
  if (running) return null;
  if (force) return "asked for from the page";
  if (!cfg.enabled || today >= cfg.maxPerDay) return null;
  const rh = rhythmNow(user.config);
  if (rh && rh.mode === "off") return null;
  if (last && now().getTime() - parse(last.started_at)!.getTime() < cfg.minIntervalMinutes * MIN) return null;
  if (!last) return "first sweep";
  const block = rh ? rh.label : null;
  if (block && block !== lastBlock) return `now in ${block}`;
  if (urgent.length) return ("new: " + [...new Set(urgent)].join("; ")).slice(0, 205);
  const moved = ownPrsNeedingNotes(buildBoard(user));
  if (moved.length) return `${moved.length} of your PRs moved`;
  return null;
}

function sweepPrompt(user: User, reason: string, hasT3: boolean): string {
  return (
    `Run a pr-radar sweep for ${user.login}, following .agents/skills/pr-radar/SKILL.md exactly. ` +
    `This sweep was triggered because: ${reason}. ` +
    "This is a headless run started by radar.ts: nobody can answer questions, there is no T3 thread to " +
    "settle (skip step 6), and the page picks up your notes and picks on its own. " +
    (hasT3
      ? "T3's tools are available through the MCP server named t3 (tool names start with mcp__t3__); load them with ToolSearch. "
      : "T3's tools are not available in this run: skip step 2 and work from the threads already linked. ") +
    "End with the step 5 report and nothing else."
  );
}

function pruneSweepLogs(user: User, keepDays: number): void {
  const dir = path.join(user.dir, "logs", "sweeps");
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - keepDays * DAY;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p);
  }
}

/** Run one headless Claude sweep; log the transcript; record the outcome. Returns the sweeps row id. */
async function runSweep(user: User, reason: string): Promise<number> {
  const cfg = sweepConfig(user.config);
  const logDir = path.join(user.dir, "logs", "sweeps");
  fs.mkdirSync(logDir, { recursive: true });
  const started = now();
  const stamp = iso(started).replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
  const logPath = path.join(logDir, `${stamp}.jsonl`);
  const rh = rhythmNow(user.config);
  const sweepId = withDb(user, (db) => {
    const res = exec(db, "insert into sweeps(started_at, reason, status, log_path) values(?,?,?,?)",
      iso(started), reason, "running", path.relative(ROOT, logPath));
    metaSet(db, "lastSweepBlock", rh ? rh.label : null);
    return Number(res.lastInsertRowid);
  });

  const mcp: string | null = cfg.mcpConfig ? path.join(ROOT, cfg.mcpConfig) : null;
  const hasT3 = !!(mcp && fs.existsSync(mcp));
  const args = ["-p", sweepPrompt(user, reason, hasT3), "--output-format", "stream-json", "--verbose",
    "--permission-mode", "dontAsk", "--allowedTools", ...SWEEP_TOOLS, "--strict-mcp-config",
    "--no-session-persistence", "--max-budget-usd", String(cfg.maxBudgetUsd)];
  if (hasT3) args.push("--mcp-config", mcp!);
  if (cfg.model) args.push("--model", cfg.model);
  let status = "error";
  let summary = "";
  let cost: number | null = null;
  let turns: number | null = null;
  try {
    fs.writeFileSync(logPath, JSON.stringify({ type: "radar", reason, t3: hasT3, startedAt: iso(started) }) + "\n");
    const fd = fs.openSync(logPath, "a");
    const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((resolve, reject) => {
      const child = spawn("claude", args, { cwd: ROOT, stdio: ["ignore", fd, fd] });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, cfg.timeoutMinutes * MIN);
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, timedOut }); });
    }).finally(() => fs.closeSync(fd));
    if (outcome.timedOut) summary = `timed out after ${cfg.timeoutMinutes} minutes`;
    else {
      let result: Obj | null = null;
      for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "result") result = msg;
        } catch { /* not JSON */ }
      }
      if (result) {
        status = result.is_error || outcome.code ? "error" : "ok";
        summary = String(result.result || result.subtype || "").slice(0, 4000);
        cost = result.total_cost_usd ?? null;
        turns = result.num_turns ?? null;
      } else summary = `claude exited with code ${outcome.code} and no result; see the log`;
    }
  } catch (e) {
    summary = `could not run claude: ${(e as Error).message}`;
  }
  const fails = withDb(user, (db) => {
    exec(db, "update sweeps set finished_at=?, status=?, summary=?, cost_usd=?, turns=? where id=?",
      iso(now()), status, summary, cost, turns, sweepId);
    exec(db, "delete from sweeps where started_at < ?", iso(addMs(now(), -cfg.keepLogDays * DAY)));
    return all(db, "select status from sweeps order by id desc limit 2").map((r) => r.status);
  });
  pruneSweepLogs(user, cfg.keepLogDays);
  if (fails.length === 2 && fails.every((s) => s === "error")) await notify("pr-radar: sweeps are failing", summary.slice(0, 120));
  return sweepId;
}

// ---------------------------------------------------------------- avatars

/** GitHub's login charset, plus the [bot] suffix of app accounts. Anything else never reaches the filesystem. */
const AVATAR_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const AVATAR_MAX_AGE_MS = 30 * DAY;
const AVATAR_RETRY_MS = HOUR; // after a failed fetch, before trying GitHub again
const AVATAR_MAX_BYTES = 1024 * 1024;

/** The image type from its first bytes, or null when it isn't an image we serve. */
function imageType(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/**
 * Fetch https://github.com/<login>.png?size=40 (it redirects to avatars.githubusercontent.com).
 * App accounts 404 there as `name[bot]`, but most serve their icon under the bare name.
 */
async function fetchAvatar(login: string): Promise<Buffer | null> {
  const names = login.endsWith("[bot]") ? [login, login.slice(0, -"[bot]".length)] : [login];
  for (const name of names) {
    try {
      const res = await fetch(`https://github.com/${encodeURIComponent(name)}.png?size=40`, {
        redirect: "follow", signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length <= AVATAR_MAX_BYTES && imageType(buf)) return buf;
    } catch { /* try the next name */ }
  }
  return null;
}

// ---------------------------------------------------------------- project icons

// A T3 project icon is a Lucide icon name, and T3's Lucide still draws old names (globe-2 is drawn
// as earth). The server resolves a name through lucide-react's export list, which carries the
// aliases, fetches the SVG from lucide-static once and serves it from users/<user>/icons/.
const LUCIDE_VERSION = "1.81.0";
const LUCIDE_CDN = "https://cdn.jsdelivr.net/npm";
const ICON_NAME = /^[a-z0-9-]{1,64}$/;
const ICON_MAX_BYTES = 64 * 1024;
const squash = (s: string): string => s.toLowerCase().replace(/-/g, ""); // globe-2 and Globe2 both become globe2

let lucideNames: Promise<Map<string, string>> | null = null;
/** Every Lucide name and alias, squashed, to the icon file that draws it. Fetched once per server. */
function lucideIndex(): Promise<Map<string, string>> {
  lucideNames ??= (async () => {
    const res = await fetch(`${LUCIDE_CDN}/lucide-react@${LUCIDE_VERSION}/dist/esm/lucide-react.mjs`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`lucide-react: HTTP ${res.status}`);
    const map = new Map<string, string>();
    for (const m of (await res.text()).matchAll(/export \{([^}]*)\} from '\.\/icons\/([a-z0-9-]+)\.m?js'/g))
      for (const n of m[1].matchAll(/default as (\w+)/g)) map.set(squash(n[1]), m[2]);
    return map;
  })().catch((e: Error) => { lucideNames = null; throw e; });
  return lucideNames;
}

/** The SVG for a T3 project icon name, or null when Lucide has no such icon or the fetch failed. */
async function fetchLucideSvg(name: string): Promise<Buffer | null> {
  try {
    const file = (await lucideIndex()).get(squash(name));
    if (!file) return null;
    const res = await fetch(`${LUCIDE_CDN}/lucide-static@${LUCIDE_VERSION}/icons/${file}.svg`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= ICON_MAX_BYTES && /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(buf.toString("utf8", 0, 2048)) ? buf : null;
  } catch (e) {
    console.error(`icon ${name}:`, (e as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------- server

class Server {
  user: User;
  notifyOn: boolean;
  sweepsOn: boolean;
  refreshing: Promise<Obj | null> | null = null;
  lastError: string | null = null;
  sweeping = false;
  avatarFetches = new Map<string, Promise<Buffer | null>>(); // one GitHub fetch per login at a time
  avatarFailures = new Map<string, number>(); // login -> when its last fetch failed
  iconFetches = new Map<string, Promise<Buffer | null>>();
  iconFailures = new Map<string, number>(); // icon name -> when its last fetch failed

  constructor(user: User, notifyOn: boolean, sweepsOn: boolean) {
    this.user = user;
    this.notifyOn = notifyOn;
    this.sweepsOn = sweepsOn;
  }

  /**
   * The avatar for a GitHub login, from users/<user>/avatars/<login>.png when it's under 30 days old,
   * otherwise fetched once and saved. A stale file still serves if the refetch fails. Null: no avatar.
   */
  async avatar(login: string): Promise<Buffer | null> {
    if (!AVATAR_LOGIN.test(login)) return null;
    const dir = path.join(this.user.dir, "avatars");
    const file = path.join(dir, `${login}.png`);
    let cached: Buffer | null = null;
    try {
      const st = fs.statSync(file);
      cached = fs.readFileSync(file);
      if (Date.now() - st.mtimeMs < AVATAR_MAX_AGE_MS) return cached;
    } catch { /* not cached yet */ }
    const failedAt = this.avatarFailures.get(login);
    if (failedAt && Date.now() - failedAt < AVATAR_RETRY_MS) return cached;
    let pending = this.avatarFetches.get(login);
    if (!pending) {
      pending = fetchAvatar(login).then((buf) => {
        if (buf) {
          fs.mkdirSync(dir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, buf);
          fs.renameSync(tmp, file);
          this.avatarFailures.delete(login);
        } else this.avatarFailures.set(login, Date.now());
        return buf;
      }).finally(() => this.avatarFetches.delete(login));
      this.avatarFetches.set(login, pending);
    }
    return (await pending) ?? cached;
  }

  /** A Lucide icon for a T3 project, from users/<user>/icons/<name>.svg, fetched once and kept. Null: no icon. */
  async icon(name: string): Promise<Buffer | null> {
    if (!ICON_NAME.test(name)) return null;
    const dir = path.join(this.user.dir, "icons");
    const file = path.join(dir, `${name}.svg`);
    try { return fs.readFileSync(file); } catch { /* not cached yet */ }
    const failedAt = this.iconFailures.get(name);
    if (failedAt && Date.now() - failedAt < AVATAR_RETRY_MS) return null;
    let pending = this.iconFetches.get(name);
    if (!pending) {
      pending = fetchLucideSvg(name).then((buf) => {
        if (buf) {
          fs.mkdirSync(dir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, buf);
          fs.renameSync(tmp, file);
          this.iconFailures.delete(name);
        } else this.iconFailures.set(name, Date.now());
        return buf;
      }).finally(() => this.iconFetches.delete(name));
      this.iconFetches.set(name, pending);
    }
    return pending;
  }

  /** Refresh unless one is running; the page's button waits for the running one instead. */
  doRefresh(background = false): Promise<Obj | null> {
    if (this.refreshing) return background ? Promise.resolve(null) : this.refreshing;
    this.refreshing = refresh(this.user, this.notifyOn)
      .then((out) => { this.lastError = null; return out; })
      .catch((e: Error) => { this.lastError = e.message; return null; }) // keep serving; show it on the page
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Start a sweep in the background if one is due (or forced). Returns the reason, or null. */
  startSweep(force = false): string | null {
    if (this.sweeping) return null;
    const reason = sweepReason(this.user, force);
    if (!reason) return null;
    this.sweeping = true;
    runSweep(this.user, reason)
      .catch((e: Error) => console.error("sweep failed:", e))
      .finally(() => { this.sweeping = false; });
    return reason;
  }

  async tick(): Promise<void> {
    const last = withDb(this.user, (db) => metaGet<string>(db, "lastRefresh"));
    const due = !last || now().getTime() - parse(last)!.getTime() >= refreshMinutes(this.user.config) * MIN;
    if (!due) return;
    await this.doRefresh(true);
    if (this.sweepsOn) this.startSweep();
  }

  board(): Obj {
    const b = buildBoard(this.user);
    b.refreshing = !!this.refreshing;
    b.error = this.lastError;
    b.sweepsEnabled = this.sweepsOn;
    return b;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, port: number): Promise<void> {
    const send = (code: number, body: unknown, ctype = "application/json") => {
      const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      res.writeHead(code, { "Content-Type": ctype, "Cache-Control": "no-store" });
      res.end(data);
    };
    const url = req.url ?? "/";
    if (req.method === "GET") {
      if (url === "/" || url === "/index.html") return send(200, fs.readFileSync(path.join(ROOT, "web", "index.html")), "text/html; charset=utf-8");
      if (url === "/api/board") return send(200, this.board());
      if (url.startsWith("/avatar/")) {
        let login = "";
        try { login = decodeURIComponent(url.slice("/avatar/".length).split("?")[0]); } catch { /* malformed escape */ }
        const img = await this.avatar(login);
        if (!img) return send(404, { error: "no avatar" });
        res.writeHead(200, { "Content-Type": imageType(img)!, "Cache-Control": "private, max-age=86400" });
        return void res.end(img);
      }
      const iconMatch = /^\/icon\/([a-z0-9-]+)\.svg(?:\?.*)?$/.exec(url);
      if (iconMatch) {
        const svg = await this.icon(iconMatch[1]);
        if (!svg) return send(404, { error: "no such icon" });
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=86400",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
        return void res.end(svg);
      }
      return send(404, { error: "not found" });
    }
    if (req.method !== "POST") return send(405, { error: "method not allowed" });
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`)
      return send(403, { error: "cross-origin request refused" });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body: Obj = raw ? JSON.parse(raw) : {};
    if (url === "/api/refresh") {
      await this.doRefresh();
      return send(200, this.board());
    }
    if (url === "/api/triage") {
      withDb(this.user, (db) => {
        const { key, action } = body;
        if (action === "clear") exec(db, "delete from triage where key=?", key);
        else {
          const until = action === "snooze" ? iso(addMs(now(), Number(body.days ?? 1) * DAY)) : null;
          exec(db, `insert into triage(key, action, until, at) values(?,?,?,?)
                    on conflict(key) do update set action=excluded.action, until=excluded.until, at=excluded.at`,
            key, action, until, iso(now()));
        }
      });
      return send(200, this.board());
    }
    if (url === "/api/sweep") {
      const reason = this.startSweep(true);
      return send(reason ? 200 : 409, { started: !!reason, error: reason ? null : "a sweep is already running" });
    }
    if (url === "/api/open") {
      // T3's built-in browser asks before following any app link, and isn't signed in to GitHub.
      // The server opens T3's own links and GitHub links through macOS instead: a click goes
      // straight to the thread or draft, and GitHub opens in the default browser.
      if (origin === undefined) return send(403, { error: "origin required" });
      const target = typeof body.url === "string" ? URL.parse(body.url) : null;
      const t3 = target?.protocol === "t3code:" && ["threads", "new"].includes(target.hostname);
      const github = target?.protocol === "https:" && target.hostname === "github.com" && !target.username && !target.password;
      if (!target || !(t3 || github))
        return send(400, { error: "only t3code://threads, t3code://new and https://github.com links" });
      const r = await run("open", [target.href]);
      return send(r.code ? 500 : 200, r.code ? { error: r.stderr.trim() || "open failed" } : { ok: true });
    }
    if (url === "/api/viewed") {
      withDb(this.user, (db) => metaSet(db, "lastViewed", iso(now())));
      return send(200, { ok: true });
    }
    return send(404, { error: "not found" });
  }
}

// ---------------------------------------------------------------- commands

type Values = Record<string, string | boolean | string[] | undefined>;
type Command = {
  help: string;
  user?: boolean; // takes --user (all but stats)
  options?: Record<string, { type: "string" | "boolean"; multiple?: boolean; default?: string; help?: string }>;
  positionals?: string[]; // names; a trailing "..." takes the rest
  required?: string[];
  run: (v: Values, pos: string[]) => Promise<void> | void;
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const userOf = (v: Values) => new User(str(v.user)!);

function upsertThread(db: DatabaseSync, key: string, tid: string, title: string, link: string, updated: string, status: string): void {
  exec(db, `insert into threads(key, thread_id, title, link, updated_at, status) values(?,?,?,?,?,?)
            on conflict(key, thread_id) do update set title=excluded.title, link=excluded.link,
            updated_at=excluded.updated_at, status=excluded.status`,
    key.toLowerCase(), tid, title, link, updated, status);
}

const STAT_FIELDS = `
  number title createdAt
  repository { nameWithOwner }
  author { login }
  files(first: 60) { nodes { path } }
`;

async function stats(v: Values, login: string): Promise<void> {
  const org = str(v.org) ?? "Runn-Fast";
  const since = str(v.since) ?? iso(addMs(now(), -365 * DAY)).slice(0, 10);
  const { nodes: authored } = await searchAll(`org:${org} is:pr author:${login} created:>=${since}`, STAT_FIELDS, 25);
  const { nodes: reviewedAll } = await searchAll(`org:${org} is:pr reviewed-by:${login} created:>=${since}`, STAT_FIELDS, 25);
  const reviewed = reviewedAll.filter((n) => n.author?.login !== login);
  const scopeRe = /^(\w+)(?:\(([^)]+)\))?!?:/;
  const summarize = (prs: Obj[]): Obj => {
    const repos = new Map<string, number>();
    const scopes = new Map<string, number>();
    const authors = new Map<string, number>();
    const dirs: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map() };
    for (const n of prs) {
      const repo: string = n.repository.nameWithOwner;
      bump(repos, repo);
      bump(authors, String(n.author?.login ?? null));
      const m = scopeRe.exec(n.title);
      if (m) bump(scopes, m[2] ? `${m[1]}(${m[2]})` : m[1]);
      const touched = new Set<string>();
      for (const f of n.files.nodes) {
        const parts = f.path.split("/");
        for (const d of [2, 3, 4]) touched.add(`${d}\u0000${parts.length > d ? parts.slice(0, d).join("/") : f.path}`);
      }
      for (const t of touched) {
        const [d, p] = t.split("\u0000");
        bump(dirs[Number(d)], `${repo.split("/")[1]}:${p}`);
      }
    }
    return {
      count: prs.length, repos: mostCommon(repos, 20), titleScopes: mostCommon(scopes, 40),
      dirsDepth2: mostCommon(dirs[2], 40), dirsDepth3: mostCommon(dirs[3], 50), dirsDepth4: mostCommon(dirs[4], 50),
      authors: mostCommon(authors, 20),
      sampleTitles: prs.slice(0, 80).map((n) => `${n.repository.nameWithOwner.split("/")[1]}#${n.number} ${n.title}`),
    };
  };
  const tz = str(v.tz) ?? Temporal.Now.timeZoneId();
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Map<string, number>();
  for (const n of authored) {
    const t = Temporal.Instant.from(n.createdAt).toZonedDateTimeISO(tz);
    hours[t.hour] += 1;
    bump(weekdays, WEEKDAYS[t.dayOfWeek - 1]);
  }
  const teams = (await run("gh", ["api", "/user/teams", "--paginate", "-q", `.[] | select(.organization.login=="${org}") | .slug`]))
    .stdout.split(/\s+/).filter(Boolean);
  const out = {
    login, org, since, teamsOfAuthenticatedUser: teams,
    activity: { timezone: tz, prsOpenedByHour: hours, prsOpenedByWeekday: Object.fromEntries(mostCommon(weekdays)) },
    authored: summarize(authored), reviewed: summarize(reviewed),
  };
  const text = dump(out);
  if (str(v.out)) {
    fs.writeFileSync(str(v.out)!, text);
    console.log(str(v.out));
  } else console.log(text);
}

const COMMANDS: Record<string, Command> = {
  refresh: {
    help: "poll open PRs, score, diff, record events (no model)",
    user: true,
    options: { notify: { type: "boolean", help: "macOS notifications for config.notify.kinds" },
      full: { type: "boolean", help: "fetch every PR in full, not just changed ones" } },
    run: async (v) => console.log(dump(await refresh(userOf(v), !!v.notify, !!v.full))),
  },
  serve: {
    help: "serve the page on 127.0.0.1 and refresh in the background",
    user: true,
    options: { port: { type: "string" }, notify: { type: "boolean" },
      sweeps: { type: "boolean", help: "also run Claude sweeps when the gate says one is due" } },
    run: (v) => {
      const user = userOf(v);
      const port = Number(str(v.port) ?? user.config.port ?? 7424);
      const srv = new Server(user, !!v.notify, !!v.sweeps);
      http.createServer((req, res) => {
        srv.handle(req, res, port).catch((e: Error) => {
          if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        });
      }).listen(port, "127.0.0.1", () => console.log(`pr-radar for ${user.login} on http://127.0.0.1:${port}`));
      const tick = () => srv.tick().catch((e: Error) => console.error("tick failed:", e));
      tick();
      setInterval(tick, 30_000);
    },
  },
  "t3-mcp": {
    help: "store T3 Connect's MCP URL from stdin for sweeps",
    user: true,
    run: (v) => {
      const url = fs.readFileSync(0, "utf8").trim();
      if (!/^https?:\/\//.test(url)) die("expected T3's MCP URL on stdin, e.g. `pbpaste | node radar.ts t3-mcp --user <login>`");
      const user = userOf(v);
      const file = path.join(user.dir, "t3-mcp.json");
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { t3: { type: "http", url } } }), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      console.log(`wrote ${path.relative(ROOT, file)}; sweeps will use T3's tools from the next run`);
    },
  },
  sweep: {
    help: "run a headless Claude sweep if one is due (see sweepReason)",
    user: true,
    options: { force: { type: "boolean", help: "run even if the gate says no" },
      "dry-run": { type: "boolean", help: "only print whether a sweep would run, and why" } },
    run: async (v) => {
      const user = userOf(v);
      const reason = sweepReason(user, !!v.force);
      if (v["dry-run"] || !reason) {
        console.log(JSON.stringify({ wouldRun: !!reason, reason }));
        return;
      }
      const id = await runSweep(user, reason);
      console.log(dump(withDb(user, (db) => ({ ...one(db, "select * from sweeps where id=?", id) }))));
    },
  },
  todo: {
    help: "own PRs whose PR or thread moved since their note",
    user: true,
    run: (v) => {
      const b = buildBoard(userOf(v));
      const todo = b.mine.filter((pr: Obj) => (pr.note ?? {}).basis !== noteBasis(pr)).map((pr: Obj) => ({
        key: pr.key, title: pr.title, action: pr.action, effort: pr.effort, flags: pr.flags, requested: pr.requested,
        basis: noteBasis(pr), threads: pr.threads, recentEvents: pr.events,
      }));
      console.log(dump({ mine: todo }));
    },
  },
  note: {
    help: "record the judgement for one PR",
    user: true,
    positionals: ["pr"],
    options: { basis: { type: "string", help: "the basis string `todo` printed for this PR" },
      next: { type: "string", help: "the one next step, imperative, under 15 words" },
      left: { type: "string", help: "what's left before merge, one or two sentences" },
      question: { type: "string", help: "an open question waiting on the user, if any" },
      why: { type: "string", help: "review/team items: why this person, in one sentence" } },
    required: ["basis"],
    run: (v, [pr]) => withDb(userOf(v), (db) => {
      exec(db, `insert into notes(key, basis, next, left_, question, why, at) values(?,?,?,?,?,?,?)
                on conflict(key) do update set basis=excluded.basis, next=excluded.next, left_=excluded.left_,
                question=excluded.question, why=excluded.why, at=excluded.at`,
        pr, str(v.basis)!, str(v.next) ?? null, str(v.left) ?? null, str(v.question) ?? null, str(v.why) ?? null, iso(now()));
    }),
  },
  picks: {
    help: "record the headline and up to three picks",
    user: true,
    options: { headline: { type: "string" }, pick: { type: "string", multiple: true, help: "'Owner/repo#123=why now', best first" } },
    run: (v) => {
      const picks = ((v.pick as string[] | undefined) ?? []).map((s) => {
        const i = s.indexOf("=");
        return i === -1 ? { key: s, why: "" } : { key: s.slice(0, i), why: s.slice(i + 1) };
      });
      withDb(userOf(v), (db) => {
        metaSet(db, "picks", picks);
        metaSet(db, "headline", str(v.headline) || "");
        metaSet(db, "triagedAt", iso(now()));
      });
    },
  },
  board: {
    help: "print the board (Markdown, or --json)",
    user: true,
    options: { json: { type: "boolean" } },
    run: (v) => {
      const b = buildBoard(userOf(v));
      console.log(v.json ? dump(b) : boardMarkdown(b));
    },
  },
  rhythm: {
    help: "print the user's current work block",
    user: true,
    run: (v) => console.log(dump(rhythmNow(userOf(v).config))),
  },
  "link-thread": {
    help: "record a T3 thread that works on a PR",
    user: true,
    positionals: ["pr", "thread_id"],
    options: { title: { type: "string" }, link: { type: "string", default: "" },
      "updated-at": { type: "string" }, status: { type: "string", default: "" } },
    required: ["title", "updated-at"],
    run: (v, [pr, tid]) => withDb(userOf(v), (db) =>
      upsertThread(db, pr, tid, str(v.title)!, str(v.link) ?? "", str(v["updated-at"])!, str(v.status) ?? "")),
  },
  "ingest-threads": {
    help: "record PR links from saved t3_thread_list results",
    user: true,
    positionals: ["files..."],
    options: { floor: { type: "string", help: "ISO date: stop paging once threads are older than this" },
      skip: { type: "string", help: "thread id to ignore (the one you're running in)" },
      commit: { type: "boolean", help: "last page read: record the scan time" } },
    run: (v, files) => withDb(userOf(v), (db) => {
      const since = metaGet<string>(db, "lastThreadScan", "") || "";
      let newest = since;
      let oldest: string | null = null;
      let linked = 0;
      let nextCursor: unknown = null;
      transaction(db, () => {
        for (const file of files) {
          const d = loadJson<Obj>(file, {});
          nextCursor = d.nextCursor ?? null;
          for (const t of d.threads ?? []) {
            if (t.parentThreadId || t.threadId === str(v.skip)) continue;
            const up: string = t.updatedAt ?? "";
            if (up > newest) newest = up;
            oldest = oldest === null || up < oldest ? up : oldest;
            for (const pr of t.pullRequests ?? []) {
              if ((pr.host ?? "github.com") !== "github.com") continue;
              upsertThread(db, `${pr.repository}#${pr.number}`, t.threadId, t.title ?? "", t.link ?? "", up, t.status ?? "");
              linked += 1;
            }
          }
        }
        if (v.commit) metaSet(db, "lastThreadScan", newest);
      });
      const floor = str(v.floor) || "";
      const bar = since > floor ? since : floor;
      console.log(dump({ linked, oldestThreadInPages: oldest, nextCursor,
        keepPaging: !!nextCursor && ((oldest ?? "") as string) > bar, lastThreadScan: metaGet(db, "lastThreadScan") }));
    }),
  },
  "t3-projects": {
    help: "cache T3's project list (for the badges) from saved t3_project_list results",
    user: true,
    positionals: ["files..."],
    run: (v, files) => withDb(userOf(v), (db) => {
      const list = files.flatMap((f) => loadJson<Obj>(f, {}).projects ?? []);
      if (!list.length) die("no projects in those files; save t3_project_list's JSON output and pass its path");
      storeProjects(db, list);
      console.log(dump({ projects: list.length }));
    }),
  },
  "thread-scan": {
    help: "get or set the last T3 thread scan time",
    user: true,
    options: { set: { type: "string" } },
    run: (v) => withDb(userOf(v), (db) => {
      if (str(v.set)) metaSet(db, "lastThreadScan", str(v.set));
      console.log(metaGet(db, "lastThreadScan") || "never");
    }),
  },
  stats: {
    help: "one-off: a year of authored and reviewed PRs, for a profile",
    positionals: ["login"],
    options: { org: { type: "string", default: "Runn-Fast" }, since: { type: "string" }, tz: { type: "string" }, out: { type: "string" } },
    run: (v, [login]) => stats(v, login),
  },
};

function usage(name?: string): string {
  if (name && COMMANDS[name]) {
    const c = COMMANDS[name];
    const lines = [`usage: node radar.ts ${name}${c.user ? " --user <login>" : ""}${(c.positionals ?? []).map((p) => ` <${p}>`).join("")} [options]`, "", c.help, ""];
    for (const [k, o] of Object.entries(c.options ?? {})) lines.push(`  --${k}${o.type === "string" ? " <value>" : ""}${o.multiple ? " (repeatable)" : ""}${o.help ? `  ${o.help}` : ""}`);
    return lines.join("\n");
  }
  return ["usage: node radar.ts <command> [options]", "", "commands:",
    ...Object.entries(COMMANDS).map(([k, c]) => `  ${k.padEnd(15)} ${c.help}`), "", "Run `node radar.ts <command> --help` for a command's options."].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h") return void console.log(usage());
  const c = COMMANDS[name];
  if (!c) die(`unknown command ${name}\n\n${usage()}`);
  if (rest.includes("--help") || rest.includes("-h")) return void console.log(usage(name));
  const options: Record<string, { type: "string" | "boolean"; multiple?: boolean; default?: string }> = {};
  for (const [k, o] of Object.entries(c.options ?? {})) {
    options[k] = { type: o.type }; // parseArgs rejects keys that are present but undefined
    if (o.multiple) options[k].multiple = true;
    if (o.default !== undefined) options[k].default = o.default;
  }
  if (c.user) options.user = { type: "string" };
  const { values, positionals } = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
  for (const r of [...(c.user ? ["user"] : []), ...(c.required ?? [])]) if (values[r] === undefined) die(`${name}: --${r} is required\n\n${usage(name)}`);
  const want = c.positionals ?? [];
  const variadic = want.at(-1)?.endsWith("...");
  if (variadic ? positionals.length < want.length : positionals.length !== want.length)
    die(`${name}: expected ${want.map((p) => `<${p}>`).join(" ") || "no arguments"}\n\n${usage(name)}`);
  await c.run(values as Values, positionals);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Exit ? e.message : e);
  process.exit(1);
});
