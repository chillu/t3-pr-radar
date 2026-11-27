# Working in pr-radar

A local PR to-do app. Read `README.md` for the design. Two skills drive it:
`pr-radar` runs a sweep and `pr-radar-setup` onboards a person.

- Name threads `pr-radar: <what>`.
- `users/<login>/radar.db` is the live state, written by the background server. Read it through `radar.py board --json`, never by editing the database. Writes go through `radar.py` subcommands, so the server and a sweep never race on the same rows.
- The server runs under launchd as `com.runn.pr-radar.<login>`. After changing `radar.py`, restart it with `launchctl kickstart -k gui/$(id -u)/com.runn.pr-radar.<login>`.
- Commit freely on `main`. Never commit `radar.db`, `logs/` or anything under `$TMPDIR`.
