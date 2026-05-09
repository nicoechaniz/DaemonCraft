/**
 * Tool schema loader + executor_supported filter.
 *
 * The schema is the consumer-side source of truth for which Gemma-Andy
 * tool names are canonical AND which the bot/server.js executor
 * implements today. The model knows all 68; we filter to the supported
 * subset before every Ollama call.
 *
 * The shipped `tool_schema_v2.json` was fetched from the canonical repo
 * at `Mar-IA-no/deamoncraft-gemma4-andy:schema/tool_schema_v2.json`
 * (provenance recorded in the JSON's `_meta` block). When a newer
 * version drops, re-fetch and replace the file in place.
 *
 * Override path via SCHEMA_PATH env var when consuming a different
 * version (e.g., a v3 trial).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = path.join(__dirname, "tool_schema_v2.json");

let _cache = null;

export function loadSchema(schemaPath = process.env.SCHEMA_PATH || DEFAULT_SCHEMA_PATH) {
  if (_cache && _cache._loaded_from === schemaPath) return _cache;
  const raw = fs.readFileSync(schemaPath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.allowed_tools)) {
    throw new Error(`schema at ${schemaPath} missing allowed_tools array`);
  }
  parsed._loaded_from = schemaPath;
  parsed._supported = new Set(
    parsed.allowed_tools.filter((t) => t.executor_supported).map((t) => t.name),
  );
  parsed._all = new Set(parsed.allowed_tools.map((t) => t.name));
  parsed._by_name = Object.fromEntries(parsed.allowed_tools.map((t) => [t.name, t]));
  _cache = parsed;
  return parsed;
}

export function isSupported(name, schema = loadSchema()) {
  return schema._supported.has(name);
}

export function isCanonical(name, schema = loadSchema()) {
  return schema._all.has(name);
}

export function filterSupported(allowed, schema = loadSchema()) {
  if (allowed == null) {
    return [...schema._supported].sort();
  }
  return allowed.filter((n) => schema._supported.has(n)).sort();
}

export function getToolDef(name, schema = loadSchema()) {
  return schema._by_name[name] ?? null;
}

/** Reset the cache. Tests use this when monkey-patching SCHEMA_PATH. */
export function _reset() {
  _cache = null;
}
