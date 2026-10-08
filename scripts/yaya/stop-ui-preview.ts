import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stopTrackedChildTree, type TrackedProcess } from '../harness-safety';

async function main() {
  const runtime = JSON.parse(fs.readFileSync('logs/yaya-ui-preview/runtime.json', 'utf8')) as {
    run_id: string; seed_id: string; container_id: string; server_pid: number; server_started_at: string;
  };
  assert.match(runtime.run_id, /^final-wire-[a-f\d]{8}$/);
  assert.match(runtime.seed_id, /^qaseed1-/);
  assert.match(runtime.container_id, /^[a-f\d]{64}$/);
  const labels: Record<string, string> = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .Config.Labels}}', runtime.container_id], { encoding: 'utf8' }));
  assert.equal(labels['yaya.qa-seed1'], runtime.seed_id);
  const server: TrackedProcess = { pid: runtime.server_pid, startedAt: runtime.server_started_at, spawnError: null, exit: null, logFile: null };
  const result = await stopTrackedChildTree(server);
  assert.ok(result.ok, result.detail);
  console.log(result.detail); // Original supervisor owns exact seed/media/credentials cleanup.
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Owned preview stop failed'); process.exitCode = 1; });
