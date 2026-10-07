# Homepage design QA — local candidate

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
