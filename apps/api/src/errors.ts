/** Typed application errors, mapped to HTTP responses in one place (app.ts). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'You do not have access to this action') =>
  new AppError(403, 'FORBIDDEN', msg);
export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', msg, details);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);
export const unprocessable = (code: string, msg: string) => new AppError(422, code, msg);
export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', msg);
