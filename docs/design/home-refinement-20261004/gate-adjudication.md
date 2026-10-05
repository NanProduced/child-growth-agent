# Current visual evidence and automated gate adjudication

## Authority and scope

The four user-approved raster designs remain the visual authority. No `--force` was used and no automated failure was changed to a pass.
The user also requested real-business adaptations during implementation. Actual role/scope data, sorted class names and honest
UserRound icons (DTOs have no avatar asset) remain documented adaptations, not invented identities.

## Current evidence

- Desktop guest: `.impeccable/review/verdict-guest.png`; comparison `diff/verdict-guest/side-by-side.png`.
- Desktop teacher: `.impeccable/review/verdict-teacher.png`; comparison `diff/verdict-teacher/side-by-side.png` and nineteen region pairs.
- Desktop administrator: `.impeccable/review/verdict-admin.png`; comparison `diff/verdict-admin/side-by-side.png`.
- Teacher390×844: `.impeccable/review/verdict-mobile.png` / `verdict-mobile-full.png`; comparison `diff/verdict-mobile/side-by-side.png`.
- Recorded DOM evidence: self-hosted font loaded; body `rgb(254,253,249)`; whole teacher image-to-action gap25.999px;
  three mobile class rows finish at804.5px within844px; `scrollWidth===clientWidth` and no app controls below43.9px tolerance.
- Browser recovered after the application pool-starvation fix. Ten concurrent real administrator renders complete; observed
  idle transactions are0. The administrator guard remains in place; only nested read-client acquisition was removed.

## Individual automated findings

| Finding | Pixel/DOM evidence | Adjudication | Raw gate result |
| --- | --- | --- | --- |
| `slogan` “missing”, detail0%, structure87% | Exact slogan is visible in `verdict-teacher.png` and source/build comparison; current AX text also contains it. | CJK crop/detail measurement does not prove missing content. Source-sized region comparison and independent reviewer support presence. This is not an authority downgrade. | retained fail |
| `teacher-art` “missing/drift” | Complete native raster, including figures/hands/book, is visible with26px clearance. Natural image1635×962, `object-fit:contain`, no clipped UI overlay. | Independent reviewer resolved the explicit clearance requirement. The smaller isolated illustration is a usability adaptation to prevent overlap, not substituted material. | retained drift |
| `record-link`61% chrome drift | Pen icon and “开始记录” remain visible, readable and clickable; link goes to actual recording page. | Independent reviewer resolved the action-region fix. Numeric crop/font/icon variance remains residual rather than a missing action. | retained fail |

The numeric full-view similarities are not functional or visual acceptance. The automated hero gate still reports **FAIL**;
it is preserved in `.impeccable/build/state.json` with the current capture/report and separate reviewer adjudication.
Do not convert remaining phases to “passed”, use a forced pass, or claim the automated comp-led pipeline completed.

## Independent reviewer verdict scope

Fresh finish review: **FIX** with seven material items. New-evidence verdict: first five visual items **resolved**;
only evidence/persistence and documentation remained partial. This document and the current state association address the evidence record;
DESIGN/sidecar/surface brief must record the latest verified state and remaining raw gate failure. A later verdict scores these two records,
not a new broad sweep or authentication/production certification.
