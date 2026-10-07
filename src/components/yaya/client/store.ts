/**
 * UI1 客户端运行时状态（账号私有作用域内）：
 * - 每个会话一份写入链与版本号，供历史适配器与模型适配器共享；
 * - 换账号时 Provider 整体重建（key = 身份键），旧闭包与迟到响应随之失效；
 * - 只保存 UI 进程内协调状态，不缓存任何业务事实、不本地判定权限。
 */
import type { YayaAgentStopReason } from "@/lib/yaya/agent/types";

export interface YayaIdentity {
  accountId: string;
  role: "teacher" | "admin";
  displayName: string;
}

export interface YayaThreadWiring {
  readonly revision: number | null;
  setRevision(revision: number): void;
  /** 版本前提冲突后置空，下一次写入/运行会重新读取当前版本。 */
  invalidateRevision(): void;
  /** 所有历史写入串行入链；失败不阻塞后续写入，也不产生成功语义。 */
  trackWrite(promise: Promise<unknown>): void;
  waitForWrites(): Promise<void>;
  /** 同一用户消息的 client_request_id 跨重试稳定。 */
  clientRequestId(parentMessageId: string): string;
}

export interface YayaThreadNotice {
  running: boolean;
  pendingConfirm: number;
  saving: boolean;
  lastStop: YayaAgentStopReason | null;
  problem: boolean;
}

export interface YayaClientStore {
  readonly identity: YayaIdentity;
  threadWiring(remoteId: string): YayaThreadWiring;
  notice(remoteId: string): YayaThreadNotice;
  updateNotice(remoteId: string, patch: Partial<YayaThreadNotice>): void;
  subscribe(listener: () => void): () => void;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function createThreadWiring(): YayaThreadWiring {
  let revision: number | null = null;
  let chain: Promise<void> = Promise.resolve();
  const requestIds = new Map<string, string>();
  return {
    get revision() {
      return revision;
    },
    setRevision(next: number) {
      if (Number.isInteger(next) && next >= 1) revision = next;
    },
    invalidateRevision() {
      revision = null;
    },
    trackWrite(promise: Promise<unknown>) {
      chain = chain.then(
        () => promise.then(
          () => undefined,
          () => undefined
        )
      );
    },
    waitForWrites() {
      return chain;
    },
    clientRequestId(parentMessageId: string) {
      const existing = requestIds.get(parentMessageId);
      if (existing !== undefined) return existing;
      const next = randomId();
      requestIds.set(parentMessageId, next);
      return next;
    },
  };
}

const EMPTY_NOTICE: YayaThreadNotice = {
  running: false,
  pendingConfirm: 0,
  saving: false,
  lastStop: null,
  problem: false,
};

export function createYayaClientStore(identity: YayaIdentity): YayaClientStore {
  const wirings = new Map<string, YayaThreadWiring>();
  const notices = new Map<string, YayaThreadNotice>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    identity,
    threadWiring(remoteId: string) {
      let wiring = wirings.get(remoteId);
      if (wiring === undefined) {
        wiring = createThreadWiring();
        wirings.set(remoteId, wiring);
      }
      return wiring;
    },
    notice(remoteId: string) {
      return notices.get(remoteId) ?? EMPTY_NOTICE;
    },
    updateNotice(remoteId: string, patch: Partial<YayaThreadNotice>) {
      const current = notices.get(remoteId) ?? EMPTY_NOTICE;
      const next = { ...current, ...patch };
      if (
        next.running === current.running &&
        next.pendingConfirm === current.pendingConfirm &&
        next.saving === current.saving &&
        next.lastStop === current.lastStop &&
        next.problem === current.problem
      ) {
        return;
      }
      notices.set(remoteId, next);
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
