# pr-radar

A local to-do list built from open pull requests across the Runn-Fast org. It
has three queues:

- your own PRs, with what's left on each, from GitHub and the T3 threads that worked on them
- the reviews you're best placed for: requests to you or your teams, then your profile's areas and people
- team PRs that are close to done but stalled

It's a page at http://127.0.0.1:7424, served by `radar.py` from a SQLite file.
Nothing is hosted.

## Two cadences

| | What | How often | Cost |
|---|---|---|---|
| **Refresh** | Poll every open PR's fingerprint (head, CI, review decision, mergeable, updated). Fetch details only for PRs that changed. Rescore, diff, and record events like "CI passed" or "review requested from you". Optionally notify. | Every 5 min in working hours and every 60 min outside them. Also on the page's Refresh button. | About 2 GraphQL points when nothing changed, with a full fetch (about 110 points) every 6 hours. No model. |
| **Sweep** | Claude reads T3 threads and review comments for PRs that moved, writes a note per PR, and picks up to three things for your current block of the day. | Scheduled T3 runs before and during each block, or on request in the pr-radar thread. | One model session. It's short when little moved. |

## Layout

- `radar.py`: the engine, the CLI and the server. Run `python3 radar.py --help`.
- `web/index.html`: the page. It polls `/api/board` every minute and posts Done, Snooze and Refresh back to the server.
- `users/<login>/`: `profile.json` (scoring weights), `profile.md` (the same in prose), `config.json` (rhythm, refresh cadence, notifications, schedule). The `radar.db` and `logs/` in there are gitignored.
- `.agents/skills/pr-radar`: the sweep, which is the judgement half.
- `.agents/skills/pr-radar-setup`: profile, rhythm, notifications, install and schedule for a new person. Start here.
- `bin/install-launchd`: keeps the server running at login.

## Running it

```sh
python3 radar.py refresh --user <login> --full   # first fill
python3 radar.py serve --user <login>            # or ./bin/install-launchd <login>
```

## Design notes

- **Fetching is a script; judgement is Claude.** The server never calls a model. A sweep only reads what moved: own PRs whose PR or T3 thread changed since their note.
- **No per-PR watches.** T3's `watch_pull_request` starts an agent turn on every event, which suits one PR you're actively babysitting, not a hundred. The light poll replaces it here.
- **Rhythm.** Every item is tagged `deep` or `quick` (a review counts as deep at 300+ lines or 15+ files). Sweeps pick for your current block: deep work in the morning, quick wins in the afternoon, or whatever your config says.
- **Into T3 Code.** Each row links its T3 threads with `t3code://threads/<environmentId>/<threadId>`, and offers "New T3 thread" as `t3code://new?pr=<url>&prompt=<text>`. T3 opens that link as a draft, and nothing runs until you press Send. Both routes come from T3's `packages/shared/src/promptLinks.ts`. T3 also has its own `/pull-requests` view (with `involvement=authored|reviewing`), but it has no app link, and it doesn't know your profile or rhythm.
- **Read-only toward GitHub.** Nothing here comments, reviews, approves or merges.

History: this started as an artifact-backed skill in `Runn-Fast/agent-context`
(`projects/pr-radar/`). It moved here when the artifact proved unable to
refresh itself.
