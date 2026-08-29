import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import yaml from "js-yaml";

const COMPOSITION_FILE = "agent.cordis.yml";
const METADATA_FILE = "preset.yml";
const MARKER_FILE = ".sagitta-managed.json";

const defaultFs = { mkdir, readFile, rename, rm, stat, writeFile };
const requireFromUpdater = createRequire(import.meta.url);
// Keep this variable table in lockstep with $templateVariables in
// scripts/sync-preset.ps1.
// SAGITTA_TASKS_FILE is the external live task fact source before Ripple
// decision ⑤; afterward retire it and move the whole instruction to the
// task API or an approved migration path.
// Unknown names are intentionally left in the text and reported as warnings.
const TEMPLATE_PATTERN = /<([^<>]+)>/g;
const DEFAULT_SAGITTA_TASKS_FILE = "D:\\workspace\\sagitta-experience\\TASKS.md";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function templateUserProfile(userProfile) {
  return text(userProfile) || text(process.env.USERPROFILE) || os.homedir();
}

function templateDshHome(dshHome, userProfile) {
  return text(dshHome) || text(process.env.DSH_HOME) ||
    path.join(templateUserProfile(userProfile), ".dsh");
}

function templateTasksFile(tasksFile) {
  return text(tasksFile) || DEFAULT_SAGITTA_TASKS_FILE;
}

function getPresetTemplateVariables({ repoPath, dshHome, userProfile, tasksFile } = {}) {
  const variables = {};
  const repository = text(repoPath);
  if (repository !== undefined) {
    variables.SAGITTA_PROJECT_ROOT = repository;
    variables.SAGITTA_AGENT_DIR = repository;
  }
  variables.USERPROFILE = templateUserProfile(userProfile);
  variables.DSH_HOME = templateDshHome(dshHome, userProfile);
  variables.SAGITTA_TASKS_FILE = templateTasksFile(tasksFile);
  return variables;
}

function expandPresetTemplate(source, {
  repoPath,
  dshHome,
  userProfile,
  tasksFile,
  sourceName = "preset",
  logger = console
} = {}) {
  const variables = getPresetTemplateVariables({ repoPath, dshHome, userProfile, tasksFile });
  const warnings = [];
  const expanded = source.replace(TEMPLATE_PATTERN, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(variables, name)) return variables[name];
    if (!warnings.includes(name)) {
      warnings.push(name);
      const message = `${sourceName}: 未定义 preset 模板变量 <${name}>，保留原样。`;
      if (typeof logger?.warn === "function") logger.warn(message);
      else console.warn(message);
    }
    return match;
  });
  return { content: expanded, warnings };
}

function mergeTemplateWarnings(...warningLists) {
  return [...new Set(warningLists.flat())];
}

function compositionProblem(rows, at = "") {
  if (!Array.isArray(rows)) {
    return at ? `group ${at} must hold a list of plugin rows` : "composition must be a top-level list";
  }
  for (const [index, row] of rows.entries()) {
    const label = at ? `${at} row ${index + 1}` : `row ${index + 1}`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return `${label} must be a map`;
    }
    if (typeof row.name !== "string" || !row.name.trim()) {
      return `${label} must have a non-empty name`;
    }
    if (row.group === true) {
      const nestedProblem = compositionProblem(row.config, label);
      if (nestedProblem) return nestedProblem;
    }
  }
  return undefined;
}

function parseComposition(source) {
  let parsed;
  try {
    parsed = yaml.load(source);
  } catch {
    return { ok: false, reason: "composition-yaml-invalid" };
  }
  const reason = compositionProblem(parsed);
  return reason ? { ok: false, reason } : { ok: true, rows: parsed };
}

function sanitizeMetadata(source) {
  if (!source.trim()) return "";
  let parsed;
  try {
    parsed = yaml.load(source);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const metadata = {};
  const name = text(parsed.name);
  const description = text(parsed.description);
  if (name !== undefined) metadata.name = name;
  if (description !== undefined) metadata.description = description;
  if (typeof parsed.order === "number" && Number.isFinite(parsed.order)) metadata.order = parsed.order;
  return Object.keys(metadata).length === 0 ? "" : yaml.dump(metadata, { lineWidth: -1 });
}

async function readIfExists(filePath, fsOps = defaultFs) {
  try {
    return await fsOps.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function defaultResolvePlugin(name, { profileDir, repoPath, fsOps = defaultFs } = {}) {
  const paths = [profileDir, repoPath].filter(Boolean);
  try {
    requireFromUpdater.resolve(name, { paths });
    return true;
  } catch {
    // Local workspace plugins are not necessarily linked in node_modules yet.
  }

  if (repoPath && name.startsWith("@sagitta/")) {
    try {
      const pluginDirs = await fsOps.stat(path.join(repoPath, "plugins"));
      if (!pluginDirs.isDirectory()) return false;
      // Avoid a directory enumeration dependency in the hot path: the four
      // canonical package names map to these stable workspace directories.
      const id = name === "@sagitta/manager"
        ? "manager"
        : name === "@sagitta/memory"
          ? "memory"
          : name === "@sagitta/auto-advance"
            ? "auto-advance"
            : name === "@sagitta/updater"
              ? "updater"
              : undefined;
      if (!id) return false;
      const packageJson = JSON.parse(await fsOps.readFile(path.join(repoPath, "plugins", id, "package.json"), "utf8"));
      return packageJson.name === name;
    } catch {
      return false;
    }
  }
  return false;
}

async function validatePresetSource(sourceDir, {
  profileDir,
  repoPath,
  dshHome,
  userProfile,
  tasksFile,
  logger = console,
  resolvePlugin = defaultResolvePlugin,
  fsOps = defaultFs
} = {}) {
  const compositionPath = path.join(sourceDir, COMPOSITION_FILE);
  const rawComposition = await readIfExists(compositionPath, fsOps);
  if (rawComposition === undefined) return { ok: false, reason: "composition-missing", templateWarnings: [] };

  const compositionResult = expandPresetTemplate(rawComposition, {
    repoPath,
    dshHome,
    userProfile,
    tasksFile,
    sourceName: COMPOSITION_FILE,
    logger
  });
  const composition = compositionResult.content;
  const templateWarnings = compositionResult.warnings;

  const parsed = parseComposition(composition);
  if (!parsed.ok) return { ...parsed, templateWarnings };

  const names = [];
  const collect = (rows) => {
    for (const row of rows) {
      names.push(row.name.trim());
      if (row.group === true) collect(row.config);
    }
  };
  collect(parsed.rows);

  for (const name of names) {
    let resolved = false;
    try {
      resolved = await resolvePlugin(name, { profileDir, repoPath, fsOps });
    } catch {
      resolved = false;
    }
    if (!resolved) return { ok: false, reason: "plugin-unresolvable", plugin: name, templateWarnings };
  }

  const metadata = await readIfExists(path.join(sourceDir, METADATA_FILE), fsOps);
  let sanitizedMetadata = "";
  if (metadata !== undefined) {
    const metadataResult = expandPresetTemplate(metadata, {
      repoPath,
      dshHome,
      userProfile,
      tasksFile,
      sourceName: METADATA_FILE,
      logger
    });
    templateWarnings.push(...metadataResult.warnings);
    sanitizedMetadata = sanitizeMetadata(metadataResult.content);
    if (sanitizedMetadata === undefined) {
      return { ok: false, reason: "metadata-invalid", templateWarnings: mergeTemplateWarnings(templateWarnings) };
    }
  }
  return {
    ok: true,
    composition,
    metadata: sanitizedMetadata,
    templateWarnings: mergeTemplateWarnings(templateWarnings)
  };
}

async function atomicReplace(filePath, content, fsOps = defaultFs) {
  const directory = path.dirname(filePath);
  await fsOps.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fsOps.writeFile(tempPath, content, "utf8");
  try {
    await fsOps.rename(tempPath, filePath);
  } catch (error) {
    // Windows refuses rename over an existing file. Move the existing managed
    // file aside, replace it, and restore it if the second rename fails.
    const backupPath = `${filePath}.replace-backup-${process.pid}-${Date.now()}`;
    let movedExisting = false;
    try {
      await fsOps.rename(filePath, backupPath);
      movedExisting = true;
      await fsOps.rename(tempPath, filePath);
      await fsOps.rm(backupPath, { force: true });
    } catch (replaceError) {
      if (movedExisting) {
        try { await fsOps.rename(backupPath, filePath); } catch { /* preserve the original failure */ }
      }
      try { await fsOps.rm(tempPath, { force: true }); } catch { /* best effort cleanup */ }
      throw replaceError;
    }
  }
}

function markerOwnsTarget(marker, targetHashes) {
  const files = marker?.files;
  if (!files || typeof files !== "object") return false;
  return files.compositionTargetHash === targetHashes.composition &&
    files.metadataTargetHash === targetHashes.metadata;
}

async function writeMarker(targetDir, marker, fsOps = defaultFs) {
  await atomicReplace(
    path.join(targetDir, MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
    fsOps
  );
}

/**
 * Synchronize one preset without overwriting a user-owned target.
 */
async function syncPreset({
  sourceDir,
  targetDir,
  presetId = "sagitta",
  sourceCommit,
  profileDir,
  repoPath,
  dshHome,
  userProfile,
  tasksFile,
  logger = console,
  force = false,
  resolvePlugin,
  fsOps = defaultFs
}) {
  const validation = await validatePresetSource(sourceDir, {
    profileDir,
    repoPath,
    dshHome,
    userProfile,
    tasksFile,
    logger,
    resolvePlugin,
    fsOps
  });
  if (!validation.ok) {
    return {
      status: "skipped",
      reason: validation.reason,
      plugin: validation.plugin,
      templateWarnings: validation.templateWarnings || []
    };
  }

  const composition = validation.composition;
  const metadata = validation.metadata || "";
  const templateWarnings = validation.templateWarnings || [];
  const sourceHashes = {
    composition: sha256(composition),
    metadata: sha256(metadata)
  };
  const targetCompositionPath = path.join(targetDir, COMPOSITION_FILE);
  const targetMetadataPath = path.join(targetDir, METADATA_FILE);
  const targetMarkerPath = path.join(targetDir, MARKER_FILE);
  const targetComposition = await readIfExists(targetCompositionPath, fsOps);
  const targetMetadata = await readIfExists(targetMetadataPath, fsOps);
  const markerText = await readIfExists(targetMarkerPath, fsOps);
  let marker;
  try { marker = markerText ? JSON.parse(markerText) : undefined; } catch { marker = undefined; }

  const targetHashes = {
    composition: sha256(targetComposition || ""),
    metadata: sha256(targetMetadata || "")
  };
  const targetExists = targetComposition !== undefined || targetMetadata !== undefined || markerText !== undefined;
  const alreadyCurrent = targetComposition === composition && targetMetadata === metadata;
  const owned = !targetExists || markerOwnsTarget(marker, targetHashes) || force;

  if (alreadyCurrent) {
    await fsOps.mkdir(targetDir, { recursive: true });
    await writeMarker(targetDir, {
      version: 1,
      presetId,
      sourceCommit: sourceCommit || null,
      sourceHashes,
      files: {
        compositionTargetHash: sourceHashes.composition,
        metadataTargetHash: sourceHashes.metadata
      }
    }, fsOps);
    return { status: "up-to-date", targetDir, changed: false, templateWarnings };
  }

  if (!owned) {
    const candidateId = sourceHashes.composition.slice(0, 12);
    await fsOps.mkdir(targetDir, { recursive: true });
    await atomicReplace(`${targetCompositionPath}.update-candidate.${candidateId}`, composition, fsOps);
    await atomicReplace(`${targetMetadataPath}.update-candidate.${candidateId}`, metadata, fsOps);
    return { status: "candidate", targetDir, changed: false, candidateId, templateWarnings };
  }

  await fsOps.mkdir(targetDir, { recursive: true });
  await atomicReplace(targetCompositionPath, composition, fsOps);
  await atomicReplace(targetMetadataPath, metadata, fsOps);
  await writeMarker(targetDir, {
    version: 1,
    presetId,
    sourceCommit: sourceCommit || null,
    sourceHashes,
    files: {
      compositionTargetHash: sourceHashes.composition,
      metadataTargetHash: sourceHashes.metadata
    }
  }, fsOps);
  return { status: targetExists ? "updated" : "installed", targetDir, changed: true, templateWarnings };
}

export {
  COMPOSITION_FILE,
  MARKER_FILE,
  METADATA_FILE,
  atomicReplace,
  compositionProblem,
  expandPresetTemplate,
  getPresetTemplateVariables,
  parseComposition,
  sanitizeMetadata,
  sha256,
  syncPreset,
  validatePresetSource
};
