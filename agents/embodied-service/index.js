#!/usr/bin/env node
/**
 * DaemonCraft Embodied Service v1 (Path B canonical).
 *
 * The bridge between Hermes' cognition and Gemma-Andy's body
 * orchestration. Hermes calls `embodied_plan(intent, ...)` which hits
 * `POST /intent` here. We compose a canonical Gemma-Andy v2 payload,
 * call Ollama, parse, dispatch each tool_call to bot/server.js, and
 * return `{ok, plan, execution_results, elapsed_seconds, context_id}`.
 *
 * v1 disciplina (per integration-options-decision.md):
 *   - No persistent memory between intents
 *   - No intent priority queue (FIFO, one at a time, serialized by HTTP)
 *   - No own Mineflayer session (RPC to bot/server.js)
 *   - No auto-initiative
 *   - No clean cancellation (kill = kill)
 *   - No progress estimation
 *
 * Port: 7790 (override via EMBODIED_SERVICE_PORT).
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { loadSchema, filterSupported } from "./lib/schema.js";
import { composeWorldState } from "./lib/world_state.js";
import { callGemmaAndy, GEMMA_ANDY_MODEL, OLLAMA_URL } from "./lib/ollama.js";
import { parseGemmaAndyResponse } from "./lib/parser.js";
import { dispatch } from "./lib/dispatcher.js";
import { applyMitigations } from "./lib/mitigations.js";
import {
  DEFAULT_GUARDIAN_CONSTRAINTS,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_DEADLINE_SECONDS,
} from "./lib/defaults.js";

const PORT = Number(process.env.EMBODIED_SERVICE_PORT || 7790);

// Load schema once at startup so /health surfaces it.
const schema = loadSchema();
console.log(
  JSON.stringify({
    event: "service_start",
    port: PORT,
    ollama_url: OLLAMA_URL,
    model: GEMMA_ANDY_MODEL,
    schema_version: schema.version ?? schema._meta?.version_label ?? schema._meta?.version,
    schema_total: schema.allowed_tools.length,
    schema_supported: schema._supported.size,
    schema_loaded_from: schema._loaded_from,
  }),
);

function logEvent(obj) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleIntent(req, res) {
  const context_id = randomUUID();
  const t0 = Date.now();
  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    return jsonResponse(res, 400, {
      ok: false,
      context_id,
      error: { error_type: "bad_json", details: err.message },
    });
  }

  const {
    intent,
    autonomy_level = DEFAULT_GUARDIAN_CONSTRAINTS.autonomy_level,
    allowed_tools = null,
    guardian_constraints = null,
    previous_error = null,
    deadline_seconds = DEFAULT_DEADLINE_SECONDS,
  } = body;

  if (!intent || typeof intent !== "string") {
    return jsonResponse(res, 400, {
      ok: false,
      context_id,
      error: { error_type: "missing_intent", details: "intent (string) required" },
    });
  }

  logEvent({ event: "intent_received", context_id, intent: intent.slice(0, 200) });

  // Compose constraints (caller overrides defaults).
  const constraints = {
    ...DEFAULT_GUARDIAN_CONSTRAINTS,
    autonomy_level,
    ...(guardian_constraints ?? {}),
  };

  // Filter allowed_tools by executor_supported. If caller passed null,
  // start from DEFAULT_ALLOWED_TOOLS; either way the schema filter is
  // the final authority.
  const requested = allowed_tools == null ? DEFAULT_ALLOWED_TOOLS : allowed_tools;
  const filtered_allowed_tools = filterSupported(requested);

  // Read world_state (parallel HTTP to bot/server.js). Failure here is
  // a hard error: without world_state the model can't plan.
  let world_state;
  try {
    world_state = await composeWorldState();
  } catch (err) {
    logEvent({ event: "world_state_failed", context_id, error: err.message });
    return jsonResponse(res, 502, {
      ok: false,
      context_id,
      error: { error_type: "world_state_unavailable", details: err.message },
    });
  }

  // Compose canonical payload (Rule 2: sort_keys=True ASCII-only is in
  // ollama.js's canonicalStringify; we just build the object here).
  const payload = {
    high_level_command: intent,
    world_state,
    allowed_tools: filtered_allowed_tools,
    guardian_constraints: constraints,
    previous_error: previous_error ?? null,
  };

  // Full payload logged for audit replay. Per E002 Phase 6 acceptance,
  // logs must capture "the assembled payload" — not just keys.
  logEvent({
    event: "ollama_call_start",
    context_id,
    payload,
    allowed_count: filtered_allowed_tools.length,
  });

  // Call Gemma-Andy. The deadline is enforced via AbortController.
  const controller = new AbortController();
  const deadline_ms = Math.max(1000, deadline_seconds * 1000);
  const deadline_timer = setTimeout(() => controller.abort(), deadline_ms);

  let ollama_result;
  try {
    ollama_result = await callGemmaAndy(payload, { signal: controller.signal });
  } catch (err) {
    clearTimeout(deadline_timer);
    logEvent({ event: "ollama_call_failed", context_id, error: err.message });
    return jsonResponse(res, 502, {
      ok: false,
      context_id,
      error: { error_type: "ollama_call_failed", details: err.message },
    });
  } finally {
    clearTimeout(deadline_timer);
  }

  // Parse the response.
  let parsed;
  try {
    parsed = parseGemmaAndyResponse(ollama_result.raw);
  } catch (err) {
    logEvent({
      event: "parse_failed",
      context_id,
      error: err.message,
      raw_excerpt: ollama_result.raw.slice(0, 400),
    });
    return jsonResponse(res, 502, {
      ok: false,
      context_id,
      error: { error_type: "parse_failed", details: err.message },
      _raw: ollama_result.raw.slice(0, 1000),
    });
  }

  // Full parsed plan logged for audit replay. Per E002 Phase 6
  // acceptance — "the parsed plan" — the whole plan, not just metrics.
  logEvent({
    event: "ollama_call_done",
    context_id,
    elapsed_ms: ollama_result.elapsed_ms,
    operational_risk: parsed.plan.operational_risk,
    tool_call_count: parsed.plan.tool_calls.length,
    had_think: parsed.think != null,
    plan: parsed.plan,
    think: parsed.think,
  });

  // Apply consumer-side mitigations for known model regressions
  // (recovery naive-retry, empty tool_calls). See lib/mitigations.js.
  const { plan: mitigated_plan, mitigations } = applyMitigations(body, parsed);
  if (mitigations.length > 0) {
    for (const m of mitigations) {
      logEvent({ event: "mitigation_applied", context_id, ...m });
    }
  }

  // Dispatch each tool_call in order. Stop on first failure (Hermes
  // can resend with previous_error).
  const execution_results = [];
  for (const call of mitigated_plan.tool_calls) {
    const r = await dispatch(call);
    execution_results.push(r);
    logEvent({
      event: "tool_dispatch",
      context_id,
      tool: r.tool,
      ok: r.ok,
      error_type: r.error_type,
    });
    if (!r.ok) break;
  }

  const elapsed_seconds = (Date.now() - t0) / 1000;
  const all_ok = execution_results.every((r) => r.ok);

  // E002 Phase 6 acceptance — total elapsed_seconds.
  logEvent({
    event: "intent_done",
    context_id,
    ok: all_ok,
    elapsed_seconds,
    tool_call_count: mitigated_plan.tool_calls.length,
    mitigation_count: mitigations.length,
    operational_risk: mitigated_plan.operational_risk,
  });

  return jsonResponse(res, 200, {
    ok: all_ok,
    context_id,
    plan: mitigated_plan,
    plan_original: mitigations.length > 0 ? parsed.plan : undefined,
    think: parsed.think,
    mitigations: mitigations.length > 0 ? mitigations : undefined,
    execution_results,
    elapsed_seconds,
    model: ollama_result.model,
  });
}

const server = http.createServer(async (req, res) => {
  // CORS-friendly defaults for ad-hoc curl from anywhere.
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET" && req.url === "/health") {
    return jsonResponse(res, 200, {
      ok: true,
      service: "daemoncraft-embodied-service",
      version: "0.1.0",
      port: PORT,
      ollama_url: OLLAMA_URL,
      model: GEMMA_ANDY_MODEL,
      schema_version: schema.version ?? schema._meta?.version_label ?? schema._meta?.version,
      schema_total: schema.allowed_tools.length,
      schema_supported: schema._supported.size,
    });
  }

  if (req.method === "POST" && req.url === "/intent") {
    try {
      return await handleIntent(req, res);
    } catch (err) {
      logEvent({ event: "handler_exception", error: err.message, stack: err.stack });
      return jsonResponse(res, 500, {
        ok: false,
        error: { error_type: "handler_exception", details: err.message },
      });
    }
  }

  jsonResponse(res, 404, { ok: false, error: { error_type: "not_found", path: req.url } });
});

server.listen(PORT, () => {
  console.log(`embodied-service listening on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown so systemd can restart cleanly.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    logEvent({ event: "shutdown", signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
