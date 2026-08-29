import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkRepository } from "../lib/git.js";
import { expandPresetTemplate, parseComposition, sha256, syncPreset } from "../lib/preset.js";
import { runStartupMaintenance } from "../lib/service.js";
import { deployWorker } from "../lib/worker.js";

function logger() {
  return { info() {}, debug() {} };
}

function gitMock({ local = "same", remote = local, mergeFails = false, dirty = "" } = {}) {
  const calls = [];
  let shortSha = remote.slice(0, 7);
  const git = async (repo, args) => {
    calls.push([repo, ...args]);
    const command = args.join(" ");
    if (command === "fetch origin") return "";
    if (command === "rev-parse HEAD") return local;
    if (command === "rev-parse origin/main") return remote;
    if (command === "status --porcelain --untracked-files=all") return dirty;
    if (command === "merge --ff-only origin/main") {
      if (mergeFails) throw new Error("mock non-fast-forward");
      return "";
    }
    if (command === "rev-parse --short HEAD") return shortSha;
    throw new Error(`unexpected git call: ${command}`);
  };
  return { calls, git };
}

test("git smoke covers no-update, update, dirty and non-fast-forward branches", async () => {
  const equal = gitMock({ local: "abc", remote: "abc" });
  assert.equal((await checkRepository({ path: "mock-repo", branch: "main" }, logger(), equal.git)).status, "up-to-date");

  const updated = gitMock({ local: "abc", remote: "def" });
  assert.equal((await checkRepository({ path: "mock-repo", branch: "main" }, logger(), updated.git)).status, "updated");
  assert.ok(updated.calls.some((call) => call.slice(1).join(" ") === "merge --ff-only origin/main"));

  const dirty = gitMock({ local: "abc", remote: "def", dirty: " M plugins/updater/lib/index.js" });
  const dirtyResult = await checkRepository({ path: "mock-repo", branch: "main" }, logger(), dirty.git);
  assert.equal(dirtyResult.reason, "dirty");

  const nonFastForward = gitMock({ local: "abc", remote: "def", mergeFails: true });
  const mergeResult = await checkRepository({ path: "mock-repo", branch: "main" }, logger(), nonFastForward.git);
  assert.equal(mergeResult.reason, "non-fast-forward-or-merge-failed");
});

test("preset validation and ownership marker do not overwrite a user edit", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sagitta-updater-preset-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const targetDir = path.join(tempRoot, "target");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "agent.cordis.yml"), "- id: updater\n  name: '@sagitta/updater'\n", "utf8");
    await writeFile(path.join(sourceDir, "preset.yml"), "name: sagitta\ndescription: smoke\nprinciples: ignored\n", "utf8");
    assert.equal(parseComposition(await readFile(path.join(sourceDir, "agent.cordis.yml"), "utf8")).ok, true);

    const first = await syncPreset({
      sourceDir,
      targetDir,
      presetId: "sagitta",
      sourceCommit: "mock-sha",
      resolvePlugin: async () => true
    });
    assert.equal(first.status, "installed");

    await writeFile(path.join(targetDir, "agent.cordis.yml"), "- id: user\n  name: custom\n", "utf8");
    const second = await syncPreset({
      sourceDir,
      targetDir,
      presetId: "sagitta",
      sourceCommit: "mock-sha-2",
      resolvePlugin: async () => true
    });
    assert.equal(second.status, "candidate");
    assert.match(await readFile(path.join(targetDir, "agent.cordis.yml"), "utf8"), /custom/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("preset template expansion resolves paths before hashing and warns on unknown variables", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sagitta-updater-template-"));
  const sourceDir = path.join(tempRoot, "source");
  const targetDir = path.join(tempRoot, "target");
  const repoPath = path.join(tempRoot, "repo");
  const dshHome = path.join(tempRoot, "dsh-home");
  const warnings = [];
  try {
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "agent.cordis.yml"), [
      "# <SAGITTA_AGENT_DIR> and <DSH_HOME> are also part of the template contract.",
      "- id: persona",
      "  name: '@deepseek-ai/dsh-persona'",
      "  config:",
      "    text: >-",
      "      Read <SAGITTA_PROJECT_ROOT>\\TASKS.md and <USERPROFILE>\\.ssh\\config.",
      "      Unknown value: <UNKNOWN_TEMPLATE>",
      ""
    ].join("\n"), "utf8");
    await writeFile(path.join(sourceDir, "preset.yml"), "name: sagitta\ndescription: smoke\norder: 1\n", "utf8");

    const directExpansion = expandPresetTemplate(
      "<SAGITTA_PROJECT_ROOT>\\TASKS.md <USERPROFILE>\\.ssh\\config <UNKNOWN_TEMPLATE>",
      { repoPath, dshHome, logger: { warn: (message) => warnings.push(message) } }
    );
    assert.equal(directExpansion.content, `${repoPath}\\TASKS.md ${process.env.USERPROFILE || os.homedir()}\\.ssh\\config <UNKNOWN_TEMPLATE>`);
    assert.deepEqual(directExpansion.warnings, ["UNKNOWN_TEMPLATE"]);

    const result = await syncPreset({
      sourceDir,
      targetDir,
      presetId: "sagitta",
      sourceCommit: "mock-sha",
      repoPath,
      dshHome,
      logger: { warn: (message) => warnings.push(message) },
      resolvePlugin: async () => true
    });
    assert.equal(result.status, "installed");
    assert.deepEqual(result.templateWarnings, ["UNKNOWN_TEMPLATE"]);

    const targetComposition = await readFile(path.join(targetDir, "agent.cordis.yml"), "utf8");
    assert.ok(targetComposition.includes(path.join(repoPath, "TASKS.md")));
    assert.ok(targetComposition.includes(path.join(process.env.USERPROFILE || os.homedir(), ".ssh", "config")));
    assert.ok(targetComposition.includes(repoPath));
    assert.ok(targetComposition.includes(dshHome));
    assert.doesNotMatch(targetComposition, /<SAGITTA_PROJECT_ROOT>|<USERPROFILE>/);
    assert.match(targetComposition, /<UNKNOWN_TEMPLATE>/);
    assert.equal(warnings.filter((message) => message.includes("UNKNOWN_TEMPLATE")).length, 2);

    const targetMetadata = await readFile(path.join(targetDir, "preset.yml"), "utf8");
    const marker = JSON.parse(await readFile(path.join(targetDir, ".sagitta-managed.json"), "utf8"));
    assert.equal(marker.sourceHashes.composition, sha256(targetComposition));
    assert.equal(marker.sourceHashes.metadata, sha256(targetMetadata));
    assert.equal(marker.files.compositionTargetHash, sha256(targetComposition));
    assert.equal(marker.files.metadataTargetHash, sha256(targetMetadata));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function makeRepositoryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sagitta-updater-flow-"));
  for (const directory of ["plugins", "presets", "worker", "scripts"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  return root;
}

test("service smoke covers no API and configured API branches with injected git/deploy", async () => {
  const repoPath = await makeRepositoryFixture();
  const profileDir = path.join(repoPath, "profile");
  const presetTarget = path.join(repoPath, "user-preset");
  try {
    const noUpdate = gitMock({ local: "abc", remote: "abc" });
    let noApiDeployCalls = 0;
    const noApi = await runStartupMaintenance({
      ctx: { "sagitta-manager": { getApiConfig: () => ({}) } },
      config: { repoPath, profileDir, presetTarget, workerUpdate: true },
      logger: logger(),
      git: noUpdate.git,
      preset: async () => ({ status: "up-to-date", changed: false }),
      deploy: async () => { noApiDeployCalls += 1; return { status: "deployed" }; }
    });
    assert.equal(noApi.repositoryResults[0].status, "up-to-date");
    assert.equal(noApi.worker.reason, "manager-api-not-configured");
    assert.equal(noApiDeployCalls, 0);

    const withUpdate = gitMock({ local: "abc", remote: "def" });
    let deployArgs;
    const withApi = await runStartupMaintenance({
      // Exercise the documented bracket service name used by the manager.
      ctx: { "sagitta-manager": {
        getApiConfig: () => ({ workerApiUrl: "https://mock.invalid", workerUploadToken: "mock-upload-token" })
      } },
      config: { repoPath, profileDir, presetTarget, workerUpdate: true },
      logger: logger(),
      git: withUpdate.git,
      install: async () => ({ status: "installed", changed: true }),
      preset: async () => ({ status: "updated", changed: true }),
      deploy: async (args) => { deployArgs = args; return { status: "deployed", mode: "mock", health: "ok" }; }
    });
    assert.equal(withApi.repositoryResults[0].status, "updated");
    assert.equal(withApi.worker.status, "deployed");
    assert.equal(deployArgs.workerApiUrl, "https://mock.invalid");
    assert.equal(deployArgs.workerUploadToken, "mock-upload-token");
    assert.equal(withApi.restart.status, "prompt");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("worker smoke verifies direct PUT and health response with injected HTTP", async () => {
  const repoPath = await makeRepositoryFixture();
  const configPath = path.join(repoPath, "worker", "wrangler.toml");
  await writeFile(path.join(repoPath, "worker", "worker.js"), "export default { fetch() { return new Response('ok') } };\n", "utf8");
  await writeFile(configPath, "name = 'mock-worker'\nmain = 'worker.js'\n", "utf8");
  const calls = [];
  try {
    const result = await deployWorker({
      repoPath,
      workerConfigPath: configPath,
      workerApiUrl: "https://mock.invalid",
      workerUploadToken: "mock-upload-token",
      env: { CF_ACCOUNT_ID: "mock-account-id" },
      request: async (url, options) => {
        calls.push({ url, options });
        if (options.method === "PUT") return { ok: true, json: async () => ({ success: true }) };
        return { ok: true, json: async () => ({ ok: true, version: "mock", env: { db: true, auth_token: true } }) };
      }
    });
    assert.equal(result.status, "deployed");
    assert.equal(result.mode, "direct");
    assert.equal(result.health, "ok");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers["Content-Type"], "application/javascript");
    assert.match(calls[0].url, /accounts%2Fmock-account-id|accounts\/mock-account-id/);
    assert.equal(calls[1].options.method, "GET");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
