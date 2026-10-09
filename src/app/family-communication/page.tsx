import type { Metadata } from "next";
import { FamilyCommunicationWorkspace } from "@/components/family-communication/workspace";
import { ReadFailureNotice, readFailureKind } from "@/components/read-failure-notice";
import { AccountsError } from "@/lib/accounts/errors";
import { scopedListChildren } from "@/lib/accounts/scoped-queries";
import { isoDateInShanghai } from "@/lib/format";
import { communicationPeriodSchema, previousCommunicationMonth } from "@/lib/family-communication-contract";
import type { Child } from "@/lib/types";

export const metadata: Metadata = { title: "家园沟通" };
export const dynamic = "force-dynamic";
export default async function FamilyCommunicationPage({ searchParams }: { searchParams: Promise<{ child?: string; kind?: string; value?: string }> }) {
  let children: Child[];
  try {
    children = await scopedListChildren();
  } catch (error) {
    return <ReadFailureNotice kind={error instanceof AccountsError ? readFailureKind(error) : "unavailable"} what="家园沟通" retryHref="/family-communication" />;
  }
  const { child, kind, value } = await searchParams;
  const today = isoDateInShanghai();
  const period = communicationPeriodSchema.safeParse(kind === "year" ? { kind } : { kind, value });
  if (child && !children.some((item) => item.id === child)) return <ReadFailureNotice kind="denied" what="这名幼儿的家园沟通" retryHref="/family-communication" />;
  return <FamilyCommunicationWorkspace today={today} initialPeriod={period.success ? period.data : { kind: "month", value: previousCommunicationMonth(today) }} initialChildId={child ?? ""}
    childrenList={children.map((item) => ({ id: item.id, name: item.name, birth_date: item.birth_date, class_name: item.current_class?.name ?? item.class_name }))} />;
}
