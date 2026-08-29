import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30000;

async function execGit(repoPath, args) {
  const result = await execFileAsync("git", args, {
    cwd: repoPath,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  return result.stdout.trim();
}

function logInfo(logger, message) {
  try {
    logger?.info?.(message);
  } catch {
    // Optional diagnostics must never affect startup.
  }
}

function logDebug(logger, message) {
  try {
    logger?.debug?.(message);
  } catch {
    // Optional diagnostics must never affect startup.
  }
}

/**
 * Fetch origin and fast-forward HEAD when the remote branch moved.
 *
 * The runner is injectable so tests can exercise fetch/SHA/merge branches
 * without touching a real repository or network.
 */
async function checkRepository(repo, logger, git = execGit) {
  const remoteRef = `origin/${repo.branch}`;
  let phase = "fetch";

  try {
    // Deliberately contact only origin.
    await git(repo.path, ["fetch", "origin"]);

    phase = "sha";
    const localSha = await git(repo.path, ["rev-parse", "HEAD"]);
    const remoteSha = await git(repo.path, ["rev-parse", remoteRef]);

    if (localSha === remoteSha) {
      logInfo(logger, `@sagitta/updater: ${repo.path} 无更新`);
      return { status: "up-to-date", path: repo.path, sha: localSha };
    }

    phase = "dirty-check";
    const dirty = String(await git(repo.path, ["status", "--porcelain", "--untracked-files=all"]) ?? "").trim();
    if (dirty) {
      logInfo(logger, `@sagitta/updater: ${repo.path} 工作树有改动，跳过更新`);
      return { status: "skipped", path: repo.path, reason: "dirty" };
    }

    phase = "merge";
    await git(repo.path, ["merge", "--ff-only", remoteRef]);
    phase = "short-sha";
    const shortSha = await git(repo.path, ["rev-parse", "--short", "HEAD"]);
    logInfo(logger, `@sagitta/updater: ${repo.path} 已更新到 ${shortSha}，下次 DSH 启动生效`);
    return { status: "updated", path: repo.path, sha: shortSha, previousSha: localSha, remoteSha };
  } catch {
    const reason = phase === "merge"
      ? "non-fast-forward-or-merge-failed"
      : phase === "fetch"
        ? "fetch-failed"
        : phase === "dirty-check"
          ? "dirty-check-failed"
          : "sha-read-failed";
    // Do not print the child-process error: a Git remote can contain a token.
    logDebug(logger, `@sagitta/updater: ${repo.path} 更新跳过（${reason}）`);
    return { status: "skipped", path: repo.path, reason };
  }
}

async function runUpdateCheck(repos, logger, git = execGit) {
  return Promise.all(repos.map((repo) => checkRepository(repo, logger, git)));
}

export {
  GIT_TIMEOUT_MS,
  checkRepository,
  execGit,
  runUpdateCheck
};
