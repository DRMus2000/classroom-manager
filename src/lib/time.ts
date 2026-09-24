import { AppError } from './errors.js';

/**
 * 接受 ISO 8601 和 PostgreSQL 文本时间（`2026-09-25 02:20:22.09+08`）。
 * 解析失败抛 INTERNAL，避免 `RangeError` 变成无错误码的 500。
 */
export function toIsoTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new AppError('INTERNAL', '时间字段无法解析');
    return value.toISOString();
  }
  let text = value.trim().replace(' ', 'T');
  if (/[+-]\d{2}$/.test(text)) text += ':00';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new AppError('INTERNAL', '时间字段无法解析');
  return date.toISOString();
}

export function timestampMs(value: Date | string): number {
  return new Date(toIsoTimestamp(value)).getTime();
}
