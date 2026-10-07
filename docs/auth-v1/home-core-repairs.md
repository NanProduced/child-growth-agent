# Imported AUTH1 core repairs — 2026-10-04

Candidate edited directly in `D:/CodexWorktrees/guide-local-preview/child-growth-agent`, branch `codex/home-v2-craft`, HEAD `e877f3b60e2886febc2bcdf22b2c1064114f7b50`. No commit or merge. This is local core evidence for parent assembly, not homepage/browser, hosted-database, or deployment acceptance.

## Exact owned write manifest

All paths below are beneath the candidate root above; these are the only nine files written by this subtask.

1. `src/lib/accounts/repository.ts`
2. `src/lib/accounts/rate-limit.ts`
3. `src/app/api/admin/teachers/route.ts`
4. `src/storage/database/shared/schema.ts` — only the `check` import and two account-table CHECKs.
5. `scripts/auth-bootstrap-admin.ts`
6. `scripts/upgrade-auth-v1.sql`
7. `scripts/check-auth-core.ts`
8. `scripts/check-auth-core-repairs.ts` — new bounded repair checks and real-lock test helpers.
9. `docs/auth-v1/home-core-repairs.md` — this handoff.

`accounts/bootstrap.ts` needed no change. Frozen contract/types, scrypt parameters, Cookie/CSRF/absolute expiry, `harness-safety.ts`, UI, `auth.ts`, authorization/guards, `pg-client.ts`, and queries were not edited by this subtask. Concurrent parent/other-worker changes in the shared candidate are outside this manifest. No source/main worktree, `.env`, hosted DB, model budget, or preview port 5020 was accessed for these checks.

## Resulting behavior

- Role/status parsers accept only the two frozen values each. Malformed identity data throws `identity_unavailable`; login creates no session, and session resolution fails closed. Teacher mutations validate the locked row's role **and status** before updating, so reset/reactivation cannot silently repair corrupt metadata.
- Both Drizzle and the additive SQL upgrade define `app_accounts_role_check` and `app_accounts_status_check`. Existing rows are validated; dirty data makes the upgrade fail with PostgreSQL `23514`, without coercion/reset/deletion. The upgrade remains repeatable. No hosted migration was run.
- `rateLimitKey` preserves call compatibility but uses only the normalized account name. Rotating first-hop XFF and username spelling cannot reopen that account's bucket. The existing process-local fixed-window limitation remains; no distributed limiter or dependency was added. The frozen contract's username/IP wording was left unchanged; the account bucket is the explicitly requested stricter repair.
- Teacher creation rejects any supplied non-array `class_ids`, any non-string member, or an empty/blank member before hashing or writing. Missing `class_ids` and `[]` retain their valid empty-assignment semantics; duplicate valid IDs retain existing deduplication.
- Bootstrap uses one readline interface with a buffered line queue, explicit EOF/error rejection, TTY password output suppression, and reader/pool closure in `finally`. All argv input is rejected. Passwords are read only from stdin, preserved byte-for-byte, and never printed. Generic failure logging excludes unknown error objects.
- Concurrency checks now prepare hashes before overlap, pause the first transaction **after a real PostgreSQL lock is acquired**, and require an actual second backend with `wait_event_type = 'Lock'` and the first PID in `pg_blocking_pids`. They then release the barrier and verify outcomes. A third read-only observer establishes the lock evidence. The test-only client wrapper executes original SQL; it does not mock locks or add product fault flags.

## Commands actually run

Working directory for every command: `D:/CodexWorktrees/guide-local-preview/child-growth-agent`.

```powershell
pnpm exec tsx scripts/check-auth-core-repairs.ts
pnpm exec tsx scripts/check-auth-core.ts --database-only
pnpm exec tsx scripts/check-auth-core-repairs.ts --interactive-cli
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint scripts/auth-bootstrap-admin.ts scripts/check-auth-core.ts scripts/check-auth-core-repairs.ts src/lib/accounts/repository.ts src/lib/accounts/rate-limit.ts src/app/api/admin/teachers/route.ts src/storage/database/shared/schema.ts --max-warnings 0
git diff --check
git hash-object scripts/harness-safety.ts
git rev-parse HEAD
git branch --show-current
```

The interactive command was run in an actual Windows terminal (`stdin.isTTY=true`, `stdout.isTTY=true`); four lines were supplied through terminal stdin, using the synthetic `PASSWORD` constant from the repair check. Only username/display-name echoed. Both password entries stayed hidden, stored scrypt verified the unchanged password including edge spaces, and the CLI exited 0 after closing its pool. Passwords were never provided as argv or environment values.

A scoped TypeScript compiler program also passed for the seven edited `.ts` files and their imports. Exact PowerShell command:

```powershell
$authCoreTypecheck = @'
const ts = require("typescript");
const roots = ["scripts/auth-bootstrap-admin.ts", "scripts/check-auth-core.ts", "scripts/check-auth-core-repairs.ts", "src/lib/accounts/repository.ts", "src/lib/accounts/rate-limit.ts", "src/app/api/admin/teachers/route.ts", "src/storage/database/shared/schema.ts"];
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram(roots, { ...parsed.options, incremental: false, noEmit: true });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: f => f, getNewLine: () => "\n" }));
else process.stdout.write("AUTH core scoped TypeScript: PASS\n");
process.exitCode = diagnostics.length ? 1 : 0;
'@
$authCoreTypecheck | pnpm exec node
```

The latest complete-repository TypeScript run passed. One intermediate run saw a concurrently edited parent-owned observation-confirm route before its syntax was repaired; it was not counted as passing. An initial repair-harness run also exposed a transient mismatch between live `pg_blocking_pids` and `pg_stat_activity.wait_event_type`; the harness now waits for both observations, and the final run passed.

## Evidence actually established

| Check | Verified result |
| --- | --- |
| Repair harness | All five repair groups passed against its own PostgreSQL 16 container. |
| Metadata | CHECK rejects invalid writes; imported bad role, bad teacher status, and admin+bad status fail closed. Login writes zero sessions; reset/status changes and failed migration preserve the corrupt account row. |
| Teacher payload | Nine malformed `class_ids` cases plus three malformed top-level bodies return 400 with unchanged account/assignment counts. Omitted/empty/deduplicated valid assignments return 201. These are real route-handler Request/Response calls with real DB, not socket HTTP. |
| Rate limit | Three wrong-password attempts from rotating XFF return 401; subsequent variants return 429. Offline checks also verify per-account separation, reset, and window expiry. |
| CLI pipe | EOF after 0/1/2/3 fields, mismatch, and argv option fail with exit 1 and zero accounts. Buffered LF, CRLF, and final-line-without-newline succeed; repeated bootstrap returns 2 without modifying the existing row. Child completion is bounded and verifies pool closure. |
| CLI real TTY | Hidden password entry, four-line paste, exact stored password verification, successful exit, and verified child cleanup. |
| Row-lock orders | Login→reset and login→disable issue a session that the second transaction revokes. Reset→login rejects the old password with zero sessions; disable→login rejects the account with zero sessions. New password succeeds after reset. All four include observed two-backend blocking. |
| Initial-admin race | Two prehashed initializations overlap at the actual advisory lock. First succeeds, second returns `admin_already_initialized`; exactly one admin exists. |
| Existing core harness | `16/16`, `offline=true`, `real_db=true`, `real_http=false`, `controlled_concurrency=true`, `model_requests=0`. Database-only mode starts no Next.js server and restores no application-generated files. |
| Static checks | Latest full TypeScript, scoped TypeScript, owned-file ESLint with zero warnings, and diff whitespace check passed. |

Final standard repair run: `auth-core-repairs-375b21e9-979f-4fd6-85ba-aaf46c0aa631`, owned container ID `c08ed3b6892b4ebd964e37db09a50ac5b692171f1963b7805c4be91d171fdf0e`.

Real-TTY run: `auth-core-repairs-f5f3bf09-ac76-4108-854e-1516410d6b7a`, owned container ID `edd625e8c94542da8e15018bd5e33700696b68d5ad5e41bdb08e060d7e8eaa2c`.

Each run used its own random run ID, `cga.auth.core.repairs` label, loopback database mapping, database identity verification, model guard, tracked CLI children, and verified cleanup. The existing core runner now uses its own `home-auth-core-*` IDs and `cga.home.auth.core.check` label. Owned disposable containers/fixture rows were removed; no persistent user data was deleted. Model guard counts were 0.

Immutable safety helper rechecked: Git blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`.

Not run: full Next.js socket HTTP core mode, homepage/account UI or browser acceptance, business-route authorization acceptance, production/hosted migration, deployment, or real-model calls. Parent assembly and acceptance remain separate.

## Homepage data sidecar — 2026-10-04

Added only `src/lib/home-v2/data.ts` and `scripts/check-home-v2-data.ts`, plus this brief append. API: `loadHomeV2Data(): Promise<HomeV2Data>`; pure `buildHomeV2Data(auth: AuthState, sources?: HomeV2Sources): HomeV2Data`. Sources must already be authorized server projections; `null` denotes a failed read and `[]` a verified empty result.

The loader consumes `resolveServerAuth()` and the fresh `withScopedRead()` transaction principal. Narrow SQL independently reads classes, current enrollment roster, each pending category, and recent records. Savepoints preserve known datasets after individual query failures. Roster/pending reads have no list limit; only the recent preview is capped at two. Admins receive management/class data without teaching feeds. Historical-only rows never enter pending/recent; current-responsible prior-class history retains its occurrence snapshot, and unknown snapshot fields stay unknown.

Passed: `pnpm exec tsx scripts/check-home-v2-data.ts` (**40/40 pure checks**), `pnpm exec tsc --noEmit --incremental false`, `pnpm exec eslint src/lib/home-v2/data.ts scripts/check-home-v2-data.ts --max-warnings 0`, and whitespace check. Pure checks cover roles/scopes, empty/error/null semantics, all frozen priority cases, partial failures, `sameScopeHistory`, deduplicated enrollment counts, uncapped counts, recent ordering, immutable inputs, and the excerpt-only DTO whitelist. Server-auth/SQL execution and browser acceptance were not run for this sidecar. No `.env`, hosted DB, model, preview server, or commit operation.
