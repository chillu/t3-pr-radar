---
name: pr-radar
description: Run a pr-radar sweep, which reads what moved on the user's pull requests and refreshes their notes, picks and headline on the local PR radar page. Use when asked to sweep or triage, what PRs need me, or what to review next.
---

# PR radar sweep

The radar is a local app: `radar.ts` and a page at `http://127.0.0.1:7424`.
It has three queues:

- **Mine**: PRs the user authored.
- **Review**: other people's PRs this user is best placed to review.
- **Team**: PRs that are close to done but stalled.

The local server refreshes GitHub data every few minutes without a model.
Each refresh records events such as "CI passed" or "review requested from
you". A **sweep** adds the **judgement** on top, which the server can't do. The server starts one headless (`claude -p`, logged under `users/<login>/logs/sweeps/`) when something moved. The user can also ask for one in any T3 thread, or with Sweep now on the page. A sweep produces:

- a note per PR, with the next step and anything waiting on the user
- up to three picks for the user's current block of the day
- a headline

A sweep is read-only toward GitHub. It never comments, reviews, approves or
merges.

Run everything from the repo root. `<login>` is `gh api user -q .login`. Every
command below starts with `node radar.ts`. Spell it out each time, because
shell variables don't carry between calls. The `--user <login>` flag selects
`users/<login>/`. If that folder is missing, stop and run the
`pr-radar-setup` skill.

## Sweep

1. **Refresh.** Run `node radar.ts refresh --user <login>`. It prints the events since the last refresh. When the server has already refreshed recently, these may be empty. Read the recent events with `node radar.ts board --user <login> --json`, which includes `events`.

2. **Scan T3 threads.** Skip this step if the T3 tools are missing. T3 threads record the PRs they created or pushed to, and this step copies those links into the radar. Run `node radar.ts thread-scan --user <login>` to get the last scan time. Then call `t3_thread_list` with `allProjects: true` and `includeSubagents: false`. It lists the most recently updated threads first. Page until the threads are older than the last scan.
   - Skip the thread you're running in.
   - Read only `pullRequests`, never `pullRequestCount`, since the two can disagree.
   - **Small pages** (`limit: 25`, the normal case): for each newer thread with `pullRequests` entries, run `node radar.ts link-thread --user <login> <Owner/repo#n> <threadId> --title "<title>" --link "<link>" --updated-at <updatedAt> --status <status>`. Finish with `node radar.ts thread-scan --user <login> --set <newest updatedAt seen>`.
   - **When a page is saved to a file** (first scan, or `limit: 100`): run `node radar.ts ingest-threads --user <login> <file> --floor <date 60 days ago> --skip <your thread id>`. Keep paging while it prints `keepPaging: true`, and add `--commit` on the last file.

3. **Judge the user's PRs.** Run `node radar.ts todo --user <login>`. It lists the user's PRs whose PR or linked thread moved since their note was written, with their recent events. Work through every entry and write a note for each:
   - If it has linked threads, call `t3_thread_read` on the newest one, with `maxCharsPerItem: 1500` and `limit: 2` for a stale draft or `6` otherwise. Look for what the agent last said: a question for the user, a blocker, a promise to watch CI, or a finished state.
   - When the action is "Answer review comments", also skim `gh pr view <url> --comments`.
   - Otherwise the GitHub signals in `todo` are enough.
   - Then run `node radar.ts note --user <login> <key> --basis "<basis from todo>" --next "..." [--left "..."] [--question "..."]`.
     - `--next` is the single next step, in the imperative and under 15 words. Phrase it as something to do ("Rebase on development and re-request review from h7y"), not as a status. Name people from `requested`.
     - Add `--question` only when something waits on the user's own answer or decision.

4. **Pick.** Run `node radar.ts rhythm --user <login>`. It reports which block of the day it is: `deep`, `quick`, or `off` with the `next` block. Its `prefer` line is the user's own words about that block. Read the queues from `node radar.ts board --user <login> --json`. Every item there has an `effort` of `deep` or `quick`, and a `hidden` flag that's true when the user marked it Done or Snooze; skip hidden items. Choose up to three **picks**, best first:
   - **Match the block.** A deep block gets `deep` items and a quick block gets `quick` items. Off hours, pick for the next block, so the page is ready when the user sits down. If the block's own kind runs out, fill from the other kind and say so.
   - **Rank within the block:**
     1. Work that unblocks someone else: a review requested from the user, a team request in their area, or an approved PR of theirs waiting to merge.
     2. The user's own PRs that are one step from merging.
     3. A stall the user can unblock with one review or one nudge.

     The tiers order the candidates; they don't fill all three picks from tier 1. A lower-tier item can rank higher when a single answer from the user unblocks it.
   - **Urgency beats the block.** A review blocking a hotfix or a security release is a pick whatever its effort.

   Write one line per pick on why now. Write a headline of one or two sentences: name the block, then lead with what changed, such as new review requests, approvals, merges or CI failures. Run `node radar.ts picks --user <login> --headline "..." --pick "<key>=<why>" ...`. The page picks up the change on its next poll, within a minute.

5. **Report.** End your turn with the headline, the picks, and anything new, in five lines or fewer. Name every PR as a link. When the user asked for the sweep in a chat, also answer whatever else they asked.

6. **Settle the thread.** Only when you're running in a T3 thread; skip this step in a headless run started by `radar.ts`. A sweep stays out of the way: the page is where the user reads the radar, not the thread. After a scheduled run, call `t3_thread_organize` with `action: "settle"` and no `threadId`, which settles this thread at the end of the turn. Leave it active only when something new needs the user before their next look at the page:
   - a review requested from them
   - a failure on one of their PRs: CI, a conflict, or changes requested
   - a new question waiting on their answer

   When the user asked for the sweep themselves in the thread, don't settle it; they're reading.

A sweep where nothing moved is a few calls: `todo` comes back empty, so only re-pick if the block has changed since the last sweep's picks.

## Tuning

- **A pick came at the wrong time of day:** adjust `rhythm` in `config.json`, or the effort thresholds (`DEEP_LINES`, `DEEP_FILES`, used by `mineSignals` and `scorePr`) in `radar.ts`.
- **A pick or review suggestion was wrong for this person:** adjust `profile.json` (an area weight, a person, a team, or `ignoreRepos`) and mirror the change in `profile.md`.
- **A rule is wrong for everyone:** change it in `mineSignals`, `reviewSignals` or `teamSignals` in `radar.ts`.

Commit tuning changes.
