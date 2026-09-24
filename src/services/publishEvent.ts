/**
 * 提交后广播。仓储只负责写入 event_log，服务层在这里登记 SSE。
 */

import type { Tx } from '../repo/db.js';
import * as auditRepo from '../repo/audit.js';
import { afterCommit } from '../repo/afterCommit.js';
import { publishEvent } from '../events/broadcaster.js';
import type { EventKind } from '../lib/schema.js';

export async function writeEvent(
  db: Tx,
  input: {
    class_id: string | null;
    kind: EventKind;
    payload: unknown;
  },
) {
  const row = await auditRepo.writeEvent(db, input);
  afterCommit(() => publishEvent(row));
  return row;
}
