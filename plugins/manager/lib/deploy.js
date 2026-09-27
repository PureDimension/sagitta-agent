import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveDeployBindings } from "./bindings.js";
import { resolveCredentials } from "./credentials.js";
import { requestCloudflare, requestWorker } from "./request.js";

function sourceSha(source) {
  return createHash("sha256").update(source).digest("hex");
}

function profileDirFrom(ctx, config) {
  const configured = config.profileDir;
  const profileDir = configured ?? (typeof ctx?.dshHomePath === "function"
    ? ctx.dshHomePath("profiles", "web")
    : undefined);
  if (typeof profileDir !== "string" || profileDir.trim() === "") {
    throw new Error("sagitta-manager profile directory is unavailable");
  }
  return profileDir;
}

async function readDeploymentState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state === null || typeof state !== "object" || typeof state.sha !== "string" || state.sha === "") {
      throw new Error(`invalid sagitta deployment state: ${statePath}`);
    }
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function upload(config, source, accountId, request = requestCloudflare) {
  const moduleName = "worker.js";
  const referencePath = path.join(config.repoPath, "worker", "reference", "deploy.json");
  const bindings = await resolveDeployBindings(referencePath);
  const metadata = new Blob([JSON.stringify({ main_module: moduleName, bindings })], { type: "application/json" });
  const module = new File([source], moduleName, { type: "application/javascript+module" });
  const form = new FormData();
  form.append("metadata", metadata);
  form.append(moduleName, module);

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(config.scriptName)}`;
  const response = await request(config, url, { method: "PUT", body: form });
  const body = await response.json();
  if (body?.success !== true) throw new Error("Cloudflare Worker upload failed");
}

export async function deployWorker({
  ctx,
  config,
  requestCloudflare: cloudflareRequest = requestCloudflare,
  requestWorker: workerRequest = requestWorker
}) {
  if (config.repoPath === "") throw new Error("sagitta-manager repoPath is required for deployment");
  const sourcePath = path.join(config.repoPath, "worker", "worker.js");
  const source = await readFile(sourcePath, "utf8");
  const sha = sourceSha(source);
  const profileDir = profileDirFrom(ctx, config);
  const statePath = path.join(profileDir, ".sagitta-deployed.json");
  const previous = await readDeploymentState(statePath);
  if (previous?.sha === sha) return { status: "up-to-date" };

  if (typeof config.cfAccountId !== "string" || config.cfAccountId.trim() === "") {
    throw new Error("sagitta-manager cfAccountId is required for deployment");
  }
  const accountId = config.cfAccountId.trim();
  const credentials = await resolveCredentials(ctx, config);
  const transportConfig = { ...config, ...credentials };
  await upload(transportConfig, source, accountId, cloudflareRequest);
  await workerRequest(transportConfig, "/mem/health", { method: "GET" });
  await writeFile(statePath, `${JSON.stringify({ sha, deployedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return { status: "deployed", sha };
}
