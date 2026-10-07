/**
 * 基础登录限流：进程内固定窗口。
 * 明确限制：多实例之间不共享计数（未引入 Redis），只作为基础防线；
 * 键 = 规范化用户名；客户端地址不参与账号桶，伪造 X-Forwarded-For 不能重开窗口。
 */

import { normalizeUsername } from "./normalize";

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

export function rateLimitKey(normalizedUsername: string, _clientAddress?: string): string {
  void _clientAddress; // 兼容现有登录调用，地址不参与账号桶。
  return normalizeUsername(normalizedUsername);
}

/** 保留调用兼容；地址不参与限流桶，也不用于授权或可信源判定 */
export function clientAddressOf(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

export const loginRateLimiter = createLoginRateLimiter();
