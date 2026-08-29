import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

const name = "sagitta-manager";
const namespace = "sagitta-manager";
const inject = [];
const RESTART_UNAVAILABLE = "restart-unavailable";
const API_FIELDS = [
  "workerApiUrl",
  "workerUploadToken",
  "d1ReadToken",
  "d1WriteToken",
  "cfAccountId",
  "cfScriptName"
];

const secret = () => z.string().default("").role("secret");

export const Config = z.object({
  workerApiUrl: z.string().default("")
    .description("Sagitta Worker runtime API 根地址。"),
  workerUploadToken: secret()
    .description("Cloudflare Worker script upload token；仅 updater 使用。"),
  d1ReadToken: secret()
    .description("D1-backed API 读权限 token；memory/task 读操作使用。"),
  d1WriteToken: secret()
    .description("D1-backed API 写权限 token；memory/task 写操作使用。"),
  cfAccountId: z.string().default("")
    .description("Cloudflare 账户 ID；Worker direct PUT 部署元数据，非 secret。"),
  cfScriptName: z.string().default("")
    .description("Cloudflare Worker 脚本名；Worker direct PUT 部署元数据，非 secret。")
});

function emptyApiConfig() {
  return {
    workerApiUrl: "",
    workerUploadToken: "",
    d1ReadToken: "",
    d1WriteToken: "",
    cfAccountId: "",
    cfScriptName: ""
  };
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function configured(value) {
  return stringValue(value).trim().length > 0;
}

function safeLog(ctx, message) {
  try {
    const logger = ctx?.logger;
    if (typeof logger?.warn === "function") {
      logger.warn(message);
    }
  } catch {
    // Diagnostics must not turn an optional provider into a startup failure.
  }
}

/**
 * Host-side single source for Sagitta runtime configuration.
 *
 * The settings scope is deliberately optional. The service is published before
 * the provider injection runs, so memory/updater consumers can always resolve
 * the service and observe an empty configuration during provider absence.
 */
export class SagittaManagerService extends Service {
  constructor(ctx) {
    super(ctx, name);
    this.scope = undefined;
    this.scopeDisposer = undefined;
    this.listeners = new Set();
  }

  attachScope(scope) {
    if (this.scope === scope) return;
    this.clearScope(this.scope);
    this.scope = scope;
    if (typeof scope?.watch === "function") {
      this.scopeDisposer = scope.watch(() => this.notify());
    }
    this.notify();
  }

  clearScope(scope) {
    if (scope !== undefined && scope !== this.scope) return;
    this.scopeDisposer?.();
    this.scopeDisposer = undefined;
    if (scope === undefined || scope === this.scope) this.scope = undefined;
    this.notify();
  }

  hasScope() {
    return this.scope !== undefined;
  }

  readScope() {
    try {
      return this.scope?.get?.() ?? {};
    } catch {
      return {};
    }
  }

  /** Read the current resolved settings value, including secrets, in-process. */
  getApiConfig() {
    const current = this.readScope();
    const result = emptyApiConfig();
    for (const field of API_FIELDS) result[field] = stringValue(current[field]);
    return result;
  }

  /** Public-safe status projection; it never contains a token value. */
  getPublicStatus() {
    const current = this.getApiConfig();
    return {
      workerConfigured: configured(current.workerApiUrl),
      uploadConfigured: configured(current.workerUploadToken),
      d1ReadConfigured: configured(current.d1ReadToken),
      d1WriteConfigured: configured(current.d1WriteToken)
    };
  }

  /** Observe settings changes without passing secrets through the event API. */
  watchConfig(listener) {
    if (typeof listener !== "function") throw new TypeError("watchConfig listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        safeLog(this.ctx, "sagitta-manager: config listener failed", error);
      }
    }
  }

  /**
   * Return an adapter-backed memory client. Auth/header semantics stay with the
   * memory plugin because the design does not define D1 token headers here.
   */
  memoryClient(options = {}) {
    return this.createAdapterClient("memory", options);
  }

  /** Return an adapter-backed task client with the same single-source config. */
  taskClient(options = {}) {
    return this.createAdapterClient("task", options);
  }

  createAdapterClient(kind, options) {
    const request = options?.request;
    return {
      kind,
      getApiConfig: () => this.getApiConfig(),
      getPublicStatus: () => this.getPublicStatus(),
      request: (path, init) => {
        if (typeof request !== "function") {
          return Promise.reject(new Error(`sagitta-manager ${kind} client requires an adapter request`));
        }
        return request({
          kind,
          path,
          init,
          config: this.getApiConfig()
        });
      }
    };
  }

  /**
   * Updater-only upload seam. The caller supplies the already-verified upload
   * transport; this service does not guess Cloudflare endpoint semantics.
   */
  requestWorkerUpload(options = {}) {
    const request = options.request;
    if (typeof request !== "function") return { status: "upload-unavailable" };
    const current = this.getApiConfig();
    if (!configured(current.workerApiUrl) || !configured(current.workerUploadToken)) {
      return { status: "not-configured" };
    }
    return request({
      ...options,
      request: undefined,
      workerApiUrl: current.workerApiUrl,
      workerUploadToken: current.workerUploadToken
    });
  }

  /** No whole-process restart API is verified in the current DSH runtime. */
  requestHostRestart(_reason) {
    return RESTART_UNAVAILABLE;
  }
}

function optionalService(ctx, serviceName) {
  try {
    return typeof ctx?.get === "function" ? ctx.get(serviceName, false) : undefined;
  } catch {
    return undefined;
  }
}

/** Install the optional settings-backed manager service. */
export function apply(ctx, config) {
  const service = new SagittaManagerService(ctx);

  if (typeof ctx?.effect === "function") {
    ctx.effect(() => () => {
      service.clearScope();
      service.listeners.clear();
    }, "sagitta-manager: service cleanup");
  }

  if (typeof ctx?.inject === "function") {
    ctx.inject(["settings"], (settingsCtx) => {
      try {
        const scope = settingsCtx.settings.register(namespace, Config, { base: config });
        service.attachScope(scope);
        if (typeof settingsCtx.effect === "function") {
          settingsCtx.effect(() => () => service.clearScope(scope), "sagitta-manager: settings scope");
        }
      } catch (error) {
        safeLog(ctx, "sagitta-manager: settings provider registration failed; using empty status", error);
      }
    });
  }

  // A missing settings provider must not hold the plugin fiber or DSH startup.
  // Give a provider that is about to become available one microtask to publish.
  queueMicrotask(() => {
    if (!service.hasScope() && optionalService(ctx, "settings") === undefined) {
      safeLog(ctx, "sagitta-manager: settings provider unavailable; using empty status");
    }
  });
}

export function requestHostRestart(_reason) {
  return RESTART_UNAVAILABLE;
}

export {
  API_FIELDS,
  RESTART_UNAVAILABLE,
  inject,
  name,
  namespace
};
