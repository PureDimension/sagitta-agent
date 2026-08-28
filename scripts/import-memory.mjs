#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SagittaMemoryClient } from "../lib/client.js";
import { resolveConfig, STREAMS } from "../lib/config.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    if (key === "help" || key === "apply") {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/import-memory.mjs --in FILE [options]

Options:
  --in FILE           JSONL export produced by export-memory.mjs (required)
  --apply             perform writes; without this flag only validate/preview
  --map FILE          resume map (default: FILE.map.json)
  --env-file FILE     credentials/config .env path
  --base-url URL      override the Worker URL
  --proxy VALUE       direct or http://host:port
  --stream NAME       import one stream
  --help              show this help

Import creates new server-managed ids. It preserves entry material and trust
counters, recreates supersede links when possible, and best-effort restores
validated/archived status. Original ids, timestamps, and audit-event ids are
not portable through the current Worker API.`);
}

function readBackup(filePath) {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const parsed = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  });
  const header = parsed.find((item) => item.kind === "sagitta-memory-export");
  if (!header || header.schema_version !== 1) throw new Error("unsupported or missing Sagitta memory export header");
  return parsed.filter((item) => item.entry && item.entry.id);
}

function entryPayload(entry, mappedSupersedes) {
  const payload = {
    type: entry.type,
    content: entry.content,
    origin: entry.origin || "sagitta",
    evidence: entry.evidence || "plausible",
  };
  for (const key of ["domain", "condition", "source_task_id", "tier", "ttl"]) {
    if (entry[key] !== null && entry[key] !== undefined && entry[key] !== "") payload[key] = entry[key];
  }
  if (Array.isArray(entry.tags) && entry.tags.length) payload.tags = entry.tags;
  if (entry.pinned === 1 || entry.pinned === true) payload.pinned = true;
  if (Array.isArray(mappedSupersedes) && mappedSupersedes.length) payload.supersedes = mappedSupersedes;
  for (const key of ["ack_count", "explicit_ack_count", "unobjected_ack_count", "oppose_count", "cross_session_count"]) {
    if (Number.isInteger(entry[key]) && entry[key] >= 0) payload[key] = entry[key];
  }
  return payload;
}

function validateRecord(record) {
  const entry = record.entry;
  const stream = record.stream || entry.stream;
  if (!STREAMS.includes(stream)) throw new Error(`invalid stream for source id ${entry.id}: ${stream}`);
  if (typeof entry.type !== "string" || typeof entry.content !== "string" || entry.content.length === 0) {
    throw new Error(`source entry ${entry.id} lacks type/content`);
  }
  return { entry, stream };
}

function loadMap(mapPath) {
  try {
    const parsed = JSON.parse(readFileSync(mapPath, "utf8"));
    return new Map(Object.entries(parsed.mappings || {}));
  } catch (error) {
    if (error && error.code === "ENOENT") return new Map();
    throw new Error(`invalid import map ${mapPath}: ${error.message}`);
  }
}

function saveMap(mapPath, mappings) {
  mkdirSync(path.dirname(mapPath), { recursive: true });
  writeFileSync(mapPath, `${JSON.stringify({ version: 1, mappings: Object.fromEntries(mappings) }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(mapPath, 0o600);
}

function latestValidationEvent(entry) {
  const events = Array.isArray(entry.validation_events) ? entry.validation_events : [];
  return events.find((event) => event && event.event_type === "validated" && typeof event.blind_spot === "string" && event.blind_spot.length > 0);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
if (!args.in) throw new Error("--in is required");
const inputPath = path.resolve(args.in);
const records = readBackup(inputPath).map(validateRecord).filter(({ stream }) => !args.stream || stream === args.stream);
if (args.stream && !STREAMS.includes(args.stream)) throw new Error(`invalid stream: ${args.stream}`);
const mapPath = path.resolve(args.map || `${inputPath}.map.json`);
const mappings = loadMap(mapPath);
const sourceIds = new Set(records.map(({ entry }) => entry.id));
const warnings = [];

for (const { entry, stream } of records) {
  const refs = Array.isArray(entry.supersedes) ? entry.supersedes : [];
  for (const ref of refs) {
    if (!sourceIds.has(ref) && !mappings.has(ref)) {
      warnings.push(`${entry.id}: supersedes source id ${ref} is outside this backup and will be omitted`);
    }
  }
}

if (!args.apply) {
  console.log(`dry-run: ${records.length} entries are valid; no API writes performed`);
  console.log(`map file would be: ${mapPath}`);
  for (const warning of warnings.slice(0, 20)) console.log(`WARN: ${warning}`);
  if (warnings.length > 20) console.log(`WARN: ${warnings.length - 20} more warning(s)`);
  process.exit(0);
}

const overrides = {};
if (args["env-file"]) overrides.envPath = path.resolve(args["env-file"]);
if (args["base-url"]) overrides.baseUrl = args["base-url"];
if (args.proxy) overrides.proxy = args.proxy;
const client = new SagittaMemoryClient(resolveConfig(overrides));
await client.health();

const pending = records.filter(({ entry }) => !mappings.has(entry.id));
while (pending.length > 0) {
  let progress = false;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const { entry, stream } = pending[i];
    const refs = Array.isArray(entry.supersedes) ? entry.supersedes : [];
    const waitsFor = refs.some((ref) => sourceIds.has(ref) && !mappings.has(ref));
    if (waitsFor) continue;
    const mappedRefs = refs.filter((ref) => mappings.has(ref)).map((ref) => mappings.get(ref));
    const created = await client.createEntry(stream, entryPayload(entry, mappedRefs));
    if (!created || typeof created.id !== "string") throw new Error(`create returned no id for source ${entry.id}`);
    mappings.set(entry.id, created.id);
    saveMap(mapPath, mappings);
    pending.splice(i, 1);
    progress = true;
    console.log(`created ${stream}/${created.id} from source ${entry.id}`);
  }
  if (progress) continue;

  // A cycle cannot be represented by the Worker create contract. Create one
  // without links so the rest of the backup remains recoverable and report it.
  const fallback = pending.pop();
  const mappedRefs = (Array.isArray(fallback.entry.supersedes) ? fallback.entry.supersedes : [])
    .filter((ref) => mappings.has(ref)).map((ref) => mappings.get(ref));
  const created = await client.createEntry(fallback.stream, entryPayload(fallback.entry, mappedRefs));
  mappings.set(fallback.entry.id, created.id);
  saveMap(mapPath, mappings);
  warnings.push(`${fallback.entry.id}: supersede cycle or unresolved dependency; created without some links`);
  console.log(`created ${fallback.stream}/${created.id} from source ${fallback.entry.id} (link warning)`);
}

// Restore terminal status only after all creates, so supersede links exist.
for (const { entry, stream } of records) {
  const targetId = mappings.get(entry.id);
  if (entry.status === "validated") {
    const event = latestValidationEvent(entry);
    if (!event) {
      warnings.push(`${entry.id}: validated status not restored because no validated event with blind_spot was exported`);
      continue;
    }
    await client.consolidate({
      items: [{
        id: targetId,
        action: "validate",
        blind_spot: event.blind_spot,
        ...(typeof event.explanation === "string" ? { explanation: event.explanation } : {}),
        ...(typeof event.linked_delegation_id === "string" ? { linked_delegation_id: event.linked_delegation_id } : {}),
      }],
    });
  } else if (entry.status === "archived") {
    try {
      await client.consolidate({ items: [{ id: targetId, action: "archive" }] });
    } catch (error) {
      warnings.push(`${entry.id}: archived status not restored: ${error.message}`);
    }
  } else if (entry.status === "superseded" && (!Array.isArray(entry.superseded_by) || entry.superseded_by.length === 0)) {
    warnings.push(`${entry.id}: source was superseded but has no superseded_by link to recreate`);
  }
}

console.log(`import complete: ${records.length} entries processed`);
for (const warning of warnings.slice(0, 50)) console.log(`WARN: ${warning}`);
if (warnings.length > 50) console.log(`WARN: ${warnings.length - 50} more warning(s)`);
