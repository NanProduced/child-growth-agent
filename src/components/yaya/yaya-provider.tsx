"use client";

/**
 * 芽芽运行时 Provider（账号身份键控）。
 *
 * - 身份变化时整体重建（key = 身份键）：换账号立即丢弃旧私人投影，
 *   旧闭包的迟到响应不会写回新账号状态；
 * - 使用 useRemoteThreadListRuntime + useLocalRuntime，自有 model/history/attachment 适配；
 * - 未认证 / 身份不可用时**不挂运行时**，只显示权限卡（fail closed，不调用模型）。
 */
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  useLocalRuntime,
  useRemoteThreadListRuntime,
  type AssistantRuntime,
} from "@assistant-ui/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { authIdentityKey } from "@/lib/accounts/client";
import type { AuthStatusResponse } from "@/lib/accounts/types";

import {
  createYayaChatModelAdapter,
  createYayaRuntimeAdaptersHook,
  createYayaThreadListAdapter,
} from "./client/adapters";
import { createYayaClientStore, type YayaClientStore } from "./client/store";

const StoreContext = createContext<YayaClientStore | null>(null);

export function useYayaStore(): YayaClientStore {
  const store = useContext(StoreContext);
  if (store === null) throw new Error("useYayaStore 必须在 YayaSurface 内使用");
  return store;
}

interface SurfaceState {
  open: boolean;
  setOpen: (open: boolean) => void;
}
const SurfaceContext = createContext<SurfaceState | null>(null);

export function useYayaSurface(): SurfaceState {
  const state = useContext(SurfaceContext);
  if (state === null) throw new Error("useYayaSurface 必须在 YayaSurface 内使用");
  return state;
}

const RuntimePresenceContext = createContext(false);
export function useYayaRuntimeReady(): boolean {
  return useContext(RuntimePresenceContext);
}

/**
 * 会话就绪状态：assistant-ui 在主线程尚未挂载时使用空占位线程
 * （`isLoading=true`），此时任何线程/composer 方法调用都会抛错。
 * UI 只在 "ready" 时渲染会话区；加载中显示骨架，列表读取失败显示说明。
 */
export function useYayaThreadAvailability(): "loading" | "ready" | "unavailable" {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const availability = useAuiState((state) => {
    try {
      if (state.threads.isLoading) return "loading";
      if (state.threads.loadError != null) return "unavailable";
      if (state.thread.isLoading) return "loading";
      return Array.isArray(state.thread.messages) ? "ready" : "unavailable";
    } catch {
      // 空占位线程：读取即失败，按加载中处理，避免把占位当空数据。
      return "loading";
    }
  });
  return mounted ? availability : "loading";
}

function YayaRuntimeMount({ store, children }: { store: YayaClientStore; children: ReactNode }) {
  const adapter = useMemo(() => createYayaThreadListAdapter(store), [store]);
  const runtimeAdapterHook = useMemo(() => createYayaRuntimeAdaptersHook(store), [store]);
  // 适配器引用必须跨渲染稳定：每次新建会触发会话列表重载与渲染循环。
  const threadListAdapter = useMemo(
    () => ({ ...adapter, unstable_useAdapters: runtimeAdapterHook }),
    [adapter, runtimeAdapterHook]
  );

  const useYayaThreadRuntime = useMemo(() => {
    return function useYayaThreadRuntimeHook(): AssistantRuntime {
      const aui = useAui();
      const chatModel = useMemo(() => createYayaChatModelAdapter(store, aui), [aui, store]);
      return useLocalRuntime(chatModel);
    };
  }, [store]);

  const runtime = useRemoteThreadListRuntime({
    runtimeHook: useYayaThreadRuntime,
    adapter: threadListAdapter,
  });

  return (
    <RuntimePresenceContext.Provider value={true}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </RuntimePresenceContext.Provider>
  );
}

/**
 * 顶层挂载：认证时挂运行时；未认证只渲染入口与权限说明。
 * identityKey 变化时重建 store 与运行时；TeacherProvider 同步会先展示更新状态。
 */
export function YayaSurface({
  auth,
  children,
  defaultOpen = false,
}: {
  auth: AuthStatusResponse;
  children: ReactNode;
  /** 仅用于预览/演示：初始打开面板。 */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const surface = useMemo(() => ({ open, setOpen }), [open]);
  const identityKey = authIdentityKey(auth);
  const store = useMemo(() => {
    const principal = auth.state.kind === "authenticated" ? auth.state.principal : null;
    return createYayaClientStore(
      principal === null
        ? { accountId: "anonymous", role: "teacher", displayName: "未登录" }
        : { accountId: principal.account_id, role: principal.role, displayName: principal.display_name }
    );
    // 只在身份键变化时重建；同类 revalidate 不重建会话状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);
  const authenticated = auth.state.kind === "authenticated";
  const content = (
    <StoreContext.Provider value={store}>
      <SurfaceContext.Provider value={surface}>
        {authenticated ? (
          <YayaRuntimeMount key={identityKey} store={store}>
            {children}
          </YayaRuntimeMount>
        ) : (
          children
        )}
      </SurfaceContext.Provider>
    </StoreContext.Provider>
  );
  return content;
}
