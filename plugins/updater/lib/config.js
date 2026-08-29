import path from "node:path";
import z from "@deepseek-ai/schemastery";

const DEFAULT_REPO_PATH = "D:\\workspace\\sagitta-agent";
const DEFAULT_BRANCH = "main";
const DEFAULT_PROFILE_NAME = "web";
const DEFAULT_PRESET_ID = "sagitta";
const DEFAULT_RESTART_POLICY = "prompt";

function nonEmptyString(value) {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > 0 ? result : undefined;
}

function resolveDshHome(env = process.env) {
  return nonEmptyString(env?.DSH_HOME) ||
    path.join(nonEmptyString(env?.USERPROFILE) || nonEmptyString(env?.HOME) || process.cwd(), ".dsh");
}

function defaultProfileDir(env = process.env, profileName = DEFAULT_PROFILE_NAME) {
  return path.join(resolveDshHome(env), "profiles", profileName);
}

function defaultPresetTarget(env = process.env, presetId = DEFAULT_PRESET_ID) {
  return path.join(resolveDshHome(env), ".agent-presets", presetId);
}

function defaultWorkerConfigPath(repoPath = DEFAULT_REPO_PATH) {
  return path.join(repoPath, "worker", "wrangler.toml.example");
}

const RepoConfig = z.object({
  path: z.string().description("要检查的 Git 仓库路径。"),
  branch: z.string().default(DEFAULT_BRANCH).description("远端分支名。")
});

const Config = z.object({
  // Canonical v2 fields.
  repoPath: z.string().default(DEFAULT_REPO_PATH).description("Sagitta agent 目标仓库路径。"),
  branch: z.string().default(DEFAULT_BRANCH).description("要跟踪的 origin 分支。"),
  profile: z.string().default(DEFAULT_PROFILE_NAME).description("DSH profile 名称。"),
  profileName: z.string().default(DEFAULT_PROFILE_NAME).description("DSH profile 名称（profile 的兼容别名）。"),
  presetId: z.string().default(DEFAULT_PRESET_ID).description("要同步的 preset id。"),
  presetTarget: z.string().default(defaultPresetTarget()).description("用户 preset 目标目录。"),
  profileDir: z.string().default(defaultProfileDir()).description("DSH profile 目录。"),
  workerConfigPath: z.string().default(defaultWorkerConfigPath()).description("Worker Wrangler/reference 配置路径。"),
  workerUpdate: z.boolean().default(true).description("有完整 manager API 配置时是否更新 Worker。"),
  workerDeploy: z.boolean().default(true).description("workerUpdate 的兼容别名。"),
  restartPolicy: z.union([
    z.const("auto-if-verified"),
    z.const("prompt")
  ]).default(DEFAULT_RESTART_POLICY).description("更新后重启策略。"),

  // v0.1.0 compatibility fields. `repos` remains useful for an additional
  // repository, while the first entry is used as the primary repository when
  // no canonical repoPath is supplied.
  path: z.string().default(DEFAULT_REPO_PATH).description("旧版 repoPath 兼容字段。"),
  repos: z.array(RepoConfig).default([]).description("旧版多仓库兼容配置。")
});

function chooseProfileName(config) {
  const profile = nonEmptyString(config?.profile);
  const profileName = nonEmptyString(config?.profileName);

  // Schemastery supplies defaults for both aliases. Prefer the value that was
  // actually customized when one alias is still the default.
  if (profile && profile !== DEFAULT_PROFILE_NAME && profileName === DEFAULT_PROFILE_NAME) return profile;
  if (profileName && profileName !== DEFAULT_PROFILE_NAME && profile === DEFAULT_PROFILE_NAME) return profileName;
  return profile || profileName || DEFAULT_PROFILE_NAME;
}

function normalizeRepos(config = {}) {
  if (Array.isArray(config.repos) && config.repos.length > 0) {
    return config.repos
      .map((repo) => ({
        path: nonEmptyString(repo?.path),
        branch: nonEmptyString(repo?.branch) || nonEmptyString(config.branch) || DEFAULT_BRANCH
      }))
      .filter((repo) => repo.path !== undefined);
  }

  const canonicalPath = nonEmptyString(config.repoPath);
  const legacyPath = nonEmptyString(config.path);
  const pathValue = canonicalPath &&
    (canonicalPath !== DEFAULT_REPO_PATH || !legacyPath || legacyPath === DEFAULT_REPO_PATH)
    ? canonicalPath
    : legacyPath;
  return [{
    path: pathValue || DEFAULT_REPO_PATH,
    branch: nonEmptyString(config.branch) || DEFAULT_BRANCH
  }];
}

function normalizeUpdaterConfig(config = {}, env = process.env) {
  const repos = normalizeRepos(config);
  const repoPath = repos[0]?.path || nonEmptyString(config.repoPath) || DEFAULT_REPO_PATH;
  const profileName = chooseProfileName(config);
  const presetId = nonEmptyString(config.presetId) || DEFAULT_PRESET_ID;
  const dshHome = resolveDshHome(env);

  const configuredProfileDir = nonEmptyString(config.profileDir);
  const configuredPresetTarget = nonEmptyString(config.presetTarget);
  const configuredWorkerConfigPath = nonEmptyString(config.workerConfigPath);
  const schemaDefaultProfileDir = defaultProfileDir(env);
  const schemaDefaultPresetTarget = defaultPresetTarget(env);
  const schemaDefaultWorkerConfigPath = defaultWorkerConfigPath(DEFAULT_REPO_PATH);

  return {
    ...config,
    repoPath,
    branch: nonEmptyString(config.branch) || DEFAULT_BRANCH,
    profile: profileName,
    profileName,
    profileDir: configuredProfileDir && configuredProfileDir !== schemaDefaultProfileDir
      ? configuredProfileDir
      : path.join(dshHome, "profiles", profileName),
    presetId,
    presetTarget: configuredPresetTarget && configuredPresetTarget !== schemaDefaultPresetTarget
      ? configuredPresetTarget
      : path.join(dshHome, ".agent-presets", presetId),
    workerConfigPath: configuredWorkerConfigPath && configuredWorkerConfigPath !== schemaDefaultWorkerConfigPath
      ? configuredWorkerConfigPath
      : defaultWorkerConfigPath(repoPath),
    // Both names are accepted, but either explicit false must disable the
    // potentially external Worker operation.
    workerUpdate: config.workerUpdate !== false && config.workerDeploy !== false,
    workerDeploy: config.workerUpdate !== false && config.workerDeploy !== false,
    restartPolicy: config.restartPolicy === "auto-if-verified" ? "auto-if-verified" : DEFAULT_RESTART_POLICY,
    repos
  };
}

export {
  Config,
  DEFAULT_BRANCH,
  DEFAULT_PRESET_ID,
  DEFAULT_PROFILE_NAME,
  DEFAULT_REPO_PATH,
  DEFAULT_RESTART_POLICY,
  RepoConfig,
  defaultPresetTarget,
  defaultProfileDir,
  defaultWorkerConfigPath,
  nonEmptyString,
  normalizeRepos,
  normalizeUpdaterConfig,
  resolveDshHome
};
