import crypto from "node:crypto";

import {
  PASSWORD_HASH_ALGORITHM,
  PASSWORD_HASH_PARAMS,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SALT_MIN_BYTES,
} from "./types";

/**
 * 固定 scrypt 密码哈希实现（AUTH1）。
 * - 只接受冻结的 N/r/p/key_length/maxmem，不读取请求提供的成本参数；
 * - 存储格式：scrypt$N$r$p$<salt_base64>$<hash_base64>；
 * - 恒时比较；密码不 trim、不做 Unicode 规范化。
 */

const { N, r, p, key_length, maxmem } = PASSWORD_HASH_PARAMS;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

export interface ParsedPasswordHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function decodeBase64Strict(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

function parsePositiveDecimal(value: string): number | null {
  if (!DECIMAL_PATTERN.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * 严格解析固定存储格式：算法、参数、盐长度、哈希长度、base64 编码全部核对；
 * 任一不符返回 null（调用方按“格式不合法”处理，不尝试兼容其他参数）。
 */
export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6) return null;
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (algorithm !== PASSWORD_HASH_ALGORITHM) return null;
  const parsedN = parsePositiveDecimal(nRaw);
  const parsedR = parsePositiveDecimal(rRaw);
  const parsedP = parsePositiveDecimal(pRaw);
  if (parsedN === null || parsedR === null || parsedP === null) return null;
  if (parsedN !== N || parsedR !== r || parsedP !== p) return null;
  const salt = decodeBase64Strict(saltRaw);
  const hash = decodeBase64Strict(hashRaw);
  if (!salt || !hash) return null;
  if (salt.length < PASSWORD_SALT_MIN_BYTES || hash.length !== key_length) return null;
  return { N: parsedN, r: parsedR, p: parsedP, salt, hash };
}

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      key_length,
      { N, r, p, maxmem },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

function encodePasswordHash(salt: Buffer, derived: Buffer): string {
  return [
    PASSWORD_HASH_ALGORITHM,
    String(N),
    String(r),
    String(p),
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/** 密码策略：不 trim、不规范化，仅要求长度下限（契约 PASSWORD_MIN_LENGTH） */
export function assertPasswordPolicy(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(`密码长度至少 ${PASSWORD_MIN_LENGTH} 个字符`);
  }
}

/** 每账号独立随机盐（至少 16 字节）；本轮使用 16 字节 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = crypto.randomBytes(PASSWORD_SALT_MIN_BYTES);
  const derived = await scryptAsync(password, salt);
  return encodePasswordHash(salt, derived);
}

/** 校验密码；存储格式不合法直接 false，不泄露区分原因 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  let derived: Buffer;
  try {
    derived = await scryptAsync(password, parsed.salt);
  } catch {
    return false;
  }
  if (derived.length !== parsed.hash.length) return false;
  return crypto.timingSafeEqual(derived, parsed.hash);
}

let dummyHashPromise: Promise<string> | null = null;

/**
 * 账号不存在时用于消耗等价的计算时间，降低“用户名是否存在”的时序差异。
 * 只在本进程内生成一次，不落库。
 */
export function getDummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(24).toString("base64url"));
  }
  return dummyHashPromise;
}
