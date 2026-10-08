# PLATFORM-FLOW-CHECK1 checkpoint

Initial baseline: `f371ba3b2a39af6aaa660566ed5435bd316c05a7`.
Branch/worktree: `codex/platform-business-check`, `D:/CodexWorktrees/platform-business-check/child-growth-agent`.
RTK.md is absent; immutable harness blob is `6702f2ddf3b436e79f8c92ae8756c33f611a8503`.
Checkpoint precedes the newly authorized normal merge of `d1b441a6a2fc5c7913d128260a1a014ce182aeb3`.
This is a repair candidate, not whole-product acceptance or deployment approval.

## Evidence-backed repairs

| Finding | RED | Shared root / GREEN |
| --- | --- | --- |
| Stable recycled upload deletes a concurrent successful upload's objects | `platform-flow-media.ts`, seed `qaseed1-muzk0v5e-09d89fcb`: committed ready row, original/thumbnail removed by failed sibling | Remove obsolete random-identity compensation from `upload-service`; real PG/local I/O concurrent control, checksums, original-identity retry and normal lease recycle pass |
| Invalid calendar days escape profile/transfer validation | `platform-flow-guards.ts`: birth/transfer dates `2022-02-30`/`2026-02-30` produce HTTP 500 | Existing shared schemas reuse `parseIsoDateStrict`; 400 and zero child/enrollment mutations |
| Media request identity retained across object I/O | Same script: revoked upload returns 200 and commits metadata; revoked content returns 200 bytes | Registration uses existing `withPrivateWrite` + bound same-client metadata; content/metadata reproject current sources with existing private AUTH and DATA rules; original headers captured, AUTH errors preserved |
| Private AUTH evaluates expiry before lock wait / does not check before COMMIT | Seed `qaseed1-muzkkn4y-0425a375`: session lock wait crosses expiry, 401 final response but metadata committed | Reuse AUTH `demandSessionValid` after session lock and after private callback, within original transaction; zero metadata after expiry |
| Pending proposal image becomes unreadable through media API | Seed `qaseed1-muzkqwcd-485b463f`: authorized image referenced by real prepared proposal returns 403 | Media reuses DATA's per-image proposal-source evaluation; authorized bytes/metadata pass, revoked source rejects even uploader/owner |

Original assertions/scripts are preserved. New regression scripts are exclusively `scripts/platform-flow-*`.
All models are local protocol/in-process doubles; no real model/search/S3/hosted database requests.

## Checks completed before merge

| Check | Result / evidence layer |
| --- | --- |
| `check-business-access` | 113/113, real route handlers + disposable PG + controlled two-client races; no Next server |
| `check-auth-core` | 28/28, real Next HTTP + disposable PG + controlled account/session races |
| `platform-flow-http` | 44/44 before later shared guard change; real Next HTTP/AUTH/PG, local protocol model double. Stronger formal-state/denominator assertions added for next run |
| `platform-flow-guards` | Final 13/13; real handlers/AUTH/PG/local objects. Includes observable session lock wait and precommit zero metadata |
| `platform-flow-media` | Concurrent recycled-identity regression GREEN; seed 62/62; real PG metadata + local objects |
| `check-integration-media-db` | 88/88 before final projection factoring; real PG, local objects, lease/reference races, source CAS/audit rollback |
| `check-tools-write-db` | 134/134 after shared private guard repair; real AUTH/PG/services, in-process model double |
| TOOLS R1 `b` / R2 `c` / R3 `l` / R4 `all` | 53/53 / 9/9 / 13/13 / 37/37 after shared private guard repair; real AUTH/PG + handler/executor checks |
| `check-guide-write-flow` / `check-save-consistency` / `check-guide-evidence-runtime` | 123/123 / 24/24 / 140/140; pure/helper/simulated evidence only |
| `check-media-r1` | 24/25: unchanged B5 assumes obsolete random recycled identity and destructive compensation. Failure retained for parent review; not relabeled PASS |

Old `check-guide-evidence-db` expects passcode login / `cga_teacher`, so it is NOT_RUN rather than rewritten into false acceptance.
The historical close-joint browser runner directly injects ai_draft; it does not prove model orchestration. The new HTTP runner actually traverses follow-up/organize/review via local protocol responses.

## Resource and scope boundary

Each database is freshly created via immutable harness or existing acceptance seed, verified by container ID + exact run label + loopback DB identity, then precisely removed. Resource identifiers are emitted without passwords/URLs. Seed teardown verifies registered object/credential paths absent; Next processes use PID + creation identity and ownership verification, not port-based killing. Generated artifacts are restored.

All completed checks report cleanup verified/removed. No credentials/.env were read; disposable HTTP fixture passwords are random and set only in the owned DB. Temporary seed credentials are created by the reused seed module and removed without reading them.

Partial upload objects may remain in the controlled object root for same-identity retries; failed requests cannot prove exclusive deletion ownership. No prefix compensation or speculative garbage collector was added.

Before merge no client, runtime/context, page-reference, UI components/pages/styles, contracts, schema/migrations, package/lock or harness were edited. Chatbox-v2 natural-language/context/client recovery checks await the authorized new baseline. Activity implementation feedback, semester snapshots, parent sharing/export are product gaps, not newly implemented features.
