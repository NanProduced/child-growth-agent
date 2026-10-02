# 首页 / — 绘本式全园成长地图（参考还原）
Mode: Operate. Scope: homepage visual rebuild; reuse all current queries, data, links and auth.

## Direction contract
THESIS: Teachers are inside a coherent illustrated kindergarten, moving from school to stage to real class without leaving the scene.
OWN-WORLD: Navy hand-brushed display lettering, warm cream, bright leaf-green capsule action, coral/gold/blue activity gardens, large painterly children, physical blank book and wooden gate sign. Data and controls remain HTML.
STORY: Start at all-school; expand one garden stage; independently select a real active class; review its pending observation or choose a child and record.
FIRST VIEWPORT: Full-width scene directly below nav. Headline floats on upper-left clouds, school sign below center building, teacher/children in center, open book/action at lower center. Small-stage entry on left, middle upper right, large lower right. Stage class nodes expand IN the corresponding region; selection details remain beside that region and never cover the central action. Overflow class counts scroll inside bounded panels. The compact recent-observation band joins the scene bottom. At 390px, independent portrait art combines headline/building/teacher with action, followed by school summary, illustrated natural-flow stage accordions, pending, recent.
FORM: User-approved plan and four pinned docs/design/homepage-map-*.png references. Code-led implementation measured against those references; no additional concept or comp approval needed.
SIGNATURE: Once-only staged arrival, scene-region lift/path highlight, local node/panel entrance and one leaf emphasis. Reduced motion removes animation/transition/displacement while retaining selection and focus.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Constraints
- No DB writes in checks, no schema/API/LLM/state/auth changes, no new dependencies, no push/deploy.
- Real enabled classes and current school years, current children plus occurrence-class observation snapshots. All statuses/counts/actions from existing view model. No fixed sample counts.
- Homepage copy exclusions and Review provenance requirements remain as specified by user. Do not invent teacher accounts, names or notifications.
- Reference paintings are only visual guidance. Newly generated art contains no UI text, buttons, badges or data. Font is self-hosted and licensed; illustration prompts kept with assets.
