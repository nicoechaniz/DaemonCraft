#!/usr/bin/env node
/**
 * Smoke-check mBit world_state injection without invoking Gemma-Andy/Ollama.
 *
 * Usage:
 *   BOT_API_URL=http://localhost:3003 node scripts/smoke_mbit_world_state.js "Go to the player safely"
 *
 * Prints the deterministic mBit selection, bounds, formats, and a small grid
 * excerpt so operators can verify that /blocks -> composeWorldState works.
 */
import { composeWorldState } from "../lib/world_state.js";

const intent = process.argv.slice(2).join(" ") || "Go to the player safely";
const botUrl = process.env.BOT_API_URL || "http://localhost:3003";

try {
  const ws = await composeWorldState({ botUrl, intent });
  const ctx = ws.mbit_context;
  if (!ctx || ctx.ok === false) {
    console.error(JSON.stringify({ ok: false, botUrl, intent, mbit_context: ctx }, null, 2));
    process.exit(1);
  }

  const summary = {
    ok: true,
    botUrl,
    intent,
    bot_position: ws.bot_position,
    purpose: ctx.purpose,
    formats: ctx.grids.map((g) => g.format),
    bounds_by_format: Object.fromEntries(ctx.grids.map((g) => [g.format, g.bounds])),
    counts: Object.fromEntries(ctx.grids.map((g) => [g.format, g.count])),
    legend: ctx.legend,
    interpretation_hint: ctx.interpretation_hint,
    excerpts: Object.fromEntries(ctx.grids.map((g) => [
      g.format,
      String(g.text || "").split("\n").slice(0, 8).join("\n"),
    ])),
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, botUrl, intent, error: err?.message || String(err) }, null, 2));
  process.exit(1);
}
