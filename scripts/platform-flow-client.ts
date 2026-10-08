import assert from 'node:assert/strict';
import { reconcileOriginalOperationQuery } from '../src/components/yaya/client/actions';
import type { YayaOperationReceipt, YayaPlannedOperation, YayaOperationQueryOutcome } from '../src/lib/yaya/types';

// Expected identities originate in the prepared plan, never in the queried receipt.
const plan: YayaPlannedOperation = { operation_id: 'op-original', proposal_id: 'proposal-original', batch_id: 'batch-original', item_key: 'item-original', target_id: 'child-original', actor_account_id: 'teacher-original' };
const receipt: YayaOperationReceipt = { ...plan, status: 'saved', effect: 'committed', business_object_id: 'observation-original', business_revision: '1', recorded_at: '2026-10-08T00:00:00.000Z' };
let passed = 0;
const failures: string[] = [];
function check(outcome: YayaOperationQueryOutcome, expected: string, label: string): void {
  const result = reconcileOriginalOperationQuery(plan.operation_id, { operation_id: plan.operation_id, outcome }, plan).outcome;
  if (result.kind === expected) passed++; else failures.push(`${label}: expected ${expected}, got ${result.kind}`);
}
check({ kind: 'saved', receipt }, 'saved', 'legitimate success');
check({ kind: 'saved_detail_unavailable', receipt }, 'saved_detail_unavailable', 'later unreadable details retain original success');
check({ kind: 'saved', receipt: { ...receipt, status: 'unchanged' } }, 'saved', 'unchanged does not require revision growth');
check({ kind: 'saved', receipt: { ...receipt, effect: 'unknown' } }, 'unknown', 'unknown effect is not saved');
check({ kind: 'saved', receipt: { ...receipt, business_object_id: ' ' } }, 'unknown', 'blank business ID is not saved');
check({ kind: 'saved_detail_unavailable', receipt: { ...receipt, effect: 'unknown' } }, 'unknown', 'unreadable detail is not a success bypass');
check({ kind: 'saved', receipt: { ...receipt, status: 'failed', effect: 'none' } }, 'unknown', 'outer saved contradicts receipt failure');
check({ kind: 'saved', receipt: { ...receipt, actor_account_id: 'other-account' } }, 'unknown', 'wrong actor');
assert.equal(reconcileOriginalOperationQuery(plan.operation_id, { operation_id: plan.operation_id, outcome: { kind: 'saved', receipt } }, null).outcome.kind, 'unknown');
passed++;
check({ kind: 'failed', effect: 'unknown' }, 'failed', 'failure with unknown effect remains unknown in disposition');
console.log(JSON.stringify({ passed, failed: failures.length, failures, layer: 'pure client recovery trust boundary; no HTTP, DB, model or business transaction proof' }));
if (failures.length) process.exitCode = 1;
