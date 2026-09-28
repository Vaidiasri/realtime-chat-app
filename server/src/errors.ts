// Expected failures. The error middleware and socket acks turn these into `{ error: code }`.
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
