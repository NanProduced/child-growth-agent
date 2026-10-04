import { createInterface } from "node:readline";

import { bootstrapInitialAdmin, bootstrapStatus } from "../src/lib/accounts/bootstrap";
import { AdminAlreadyInitializedError } from "../src/lib/accounts/errors";

/**
 * 部署者非公网首位管理员初始化脚本（AUTH1）。
 *
 * 使用方式（部署主机，环境变量配置 DATABASE_URL / AUTH_SCHOOL_ID）：
 *   pnpm exec tsx scripts/auth-bootstrap-admin.ts
 * 然后按提示输入用户名、显示名与密码；密码只从标准输入读取，
 * 不通过命令行参数、环境变量或日志暴露；输入在 TTY 下不回显。
 *
 * 退出码：0 成功；2 已存在管理员（admin_already_initialized）；1 其他失败。
 * 本脚本没有 HTTP 入口，不创建默认账号、不覆盖或重置已有管理员。
 */

function readLine(prompt: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const interactive = process.stdin.isTTY === true;
    if (!interactive) process.stderr.write(prompt);
    const rl = createInterface({
      input: process.stdin,
      output: interactive ? process.stdout : process.stderr,
      terminal: interactive,
    });
    if (hidden && interactive) {
      const internal = rl as unknown as { _writeToOutput?: (text: string) => void };
      const original = internal._writeToOutput?.bind(rl);
      process.stdout.write(prompt);
      internal._writeToOutput = (text: string) => {
        if (text.includes("\n") || text.includes("\r")) original?.("\n");
      };
    }
    rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("error", reject);
  });
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => /pass(word)?/i.test(arg))) {
    throw new Error("拒绝通过命令行参数传递密码；请使用标准输入");
  }
  const status = await bootstrapStatus();
  if (status.admin_initialized) {
    console.error("系统中已存在管理员，拒绝重复初始化（admin_already_initialized）");
    process.exitCode = 2;
    return;
  }
  const username = await readLine("管理员用户名：", false);
  const displayName = await readLine("管理员显示名：", false);
  const password = await readLine("管理员密码（输入不回显）：", true);
  const confirm = await readLine("再次输入管理员密码：", true);
  if (password !== confirm) throw new Error("两次输入的密码不一致");
  const result = await bootstrapInitialAdmin({ username, display_name: displayName, password });
  // 只输出非敏感结果，绝不输出密码或哈希
  console.log(
    JSON.stringify({
      ok: true,
      account_id: result.principal.account_id,
      username: result.principal.username,
      role: result.principal.role,
    }),
  );
}

void main().catch((error: unknown) => {
  if (error instanceof AdminAlreadyInitializedError) {
    console.error("系统中已存在管理员，拒绝重复初始化（admin_already_initialized）");
    process.exitCode = 2;
    return;
  }
  console.error(error instanceof Error ? error.message : "初始化失败");
  process.exitCode = 1;
});
