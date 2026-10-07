import { createInterface } from "node:readline";
import { Writable } from "node:stream";

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

function createInputReader() {
  const interactive = process.stdin.isTTY === true;
  const lines: string[] = [];
  let lineCount = 0;
  let closed = false;
  let hidden = false;
  let failure: Error | null = null;
  let pending: { resolve(value: string): void; reject(error: Error): void } | null = null;
  // 按实际收到的行数同步关闭密码回显，粘贴多行也不会提前回显密码。
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (interactive && lineCount < 2 && !hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: interactive, crlfDelay: Infinity });
  rl.on("line", (line: string) => {
    lineCount += 1;
    if (pending) {
      const waiting = pending;
      pending = null;
      waiting.resolve(line);
    } else {
      lines.push(line);
    }
  });
  rl.on("error", () => {
    failure = new Error("标准输入读取失败");
    pending?.reject(failure);
    pending = null;
  });
  rl.on("close", () => {
    closed = true;
    pending?.reject(new Error("标准输入提前结束，初始化未执行"));
    pending = null;
  });
  return {
    async readLine(prompt: string, hide: boolean): Promise<string> {
      hidden = hide;
      (interactive ? process.stdout : process.stderr).write(prompt);
      if (failure) throw failure;
      let line: string;
      if (lines.length > 0) {
        line = lines.shift()!;
      } else {
        if (closed) throw new Error("标准输入提前结束，初始化未执行");
        line = await new Promise<string>((resolve, reject) => { pending = { resolve, reject }; });
      }
      if (interactive && hide) process.stdout.write("\n");
      return line;
    },
    close: () => rl.close(),
  };
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error("拒绝通过命令行参数传递密码；请使用标准输入");
  }
  const reader = createInputReader();
  try {
    const status = await bootstrapStatus();
    if (status.admin_initialized) {
      console.error("系统中已存在管理员，拒绝重复初始化（admin_already_initialized）");
      process.exitCode = 2;
      return;
    }
    const username = await reader.readLine("管理员用户名：", false);
    const displayName = await reader.readLine("管理员显示名：", false);
    const password = await reader.readLine("管理员密码（输入不回显）：", true);
    const confirm = await reader.readLine("再次输入管理员密码：", true);
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
  } finally {
    reader.close();
    if (globalThis.__pgPool) {
      await globalThis.__pgPool.end();
      globalThis.__pgPool = undefined;
    }
  }
}

void main().catch((error: unknown) => {
  if (error instanceof AdminAlreadyInitializedError) {
    console.error("系统中已存在管理员，拒绝重复初始化（admin_already_initialized）");
    process.exitCode = 2;
    return;
  }
  // 不打印未知错误对象（可能带连接参数或输入），密码始终不进入日志。
  console.error("初始化失败：输入不完整、不合法或数据库不可用。");
  process.exitCode = 1;
});
