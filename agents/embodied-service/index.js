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
    world_state = await composeWorldState({ botUrl: bot_api_url });
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
      const r = await dispatch(synthesized);
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

  // ── Dispatch with auto-retry via previous_error ──────────────────
  // Gemma-Andy was trained to produce recovery plans when previous_error
  // is populated. If a tool_call fails, we call the model again with the
  // failure details so it can replan — rather than failing immediately.
  const MAX_RETRIES = 1; // one recovery attempt per intent
  const all_results = [];
  let current_plan = mitigated_plan;
  let retry_used = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const batch_results = [];
    for (const call of current_plan.tool_calls) {
      const r = await dispatch(call);
      batch_results.push(r);
      logEvent({
        event: "tool_dispatch",
        context_id,
        tool: r.tool,
        ok: r.ok,
        error_type: r.error_type,
        attempt: attempt > 0 ? `retry_${attempt}` : "first",
      });
      if (!r.ok) {
        // Stop this batch. If we have retries left, prepare recovery.
        break;
      }
    }

    all_results.push(...batch_results);
    const batch_ok = batch_results.every((r) => r.ok);

    if (batch_ok || attempt >= MAX_RETRIES) {
      // Success or out of retries — done.
      break;
    }

    // Compose previous_error from the first failure in this batch
    const failed = batch_results.find((r) => !r.ok);
    const previous_error = {
      tool: failed.tool,
      error_type: failed.error_type || "other",
      details: failed.details || failed.error || "tool_call failed",
    };

    logEvent({
      event: "retry_with_previous_error",
      context_id,
      previous_error,
    });

    // Build recovery payload — same intent/world_state/constraints,
    // but with previous_error so Gemma-Andy composes a recovery plan.
    const recovery_payload = {
      high_level_command: intent,
      world_state,
      allowed_tools: filtered_allowed_tools,
      guardian_constraints: constraints,
      previous_error,
    };

    logEvent({
      event: "ollama_recovery_call_start",
      context_id,
      previous_error,
    });

    const RECOVERY_TIMEOUT_SEC = 30; // recovery gets its own budget, not the original deadline
    const recovery_controller = new AbortController();
    const recovery_timer = setTimeout(() => recovery_controller.abort(), RECOVERY_TIMEOUT_SEC * 1000);

    let recovery_result;
    try {
      recovery_result = await callGemmaAndy(recovery_payload, { signal: recovery_controller.signal });
    } catch (err) {
      clearTimeout(recovery_timer);
      logEvent({ event: "ollama_recovery_call_failed", context_id, error: err.message });
      break; // can't recover — return partial results
    } finally {
      clearTimeout(recovery_timer);
    }

    let recovery_parsed;
    try {
      recovery_parsed = parseGemmaAndyResponse(recovery_result.raw);
    } catch (err) {
      logEvent({ event: "recovery_parse_failed", context_id, error: err.message });
      break; // can't parse recovery — return partial results
    }

    logEvent({
      event: "ollama_recovery_call_done",
      context_id,
      elapsed_ms: recovery_result.elapsed_ms,
      tool_call_count: recovery_parsed.plan.tool_calls.length,
    });

    retry_used = true;
    current_plan = recovery_parsed.plan;
  }

  const elapsed_seconds = (Date.now() - t0) / 1000;
  const all_ok = all_results.length > 0 && all_results.every((r) => r.ok);

  logEvent({
    event: "intent_done",
    context_id,
    ok: all_ok,
    elapsed_seconds,
    tool_call_count: all_results.length,
    mitigation_count: mitigations.length,
    retry_used,
    operational_risk: mitigated_plan.operational_risk,
  });

  // Send embodied activity to bot dashboard in real time
  sendDashboardUpdate(bot_api_url, {
    event: "intent_done",
    context_id,
    ok: all_ok,
    intent: intent.slice(0, 200),
    plan: mitigated_plan?.body_plan || [],
    tool_calls: (all_results || []).map(r => ({ tool: r.tool, ok: r.ok, error_type: r.error_type })),
    retry_used,
    elapsed_seconds,
    operational_risk: mitigated_plan.operational_risk,
  });

  return jsonResponse(res, 200, {
    ok: all_ok,
    context_id,
    plan: mitigated_plan,
    plan_recovery: retry_used ? current_plan : undefined,
    plan_original: mitigations.length > 0 ? parsed.plan : undefined,
    think: parsed.think,
    mitigations: mitigations.length > 0 ? mitigations : undefined,
    execution_results: all_results,
    retry_used,
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
