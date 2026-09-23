/**
 * Drizzle 的 `execute` 在 node-postgres 上返回 `{ rows }`。
 * 业务代码按行数组读取，这里把两种形状收成同一种。
 */

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result !== null &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
