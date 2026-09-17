export const EXIT = {
  OK: 0,
  ERROR: 1,
  NOT_AVAILABLE: 2,
  NOT_INITIALIZED: 3,
  INTERRUPTED: 130,
} as const;

/** Error category, mapped to exit codes by the CLI and HTTP statuses by the server. */
export type ErrorKind = 'invalid' | 'not-found' | 'conflict' | 'not-initialized' | 'busy' | 'unprocessable' | 'forbidden' | 'internal';

/** An expected, user-facing error with an actionable hint. No stack trace is shown. */
export class AthenaError extends Error {
  readonly kind: ErrorKind;
  constructor(
    message: string,
    readonly hint?: string,
    readonly exitCode: number = EXIT.ERROR,
    kind?: ErrorKind,
    /** Structured details safe to return to clients. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AthenaError';
    this.kind = kind ?? (exitCode === EXIT.NOT_INITIALIZED ? 'not-initialized' : 'invalid');
  }
}

export const notFound = (message: string) => new AthenaError(message, undefined, EXIT.ERROR, 'not-found');
export const conflict = (message: string, hint?: string, details?: Record<string, unknown>) => new AthenaError(message, hint, EXIT.ERROR, 'conflict', details);
