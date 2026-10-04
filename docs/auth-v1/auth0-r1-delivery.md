# AUTH0-R1 交付报告（返修候选，等待主评审）

- 基线：`734f572925e7c298f2226679c00e3e4e978068b2`（上一轮待返修候选，**不是获批实装基线**）
- 分支：`codex/auth0-contract`（独立工作树 `child-growth-auth0`，未整合其他分支）
- 本轮 R1 提交 SHA：见交付消息/`git log`（本文件不写入自身 SHA，避免自引用）
- 精确修改清单：仅 `docs/auth-v1/contract.md`、`docs/auth-v1/ownership.md`、`docs/auth-v1/auth0-r1-delivery.md`（新增）、`src/lib/accounts/types.ts`、`src/lib/accounts/__fixtures__/contract-fixtures.ts`、`src/lib/home-v2/types.ts`、`src/lib/home-v2/__fixtures__/contract-fixtures.ts`、`scripts/check-auth-contract.ts`、`PRODUCT.md`（局部）

## A～G 修正前后与参考反例

### A. 首位管理员初始化

- 修正前：公开 `POST /api/auth/initialize-admin` 在接口清单中；`InitialAdminRequest/Response` 形同 HTTP DTO；无并发与覆盖语义。
- 修正后：公开接口设计**撤销**，`AUTH_API_ACTIONS` 不再包含初始化动作；改为部署者非公网脚本；冻结授权前提（仅部署主机，公网/HTTP 一律拒绝）、一次性、并发唯一成功、已有管理员不得覆盖/重置、密码不走 argv/env/日志、失败回滚；类型改名 `AdminBootstrapInput/Result/Status` 并注明非公开 DTO。
- 反例：`public-http-no-admin-rejected`、`authenticated-http-admin-exists-rejected`、`deployer-admin-exists-rejected`、并发两个仅 1 成功 1 冲突 → 全部通过。

### B. 登录前 / 登录后保护分离

- 修正前：所有变更请求（含登录）都要求会话绑定 CSRF，未登录无法登录。
- 修正后：
  - 登录前：可信 `Origin` 只来自部署配置（Host/Forwarded 不参与）、仅 `application/json`、固定自定义头 `x-cga-auth-request: 1`、不要求会话 CSRF；跨源/Origin=null/缺同源证明/缺头/普通表单拒绝；
  - 登录后：同源 + 有效会话 + 会话绑定 `x-csrf-token`；另一会话令牌不可用；登录建立全新会话与令牌；
  - 退出：有效会话撤销；失效/缺失幂等清理；旧 Cookie 不授权、不阻断登录；服务端按原路径 `/` 清除旧 Cookie；
  - `SESSION_RENEWAL_ON_GET=false`、`CSRF_FETCH_RENEWS_SESSION=false`。
- 反例：`valid-pre-login-without-session`（无会话可登录）、`cross-origin/origin-null/spoofed-host/origin-missing/header-missing/plain-form`、`other-session-token-rejected`、Cookie 并存三态 → 全部通过。

### C. 动作/资源合法组合

- 修正前：`observation.confirm + { kind:"class" }` 在参考算法中返回 `allowed:true`（主评审独立探针复现）。
- 修正后：`ACTION_RESOURCE_KINDS` 冻结每个动作的合法资源；**先组合合法、后角色与范围**；非法组合 400 `invalid_request`，管理员不能绕过；`observation.write`=child（创建观察）、`observation.organize/confirm/guide.decide`=observation（已有观察）；建档=class（目标班级）、转班=transfer（幼儿+目标班级）、小结/活动支持=child；资源事实只能服务端读取。
- 反例：`invalid-combo-confirm-with-class`（教师）、`invalid-combo-admin-confirm-with-class`（管理员）、`invalid-combo-write-with-observation`、`invalid-combo-profile-with-observation`、`invalid-combo-guide-with-child`、`invalid-combo-teacher-manage-with-class`；合法侧 `teacher-a-write-observation-for-current-child`、`teacher-a-organize/confirm-existing-observation` → 全部通过。

### D. 密码哈希参数

- 修正前：N=16384, r=8, p=1, key_length=64。
- 修正后：**N=32768, r=8, p=3, key_length=64, maxmem=64MiB**；随机盐至少 16 字节；格式不变；不接受请求成本参数；密码不 trim、不做 Unicode 规范化；正确/错误密码、独立盐、格式、耗时与并发资源检查列为 AUTH1 验收。
- 反例：参数/`maxmem`/盐长度/格式段位/原样密码样本全部一致 → 通过。

### E. 统一授权错误码

- 修正前：文档写 `forbidden_role` / `out_of_scope`，`AuthErrorCode` 缺失（只有泛化 `forbidden`）。
- 修正后：补齐 `forbidden_role`、`out_of_scope`（均 403），移除泛化 `forbidden`；新增 `AUTH_DENY_ERROR_CODE` 拒绝原因→错误码映射；授权失败不得包装为空/无记录/依据失效，409 业务冲突保留。
- 反例：映射一致性、401/403/503、无 409 授权错误 → 通过。

### F. 模型等待期间撤权/停用/转班

- 修正前：只有“请求开始时一次授权”的表述。
- 修正后：冻结事务外模型调用、返回后重核清单（会话/账号/权限/任教/幼儿归属/观察修订/请求归属）、共同事务协调、拒绝客户端 Principal 与缓存范围、新会话不能承接旧请求；提供参考时序与 `FIXTURE_MODEL_WAIT_CASES`（含 409 冲突与零写入断言）。
- 反例：`session-revoked`、`account-disabled`、`assignment-removed`、`child-transferred`、`observation-changed`、`new-session-cannot-take-over` → 全部通过（reference_only）。

### G. 首页范围、待办与主行动

- 修正前：教师首页观察被强制限定“发生在当前任教班级”；`pending_count` 混用；`覆盖`、计数为普通数字；无“继续整理”动作码；未登录文案“教师登录”。
- 修正后：`pending` 仅含当前可操作记录（原班历史只读排除），当前负责幼儿的转入前历史可展示且保留发生时班级；待确认/待补充/待整理分开计数；数字 `null=未获取`、`0=真实零值`；新增 `organize_draft`；主行动优先级固定为待确认→待补充→待整理→建档/新记录；未分配不提供建班捷径；无幼儿→建档、无观察→开始记录、读取失败→重试；文案统一“园所账号登录”。
- 反例：教师 A 历史只读不入待办、教师 B 转入前历史可操作且保留原班、管理员待办为 0、无分配/无幼儿/无观察/读取失败四态、主行动 8 组用例 → 全部通过。

## 新冻结接口 / 旧接口退役 / HOME 接入

- 新增：登录前保护常量与失败码、`SESSION_WRITE_PROTECTION`、`CSRF_TOKEN_BINDING`、退出语义、`AdminBootstrap*`、`MODEL_WAIT_*`、`ACTION_RESOURCE_KINDS`、`AUTH_DENY_ERROR_CODE`、首页 `HomePendingCounts`/`organize_draft`/`data_unavailable`。
- 退役：公开 `POST /api/auth/initialize-admin`；旧 `{passcode}` 登录形状；泛化错误码 `forbidden`；首页 `pending_count` 与“教师登录”文案。
- HOME 接入：只消费 `src/lib/home-v2/types.ts`；`pending_counts` 三态计数 + `pending` 可操作列表 + 单一主行动；`organize_draft` 与 `retry` 由 HOME 实现方装配；不得在前端过滤全园数据，也不得私自扩类型（由契约负责人统一修订）。

## AUTH1 / AUTH2 尚需验证的真实行为（本轮 NOT_RUN）

- AUTH1：scrypt 正确/错误密码、独立随机盐、存储格式解析、`maxmem` 生效、耗时与并发内存；会话 Cookie 属性（HttpOnly/SameSite/Secure）、令牌哈希、固定期限、撤销与停用/重置级联；登录限流与 `invalid_credentials` 不泄露；可信 Origin 在反向代理后的真实行为；旧 Cookie 服务端清除路径。
- AUTH2：模型等待期间撤权/停用/转班的真实事务交错与零写入；路由授权接入后的 401/403/503/400 实际响应；G5 GET 从公开变受限的实库行为；管理员教学动作拒绝的真实路径。
- 浏览器/UI：首页各状态、待办计数与主行动的真实渲染与交互。

## 实际检查结果与限制

- `pnpm exec tsx scripts/check-auth-contract.ts` → `{ passed: 33, total: 33, reference_only: true }`
- `pnpm ts-check` → 通过
- `pnpm lint:build` → 通过
- `NOT_RUN`：真实认证/DB/模型/浏览器/部署；参考算法不构成真实安全、事务或浏览器验收。
- 剩余限制：`admin_already_initialized` 复用 409 `state_conflict` 语义码（尚无独立错误码）；初始化脚本、迁移与路由改造均未实现。

## 工作树状态

- 分支 `codex/auth0-contract`，基线祖先 `734f572`，R1 提交后工作树干净；未 push、未部署、未合并 main、未操作其他 agent 工作树。
- 状态：**返修候选，等待主评审**，不自行宣布通过。
