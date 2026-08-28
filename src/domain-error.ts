export type DomainErrorStatus = 400 | 404 | 409 | 422;

export class DomainError extends Error {
  constructor(
    readonly statusCode: DomainErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
