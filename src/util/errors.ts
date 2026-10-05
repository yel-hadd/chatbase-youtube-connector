// Exit codes (part of the public interface: scripts and the README rely on them) and the
// error types that carry them.
export enum ExitCode {
  Ok = 0,
  Unexpected = 1,
  ConfigInvalid = 2,
  BudgetExceeded = 3,
  PartialFailure = 4,
  AuthOrPlan = 5,
}

/** An error whose message is safe and useful to show the user as-is. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = ExitCode.Unexpected,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

/** A non-2xx HTTP response, with the API's error code when it sent one. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
