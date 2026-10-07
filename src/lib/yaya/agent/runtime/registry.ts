/**
 * 芽芽运行进程内注册表（AGENT-APP1）。
 *
 * 只管理**本进程**正在派发的 run 的 AbortController：取消请求到达本进程时用于
 * 停止后续派发/消费。它不是恢复存储，也不冒充跨进程状态：
 * - 跨进程查询只能通过 run 持久化记录（store.ts）读取真实状态；
 * - 进程重启后注册表为空，活跃 run 由查询侧如实判为不可核验，绝不自动重跑。
 */
import { randomUUID } from 'node:crypto';

export interface YayaRunProcessEntry {
  run_id: string;
  controller: AbortController;
}

const PROCESS_INSTANCE_ID = randomUUID();
const activeRuns = new Map<string, YayaRunProcessEntry>();

/** 本进程实例标识：写入 run 记录，供跨进程查询判断活跃派发者是否可核验 */
export function getYayaRunProcessInstanceId(): string {
  return PROCESS_INSTANCE_ID;
}

export function registerYayaRunProcess(runId: string): YayaRunProcessEntry {
  activeRuns.get(runId)?.controller.abort();
  const entry: YayaRunProcessEntry = { run_id: runId, controller: new AbortController() };
  activeRuns.set(runId, entry);
  return entry;
}

export function unregisterYayaRunProcess(runId: string, entry?: YayaRunProcessEntry): void {
  const current = activeRuns.get(runId);
  if (current === undefined) return;
  if (entry !== undefined && current !== entry) return;
  activeRuns.delete(runId);
}

export function hasYayaRunProcess(runId: string): boolean {
  return activeRuns.has(runId);
}

/** 只 abort 本进程持有的控制器；不存在则静默（跨进程取消由 owner 进程在边界观察到） */
export function abortYayaRunProcess(runId: string): boolean {
  const entry = activeRuns.get(runId);
  if (entry === undefined) return false;
  entry.controller.abort();
  return true;
}
