import { HeaderUtils } from 'coze-coding-dev-sdk';

const PROJECT = '7690843235199139866';

/** Explicit compatibility with the platform-injected workload protocol.
 * No CLI/PAT extraction, environment mutation, private SDK fields or user keys.
 */
export function platformWorkloadHeaders(kind: 'model' | 'storage', forward?: Record<string, string>): Record<string, string> {
  if (process.env.YAYA_PLATFORM_AUTH !== 'workload' || process.env.COZE_PROJECT_ID !== PROJECT || !['DEV', 'PROD'].includes(process.env.COZE_PROJECT_ENV ?? '')) {
    throw Error('平台 workload 协议未配置或项目身份不匹配。');
  }
  const token = process.env.COZE_WORKLOAD_IDENTITY_API_KEY?.trim();
  if (!token) throw Error('平台运行时身份不可用。');
  const headers = HeaderUtils.extractForwardHeaders(forward ?? {});
  delete headers['x-run-mode'];
  // Legacy workload gateways must not receive the new PAT-mode X-Coze-* trio.
  // DEV transport checks confirmed that mixing the protocols yields empty SSE.
  return { ...headers, ...(kind === 'model' ? { Authorization: 'Bearer ' + token } : { 'x-storage-token': token }) };
}

export function assertCozeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.hostname !== 'integration.coze.cn' || url.username || url.password || url.search || url.hash) throw Error('不是已核验的扣子平台代理端点。');
  return endpoint.replace(/\/+$/, '');
}
