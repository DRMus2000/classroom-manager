/** 备份调度与恢复目标校验。不访问数据库。 */

export function msUntilShanghai(hour: number, minute: number, now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const current = { hour: pick('hour'), minute: pick('minute'), second: pick('second') };
  const passed =
    current.hour > hour
    || (current.hour === hour && current.minute > minute)
    || (current.hour === hour && current.minute === minute && current.second > 0);
  let seconds = (hour - current.hour) * 3600 + (minute - current.minute) * 60 - current.second;
  if (passed) seconds += 24 * 3600;
  if (seconds < 1) seconds = 24 * 3600;
  return seconds * 1000;
}

export function assertRestoreTarget(liveUrl: string, targetUrl: string): void {
  const live = new URL(liveUrl);
  const target = new URL(targetUrl);
  const same =
    live.protocol === target.protocol
    && live.hostname === target.hostname
    && (live.port || '5432') === (target.port || '5432')
    && live.pathname === target.pathname;
  if (same) throw new Error('恢复目标不能是当前 DATABASE_URL');
}
