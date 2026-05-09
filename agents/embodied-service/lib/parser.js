/**
 * Gemma-Andy response parser.
 *
 * Output shape (raw/gemma-andy/gemma-andy-integration-guide.md):
 *
 *   <think>...</think>?    // optional, only on medium+ risk / multi-step / recovery / adverse state
 *
 *   {
 *     "body_plan":        [...],
 *     "checks":           [...],
 *     "tool_calls":       [...],
 *     "failure_policy":   "...",
 *     "operational_risk": "none | low | medium | high | critical"
 *   }
 *
 * Rule 6 (the 6 hard rules): parser must tolerate ~1% of outputs with
 * residual text around the JSON. Strategy:
 *   1. Strip optional <think>...</think> prefix (record content for audit).
 *   2. Try JSON.parse on the stripped output.
 *   3. On failure, locate first `{` and last `}` and parse that substring.
 *   4. On second failure, throw with the raw text for the caller to log.
 */

const REQUIRED_FIELDS = [
  "body_plan",
  "checks",
  "tool_calls",
  "failure_policy",
  "operational_risk",
];

const VALID_RISK = new Set(["none", "low", "medium", "high", "critical"]);

export function stripThink(text) {
  const t = text.trimStart();
  if (!t.startsWith("<think>")) return { think: null, rest: text };
  const end = t.indexOf("</think>");
  if (end === -1) {
    // Malformed <think> with no close — treat the whole prefix as think
    // up to the next `{` as a defensive fallback.
    const brace = t.indexOf("{");
    if (brace === -1) return { think: t.slice(7), rest: "" };
    return { think: t.slice(7, brace).trim(), rest: t.slice(brace) };
  }
  return {
    think: t.slice(7, end).trim(),
    rest: t.slice(end + "</think>".length).trim(),
  };
}

function bracketFallback(s) {
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

export function parseGemmaAndyResponse(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("empty response from Gemma-Andy");
  }

  const { think, rest } = stripThink(rawText);
  let body = rest.trim();
  let parsed;

  try {
    parsed = JSON.parse(body);
  } catch (_e) {
    const fallback = bracketFallback(body);
    if (!fallback) {
      throw new Error(
        `unparseable Gemma-Andy output (no JSON braces found): ${rawText.slice(0, 200)}`,
      );
    }
    try {
      parsed = JSON.parse(fallback);
    } catch (e2) {
      throw new Error(
        `unparseable Gemma-Andy output even with bracket fallback: ${e2.message}\nraw: ${rawText.slice(0, 400)}`,
      );
    }
  }

  // Validate required fields.
  const missing = REQUIRED_FIELDS.filter((f) => !(f in parsed));
  if (missing.length > 0) {
    throw new Error(`Gemma-Andy output missing required fields: ${missing.join(", ")}`);
  }
  if (!Array.isArray(parsed.body_plan)) {
    throw new Error("body_plan must be an array");
  }
  if (!Array.isArray(parsed.checks)) {
    throw new Error("checks must be an array");
  }
  if (!Array.isArray(parsed.tool_calls)) {
    throw new Error("tool_calls must be an array");
  }
  if (typeof parsed.failure_policy !== "string") {
    throw new Error("failure_policy must be a string");
  }
  if (!VALID_RISK.has(parsed.operational_risk)) {
    throw new Error(
      `operational_risk must be one of ${[...VALID_RISK].join("|")}, got ${parsed.operational_risk}`,
    );
  }

  // Per-tool-call shape: {name: string, arguments: object}
  for (const [i, call] of parsed.tool_calls.entries()) {
    if (typeof call?.name !== "string" || !call.name) {
      throw new Error(`tool_calls[${i}].name missing or non-string`);
    }
    if (typeof call?.arguments !== "object" || call.arguments === null) {
      // Some calls may omit args legitimately (e.g. stop_movement); coerce to {}.
      call.arguments = call.arguments ?? {};
    }
  }

  return { think, plan: parsed };
}
