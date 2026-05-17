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
import { setBotUrl } from "./lib/refs.js";
import { applyMitigations } from "./lib/mitigations.js";
import {
  DEFAULT_GUARDIAN_CONSTRAINTS,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_DEADLINE_SECONDS,
} from "./lib/defaults.js";
import { appendFile } from "node:fs/promises";

const PORT = Number(process.env.EMBODIED_SERVICE_PORT || 7790);

// Verification logging — JSONL for later analysis.
const VERIFICATION_LOG_PATH = process.env.VERIFICATION_LOG_PATH
  || `${process.env.HOME}/.local/share/daemoncraft/lab/logs/intent_verification.jsonl`;

async function writeVerificationLog(entry) {
  try {
    await appendFile(VERIFICATION_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Fire-and-forget: never fail the intent for logging issues.
    logEvent({ event: "verification_log_failed", error: err.message });
  }
}

function detectLanguage(text) {
  if (!text) return "en";
  const lowered = text.toLowerCase();
  const esTokens = /\b(á|é|í|ó|ú|ñ|traé|miná|andá|vení|acordate|recordá|marcá|volvé|alejate|comé|tirá|equipá|recogé|agarrá|construí|atacá|defendé|seguime|decime|mostrame|hacé|algo|después|luego|jugador|posición|madera|cerca|lejos|aquí|acá|allí|ahí)\b/;
  const enTokens = /\b(mine|go to|goto|follow|come|approach|eat|get|toss|equip|pick up|build|attack|defend|remember|return|move away|show|tell|player|position|wood|here|there|near|far|after|then)\b/;
  const hasEs = esTokens.test(lowered);
  const hasEn = enTokens.test(lowered);
  if (hasEs && hasEn) return "mixed";
  if (hasEs) return "es";
  return "en";
}

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

/** POST embodied activity to the bot's dashboard WebSocket relay. */
async function sendDashboardUpdate(botUrl, data) {
  if (!botUrl) return;
  try {
    await fetch(`${botUrl}/dashboard/embodied`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, timestamp: Date.now() }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Dashboard might be down or unreachable — never fail the intent for this
  }
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
    bot_api_url = null,
    _verification_meta = null,
  } = body;

  if (!intent || typeof intent !== "string") {
    return jsonResponse(res, 400, {
      ok: false,
      context_id,
      error: { error_type: "missing_intent", details: "intent (string) required" },
    });
  }

  // Set per-request bot URL for multi-bot dispatch
  setBotUrl(bot_api_url);
  logEvent({ event: "intent_received", context_id, intent: intent.slice(0, 200), bot_api_url });

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
    world_state = await composeWorldState({ botUrl: bot_api_url, intent });
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
    const raw_text = ollama_result.raw ?? "";
    // Truncation heuristic: Gemma-Andy's response shape ends with `}`
    // (outer object close). If the last `}` is missing entirely, or
    // appears more than 50 chars before the end, treat as truncated.
    // Using only `}` (not `]`) avoids false negatives when the inner
    // tool_calls array closes but the outer object never does — an
    // observed failure mode when num_predict cuts mid-emit.
    const last_brace = raw_text.lastIndexOf("}");
    const truncated_heuristic = raw_text.length > 0
      && (last_brace === -1 || last_brace < raw_text.length - 50);
    logEvent({
      event: "parse_failed",
      context_id,
      error: err.message,
      raw_excerpt: raw_text.slice(0, 400),
      raw_length_chars: raw_text.length,
      truncated: truncated_heuristic,
    });
    // Mitigation: if the model returned an empty string, synthesize a
    // signal so upstream can act. This is a regression observed in
    // field-test 2026-05-09 — distinct from `empty_tool_calls` (where
    // the model produced JSON with tool_calls=[]); here the model
    // produced literally nothing. See lib/mitigations.js for the
    // post-parse counterpart.
    const isEmptyResponse = !ollama_result.raw || !ollama_result.raw.trim();
    if (isEmptyResponse) {
      const synthesized = {
        name: "raise_guardian_event",
        arguments: {
          category: "model_unavailable",
          reason: "Gemma-Andy returned empty response; consumer-side mitigation surfaces as guardian event",
          command_excerpt: (intent || "").slice(0, 200),
        },
      };
      logEvent({
        event: "mitigation_applied",
        context_id,
        regression: "empty_model_response",
        pattern_detected: "Ollama returned empty raw output",
        action_taken: "synthesized raise_guardian_event(model_unavailable) so upstream sees a signal",
      });
      const r = await dispatch(synthesized, null, filtered_allowed_tools);
      const elapsed_seconds = (Date.now() - t0) / 1000;
      logEvent({
        event: "intent_done",
        context_id,
        ok: false,
        elapsed_seconds,
        tool_call_count: 1,
        mitigation_count: 1,
        operational_risk: "none",
      });
      return jsonResponse(res, 200, {
        ok: false,
        context_id,
        // Populate `error` so upstream consumers (embodied_plan_tool.py,
        // local_agent/embodied.py) don't fall through to "unknown error".
        // The structured `plan`/`execution_results`/`mitigations` below
        // are kept for full observability.
        error: {
          error_type: "empty_model_response",
          details:
            "Ollama returned empty raw output; consumer-side mitigation synthesized raise_guardian_event(model_unavailable)",
        },
        plan: {
          body_plan: ["model returned empty response; consumer-side mitigation"],
          checks: ["parse_failed with empty raw — likely Ollama or model availability issue"],
          tool_calls: [synthesized],
          failure_policy: "retry once; if persists, escalate via raise_guardian_event(model_unavailable)",
          operational_risk: "none",
        },
        mitigations: [{
          regression: "empty_model_response",
          pattern_detected: "Ollama returned empty raw output (parser would fail)",
          action_taken: "synthesized raise_guardian_event(model_unavailable)",
          synthesized_tool_calls: [synthesized],
        }],
        execution_results: [r],
        elapsed_seconds,
        model: ollama_result.model,
      });
    }
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
    think_excerpt: typeof parsed.think === "string" ? parsed.think.slice(0, 500) : null,
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

  // ── Dispatch tool_calls in order, fail-fast on first failure ─────
  // Per Mariano's canonical design: the embodied service is stateless
  // and fail-fast. Recovery (previous_error, deterministic synthesis)
  // is the consumer's (Hermes agent_loop) responsibility.
  const execution_results = [];
  for (const call of mitigated_plan.tool_calls) {
    const r = await dispatch(call, null, filtered_allowed_tools);
    execution_results.push(r);
    logEvent({
      event: "tool_dispatch",
      context_id,
      tool: r.tool,
      ok: r.ok,
      error_type: r.error_type,
      details: r.details ?? null,
      attempt: "first",
    });
    if (!r.ok) {
      break;
    }
  }

  const elapsed_seconds = (Date.now() - t0) / 1000;
  const all_ok = execution_results.length > 0 && execution_results.every((r) => r.ok);

  // ── Verification block (non-blocking, fire-and-forget log) ─────
  const firstFailure = execution_results.find((r) => !r.ok) ?? null;
  const expectedWorldStateKeys = [
    "biome", "bot_health", "bot_position", "dimension", "hazards",
    "hunger", "inventory", "light_level", "mbit_context", "nearby_blocks", "nearby_entities",
    "player_position", "time_of_day", "weather", "zone_owner",
  ];
  const worldStateKeysPresent = world_state
    ? expectedWorldStateKeys.filter((k) => k in world_state)
    : [];
  const worldStateKeysMissing = world_state
    ? expectedWorldStateKeys.filter((k) => !(k in world_state))
    : expectedWorldStateKeys;

  let executionOutcome;
  if (execution_results.length === 0) {
    executionOutcome = "no_tools_emitted";
  } else if (execution_results.every((r) => r.ok)) {
    executionOutcome = "all_ok";
  } else if (execution_results.some((r) => r.ok)) {
    executionOutcome = "partial_failure";
  } else {
    executionOutcome = "all_failed";
  }

  const verification = {
    intent_original: _verification_meta?.intent_original ?? intent,
    intent_inferred_language: detectLanguage(intent),
    allowed_tools_requested: requested,
    allowed_tools_filtered: filtered_allowed_tools,
    world_state_keys_present: worldStateKeysPresent,
    world_state_keys_missing: worldStateKeysMissing,
    execution_outcome: executionOutcome,
    first_failure: firstFailure
      ? { tool: firstFailure.tool, error_type: firstFailure.error_type, details: firstFailure.details }
      : null,
  };

  // Structured JSONL log for later analysis.
  const jsonlEntry = {
    timestamp: new Date().toISOString(),
    intent_original: _verification_meta?.intent_original ?? intent,
    intent_normalized: intent,
    policy_layer: _verification_meta?.policy_layer ?? "none",
    category: _verification_meta?.category ?? "unknown",
    allowed_tools: filtered_allowed_tools,
    execution_results: execution_results.map((r) => ({ tool: r.tool, ok: r.ok, error_type: r.error_type, details: r.details })),
    all_ok: all_ok,
    elapsed_ms: Math.round(elapsed_seconds * 1000),
  };
  writeVerificationLog(jsonlEntry);

  logEvent({
    event: "intent_done",
    context_id,
    ok: all_ok,
    elapsed_seconds,
    tool_call_count: execution_results.length,
    mitigation_count: mitigations.length,
    operational_risk: mitigated_plan.operational_risk,
  });

  // Send embodied activity to bot dashboard in real time
  sendDashboardUpdate(bot_api_url, {
    event: "intent_done",
    context_id,
    ok: all_ok,
    intent: intent.slice(0, 200),
    plan: mitigated_plan?.body_plan || [],
    tool_calls: (execution_results || []).map(r => ({ tool: r.tool, ok: r.ok, error_type: r.error_type })),
    elapsed_seconds,
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
    verification,
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
