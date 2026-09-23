/**
 * 类型化错误工厂：业务层抛出，路由层捕获并转换为 HTTP 响应。
 *
 * 约定：
 * - 所有业务错误继承 AppError，携带 code + message + details。
 * - code 必须是 ERROR_CODES 枚举之一，映射到 HTTP 状态码。
 * - 不捕获的错误（如 DB 连接失败）会到达 Fastify 全局错误处理器，返回 500。
 */

import type { ErrorCode } from './schema.js';
import { ERROR_HTTP_STATUS } from './schema.js';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

/** 工厂函数：按 code 快速构造。 */
export function err(code: ErrorCode, message: string, details?: unknown): AppError {
  return new AppError(code, message, details);
}

/** 常见错误快捷方式 */
export const Errors = {
  unauthenticated: (msg = '未登录或会话已过期') => err('UNAUTHENTICATED', msg),
  sessionRevoked: (msg = '会话已被撤销（已从其他设备退出）') => err('SESSION_REVOKED', msg),
  forbidden: (msg = '权限不足') => err('FORBIDDEN', msg),
  notFound: (entity: string, id?: string) =>
    err('NOT_FOUND', `${entity}${id ? ` ${id}` : ''} 不存在`),

  versionConflict: (msg = '数据已被其他设备修改，请载入最新状态') =>
    err('VERSION_CONFLICT', msg),
  idempotencyMismatch: (msg = '同一 request_id 的请求体不一致') =>
    err('IDEMPOTENCY_MISMATCH', msg),
  requestInFlight: (msg = '请求正在处理中，请稍候') => err('REQUEST_IN_FLIGHT', msg),

  seatConflict: (seatNumber: number, occupant: string) =>
    err('SEAT_CONFLICT', `座位 ${seatNumber} 已被 ${occupant} 占用`, {
      seat_number: seatNumber,
      occupant,
    }),
  seatOccupied: (seatId: string, classes: string[]) =>
    err('SEAT_OCCUPIED', `座位 ${seatId} 仍被以下班级占用，无法删除`, {
      seat_id: seatId,
      classes,
    }),
  seatRequired: (msg = '在班学生必须绑定独立座位') => err('SEAT_REQUIRED', msg),
  seatMoveUnbalanced: (msg = '来源学生数与目标座位数不匹配，或目标座位不存在') =>
    err('SEAT_MOVE_UNBALANCED', msg),

  termReadonly: (msg = '学期已归档，禁止写入账本') => err('TERM_READONLY', msg),
  studentNoSeat: (students: string[]) =>
    err('STUDENT_NO_SEAT', `存在无座在班学生，阻塞导入提交`, { students }),

  importInvalid: (issues: unknown[]) =>
    err('IMPORT_INVALID', '导入文件校验失败', { issues }),
  importTokenExpired: (msg = '预览令牌已过期或数据已变，请重新预览') =>
    err('IMPORT_TOKEN_EXPIRED', msg),

  alreadyReversed: (msg = '该明细已被冲销') => err('ALREADY_REVERSED', msg),
  dutySelectionPending: (msg = '该轮已有未确认抽选，无法同时处理多个') =>
    err('DUTY_SELECTION_OPEN', msg),
  dutyNotFrozen: (msg = '尚未冻结候选，不能抽选') => err('DUTY_NOT_FROZEN', msg),
  noPushAlreadyMarked: (msg = '该生本轮未推椅子已登记') => err('NO_PUSH_ALREADY_MARKED', msg),

  rateLimited: (msg = '登录失败次数过多，请稍后再试') => err('RATE_LIMITED', msg),
  internal: (msg = '服务器内部错误') => err('INTERNAL', msg),
};

/**
 * Fastify 错误处理器集成：捕获 AppError 并转换为 HTTP 响应。
 *
 * 使用示例（在 Fastify 注册时）：
 * ```ts
 * fastify.setErrorHandler((error, request, reply) => {
 *   if (error instanceof AppError) {
 *     return reply.status(error.httpStatus).send(error.toJSON());
 *   }
 *   // 未知错误 → 500
 *   console.error('未知错误:', error);
 *   return reply.status(500).send({
 *     error: { code: 'INTERNAL', message: '服务器内部错误', request_id: request.id },
 *   });
 * });
 * ```
 */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
