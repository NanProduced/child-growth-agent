"use client";

/**
 * 芽芽虚拟形象与状态反馈。
 *
 * 使用用户批准的透明插画头像原图（public/assets/yaya），不用 CSS/emoji 冒充；
 * 状态永远伴随文字，`prefers-reduced-motion` 下不依赖动画。
 */
import Image from "next/image";
import { AlertTriangle, Check, Flag, Loader2, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";

export type YayaMood = "idle" | "thinking" | "confirm" | "saving" | "saved" | "unknown" | "restricted";

export const YAYA_MOOD_TEXT: Record<YayaMood, string> = {
  idle: "随时可以问我",
  thinking: "正在想…",
  confirm: "请你核对",
  saving: "正在保存…",
  saved: "操作已收到回执",
  unknown: "结果未知，按原操作核对",
  restricted: "当前身份不能用这项能力",
};

function MoodIndicator({ mood }: { mood: YayaMood }) {
  const base =
    "absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border border-background";
  switch (mood) {
    case "thinking":
      return (
        <span className={cn(base, "bg-sky-100 text-sky-700")}>
          <Loader2 className="size-2.5 motion-reduce:hidden" aria-hidden />
          <span className="hidden size-1.5 rounded-full bg-sky-600 motion-reduce:block" aria-hidden />
        </span>
      );
    case "confirm":
      return (
        <span className={cn(base, "bg-amber-100 text-amber-700")}>
          <Flag className="size-2.5" aria-hidden />
        </span>
      );
    case "saving":
      return (
        <span className={cn(base, "bg-amber-100 text-amber-700")}>
          <Loader2 className="size-2.5 animate-spin" aria-hidden />
        </span>
      );
    case "saved":
      return (
        <span className={cn(base, "bg-emerald-100 text-emerald-700")}>
          <Check className="size-2.5" aria-hidden />
        </span>
      );
    case "unknown":
      return (
        <span className={cn(base, "bg-amber-100 text-amber-700")}>
          <AlertTriangle className="size-2.5" aria-hidden />
        </span>
      );
    case "restricted":
      return (
        <span className={cn(base, "bg-slate-100 text-slate-600")}>
          <ShieldAlert className="size-2.5" aria-hidden />
        </span>
      );
    default:
      return null;
  }
}

export function YayaAvatar({
  mood = "idle",
  size = 28,
  className,
}: {
  mood?: YayaMood;
  size?: number;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <Image
        src="/assets/yaya/yaya-avatar.png"
        alt="芽芽"
        width={size}
        height={size}
        className="size-full select-none rounded-full object-contain"
        priority={false}
      />
      <MoodIndicator mood={mood} />
    </span>
  );
}

export function YayaStatusLine({
  mood,
  text,
  className,
}: {
  mood: YayaMood;
  text?: string;
  className?: string;
}) {
  return (
    <span role="status" aria-live="polite" className={cn("text-xs text-muted-foreground", className)}>
      {text ?? YAYA_MOOD_TEXT[mood]}
    </span>
  );
}
