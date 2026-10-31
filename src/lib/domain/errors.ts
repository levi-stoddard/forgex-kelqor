/** An expected, user-facing failure (bad state, missing permission, invalid input). */
export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid" | "forbidden" | "not_found" | "conflict" = "invalid",
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function assert(condition: unknown, message: string, code?: DomainError["code"]): asserts condition {
  if (!condition) throw new DomainError(message, code);
}
