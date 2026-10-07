# AUTH0-R2 交付报告（返修候选，等待主评审）

- 基线：`cea871f91795460ac219cf0920f94d2adc0550be`（AUTH0-R1 返修候选）
- 分支：`codex/auth0-contract`（独立工作树 `child-growth-auth0`，未整合其他分支）
- 本轮 R2 提交 SHA：见交付消息/`git log`（本文件不写入自身 SHA，避免自引用）
- 精确修改清单：
  - `scripts/check-auth-contract.ts`（参考算法与 3 个新增边界检查）
  - `src/lib/accounts/__fixtures__/contract-fixtures.ts`（登录媒体类型与模型等待反例）
  - `src/lib/home-v2/__fixtures__/contract-fixtures.ts`（主行动可空计数与局部未知反例）
  - `docs/auth-v1/contract.md`（A/B/C 必要语义说明与检查数更新）
  - `docs/auth-v1/auth0-r2-delivery.md`（本文件，新增）
  - 未修改：`src/lib/accounts/types.ts`、`src/lib/home-v2/types.ts`、`PRODUCT.md`、认证实现、schema、API、页面、G0～G5、HOME0、依赖与锁文件

## 三个主评审反例的 RED → GREEN

### A. 模型等待后的归属前提

- RED：`child-transferred-within-scope-conflicts: 模型等待重核结果不一致`，`actual {write:true,outcome:'saved'}` vs `expected {write:false,outcome:'conflict'}`（教师同时负责 A、B，幼儿 A→B 后旧请求仍被保存）。
- 修正：`evaluateModelWait` 在授权重核之后、返回 saved 之前，比较 `currentClassOf(before.resource)` 与 `currentClassOf(after.resource)`；事实不同 → `{write:false, outcome:'conflict', error:'state_conflict'}`。授权仍有效但前提变化也必须冲突；授权已失效仍保留既有 denied 语义；不修改发生时班级快照。
- GREEN：既有 CASE 全部保留；新增 `child-transferred-within-scope-conflicts`（同教师 A→B，冲突零写入）、`attribution-changed-with-none-label-conflicts`（事件标签 `none` 但事实变化，仍冲突）、`no-change-saves`（同归属正常保存）、`child-transferred-during-wait`（A→无权班级，保留 `out_of_scope` 拒绝）。

### B. JSON 媒体类型精确匹配

- RED：`jsonp-prefix-rejected: 登录保护结果不一致`，`actual {accepted:true}` vs `expected {accepted:false, failure:'content_type_rejected'}`（`startsWith("application/json")` 放行 `application/jsonp`）。
- 修正：新增 `isJsonMediaType`：按 `;` 截取媒体类型主体、trim、小写后与 `AUTH_LOGIN_CONTENT_TYPE`（`application/json`）精确相等；不做前缀匹配，不引入媒体类型库。可信 Origin、自定义头、禁止跨域凭证等守门全部保留。
- GREEN：`application/json`、`application/json; charset=utf-8`、`Application/JSON` 通过；`application/jsonp`、`application/json-seq`、`application/jsonx`、`text/plain`、空值拒绝。

### C. 首页局部未知计数

- RED：`child-count-unknown-retry: 主行动优先级不一致`，`actual 'start_observation'` vs `expected 'retry'`（三类待办已知为 0、class_count=1、child_count=null 时默认进入新记录）。
- 修正：参考输入 `counts.*`、`class_count`、`child_count` 与正式 DTO 一样可空；`nextPrimaryAction` 先按从高到低检查待办计数，遇 `null` 返回 `retry`（不得视为 0）；待办全部已知为 0 后才检查 `class_count/child_count`，任一 `null` → `retry`；已知待办 `>0` 时不因范围数量未知而被屏蔽。
- GREEN：新增 `child-count-unknown-retry`、`class-count-unknown-retry`、`known-confirmations-with-unknown-range`、`known-supplements-with-unknown-range`、`known-organizes-with-unknown-range`、`unknown-higher-priority-retry`、`unknown-supplements-blocks-start`；既有管理员、未分配、无幼儿、无观察、全部已知分支全部保留。

## 新增正向与边界检查

- 34) JSON 媒体类型精确匹配：8 个媒体类型直接断言 + fixture 场景齐全。
- 35) 模型等待归属前提：A→B 同教师冲突、标签 `none` 事实变化冲突、同归属保存、无权班级保留拒绝。
- 36) 首页局部未知计数：局部未知场景齐全并逐条核对；`child_count=null` → `retry`；已知待确认 → `process_confirmations`。
- 既有 33 项断言全部保留，无删除、无仅改预期。

## 共享类型与下游影响

- 本轮**未修改共享类型**（`src/lib/accounts/types.ts`、`src/lib/home-v2/types.ts` 均无 diff）：正式 DTO 本已允许 `null`，问题在 fixture 输入与参考算法；A/B/C 三处修正只落在 fixture、参考检查与契约语义说明。
- 下游影响：AUTH1/AUTH2 实现方需按 R2 契约落实（模型等待比较归属前提、媒体类型精确匹配、首页局部未知转 retry）；HOME 实现方沿用正式 DTO，无需改类型。

## 检查结果与限制

- `pnpm exec tsx scripts/check-auth-contract.ts` → `{ passed: 36, total: 36, reference_only: true }`
- `pnpm ts-check` → 通过
- `pnpm lint:build` → 通过
- `NOT_RUN`：真实事务协调、双连接交错与数据库零写入；真实 scrypt、认证、Cookie/CSRF；实库与迁移；模型调用；浏览器/UI；部署。
- 剩余限制：以上均为参考算法结果，不构成真实安全/事务/浏览器验收；`admin_already_initialized` 仍复用 409 `state_conflict` 语义码（已获接受，本轮未新增错误码）。

## 工作树状态

- 基线祖先正确，分支 `codex/auth0-contract`，提交后工作树干净；未 push、未部署、未合并 main、未操作其他 agent 工作树；`RTK.md` 仍不存在（记录，不补造）。
- 状态：**返修候选，等待主评审**；不自行宣布 AUTH1 可以开工。
