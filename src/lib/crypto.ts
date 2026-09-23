/**
 * 密码哈希与令牌哈希（Argon2id + SHA-256）。
 *
 * 约定：
 * - 密码用 Argon2id（memoryCost=64MB, timeCost=3）。
 * - 会话令牌只存哈希（SHA-256），不存明文。
 * - 生成的令牌为 32 字节随机数的 base64url 编码。
 */

import { hash as argon2Hash, verify as argon2Verify } from 'argon2';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * 密码哈希（Argon2id）。
 * 参数：memoryCost=64MB, timeCost=3, parallelism=1（2C4G 单机适配）。
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, {
    type: 2, // Argon2id
    memoryCost: 64 * 1024, // 64 MB
    timeCost: 3,
    parallelism: 1,
  });
}

/**
 * 密码校验。
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * 生成会话令牌（32 字节随机数 → base64url）。
 * 返回 { token: 明文令牌, tokenHash: SHA-256 哈希（存库） }。
 */
export function generateSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

/**
 * 令牌哈希（用于校验会话令牌）。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 生成匿名化加密密钥（32 字节 hex）。
 * 用于加密匿名化外部账本；密钥必须独立保管，不进数据库备份。
 */
export function generateAnonLedgerKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * 简单对称加密（AES-256-GCM）+ base64 编码。
 * 用于匿名化账本的持久化存储。
 *
 * 注：生产环境应使用专用密钥管理服务（如 AWS KMS）。
 * 这里为单机部署提供基础实现。
 */
export function encryptAnonLedger(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12); // GCM 推荐 12 字节
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');

  // 格式：iv:authTag:ciphertext（全部 base64）
  return `${iv.toString('base64')}:${authTag}:${encrypted}`;
}

/**
 * 解密匿名化账本。
 */
export function decryptAnonLedger(ciphertext: string, keyHex: string): string {
  const [ivB64, authTagB64, encryptedB64] = ciphertext.split(':');
  if (!ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error('密文格式无效');
  }

  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedB64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
