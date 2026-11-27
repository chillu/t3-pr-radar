# sample-dev: PR radar profile

This is a made-up example, not a real person. It shows what `pr-radar-setup`
writes for someone: a frontend engineer on a platform team at `example-org`.
`profile.json` holds the weights the scorer uses. This file explains them.
Edit both together.

## Where they contribute

- **web-app** is the centre of gravity, followed closely by **ui-kit**, the shared component library. They touch **api** when a UI change needs a schema change.
- **Design system and UI components** has the heaviest weight: components, stories, design tokens and accessibility fixes.
- **Frontend build and tooling**: Vite, TypeScript and ESLint config, and package scripts.
- **CI and preview deploys**: the workflows that build and publish preview environments for each PR.
- **Performance**: bundle size, lazy loading and web vitals.
- **GraphQL API** and **dependency upgrades** carry lighter weights.

## Who they review

Mostly teammate-a and teammate-b, who work on the same product area. Their PRs
get the biggest boost. teammate-c and teammate-d get a smaller one.

## Teams that count as asking them

`platform-team` and `frontend-guild`. The org-wide `engineering` team is left
out on purpose: a request to it doesn't single anyone out.

## Rhythm

They warm up on quick wins, do deep work through the middle of the day, and
wrap up with quick wins before logging off. Sweeps pick for whichever block
they're in.

## Left out

- Bot PRs (Dependabot, Renovate). The board shows only a count per repo.
- `example-org/sandbox`, a scratch repo nobody reviews.
