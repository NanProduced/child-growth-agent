---
primary_target: src/components/guide/evidence-route-client.tsx
related_targets: [src/app/children/[id]/evidence/page.tsx, src/app/classes/[id]/evidence/page.tsx]
---

# Local integration of G3/G4 read surfaces

Mode: Read / Operate. Scope: assemble existing approved G3/G4 components using G5 server DTOs. No new visual world, evidence algorithm, permission model or teaching mutation.

## Direction contract

THESIS: A teacher can read an item, expand its sources and move from a class distribution to one child's evidence without losing the applied period.

OWN-WORLD: Inherit G3/G4 and DESIGN.md exactly; no new palette, artwork, fonts, global CSS or metric framing.

STORY: Existing detail page → guide evidence → filter / period → item disclosure → class roster drilldown → return to detail.

FIRST VIEWPORT: One return control above the existing evidence component. Its existing identity, applied period, domain and reference-age controls remain the information hierarchy. Transition feedback does not replace existing readable content.

FORM: Precisely scoped extension, no concept seed needed. Server components load the formal DTO; a small client adapter only changes URL parameters. Source dates, formal states and class ratios are never computed in this adapter.

SIGNATURE: Roster drilldown retains scope and filters, narrows to the item's goal and focuses the matching item disclosure. Browser Back restores the URL-backed applied scope.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Integration limits

- Read-only page assembly, not full G6: no review/manual-association authoring UI, no item-aware observation write flow.
- AUTH1 remains excluded; this is not an authorized production preview. Local supervisor disables legacy write sessions, binds loopback and uses an isolated PostgreSQL database.
- No generated or changed raster assets. Existing artwork stays with its committed sources.
- Frozen G3/G4 files and server algorithms are unchanged. DESIGN.md is inherited, not rewritten.
