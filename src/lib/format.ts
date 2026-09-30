/** 页面展示用的格式化工具 */

import { CLASS_STAGE_LABELS, type ClassStage, type SchoolClass } from "./types";

/** 「中班 · 向日葵班」；没有班级名时返回 null */
export function classLabel(
  stage: ClassStage | null | undefined,
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  return stage ? `${CLASS_STAGE_LABELS[stage]} · ${name}` : name;
}

export function schoolClassLabel(klass: SchoolClass | null | undefined): string | null {
  return klass ? classLabel(klass.stage, klass.name) : null;
}

export function formatDateCn(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * 固定按东八区（幼儿园所在地）展示，服务端与浏览器输出一致，避免水合不一致。
 */
export function formatDateTimeCn(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}年${t.getUTCMonth() + 1}月${t.getUTCDate()}日 ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

export function ageText(birthDate: string, at?: string): string {
  const b = new Date(`${birthDate}T00:00:00`);
  const ref = at ? new Date(`${at.slice(0, 10)}T00:00:00`) : new Date();
  if (Number.isNaN(b.getTime()) || Number.isNaN(ref.getTime())) return "—";
  let months = (ref.getFullYear() - b.getFullYear()) * 12 + (ref.getMonth() - b.getMonth());
  if (ref.getDate() < b.getDate()) months -= 1;
  months = Math.max(0, months);
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years <= 0) return `${rest}个月`;
  if (rest === 0) return `${years}岁`;
  return `${years}岁${rest}个月`;
}

export function excerpt(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
