import type { HeaderCarrier } from "@/lib/accounts/guards";
import { AccountsError } from "@/lib/accounts/errors";
import { withPrivateRead } from "@/lib/yaya/data";
import { scopedGetChild, scopedGetClass, scopedGetObservation } from "@/lib/accounts/scoped-queries";
import { withBusinessRead } from "@/lib/accounts/access";
import { readAccessResourceFacts } from "./data/access-facts";
import { parseReferencePath, type YayaPageReference } from "./page-reference";

/** Whitelisted app resources only; no HTML scrape, arbitrary URL, form values or secrets. */
export async function readPageReference(carrier: HeaderCarrier, rawPath: string): Promise<YayaPageReference> {
  const identity = await withPrivateRead(carrier, async ({ principal }) => principal);
  const page = parseReferencePath(rawPath);
  if (page === null) throw new AccountsError("invalid_request", "当前页面不能作为引用；请在班级、幼儿档案或观察页面引用。");
  const reference: YayaPageReference = {
    format: "yaya-page-focus-v1", owner_account_id: identity.account_id,
    path: page.path, title: page.title, summary: "", sources: [], revision: null,
    captured_at: new Date().toISOString(),
  };
  if (page.kind === "child") {
    const child = await scopedGetChild(page.id!, carrier);
    if (!child) throw new AccountsError("not_found", "幼儿资料不存在或不可读。");
    reference.title = child.name + "的成长档案";
    reference.summary = "当前幼儿：" + child.name + "；child_id=" + child.id + "。引用只强调关注对象，未自动读取完整档案或将AI小结变成已确认事实。";
    reference.sources = [{ kind: "child", child_id: child.id, current_class_id: child.class_id ?? null }];
    reference.revision = child.updated_at ?? child.created_at;
  } else if (page.kind === "class") {
    const klass = await scopedGetClass(page.id!, carrier);
    if (!klass) throw new AccountsError("not_found", "班级资料不存在或不可读。");
    reference.title = klass.name + (page.path.split("?")[0]!.endsWith("/evidence") ? " · 班级指南证据" : " · 班级");
    reference.summary = "当前班级：" + klass.name + "；class_id=" + klass.id + "；学年=" + klass.school_year + "。未自动读取私有名单或把指南参考变成幼儿事实。";
    reference.sources = [{ kind: "class", class_id: klass.id }];
    reference.revision = klass.updated_at ?? klass.created_at;
  } else if (page.kind === "observation") {
    const observation = await scopedGetObservation(page.id!, carrier);
    if (!observation) throw new AccountsError("not_found", "观察资料不存在或不可读。");
    const facts = await withPrivateRead(carrier, ({ client, schoolId }) =>
      readAccessResourceFacts(client, { kind: "observation", observation_id: observation.id }, schoolId));
    if (facts?.kind !== "observation") throw new AccountsError("not_found", "观察归属无法核验。");
    reference.title = "观察记录 · " + observation.observed_at;
    reference.summary = "当前观察：observation_id=" + observation.id + "；日期=" + observation.observed_at + "；状态=" + observation.status + "。需要正文/草稿/依据时，仍应调用已授权工具读取；不可仅凭页面引用确认归档。";
    reference.sources = [{ kind: "observation", observation_id: observation.id, child_id: observation.child_id, current_class_id: facts.current_class_id, observed_class_id: facts.observed_class_id }];
    reference.revision = observation.updated_at ?? observation.created_at;
  } else {
    reference.summary = "关注页面：" + page.title + "。仅提供页面入口，不自动注入私人名册或全部业务资料。";
  }
  if (page.filters) reference.summary += "；页面筛选（关注提示，不是权限或强制工具指令）：" + page.filters;
  // An identity change during resource reads must not attach the earlier account's projection.
  await withPrivateRead(carrier, async ({ principal }) => {
    if (principal.account_id !== identity.account_id) throw new AccountsError("unauthenticated", "账号已变化，请重新引用。");
  });
  if (page.kind === "child") await withBusinessRead(carrier, "child.read", { kind: "child", child_id: page.id! }, async () => undefined);
  else if (page.kind === "class") await withBusinessRead(carrier, "class.read", { kind: "class", class_id: page.id! }, async () => undefined);
  else if (page.kind === "observation") await withBusinessRead(carrier, "observation.read", { kind: "observation", observation_id: page.id! }, async () => undefined);
  return reference;
}
