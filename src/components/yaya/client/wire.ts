/**
 * UI1 运行事件流消费（NDJSON）。
 *
 * 只消费冻结协议 `yaya-run-events-v1`：逐行 parseYayaRunWireLine 校验；
 * 流结束后用 validateYayaRunEventStream 复核身份 / 序号 / 终态一致性。
 * 任何坏行、错 run、缺终态、终态矛盾都不返回成功，已收到的正文只是草稿展示。
 */
import {
  parseYayaRunWireLine,
  validateYayaRunEventStream,
  type YayaRunWireEvent,
  type YayaApiViolation,
} from "@/lib/yaya/api-contract";
import type { YayaRunOutcome } from "@/lib/yaya/agent/types";

import { yayaHttpError, YayaApiError } from "./api";

export type YayaRunStreamResult =
  | { ok: true; run_id: string; outcome: YayaRunOutcome; events: readonly YayaRunWireEvent[] }
  | {
      ok: false;
      kind: "http";
      status: number;
      code: string;
      message: string;
    }
  | {
      ok: false;
      kind: "malformed";
      detail: string;
      violations: readonly YayaApiViolation[];
      events: readonly YayaRunWireEvent[];
    }
  | { ok: false; kind: "aborted" };

function firstViolationMessage(violations: readonly YayaApiViolation[]): string {
  const first = violations[0];
  if (first === undefined) return "事件流不符合协议";
  const path = first.path !== "" ? `${first.path}：` : "";
  return `${path}${first.message}`;
}

/**
 * 读取 NDJSON 流。`onEvent` 在每条校验通过、且未越过终态的事件到达时调用一次。
 * 终态之后再有事件、坏行、序号缺口都在结束时由 validateYayaRunEventStream 判定。
 */
export async function readYayaRunStream(
  response: Response,
  signal: AbortSignal,
  onEvent?: (event: YayaRunWireEvent) => void
): Promise<YayaRunStreamResult> {
  if (!response.ok) {
    const error: YayaApiError = await yayaHttpError(response);
    return { ok: false, kind: "http", status: error.status, code: error.code, message: error.message };
  }
  if (response.body === null) {
    return {
      ok: false,
      kind: "malformed",
      detail: "响应没有事件流正文",
      violations: [],
      events: [],
    };
  }

  const events: YayaRunWireEvent[] = [];
  let terminalSeen = false;
  let buffer = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const consumeLine = (rawLine: string): string | null => {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") return null;
    const parsed = parseYayaRunWireLine(line);
    if (!parsed.ok) return firstViolationMessage(parsed.violations);
    if (terminalSeen) return "run_end 之后不得再有事件";
    events.push(parsed.value);
    if (parsed.value.type === "run_end") terminalSeen = true;
    else onEvent?.(parsed.value);
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) {
        void reader.cancel().catch(() => {});
        return { ok: false, kind: "aborted" };
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const problem = consumeLine(line);
        if (problem !== null) {
          void reader.cancel().catch(() => {});
          return {
            ok: false,
            kind: "malformed",
            detail: problem,
            violations: [],
            events,
          };
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      const problem = consumeLine(buffer);
      if (problem !== null) {
        return { ok: false, kind: "malformed", detail: problem, violations: [], events };
      }
    }
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return { ok: false, kind: "aborted" };
    }
    return {
      ok: false,
      kind: "malformed",
      detail: "事件流读取中断",
      violations: [],
      events,
    };
  } finally {
    reader.releaseLock();
  }

  const verdict = validateYayaRunEventStream(events);
  if (!verdict.ok) {
    return {
      ok: false,
      kind: "malformed",
      detail: firstViolationMessage(verdict.violations),
      violations: verdict.violations,
      events,
    };
  }
  return { ok: true, run_id: verdict.run_id, outcome: verdict.outcome, events };
}
