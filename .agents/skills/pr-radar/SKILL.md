---
name: pr-radar
description: Run a pr-radar sweep, which reads what moved on the user's pull requests and refreshes their notes, picks and headline on the local PR radar page. Use when asked to sweep or triage, what PRs need me, or what to review next.
---

# PR radar sweep

The radar is a local app: `radar.py` and a page at `http://127.0.0.1:7424`.
It has three queues:

- **Mine**: PRs the user authored.
- **Review**: other people's PRs this user is best placed to review.
- **Team**: PRs that are close to done but stalled.

The local server refreshes GitHub data every few minutes without a model.
Each refresh records events such as "CI passed" or "review requested from
you". A **sweep** adds the **judgement** on top, which the server can't do:

- a note per PR, with the next step and anything waiting on the user
- up to three picks for the user's current block of the day
- a headline

A sweep is read-only toward GitHub. It never comments, reviews, approves or
merges.

Run everything from the repo root. `<login>` is `gh api user -q .login`. Every
command below starts with `python3 radar.py`. Spell it out each time, because
shell variables don't carry between calls. The `--user <login>` flag selects
`users/<login>/`. If that folder is missing, stop and run the
`pr-radar-setup` skill.

## Sweep

1. **Refresh.** Run `python3 radar.py refresh --user <login>`. It prints the events since the last refresh. When the server has already refreshed recently, these may be empty. Read the recent events with `python3 radar.py board --user <login> --json`, which includes `events`.

2. **Scan T3 threads.** Skip this step if the T3 tools are missing. T3 threads record the PRs they created or pushed to, and this step copies those links into the radar. Run `python3 radar.py thread-scan --user <login>` to get the last scan time. Then call `t3_thread_list` with `allProjects: true` and `includeSubagents: false`. It lists the most recently updated threads first. Page until the threads are older than the last scan.
   - Skip the thread you're running in.
   - Read only `pullRequests`, never `pullRequestCount`, since the two can disagree.
   - **Small pages** (`limit: 25`, the normal case): for each newer thread with `pullRequests` entries, run `python3 radar.py link-thread --user <login> <Owner/repo#n> <threadId> --title "<title>" --link "<link>" --updated-at <updatedAt> --status <status>`. Finish with `python3 radar.py thread-scan --user <login> --set <newest updatedAt seen>`.
   - **When a page is saved to a file** (first scan, or `limit: 100`): run `python3 radar.py ingest-threads --user <login> <file> --floor <date 60 days ago> --skip <your thread id>`. Keep paging while it prints `keepPaging: true`, and add `--commit` on the last file.

3. **Judge the user's PRs.** Run `python3 radar.py todo --user <login>`. It lists the user's PRs whose PR or linked thread moved since their note was written, with their recent events. Work through every entry and write a note for each:
   - If it has linked threads, call `t3_thread_read` on the newest one, with `maxCharsPerItem: 1500` and `limit: 2` for a stale draft or `6` otherwise. Look for what the agent last said: a question for the user, a blocker, a promise to watch CI, or a finished state.
   - When the action is "Answer review comments", also skim `gh pr view <url> --comments`.
   - Otherwise the GitHub signals in `todo` are enough.
   - Then run `python3 radar.py note --user <login> <key> --basis "<basis from todo>" --next "..." [--left "..."] [--question "..."]`.
     - `--next` is the single next step, in the imperative and under 15 words. Phrase it as something to do ("Rebase on development and re-request review from h7y"), not as a status. Name people from `requested`.
     - Add `--question` only when something waits on the user's own answer or decision.

4. **Pick.** Run `python3 radar.py rhythm --user <login>`. It reports which block of the day it is: `deep`, `quick`, or `off` with the `next` block. Its `prefer` line is the user's own words about that block. Read the queues from `python3 radar.py board --user <login> --json`. Every item there has an `effort` of `deep` or `quick`, and a `hidden` flag that's true when the user marked it Done or Snooze; skip hidden items. Choose up to three **picks**, best first:
   - **Match the block.** A deep block gets `deep` items and a quick block gets `quick` items. Off hours, pick for the next block, so the page is ready when the user sits down. If the block's own kind runs out, fill from the other kind and say so.
   - **Rank within the block:**
     1. Work that unblocks someone else: a review requested from the user, a team request in their area, or an approved PR of theirs waiting to merge.
     2. The user's own PRs that are one step from merging.
     3. A stall the user can unblock with one review or one nudge.

     The tiers order the candidates; they don't fill all three picks from tier 1. A lower-tier item can rank higher when a single answer from the user unblocks it.
   - **Urgency beats the block.** A review blocking a hotfix or a security release is a pick whatever its effort.

   Write one line per pick on why now. Write a headline of one or two sentences: name the block, then lead with what changed, such as new review requests, approvals, merges or CI failures. Run `python3 radar.py picks --user <login> --headline "..." --pick "<key>=<why>" ...`. The page picks up the change on its next poll, within a minute.

5. **Report.** End your turn with the headline, the picks, and anything new, in five lines or fewer. Name every PR as a link. When the user asked for the sweep in a chat, also answer whatever else they asked.

A sweep where nothing moved is a few calls: `todo` comes back empty, so only re-pick if the block has changed since the last sweep's picks.

## Tuning

- **A pick came at the wrong time of day:** adjust `rhythm` in `config.json`, or the `effort_of` thresholds (`DEEP_LINES`, `DEEP_FILES`) in `radar.py`.
- **A pick or review suggestion was wrong for this person:** adjust `profile.json` (an area weight, a person, a team, or `ignoreRepos`) and mirror the change in `profile.md`.
- **A rule is wrong for everyone:** change it in `mine_signals`, `review_signals` or `team_signals` in `radar.py`.

Commit tuning changes.
