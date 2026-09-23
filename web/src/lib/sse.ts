/**
 * SSE 客户端。
 *
 * 协议（见后端 src/events/broadcaster.ts）：
 *   GET /api/v1/events?since=<seq>
 *   id: <event_seq>
 *   event: <kind>
 *   data: {"event_seq":..,"kind":..,"class_id":..,"payload":..,"occurred_at":..}
 *
 * 断线续传：浏览器原生 EventSource 会自动带 Last-Event-ID 重连，但那是在
 * 「同一条连接掉线」的场景。我们还要覆盖「整页刷新 / 长时间离线」——所以自己
 * 维护 lastEventId，重连时同时用 ?since= 与 Last-Event-ID 表达请求的起点。
 *
 * resync：服务端环形缓冲已丢掉我们缺的那段事件（seq 过旧）时会推 resync，
 * 此时不能增量补，必须整体重拉 —— 通过 onResync 回调告知上层（React Query
 * 的 invalidateQueries）。
 *
 * 重连：EventSource 自身有重连，但它在服务端返回 4xx/5xx 时会一直快速重试。
 * 这里统一由我们接管：出错就 close()，然后用指数退避 + 抖动重开。
 */

import { z } from 'zod';
import type { EventKind, SseMessage } from './schema';
import { sseMessage } from './schema';

export interface SseClientOptions {
  /** 起始序号。默认 0 = 从头（服务端可能直接回 resync）。 */
  since?: number;
  /** 只订阅某个班级的事件；不传 = 全部。 */
  classId?: string;
  onEvent: (msg: SseMessage) => void;
  /** 需要全量重拉（缓冲区已过期、或服务端要求 resync）。 */
  onResync: (reason: string) => void;
  /** 连接状态变化，用于 UI 提示「实时同步已断开」。 */
  onStatus?: (status: SseStatus) => void;
}

export type SseStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class SseClient {
  private es: EventSource | null = null;
  private readonly opts: SseClientOptions;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  /** 已处理的最大 event_seq。重连时作为 ?since= 的值。 */
  private lastEventId = 0;

  constructor(opts: SseClientOptions) {
    this.opts = opts;
    this.lastEventId = opts.since ?? 0;
  }

  get lastSeq(): number {
    return this.lastEventId;
  }

  connect(): void {
    if (this.closed) return;
    this.cleanupSocket();

    const params = new URLSearchParams();
    params.set('since', String(this.lastEventId));
    if (this.opts.classId) params.set('class_id', this.opts.classId);

    this.opts.onStatus?.(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const url = `/api/v1/events?${params.toString()}`;
    const es = new EventSource(url, { withCredentials: true });
    this.es = es;

    es.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus?.('open');
    };

    // 具名事件：服务端 `event: <kind>`，所以必须逐个 kind 注册监听。
    // 用 addEventListener 而非 onmessage —— onmessage 只接无 event 字段的消息。
    const kinds: readonly EventKind[] = [
      'seat_changed',
      'points_appended',
      'roster_changed',
      'layout_changed',
      'term_switched',
      'marks_changed',
      'duty_round_changed',
      'countdown_changed',
      'resync',
    ];
    for (const kind of kinds) {
      es.addEventListener(kind, (ev) => {
        this.handleMessage(ev as MessageEvent<string>, kind);
      });
    }

    // 兜底：服务端若未设置 event 字段（默认 message），也要能收到
    es.onmessage = (ev) => this.handleMessage(ev, null);

    es.onerror = () => {
      // EventSource 无法区分「服务端 4xx」与「网络抖动」，统一按可重连处理。
      // 但在 cookie 失效时重连是白费 —— 交给上层（401 由 REST 请求发现）。
      this.cleanupSocket();
      this.scheduleReconnect();
    };
  }

  /** 主动断开等场景：不再重连。 */
  close(): void {
    this.closed = true;
    this.cleanupSocket();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.opts.onStatus?.('closed');
  }

  /* ---------------- 内部 ---------------- */

  private handleMessage(ev: MessageEvent<string>, kindFromEvent: EventKind | null): void {
    // id: 字段来自服务端写入的 event_seq
    const idNum = ev.lastEventId ? Number(ev.lastEventId) : NaN;

    let parsed: SseMessage;
    try {
      const json: unknown = JSON.parse(ev.data);
      const result = sseMessage.safeParse(json);
      if (!result.success) {
        // 契约漂移时不静默丢弃：记为一次 resync 请求更安全
        this.opts.onResync('malformed_event');
        return;
      }
      parsed = result.data;
    } catch {
      this.opts.onResync('malformed_event');
      return;
    }

    if (Number.isFinite(idNum)) this.lastEventId = Math.max(this.lastEventId, idNum);
    this.lastEventId = Math.max(this.lastEventId, parsed.event_seq);

    // resync：缓冲区已过期，增量补发不可能，必须全量重拉
    if (parsed.kind === 'resync' || kindFromEvent === 'resync') {
      const reason = extractReason(parsed.payload) ?? 'seq_expired';
      this.opts.onResync(reason);
      return;
    }

    if (kindFromEvent && parsed.kind !== kindFromEvent) {
      // 具名事件与 payload 的 kind 不一致：以 payload 为准（它是权威结构）
      // 这里不额外处理，仅作为注释说明这个分支的意图。
    }

    this.opts.onEvent(parsed);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.opts.onStatus?.('reconnecting');

    // 指数退避 + 抖动，避免多设备同时重连打爆后端
    const exp = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempt);
    const jitter = Math.random() * 500;
    const delay = exp + jitter;
    this.attempt += 1;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private cleanupSocket(): void {
    if (this.es) {
      this.es.onopen = null;
      this.es.onerror = null;
      this.es.onmessage = null;
      this.es.close();
      this.es = null;
    }
  }
}

const resyncPayload = z.object({ reason: z.string().optional() });

function extractReason(payload: unknown): string | null {
  const parsed = resyncPayload.safeParse(payload);
  return parsed.success ? (parsed.data.reason ?? null) : null;
}
