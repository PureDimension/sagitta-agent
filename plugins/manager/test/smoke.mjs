import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { apply, Config } from "../lib/index.js";
import { resolveDeployBindings } from "../lib/bindings.js";
import { deployWorker } from "../lib/deploy.js";

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the background deployment");
}

function makeContext(config, values, profileDir) {
  let service;
  const settings = {
    register(namespace, schema) {
      assert.equal(namespace, "sagitta-manager");
      assert.ok(schema);
      return {
        get: () => config,
        watch: () => () => {}
      };
    }
  };
  const credentials = {
    async resolve(ref) {
      const value = values[ref];
      return value === undefined ? undefined : { value, source: "file" };
    }
  };
  const ctx = {
    settings,
    credentials,
    logger: { info() {}, warn() {}, error() {} },
    reflect: {
      provide(id, value) {
        if (id === "sagitta-manager") service = value;
      }
    },
    effect() {
      return () => {};
    },
    inject(_dependencies, callback) {
      return callback({
        settings,
        effect() {
          return () => {};
        }
      });
    }
  };
  if (profileDir !== undefined) ctx.dshHomePath = () => profileDir;
  return { ctx, getService: () => service };
}

const schemaText = JSON.stringify(Config.toJSON());
for (const field of [
  "workerApiUrl", "proxy", "scriptName", "cfAccountId", "repoPath", "codexModel",
  "accessIdRef", "accessSecretRef", "uploadTokenRef"
]) assert.match(schemaText, new RegExp(field));
assert.match(schemaText, /SAGITTA_ACCESS_ID/);
assert.match(schemaText, /SAGITTA_ACCESS_SECRET/);
assert.match(schemaText, /SAGITTA_UPLOAD_TOKEN/);
assert.match(schemaText, /gpt-5\.6-luna/);

const credentialValues = {
  SAGITTA_ACCESS_ID: "default-access-id",
  SAGITTA_ACCESS_SECRET: "default-access-secret",
  SAGITTA_UPLOAD_TOKEN: "default-upload-token",
  SMOKE_ACCESS_ID: "smoke-access-id",
  SMOKE_ACCESS_SECRET: "smoke-access-secret",
  SMOKE_UPLOAD_TOKEN: "smoke-upload-token"
};
const requestConfig = {
  workerApiUrl: "https://worker.example.invalid",
  proxy: "",
  scriptName: "sagitta-memory",
  cfAccountId: "smoke-account-id",
  repoPath: "",
  codexModel: "smoke-model",
  accessIdRef: "SAGITTA_ACCESS_ID",
  accessSecretRef: "SAGITTA_ACCESS_SECRET",
  uploadTokenRef: "SAGITTA_UPLOAD_TOKEN"
};
const requestContext = makeContext(requestConfig, credentialValues);
await apply(requestContext.ctx, requestConfig);
const requestService = requestContext.getService();
assert.deepEqual(await requestService.apiConfig(), {
  workerApiUrl: requestConfig.workerApiUrl,
  proxy: requestConfig.proxy,
  scriptName: requestConfig.scriptName,
  cfAccountId: requestConfig.cfAccountId,
  repoPath: requestConfig.repoPath,
  codexModel: requestConfig.codexModel,
  accessId: credentialValues.SAGITTA_ACCESS_ID,
  accessSecret: credentialValues.SAGITTA_ACCESS_SECRET,
  uploadToken: credentialValues.SAGITTA_UPLOAD_TOKEN
});
requestConfig.accessIdRef = "SMOKE_ACCESS_ID";
requestConfig.accessSecretRef = "SMOKE_ACCESS_SECRET";
requestConfig.uploadTokenRef = "SMOKE_UPLOAD_TOKEN";
assert.deepEqual(await requestService.apiConfig(), {
  workerApiUrl: requestConfig.workerApiUrl,
  proxy: requestConfig.proxy,
  scriptName: requestConfig.scriptName,
  cfAccountId: requestConfig.cfAccountId,
  repoPath: requestConfig.repoPath,
  codexModel: requestConfig.codexModel,
  accessId: credentialValues.SMOKE_ACCESS_ID,
  accessSecret: credentialValues.SMOKE_ACCESS_SECRET,
  uploadToken: credentialValues.SMOKE_UPLOAD_TOKEN
});
const emptyCredentialContext = makeContext({ ...requestConfig, accessIdRef: "EMPTY" }, { ...credentialValues, EMPTY: "" });
await apply(emptyCredentialContext.ctx, requestConfig);
await assert.rejects(() => emptyCredentialContext.getService().apiConfig(), /credential is empty: EMPTY/);
console.log("apiConfig returns 9 fields and configurable credential refs: PASS");

const failedDeployContext = makeContext({ ...requestConfig, repoPath: "missing-manager-smoke-repository" }, credentialValues);
const deploymentWarnings = [];
failedDeployContext.ctx.logger.warn = (...args) => deploymentWarnings.push(args);
await apply(failedDeployContext.ctx, requestConfig);
await waitFor(() => deploymentWarnings.length === 1);
assert.equal(deploymentWarnings.length, 1);
assert.match(deploymentWarnings[0][0], /automatic deployment failed; settings remain available/);
assert.equal((await failedDeployContext.getService().apiConfig()).workerApiUrl, requestConfig.workerApiUrl);
await assert.rejects(() => failedDeployContext.getService().deployWorker(), /ENOENT/);
console.log("background startup deployment failure preserves settings; explicit deployment still rejects: PASS");

const proxyConnections = [];
const proxy = net.createServer((socket) => {
  let request = "";
  socket.on("data", (chunk) => {
    request += chunk.toString("latin1");
    if (request.includes("\r\n\r\n")) {
      proxyConnections.push(request.split("\r\n", 1)[0]);
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
    }
  });
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = proxy.address().port;
const proxyConfig = { ...requestConfig, proxy: `http://127.0.0.1:${proxyPort}` };
const proxyContext = makeContext(proxyConfig, credentialValues);
await apply(proxyContext.ctx, proxyConfig);
await assert.rejects(() => proxyContext.getService().request("/mem/health"), /proxy CONNECT failed/);
assert.deepEqual(proxyConnections, ["CONNECT worker.example.invalid:443 HTTP/1.1"]);
await new Promise((resolve) => proxy.close(resolve));
console.log("request CONNECT tunnel branch: PASS");

const workerRoot = await mkdtemp(path.join(os.tmpdir(), "sagitta-manager-smoke-worker-"));
const profileDir = await mkdtemp(path.join(os.tmpdir(), "sagitta-manager-smoke-profile-"));
const previousSmokeSecret = process.env.SMOKE_SECRET;
process.env.SMOKE_SECRET = "secret-from-env";
let health;
try {
  await mkdir(path.join(workerRoot, "worker", "reference"), { recursive: true });
  const source = "export default {};\n";
  await writeFile(path.join(workerRoot, "worker", "worker.js"), source);
  const referencePath = path.join(workerRoot, "worker", "reference", "deploy.json");
  await writeFile(referencePath, JSON.stringify({ bindings: [
    { name: "MEMORY_SECRET", type: "secret_text", fromEnv: "SMOKE_SECRET" },
    { name: "MEMORY_DB", type: "d1", id: "smoke-d1-id" },
    { name: "GENERATED_SECRET", type: "secret_text", generate: true }
  ] }));
  const bindings = await resolveDeployBindings(referencePath, { SMOKE_SECRET: "secret-from-env" });
  assert.deepEqual(bindings.slice(0, 2), [
    { name: "MEMORY_SECRET", type: "secret_text", text: "secret-from-env" },
    { name: "MEMORY_DB", type: "d1", id: "smoke-d1-id" }
  ]);
  assert.match(bindings[2].text, /^[0-9a-f]{64}$/);
  await assert.rejects(() => resolveDeployBindings(path.join(workerRoot, "missing-deploy.json")), /ENOENT/);
  await writeFile(referencePath, JSON.stringify({}));
  await assert.rejects(() => resolveDeployBindings(referencePath), /no bindings array/);
  await writeFile(referencePath, JSON.stringify({ bindings: [
    { name: "MEMORY_SECRET", type: "secret_text", fromEnv: "SMOKE_SECRET" },
    { name: "MEMORY_DB", type: "d1", id: "smoke-d1-id" },
    { name: "GENERATED_SECRET", type: "secret_text", generate: true }
  ] }));
  console.log("deploy bindings resolution and strict reference errors: PASS");

  const sha = createHash("sha256").update(source).digest("hex");
  const deployConfig = {
    ...requestConfig,
    workerApiUrl: "http://127.0.0.1:0",
    proxy: "",
    repoPath: workerRoot
  };
  await writeFile(path.join(profileDir, ".sagitta-deployed.json"), JSON.stringify({ sha, deployedAt: "2026-09-27T00:00:00.000Z" }));
  let unexpectedHealthCall = false;
  const upToDate = await deployWorker({
    ctx: makeContext(deployConfig, credentialValues, profileDir).ctx,
    config: deployConfig,
    requestWorker: async () => { unexpectedHealthCall = true; },
    requestCloudflare: async () => { throw new Error("upload must not run for equal sha"); }
  });
  assert.deepEqual(upToDate, { status: "up-to-date" });
  assert.equal(unexpectedHealthCall, false);
  console.log("deploy sha branch: PASS ({ status: 'up-to-date' })");

  await writeFile(path.join(profileDir, ".sagitta-deployed.json"), JSON.stringify({ sha: "old-sha", deployedAt: "2026-09-26T00:00:00.000Z" }));
  health = http.createServer((request, response) => {
    assert.equal(request.url, "/mem/health");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => health.listen(0, "127.0.0.1", resolve));
  deployConfig.workerApiUrl = `http://127.0.0.1:${health.address().port}`;
  let uploadMetadata;
  const deployed = await deployWorker({
    ctx: makeContext(deployConfig, credentialValues, profileDir).ctx,
    config: deployConfig,
    requestCloudflare: async (_config, url, init) => {
      assert.match(url, /accounts\/smoke-account-id\/workers\/scripts\/sagitta-memory$/);
      uploadMetadata = JSON.parse(await init.body.get("metadata").text());
      assert.equal(init.body.get("worker.js").name, "worker.js");
      return { json: async () => ({ success: true }) };
    }
  });
  assert.deepEqual(deployed, { status: "deployed", sha });
  assert.equal(uploadMetadata.main_module, "worker.js");
  assert.deepEqual(uploadMetadata.bindings.slice(0, 2), [
    { name: "MEMORY_SECRET", type: "secret_text", text: "secret-from-env" },
    { name: "MEMORY_DB", type: "d1", id: "smoke-d1-id" }
  ]);
  const storedState = JSON.parse(await readFile(path.join(profileDir, ".sagitta-deployed.json"), "utf8"));
  assert.equal(storedState.sha, sha);
  console.log("deploy sha branch: PASS ({ status: 'deployed', sha })");
  console.log("manager smoke: PASS");
} finally {
  if (health !== undefined) await new Promise((resolve) => health.close(resolve));
  if (previousSmokeSecret === undefined) delete process.env.SMOKE_SECRET;
  else process.env.SMOKE_SECRET = previousSmokeSecret;
  await rm(workerRoot, { recursive: true, force: true });
  await rm(profileDir, { recursive: true, force: true });
}
