import { SERVER_TZ } from './schema';

const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SERVER_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SERVER_TZ,
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const secondFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SERVER_TZ,
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: SERVER_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * 同时接受 ISO 8601 与 PostgreSQL 文本格式（`2026-09-25 02:20:22.09+08`）。
 * 部分回放接口直接透传数据库时间字符串。
 */
export function parseTime(value: string | Date): Date {
  if (value instanceof Date) return value;
  let s = value.trim().replace(' ', 'T');
  if (/[+-]\d{2}$/.test(s)) s += ':00';
  return new Date(s);
}

export function timeMs(value: string | Date): number {
  return parseTime(value).getTime();
}

export function formatTime(iso: string | Date): string {
  return timeFmt.format(parseTime(iso));
}

export function formatDateTime(iso: string | Date): string {
  return dateTimeFmt.format(parseTime(iso));
}

export function formatDateTimeSeconds(iso: string | Date): string {
  return secondFmt.format(parseTime(iso));
}

/** 北京时间的 YYYY-MM-DD，用于 `<input type="date">`。 */
export function beijingDay(value: string | Date = new Date()): string {
  return dayFmt.format(parseTime(value));
}

/** 北京时间某天的起点或终点，转成带时区的 ISO。 */
export function beijingDayBoundary(day: string, edge: 'start' | 'end'): string {
  const time = edge === 'start' ? '00:00:00.000' : '23:59:59.999';
  return new Date(`${day}T${time}+08:00`).toISOString();
}

export function signed(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}

export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 榜单行的显示名：匿名化学生 `name` 为空，显示匿名代号。 */
export function rowName(row: { name: string; anon_code: string | null }): string {
  return row.name || row.anon_code || '匿名';
}

export function initial(name: string): string {
  return Array.from(name.trim())[0] ?? '·';
}
