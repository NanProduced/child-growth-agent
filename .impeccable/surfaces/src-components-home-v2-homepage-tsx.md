---
primary_target: src/components/home-v2/homepage.tsx
related_targets: [src/app/page.tsx, src/components/home-v2/homepage.module.css, src/components/home-v2/home-fonts.css, src/components/home-v2/login-panel.tsx, src/components/top-nav.tsx, src/components/teacher-provider.tsx, src/app/login/page.tsx]
mode: Operate
---

# Approved homepage workbench — scoped local completion

The user approved all four native ImageGen state/device images on 2026-10-04. They are one design, not competing alternatives. Approval is a durable style decision; reviewer verdict 2 now records local SHIP strictly for the original seven-item fix list. This brief replaces the former homepage garden direction only. Other pages and the frozen guide/auth contracts retain their existing scope and semantics.

## Approved visual authority

All paths below are under `docs/design/home-refinement-20261004/`:

| Exact file | State | Native raster | SHA256 |
| --- | --- | --- | --- |
| `01-guest-desktop.png` | Logged out | 1536×1024 | `4b2cc1cbf41148d410ab8b2828cde99f8aa11bc77a0da9108a1529c9c7e8281f` |
| `02-teacher-desktop.png` | Assigned teacher; main visual reference | 1536×1024 | `c767ef48513fad154936618013c30c6f496aa6f336159d4e1466e5940d10ea1c` |
| `03-admin-desktop.png` | Administrator | 1536×1024 | `a84050e45eb56a8b6cd83fcf4b6a7052c10896207266fc7e0c6ee44856737172` |
| `04-teacher-mobile.png` | Assigned teacher; logical target 390×844 | 853×1844 | `b9aa55c06d0ce9f94fec5243bd3b0b8cf3cb47310036a929cd3e8cf588cb8828` |

This documenter pass inspected all four exact images and matched their file hashes to the adjacent `*.meta.json`. Those metadata files preserve native generated-image paths, `image_gen.imagegen`, approval and synthetic-design-data flags; prompts are in `PROMPTS.md`. Model ID and usage were not returned and remain unknown. These images are not browser captures. The folder README's earlier “waiting for review” wording predates approval; preserve it outside this write scope, and use the user's approval plus image metadata for current style authority.

## Direction contract

THESIS: Three-year evidence-led development becomes a calm professional teacher workbench. Confirm-first action and assigned classes are the first authenticated task.

OWN-WORLD: Warm-white ground, navy Chinese sans, leaf-green pure-color actions, fine separators, and complete small authored picture-book illustrations. Keep the sprout brand and Lucide/shadcn components; all live text, data and controls are HTML. No full-screen garden, floating map cards or brush display face in this homepage.

STORY: Guest understands longitudinal observation and logs in. Teacher sees assigned scope and the first actionable pending category, then grouped classes and evidence. Administrator sees the school and manages classes/teachers, without teaching confirmation actions.

FIRST VIEWPORT: Assigned desktop: navigation → welcome/scope and isolated teacher artwork → one action strip → stage-grouped class rows → at most two recent summaries. Guest desktop: brand/complete illustration beside a separate login panel, followed by record → AI organize → teacher confirm → guide evidence → activity support. Administrator: welcome/school scope plus two management actions → all school classes grouped by stage. Teacher mobile: two-row header, welcome/scope, action strip, then assigned class rows; omit large artwork and school-year detail. Five navigation entries remain discoverable for users with class scope.

FORM: Use the exact four approved raster compositions with the approved illustration-clearance adaptation. Main typography, rows and controls come from the current home-v2 implementation, never from baked-in image pixels. Synthetic 54/94 examples are not runtime constants.

FINISH: Reviewer verdict 2 resolves evidence association (item 6) and documentation (item 7), completing all seven original material fixes. Disposition SHIP applies to ORIGINAL SEVEN FIXES ONLY; no new user decision or visual batch is required. Manual comparison/inspected-scope QA passed. Keep raw HERO FAIL and pending phases intact; this does not certify the whole app, security/auth, production or the automated comp-led pipeline.

## Durable tokens and asset provenance

Normative `home-*` primitives are in the DESIGN.md frontmatter; `.impeccable/design.json` extends them with component samples, source paths, ramps, breakpoints, motion, asset provenance and candidate status. Home-only tokens do not replace the global theme.

- Ground `#fefdf9` is scoped by `body:has([data-home-state])`; other routes retain `bg-background`. Navy `#0a1d54`, leaf green `#008344`, cream action `#fffbf0`, white rows and fine warm-grey lines define the homepage. Existing row/nav ink variants stay distinct in the extracted tokens.
- The actual CSS family is `'Home Noto Sans SC', 'Noto Sans SC', sans-serif`, with variable weights 100–900 and swap. The locally measured WOFF2 is 107,664 bytes, 414 glyphs, SHA256 `6ded052d2ac148fd8405f4625054cc523cd158c62a74e8b7b008ff8bc75c9646`; source and OFL 1.1 license are `public/assets/fonts/home-v2/source.json` and `OFL-NotoSansSC.txt`.
- Font coverage is bounded to fixed UI plus approved example glyphs. Rare business names rely on fallback; arbitrary-data glyph metrics and wrapping are NOT_VERIFIED. Regenerate after static copy changes using `pnpm exec node scripts/fetch-home-font.mjs`, then manually refresh source.json bytes/glyph/hash. Generation uses public font services; runtime is self-hosted. The script implements no byte-size cap. This documentation pass did not regenerate the font or read private data.
- `public/assets/illustrations/home-v2-guest.png` is a 1774×887 native transparent PNG derived from `01-guest-desktop.png`; `home-v2-teacher.png` is 1635×962, derived from `02-teacher-desktop.png`. Both contain the inspected PNG `tEXt` key `impeccable:prompt`. Their adjacent `.png.json` files name exact approved references, tool, transparency and prompt files `guest-asset-prompt.txt` / `teacher-asset-prompt.txt`. Do not fabricate model IDs or treat the illustrations as UI/data.

## Source measurements and acceptance requirements

Source inspection is not computed-style or browser verification.

- Content/nav max width is 1356px inside the existing 1536px root container. Responsive thresholds are 1390px, 1090px and 767px; the middle threshold wraps navigation and actions, the last switches to mobile natural flow.
- Main welcome title is `clamp(32px, 3.15vw, 48px)` / 750 / 1.28; mobile is 26px / 1.3. The 38px desktop value belongs to the action-count number, not the main heading. Section titles are 29px, mobile 23px. Mobile pending states and navigation are 14px; existing 12px archive/role badges are not canonized as the critical-state floor.
- Desktop teacher art has 190px container/image height, 370px image width and contain fit. A 176px welcome minimum with the art shifted up 40px implies about 26px nominal clearance before the action strip. Approved clearance is at least 24px (target 24–32px), with complete intended portrait, hands and notebook. New local DOM measures 25.999px clearance with the font loaded and the complete portrait visible. Arbitrary long names, rare glyphs and additional device combinations remain outside this bounded conclusion.
- Desktop class/recent rows use grids with fine separators; pending categories should keep stable corresponding columns when values are absent. The new local captures and reviewer verdict 1 resolve the first five visual fixes, including row/category separators; the component sample alone is not that evidence and does not define every sparse-data layout.
- Core targets remain at least 44px: desktop primary at least 62px, mobile ordinary primary 56px, mobile action-strip primary 44px, mobile nav 56px. The assigned teacher's three class rows must be reachable in the 390×844 first viewport without shrinking key text or controls. New local DOM records the third row bottom at 804.5px < 844px, no horizontal overflow and core targets >=43.9px measurement tolerance; the reviewer resolved the visual criterion for that view. The broader responsive phase is still pending.
- Focus is a 3px deep-green outline with 4px offset. Buttons use restrained color-state transitions (150ms ease-out); reduced-motion rules suppress homepage/nav animation, transitions and smooth scroll. Flat controls and light borders replace the old map shadows and scene motion.

## Functional invariants

Use real persisted account login and fresh server-authorized scope; no role selector, public registration or fake identity toggle. Do not normalize passwords. Guest and identity-unavailable responses expose no private home data. Admin has no teaching task counts/buttons. Unassigned teacher contacts admin rather than creating a class.

Class and child counts, links and tasks come from authorized SQL. The parent reports genuinely exercised local account/read behavior against owned isolated synthetic data: administrator 6 classes/94 children, teacher only 3/54. This documenter pass checked implementation and existing evidence references; it did not rerun auth/HTTP/database checks. Those counts are neither production proof nor hardcoded values, even though they match the approved synthetic mock examples. Null means unread/unknown, never zero; authenticated empty scope and failed reads remain distinguishable.

Pending confirmations, supplements and organizes are separate observation workflow categories, not guide suggestions. Guide formal states remain exactly **暂无相关记录、已有相关线索、已确认观察到**; “AI 关联待核对” is a workflow hint, not a fourth state. ✓ means confirmed observation evidence, not test mastery, attainment or a score. Original `raw_text` is immutable; AI is a draft until teacher confirmation. Existing guide evidence sources, class-at-occurrence, adult-help semantics, denominator/period requirements and transaction guards are unchanged.

## Scoped completion and verification boundary

Latest status, synchronized on 2026-10-05 Asia/Shanghai: user/main handoff of reviewer verdict 2 and `design-qa.md` provide the final scoped disposition; `.impeccable/build/state.json.currentEvidence` and `docs/design/home-refinement-20261004/gate-adjudication.md` preserve capture/report associations and raw-gate adjudication. Their retained verdict 1 status prose is historical, not a new pending requirement; this three-file pass does not modify those records.

- Branch `codex/home-v2-craft`; local preview is complete at the user-requested original seven-fix scope. Initial finish review was FIX. **Reviewer verdict 2: items 6/7 RESOLVED; all 7/7 RESOLVED; disposition SHIP — ORIGINAL SEVEN FIXES ONLY.** Evidence/persistence association and document synchronization are verified; no remaining original-seven review, new user decision or additional visual batch is required. This does not certify the whole app, security/auth, production or an automated pipeline.
- **Browser recovered; current post-fix local visual evidence VERIFIED.** The previous IAB/pool blockage is historical. Actual cause was application pool starvation from the new teacher-management page's nested scoped query during concurrent/prefetch reads. The existing administrator guard now reads through a single client without weakening auth/scope; own preview restart and cleanup were verified by the main task.
- Current captures: `.impeccable/review/verdict-guest.png`, `verdict-teacher.png`, `verdict-admin.png`, `verdict-mobile.png` and `verdict-mobile-full.png`. Comparisons/report paths are `.impeccable/review/diff/verdict-{guest,teacher,admin,mobile}/side-by-side.png` and `report.json`; teacher comparison contains nineteen region pairs. buildstate currentEvidence points to these new artifacts and the adjudication. Old `final` / `current` captures are historical pre-fix evidence.
- Recorded actual DOM: `Home Noto Sans SC` loaded; body `rgb(254,253,249)`; teacher image-to-action clearance **25.999px**; mobile390×844 third class row bottom **804.5px < 844px**; `scrollWidth === clientWidth`; app core targets **>=43.9px** tolerance. This is current local browser evidence, not a source-only prediction.
- Main task's local validation: **HTTP 20/20**, including **10 parallel actual administrator renders**; **PG idle transactions 0**; **DirectAuth 107** and **pure 33 + 40 + 28** checks validated locally. This documenter inspected the new captures, current state and adjudication and records the supplied results; it did not rerun business checks. These are not hosted, real-model, production or deployment certification.
- **AUTOMATED HERO GATE: FAIL retained**, score **0.8516 / 85.16%**, `ok:false`, `forced:null`; no `--force`. hero remains **open**; sections, motion, responsive and review remain **pending**, and finish is null. The report-level numeric label `match` is not a successful gate. **Comp-led pipeline: NOT_COMPLETED. Scoped reviewer SHIP: ORIGINAL SEVEN FIXES ONLY. Whole-app/security/production/full business certification: NOT_VERIFIED. Push/deployment: NOT_RUN.**
- `design-qa.md` records **final result: passed** for **MANUAL comparison / inspected scope**, with the raw automated failure disclosed. The user-requested local code/fix goal is complete at that scope; no automated fake PASS, whole-app certification, push or deploy is implied.

### Gate differences and approved adaptations

The four source images remain the authority. Actual role/scope field data, server-sorted class names, honest UserRound icons when the DTO has no avatar asset, and smaller isolated art to preserve required clearance are approved real-business/usability adaptations; they neither invent identities nor downgrade the raster authority.

The adjudication retains each raw automated result separately: slogan detail0%/structure87% does not prove absence because the exact CJK slogan is present in the new capture and AX text; teacher-art remains raw drift despite complete figures/hands/book and approximately26px clearance; record-link remains raw61% drift despite the readable pen/action and actual recording destination. Independent reviewer and DOM evidence support the first-five RESOLVED decision. Do not force PASS, erase residual numeric differences, close other phases, or convert this bounded verdict into general authentication/production certification.

## Write scope and retained drift

This documenter owns writes only to `DESIGN.md`, `.impeccable/design.json`, and this surface brief. No source/API writes, new docs, resource generation, commit, push, deployment, hosted access or real-model calls. Broader evidence/detail-page redesign is not authorized.

Retain the non-homepage “轻量成长观察册” direction and guide contracts. Existing non-home prose still contains unresolved color/type tokens and historical “not implemented” wording despite existing globals.css and guide code; record this drift without repairing it. TopNav is already shared outside the homepage; this implementation linkage is not permission to adopt the home palette on other content surfaces. The first five visual fixes are locally resolved; items 6/7 are now resolved and the original seven-item list is complete under reviewer verdict 2. All uncompleted automated build phases retain their existing statuses. Unverified extra-device, arbitrary-name and production behavior is not a reusable system rule.
