# Working in pr-radar

A local PR to-do app. Read `README.md` for the design. Two skills drive it:
`pr-radar` runs a sweep and `pr-radar-setup` onboards a person.

- Name threads `pr-radar: <what>`.
- `users/<login>/radar.db` is the live state, written by the background server. Read it through `node radar.ts board --json`, never by editing the database. Writes go through `radar.ts` subcommands, so the server and a sweep never race on the same rows.
- The server runs under launchd as `com.runn.pr-radar.<login>`. After changing `radar.ts`, restart it with `launchctl kickstart -k gui/$(id -u)/com.runn.pr-radar.<login>`.
- `radar.ts` is erasable TypeScript run directly by Node (>= 24): no build step and no dependencies. Keep it that way: no `enum`, `namespace` or parameter properties, and nothing added to `package.json` beyond `type` and `engines`.
- Type-check after changes: `npm install --no-save --no-package-lock @types/node@24` once (into the gitignored `node_modules`), then `npx -y -p typescript tsc --noEmit`.
- Commit freely on `main`. Never commit `radar.db`, `logs/` or anything under `$TMPDIR`.
