import { stat } from "node:fs/promises";
import path from "node:path";
import { normalizeUpdaterConfig } from "./config.js";
import { runUpdateCheck } from "./git.js";
import { installProfileDependencies } from "./install.js";
import { syncPreset } from "./preset.js";
import { deployWorker, resolveWorkerConfig } from "./worker.js";

const REQUIRED_REPOSITORY_DIRS = ["plugins", "presets", "worker", "scripts"];

function log(logger, level, message) {
  try {
    logger?.[level]?.(message);
  } catch {
    // Optional diagnostics must never affect startup.
  }
}

async function ensureRepositoryLayout(repoPath, fsOps = { stat }) {
  const missing = [];
  try {
    const root = await fsOps.stat(repoPath);
    if (!root.isDirectory()) missing.push(".");
  } catch {
    missing.push(".");
  }

  for (const directory of REQUIRED_REPOSITORY_DIRS) {
    try {
      const value = await fsOps.stat(path.join(repoPath, directory));
      if (!value.isDirectory()) missing.push(directory);
    } catch {
      missing.push(directory);
    }
  }

  return {
    status: missing.length === 0 ? "complete" : "incomplete",
    complete: missing.length === 0,
    missing,
    repoPath
  };
}

function managerFromContext(ctx, explicitManager) {
  return explicitManager || ctx?.["sagitta-manager"] || ctx?.sagittaManager;
}

function primaryRepositoryResult(config, results) {
  return results.find((result) => result.path === config.repoPath) || results[0];
}

/**
 * Run all best-effort startup maintenance steps. Each step is isolated so a
 * broken Git checkout, package manager, preset, manager setting, or Worker
 * never prevents the DSH process from remaining available.
 */
async function runStartupMaintenance({
  ctx,
  config: rawConfig,
  logger = ctx?.logger,
  env = process.env,
  git,
  install = installProfileDependencies,
  preset = syncPreset,
  deploy = deployWorker,
  layout = ensureRepositoryLayout,
  manager,
  restartBridge,
  presetOptions = {},
  workerOptions = {}
} = {}) {
  const config = normalizeUpdaterConfig(rawConfig || {}, env);
  const diagnostics = [];
  const report = (code, message, details = {}) => {
    diagnostics.push({ code, message, ...details });
    log(logger, "info", `@sagitta/updater: ${message}`);
  };

  let repositoryResults = [];
  try {
    repositoryResults = await runUpdateCheck(config.repos, logger, git);
  } catch {
    report("git-failed", "Git 更新步骤失败，已跳过");
  }
  const primary = primaryRepositoryResult(config, repositoryResults);
  const sourceChanged = repositoryResults.some((result) => result.status === "updated");
  for (const result of repositoryResults) {
    if (result.status === "skipped") {
      report("repository-update-skipped", `Git 更新已跳过（${result.reason || "unknown"}）`);
    }
  }

  let layoutResult;
  try {
    layoutResult = await layout(config.repoPath);
  } catch {
    layoutResult = { status: "incomplete", complete: false, missing: ["unknown"], repoPath: config.repoPath };
  }
  if (!layoutResult.complete) {
    report("repository-layout-incomplete", `目标仓库目录结构不完整，缺少：${layoutResult.missing.join(", ")}；不破坏现有文件`, {
      missing: layoutResult.missing
    });
  }

  let installResult = { status: "not-run", changed: false };
  if (sourceChanged && layoutResult.complete) {
    try {
      installResult = await install({
        profileDir: config.profileDir,
        repoPath: config.repoPath,
        profileName: config.profileName
      });
      if (installResult.status === "installed") report("profile-dependencies-installed", "profile 依赖已重新安装");
      if (installResult.status === "skipped") report("profile-install-skipped", "profile 依赖安装已跳过，下次启动重试");
    } catch {
      installResult = { status: "skipped", reason: "profile-install-failed", changed: false };
      report("profile-install-failed", "profile 依赖安装失败，已跳过");
    }
  }

  let presetResult = { status: "not-run", changed: false };
  try {
    presetResult = await preset({
      sourceDir: path.join(config.repoPath, "presets", config.presetId),
      targetDir: config.presetTarget,
      presetId: config.presetId,
      sourceCommit: primary?.sha,
      profileDir: config.profileDir,
      repoPath: config.repoPath,
      ...presetOptions
    });
    if (presetResult.status === "candidate") {
      report("preset-user-owned", "用户 preset 已修改，未覆盖；已写出 update candidate");
    } else if (presetResult.changed) {
      report("preset-synced", "Sagitta preset 已同步");
    } else if (presetResult.status === "skipped") {
      report("preset-sync-skipped", "preset 同步已跳过，下次启动重试");
    }
  } catch {
    presetResult = { status: "skipped", reason: "preset-sync-failed", changed: false };
    report("preset-sync-failed", "preset 同步失败，已跳过");
  }

  let apiConfig;
  const service = managerFromContext(ctx, manager);
  if (service && typeof service.getApiConfig === "function") {
    try {
      apiConfig = await service.getApiConfig();
    } catch {
      report("manager-config-failed", "Sagitta Manager 配置读取失败，Worker 将尝试使用环境变量配置");
    }
  } else {
    report("manager-unavailable", "Sagitta Manager service 不可用，Worker 将尝试使用环境变量配置");
  }

  const workerConfig = resolveWorkerConfig(apiConfig, env);
  let workerResult = { status: "not-run", changed: false };
  if (!config.workerUpdate) {
    workerResult = { status: "skipped", reason: "worker-update-disabled" };
    report("worker-update-disabled", "Worker 自动更新已关闭");
  } else if (!workerConfig.workerApiUrl || !workerConfig.workerUploadToken) {
    workerResult = { status: "skipped", reason: "manager-api-not-configured" };
    report("worker-not-configured", "Worker 未配置；请到 Plugins > Sagitta Manager 配置或设置环境变量");
  } else {
    try {
      workerResult = await deploy({
        repoPath: config.repoPath,
        ...workerConfig,
        workerConfigPath: config.workerConfigPath,
        env,
        ...workerOptions
      });
      if (workerResult.status === "deployed") report("worker-updated", "Worker 已更新并通过 health check");
      if (workerResult.status === "degraded") report("worker-health-failed", "Worker 上传完成但 health check 失败，下次启动重试");
      if (workerResult.status === "skipped") report("worker-update-skipped", "Worker 更新已跳过，下次启动重试");
    } catch {
      workerResult = { status: "skipped", reason: "worker-update-failed" };
      report("worker-update-failed", "Worker 更新失败，下次启动重试");
    }
  }

  const changed = sourceChanged || Boolean(installResult.changed) || Boolean(presetResult.changed);
  let restartResult = { status: "not-needed" };
  if (changed) {
    if (config.restartPolicy === "auto-if-verified" && typeof restartBridge === "function") {
      try {
        await restartBridge("sagitta-updater maintenance completed");
        restartResult = { status: "requested" };
        report("restart-requested", "已调用经过验证的 DSH 整树重启桥");
      } catch {
        restartResult = { status: "unavailable" };
        report("restart-unavailable", "整树重启桥不可用，请手动执行 dsh --profile web");
      }
    } else {
      restartResult = { status: "prompt" };
      report("restart-prompt", "插件/preset 已更新；请手动执行 dsh --profile web 使其生效");
    }
  }

  return {
    status: "completed",
    config,
    repositoryResults,
    layout: layoutResult,
    install: installResult,
    preset: presetResult,
    worker: workerResult,
    restart: restartResult,
    changed,
    diagnostics
  };
}

export {
  REQUIRED_REPOSITORY_DIRS,
  ensureRepositoryLayout,
  managerFromContext,
  runStartupMaintenance
};
