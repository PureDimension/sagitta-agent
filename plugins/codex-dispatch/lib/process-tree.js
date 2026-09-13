import { spawnSync } from "node:child_process";

const TREE_QUERY_TIMEOUT_MS = 3000;
const TERM_GRACE_MS = 250;
const POLL_MS = 25;

function validPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid ? pid : null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function parseParentRows(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => {
      const match = /^(\d+)\s*,\s*(\d+)$/u.exec(line);
      if (!match) return null;
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      return Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid) ? { pid, parentPid } : null;
    })
    .filter(Boolean);
}

function queryWindowsParents() {
  // There is no portable Node API for the Windows process parent table. Keep
  // this read-only query as a diagnostic/fallback supplement to taskkill /T;
  // taskkill remains the actual tree-scoped terminator.
  const command = "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1}' -f [int]$_.ProcessId,[int]$_.ParentProcessId }";
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    let result;
    try {
      result = spawnSync(executable, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-Command", command,
      ], {
        encoding: "utf8",
        timeout: TREE_QUERY_TIMEOUT_MS,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      continue;
    }
    if (!result.error && result.status === 0) return parseParentRows(result.stdout);
  }
  return [];
}

function windowsLivePids(pids, rows = queryWindowsParents()) {
  if (rows.length > 0) {
    const live = new Set(rows.map(({ pid }) => pid));
    return pids.filter((pid) => live.has(pid));
  }
  // If the diagnostic query itself is unavailable, retain the conservative
  // Node probe. A successful tree kill is still reported as uncertain below
  // rather than silently treated as clean.
  return pids.filter(pidAlive);
}

function queryPosixParents() {
  let result;
  try {
    result = spawnSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: TREE_QUERY_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return [];
  }
  return result.error || result.status !== 0 ? [] : parseParentRows(result.stdout.replace(/\s+(?=\d+$)/gmu, ","));
}

function processTreePids(rootPid, platform = process.platform) {
  const root = validPid(rootPid);
  if (root === null) return [];
  const entries = platform === "win32" ? queryWindowsParents() : queryPosixParents();
  const childrenByParent = new Map();
  for (const entry of entries) {
    const children = childrenByParent.get(entry.parentPid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.parentPid, children);
  }
  const visited = new Set();
  const result = [];
  const visit = (pid) => {
    if (visited.has(pid)) return;
    visited.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
    if (pid !== process.pid) result.push(pid);
  };
  // Starting at the root also finds descendants after the root has already
  // exited (their parent PID can still be observed briefly).
  visit(root);
  return result;
}

function unionPids(...groups) {
  const result = [];
  const seen = new Set();
  for (const group of groups) {
    if (!group) continue;
    for (const value of group) {
      const pid = validPid(value);
      if (pid === null || seen.has(pid)) continue;
      seen.add(pid);
      result.push(pid);
    }
  }
  return result;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function posixGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function signalKnownPids(pids, signal) {
  const failures = [];
  for (const pid of [...pids].reverse()) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") failures.push({ pid, error });
    }
  }
  return failures;
}

function taskkill(pid, tree) {
  let result;
  try {
    result = spawnSync("taskkill.exe", [
      "/PID", String(pid),
      ...(tree ? ["/T"] : []),
      "/F",
    ], {
      encoding: "utf8",
      timeout: TREE_QUERY_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return { ok: false, output: "", error };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  // A process that won the exit race is already clean. Treat that Windows
  // result as success so terminal cleanup remains idempotent.
  const alreadyGone = /not found|no running instance|does not exist|不存在|找不到/u.test(output);
  return {
    ok: !result.error && (result.status === 0 || alreadyGone),
    output,
    error: result.error ?? (result.status === 0 || alreadyGone ? null : new Error(`taskkill exited with ${result.status}`)),
  };
}

async function terminateWindowsTree(rootPid, knownPids) {
  const before = unionPids(knownPids, processTreePids(rootPid, "win32"), [rootPid]);
  const initialLive = new Set(windowsLivePids(before));
  const rootWasAlive = initialLive.has(rootPid);
  const attempts = [];
  let commandFailure = null;

  // /T is the important part: it handles grandchildren even when codex
  // inserted a node/powershell/npm wrapper between the adapter and the work.
  if (rootWasAlive) {
    const result = taskkill(rootPid, true);
    attempts.push({ pid: rootPid, tree: true, ok: result.ok });
    if (!result.ok) commandFailure = result.error ?? new Error("taskkill /T failed");
  }

  // If the top-level codex process already exited normally, /T cannot be
  // applied to it. Kill the descendants captured from the process table,
  // individually and only when they are still alive.
  for (const pid of before) {
    if (pid === rootPid || !initialLive.has(pid)) continue;
    const result = taskkill(pid, false);
    attempts.push({ pid, tree: false, ok: result.ok });
    if (!result.ok && commandFailure === null) commandFailure = result.error ?? new Error(`taskkill failed for ${pid}`);
  }

  // A child may have spawned one final descendant during the first command.
  // Re-snapshot a few times, but never retry the root PID after it has gone;
  // this avoids targeting an unrelated process if Windows reuses that PID.
  let allKnown = before;
  for (let round = 0; round < 3; round++) {
    allKnown = unionPids(allKnown, processTreePids(rootPid, "win32"));
    const survivors = windowsLivePids(allKnown);
    if (survivors.length === 0) break;
    for (const pid of survivors) {
      if (pid === rootPid && !rootWasAlive) continue;
      const result = taskkill(pid, false);
      attempts.push({ pid, tree: false, ok: result.ok });
      if (!result.ok && commandFailure === null) commandFailure = result.error ?? new Error(`taskkill failed for ${pid}`);
    }
    await wait(POLL_MS);
  }

  const survivors = windowsLivePids(allKnown);
  return {
    // A taskkill command can return 128 when the root wins the exit race; the
    // authoritative result is the post-cleanup process-table check. If no
    // owned PID survives, the tree is clean despite that benign command race.
    ok: survivors.length === 0,
    method: "taskkill /T /F",
    pids: allKnown,
    survivors,
    attempts,
    error: survivors.length > 0
      ? new Error(`surviving pids: ${survivors.join(", ")}${commandFailure ? `; ${commandFailure.message ?? commandFailure}` : ""}`)
      : null,
  };
}

async function terminatePosixTree(rootPid, child, knownPids) {
  const before = unionPids(knownPids, processTreePids(rootPid, process.platform), [rootPid]);
  const failures = [];
  let groupSignalled = false;
  try {
    process.kill(-rootPid, "SIGTERM");
    groupSignalled = true;
  } catch (error) {
    if (error?.code !== "ESRCH") failures.push(error);
  }

  let alive = groupSignalled && posixGroupAlive(rootPid);
  const deadline = Date.now() + TERM_GRACE_MS;
  while (alive && Date.now() < deadline) {
    await wait(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
    alive = posixGroupAlive(rootPid);
  }
  if (alive) {
    try {
      process.kill(-rootPid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") failures.push(error);
    }
  }

  // Detached children should always be in the process group. This narrow
  // fallback covers a caller that supplied a non-detached ChildProcess, while
  // retaining the same PID allow-list and never scanning arbitrary processes.
  if (!groupSignalled || posixGroupAlive(rootPid)) {
    failures.push(...signalKnownPids(before, "SIGKILL").map(({ error }) => error));
    if (child && pidAlive(rootPid)) {
      try { child.kill("SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") failures.push(error); }
    }
  }

  const finalDeadline = Date.now() + TERM_GRACE_MS;
  while (posixGroupAlive(rootPid) && Date.now() < finalDeadline) await wait(POLL_MS);
  const survivors = unionPids(before, processTreePids(rootPid, process.platform)).filter(pidAlive);
  if (posixGroupAlive(rootPid) && !survivors.includes(rootPid)) survivors.push(rootPid);
  return {
    ok: survivors.length === 0 && failures.length === 0,
    method: "POSIX process group SIGTERM→SIGKILL",
    pids: before,
    survivors,
    attempts: groupSignalled ? ["SIGTERM", ...(alive ? ["SIGKILL"] : [])] : ["pid allow-list fallback"],
    error: survivors.length > 0 ? new Error(`surviving pids: ${survivors.join(", ")}`) : failures[0] ?? null,
  };
}

/**
 * Terminate exactly one adapter-owned process tree.
 *
 * Windows has no POSIX process groups. The supported native fallback is
 * taskkill /T /F, supplemented by a read-only parent-table snapshot when the
 * root has already exited. POSIX uses a detached process group and signals its
 * negative PGID, escalating to SIGKILL after a short grace period.
 */
async function terminateProcessTree({ pid, child, workId, reason, logger, knownPids = [] } = {}) {
  const rootPid = validPid(pid);
  if (rootPid === null) {
    const result = { ok: true, skipped: true, method: "none", pids: [], survivors: [], attempts: [] };
    logger?.(`sagitta-codex: process tree cleanup work_id=${workId ?? "unknown"} pid=${pid ?? "none"} reason=${reason ?? "unspecified"} result=skipped`);
    return result;
  }
  const observedPids = unionPids(knownPids, processTreePids(rootPid, process.platform));
  const result = process.platform === "win32"
    ? await terminateWindowsTree(rootPid, observedPids)
    : await terminatePosixTree(rootPid, child, observedPids);
  const status = result.ok ? "success" : "failure";
  logger?.(
    `sagitta-codex: process tree cleanup work_id=${workId ?? "unknown"} pid=${rootPid} ` +
    `reason=${reason ?? "unspecified"} method=${result.method} pids=[${result.pids.join(",")}] ` +
    `survivors=[${result.survivors.join(",")}] result=${status}` +
    (result.error ? ` error=${result.error.message ?? result.error}` : "")
  );
  return result;
}

/**
 * Idempotent bridge between async-work/settled and adapter-owned processes.
 * Keeping this bridge separate makes the lifecycle race-testable without a
 * DSH host: explicit cancel, reap/expired, child exit, and dispose all call
 * the same cleanup promise for a work_id.
 */
function createCodexProcessTracker({ records, logger } = {}) {
  const owned = records ?? new Map();

  function stopMonitor(metadata) {
    if (metadata.monitor !== undefined) {
      clearInterval(metadata.monitor);
      metadata.monitor = undefined;
    }
  }

  function track(workId, metadata) {
    const pid = validPid(metadata?.pid);
    if (pid === null) return;
    metadata.knownPids = unionPids(metadata.knownPids, processTreePids(pid, process.platform), [pid]);
    // taskkill /T cannot recover descendants after the root has already
    // exited and Windows has reparented them. Keep a small, per-work allow-list
    // while the root is alive so normal completion can still clean those
    // descendants without scanning or killing unrelated processes.
    if (process.platform === "win32" && metadata.monitor === undefined) {
      metadata.monitor = setInterval(() => {
        if (metadata.cleanupPromise) return;
        metadata.knownPids = unionPids(metadata.knownPids, processTreePids(pid, "win32"));
      }, 250);
      metadata.monitor.unref?.();
    }
    return workId;
  }

  function cleanup(workId, metadata, reason) {
    if (!metadata) return Promise.resolve({ ok: true, skipped: true, pids: [], survivors: [] });
    if (metadata.cleanupPromise) return metadata.cleanupPromise;
    stopMonitor(metadata);
    metadata.cleanupPromise = terminateProcessTree({
      pid: metadata.pid,
      child: metadata.child,
      workId,
      reason,
      logger,
      knownPids: metadata.knownPids,
    }).catch((error) => {
      logger?.(`sagitta-codex: process tree cleanup work_id=${workId} result=failure error=${error?.message ?? error}`);
      return { ok: false, pids: metadata.pid ? [metadata.pid] : [], survivors: [metadata.pid].filter(Boolean), error };
    });
    return metadata.cleanupPromise;
  }

  function settled(payload) {
    const workId = payload?.workId ?? payload?.work_id;
    const metadata = workId === undefined ? undefined : owned.get(String(workId));
    if (!metadata) return Promise.resolve({ ok: true, skipped: true, pids: [], survivors: [] });
    if (payload?.ownerId !== undefined && metadata.ownerId !== payload.ownerId) {
      logger?.(`sagitta-codex: ignored async-work settlement for mismatched owner work_id=${workId}`);
      return Promise.resolve({ ok: false, skipped: true, pids: [], survivors: [], error: new Error("owner mismatch") });
    }
    return cleanup(String(workId), metadata, payload?.status ?? "settled");
  }

  async function dispose(reason = "plugin-dispose") {
    const results = await Promise.all([...owned.entries()].map(([workId, metadata]) => cleanup(workId, metadata, reason)));
    return results;
  }

  return { cleanup, settled, dispose, track };
}

export {
  createCodexProcessTracker,
  processTreePids,
  terminateProcessTree,
};
