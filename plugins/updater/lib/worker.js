import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

async function execCommand(command, args, options = {}) {
  return execFileAsync(command, args, {
    windowsHide: true,
    timeout: WORKER_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
    ...options
  });
}

function nonEmptyString(value) {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result ? result : undefined;
}

function parseTomlString(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m"));
  return match?.[1]?.trim() || undefined;
}

function parseWorkerConfig(text) {
  const name = parseTomlString(text, "name");
  const main = parseTomlString(text, "main");
  return {
    name,
    main,
    hasPlaceholders: /REPLACE_WITH_|YOUR_|<[^>]+>/i.test(text)
  };
}

function workerSourcePath(repoPath) {
  return path.join(repoPath, "worker", "worker.js");
}

function deployReferencePath(repoPath) {
  return path.join(repoPath, "worker", "reference", "deploy.json");
}

/**
 * 从 worker/reference/deploy.json 构建 multipart metadata 的 bindings。
 * secret_text：fromEnv 有值则用；标记 generate 时缺失则随机生成（绝不落日志）。
 * 返回 undefined 表示 reference 缺失（调用方回退纯 JS PUT 并告警）；否则抛错表示配置非法。
 */
async function resolveDeployBindings(deployReferencePath, env = process.env) {
  let reference;
  try {
    reference = JSON.parse(await readFile(deployReferencePath, "utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(reference.bindings)) return [];
  const bindings = [];
  for (const binding of reference.bindings) {
    if (binding?.type === "secret_text") {
      let value = typeof binding.fromEnv === "string" ? nonEmptyString(env[binding.fromEnv]) : undefined;
      if (!value && binding.generate === true) value = randomBytes(32).toString("hex");
      if (!value) {
        throw new Error(`secret binding ${binding.name} 无值（fromEnv 未配置且未标记 generate）`);
      }
      bindings.push({ name: binding.name, type: "secret_text", text: value });
    } else if (binding?.type === "d1") {
      if (!nonEmptyString(binding.id)) throw new Error(`d1 binding ${binding.name} 缺少 id`);
      bindings.push({ name: binding.name, type: "d1", id: binding.id });
    } else {
      throw new Error(`未知 binding 类型 ${binding?.type}`);
    }
  }
  return bindings;
}

function directUploadUrl(accountId, scriptName) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`;
}

function healthUrl(workerApiUrl) {
  return `${workerApiUrl.replace(/\/+$/, "")}/mem/health`;
}

function sourceSha(source) {
  return createHash("sha256").update(source).digest("hex");
}

async function responseIsOk(response) {
  if (!response || response.ok !== true) return false;
  if (typeof response.json !== "function") return true;
  try {
    const body = await response.json();
    return !body || body.success !== false;
  } catch {
    // Some simple HTTP mocks and successful empty responses have no JSON body.
    return true;
  }
}

async function healthResponseIsOk(response) {
  if (!response || response.ok !== true || typeof response.json !== "function") return false;
  try {
    const body = await response.json();
    // New workers report the configured verifier as auth_mode (auth_token or
    // d1); keep auth_token=true as a compatibility path for older workers.
    const authMode = body?.env?.auth_mode;
    const authConfigured = authMode === "auth_token" || authMode === "d1"
      ? true
      : authMode === undefined && body?.env?.auth_token === true;
    return body?.ok === true &&
      typeof body.version === "string" && body.version.length > 0 &&
      body.env?.db === true && authConfigured;
  } catch {
    return false;
  }
}

async function runWrangler({ repoPath, workerConfigPath, exec = execCommand }) {
  const executable = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  await exec(executable, ["deploy", "--config", workerConfigPath], {
    cwd: repoPath,
    windowsHide: true,
    timeout: WORKER_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8"
  });
  return { status: "deployed", mode: "wrangler" };
}

function resolveWorkerConfig(config = {}, env = process.env) {
  return {
    workerApiUrl: nonEmptyString(config?.workerApiUrl) || nonEmptyString(env?.SAGITTA_WORKER_API_URL),
    workerUploadToken: nonEmptyString(config?.workerUploadToken) || nonEmptyString(env?.CLOUDFLARE_API_TOKEN),
    accountId: nonEmptyString(config?.accountId ?? config?.cfAccountId) || nonEmptyString(env?.CF_ACCOUNT_ID),
    scriptName: nonEmptyString(config?.scriptName ?? config?.cfScriptName) || nonEmptyString(env?.CF_SCRIPT_NAME)
  };
}

/**
 * Upload worker/worker.js with direct PUT, with Wrangler as an explicit
 * fallback for bindings/configuration that direct script upload cannot carry.
 * No credentials are read from updater Config; the upload token is supplied by
 * the manager service and account id is non-secret environment metadata.
 */
async function deployWorker({
  repoPath,
  workerApiUrl,
  workerUploadToken,
  workerConfigPath,
  workerSourcePath: sourcePath = workerSourcePath(repoPath),
  env = process.env,
  accountId,
  scriptName,
  request = globalThis.fetch,
  exec = execCommand,
  allowWranglerFallback = true,
  healthCheck = true
}) {
  const workerConfig = resolveWorkerConfig({ workerApiUrl, workerUploadToken, accountId, scriptName }, env);
  const apiUrl = workerConfig.workerApiUrl;
  const uploadToken = workerConfig.workerUploadToken;
  if (!apiUrl || !uploadToken) {
    return { status: "skipped", reason: "manager-api-not-configured" };
  }
  if (typeof request !== "function") {
    return { status: "skipped", reason: "fetch-unavailable" };
  }

  const configPath = workerConfigPath || path.join(repoPath, "worker", "wrangler.toml.example");
  let source;
  let deploymentConfig;
  try {
    source = await readFile(sourcePath, "utf8");
    deploymentConfig = parseWorkerConfig(await readFile(configPath, "utf8"));
  } catch {
    return { status: "skipped", reason: "worker-source-or-config-missing" };
  }

  const resolvedAccountId = workerConfig.accountId;
  const configuredScriptName = workerConfig.scriptName;
  const resolvedScriptName = configuredScriptName || (deploymentConfig.hasPlaceholders ? undefined : deploymentConfig.name);
  let directFailure = false;

  if (resolvedAccountId && resolvedScriptName) {
    try {
      const url = directUploadUrl(resolvedAccountId, resolvedScriptName);
      const headers = { Authorization: `Bearer ${uploadToken}` };
      let body;
      // multipart PUT（metadata + 模块 part）：携带 D1/secret bindings，避免清空线上绑定。
      // part 名 = 模块文件名；content-type 必须 application/javascript+module（CF 对 module 格式的硬要求）；
      // metadata.main_module 引用同一 part 名（官方 multipart 契约，缺任一都会 10021）。
      // reference 缺失时回退纯 JS PUT（旧行为），但告警提示部署可能丢失 bindings。
      const bindings = await resolveDeployBindings(deployReferencePath(repoPath), env);
      if (bindings) {
        const moduleName = path.basename(sourcePath);
        const metadata = { main_module: moduleName, bindings };
        const form = new FormData();
        form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
        // 必须用 File（不是 Blob）：CF 要求模块 part 带 filename（Content-Disposition: ... filename=...），
        // Blob part 无 filename 会 10021。content-type 必须是 application/javascript+module。
        form.append(moduleName, new File([source], moduleName, { type: "application/javascript+module" }));
        body = form;
      } else {
        headers["Content-Type"] = "application/javascript";
        body = source;
      }
      const response = await request(url, { method: "PUT", headers, body });
      if (!await responseIsOk(response)) throw new Error("cloudflare-upload-failed");
    } catch {
      directFailure = true;
    }
  }

  let deployment;
  if (!directFailure && resolvedAccountId && resolvedScriptName) {
    deployment = { status: "deployed", mode: "direct", scriptName: resolvedScriptName, sha: sourceSha(source) };
  } else if (allowWranglerFallback && !deploymentConfig.hasPlaceholders) {
    try {
      deployment = await runWrangler({ repoPath, workerConfigPath: configPath, exec });
      deployment = { ...deployment, sha: sourceSha(source) };
    } catch {
      return { status: "skipped", reason: directFailure ? "direct-and-wrangler-failed" : "deployment-metadata-missing" };
    }
  } else {
    return {
      status: "skipped",
      reason: directFailure ? "direct-upload-failed" : "deployment-metadata-missing"
    };
  }

  if (!healthCheck) return deployment;
  try {
    const response = await request(healthUrl(apiUrl), { method: "GET" });
    if (!await healthResponseIsOk(response)) {
      return { ...deployment, status: "degraded", reason: "health-check-failed" };
    }
    return { ...deployment, health: "ok" };
  } catch {
    return { ...deployment, status: "degraded", reason: "health-check-failed" };
  }
}

export {
  WORKER_TIMEOUT_MS,
  deployReferencePath,
  deployWorker,
  directUploadUrl,
  execCommand,
  healthResponseIsOk,
  healthUrl,
  parseTomlString,
  parseWorkerConfig,
  resolveDeployBindings,
  resolveWorkerConfig,
  runWrangler,
  sourceSha,
  workerSourcePath
};
