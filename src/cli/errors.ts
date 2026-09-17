export const EXIT = {
  OK: 0,
  ERROR: 1,
  NOT_AVAILABLE: 2,
  NOT_INITIALIZED: 3,
  INTERRUPTED: 130,
} as const;

/** An expected, user-facing error with an actionable hint. No stack trace is shown. */
export class AthenaError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly exitCode: number = EXIT.ERROR,
  ) {
    super(message);
    this.name = 'AthenaError';
  }
}
