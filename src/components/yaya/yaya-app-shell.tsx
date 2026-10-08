"use client";

import type { ReactNode } from "react";

import { TopNav } from "@/components/top-nav";
import type { AuthStatusResponse } from "@/lib/accounts/types";
import { cn } from "@/lib/utils";

import { YayaEntry } from "./yaya-entry";
import { YayaPanel } from "./yaya-panel";
import { useYayaSurface } from "./yaya-provider";

export function YayaAppShell({ auth, children }: { auth: AuthStatusResponse; children: ReactNode }) {
  const { open } = useYayaSurface();

  return (
    <div
      data-yaya-app-shell
      className={cn(
        "min-w-0",
        open && "lg:grid lg:grid-cols-[minmax(0,1fr)_clamp(360px,34vw,480px)] lg:items-start"
      )}
    >
      <div
        className={cn(
          "min-w-0",
          open && [
            "lg:[&>header>div]:flex-wrap lg:[&>header>div]:gap-2 lg:[&>header>div]:px-6 lg:[&>header>div]:pt-2",
            "lg:[&>header>div>nav]:order-3 lg:[&>header>div>nav]:basis-full lg:[&>header>div>nav]:flex-wrap",
          ]
        )}
      >
        <TopNav />
        <main className={cn(
          "mx-auto w-full max-w-[1536px] px-4 pb-16 pt-6 sm:px-6",
          open ? "lg:px-6 lg:[container-name:yaya-main] lg:[container-type:inline-size]" : "lg:px-10"
        )}>
          {children}
        </main>
      </div>
      <YayaPanel auth={auth} />
      <YayaEntry auth={auth} />
    </div>
  );
}
