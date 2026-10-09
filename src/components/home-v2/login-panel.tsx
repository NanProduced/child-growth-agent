"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTeacher } from "@/components/teacher-provider";
import { safeLoginReturn } from "@/lib/accounts/login-return";
import styles from "./homepage.module.css";

export function LoginPanel({ returnTo = "/" }: { returnTo?: string }) {
  const router = useRouter();
  const { login, loading } = useTeacher();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (!username.trim() || !password) { setError("请输入账号和密码。"); return; }
    submitting.current = true;
    setError(null);
    try {
      const result = await login(username, password);
      if (result.ok) { setPassword(""); router.replace(safeLoginReturn(returnTo)); router.refresh(); }
      else setError(result.message ?? "登录未完成，请重试。");
    } finally { submitting.current = false; }
  }

  return (
    <section id="school-login" className={styles["login-panel"]} aria-labelledby="account-login-title">
      <h2 id="account-login-title">园所账号登录</h2>
      <form method="post" onSubmit={submit} className={styles["login-form"]}>
        <div className={styles["form-field"]}>
          <label htmlFor="school-username">账号</label>
          <Input id="school-username" name="username" autoComplete="username" placeholder="请输入账号"
            value={username} onChange={(event) => setUsername(event.target.value)} disabled={!ready || loading} required />
        </div>
        <div className={styles["form-field"]}>
          <label htmlFor="school-password">密码</label>
          <div className={styles["password-field"]}>
            <Input id="school-password" name="password" autoComplete="current-password" type={visible ? "text" : "password"}
              placeholder="请输入密码" value={password} onChange={(event) => setPassword(event.target.value)} disabled={!ready || loading} required />
            <button type="button" className={styles["password-toggle"]} aria-label={visible ? "隐藏密码" : "显示密码"}
              aria-pressed={visible} onClick={() => setVisible((previous) => !previous)} disabled={!ready || loading}>
              {visible ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
        </div>
        <p id="login-error" role={error ? "alert" : undefined} className={styles["login-error"]}>{error ?? "\u00a0"}</p>
        <Button type="submit" className={styles["login-button"]} disabled={!ready || loading}>
          {!ready ? "正在准备登录…" : loading ? <><Loader2 size={20} className="animate-spin" />正在登录…</> : "登录"}
        </Button>
      </form>
      <div className={styles["login-help"]}><p>账号由园所管理员分配</p><p>如需账号或重置密码，请联系管理员。</p></div>
    </section>
  );
}
