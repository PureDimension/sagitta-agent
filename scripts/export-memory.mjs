#!/usr/bin/env node

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SagittaMemoryClient } from "../lib/client.js";
import { resolveConfig, STATUSES, STREAMS } from "../lib/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
    if (key === "help") {
      args.help = true;
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
  console.log(`Usage: node scripts/export-memory.mjs --out FILE [options]

Options:
  --out FILE          JSONL output path (required; file is sensitive)
  --env-file FILE     credentials/config .env path
  --base-url URL      override the Worker URL
  --proxy VALUE       direct or http://host:port
  --stream NAME       export one stream; default exports all four streams
  --page-size N       API page size, 1-100 (default: 100)
  --help              show this help

The export walks every stream and every status, including archived/superseded
entries. It does not print credentials or memory contents to stdout.`);
}

function value(args, key, fallback = undefined) {
  return args[key] === undefined ? fallback : args[key];
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
if (!args.out) throw new Error("--out is required");

const streams = args.stream ? [args.stream] : STREAMS;
for (const stream of streams) {
  if (!STREAMS.includes(stream)) throw new Error(`invalid stream: ${stream}`);
}
const pageSize = Number(value(args, "page-size", 100));
if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
  throw new Error("--page-size must be an integer between 1 and 100");
}

const overrides = {};
if (args["env-file"]) overrides.envPath = path.resolve(args["env-file"]);
if (args["base-url"]) overrides.baseUrl = args["base-url"];
if (args.proxy) overrides.proxy = args.proxy;
const config = resolveConfig(overrides);
const client = new SagittaMemoryClient(config);
const outPath = path.resolve(args.out);
const records = [];

const health = await client.health();
if (health.ok !== true) throw new Error("memory health check did not return ok:true");

for (const stream of streams) {
  for (const status of STATUSES) {
    let page = 1;
    while (true) {
      const data = await client.listEntries(stream, { page, size: pageSize, status });
      const items = Array.isArray(data.items) ? data.items : [];
      for (const entry of items) {
        records.push({
          schema_version: 1,
          exported_at: new Date().toISOString(),
          stream,
          entry,
        });
      }
      if (items.length < pageSize) break;
      page += 1;
    }
  }
}

mkdirSync(path.dirname(outPath), { recursive: true });
const header = {
  schema_version: 1,
  kind: "sagitta-memory-export",
  exported_at: new Date().toISOString(),
  streams,
  statuses: STATUSES,
  count: records.length,
};
const body = [header, ...records].map((item) => JSON.stringify(item)).join("\n") + "\n";
writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 });
chmodSync(outPath, 0o600);
console.log(`exported ${records.length} memory entries to ${path.relative(HERE, outPath) || outPath}`);
