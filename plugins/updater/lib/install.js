import { access, cp, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

const defaultFs = { access, cp, readFile, stat };

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
 * pnpm's hoisted linker may keep a copied `file:` dependency when only the
 * package contents changed (the package version and lock entry are unchanged).
 * That leaves a running profile on stale plugin code after an updater pull.
 * Synchronize configured local file dependencies after the package manager
 * runs so the profile always executes the checked-out repository contents.
 */
async function syncLocalFileDependencies(profileDir, fsOps = defaultFs) {
  const packagePath = path.join(profileDir, "package.json");
  const packageData = JSON.parse(await fsOps.readFile(packagePath, "utf8"));
  const dependencies = {
    ...(packageData.dependencies || {}),
    ...(packageData.optionalDependencies || {})
  };
  let synced = 0;
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
    const rawSourcePath = spec.slice("file:".length);
    const sourcePath = path.isAbsolute(rawSourcePath)
      ? path.normalize(rawSourcePath)
      : path.resolve(profileDir, rawSourcePath);
    const targetPath = path.join(profileDir, "node_modules", ...name.split("/"));
    if (sourcePath.toLowerCase() === path.resolve(targetPath).toLowerCase()) continue;
    if (!(await exists(sourcePath, fsOps))) continue;
    if (!(await exists(targetPath, fsOps))) {
      throw new Error(`local file dependency was not materialized: ${name}`);
    }
    await fsOps.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      filter: (entryPath) => !["node_modules", ".git"].includes(path.basename(entryPath))
    });
    synced++;
  }
  return synced;
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

  const syncedLocalDependencies = await syncLocalFileDependencies(profileDir, fsOps);
  return { status: "installed", packageManager: manager, changed: true, syncedLocalDependencies };
}

export {
  INSTALL_TIMEOUT_MS,
  detectPackageManager,
  execCommand,
  exists,
  installProfileDependencies,
  syncLocalFileDependencies
};
