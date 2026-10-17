/**
 * Domain errors. Each carries a stable machine-readable `code` and the HTTP
 * status the API layer should map it to. Routes never invent their own error
 * shapes — the error handler plugin serialises these uniformly as
 *   { error: { code, message, details? , requestId } }.
 */
export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'CONFLICT'
  | 'INVALID_TRANSITION'
  | 'OUT_OF_STOCK'
  | 'STORE_CLOSED'
  | 'MINIMUM_ORDER'
  | 'OUTSIDE_DELIVERY_AREA'
  | 'PROMO_INVALID'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'PAYMENT_MISMATCH'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  OUT_OF_STOCK: 409,
  STORE_CLOSED: 409,
  MINIMUM_ORDER: 422,
  OUTSIDE_DELIVERY_AREA: 422,
  PROMO_INVALID: 422,
  RATE_LIMITED: 429,
  IDEMPOTENCY_MISMATCH: 422,
  PAYMENT_MISMATCH: 409,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const notFound = (what: string, id?: string): DomainError =>
  new DomainError('NOT_FOUND', id ? `${what} ${id} not found` : `${what} not found`, { what, id });

export const forbidden = (message = 'not allowed'): DomainError =>
  new DomainError('FORBIDDEN', message);

export const validation = (message: string, details?: Record<string, unknown>): DomainError =>
  new DomainError('VALIDATION', message, details);

export const conflict = (message: string, details?: Record<string, unknown>): DomainError =>
  new DomainError('CONFLICT', message, details);

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
