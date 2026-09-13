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
      const match = /^(\d+)\s*,\s*(\d+)(?:\s*,\s*(.*\S))?$/u.exec(line);
      if (!match) return null;
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) return null;
      return { pid, parentPid, ...(match[3] ? { identity: match[3] } : {}) };
    })
    .filter(Boolean);
}

function queryWindowsParents() {
  // There is no portable Node API for the Windows process parent table. Keep
  // this read-only query as a diagnostic/fallback supplement to taskkill /T;
  // taskkill remains the actual tree-scoped terminator.
  const command = "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f [int]$_.ProcessId,[int]$_.ParentProcessId,$_.CreationDate.ToUniversalTime().ToString('o') }";
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

function windowsLivePids(pids, rows = queryWindowsParents(), identities) {
  if (rows.length > 0) {
    const live = new Map(rows.map((row) => [row.pid, row]));
    return pids.filter((pid) => {
      const row = live.get(pid);
      const expected = identities?.get(pid);
      return row !== undefined && (expected === undefined || expected === row.identity);
    });
  }
  // If the diagnostic query itself is unavailable, retain the conservative
  // Node probe. A successful tree kill is still reported as uncertain below
  // rather than silently treated as clean.
  return pids.filter(pidAlive);
}

function rememberWindowsIdentities(metadata, rows, pids) {
  const identities = metadata.processIdentities instanceof Map ? metadata.processIdentities : new Map();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const pid of pids) {
    const identity = byPid.get(pid)?.identity;
    if (identity !== undefined && !identities.has(pid)) identities.set(pid, identity);
  }
  metadata.processIdentities = identities;
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

function treePidsFromRows(rootPid, entries) {
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
  visit(rootPid);
  return result;
}

function processTreePids(rootPid, platform = process.platform) {
  const root = validPid(rootPid);
  if (root === null) return [];
  const entries = platform === "win32" ? queryWindowsParents() : queryPosixParents();
  return treePidsFromRows(root, entries);
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
  const alreadyGone = result.status === 128 || /not found|no running instance|no instance of the task|does not exist|not exist|不存在|找不到/u.test(output);
  return {
    ok: !result.error && (result.status === 0 || alreadyGone),
    output,
    error: result.error ?? (result.status === 0 || alreadyGone ? null : new Error(
      `taskkill exited with ${result.status}${output ? `: ${output}` : ""}`
    )),
  };
}

async function terminateWindowsTree(rootPid, knownPids, child, identities = new Map()) {
  identities = identities instanceof Map ? identities : new Map();
  const initialRows = queryWindowsParents();
  const initialTree = treePidsFromRows(rootPid, initialRows);
  const initialByPid = new Map(initialRows.map((row) => [row.pid, row]));
  const rootRow = initialByPid.get(rootPid);
  const expectedRoot = identities.get(rootPid);
  const childLooksLikeRunningRoot = child === undefined || child === null
    ? true
    : child.pid === rootPid && child.exitCode === null && child.signalCode === null;
  const rootIdentityMatches = expectedRoot === undefined || rootRow?.identity === expectedRoot;
  const rootWasAlive = initialRows.length > 0
    ? rootRow !== undefined && rootIdentityMatches && childLooksLikeRunningRoot
    : pidAlive(rootPid) && childLooksLikeRunningRoot;
  const rootWasReused = initialRows.length > 0 && rootRow !== undefined &&
    (!rootIdentityMatches || !childLooksLikeRunningRoot);
  const known = unionPids(knownPids);
  const trustedKnown = initialRows.length > 0
    ? known.filter((pid) => !rootWasReused || identities.has(pid))
      .filter((pid) => windowsLivePids([pid], initialRows, identities).includes(pid))
    : known;
  // Once the root PID is observed as a different process, its current PPID
  // children are not owned by this work. Retain only identities captured while
  // tracking the original tree; this is the PID-reuse safety boundary.
  const safeInitialTree = rootWasReused ? [] : initialTree.filter((pid) => pid !== rootPid);
  const before = unionPids(trustedKnown, safeInitialTree, [rootPid]);
  const initialLive = new Set(windowsLivePids(before, initialRows, identities));
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
  // Re-snapshot a few times, but never retry the root PID. If Windows reuses
  // it, only the tracked process identities remain eligible for cleanup.
  let allKnown = before;
  for (let round = 0; round < 3; round++) {
    const rows = queryWindowsParents();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const row = byPid.get(rootPid);
    const identityMatches = identities.get(rootPid) === undefined || row?.identity === identities.get(rootPid);
    const reused = rows.length > 0 && row !== undefined && !identityMatches;
    const snapshotTree = treePidsFromRows(rootPid, rows).filter((pid) => pid !== rootPid);
    if (!reused) allKnown = unionPids(allKnown, snapshotTree);
    const survivors = windowsLivePids(allKnown, rows, identities);
    if (survivors.length === 0) break;
    for (const pid of survivors) {
      // Never individually retry rootPid: after the first /T call it may be a
      // different process even if the original root was observed alive.
      if (pid === rootPid) continue;
      const result = taskkill(pid, false);
      attempts.push({ pid, tree: false, ok: result.ok });
      if (!result.ok && commandFailure === null) commandFailure = result.error ?? new Error(`taskkill failed for ${pid}`);
    }
    await wait(POLL_MS);
  }

  const finalRows = queryWindowsParents();
  const survivors = windowsLivePids(allKnown, finalRows, identities);
  const error = survivors.length > 0
    ? new Error(`surviving pids: ${survivors.join(",")}${commandFailure ? `; ${commandFailure.message ?? commandFailure}` : ""}`)
    : commandFailure;
  return {
    // A taskkill command that reports a real error must remain visible even if
    // a later snapshot happens to show no survivor. The taskkill helper already
    // classifies its normal "already gone" response as a successful race.
    ok: survivors.length === 0 && commandFailure === null,
    method: "taskkill /T /F",
    pids: allKnown,
    survivors,
    attempts,
    error,
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
async function terminateProcessTree({ pid, child, workId, reason, logger, knownPids = [], processIdentities } = {}) {
  const rootPid = validPid(pid);
  if (rootPid === null) {
    const result = { ok: true, skipped: true, method: "none", pids: [], survivors: [], attempts: [] };
    logger?.(`sagitta-codex: process tree cleanup work_id=${workId ?? "unknown"} pid=${pid ?? "none"} reason=${reason ?? "unspecified"} result=skipped`);
    return result;
  }
  // The Windows terminator takes its own settle-time snapshot so it can pair
  // the rows with tracked process identities; avoid an otherwise duplicate
  // full-table PowerShell query here. POSIX still snapshots before signalling.
  const observedPids = process.platform === "win32"
    ? unionPids(knownPids)
    : unionPids(knownPids, processTreePids(rootPid, process.platform));
  const result = process.platform === "win32"
    ? await terminateWindowsTree(rootPid, observedPids, child, processIdentities)
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
    if (metadata.monitor !== undefined && metadata.monitor !== null) {
      clearInterval(metadata.monitor);
    }
    metadata.monitor = null;
  }

  function track(workId, metadata) {
    if (!metadata) return;
    stopMonitor(metadata);
    const pid = validPid(metadata?.pid);
    if (pid === null) return;
    if (process.platform === "win32") {
      // Windows retains the creation-time ParentProcessId after a parent exits.
      // One settle-time PPID snapshot is therefore sufficient; polling the
      // whole process table while work runs only adds synchronous PowerShell
      // process launches and cannot improve the root-exit cleanup path.
      const rows = queryWindowsParents();
      const tree = treePidsFromRows(pid, rows);
      metadata.knownPids = unionPids(metadata.knownPids, tree, [pid]);
      rememberWindowsIdentities(metadata, rows, metadata.knownPids);
    } else {
      metadata.knownPids = unionPids(metadata.knownPids, processTreePids(pid, process.platform), [pid]);
    }
    return workId;
  }

  function cleanup(workId, metadata, reason) {
    if (!metadata) return Promise.resolve({ ok: true, skipped: true, pids: [], survivors: [] });
    stopMonitor(metadata);
    if (metadata.cleanupPromise) return metadata.cleanupPromise;
    metadata.cleanupPromise = terminateProcessTree({
      pid: metadata.pid,
      child: metadata.child,
      workId,
      reason,
      logger,
      knownPids: metadata.knownPids,
      processIdentities: metadata.processIdentities,
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
