/**
 * 类型化 fetch 封装。
 *
 * 三条硬约定：
 * 1. 一律 `credentials: 'include'` —— 会话是 HttpOnly Cookie，不带凭据等于未登录。
 * 2. 失败一律抛 ApiError，携带统一错误体的 {code, message, details}。
 *    调用方永远不需要自己解析 JSON 来判断业务错误。
 * 3. 每一个写操作自动生成 request_id（A7 幂等键）；重试时复用调用方持有的同一个
 *    值 —— 见下方 newRequestId / ApiOptions.requestId 的注释。
 */
import { z } from 'zod';
import type { ErrorCode } from './schema';
import { ERROR_CODES, errorBody } from './schema';

export const API_BASE = '/api/v1';

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

/**
 * 业务错误。details 是 unknown（各 code 形状不同），用下方 helper 收窄。
 *
 * `retryable` 只表达「同一 request_id 重发是安全的」这一件事：
 * 网络层失败、或 409 REQUEST_IN_FLIGHT，都属于这种情况。
 * 校验类错误重发多少次都是同样的结果，不标记为可重试。
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | undefined;
  readonly retryable: boolean;

  constructor(init: {
    code: ErrorCode;
    message: string;
    status: number;
    details?: unknown;
    requestId?: string;
    retryable?: boolean;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryable = init.retryable ?? false;
  }

  /** 会话失效（需要跳登录页）。 */
  get isAuthFailure(): boolean {
    return this.code === 'UNAUTHENTICATED' || this.code === 'SESSION_REVOKED';
  }

  /** 版本冲突（A12）：必须提示「载入最新状态」，不得静默合并。 */
  get isVersionConflict(): boolean {
    return this.code === 'VERSION_CONFLICT';
  }
}

/** 网络层错误（请求没到服务器）与业务错误统一成一个类型，方便 UI 一把处理。 */
export class NetworkError extends ApiError {
  constructor(message = '网络不可用，请检查连接') {
    super({
      code: 'INTERNAL',
      message,
      status: 0,
      retryable: true,
    });
    this.name = 'NetworkError';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** 把任意 thrown 值转成可展示的中文文案。 */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return '发生未知错误';
}

/** 收窄 details。details 是 unknown，调用方按需索取字段。 */
export function detailsAs<T>(e: ApiError, shape: z.ZodType<T>): T | null {
  const parsed = shape.safeParse(e.details);
  return parsed.success ? parsed.data : null;
}

/** 校验 details 里的字段名，避免 UI 层用错键名。 */
export const seatOccupiedDetails = z.object({
  seat_id: z.string(),
  classes: z.array(z.string()),
});

export const studentNoSeatDetails = z.object({ students: z.array(z.string()) });

/** 后端 validation 错误的 details 形状未在 schema.ts 中固定，做宽松解析。 */
export const validationDetails = z.object({
  issues: z
    .array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])).optional(),
        message: z.string(),
      }),
    )
    .optional(),
});

/* ------------------------------------------------------------------ */
/* request_id（幂等键，A7）                                            */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 为一次写操作生成幂等键。
 *
 * 【幂等契约 —— 必读】
 * 后端按 request_id 去重：同一个 request_id 重发，返回首次的结果（200），
 * 不会重复记账、不会重复换座。因此：
 *
 *   - 每次「用户意图」生成一个新的 request_id（点击保存、点击提交）。
 *   - 同一次用户意图的所有重试必须复用同一个值。
 *     典型场景：请求超时但服务端其实已提交 —— 点击「重试」时要传回
 *     上一次的 request_id，否则会重复记分。
 *   - 因此在 React 侧的正确用法是：把 request_id 存进 mutation 的 variables
 *     或组件 state，重试时原样回传；不要每次重试都调 newRequestId()。
 *
 * 实现要点：优先用 crypto.randomUUID；旧版浏览器（微信内置 WebView 老版本）
 * 没有该 API 时退化为 getRandomValues 手工拼 v4，绝不退化成非 UUID ——
 * 后端契约是 z.string().uuid()，格式不符会直接 400。
 */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    // 依 RFC 4122 置版本位与变体位
    const b6 = bytes[6] ?? 0;
    const b8 = bytes[8] ?? 0;
    bytes[6] = (b6 & 0x0f) | 0x40;
    bytes[8] = (b8 & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // 兜底：non-secure context 下的极旧环境。幂等键只要求唯一性，不要求密码学安全。
  const rand = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rand()}${rand()}-${rand()}-4${rand().slice(1)}-a${rand().slice(1)}-${rand()}${rand()}${rand()}`;
}

export function isRequestId(v: string): boolean {
  return UUID_RE.test(v);
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

export interface RequestOptions<TBody> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: TBody;
  /** 查询串；undefined/null 的键会被丢弃。 */
  query?: Record<string, string | number | boolean | undefined | null>;
  /**
   * 幂等键。给写操作传：
   *   - 首次提交：newRequestId()
   *   - 重试同一意图：传回上次那个值
   * 不传时，写操作会自动生成一个（首次调用即正确的默认行为）。
   */
  requestId?: string;
  signal?: AbortSignal;
  /** 响应校验器。传了就 parse，字段漂移会立刻报错而不是渲染 undefined。 */
  schema?: z.ZodType<unknown>;
}

/** 写操作（需要幂等键的方法）。 */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function buildUrl(path: string, query?: RequestOptions<unknown>['query']): string {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

/**
 * 核心请求函数。
 *
 * 返回 { data, requestId }：把本次实际使用的 request_id 交还给调用方，
 * 这样调用方在重试时能原样传回（幂等契约的闭环）。
 */
export async function apiRequest<TResponse, TBody = unknown>(
  path: string,
  options: RequestOptions<TBody> = {},
): Promise<{ data: TResponse; requestId: string | undefined }> {
  const method = options.method ?? 'GET';
  const isWrite = WRITE_METHODS.has(method);

  // 写操作必须有幂等键：调用方没给就新生成一个（首次提交的正确默认值）。
  const requestId = isWrite ? (options.requestId ?? newRequestId()) : undefined;

  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (isForm) {
    // 浏览器自己带 multipart boundary。导入预览只认字段 file，不注入 request_id。
    payload = options.body as FormData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    // 后端所有写入 DTO 都要求 request_id 字段，这里统一注入，
    // 避免每个调用点自己记得加（漏加会被 z 校验挡在 400）。
    const withKey =
      requestId && typeof options.body === 'object' && options.body !== null
        ? { ...(options.body as Record<string, unknown>), request_id: requestId }
        : options.body;
    payload = JSON.stringify(withKey);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: payload,
      credentials: 'include', // 会话 Cookie 必须随请求发送
      cache: 'no-store',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    // AbortError 要原样抛，调用方（React Query）靠它识别取消
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new NetworkError();
  }

  if (res.status === 204) {
    return { data: undefined as TResponse, requestId };
  }

  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      if (!res.ok) {
        throw new ApiError({
          code: 'INTERNAL',
          message: `服务器返回了非 JSON 响应（HTTP ${res.status}）`,
          status: res.status,
        });
      }
      throw new ApiError({
        code: 'INTERNAL',
        message: '服务器返回了无法解析的响应',
        status: res.status,
      });
    }
  }

  if (!res.ok) {
    const parsed = errorBody.safeParse(json);
    if (parsed.success) {
      const { code, message, details, request_id } = parsed.data.error;
      throw new ApiError({
        code,
        message,
        status: res.status,
        details,
        requestId: request_id,
        // 同一 request_id 重发安全的两种情况
        retryable: code === 'REQUEST_IN_FLIGHT' || code === 'INTERNAL',
      });
    }
    // 后端没按统一错误体返回（例如 nginx 502 页面）
    throw new ApiError({
      code: 'INTERNAL',
      message: `请求失败（HTTP ${res.status}）`,
      status: res.status,
      retryable: res.status >= 500,
    });
  }

  if (options.schema) {
    const parsed = options.schema.safeParse(json);
    if (!parsed.success) {
      // 前端契约与后端漂移：开发期必须炸出来，不要静默渲染 undefined
      throw new ApiError({
        code: 'INTERNAL',
        message: `接口返回结构与前端契约不一致：${path}`,
        status: res.status,
        details: parsed.error.issues,
      });
    }
    return { data: parsed.data as TResponse, requestId };
  }

  return { data: json as TResponse, requestId };
}

/** 只取数据的便捷包装（不需要 request_id 回传时用）。 */
export async function api<TResponse, TBody = unknown>(
  path: string,
  options: RequestOptions<TBody> = {},
): Promise<TResponse> {
  const { data } = await apiRequest<TResponse, TBody>(path, options);
  return data;
}

/** 健康探针：不走 /api/v1，不带凭据要求。用于在线状态判定。 */
export async function probeHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('/healthz', {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 错误码 → 中文兜底文案（后端已给 message，这里只做补充说明）。 */
export const ERROR_HINTS: Partial<Record<ErrorCode, string>> = {
  VERSION_CONFLICT: '数据已被其他设备修改，请载入最新状态后重试。',
  IDEMPOTENCY_MISMATCH: '同一 request_id 的请求体不一致：请勿修改请求内容后重试。',
  REQUEST_IN_FLIGHT: '请求正在处理中，可稍后用同一 request_id 重试。',
  SEAT_CONFLICT: '目标座位已被占用。',
  SEAT_MOVE_UNBALANCED: '来源学生数与目标座位数不匹配，或目标区域与来源区域部分重叠。',
  TERM_READONLY: '当前学期已归档，禁止写入。',
  SESSION_REVOKED: '会话已在其他设备退出，请重新登录。',
  RATE_LIMITED: '操作过于频繁，请稍后再试。',
};

export function isKnownErrorCode(v: string): v is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(v);
}
