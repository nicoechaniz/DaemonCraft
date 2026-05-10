/**
 * Default values applied when the intent omits them.
 *
 * Per `raw/gemma-andy/integration-options-decision.md` — the embodied
 * service has its own "safe set" defaults so callers can pass only an
 * intent and get reasonable behavior.
 */
export const DEFAULT_GUARDIAN_CONSTRAINTS = {
  autonomy_level: 2,            // constructor supervisado
  // EXPLORATION MODE — guardian constraints disabled for capability testing.
  // Re-enable for production: no_tnt: true, no_protected_zone_edit: true
};

/**
 * Default `allowed_tools` when the caller passes null.
 *
 * EXPLORATION MODE: null → filterSupported(null) returns ALL 42
 * executor_supported tools from the canonical schema. Gemma-Andy has
 * unrestricted access for capability testing.
 *
 * Production: replace null with an explicit safe-subset array.
 */
export const DEFAULT_ALLOWED_TOOLS = null;

/** Default deadline for the whole intent (compose + Ollama + dispatch). */
export const DEFAULT_DEADLINE_SECONDS = 30;
