import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createHash } from "node:crypto";

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
    return body?.ok === true &&
      typeof body.version === "string" && body.version.length > 0 &&
      body.env?.db === true && body.env?.auth_token === true;
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
  const apiUrl = nonEmptyString(workerApiUrl) || nonEmptyString(env?.SAGITTA_WORKER_API_URL);
  const uploadToken =
    nonEmptyString(workerUploadToken) || nonEmptyString(env?.CLOUDFLARE_API_TOKEN);
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

  const resolvedAccountId = nonEmptyString(accountId) || nonEmptyString(env?.CF_ACCOUNT_ID);
  const resolvedScriptName = nonEmptyString(scriptName) || deploymentConfig.name;
  let directFailure = false;

  if (resolvedAccountId && resolvedScriptName) {
    try {
      const response = await request(directUploadUrl(resolvedAccountId, resolvedScriptName), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "Content-Type": "application/javascript"
        },
        body: source
      });
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
  deployWorker,
  directUploadUrl,
  execCommand,
  healthResponseIsOk,
  healthUrl,
  parseTomlString,
  parseWorkerConfig,
  runWrangler,
  sourceSha,
  workerSourcePath
};
