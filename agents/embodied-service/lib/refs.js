/**
 * Reference resolvers — translate Gemma-Andy v2 reference shapes into
 * the coordinate-pure args bot/server.js expects.
 *
 * Gemma-Andy v2 emits four reference shapes (per tool_schema_v2):
 *   - Position3D       : {x, y, z}        — used directly
 *   - BlockType / BlockRef : "oak_log"    — needs find_blocks
 *   - EntityRef        : "Skeleton" / "Steve" — needs find_entities
 *   - PlaceName        : "home"           — needs marks lookup
 *
 * The bot's ACTIONS table is coord-pure: most spatial actions take
 * {x,y,z}. We resolve the canonical ref against the live bot state
 * before dispatching.
 *
 * All resolvers return a Promise<{x,y,z}> on success or throw with a
 * structured Error so the dispatcher can surface error_type cleanly.
 */
const BOT_API_URL = process.env.BOT_API_URL || "http://localhost:3001";

class RefResolveError extends Error {
  constructor(error_type, details) {
    super(details);
    this.error_type = error_type;
    this.details = details;
  }
}

/** Lightweight HTTP wrappers. */
async function botPost(path, body) {
  const res = await fetch(`${BOT_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, body: data };
}

async function botGet(path) {
  const res = await fetch(`${BOT_API_URL}${path}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, body: data };
}

/**
 * Resolve a Position3D-shaped value.
 * Accepts {x,y,z} object or [x,y,z] array.
 */
function asPosition(p) {
  if (p == null) return null;
  if (typeof p === "object" && "x" in p && "y" in p && "z" in p) {
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }
  if (Array.isArray(p) && p.length === 3 && p.every((n) => typeof n === "number")) {
    return { x: Math.floor(p[0]), y: Math.floor(p[1]), z: Math.floor(p[2]) };
  }
  return null;
}

/**
 * Resolve `target` of canonical movement / building tools.
 *
 * @param target raw target ref (string block name, string entity name, {x,y,z}, place name)
 * @param target_type "coords" | "block" | "entity" | "remembered_place" — model-supplied
 * @param opts.radius search radius (default 32)
 *
 * Returns {x,y,z}. Throws RefResolveError on miss.
 */
async function resolveTarget(target, target_type, opts = {}) {
  if (target == null) {
    throw new RefResolveError("missing_target", "tool_call.arguments.target is required");
  }

  // Coords path: explicit or implicit (object/array)
  if (target_type === "coords" || (typeof target === "object" && target !== null)) {
    const pos = asPosition(target);
    if (!pos) throw new RefResolveError("bad_target", `target_type=coords but target shape unrecognized: ${JSON.stringify(target)}`);
    return pos;
  }

  // Block path: scan for the named block, pick nearest.
  if (target_type === "block" || target_type == null) {
    if (typeof target !== "string") {
      throw new RefResolveError("bad_target", `target_type=block expects string block name, got ${typeof target}`);
    }
    const radius = opts.radius ?? 32;
    const r = await botPost(`/action/find_blocks`, { block: target, radius, count: 1 });
    if (!r.ok) {
      throw new RefResolveError("ref_resolve_failed", `find_blocks(${target}) failed: ${r.body?.error ?? r.status}`);
    }
    const locs = r.body?.locations ?? [];
    if (!locs.length) {
      throw new RefResolveError("target_not_found", `No '${target}' found within ${radius} blocks. ${r.body?.result ?? ""}`.trim());
    }
    const nearest = locs[0];
    return { x: Math.floor(nearest.x), y: Math.floor(nearest.y), z: Math.floor(nearest.z) };
  }

  // Entity path: find by type/name, pick nearest.
  if (target_type === "entity") {
    if (typeof target !== "string") {
      throw new RefResolveError("bad_target", `target_type=entity expects string entity name, got ${typeof target}`);
    }
    const r = await botPost(`/action/find_entities`, { type: target, radius: opts.radius ?? 32 });
    if (!r.ok) {
      throw new RefResolveError("ref_resolve_failed", `find_entities(${target}) failed: ${r.body?.error ?? r.status}`);
    }
    const list = r.body?.entities ?? r.body?.result ?? [];
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) {
      throw new RefResolveError("target_not_found", `No entity matching '${target}' nearby.`);
    }
    const nearest = arr[0];
    const p = nearest.position ?? nearest;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }

  // Remembered place: look up via /action/marks (the bot returns a
  // free-text string; we parse the line for the matching name).
  if (target_type === "remembered_place") {
    if (typeof target !== "string") {
      throw new RefResolveError("bad_target", `target_type=remembered_place expects string name, got ${typeof target}`);
    }
    const r = await botPost(`/action/marks`, {});
    if (!r.ok) {
      throw new RefResolveError("ref_resolve_failed", `marks() failed: ${r.body?.error ?? r.status}`);
    }
    const text = r.body?.result ?? "";
    // Lines look like "name: x,y,z (Nm) — note"
    const re = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(-?\\d+),\\s*(-?\\d+),\\s*(-?\\d+)`, "m");
    const m = text.match(re);
    if (!m) {
      throw new RefResolveError("target_not_found", `Remembered place '${target}' not found in marks.`);
    }
    return { x: parseInt(m[1], 10), y: parseInt(m[2], 10), z: parseInt(m[3], 10) };
  }

  throw new RefResolveError("bad_target_type", `Unknown target_type: '${target_type}'`);
}

/**
 * Resolve a "from" ref for move_away — accepts the same shapes as
 * resolveTarget but is more permissive (also accepts EntityRef without
 * an explicit target_type).
 */
async function resolveFrom(from) {
  if (from == null) {
    throw new RefResolveError("missing_target", "from is required");
  }
  // Object → coords
  if (typeof from === "object") {
    const pos = asPosition(from);
    if (pos) return pos;
    throw new RefResolveError("bad_target", `from object shape unrecognized: ${JSON.stringify(from)}`);
  }
  // String → try entity first (move_away typical use case), then block
  const entR = await botPost(`/action/find_entities`, { type: from, radius: 32 });
  if (entR.ok) {
    const arr = entR.body?.entities ?? [];
    if (Array.isArray(arr) && arr.length) {
      const p = arr[0].position ?? arr[0];
      return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    }
  }
  // Fallback: block
  const blkR = await botPost(`/action/find_blocks`, { block: from, radius: 32, count: 1 });
  if (blkR.ok && blkR.body?.locations?.length) {
    const n = blkR.body.locations[0];
    return { x: Math.floor(n.x), y: Math.floor(n.y), z: Math.floor(n.z) };
  }
  throw new RefResolveError("target_not_found", `Couldn't resolve 'from' = '${from}' to entity or block.`);
}

export {
  resolveTarget,
  resolveFrom,
  asPosition,
  botPost,
  botGet,
  RefResolveError,
  BOT_API_URL,
};
