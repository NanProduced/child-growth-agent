"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Copy, FileText, Info, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTeacher } from "@/components/teacher-provider";
import { authIdentityKey, fetchWithAccountAuth } from "@/lib/accounts/client";
import { formatDateCn } from "@/lib/format";
import { CONFIGURED_SEMESTERS } from "@/lib/semester/config";
import {
  MAX_COMMUNICATION_SOURCES, communicationViewSchema, communicationWorkspaceSchema,
  previousCommunicationMonth, type CommunicationPeriod, type CommunicationView, type CommunicationWorkspace,
} from "@/lib/family-communication-contract";
import styles from "./workspace.module.css";

type ChildOption = { id: string; name: string; class_name: string; birth_date: string };
class CommunicationHttpError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}
function periodQuery(child: string, period: CommunicationPeriod): string {
  return new URLSearchParams({ child_id: child, kind: period.kind, ...("value" in period ? { value: period.value } : {}) }).toString();
}
async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
      ? body.message : "读取或保存暂未完成，请重新核验。";
    throw new CommunicationHttpError(message, response.status);
  }
  return body;
}
function parseView(body: unknown): CommunicationView | null {
  if (!body || typeof body !== "object" || !("communication" in body)) throw new Error("草稿响应无法核对。 ");
  return body.communication === null ? null : communicationViewSchema.parse(body.communication);
}

export function FamilyCommunicationWorkspace({ today, initialChildId, initialPeriod, childrenList }: {
  today: string; initialChildId: string; initialPeriod: CommunicationPeriod; childrenList: ChildOption[];
}) {
  const { auth, isTeacher, revalidate } = useTeacher();
  const identity = authIdentityKey(auth);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const owner = auth.state.kind === "authenticated" ? auth.state.principal.account_id : "";
  const [childId, setChildId] = useState(initialChildId);
  const [period, setPeriod] = useState<CommunicationPeriod>(initialPeriod);
  const [workspace, setWorkspace] = useState<CommunicationWorkspace | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [draft, setDraft] = useState<CommunicationView | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"generate" | "save" | "review" | "lookup" | null>(null);
  const [uncertain, setUncertain] = useState<string | null>(null);
  const [lookupEdit, setLookupEdit] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showMobileSources, setShowMobileSources] = useState(false);
  const generation = useRef(0);
  const writeBusy = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const dirty = Boolean(draft && text !== draft.text);
  const positiveNotice = /^(分享草稿已保存|已复制核对|修改已保存|已读取原草稿)/.test(notice);
  const key = `${identity}:${childId}:${JSON.stringify(period)}`;
  const viewKey = useRef(key);
  viewKey.current = key;
  const canWrite = isTeacher && loadState === "ready" && !busy && !uncertain;
  const sourceSelectionChanged = Boolean(draft && JSON.stringify([...selected].sort()) !== JSON.stringify([...draft.source_ids].sort()));
  const noteChanged = Boolean(draft && note !== draft.note);
  const currentDraft = Boolean(draft && ["draft", "reviewed"].includes(draft.status) && !sourceSelectionChanged && !noteChanged);

  const load = useCallback(async (signal?: AbortSignal) => {
    const ticket = ++generation.current;
    const currentIdentity = identity;
    setLoadState("loading"); setWorkspace(null); setDraft(null); setText(""); setNote(""); setNotice(""); setUncertain(null); setLookupEdit(null);
    if (!childId) { setLoadState("ready"); return; }
    try {
      const response = await fetchWithAccountAuth(`/api/family-communications?${periodQuery(childId, period)}`, { signal });
      if ([401, 403, 503].includes(response.status)) void revalidate();
      const data = communicationWorkspaceSchema.parse(await responseBody(response));
      if (signal?.aborted || ticket !== generation.current || identityRef.current !== currentIdentity) return;
      if (data.child.id !== childId || (data.communication && data.communication.owner_account_id !== owner)) throw new Error("草稿对象或账号无法核对。 ");
      setWorkspace(data); setLoadState("ready"); setDraft(data.communication);
      const previous = data.communication;
      setSelected(previous && previous.status !== "stale" ? previous.source_ids : data.sources.length <= MAX_COMMUNICATION_SOURCES ? data.sources.map((item) => item.id) : []);
      setText(previous?.text ?? ""); setNote(previous?.note ?? ""); setShowAll(false);
      if (previous?.status === "generating") { setUncertain(previous.client_request_id); setNotice("原请求还在处理中，请核验它的结果，不要重复生成。 "); }
      else if (previous?.status === "stale") setNotice("这份草稿的班级或依据已变化，请重新选择记录并生成。 ");
    } catch (error) {
      if (signal?.aborted || ticket !== generation.current || identityRef.current !== currentIdentity) return;
      setLoadState("error"); setNotice(error instanceof Error ? error.message : "记录暂未读取，请重新尝试。 ");
    }
  }, [childId, period, identity, owner, revalidate]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => { controller.abort(); generation.current++; }; }, [load]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (childId) url.searchParams.set("child", childId);
    url.searchParams.set("kind", period.kind);
    if ("value" in period) url.searchParams.set("value", period.value); else url.searchParams.delete("value");
    window.history.replaceState(null, "", url);
  }, [childId, period]);
  useEffect(() => {
    if (!dirty && !noteChanged && !(note && !draft)) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty, noteChanged, note, draft]);

  function mayLeave(): boolean { return (!dirty && !noteChanged && !(!draft && note)) || window.confirm("还有未保存的修改。要放弃这些修改并切换吗？"); }
  function acceptView(next: CommunicationView, currentKey: string): boolean {
    if (viewKey.current !== currentKey) return false;
    if (next.owner_account_id !== owner || next.child_id !== childId) throw new Error("返回的草稿不属于当前账号或幼儿。 ");
    setDraft(next); setText(next.text); setNote(next.note); setSelected(next.source_ids);
    return true;
  }
  function rememberRequest(requestId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("child", childId); url.searchParams.set("draft_request", requestId);
    window.history.replaceState(null, "", url);
  }
  async function generate() {
    if (!canWrite || writeBusy.current || !selected.length || selected.length > MAX_COMMUNICATION_SOURCES) return;
    if (dirty && !window.confirm("编辑区还有未保存的修改。要生成新草稿替换它吗？")) return;
    const requestId = crypto.randomUUID();
    const currentKey = key;
    writeBusy.current = true; setBusy("generate"); setNotice(""); rememberRequest(requestId);
    try {
      const response = await fetchWithAccountAuth("/api/family-communications", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_request_id: requestId, child_id: childId, period, observation_ids: selected, note }) });
      const next = parseView(await responseBody(response));
      if (!next || next.client_request_id !== requestId || JSON.stringify(next.period) !== JSON.stringify(period) || next.note !== note.trim() ||
        JSON.stringify([...next.source_ids].sort()) !== JSON.stringify([...selected].sort())) throw new Error("生成响应无法核对。 ");
      if (!acceptView(next, currentKey)) return;
      if (next.status === "generating") { setUncertain(requestId); setNotice("原请求还在处理中，请核验结果。 "); }
      else if (next.status === "draft") { setUncertain(null); setNotice("分享草稿已保存，请核对事实和称呼。 "); }
      else throw new Error("原请求尚未返回可编辑草稿，请核验结果。 ");
    } catch (error) {
      if (viewKey.current !== currentKey) return;
      setUncertain(requestId); setNotice(`${error instanceof Error ? error.message : "生成连接中断。"} 请只核验原请求，已有文字仍保留。`);
    } finally { writeBusy.current = false; if (viewKey.current === currentKey) setBusy(null); }
  }
  async function lookupOriginal() {
    if (!uncertain || writeBusy.current) return;
    const requestId = uncertain, currentKey = key;
    setBusy("lookup"); setNotice("");
    try {
      const next = parseView(await responseBody(await fetchWithAccountAuth(`/api/family-communications?${new URLSearchParams({ client_request_id: requestId })}`)));
      if (viewKey.current !== currentKey) return;
      if (!next) { setNotice("尚未查到原请求的结果，请稍后再核验。不会重复生成。 "); return; }
      if (next.client_request_id !== requestId || next.owner_account_id !== owner || next.child_id !== childId) throw new Error("原请求身份无法核对。 ");
      if (next.status === "generating") { setNotice("原请求仍在处理中，暂时不能再次生成或复制。 "); return; }
      if (lookupEdit !== null && next.text !== lookupEdit) {
        setNotice("当前保存的文字与刚才的修改不同，你的输入还保留着。请重新读取后对照，不能认定刚才的修改已保存。 ");
        return;
      }
      if (next.status === "failed") { setUncertain(null); if (draft?.status === "generating") await load(); setNotice("原请求明确没有生成可用草稿。可以重新生成；原有草稿未被覆盖。 "); }
      else if (acceptView(next, currentKey)) { setUncertain(null); setLookupEdit(null); setNotice(next.status === "stale" ? "原依据已变化，请重新生成。" : "已读取原草稿的保存结果，请核对后复制。 "); }
    } catch (error) { if (viewKey.current === currentKey) setNotice(error instanceof Error ? error.message : "原请求暂时无法核验。 "); }
    finally { if (viewKey.current === currentKey) setBusy(null); }
  }
  async function save(action: "save" | "review") {
    if (!draft || !currentDraft || !canWrite || writeBusy.current || text.trim().length < 30) return;
    const currentKey = key, copyText = text.trim();
    writeBusy.current = true; setBusy(action); setNotice("");
    let confirmed = false;
    try {
      const response = await fetchWithAccountAuth(`/api/family-communications/${encodeURIComponent(draft.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_revision: draft.revision, action, text: copyText }),
      });
      const next = parseView(await responseBody(response));
      if (!next || next.id !== draft.id || next.client_request_id !== draft.client_request_id || next.text !== copyText ||
          (action === "review" && next.status !== "reviewed") || (action === "save" && next.status !== "draft") ||
          next.revision !== draft.revision + 1) throw new Error("保存结果无法核对。 ");
      if (!acceptView(next, currentKey)) return;
      confirmed = true;
      if (action === "review") {
        await navigator.clipboard.writeText(next.text);
        if (viewKey.current === currentKey) setNotice("已复制核对后的文字。请自行发送给家长。 ");
      } else setNotice("修改已保存。 ");
    } catch (error) {
      if (viewKey.current !== currentKey) return;
      if (confirmed) {
        editor.current?.focus(); editor.current?.select();
        setNotice("文字已保存并核对，但浏览器没有允许复制。请复制编辑框里的文字。 ");
      } else if (error instanceof CommunicationHttpError && [400, 401, 403, 409, 422].includes(error.status)) {
        setNotice(`${error.message} 本次修改未保存，你的输入仍保留。`);
      } else {
        setUncertain(draft.client_request_id); setLookupEdit(copyText);
        setNotice(`${error instanceof Error ? error.message : "保存连接中断。"} 你的输入还保留着，请先核验保存结果，不重复提交。`);
      }
    } finally { writeBusy.current = false; if (viewKey.current === currentKey) setBusy(null); }
  }

  const visibleSources = showAll ? workspace?.sources ?? [] : (workspace?.sources ?? []).slice(0, 3);
  const selectedCount = selected.length;
  return (
    <div className={styles.page} data-platform-surface="family-communication">
      <Link href="/children" className={styles.back}><ArrowLeft size={17} aria-hidden="true" />返回成长档案</Link>
      <header className={styles.heading}><h1>家园沟通</h1><p>把日常观察，写成给家长的成长分享。</p></header>
      <section className={styles.filters} aria-label="选择幼儿和时间">
        <div className={styles["child-field"]}><Label htmlFor="communication-child">选择幼儿</Label>
          <Select value={childId} onValueChange={(value) => { if (mayLeave()) { setBusy(null); setChildId(value); } }} disabled={Boolean(busy)}>
            <SelectTrigger id="communication-child"><SelectValue placeholder="选择一名幼儿" /></SelectTrigger>
            <SelectContent>{childrenList.map((child) => <SelectItem key={child.id} value={child.id}>{child.name} · {child.class_name}{childrenList.some((other) => other.id !== child.id && other.name === child.name && other.class_name === child.class_name) ? ` · ${formatDateCn(child.birth_date)}出生` : ""}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className={styles["period-field"]}><Label>选择时间段</Label>
          <div className={styles["period-controls"]}><div className={styles.segments} role="group" aria-label="时间范围类型">
            {([ ["month", "按月"], ["semester", "学期"], ["year", "近一年"] ] as const).map(([kind, label]) => <Button key={kind} variant="ghost" aria-pressed={period.kind === kind} disabled={Boolean(busy)}
              onClick={() => { if (!mayLeave()) return; setPeriod(kind === "month" ? { kind, value: previousCommunicationMonth(today) } : kind === "semester" ?
                { kind, value: CONFIGURED_SEMESTERS.find((item) => item.start_date <= today && item.end_date >= today)?.id ?? CONFIGURED_SEMESTERS[0].id } : { kind }); }}>{label}</Button>)}
          </div>
          {period.kind === "month" ? <input type="month" aria-label="选择月份" className={styles.month} value={period.value} min="2020-01" max={today.slice(0, 7)} disabled={Boolean(busy)}
            onChange={(event) => { if (event.target.value && mayLeave()) setPeriod({ kind: "month", value: event.target.value }); }} /> : period.kind === "semester" ?
            <Select value={period.value} disabled={Boolean(busy)} onValueChange={(value) => { if (mayLeave()) setPeriod({ kind: "semester", value }); }}>
              <SelectTrigger aria-label="选择学期"><SelectValue /></SelectTrigger><SelectContent>{CONFIGURED_SEMESTERS.filter((item) => item.start_date <= today).map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
            </Select> : null}
          </div>
        </div>
        <div className={styles.range}>{workspace ? <><span>{formatDateCn(workspace.range.from)} — {formatDateCn(workspace.range.to)}</span><span>已选择 <strong>{selectedCount}</strong> 条观察 · 共 {workspace.sources.length} 条已确认记录</span></> : <span>{loadState === "loading" ? "正在读取记录…" : "时间范围尚未读取"}</span>}</div>
      </section>
      {notice ? <div className={styles.notice} data-tone={positiveNotice ? "success" : "attention"} role={positiveNotice ? "status" : "alert"}><span className={styles["notice-copy"]}>{positiveNotice ? <Check size={17} aria-hidden="true" /> : <Info size={17} aria-hidden="true" />}{notice}</span>{uncertain ? <Button variant="outline" disabled={Boolean(busy)} onClick={() => { void lookupOriginal(); }}><RefreshCw size={16} aria-hidden="true" />核验原请求</Button> : dirty ? <Button variant="outline" disabled={Boolean(busy)} onClick={() => { if (mayLeave()) void load(); }}>重新读取草稿</Button> : null}</div> : null}
      {!isTeacher ? <p className={styles["read-only"]}>管理员可以查阅观察；生成、编辑和核对分享由负责班级的教师完成。</p> : null}
      <div className={styles.workspace}>
        <section className={styles.sources} aria-labelledby="communication-sources">
          <div className={styles["source-heading"]}><h2 id="communication-sources">这段时间的小故事</h2><span>{loadState === "ready" ? `${selectedCount} 条已选` : ""}</span>
            <Button variant="ghost" className={styles["mobile-sources-toggle"]} aria-expanded={showMobileSources} aria-controls="communication-source-list" onClick={() => setShowMobileSources(!showMobileSources)}>{showMobileSources ? "收起" : "查看观察"}<ChevronDown size={16} aria-hidden="true" /></Button>
          </div>
          <div id="communication-source-list" className={styles["source-content"]} data-expanded={showMobileSources || loadState !== "ready" || !workspace?.sources.length}>
          {loadState === "loading" ? <div className={styles.empty} role="status"><LoaderCircle className={styles.spinner} size={22} />正在读取已确认观察…</div> : loadState === "error" ? <div className={styles.empty}><p>记录暂未读取</p><Button variant="outline" onClick={() => { void load(); }}>重新读取</Button></div> : !workspace?.sources.length ?
            <div className={styles.empty}><FileText size={25} aria-hidden="true" /><p>{childId ? "这段时间还没有已确认的观察" : childrenList.length ? "先选择一名幼儿" : "还没有可选择的成长档案"}</p><span>{childId ? "换一个时间段，或先确认一条观察。" : "选择后，会读取这名幼儿的已确认观察。"}</span>{isTeacher && childId ? <Button asChild variant="outline"><Link href={`/observations?child_id=${encodeURIComponent(childId)}`}>查看观察记录</Link></Button> : null}</div> : <>
              <ul className={styles["source-list"]}>{visibleSources.map((source) => <li key={source.id}>
                <label className={styles["source-check"]} htmlFor={`source-${source.id}`}><Checkbox id={`source-${source.id}`} checked={selected.includes(source.id)} disabled={!canWrite}
                  onCheckedChange={(checked) => { setNotice(""); setSelected((previous) => checked ? [...previous, source.id] : previous.filter((id) => id !== source.id)); }} /><span className="sr-only">选择{formatDateCn(source.observed_at)}的{source.context}记录</span></label>
                <div className={styles["source-body"]}><div className={styles["source-meta"]}><span>{formatDateCn(source.observed_at)} · {source.context}</span></div><p>{source.raw_text}</p><Link href={`/observations/${encodeURIComponent(source.id)}/review`} target="_blank" rel="noreferrer">查看原记录<span className="sr-only">（新标签页）</span></Link></div>
              </li>)}</ul>
              {workspace.sources.length > 3 ? <Button variant="ghost" className={styles["show-all"]} aria-expanded={showAll} aria-controls="communication-source-list" onClick={() => setShowAll(!showAll)}><ChevronDown size={17} aria-hidden="true" />{showAll ? "收起记录" : `展开另外 ${workspace.sources.length - 3} 条`}</Button> : null}
              {workspace.sources.length > MAX_COMMUNICATION_SOURCES ? <p className={styles.limit}>一次最多选 {MAX_COMMUNICATION_SOURCES} 条，选几个想分享的关键事例即可。</p> : null}
            </>}
          </div>
        </section>
        <section className={styles["editor-panel"]} aria-labelledby="communication-draft">
          <div className={styles["editor-heading"]}><FileText size={23} aria-hidden="true" /><h2 id="communication-draft">给家长的分享</h2><span className={styles.status}>{!isTeacher ? "只读" : dirty ? "修改未保存" : draft?.status === "failed" ? "生成未完成" : draft?.status === "reviewed" ? "已核对" : draft?.status === "generating" || busy === "generate" ? "生成中" : "草稿 · 未核对"}</span></div>
          <p className={styles["editor-help"]}>{!isTeacher ? "分享由负责班级的教师生成和核对。" : draft?.status === "stale" ? "原依据已变化，重新生成后再核对。" : "先核对事实和称呼，再复制给家长。"}</p>
          <Label className="sr-only" htmlFor="parent-sharing-text">给家长的分享文字</Label>
          {draft ? <Textarea ref={editor} id="parent-sharing-text" className={styles.editor} value={text} maxLength={5000} readOnly={!isTeacher || Boolean(busy) || Boolean(uncertain) || !currentDraft}
            onChange={(event) => { setText(event.target.value); setNotice(""); }} placeholder="选择观察记录，生成后可以在这里修改。" /> :
            <div className={styles.prepare}><p>{!isTeacher ? "可在左侧查阅已确认的观察。" : selectedCount ? `用选好的 ${selectedCount} 条观察，写一段给家长的分享。` : "先选一名幼儿和想分享的观察记录。"}</p>{isTeacher ? <span>生成后可以修改文字，再核对并复制。</span> : null}
              {isTeacher ? <Button className={styles.primary} onClick={() => { void generate(); }} disabled={!canWrite || !selectedCount || selectedCount > MAX_COMMUNICATION_SOURCES}>{busy === "generate" ? <><LoaderCircle className={styles.spinner} size={17} />正在生成…</> : "生成分享草稿"}</Button> : null}
            </div>}
          <details className={styles.note}><summary>补充想告诉家长的话<span>可选</span><ChevronDown size={17} aria-hidden="true" /></summary><Label htmlFor="communication-note" className="sr-only">补充想告诉家长的话</Label>
            <Textarea id="communication-note" value={note} maxLength={800} disabled={!canWrite} onChange={(event) => setNote(event.target.value)} placeholder="例如：这次想多分享孩子在积木区的尝试。" /><p>补充内容用于沟通重点，不会写回原始观察。</p></details>
          {sourceSelectionChanged || noteChanged ? <p className={styles.changed}>选择或补充内容已变，请重新生成；原草稿不会被覆盖。</p> : null}
          <div className={styles.actions}>
            {isTeacher && draft ? <><Button variant="outline" onClick={() => { void generate(); }} disabled={!canWrite || !selectedCount || selectedCount > MAX_COMMUNICATION_SOURCES}><RefreshCw size={17} className={busy === "generate" ? styles.spinner : undefined} aria-hidden="true" />{busy === "generate" ? "正在生成…" : "重新生成"}</Button>
              <div className={styles["save-actions"]}>{dirty ? <Button variant="outline" disabled={!canWrite || !currentDraft} onClick={() => { void save("save"); }}><Save size={16} aria-hidden="true" />保存修改</Button> : null}
                <Button className={styles.primary} disabled={!canWrite || !currentDraft || text.trim().length < 30} onClick={() => { void save("review"); }}><Copy size={17} aria-hidden="true" />{busy === "review" ? "正在保存…" : "我已核对，复制文字"}</Button></div></> : null}
          </div>
          {draft?.status === "reviewed" && !dirty ? <p className={styles.saved}><Check size={15} aria-hidden="true" />文字已核对，可自行发给家长。</p> : null}
          {draft ? <p className={styles.saved}>草稿仅当前账号可见 · 观察期间：{formatDateCn(draft.range.from)} — {formatDateCn(draft.range.to)}</p> : null}
        </section>
      </div>
    </div>
  );
}
