import { access, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

const defaultFs = { access, stat };

async function execCommand(command, args, options = {}) {
  return execFileAsync(command, args, {
    windowsHide: true,
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
    ...options
  });
}

async function exists(filePath, fsOps = defaultFs) {
  try {
    if (typeof fsOps.access === "function") {
      await fsOps.access(filePath);
    } else {
      await fsOps.stat(filePath);
    }
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(profileDir, fsOps = defaultFs) {
  if (await exists(path.join(profileDir, "pnpm-lock.yaml"), fsOps)) return "pnpm";
  if (await exists(path.join(profileDir, "package-lock.json"), fsOps)) return "npm";
  return "pnpm";
}

/**
 * Re-link/install the profile after the repository has moved.
 *
 * This function intentionally does not edit package.json: install.ps1 owns
 * profile composition. Runtime updater only asks the detected package manager
 * to materialize the already configured local file dependencies.
 */
async function installProfileDependencies({
  profileDir,
  packageManager,
  command = execCommand,
  fsOps = defaultFs
}) {
  if (!profileDir || !(await exists(path.join(profileDir, "package.json"), fsOps))) {
    return { status: "skipped", reason: "profile-package-missing" };
  }

  const manager = packageManager || await detectPackageManager(profileDir, fsOps);
  const executable = process.platform === "win32" ? `${manager}.cmd` : manager;
  const args = manager === "npm"
    ? ["install", "--no-package-lock"]
    : ["install", "--lockfile=false"];

  await command(executable, args, {
    cwd: profileDir,
    windowsHide: true,
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8"
  });

  return { status: "installed", packageManager: manager, changed: true };
}

export {
  INSTALL_TIMEOUT_MS,
  detectPackageManager,
  execCommand,
  exists,
  installProfileDependencies
};
