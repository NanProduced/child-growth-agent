# Homepage design QA — local candidate

> 本文件原有Homepage记录保持原历史范围；新增Chatbox v2 QA独立列于文末，不能互相替代或据此宣布整站/生产PASS。

final result: passed

## Visual truth and captures

Selected sources: `docs/design/home-refinement-20261004/01-guest-desktop.png`, `02-teacher-desktop.png`, `03-admin-desktop.png`, `04-teacher-mobile.png`.
The three desktop sources are1536×1024; mobile853×1844 represents390×844 logical space.

Browser: Codex IAB2, localhost5020, real sessions and owned isolated PostgreSQL. Required pre-correction captures under `.impeccable/review/`:
`guest-final-desktop.png`, `teacher-final-desktop.png`, `admin-final-desktop.png`, `teacher-final-mobile.png`,
`teacher-tablet.png`, `desktop.png` (1440), `teacher-unassigned.png`, and `teacher-mobile-full.png`.
Desktop captures1521×1014 and mobile375×811 were normalized by the comparison tool to the corresponding source frame;
this sizing difference is recorded rather than mistaken for content loss. The development badge is not product UI.

Combined comparisons and focused crops: `.impeccable/review/diff/final-{guest,teacher,admin,mobile}/`.
Sources and captures were opened in the same comparison input. Hero has a measured spec and individual text/control/art crops.

## Comparison history

1. Initial implemented capture: button width/position, smaller helper copy, class columns and mobile density differed.
   A batched source-guided correction addressed action width, class tracks, shorter mobile helper copy and status priority.
2. Independent fresh-context Impeccable finish reviewer (`01a10775-b22d-7223-830d-58f33ded563b`) inspected all required captures,
   paired crops and source. Disposition **fix**, not ship. Full measured similarities (81/87/86/68%) do not certify fidelity.
3. Reviewer material corrections are now implemented: self-hosted Noto Sans SC UI subset; mobile nav14px/status14px;
   visible number/status separation and stable tracks; homepage-only ground `#FEFDF9` with other routes' original ground restored;
   tighter mobile action/section rhythm; teacher artwork190px high with a reserved gap; primary mobile target>=44px.
   New browser captures are `verdict-guest.png`, `verdict-teacher.png`, `verdict-admin.png`, `verdict-mobile.png` / `verdict-mobile-full.png`.
   Independent verdict resolved all five visual fixes and then the two evidence/documentation fixes. Disposition **ship** is scoped to
   the original seven-item fix list; it is not a new whole-app, authentication, production or automated-pipeline certification.

## Five fidelity surfaces

- Typography: pre-correction system font differed from source. New local variable UI font is107,664 bytes/414 glyphs, with OFL notice.
  Fixed UI is self-hosted; arbitrary names outside the subset retain a Chinese fallback. Current browser reports this face loaded; reviewer resolved TYPE.
- Spacing/layout: new captures confirm grouped multi-class hierarchy, confirm-first flow and mobile separation; third row finishes at804.5px within844px.
- Colors/tokens: reviewer identified old ground too yellow; homepage-only corrected ground and navy now recorded in source.
  Other page backgrounds are not redesigned. Current browser samples `rgb(254,253,249)`; reviewer resolved GROUND.
- Images: two genuine native ImageGen transparent illustrations with prompt/origin provenance; no CSS/SVG picture substitutes.
  Complete unoccluded raster has measured25.999px clearance; reviewer resolved the image fix.
- Copy/content: exact slogan and three-year/guide mechanism kept; data comes from current authorized SQL. Real-name sort order differs
  from mock order deliberately. DTOs lack actual avatar images; UserRound is an honest icon, not a fabricated child/photo.

## Function evidence (separate from visual acceptance)

- Pure homepage data40/40; mock account client33/33; teacher management logic27/27.
- Real Next HTTP20/20: guest denial, teacher3 classes/54 children, cross-scope and G5 restrictions, admin6/94,
  teaching-write rejection, wrong CSRF rejection, unassigned scope and revoked session denial, plus ten concurrent admin renders without pool starvation.
  Owned PG reports idle transactions0. No successful business write/model request.
- Owned isolated PostgreSQL access107/107, controlled late-save/lock interleaving and zero prohibited writes; not a browser test.
- Browser before the final correction: actual teacher/admin/unassigned login/logout, main CTA→3-item pending list→Review,
  real admin teacher directory, cancel-stop dialog, keyboard focus,44px targets and no horizontal overflow at390/768/1440.
  No confirmation/model action was clicked. Teacher management creation/grant/reset was not performed through UI.
- Build succeeded before the final visual correction. Latest correction type/style checks pass; final build/validate is recorded in handoff
  only after actual execution. Model quality, hosted DB, production migration, push/deployment: NOT_RUN.

## Blocking condition and recovery

After the correction, IAB5 stopped answering browser commands. Same-browser tab6 navigation also timed out.
Inventory additionally reported an unrelated Chrome request-header policy failure. Static/anonymous200 responses alone were
insufficient: a later authenticated HTTP run also stalled. Read-only inspection of the owned PostgreSQL found all five pool clients
idle in transaction. The administrator teacher page nested `scopedListClasses()` inside its authorized transaction, opening another
transaction while holding the first. Concurrent prefetch exhausted the pool. This was an application defect, not certified as an
external-only browser failure. The page now reads `listClasses()` within the existing fresh administrator read/client; the guard is not removed.
The owned preview server was stopped by recorded PID+creation identity+verified container ownership; its supervisor performs cleanup.
A fresh owned preview and ten concurrent real administrator renders are used for recovery/regression; the result is recorded only after execution.

Browser access recovered on a fresh same-IAB tab after the pool fix. The `final-*` shots are historical pre-correction evidence;
the new `verdict-*` shots are the actual post-correction evidence. Same reviewer scored all seven named fixes resolved, ending further visual edits.

## Residual limits

The automated hero gate is still **FAIL85.16%** and was not forced or converted to a pass. Source/build paired crops plus visible DOM and reviewer
adjudication show the slogan/art and recording action present; see `docs/design/home-refinement-20261004/gate-adjudication.md`.
This manual comparison gate has no remaining actionable P0/P1/P2 fix on the inspected scope, but the automated comp-led pipeline remains incomplete.
Minor raster/icon/glyph and real-data-order differences are recorded adaptations/P3, not silently hidden. Arbitrary-name fallback metrics,
real LLM quality, reverse proxy behavior, hosted database, public deployment and whole-app safety certification remain outside this local acceptance.

## Evidence UI polish — ordinary extension, 2026-10-08

Scope: only the class evidence workbench and child evidence list; bounded documentation of the shipped local candidate.
This section appends to the homepage QA history; its earlier result and automated hero FAIL remain separate.

Selected layout directions (synthetic figures are reference content, never product constants):

- Class option 3: `docs/design/class-overview-v2-20261008/03-evidence-workspace.png`.
- Child latest V4 option 1: `docs/design/child-evidence-v4-simple-20261008/01-single-column-list.png`; rejected V2/V3 are not authority.

Human layout comparison: opened both sources against saved formal desktop and narrow captures, plus both note fixtures.
Class desktop keeps aligned actual-N distribution and one inspector; narrow detail is a scrolled reading state with a return control.
Child keeps a normal single-column list and inline sources; at 390×844 progressive optional filters leave the first full item/status visible.
The app's warmer ground is intentional inherited adaptation; actual DTO wording, names, counts and dates replace synthetic comp content.
Local type: child title24/body16/meta14; class title24/detail18/guide-and-quote16; native targets44. No global token promotion.
No new shipped UI raster assets; adjacent PROMPTS.md/provenance.json retain reference origins and historical metadata.
Existing non-home DESIGN placeholders/implementation wording remain drift; no global system, sidecar or config repair.

Reviewer: `.impeccable/review/evidence-ui-polish/VERDICT-1.md` disposition **ship**, ORIGINAL SEVEN FIXES ONLY:

- F1 resolved: child narrow progressive age/goal/help filters; first complete item visible; tablet help can reflow.
- F2 resolved: compact class behavior rows; health references independently collapsed with complete source access.
- F3 resolved: class24/18/16 reading hierarchy and long-token wrapping.
- F4 resolved: notes/continuous summaries stay with matching observation; cross-record notes stay in association details.
- F5 resolved: existing launcher docked in these pages' document return toolbar, using the existing ≤1090px nav breakpoint.
- F6 resolved: no-record class badges keep dark text; saved computed-contrast checks pass ≥4.5.
- F7 resolved: inline statistics help in ordinary Chinese, preserving denominator/period, three states and UNKNOWN ≠ 0.
Initial `REVIEW.md` FIX history remains intact; this verdict does not certify the whole site, all two-page behavior or production.
Source read/selection cancellation, one inspector and same-period drilldown preserve verbatim quotes, dates, class snapshots and teacher control.

Saved formal evidence: `output/playwright/evidence-pages-206ffba5/results.json` **103/103**, errors=[], models0, cleanup_issues=[].
Real Next production HTTP + isolated PG + AUTH + Chrome use synthetic acceptance data; five viewports1440/1024/768/390 are recorded.
Injected HTTP faults/expected console failures and controlled response delay are separate; two long-token captures are DOM layout doubles.
`output/g3-verdict-final/notes-1440.png` and `notes-390.png` are component-only synthetic note fixtures, not persisted business examples.
Component suites: class115/115; child133/133 (old127+6). Pure34/42/63, validate and Next+tsup passed per delivery record; no rerun here.
No fabricated comp-diff score, FORM seed, QUALITY BAR or hero gate pass; scope is human layout comparison and the seven resolved fixes.
NOT_RUN: real provider, hosted DB/object bucket, deploy, real phones/soft keyboard, Safari and manual screen reader. No push/merge.
---

# 芽芽 Chatbox v2 — scoped local QA (2026-10-08)

final result: passed (local inspected scope; not production or pixel-identical acceptance)

Visual authority: the three native images in `docs/design/yaya-chatbox-v2/`, with direction-only user approval recorded in `approval.json`. The parent homepage history and FAIL85.16% hero gate above remain unchanged. Source `desktop-review.png`/`mobile-conversation.png` and actual1440/1024/390 screenshots were inspected together; all live background data is synthetic authenticated seed, not generated mock data.

## Five surfaces

- Typography: complete14–16px chat reading with1.65 rhythm, mobile composer16px; no automatic long-answer cutoff. Existing system sans/fallback remains, not pixel-identical glyph metrics to generated images.
- Layout/spacing: desktop reserved360–480px nonmodal column, mobile fullscreen, fixed visible composer; floating entry hidden while open. Main page links work; homepage container queries prevent narrow-main vertical text and rigid track overflow. Open/close preserves draft; no second visible runtime/provider.
- Colors/tokens: existing warm white/leaf green with mint user bubble and fine separators. No global token/DESIGN replacement. Error/unknown/saved remain distinct and are not inferred from green styling.
- Imagery: existing native avatar at small authored sizes; ordinary Lucide icons. No generated UI crops or fake child photographs/assets. Approved PNGs remain design references, not rendered backgrounds.
- Content: no compulsory child/module/source form. Optional current-page reference has preview/remove and pinned snapshot. Exact teacher raw text survives. Review preserves object/date/原文/后果; detailed IDs collapse but verification status is visible. List selection is explicitly withheld without per-resource dependencies rather than labeled public.

## Real implementation evidence

`output/playwright/final-wiring/browser-results.json`:18 grouped records (including3 geometry records), errors0, actual Chrome at1440×900/1024×900/390×844; all3 report overflow=false and composer_visible=true. Actual session originates inHTTP login, PG is isolated, only model is an owned protocol double. Checks include navigation/clicks, quote/remove/Escape, draft retention, request-delayed keyboard guard, approval→realDB, reload→original receiptGET and no repeated execute/messagePOST. Mobile focus/Tab and reduced-motion were exercised, not real mobile keyboard.

Latest combined route checks70/70, APP182/182, client56/56, new reference42/42; final type/lint/style and NextWebpack+tsup successful. Dedicated checks do not count image-generation pixels or fixture data as real-provider acceptance.

## Bounded review, limits and failures

One source/capture inspection identified narrow-main homepage layout; one batched visual correction and confirmation completed. Independent read-only reviewer identified list-selection source loss, keyboard wait bypass and missing list filters; shared boundary fixes and counterexamples are recorded in delivery. Impeccable targeted detector:0 primary /5 font-size advisory; no whole-site policy rewrite.

DevWebpack refresh `Invalid or unexpected token` remains unclassified. Production-local build refresh/receipt recovery passes with0 page errors. Early selectors matched hidden Activity nodes and were scoped to visible cards withoutforceclick or dropping DB assertions.

NOT_RUN: realprovider/S3/hostedDB/deployment, true mobile keyboard/Safari/iOS, manual screen reader and full desktopTab-order audit. No preview resources retained. Source truth, browser functional proof and production readiness stay separate; see `docs/yaya-v1/chatbox-v2-delivery.md`.

## 2026-10-08 消息UI复用/精简追加轮

Local inspected result: passed. Prior homepage gate and earlier chatbox record remain historical, not rewritten as production certification.

Assistant-ui0.15.23 actual exports/source verified: native Quote/QuoteText/QuoteDismiss, Message.Quote, ActionBar.Root/Copy, AuiIf, Attachment primitives and ScrollToBottom/ViewportFooter. Business approval/receipt cards keep application protocols rather than fake generic tool-call parts.

One batched desktop/mobile inspection simplified query/source noise, duplicate badges, primary/secondary actions and ready/retry image states. It exposed an empty-avatar workspace proposal cue and led to one batch of visible corrections. Functional confirmation separately corrected a test's multipart-field assumption and the pre-existing cancel-caption/API mismatch; no aesthetic redesign loop followed. Latest source captures were inspected: pending/saved1440, full long390 and retry390.

Chrome24 grouped records (including3 geometry), errors0; original scope preserved, native copy/quote/remove/scroll and keyboard menus work. Full fields remain before approval. Real local HTTP/PG70/70, client56/56, quote42/42, new actual-render15/15 and NextWebpack build pass. Impeccable targeted detector0 primary/5 advisory, not a visual-quality or production certificate.

`取消提案` is corrected to `撤销未执行批准` because the existing repository does not close proposals. Honest null feedback leaves a proposal reviewable and does not undo any saved observation. Unknown results still query original identity. Exact artifacts, component inventory and NOT_RUN are in `docs/yaya-v1/chatbox-v2-components.md`. True mobile keyboard, screen reader, real provider/bucket and deployment remain NOT_RUN; local model is a protocol double.
