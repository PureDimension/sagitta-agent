import assert from "node:assert/strict";
import { apply, Config, SagittaManagerService } from "../lib/index.js";

const stored = {
  workerApiUrl: "https://worker.example.invalid",
  workerUploadToken: "smoke-upload-token",
  d1ReadToken: "smoke-read-token",
  d1WriteToken: "smoke-write-token",
  cfAccountId: "smoke-account-id",
  cfScriptName: "smoke-script-name"
};
let registerCall;
let service;
const warnings = [];

const context = {
  logger: {
    warn(message) {
      warnings.push(String(message));
    }
  },
  reflect: {
    provide(id, value) {
      if (id === "sagitta-manager") service = value;
    }
  },
  effect() {
    return () => {};
  },
  inject(_dependencies, callback) {
    callback({
      settings: {
        register(namespace, schema, options) {
          registerCall = { namespace, schema, options };
          return {
            get: () => stored,
            watch: () => () => {}
          };
        }
      },
      effect() {
        return () => {};
      }
    });
  },
  get(id) {
    return id === "settings" ? {} : undefined;
  }
};

apply(context, { workerApiUrl: "", workerUploadToken: "", d1ReadToken: "", d1WriteToken: "", cfAccountId: "", cfScriptName: "" });
assert.ok(service instanceof SagittaManagerService);
assert.equal(registerCall.namespace, "sagitta-manager");
assert.equal(registerCall.options.base.workerApiUrl, "");
assert.deepEqual(service.getApiConfig(), {
  workerApiUrl: stored.workerApiUrl,
  workerUploadToken: stored.workerUploadToken,
  d1ReadToken: stored.d1ReadToken,
  d1WriteToken: stored.d1WriteToken,
  cfAccountId: stored.cfAccountId,
  cfScriptName: stored.cfScriptName
});
stored.workerApiUrl = "https://worker-updated.example.invalid";
assert.equal(service.getApiConfig().workerApiUrl, stored.workerApiUrl);
assert.deepEqual(service.getPublicStatus(), {
  workerConfigured: true,
  uploadConfigured: true,
  d1ReadConfigured: true,
  d1WriteConfigured: true
});
assert.equal(JSON.stringify(service.getPublicStatus()).includes("smoke-"), false);
assert.equal(JSON.stringify(warnings).includes("smoke-"), false);
assert.equal(service.requestHostRestart("smoke"), "restart-unavailable");

let missingService;
const missingContext = {
  logger: context.logger,
  reflect: {
    provide(id, value) {
      if (id === "sagitta-manager") missingService = value;
    }
  },
  effect() {
    return () => {};
  },
  inject() {
    // No settings provider: the optional injection intentionally never runs.
  },
  get() {
    return undefined;
  }
};
apply(missingContext, {});
await Promise.resolve();
assert.deepEqual(missingService.getPublicStatus(), {
  workerConfigured: false,
  uploadConfigured: false,
  d1ReadConfigured: false,
  d1WriteConfigured: false
});
assert.equal(warnings.some((message) => message.includes("settings provider unavailable")), true);

const schemaJson = Config.toJSON();
const schemaText = JSON.stringify(schemaJson);
assert.equal((schemaText.match(/"role":"secret"/g) ?? []).length, 3);
assert.equal(schemaText.includes("cfAccountId"), true);
assert.equal(schemaText.includes("cfScriptName"), true);

console.log("manager smoke: PASS (registration, live reads, public redaction, secret schema roles)");
