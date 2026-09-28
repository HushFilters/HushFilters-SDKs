import { createHash } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import {
  APIError, HushClientError, ProtocolError, RequestAbortedError, RequestTimeoutError,
  SyncFailedError, SyncTimeoutError, TransportError,
} from "./errors.js";
import type * as Models from "./models.js";

export interface HushClientOptions {
  baseUrl?: string;
  /** Total request deadline in milliseconds; defaults to 30000. */
  timeoutMs?: number;
  /** Defaults to true. Disable only for explicit local development. */
  verifyTls?: boolean;
  /** PEM contents, not a file path. Supports self-signed/private certificates. */
  ca?: string | Buffer | Array<string | Buffer>;
  headers?: Record<string, string>;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WaitForSyncOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

/** SHA256(UTF8(username + 'nWebbed' + password)), without normalization. */
export function credentialHash(username: string, password = ""): string {
  return createHash("sha256").update(username + "nWebbed" + password, "utf8").digest("hex");
}

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be positive and at most 2147483647 milliseconds`);
  }
}

/** Promise-based Node.js client; no runtime dependencies, redirects, or retries. */
export class HushClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly verifyTls: boolean;
  private readonly ca: HushClientOptions["ca"];
  private readonly headers: Record<string, string>;

  constructor(options: HushClientOptions = {}) {
    const url = new URL(options.baseUrl ?? "https://localhost");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError("baseUrl must be an HTTP(S) URL without credentials, query, or fragment");
    }
    this.baseUrl = url.href.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    positive(this.timeoutMs, "timeoutMs");
    this.verifyTls = options.verifyTls ?? true;
    this.ca = options.ca;
    if (!this.verifyTls && this.ca !== undefined) {
      throw new TypeError("ca cannot be combined with verifyTls=false");
    }
    this.headers = { accept: "application/json", "user-agent": "hushclient-node/0.1.0" };
    for (const [key, value] of Object.entries(options.headers ?? {})) this.headers[key.toLowerCase()] = value;
  }

  private async request<T>(method: string, path: string, body?: unknown,
    options: RequestOptions = {}, query?: Record<string, string>): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    positive(timeoutMs, "timeoutMs");
    if (options.signal?.aborted) throw new RequestAbortedError("HushClient request aborted");
    const url = new URL(this.baseUrl + path);
    if (query) url.search = new URLSearchParams(query).toString();
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const headers = { ...this.headers };
    if (data) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(data.length);
    }
    return new Promise<T>((resolve, reject) => {
      const send = url.protocol === "https:" ? https.request : http.request;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (error?: Error, payload?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(payload as T);
      };
      const req = send(url, {
        method, headers, agent: false,
        rejectUnauthorized: this.verifyTls, ca: this.ca,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", () => done(new TransportError(`HushClient response interrupted for ${method} ${path}`)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let payload: unknown;
          try { payload = JSON.parse(text); } catch { payload = text; }
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            done(new APIError(status, method, path, payload, res.headers));
          } else if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
            done(new ProtocolError(`Expected a JSON object for ${method} ${path}`));
          } else {
            done(undefined, payload as T);
          }
        });
      });
      const abort = () => {
        const error = new RequestAbortedError(`HushClient request aborted for ${method} ${path}`);
        done(error);
        req.destroy(error);
      };
      req.on("error", (error: Error) => done(error instanceof HushClientError ? error :
        new TransportError(`HushClient connection failed for ${method} ${path}`)));
      options.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        const error = new RequestTimeoutError(`HushClient request timed out for ${method} ${path}`);
        done(error);
        req.destroy(error);
      }, timeoutMs);
      req.end(data);
    });
  }

  info(options?: RequestOptions): Promise<Models.RootResponse> { return this.request("GET", "/endpoints", undefined, options); }
  health(options?: RequestOptions): Promise<Models.HealthResponse> { return this.request("GET", "/health", undefined, options); }
  stats(options?: RequestOptions): Promise<Models.StatsResponse> { return this.request("GET", "/stats", undefined, options); }
  check(username: string, password = "", options?: RequestOptions): Promise<Models.CheckResponse> {
    return this.request("POST", "/check", { username, password }, options);
  }
  /** GET compatibility endpoint: credentials may appear in server access logs. */
  checkGet(username: string, password = "", options?: RequestOptions): Promise<Models.CheckResponse> {
    return this.request("GET", "/check", undefined, options, { username, password });
  }
  checkBatch(credentials: ReadonlyArray<Models.CheckRequest>, options?: RequestOptions): Promise<Models.BatchCheckResponse> {
    return this.request("POST", "/check/batch", { credentials }, options);
  }
  checkHash(hash: string, options?: RequestOptions): Promise<Models.CheckResponse> {
    return this.request("POST", "/checkhash", { hash }, options);
  }
  checkHashBatch(hashes: ReadonlyArray<string>, options?: RequestOptions): Promise<Models.BatchHashCheckResponse> {
    return this.request("POST", "/checkhash/batch", { hashes }, options);
  }
  /** Starts a background refresh (202); call waitForSync to wait for completion. */
  syncApply(options?: RequestOptions): Promise<Models.SyncApplyStartResponse> {
    return this.request("POST", "/sync/apply", undefined, options);
  }
  syncFilters(options?: RequestOptions): Promise<Models.SyncFiltersResponse> {
    return this.request("POST", "/sync/filters", undefined, options);
  }
  updateManifest(options?: RequestOptions): Promise<Models.ManifestUpdateResponse> {
    return this.request("POST", "/sync/manifest", undefined, options);
  }
  reloadFilters(options?: RequestOptions): Promise<Models.ReloadFiltersResponse> {
    return this.request("POST", "/sync/reload", undefined, options);
  }
  syncStatus(options?: RequestOptions): Promise<Models.SyncStatusResponse> {
    return this.request("GET", "/sync/status", undefined, options);
  }
  autoUpdateStatus(options?: RequestOptions): Promise<Models.AutoUpdateStatusResponse> {
    return this.request("GET", "/sync/auto-update", undefined, options);
  }
  /** Persists schedule settings. The hour uses the container's local timezone. */
  configureAutoUpdate(enabled: boolean, hour: number | null = null, options?: RequestOptions): Promise<Models.AutoUpdateStatusResponse> {
    return this.request("PUT", "/sync/auto-update", { enabled, hour }, options);
  }

  /** Polls global status; does not start or cancel a sync. The API has no job IDs. */
  async waitForSync(options: WaitForSyncOptions = {}): Promise<Models.SyncStatusResponse> {
    const timeoutMs = options.timeoutMs ?? 3_600_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    positive(timeoutMs, "timeoutMs");
    positive(pollIntervalMs, "pollIntervalMs");
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new SyncTimeoutError("Timed out waiting for sync; the server operation was not cancelled");
      const status = await this.syncStatus({ timeoutMs: Math.min(this.timeoutMs, remaining), signal: options.signal });
      if (!status.active) {
        if (status.success === false) throw new SyncFailedError(status);
        return status;
      }
      try {
        await sleep(Math.max(0, Math.min(pollIntervalMs, deadline - performance.now())), undefined, { signal: options.signal });
      } catch {
        throw new RequestAbortedError("HushClient sync wait aborted; the server operation was not cancelled");
      }
    }
  }
}
