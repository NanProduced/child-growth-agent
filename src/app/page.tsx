import type { Metadata } from "next";
import { Homepage } from "@/components/home-v2/homepage";
import { loadHomeV2Data } from "@/lib/home-v2/data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "园所成长工作台",
  description: "以三年为序，看见幼儿持续生长：连接观察证据、指南参照与教育支持。",
};

export default async function HomePage() {
  return <Homepage data={await loadHomeV2Data()} />;
}
