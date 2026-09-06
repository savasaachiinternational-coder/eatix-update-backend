# Cross-repo sync: Ethics-app ⇄ eatix-backend

Some data must stay byte-identical between this repo and `eatix-backend`
because the client's live preview and the backend's real FFmpeg bake both
render from it — if they drift, what a user sees while editing stops
matching what actually gets published.

There is no shared package/monorepo tooling between the two repos, so this
is enforced by a checksum guard + this runbook rather than automated
cross-repo CI. Follow it exactly when touching a synced file.

## Synced files

| Ethics-app | This repo (eatix-backend) | What it defines |
|---|---|---|
| `src/constants/filter-preset-spec.json` | `src/shorts/filter-preset-spec.json` | Filter/theme id → color-grade `{hex, opacity}` |

(Future additions — sticker catalog, collage layouts — should follow the
same pattern and be added to this table.)

## How to change a synced file

1. Edit the JSON in **one** repo.
2. Run `npm run hash:filter-spec` in that repo (regenerates the sibling
   `.sha256` checksum file).
3. Copy the **exact same edit** to the other repo's copy of the JSON, then
   run `npm run hash:filter-spec` there too.
4. Verify both are byte-identical:
   `diff <path-in-Ethics-app> <path-in-eatix-backend>` should print nothing.
5. Commit/PR both repos referencing each other (or at minimum, note the
   matching commit/PR in each description) so a reviewer can see both
   sides moved together.

## What the checksum guard actually catches

`npm run verify:filter-spec` (wired into `npm run lint` via `prelint` in
both repos) fails the build if the JSON changed without regenerating its
`.sha256`. It does **not** detect drift *between* the two repos — there's
no automated cross-repo check — it only guarantees that within a single
repo, nobody edits the spec without a deliberate, reviewable checksum
update. The actual cross-repo parity depends on step 3-4 above being
followed by hand.
