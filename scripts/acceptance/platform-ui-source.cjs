"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const read = file => fs.readFileSync(file, "utf8");
assert.equal(git("branch", "--show-current"), "codex/platform-ui-typeset");
assert.equal(git("hash-object", "scripts/harness-safety.ts"), "6702f2ddf3b436e79f8c92ae8756c33f611a8503");
const BASE = "ccf5998c20a4e8de6671f3938ec86a14f3ed545e";
const changed = git("diff", "--name-only", BASE).split("\n").filter(Boolean);
const owned = file => /^src\/app\/(?!api\/).+\.(?:tsx|css)$/.test(file)
  || /^src\/components\/(?!yaya\/client\/).+\.(?:tsx|css)$/.test(file)
  || /^scripts\/acceptance\/platform-ui-/.test(file)
  || /^docs\/platform-review\/ui-/.test(file)
  || file === ".impeccable/surfaces/src-app-globals-css.md";
assert.deepEqual(changed.filter(file => !owned(file) && file !== "next-env.d.ts"), []);
for (const file of ["src/app/classes/page.tsx", "src/app/children/page.tsx", "src/app/children/new/page.tsx", "src/app/observations/page.tsx", "src/app/observations/new/new-observation-client.tsx", "src/app/observations/[id]/review/review-client.tsx", "src/app/activities/page.tsx", "src/app/reports/page.tsx"]) assert.match(read(file), /data-platform-surface=/, file);
assert.match(read("src/components/ui/input.tsx"), /h-11 min-h-11/);
assert.doesNotMatch(read("src/components/ui/input.tsx"), /md:text-sm/);
assert.doesNotMatch(read("src/components/ui/textarea.tsx"), /md:text-sm/);
assert.match(read("src/components/ui/button.tsx"), /min-h-11 min-w-11/);
assert.match(read("src/components/ui/dialog.tsx"), /关闭/);
assert.match(read("src/components/ui/dialog.tsx"), /overflow-y-auto/);
assert.match(read("src/app/classes/page.tsx"), /flex-wrap.*lg:flex/);
assert.match(read("src/app/children/new/page.tsx"), /min-h-11 min-w-11 cursor-pointer/);
assert.equal(git("diff", BASE, "--", "src/lib", "src/app/api", "src/storage", "src/components/yaya/client", "package.json", "pnpm-lock.yaml", "scripts/harness-safety.ts"), "");
console.log(JSON.stringify({ status: "PASS", level: "source_only", base: BASE, harness_blob: "unchanged", owned_files_from_base: changed.filter(owned).length, browser: "NOT_RUN by this check", model: "NOT_RUN by this check" }));
