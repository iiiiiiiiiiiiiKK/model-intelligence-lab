/** Uniform API error envelope used by every route. */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'NOT_COMPARABLE'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_NOT_CONFIGURED: 400,
  PROVIDER_ERROR: 502,
  BUDGET_EXCEEDED: 402,
  NOT_COMPARABLE: 409,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, details?: unknown, retryable = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
    this.retryable = retryable;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        retryable: this.retryable,
      },
    };
  }
}

export const notFound = (what: string) => new ApiError('NOT_FOUND', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new ApiError('BAD_REQUEST', message, details);
