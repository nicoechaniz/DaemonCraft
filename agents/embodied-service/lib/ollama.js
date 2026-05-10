/**
 * Ollama client for Gemma-Andy.
 *
 * Endpoint: http://10.10.20.1:11434/api/chat (override via OLLAMA_URL)
 * Model:    gemma-andy:e4b-v2-2-3-q8_0       (override via GEMMA_ANDY_MODEL)
 *
 * Hard rules (raw/gemma-andy/gemma-andy-integration-guide.md):
 *
 *   1. NO system message in the request — the SYSTEM is baked into the
 *      Modelfile byte-exact with training (fix 7205b0a, 2026-05-08).
 *   2. Serialize the input JSON with sort_keys=True and ASCII-only.
 *      We use canonicalStringify below.
 *   3. Don't override sampling — Modelfile already pins
 *      temperature=0.2, top_p=0.9, min_p=0.05, repeat_penalty=1.05,
 *      num_ctx=131072.
 *
 * Rule 2 — the canonical serializer must match Python's
 *   `json.dumps(payload, sort_keys=True, ensure_ascii=True)`.
 * Implementation: recurse, sort object keys alphabetically, escape any
 * non-ASCII codepoint with \uXXXX. Arrays preserve order (the model was
 * trained on ordered tool_calls / blocks lists).
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://10.10.20.1:11434";
const GEMMA_ANDY_MODEL = process.env.GEMMA_ANDY_MODEL || "gemma-andy:e4b-v2-2-3-q8_0";

/**
 * Canonical JSON serializer matching `json.dumps(obj, sort_keys=True,
 * ensure_ascii=True)` from Python.
 */
export function canonicalStringify(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("non-finite number not JSON-serializable");
    }
    return String(value);
  }
  if (typeof value === "string") return canonicalEscapeString(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(", ") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const pairs = keys.map((k) => canonicalEscapeString(k) + ": " + canonicalStringify(value[k]));
    return "{" + pairs.join(", ") + "}";
  }
  throw new TypeError(`unsupported type for canonical JSON: ${typeof value}`);
}

function canonicalEscapeString(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0x22) {
      out += '\\"';
    } else if (cp === 0x5c) {
      out += "\\\\";
    } else if (cp < 0x20) {
      const named = { 0x08: "\\b", 0x09: "\\t", 0x0a: "\\n", 0x0c: "\\f", 0x0d: "\\r" }[cp];
      out += named ?? "\\u" + cp.toString(16).padStart(4, "0");
    } else if (cp < 0x7f) {
      // Printable ASCII
      out += ch;
    } else {
      // Non-ASCII → \uXXXX; surrogate-aware via codePointAt
      if (cp <= 0xffff) {
        out += "\\u" + cp.toString(16).padStart(4, "0");
      } else {
        // Emit surrogate pair
        const v = cp - 0x10000;
        const hi = 0xd800 + (v >> 10);
        const lo = 0xdc00 + (v & 0x3ff);
        out +=
          "\\u" +
          hi.toString(16).padStart(4, "0") +
          "\\u" +
          lo.toString(16).padStart(4, "0");
      }
    }
  }
  return out + '"';
}

/**
 * Call Gemma-Andy with the canonical payload. Returns the raw text from
 * the message.content of the response (caller passes it to parser.js).
 */
export async function callGemmaAndy(payload, { signal, options = {} } = {}) {
  const userContent = canonicalStringify(payload);
  const requestBody = {
    model: GEMMA_ANDY_MODEL,
    stream: false,
    // Rule 1: NO system message. Only `role: "user"`.
    messages: [{ role: "user", content: userContent }],
    options: {
      // Sampling: leave Modelfile defaults (temperature=0.2, top_p=0.9,
      // min_p=0.05, repeat_penalty=1.05, num_ctx=131072) UNTOUCHED.
      // Earlier field-test tried temperature=0.0 (greedy, mirroring
      // eval_with_adapter.py's do_sample=False) but it made the model
      // collapse to single-tool plans (e.g. "construyamos casa" emitted
      // ONLY scan_nearby, dropping the multi-step gather+build that
      // example #1 of the integration guide shows). Greedy is for
      // deterministic eval; production needs the small variance for
      // multi-step planning.
      num_predict: 512,
      ...options,
    },
  };

  const t0 = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal,
  });
  const elapsed_ms = Date.now() - t0;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/chat → ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const content = json?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`Ollama response missing message.content: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return {
    raw: content,
    model: json.model ?? GEMMA_ANDY_MODEL,
    elapsed_ms,
    eval_count: json.eval_count,
    prompt_eval_count: json.prompt_eval_count,
  };
}

export { OLLAMA_URL, GEMMA_ANDY_MODEL };
