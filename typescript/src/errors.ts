export class HushClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Non-2xx response. Messages omit response data, query strings, and credentials. */
export class APIError extends HushClientError {
  readonly detail: unknown;
  constructor(
    readonly statusCode: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
    readonly headers: Record<string, string | string[] | undefined>,
  ) {
    super(`HushClient returned HTTP ${statusCode} for ${method} ${path}`);
    this.detail = body && typeof body === "object" && "detail" in body ? body.detail : undefined;
  }
}

export class TransportError extends HushClientError {}
export class RequestTimeoutError extends TransportError {}
export class RequestAbortedError extends TransportError {}
export class ProtocolError extends HushClientError {}
export class SyncTimeoutError extends HushClientError {}

export class SyncFailedError extends HushClientError {
  constructor(readonly status: import("./models.js").SyncStatusResponse) {
    super("HushClient background sync failed; inspect status for details");
  }
}

