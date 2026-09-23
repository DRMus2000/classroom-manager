/**
 * SSE 广播器：进程内事件总线 + 环形缓冲。
 *
 * 约定（A8 / 多端同步）：
 * - 写入走普通 API，推送走 SSE（单向）。事件带自增序号，客户端用 Last-Event-ID 续传。
 * - 客户端序号过旧（超出缓冲）→ 推送 resync 事件，要求全量重拉。
 * - 断网重连：客户端带 Last-Event-ID，服务端补发缺失事件。
 */

import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { EventKind, SseMessage } from '../lib/schema.js';

/** 环形缓冲大小：超出后旧事件被丢弃，迟到客户端收到 resync。 */
const RING_SIZE = 1000;

/** SSE 心跳间隔（毫秒），防止中间代理断开空闲连接。 */
const HEARTBEAT_MS = 25_000;

interface Client {
  id: string;
  res: ServerResponse;
  classId?: string;
  lastSeq: number;
  heartbeat: NodeJS.Timeout;
}

class Broadcaster {
  private readonly emitter = new EventEmitter();
  private readonly ring: SseMessage[] = [];
  private readonly clients = new Map<string, Client>();
  private maxSeq = 0;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  /** 记录事件（写库后调用）。seq 由数据库 event_log 提供，保证与回放一致。 */
  publish(msg: SseMessage): void {
    this.maxSeq = Math.max(this.maxSeq, msg.event_seq);

    this.ring.push(msg);
    if (this.ring.length > RING_SIZE) this.ring.shift();

    // 广播给订阅客户端（按 classId 过滤）
    for (const client of this.clients.values()) {
      if (client.classId && msg.class_id && msg.class_id !== client.classId) continue;
      this.send(client, msg);
    }
  }

  /** 注册 SSE 客户端。返回注销函数。 */
  subscribe(
    id: string,
    res: ServerResponse,
    opts: { classId?: string; lastEventId?: number },
  ): () => void {
    const client: Client = {
      id,
      res,
      classId: opts.classId,
      lastSeq: opts.lastEventId ?? 0,
      heartbeat: setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          this.unsubscribe(id);
        }
      }, HEARTBEAT_MS),
    };

    this.clients.set(id, client);

    // 补发缺失事件
    if (opts.lastEventId != null) {
      this.replay(client, opts.lastEventId);
    }

    return () => this.unsubscribe(id);
  }

  /** 补发 lastSeq 之后的事件；若序号过旧则要求全量重拉。 */
  private replay(client: Client, lastSeq: number): void {
    const oldest = this.ring[0]?.event_seq ?? this.maxSeq;

    if (lastSeq < oldest - 1 && this.ring.length >= RING_SIZE) {
      // 事件已过期，客户端必须全量重拉
      this.writeRaw(client, {
        event_seq: this.maxSeq,
        kind: 'resync',
        class_id: client.classId ?? null,
        payload: { reason: 'seq_expired' },
        occurred_at: new Date().toISOString(),
      });
      return;
    }

    for (const msg of this.ring) {
      if (msg.event_seq > lastSeq) this.send(client, msg);
    }
  }

  private send(client: Client, msg: SseMessage): void {
    this.writeRaw(client, msg);
    client.lastSeq = msg.event_seq;
  }

  private writeRaw(client: Client, msg: SseMessage): void {
    try {
      // SSE 格式：id: <seq>\nevent: <kind>\ndata: <json>\n\n
      client.res.write(`id: ${msg.event_seq}\n`);
      client.res.write(`event: ${msg.kind}\n`);
      client.res.write(`data: ${JSON.stringify(msg)}\n\n`);
    } catch {
      this.unsubscribe(client.id);
    }
  }

  private unsubscribe(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    clearInterval(client.heartbeat);
    this.clients.delete(id);
  }

  /** 当前在线客户端数（诊断用）。 */
  get clientCount(): number {
    return this.clients.size;
  }

  /** 最大事件序号（新客户端首次连接时的起点）。 */
  get currentSeq(): number {
    return this.maxSeq;
  }

  /** 主动断开全部客户端（进程退出用）。 */
  closeAll(): void {
    for (const client of [...this.clients.values()]) {
      clearInterval(client.heartbeat);
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}

export const broadcaster = new Broadcaster();

/**
 * 便捷函数：把数据库写入的 event_log 行转为 SSE 消息并广播。
 */
export function publishEvent(row: {
  event_seq: number | string;
  class_id: string | null;
  kind: string;
  payload: unknown;
  occurred_at: Date | string;
}): void {
  broadcaster.publish({
    event_seq: Number(row.event_seq),
    kind: row.kind as EventKind,
    class_id: row.class_id,
    payload: row.payload,
    occurred_at:
      row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
  });
}
