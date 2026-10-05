/** Login destinations are app-local; never accept a protocol, API route, or control character. */
export function safeLoginReturn(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return "/";
  const target = new URL(value, "http://local.invalid");
  if (target.origin !== "http://local.invalid" || target.pathname.startsWith("//") ||
      /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(target.pathname) ||
      target.pathname === "/login" || target.pathname === "/api" || target.pathname.startsWith("/api/")) return "/";
  return target.pathname + target.search + target.hash;
}
