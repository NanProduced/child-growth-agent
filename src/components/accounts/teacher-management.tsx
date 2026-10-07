"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import { z } from "zod";
import { useTeacher } from "@/components/teacher-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { authIdentityKey, fetchWithAccountAuth } from "@/lib/accounts/client";
import { isValidNormalizedUsername, normalizeUsername } from "@/lib/accounts/normalize";
import { PASSWORD_MIN_LENGTH, type AccountStatus, type TeacherAccountSummary } from "@/lib/accounts/types";
import { CLASS_STAGE_LABELS, type SchoolClass } from "@/lib/types";

export type TeacherClass = Pick<SchoolClass, "id" | "name" | "stage" | "school_year" | "is_active">;
type Props = { adminAccountId: string; initialTeachers: TeacherAccountSummary[]; initialClasses: TeacherClass[] };
export type TeacherChange =
  | { kind: "create"; username: string; display_name: string; initial_password: string }
  | { kind: "reset_password"; account_id: string; new_password: string }
  | { kind: "assign" | "remove"; account_id: string; class_id: string }
  | { kind: "status"; account_id: string; status: AccountStatus };
/** Create and reset never keep a password across attempts; re-reading the directory cannot confirm either. */
export type PendingTeacherChange =
  | { kind: "create"; username: string; display_name: string }
  | { kind: "reset_password"; account_id: string }
  | { kind: "assign" | "remove"; account_id: string; class_id: string }
  | { kind: "status"; account_id: string; status: AccountStatus };
type Confirmation = { teacher: TeacherAccountSummary } & (
  | { kind: "status"; status: AccountStatus }
  | { kind: "remove"; class_id: string; class_name: string }
);

const teacherSchema = z.object({
  account_id: z.string().min(1), username: z.string().min(1), display_name: z.string().min(1),
  role: z.literal("teacher"), status: z.enum(["active", "disabled"]), class_ids: z.array(z.string().min(1)),
  created_at: z.string(), updated_at: z.string().nullable(),
});
const classSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), stage: z.enum(["small", "middle", "large"]),
  school_year: z.string(), is_active: z.boolean(),
});

export class TeacherChangeError extends Error {
  constructor(public readonly kind: "auth" | "rejected" | "uncertain", message: string) {
    super(message);
  }
}

const errorMessages: Record<string, string> = {
  username_taken: "该用户名已被使用，请更换用户名；如上次提交结果待核对，请先重新读取名单。",
  invalid_request: "教师资料或班级信息不符合要求，请核对后再提交。",
  not_found: "教师或班级已不存在，请重新读取名单。",
  state_conflict: "教师资料已变化，请重新读取后再操作。",
  csrf_rejected: "当前登录校验未通过，请重新登录后再操作。",
};

function responseError(response: Response, body: unknown): TeacherChangeError {
  const code = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "";
  if (response.status === 401 || response.status === 403) {
    return new TeacherChangeError("auth", "当前登录或管理员权限已失效，请重新登录管理员账号。");
  }
  if (response.status >= 500) return new TeacherChangeError("uncertain", "请求结果暂无法确认。请重新读取核对，勿重复提交。");
  return new TeacherChangeError("rejected", errorMessages[code] ?? "本次操作未被接受，请核对资料后再操作。");
}

/** A single request per explicit action; no retry or optimistic assignment state. */
export async function persistTeacherChange(change: TeacherChange): Promise<{ teacher: TeacherAccountSummary; revoked_session_count?: number }> {
  let path = "/api/admin/teachers";
  let method = "POST";
  let payload: Record<string, string>;
  if (change.kind === "create") {
    payload = { username: normalizeUsername(change.username), display_name: change.display_name.trim(), initial_password: change.initial_password };
  } else {
    path += `/${encodeURIComponent(change.account_id)}`;
    if (change.kind === "status") { method = "PATCH"; payload = { account_id: change.account_id, status: change.status }; }
    else if (change.kind === "reset_password") {
      path += "/password-reset";
      payload = { account_id: change.account_id, new_password: change.new_password };
    } else {
      path += "/assignments";
      if (change.kind === "remove") { method = "DELETE"; path += `/${encodeURIComponent(change.class_id)}`; }
      payload = { account_id: change.account_id, class_id: change.class_id };
    }
  }
  let response: Response;
  try {
    response = await fetchWithAccountAuth(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    throw new TeacherChangeError("uncertain", "连接中断，无法确认是否已保存。请重新读取核对，勿重复提交。");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw responseError(response, body);
  const schema = change.kind === "status" || change.kind === "reset_password"
    ? z.object({ teacher: teacherSchema, revoked_session_count: z.number().int().nonnegative() })
    : z.object({ teacher: teacherSchema });
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new TeacherChangeError("uncertain", "保存响应无法核对。请重新读取教师名单，勿重复提交。");
  // A reset is corroborated only by its own response; directory re-reads cannot prove a password change.
  const observed = change.kind === "reset_password"
    ? parsed.data.teacher.account_id === change.account_id
    : teacherChangeObserved(change, [parsed.data.teacher]);
  if (!observed) throw new TeacherChangeError("uncertain", "保存响应无法核对。请重新读取教师名单，勿重复提交。");
  return parsed.data;
}

/** An uncertain create or reset keeps no password; rereading never submits the write again. */
export function pendingTeacherChange(change: TeacherChange): PendingTeacherChange {
  if (change.kind === "create") {
    return { kind: "create", username: normalizeUsername(change.username), display_name: change.display_name.trim() };
  }
  if (change.kind === "reset_password") return { kind: "reset_password", account_id: change.account_id };
  return change;
}

export function teacherChangeObserved(change: PendingTeacherChange, teachers: TeacherAccountSummary[]): boolean {
  // The directory never carries password state, so a reset can never be confirmed from it.
  if (change.kind === "reset_password") return false;
  const teacher = teachers.find((entry) => change.kind === "create"
    ? entry.username === normalizeUsername(change.username) && entry.display_name === change.display_name.trim()
    : entry.account_id === change.account_id);
  if (!teacher) return false;
  if (change.kind === "create") return true;
  if (change.kind === "status") return teacher.status === change.status;
  return teacher.class_ids.includes(change.class_id) === (change.kind === "assign");
}

export async function readTeacherDirectory(): Promise<{ teachers: TeacherAccountSummary[]; classes: TeacherClass[] }> {
  const settled = await Promise.allSettled([
    fetchWithAccountAuth("/api/admin/teachers"), fetchWithAccountAuth("/api/classes"),
  ]);
  const responses = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const denied = responses.find((response) => response.status === 401 || response.status === 403);
  if (denied) throw responseError(denied, await denied.json().catch(() => null));
  if (responses.length !== 2) throw new Error("教师或班级资料暂不可读，请稍后重新读取。");
  const bodies: unknown[] = await Promise.all(responses.map((response) => response.json().catch(() => null)));
  if (responses.some((response) => !response.ok)) throw new Error("教师或班级资料暂不可读，请稍后重新读取。读取失败不代表名单为空。");
  const teachers = z.object({ teachers: z.array(teacherSchema) }).safeParse(bodies[0]);
  const classes = z.object({ classes: z.array(classSchema) }).safeParse(bodies[1]);
  if (!teachers.success || !classes.success) throw new Error("教师或班级资料无法核对，请稍后重新读取。");
  return { teachers: teachers.data.teachers, classes: classes.data.classes };
}

export function TeacherManagement({ adminAccountId, initialTeachers, initialClasses }: Props) {
  const { auth, principal, loading: authLoading, revalidate } = useTeacher();
  const identity = authIdentityKey(auth);
  const [directory, setDirectory] = useState({ identity, teachers: initialTeachers, classes: initialClasses });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const [authBlocked, setAuthBlocked] = useState(false);
  const [uncertain, setUncertain] = useState<PendingTeacherChange | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [resetTarget, setResetTarget] = useState<TeacherAccountSummary | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetUncertainId, setResetUncertainId] = useState<string | null>(null);
  const canManage = !authLoading && principal?.role === "admin" && principal.account_status === "active" && principal.account_id === adminAccountId;
  const visible = canManage && !authBlocked && directory.identity === identity;
  const locked = busy || uncertain !== null || !visible;

  useEffect(() => {
    generation.current += 1;
    setConfirmation(null); setCreating(false); setNotice(null);
    setResetTarget(null); setResetPassword(""); setResetUncertainId(null);
  }, [identity]);

  async function reload() {
    if (busyRef.current || !canManage) return;
    busyRef.current = true; setBusy(true);
    const requestGeneration = generation.current;
    try {
      const next = await readTeacherDirectory();
      if (requestGeneration !== generation.current) return;
      setDirectory({ ...next, identity }); setAuthBlocked(false);
      if (uncertain && !teacherChangeObserved(uncertain, next.teachers)) {
        setNotice({ error: true, text: "已重新读取，但当前名单尚不能确认上次变更。请稍后再次读取核对，勿重复提交。" });
      } else if (uncertain) {
        setUncertain(null); setNotice({ error: false, text: "已重新读取并核对当前教师与任教资料。" });
      } else if (resetUncertainId) {
        setNotice({ error: true, text: "已重新读取教师与任教资料；教师名单无法证明密码是否已重置。请与教师核实新密码，或明确再次发起重置（会再次撤销全部会话）。" });
      } else {
        setNotice({ error: false, text: "已重新读取并核对当前教师与任教资料。" });
      }
    } catch (error: unknown) {
      if (requestGeneration !== generation.current) return;
      if (error instanceof TeacherChangeError && error.kind === "auth") {
        setAuthBlocked(true); setDirectory({ identity, teachers: [], classes: [] }); void revalidate();
      }
      setNotice({ error: true, text: error instanceof TeacherChangeError ? error.message : "教师或班级资料暂不可读，请稍后重新读取。读取失败不代表名单为空。" });
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function save(change: TeacherChange) {
    if (busyRef.current || locked) return;
    busyRef.current = true; setBusy(true); setNotice(null);
    const requestGeneration = generation.current;
    try {
      const result = await persistTeacherChange(change);
      if (requestGeneration !== generation.current) return;
      setDirectory((previous) => ({ ...previous, teachers: change.kind === "create"
        ? [...previous.teachers, result.teacher]
        : previous.teachers.map((teacher) => teacher.account_id === result.teacher.account_id ? result.teacher : teacher) }));
      const text = change.kind === "status"
        ? change.status === "disabled" ? `已停用「${result.teacher.display_name}」，撤销 ${result.revoked_session_count} 个登录会话，历史观察保留。`
          : `已启用「${result.teacher.display_name}」。教师需重新登录，按现有任教班级访问资料。`
        : change.kind === "create" ? `已创建「${result.teacher.display_name}」。请在名单中添加任教班级后再开始使用。`
          : change.kind === "assign" ? `已为「${result.teacher.display_name}」添加任教班级。` : `已撤销「${result.teacher.display_name}」的该班级任教，历史记录保留。`;
      setNotice({ error: false, text }); setConfirmation(null);
      if (change.kind === "create") setCreating(false);
    } catch (error: unknown) {
      if (requestGeneration !== generation.current) return;
      setConfirmation(null);
      if (!(error instanceof TeacherChangeError) || error.kind === "uncertain") setUncertain(pendingTeacherChange(change));
      if (error instanceof TeacherChangeError && error.kind === "auth") {
        setAuthBlocked(true); setDirectory({ identity, teachers: [], classes: [] }); setCreating(false); void revalidate();
      }
      setNotice({ error: true, text: error instanceof TeacherChangeError ? error.message : "请求结果待核对，请重新读取教师名单，勿重复提交。" });
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function saveReset() {
    const target = resetTarget;
    if (busyRef.current || !visible || !target || resetPassword.length < PASSWORD_MIN_LENGTH) return;
    const submitted = resetPassword;
    // The password lives only in this closure and is cleared from state before the request resolves.
    setResetPassword("");
    setResetTarget(null);
    busyRef.current = true; setBusy(true); setNotice(null);
    const requestGeneration = generation.current;
    try {
      const result = await persistTeacherChange({ kind: "reset_password", account_id: target.account_id, new_password: submitted });
      if (requestGeneration !== generation.current) return;
      setDirectory((previous) => ({ ...previous, teachers: previous.teachers.map((teacher) =>
        teacher.account_id === result.teacher.account_id ? result.teacher : teacher) }));
      setResetUncertainId(null);
      setNotice({ error: false, text: `已重置「${result.teacher.display_name}」的登录密码，并撤销 ${result.revoked_session_count} 个登录会话。教师需用新密码重新登录；本页不会展示或保留密码。` });
    } catch (error: unknown) {
      if (requestGeneration !== generation.current) return;
      if (error instanceof TeacherChangeError && error.kind === "auth") {
        setAuthBlocked(true); setDirectory({ identity, teachers: [], classes: [] }); void revalidate();
        setNotice({ error: true, text: error.message });
      } else if (!(error instanceof TeacherChangeError) || error.kind === "uncertain") {
        setResetUncertainId(target.account_id);
        setNotice({ error: true, text: "重置结果待核对：响应不可用，无法确认密码是否已重置；教师名单也无法证明。请与教师核实，或明确再次发起重置（会再次撤销全部会话）。" });
      } else {
        setNotice({ error: true, text: error.message });
      }
    } finally {
      busyRef.current = false; setBusy(false); setResetPassword("");
    }
  }

  function createTeacher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const username = normalizeUsername(String(fields.get("username") ?? ""));
    const displayName = String(fields.get("display_name") ?? "").trim();
    const password = fields.get("initial_password");
    fields.delete("initial_password");
    const input = form.elements.namedItem("initial_password");
    if (input instanceof HTMLInputElement) input.value = "";
    if (!isValidNormalizedUsername(username) || !displayName || displayName.length > 50 || typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
      setNotice({ error: true, text: `请填写有效用户名、教师姓名和至少 ${PASSWORD_MIN_LENGTH} 个字符的初始密码。` }); return;
    }
    void save({ kind: "create", username, display_name: displayName, initial_password: password });
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-8 [&_button]:max-w-full">
      <Button asChild variant="ghost" className="-ml-3 min-h-11"><Link href="/"><ArrowLeft aria-hidden="true" />返回首页</Link></Button>
      <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold sm:text-3xl">教师管理</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">为教师建立账号，添加任教班级，或重置登录密码；每次操作逐条保存，成功后即生效。</p>
        </div>
        <Button disabled={locked} className="min-h-11 self-start" onClick={() => setCreating(!creating)} aria-expanded={creating} aria-controls="create-teacher">
          <Plus aria-hidden="true" />{creating ? "收起新增表单" : "添加教师"}
        </Button>
      </header>
      {notice && directory.identity === identity ? <Alert variant={notice.error ? "destructive" : "default"} role={notice.error ? "alert" : "status"}>
        <AlertTitle>{notice.error ? uncertain || resetUncertainId ? "结果待核对" : "操作暂未完成" : "资料已更新"}</AlertTitle>
        <AlertDescription className="[overflow-wrap:anywhere]">{notice.text}</AlertDescription>
      </Alert> : null}
      {busy ? <p role="status" className="text-sm text-primary">正在处理本次请求，请稍候…</p> : null}
      {!visible ? <Alert><AlertTitle>管理员资料暂不可显示</AlertTitle><AlertDescription>
        当前登录、权限或账号范围已变化。请重新读取；需要登录时请使用管理员账号。
        <Button asChild variant="link" className="mt-2 min-h-11 px-0"><Link href="/login?returnTo=%2Fadmin%2Fteachers">管理员登录</Link></Button>
      </AlertDescription></Alert> : null}
      {creating && visible ? <section id="create-teacher" className="rounded-xl border bg-background p-5 sm:p-6" aria-labelledby="create-teacher-title">
        <h2 id="create-teacher-title" className="text-lg font-semibold">添加教师账号</h2>
        <p id="password-help" className="mt-2 text-sm leading-6 text-muted-foreground">初始密码至少 {PASSWORD_MIN_LENGTH} 个字符，提交后输入框会清空。请通过可信渠道交给本人；本页不会展示或保留密码。</p>
        <form className="mt-5 space-y-5" onSubmit={createTeacher}>
          <fieldset disabled={locked} className="grid min-w-0 gap-5 sm:grid-cols-2">
            <div className="min-w-0 space-y-2"><Label htmlFor="teacher-display-name">教师姓名</Label><Input id="teacher-display-name" name="display_name" required maxLength={50} className="min-h-11" autoComplete="off" /></div>
            <div className="min-w-0 space-y-2"><Label htmlFor="teacher-username">登录用户名</Label><Input id="teacher-username" name="username" required maxLength={64} className="min-h-11" autoComplete="off" aria-describedby="username-help" /><p id="username-help" className="text-sm leading-6 text-muted-foreground">用户名不区分大小写，同一用户名只能创建一次。</p></div>
            <div className="min-w-0 space-y-2 sm:col-span-2"><Label htmlFor="teacher-password">初始密码</Label><Input id="teacher-password" name="initial_password" type="password" required minLength={PASSWORD_MIN_LENGTH} className="min-h-11 sm:max-w-md" autoComplete="new-password" aria-describedby="password-help" /></div>
          </fieldset>
          <div className="flex flex-wrap gap-3"><Button type="submit" disabled={locked} className="min-h-11">创建教师账号</Button><Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => setCreating(false)}>取消</Button></div>
        </form>
      </section> : null}
      <section aria-labelledby="teacher-list-title" aria-busy={busy}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 ref={listHeading} tabIndex={-1} id="teacher-list-title" className="text-lg font-semibold">教师与任教班级{visible ? <span className="ml-2 text-sm font-normal text-muted-foreground">{directory.teachers.length} 位</span> : null}</h2>
          <Button variant="outline" className="min-h-11" onClick={() => void reload()} disabled={busy || !canManage}><RefreshCw aria-hidden="true" />重新读取名单</Button>
        </div>
        {visible ? directory.teachers.length === 0 ? <p className="border-y py-8 text-sm leading-6 text-muted-foreground">还没有教师账号。添加教师后，再为其分配任教班级。</p>
          : <div className="divide-y border-y">{directory.teachers.map((teacher) => <TeacherRow key={teacher.account_id} teacher={teacher} classes={directory.classes} locked={locked}
            resetUncertain={resetUncertainId === teacher.account_id}
            onReset={() => { setResetPassword(""); setResetTarget(teacher); }}
            onAssign={(classId) => save({ kind: "assign", account_id: teacher.account_id, class_id: classId })}
            onConfirm={(action) => {
              returnFocus.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
              setConfirmation({ teacher, ...action });
            }} />)}</div> : null}
      </section>
      <AlertDialog open={visible && resetTarget !== null} onOpenChange={(open) => { if (!open && !busy) { setResetTarget(null); setResetPassword(""); } }}>
        <AlertDialogContent className="[overflow-wrap:anywhere]">
          <AlertDialogHeader>
            <AlertDialogTitle>重置「{resetTarget?.display_name}」的登录密码？</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">
              提交后立即撤销该教师的全部登录会话，教师需用新密码重新登录；任教关系与历史观察保留。
              密码只用于本次提交，不显示、不写入浏览器存储。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="teacher-reset-password">为 {resetTarget?.username} 设置新密码</Label>
            <Input id="teacher-reset-password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH}
              className="min-h-11" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
            <p className="text-sm leading-6 text-muted-foreground">至少 {PASSWORD_MIN_LENGTH} 个字符；首尾空格不会被去除（与登录一致）。</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11" disabled={busy}>取消</AlertDialogCancel>
            <Button className="min-h-11" disabled={busy || resetPassword.length < PASSWORD_MIN_LENGTH} onClick={() => void saveReset()}>
              {busy ? "正在重置…" : "确认重置密码"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={visible && confirmation !== null} onOpenChange={(open) => { if (!open && !busy) setConfirmation(null); }}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto [overflow-wrap:anywhere]" onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocus.current?.isConnected ? returnFocus.current : listHeading.current;
          target?.focus();
        }}>
          <AlertDialogHeader><AlertDialogTitle>{confirmation?.kind === "remove" ? "撤销任教班级？" : confirmation?.status === "disabled" ? "停用教师账号？" : "启用教师账号？"}</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">{confirmation?.kind === "remove"
              ? `撤销「${confirmation.teacher.display_name}」在「${confirmation.class_name}」的任教，将取消该班级的业务访问权限。历史观察、作者与幼儿归属保留。${confirmation.teacher.class_ids.length === 1 ? "这是最后一个任教班级，撤销后即使可登录也不能访问业务资料。" : "其他任教班级不受影响。"}`
              : confirmation?.status === "disabled" ? `停用「${confirmation.teacher.display_name}」后将立即撤销全部登录会话，教师不能继续登录或处理观察。任教关系与历史观察保留；再次启用后需重新登录。`
                : `启用「${confirmation?.teacher.display_name ?? ""}」后，教师需重新登录。${confirmation?.teacher.class_ids.length ? "只可访问现有任教班级范围，已撤销的登录会话不会恢复。" : "尚未分配任教班级，可登录但不能访问业务资料。"}`}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel className="min-h-11" disabled={busy}>取消</AlertDialogCancel>
            <Button className="min-h-11" variant={confirmation?.kind === "remove" || confirmation?.status === "disabled" ? "destructive" : "default"} disabled={locked} onClick={() => {
              if (!confirmation) return;
              void save(confirmation.kind === "remove" ? { kind: "remove", account_id: confirmation.teacher.account_id, class_id: confirmation.class_id }
                : { kind: "status", account_id: confirmation.teacher.account_id, status: confirmation.status });
            }}>{busy ? "正在保存…" : confirmation?.kind === "remove" ? "确认撤销任教" : confirmation?.status === "disabled" ? "确认停用" : "确认启用"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TeacherRow({ teacher, classes, locked, resetUncertain, onReset, onAssign, onConfirm }: {
  teacher: TeacherAccountSummary; classes: TeacherClass[]; locked: boolean; resetUncertain: boolean;
  onReset: () => void;
  onAssign: (classId: string) => Promise<void>;
  onConfirm: (action: { kind: "status"; status: AccountStatus } | { kind: "remove"; class_id: string; class_name: string }) => void;
}) {
  const [selected, setSelected] = useState("");
  const available = classes.filter((entry) => !teacher.class_ids.includes(entry.id));
  const chosen = available.find((entry) => entry.id === selected);
  return (
    <article className="grid min-w-0 gap-5 py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]" aria-labelledby={`teacher-${teacher.account_id}`}>
      <div className="min-w-0 space-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2"><h3 id={`teacher-${teacher.account_id}`} className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{teacher.display_name}</h3><Badge variant={teacher.status === "active" ? "secondary" : "outline"}>{teacher.status === "active" ? "已启用" : "已停用"}</Badge></div>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">用户名：{teacher.username}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={locked} className="min-h-11" aria-label={`重置教师${teacher.display_name}的密码`} onClick={onReset}>重置密码</Button>
          <Button variant="outline" disabled={locked} className="min-h-11" aria-label={`${teacher.status === "active" ? "停用" : "启用"}教师${teacher.display_name}`} onClick={() => onConfirm({ kind: "status", status: teacher.status === "active" ? "disabled" : "active" })}>{teacher.status === "active" ? "停用账号" : "启用账号"}</Button>
        </div>
        {resetUncertain ? <p role="status" className="text-sm leading-6 text-amber-700 [overflow-wrap:anywhere]">上次密码重置结果待核对：教师名单无法证明是否已重置。请与教师核实，或明确再次重置。</p> : null}
      </div>
      <div className="min-w-0 space-y-4">
        {teacher.class_ids.length ? <ul className="space-y-2" aria-label={`${teacher.display_name}的任教班级`}>{teacher.class_ids.map((classId) => {
          const klass = classes.find((entry) => entry.id === classId);
          const className = klass?.name ?? "班级名称暂不可读";
          return <li key={classId} className="flex min-w-0 flex-col gap-2 border-b pb-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0"><p className="text-sm font-medium [overflow-wrap:anywhere]">{className}</p>{klass ? <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{CLASS_STAGE_LABELS[klass.stage]} · {klass.school_year}{klass.is_active ? "" : " · 班级已停用"}</p> : null}</div>
            <Button variant="ghost" className="min-h-11 self-start sm:self-auto" disabled={locked} aria-label={`撤销${teacher.display_name}在${className}的任教`} onClick={() => onConfirm({ kind: "remove", class_id: classId, class_name: className })}>撤销任教</Button>
          </li>;
        })}</ul> : <p className="text-sm leading-6 text-muted-foreground">尚未分配任教班级。{teacher.status === "active" ? "可登录，但不能访问业务资料。" : "账号仍处于停用状态。"}</p>}
        {available.length ? <div className="min-w-0 space-y-2"><Label htmlFor={`assign-${teacher.account_id}`}>添加任教班级</Label>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
            <Select value={chosen ? selected : ""} onValueChange={setSelected} disabled={locked}>
              <SelectTrigger id={`assign-${teacher.account_id}`} className="data-[size=default]:h-auto min-h-11 w-full min-w-0 flex-1 [&_[data-slot=select-value]]:block [&_[data-slot=select-value]]:line-clamp-none [&_[data-slot=select-value]]:whitespace-normal [&_[data-slot=select-value]]:[overflow-wrap:anywhere]"><SelectValue placeholder="选择一个班级" /></SelectTrigger>
              <SelectContent position="popper" align="start" className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] [&_[data-slot=select-scroll-up-button]]:min-h-11 [&_[data-slot=select-scroll-down-button]]:min-h-11">{available.map((klass) => <SelectItem key={klass.id} value={klass.id} className="min-h-11 whitespace-normal [overflow-wrap:anywhere]">{klass.name} · {CLASS_STAGE_LABELS[klass.stage]} · {klass.school_year}{klass.is_active ? "" : "（班级已停用）"}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="outline" className="min-h-11 self-start" disabled={locked || !chosen} onClick={() => { if (chosen) void onAssign(chosen.id); }}>确认添加</Button>
          </div>
          {teacher.status === "disabled" ? <p className="text-sm leading-6 text-muted-foreground">任教关系可保存，教师启用账号后才可访问班级。</p> : null}
        </div> : <p className="text-sm leading-6 text-muted-foreground">{classes.length ? "已分配全部现有班级。" : "暂无可分配班级，请先在班级页建立班级。"}</p>}
      </div>
    </article>
  );
}
