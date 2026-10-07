# Local integration and read-only preview — 2026-10-04

## Candidate and boundaries

- Branch: `codex/local-preview-20261004`.
- Managed worktree: `D:\CodexWorktrees\guide-local-preview\child-growth-agent`.
- Base: `41cbe133108c85f7751dff44d78ae9604205b4ab` (G0–G4 and G5 combination candidate).
- `--no-ff` merge of approved TEST-SAFE1 `80965b33cb69ad86bde1a5cda1247ff33de416bf`: `89f98f06de62322be42f544d42772b272e56b347`. This also retains AUTH0-R2 contract ancestry.
- `--no-ff` merge of approved HOME0-R1 design documents `77e45330a5f20e10deae8c37c58790667bef93b3`: `4c10fbe711a0ace952e8837789a73fbb65bbbf2a`.
- Main and all source worktrees are unchanged. No push, hosted migration, deployment, environment-secret copying or real model call.
- AUTH1 runtime is deliberately excluded: its review findings and AUTH2/UI authorization integration remain open. The current homepage is unchanged; HOME0 is design documentation, not implemented UI.
- G5 combination remains a local candidate, not a release approval. The previously identified saved-AI-link/NULL-version first-archive real-DB test gap is not closed by this preview.

## Added assembly

- `/children/[id]/evidence`: G3 component with formal G5 `loadChildEvidenceBook` output.
- `/classes/[id]/evidence`: G4 component with formal G5 `loadClassEvidenceOverview` output.
- Thin client adapter changes URL scope/filters, preserves the applied range across class-to-child drilldown, narrows to the selected item's goal and focuses its disclosure control.
- Added entry links in existing child/class detail pages; no replacement of their original content.
- Retry recovery preserves all original query values; invalid ranges provide a separately named “查看全部历史” escape.
- No component statistics, teacher decisions, manual-association authoring, item-aware observation creation, new AI prompt or authorization algorithm were added. This is not full G6 completion.
- Frozen G3/G4 components, catalog, guide contracts, transactions and shared helper source are unchanged.

## Preview runtime

Run `pnpm exec tsx scripts/start-local-guide-preview.ts` from this worktree. Default port is 5020; an occupied or unverifiable port is refused, never killed.

- Bind only `127.0.0.1`.
- Use the approved resource-safety helper to create and verify a unique fresh local PostgreSQL container before DDL/writes.
- Initialize from the committed demo SQL, then author two synthetic jumping observations with real enrollment snapshots. Archive and manual guide association use the actual G5 confirmation transaction, without LLM generation.
- One child has confirmed behavior evidence and one has a clue: the jumping row is `1/2` (50%), with period and denominator; no individual percentage is shown.
- Legacy observations keep their NULL historical snapshots. No retrospective class-stage invention.
- Remove inherited hosted database variables and legacy teacher passcode from the preview child environment. Write sessions are disabled; provider requests are redirected to the local model-request guard.
- Keep the database and process alive for viewing, not as test residue. Stop with Ctrl+C in the supervisor session; a two-hour watchdog also performs the owned cleanup. Cleanup uses tracked process identity, container ID + label and precise generated-artifact restoration.
- Runtime receipt without connection strings or credentials: `logs/local-preview/runtime.json`.

Windows dependency reuse across C:/D: initially failed bundler resolution; this worktree now has its own frozen-lockfile pnpm installation. Package and lockfile are unchanged. A checkout CRLF conversion caused the safety helper's raw-byte assertion to fail once; formatting back to the approved LF bytes and a targeted `.gitattributes` rule restore deterministic checkout. Helper Git blob remains `6702f2ddf3b436e79f8c92ae8756c33f611a8503`; no check was weakened.

## Verification

- Final `pnpm next build` (default Turbopack): exit 0, both new routes included.
- `pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify`: exit 0.
- TypeScript, ESLint and Stylelint: exit 0. Final retry change also passed TypeScript and ESLint.
- Contract 19/19; catalog 11/11; G5 runtime 140/140; mocked routes 26/26; G5 repair checks 91/91; AUTH0 reference 36/36; G3 fixture 63/63; G4 fixture 42/42; navigation 18/18.
- Agent flow 30/30; organize retry 9/9; growth 13/13; activity 19/19; teacher clarify 13/13; save consistency 24/24; class/report pages 11/11; homepage-map check passed.
- TEST-SAFE1 checks rerun in combined tree: safety 31/31 after LF correction, real isolated class check 15/15. Their own resources were cleaned; the viewing database was preserved.
- Browser: actual local PostgreSQL → G5 DTO → server page → G3/G4 component. At 1440/390, no horizontal overflow, visible interaction targets at least 44px; keyboard Enter disclosure, roster drilldown, scope change and browser Back verified. These are not mocked GET responses.
- Invalid-date error pages checked in IAB: child retry retains dates/domain/item; class retry retains dates/domain/age/goal. Both have the separate history escape.
- Impeccable detector on the new route adapter: `[]`. Existing G3/G4 design values were inherited, not rewritten to eliminate historic advisories.
- Fresh finish reviewer initially returned `fix` for retry parameter loss; final verdict scored that fix `resolved`, disposition `ship`. This is read-surface integration review, not whole-product approval.
- Incumbent DESIGN.md and its CSS/modules checked; no new visual system or raster was introduced, so no design-system rewrite.

Accepted captures are retained outside Git under `logs/local-preview/shots/`: child desktop/mobile, class desktop/mobile, error recovery and current homepage. Homepage capture is the unchanged baseline for the next design round, not a new design comp.

## Still open

- Full G6 review/association writing flow and item-aware recording.
- AUTH1 repairs, AUTH2 all-route/page authorization, account/teacher-management UI.
- Simplified login-aware homepage implementation and its image/design approval.
- G5 saved-AI-link first-archive real-DB scenarios, final combined authorization/transaction verification, real provider quality and hosted release acceptance.

Local viewing succeeds; it must not be described as full business closure or production-ready.
