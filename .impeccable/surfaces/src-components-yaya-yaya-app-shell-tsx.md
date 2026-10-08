---
primary_target: src/components/yaya/yaya-app-shell.tsx
related_targets: [src/components/yaya/yaya-panel.tsx, src/components/yaya/yaya-composer.tsx, src/components/yaya/yaya-message.tsx, src/components/yaya/yaya-proposal.tsx, src/components/yaya/yaya-workspace.tsx]
mode: Operate
---

# 芽芽 Chatbox v2 — user-approved direction

Visual authority: `docs/design/yaya-chatbox-v2/` three approved native ImageGen images; approval is direction-based, not pixel-identical. Keep assistant-ui runtime, existing sprout avatar, warm white and leaf green; do not redesign other business pages or global tokens.

Desktop: dock, not overlay. Main page stays usable; floating entry disappears. Mobile: fullscreen dialog and visible multiline composer. Natural-language entry is primary; no compulsory child/module form. Page quote is optional untrusted focus, pinned on explicit selection and independently removable; current rights remain server-authoritative. List selection without per-resource dependencies is withheld, not converted into public content.

Chat rhythm: calm user bubbles, readable complete answers, subtle tool provenance; detailed audit ids fold, success/unknown/failure remain visible. Review cards preserve all approved business fields and consequences. Unknown writes only query original identity; drafts and same-account input survive closing, different identities cannot inherit private projections. Reuse native primitives and existing components; no additional state/store/dependencies.

Acceptance: actual Chrome at1440/1024/390 with real AUTH/local isolated PostgreSQL/Next production server and owned model double. Evidence remains distinct from real provider/hosted database/production deployment. See scoped QA in `design-qa.md` and delivery report.
