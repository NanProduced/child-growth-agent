/**
 * 基础登录限流：进程内固定窗口。
 * 明确限制：多实例之间不共享计数（未引入 Redis），只作为基础防线；
 * 键 = 规范化用户名 + 客户端地址（地址取 X-Forwarded-For 首跳，仅作辅助，可被伪造）。
 */

export interface RateLimitPolicy {
  maxFailures: number;
  windowMs: number;
}

interface Bucket {
  failures: number;
  windowStart: number;
}

export interface LoginRateLimiter {
  isBlocked(key: string, policy: RateLimitPolicy): boolean;
  recordFailure(key: string, policy: RateLimitPolicy): void;
  reset(key: string): void;
  size(): number;
}

export function createLoginRateLimiter(clock: () => number = Date.now): LoginRateLimiter {
  const buckets = new Map<string, Bucket>();

  function activeBucket(key: string, policy: RateLimitPolicy): Bucket | null {
    const bucket = buckets.get(key);
    if (!bucket) return null;
    if (clock() - bucket.windowStart >= policy.windowMs) {
      buckets.delete(key);
      return null;
    }
    return bucket;
  }

  return {
    isBlocked(key, policy) {
      const bucket = activeBucket(key, policy);
      return bucket !== null && bucket.failures >= policy.maxFailures;
    },
    recordFailure(key, policy) {
      const bucket = activeBucket(key, policy);
      if (!bucket) {
        buckets.set(key, { failures: 1, windowStart: clock() });
      } else {
        bucket.failures += 1;
      }
      if (buckets.size > 1000) {
        for (const [existingKey, existing] of buckets) {
          if (clock() - existing.windowStart >= policy.windowMs) buckets.delete(existingKey);
        }
      }
    },
    reset(key) {
      buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
  };
}

export function rateLimitKey(normalizedUsername: string, clientAddress: string): string {
  return `${normalizedUsername}|${clientAddress}`;
}

/** 仅作限流辅助键；不用于任何授权或可信源判定 */
export function clientAddressOf(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

export const loginRateLimiter = createLoginRateLimiter();
