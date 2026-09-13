import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncWorkRegistry, MIN_TIMEOUT_MS } from "../../async-work/lib/registry.js";
import { createCodexProcessTracker } from "../lib/process-tree.js";

const isWindows = process.platform === "win32";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(message);
}

async function spawnTree({ rootExits = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sagitta-process-tree-"));
  const marker = join(directory, "child-pid");
  const childCommand = isWindows ? "pwsh.exe" : "sh";
  const childArgs = isWindows
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep 300"]
    : ["-c", "sleep 300"];
  const childScript = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const child = spawn(${JSON.stringify(childCommand)}, ${JSON.stringify(childArgs)}, { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
    rootExits ? "setTimeout(() => process.exit(0), 150);" : "setInterval(() => {}, 1000);",
  ].join("\n");
  const root = spawn(process.execPath, ["-e", childScript], {
    detached: !isWindows,
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(root.pid, "fake codex root must have a PID");
  await waitFor(async () => {
    try {
      const value = await readFile(marker, "utf8");
      return Number.isInteger(Number(value)) && Number(value) > 1 && isAlive(Number(value));
    } catch {
      return false;
    }
  }, "fake codex child did not start");
  const childPid = Number(await readFile(marker, "utf8"));
  return { root, childPid, marker, directory };
}

async function assertGone(tree) {
  if (isWindows) {
    await waitFor(() => {
      try {
        const output = execFileSync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command",
          `@(Get-Process -Id ${tree.root.pid},${tree.childPid} -ErrorAction SilentlyContinue).Count`,
        ], { encoding: "utf8" }).trim();
        return output === "0";
      } catch {
        return false;
      }
    }, `process tree survived cleanup: root=${tree.root.pid}, child=${tree.childPid}`, 5000);
    return;
  }
  await waitFor(
    () => !isAlive(tree.root.pid) && !isAlive(tree.childPid),
    `process tree survived cleanup: root=${tree.root.pid}, child=${tree.childPid}`,
    5000
  );
}

async function terminalCase(status, { normalExit = false } = {}) {
  let now = Date.now();
  let sequence = 0;
  const registry = new AsyncWorkRegistry({
    clock: () => now,
    idFactory: () => `tree-${status}-${++sequence}`,
  });
  const records = new Map();
  const logs = [];
  const tracker = createCodexProcessTracker({ records, logger: (message) => logs.push(message) });
  registry.onSettled((payload) => tracker.settled(payload));
  const work = registry.register({
    ownerId: "tree-test-owner",
    taskId: `task-${status}`,
    kind: "codex",
    desc: `tree ${status}`,
    timeoutMs: MIN_TIMEOUT_MS,
  });
  const tree = await spawnTree({ rootExits: normalExit });
  const metadata = {
    ownerId: work.owner_id,
    taskId: work.task_id,
    child: tree.root,
    pid: tree.root.pid,
    knownPids: [tree.childPid],
  };
  records.set(work.work_id, metadata);
  tracker.track(work.work_id, metadata);

  if (normalExit) {
    await new Promise((resolve, reject) => {
      tree.root.once("exit", resolve);
      tree.root.once("error", reject);
    });
  }
  if (status === "completed") registry.complete(work.owner_id, work.work_id, work.task_id);
  if (status === "failed") registry.fail(work.owner_id, work.work_id, "fake failure", work.task_id);
  if (status === "cancelled") registry.cancel(work.owner_id, work.work_id, work.task_id);
  if (status === "expired") {
    now += MIN_TIMEOUT_MS;
    registry.reap(work.owner_id);
  }
  assert.equal(registry.get(work.owner_id, work.work_id).status, status);
  await metadata.cleanupPromise;
  await assertGone(tree);
  assert.ok(
    logs.some((message) => message.includes(`work_id=${work.work_id}`) && message.includes("result=success")),
    logs.join("\n")
  );
  await tracker.dispose();
  registry.dispose();
  await rm(tree.directory, { recursive: true, force: true });
}

await terminalCase("cancelled");
await terminalCase("completed", { normalExit: true });
await terminalCase("failed");
await terminalCase("expired");

// DSH dispose owns both lifecycle state and process metadata. Exercise the
// cleanup side independently as well, including a still-running root tree.
{
  const tree = await spawnTree();
  const records = new Map([["dispose-work", {
    ownerId: "tree-test-owner",
    taskId: "task-dispose",
    child: tree.root,
    pid: tree.root.pid,
    knownPids: [tree.childPid],
  }]]);
  const logs = [];
  const tracker = createCodexProcessTracker({ records, logger: (message) => logs.push(message) });
  tracker.track("dispose-work", records.get("dispose-work"));
  await tracker.dispose();
  await assertGone(tree);
  assert.ok(logs.some((message) => message.includes("work_id=dispose-work") && message.includes("reason=plugin-dispose")));
  await rm(tree.directory, { recursive: true, force: true });
}

console.log(`codex process-tree smoke: PASS (${isWindows ? "Windows taskkill /T /F" : "POSIX detached process group"}; cancelled/completed/failed/expired/dispose; no residual root or child PIDs)`);
