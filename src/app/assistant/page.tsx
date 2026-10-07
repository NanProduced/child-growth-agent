import type { Metadata } from "next";

import { YayaWorkspace } from "@/components/yaya/yaya-workspace";

export const metadata: Metadata = {
  title: "芽芽工作区",
};

export default function AssistantPage() {
  return <YayaWorkspace />;
}
