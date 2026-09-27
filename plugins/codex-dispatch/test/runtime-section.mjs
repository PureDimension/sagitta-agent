import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

// The persona is static; the runtime section is its dynamic tail. This test
// drives the plugin with a stub context and proves the section re-reads the
// manager's live settings on every render — changing a setting must change what
// the model reads without a restart.
let model = "gpt-5.6-luna";
const sections = new Map();
const ctx = {
  tools: { register() {} },
  "sagitta-async-work": {
    register() {},
    listActive() { return []; },
    get() { return null; },
    complete() {},
    fail() {},
    cancel() {},
  },
  "sagitta-manager": {
    apiConfig: async () => ({ codexModel: model }),
    configSnapshot: () => ({ codexModel: model }),
  },
  systemPrompt: { section: (section) => sections.set(section.name, section) },
  logger: { warn() {} },
  on: () => () => {},
  effect: (factory) => { ctx.dispose = factory(); },
};

apply(ctx, {});
const section = sections.get("sagitta:runtime");
assert.ok(section, "the runtime prompt section must be registered");
assert.equal(section.text(), "codex 默认模型（来自 Sagitta Manager 设置）：gpt-5.6-luna");

model = "gpt-5.6-terra"; // simulate editing the setting in Settings
assert.equal(section.text(), "codex 默认模型（来自 Sagitta Manager 设置）：gpt-5.6-terra");

// A manager without the synchronous snapshot must fail loudly at activation
// rather than silently rendering a stale or empty line.
const broken = { ...ctx, "sagitta-manager": { apiConfig: async () => ({ codexModel: model }) } };
assert.throws(() => apply(broken, {}), /sagitta-manager 服务未加载或接口不完整/u);

console.log("codex-dispatch runtime section: PASS (dynamic per-render read, fail-loud without configSnapshot)");
