---
name: pr-radar-setup
description: Set up a personal PR radar for anyone in the Runn-Fast GitHub org. It builds a reviewer profile from a year of their PRs and reviews, learns their working rhythm, installs the local app, and schedules Claude sweeps.
disable-model-invocation: true
---

# PR radar setup

This skill sets up the radar for one person. Read `README.md` and
`.agents/skills/pr-radar/SKILL.md` first. Setup settles four things with the
person and writes them to `users/<login>/`:

- **profile**: `profile.json` and `profile.md`
- **rhythm**: in `config.json`
- **notifications**: in `config.json`
- **schedule**: a launchd job for the app, plus T3 sweeps

Run every command from the repo root. Confirm whose radar this is with
`gh api user -q .login`. The app runs as whoever is logged in to `gh`, so
each person sets it up on their own machine.

## 1. Build the profile

1. Run `python3 radar.py stats <login> --out $TMPDIR/stats-<login>.json`. It summarises a year of authored and reviewed PRs: repos, conventional-commit scopes, directories at depths 2 to 4, who they review, the teams of the logged-in `gh` user, and when they open PRs (`activity`).
2. Draft **areas**: five to nine named clusters of work. Each has fnmatch `paths` (`*` matches across `/`), title `keywords`, and a `weight` from 1 to 3.
   - Merge what authoring and reviewing both show. Weight an area by how much of their work lands there and how specialised it is. Lockfile churn isn't an area.
   - Repos get restructured (in runn, `app/` moved to `apps/rails/app/`), so cover both the old and the new paths.
3. Check CODEOWNERS in the main repos (`git show origin/development:.github/CODEOWNERS` in runn) for teams that own those paths.
4. Write `users/<login>/profile.json`, copying the shape of `users/chillu/profile.json`:
   - `teams`: the teams whose requests should count as asking this person. Leave out org-wide teams like `developers`.
   - `repos` and `people`: weights from 0 to 1.
   - `ignoreRepos`, `minReviewScore`, `maxReview`, `maxTeam`.
5. Write `profile.md`, the same profile in prose: where they contribute, who they review, which teams count, and what's left out and why. Ask what's wrong or missing. People know their role better than their commit history does. Adjust until they agree.

## 2. Learn their rhythm

People don't want the same work at every hour. Some do deep work first thing
and clear small things in the afternoon. Others warm up on quick wins. The
radar picks for the block the person is in.

1. Start from `activity` in the stats. Pass `--tz <IANA zone>` to `stats` if they're in a different timezone from this machine. `git log --author=<them> --since=1.year --date=format-local:%H --format=%ad` in a repo they commit to often gives a sharper picture. Peaks show when they ship, not when they think, so treat the data as a starting point.
2. Ask:
   - Their timezone, workdays and working hours.
   - When they do their best deep work, such as big reviews and gnarly fixes.
   - When they prefer quick wins: merges, small reviews, nudges, closing stale drafts.
   - Anything fixed in their day, such as standups or a no-meetings morning.
3. Write `rhythm` in `config.json`: `timezone`, `workdays` (ISO, Monday is 1), and `blocks`. Each block has a `mode` (`deep` or `quick`), a `label` for the page, `from` and `to` as `HH:MM`, and `prefer` in their own words. Check it with `python3 radar.py rhythm --user <login>`.
4. Set `refresh` in `config.json`: `workingMinutes` (default 5) and `offHoursMinutes` (default 60). A refresh with nothing changed costs about 2 GraphQL points.

## 3. Notifications

The background refresh can raise a macOS notification on chosen events. Ask
which ones they want, and write the kinds to `notify.kinds` in `config.json`:

- `review_requested`: someone asked them to review
- `team_requested`: someone asked one of their teams
- `ci_failed` and `ci_passed`
- `approved` and `changes_requested`
- `comments`: review threads waiting on them
- `merged`
- `conflict`
- `pushed`: new commits since their review

A short list beats a noisy one. `[]` turns them off.

## 4. Install and schedule

1. Run `python3 radar.py refresh --user <login> --full` once, then `python3 radar.py board --user <login>`. Show them the review and team queues, and tune the weights until the lists look right.
2. Run `./bin/install-launchd <login>`. It installs a LaunchAgent that keeps `radar.py serve` running at login, and prints the page URL. Its sandbox and permission needs are in the script's header. The person runs it in their own terminal if the agent can't.
3. **T3 Code:** add the repo as a T3 project if it isn't one yet, and start a thread in it titled `pr-radar: sweeps for <login>`. From inside that thread, create one `schedule_task` per sweep time:
   - `fixed_time` with `timeOfDay` in local time and `weekdays` (0 is Sunday)
   - `bindToCurrentThread: true`, so the runs post into that thread and the person can ask for a sweep there at any time
   - `freshSession: true`
   - the prompt: "Run the pr-radar skill: a sweep for `<login>`. Don't ask questions; if something blocks the sweep, say what in your report and stop."

   Time the sweeps about 15 minutes before each block starts, plus one mid-block in a long block, on workdays only. Record the times and task ids under `schedule` in `config.json`.
4. **Without T3**, run sweeps by hand with "run a pr-radar sweep", or with `/loop` in a long-lived session.

## 5. Commit

Commit `profile.json`, `profile.md` and `config.json`. `radar.db` and the logs
stay gitignored.
