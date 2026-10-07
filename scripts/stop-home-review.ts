import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { stopTrackedChildTree, type TrackedProcess } from "./harness-safety";

async function main() {
  const runtime = JSON.parse(await fs.readFile("logs/home-review/runtime.json", "utf8")) as {
    run_id: string; container_id: string; server_pid: number; server_started_at: string;
  };
  assert.match(runtime.run_id, /^home-/);
  assert.match(runtime.container_id, /^[a-f0-9]{64}$/);
  const labels = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .Config.Labels}}", runtime.container_id], { encoding: "utf8" })) as Record<string, string>;
  assert.equal(labels["child-growth-agent.home-review"], runtime.run_id);
  const server: TrackedProcess = { pid: runtime.server_pid, startedAt: runtime.server_started_at,
    spawnError: null, exit: null, logFile: null };
  const result = await stopTrackedChildTree(server);
  assert.equal(result.ok, true, result.detail);
  console.log(result.detail);
  // The original supervisor owns DB/credentials/guard cleanup after its server exits.
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Owned stop failed"); process.exitCode = 1; });
