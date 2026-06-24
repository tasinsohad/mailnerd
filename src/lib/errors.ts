export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON() {
    const obj: Record<string, unknown> = {
      error: this.message,
      code: this.code,
    };
    if (this.details !== undefined) {
      obj.details = this.details;
    }
    return obj;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "VALIDATION_ERROR", details);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfter?: number) {
    super("Rate limit exceeded", 429, "RATE_LIMITED", { retryAfter });
    this.name = "RateLimitError";
  }
}

export function handleServerError(error: unknown): {
  error: string;
  code?: string;
  details?: unknown;
} {
  if (error instanceof AppError) {
    return {
      error: error.message,
      code: error.code,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    console.error("Unhandled error:", error);
    return {
      error: "An unexpected error occurred",
      code: "INTERNAL_ERROR",
    };
  }

  return {
    error: "An unexpected error occurred",
    code: "UNKNOWN_ERROR",
  };
}

export function errorResponse(error: unknown): Response {
  const { error: message, code, details } = handleServerError(error);

  const responseObj: Record<string, unknown> = { error: message, code };
  if (details !== undefined) {
    responseObj.details = details;
  }

  return new Response(JSON.stringify(responseObj), {
    status: error instanceof AppError ? (error as AppError).statusCode : 500,
    headers: { "Content-Type": "application/json" },
  });
}

export async function tryCatch<T>(
  fn: () => Promise<T>,
  onError?: (error: unknown) => T,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (onError) {
      return onError(error);
    }
    throw error;
  }
}
