export function dropExpiredKeys<T extends { expiresAt: number }>(
  now: number,
  meta: Map<string, T>,
  payloads: Map<string, unknown>,
): void {
  for (const [key, value] of meta) {
    if (value.expiresAt < now) {
      meta.delete(key);
      payloads.delete(key);
    }
  }
}
