#!/usr/bin/env node
/**
 * HermesCraft — Embodied Hermes agents for Minecraft
 *
 * Copyright (c) 2026 bigph00t
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * HermesCraft Bot Server
 * 
 * A standalone HTTP server that controls a Mineflayer Minecraft bot.
 * Start this, then use the `mc` CLI or any HTTP client to control the bot.
 *
 * Usage:
 *   node server.js                              # defaults
 *   MC_HOST=localhost MC_PORT=25565 node server.js
 *   node server.js --port 3001 --mc-host localhost --mc-port 35901
 *
 * Environment:
 *   MC_HOST       Minecraft server host (default: localhost)
 *   MC_PORT       Minecraft server port (default: 25565)
 *   MC_USERNAME   Bot username (default: HermesBot)
 *   MC_AUTH       Auth type: offline|microsoft (default: offline)
 *   API_PORT      HTTP API port (default: 3001)
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
// pvp plugin disabled — its deprecated physicTick event breaks pathfinder
// import pvpPkg from 'mineflayer-pvp';
// const pvpPlugin = pvpPkg.plugin;
import armorManager from 'mineflayer-armor-manager';
import { loader as autoEatLoader } from 'mineflayer-auto-eat';
import collectBlockPkg from 'mineflayer-collectblock';
const collectBlock = collectBlockPkg.plugin;
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { encode as encodeMbit, isWalkable } from './lib/mbit.js';
import {
  CURRENT_CAST,
  buildKnownNames,
  parseMessageRouting,
  isMessageForMe,
  broadcastMentionsMe,
  stripMentionPrefix,
  applySocialEvent,
  summarizeSocialGraph,
} from './lib/chat.js';
import { WebSocketServer } from 'ws';
import {
  yawPitchToDir,
  bearingFromDelta,
  classifySector,
  angleDiffDegrees,
  makeBlockMemoryKey,
  summarizeVisibleBlocks,
  summarizeSceneText,
} from './lib/perception.js';
import {
  inventoryHint,
  itemCounts,
  recipeDiagnostics,
  recipeIngredientCounts,
} from './lib/action_feedback.js';
import { MotionController } from './lib/motion-controller.js';
import { BodyMutex } from './lib/mutex.js';
import { ACTION_REGISTRY, ON_ABORT } from './lib/action-registry.js';
import { HOSTILE_NAMES, WEAPONS, BANNED_FOOD, isHostileName, equipBestWeapon } from './lib/combat-data.js';
// mine-photo removed — prismarine-viewer + puppeteer replaced it (see line 253).
// The package was broken on Node 22 (fs.globSync at module load) and the
// only call site (Camera ray-tracing init) was removed below.
import { mineflayer as mineflayerViewer } from 'prismarine-viewer';
import puppeteer from 'puppeteer';

// Screenshot directory
const SCREENSHOT_DIR = path.join('/tmp', 'daemoncraft-screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Per-bot locations file to prevent race conditions in multi-agent mode
const DATA_DIR = process.env.WORKSPACE_DIR
  ? path.join(process.env.WORKSPACE_DIR)
  : path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const LOCATIONS_FILE = path.join(DATA_DIR, `locations-${(process.env.MC_USERNAME || 'HermesBot').toLowerCase()}.json`);
const BLUEPRINTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'blueprints');
// Phase 1 Cross-Layer Visibility: shared state file written by Python RunnerThread
const RUNNER_STATE_DIR = process.env.MC_RUNNER_STATE_DIR
  ? process.env.MC_RUNNER_STATE_DIR
  : path.join(process.env.HOME || '/home/nicolas', '.local', 'share', 'daemoncraft', 'lab');
const RUNNER_STATE_PATH = path.join(RUNNER_STATE_DIR, 'runner_state.json');
// Fase 2+3 Cross-Layer: shared state files for executor/orchestrator control
const EXECUTOR_INTENT_PATH = path.join(RUNNER_STATE_DIR, 'executor_intent.json');
const PLAN_MANIFEST_PATH = path.join(RUNNER_STATE_DIR, 'plan_manifest.json');
// MC_VERSION_SENSITIVE: 1.21.11
// Load the shared validation registry generated by scripts/generate-minecraft-registry.js
// When bumping Minecraft version, regenerate the registry and restart the server.
const REGISTRY_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'minecraft-registry.json');
let MC_REGISTRY = null;
function loadRegistry() {
  try {
    MC_REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    console.log('[registry] Loaded minecraft-registry.json for', MC_REGISTRY._meta?.version);
  } catch (err) {
    console.warn('[registry] Failed to load minecraft-registry.json:', err.message);
    MC_REGISTRY = null;
  }
}
loadRegistry();

function loadLocations() {
  try { return JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveLocations(locs) {
  const dir = path.dirname(LOCATIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOCATIONS_FILE, JSON.stringify(locs, null, 2));
}

// Per-bot persistent plan file (tactical goal layer)
const PLAN_FILE = path.join(DATA_DIR, `plan-${(process.env.MC_USERNAME || 'HermesBot').toLowerCase()}.json`);

function loadPlan() {
  // Try agent_loop.py's workspace/plan.json first (Autonomía Corporal format)
  const username = (config.mc && config.mc.username || process.env.MC_USERNAME || 'HermesBot').toLowerCase();
  const home = process.env.HOME || '/home/nicolas';
  try {
    const agentPlanPath = path.join(home, 'agents', username, 'workspace', 'plan.json');
    if (fs.existsSync(agentPlanPath)) {
      const raw = JSON.parse(fs.readFileSync(agentPlanPath, 'utf8'));
      // Convert plan_schema format → dashboard format
      return {
        goal: raw.goal || '',
        tasks: (raw.steps || []).map((s, i) => ({
          id: s.id || i + 1,
          description: s.intent || '',
          status: i < (raw.current_step || 0) ? 'done'
                : i === (raw.current_step || 0) && raw.state === 'executing' ? 'in_progress'
                : raw.state === 'blocked' && i === (raw.current_step || 0) ? 'blocked'
                : 'pending',
          attempts: s.retries || 0,
          verify: s.verify || null,
        })),
        state: raw.state || 'idle',
        current_step: raw.current_step || 0,
        started_at: raw.started_at_ts ? new Date(raw.started_at_ts * 1000).toISOString() : null,
      };
    }
  } catch {}

  // Fallback: legacy plan-<name>.json
  try {
    const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
    if (typeof plan.epoch !== 'number') plan.epoch = 0;
    return plan;
  }
  catch { return null; }
}
function savePlan(plan) {
  const dir = path.dirname(PLAN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  plan.epoch = (plan.epoch || 0) + 1;
  plan.updated_at = new Date().toISOString();
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
}

// ═══════════════════════════════════════════════════════════════════
// Configuration — single source of truth via JSON file
// ═══════════════════════════════════════════════════════════════════

// Parse CLI args first to find --config
let configPath = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--config' && process.argv[i + 1]) {
    configPath = process.argv[i + 1];
    i++;
  }
}

// Load unified config (JSON) or fall back to env vars for backward compat
let unifiedConfig = {};
if (configPath && fs.existsSync(configPath)) {
  try {
    unifiedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`[config] Loaded unified config from ${configPath}`);
  } catch (err) {
    console.warn(`[config] Failed to load ${configPath}:`, err.message);
  }
}

const _cfg = (section, key, fallback) => {
  return unifiedConfig[section]?.[key] ?? fallback;
};

const config = {
  mc: {
    host: _cfg('minecraft', 'host', process.env.MC_HOST || 'localhost'),
    port: _cfg('minecraft', 'port', parseInt(process.env.MC_PORT || '25565')),
    username: _cfg('minecraft', 'username', process.env.MC_USERNAME || 'HermesBot'),
    auth: _cfg('minecraft', 'auth', process.env.MC_AUTH || 'offline'),
  },
  api: {
    port: _cfg('server', 'api_port', parseInt(process.env.API_PORT || '3001')),
  },
};

// Override CLI flags (highest priority)
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  const next = process.argv[i + 1];
  if (arg === '--port' && next) { config.api.port = parseInt(next); i++; }
  if (arg === '--mc-host' && next) { config.mc.host = next; i++; }
  if (arg === '--mc-port' && next) { config.mc.port = parseInt(next); i++; }
  if (arg === '--username' && next) { config.mc.username = next; i++; }
  if (arg === '--auth' && next) { config.mc.auth = next; i++; }
}

// Pathfinder settings from unified config
const PATHFINDER_CFG = unifiedConfig.pathfinder || {};
if (PATHFINDER_CFG.max_stuck_attempts != null) {
  process.env.MC_MAX_STUCK_ATTEMPTS = String(PATHFINDER_CFG.max_stuck_attempts);
}

// Chat settings from unified config
const CHAT_CFG = unifiedConfig.chat || {};
const MC_FRAGMENT_MAX_CHARS = CHAT_CFG.fragment_max_chars ?? parseInt(process.env.MC_FRAGMENT_MAX_CHARS || "240", 10);
const MC_MAX_FRAGMENTS = CHAT_CFG.max_fragments ?? parseInt(process.env.MC_MAX_FRAGMENTS || "3", 10);
const MC_FRAGMENT_DELAY_MS = CHAT_CFG.fragment_delay_ms ?? parseInt(process.env.MC_FRAGMENT_DELAY_MS || "300", 10);

// Workspace dir from unified config
const WORKSPACE_DIR = unifiedConfig.workspace_dir || process.env.WORKSPACE_DIR || null;

// ═══════════════════════════════════════════════════════════════════
// Bot Manager
// ═══════════════════════════════════════════════════════════════════

let bot = null;
let motion = null;
let bodyMutex = null;
let mcData = null;
let botReady = false;
let chatLog = [];
let deathLog = [];
let commandQueue = []; // complex commands for Hermes to process
let currentTask = null; // background task state
let actionInProgress = false; // guard: synchronous action running (watchdog must not interfere)
let lastDeath = null;
let hardcoreDead = false; // Once true, no reconnect — permanent death
let lastHealth = 20;
let reconnectAttempts = 0;
let reconnectTimeout = null; // Track active reconnect timer to cancel stale ones
let isConnecting = false; // Guard against concurrent createBot() calls
const MAX_LOG = 100;
const MAX_QUEUE = 20;
const MC_PROTOCOL_BYTE_LIMIT = 256;        // Minecraft hard limit
const MC_THROTTLE_WINDOW_MS = 10_000;
const MC_THROTTLE_WINDOW_MAX = 5;

// Per-bot sliding-window state (anti-spam). One server.js = one bot.
let recentFragments = [];

// Rolling buffer of recent action outcomes for loop detection
let actionHistory = []; // { action, status, time }
const MAX_ACTION_HISTORY = 200;
let lastAttackTargetId = null;
let lastAttackAt = 0;
const STICKY_TARGET_MS = 3000;
const STICKY_TARGET_MAX_DIST = 4;
let lastJudge = null; // backward compat — most recent judge entry
let judgeRing = []; // ring buffer of last N judge entries (max 10)
const MAX_JUDGE_RING = 10;
let agentLog = []; // { turn, time, prompt, response, tool_calls, error }
const MAX_AGENT_LOG = 50;
let agentHeartbeat = { nextTurnIn: null, turnInProgress: false }; // countdown for dashboard

// Controller Mode — explicit, not automagic. "lab" = no autonomous turns.
let controllerMode = "autonomous"; // default autonomous for 24/7 operation; overridable via POST /controller/mode

// ═══════════════════════════════════════════════════════════════════
// Phase 1 Reactive Runner — event producers (debounced edge detectors)
// Emits 'runner_event' on bot; accumulated into runnerEventBuffer for /events
// Consumed by EventPoller → RunnerThread → /mutex/claim for preemption
// ═══════════════════════════════════════════════════════════════════
let runnerEventBuffer = []; // drained by GET /events, bounded to EVENT_BUFFER_MAX
const EVENT_BUFFER_MAX = 50;

const eventDebounce = {
  entity_near: {},
  health_edge: 0,
  hazard_edge: 0,
};

function checkEntityProximity() {
  if (!bot || !bot.entity || !botReady) return;
  const entities = bot.entities || {};
  const now = Date.now();
  // Hostile list from combat-data.js — single source of truth
  for (const [id, entity] of Object.entries(entities)) {
    if (entity === bot.entity) continue;
    const name = (entity.name || entity.mobType || entity.displayName || '').toLowerCase();
    if (!name) continue;
    const isHostile = HOSTILE_NAMES.some(h => name.includes(h));
    if (!isHostile) continue;
    if (!entity.position) continue;
    const dist = bot.entity.position.distanceTo(entity.position);
    // Only react to hostiles within 3m AND with line of sight (no walls between)
    if (dist > 3) continue;
    // Quick line-of-sight: check if mid-point block is air
    const midX = (bot.entity.position.x + entity.position.x) / 2;
    const midY = (bot.entity.position.y + entity.position.y) / 2;
    const midZ = (bot.entity.position.z + entity.position.z) / 2;
    const midBlock = bot.blockAt(new Vec3(midX, midY, midZ));
    if (midBlock && midBlock.name !== 'air' && midBlock.name !== 'cave_air' && midBlock.boundingBox === 'block') continue;

    const key = entity.name || entity.mobType || entity.displayName || name;
    const last = eventDebounce.entity_near[key] || 0;
    if (now - last > 1000) {
      eventDebounce.entity_near[key] = now;
      console.error(`[runner-events] entity_near ${key} ${dist.toFixed(1)}m`);
      bot.emit('runner_event', {
        type: 'entity_near',
        entityType: key,
        distance: Math.round(dist * 10) / 10,
        priority: 'critical',
        timestamp: now,
      });
    }
  }
}

function checkHealthEdges() {
  if (!bot || !botReady) return;
  const now = Date.now();
  const health = bot.health || 20;
  const lastHealth = eventDebounce._lastHealth ?? health;

  // Damage detection: any health decrease (debounced 500ms)
  if (health < lastHealth && now - eventDebounce.health_edge > 500) {
    eventDebounce.health_edge = now;
    eventDebounce._lastHealth = health;
    console.error(`[runner-events] taking_damage health=${health}`);
    bot.emit('runner_event', {
      type: 'taking_damage',
      health,
      maxHealth: 20,
      priority: 'critical',
      timestamp: now,
    });
  }

  // Critical health alert
  if (health <= 6 && now - eventDebounce.health_edge > 500) {
    eventDebounce.health_edge = now;
    eventDebounce._lastHealth = health;
    bot.emit('runner_event', {
      type: 'health_low',
      health,
      maxHealth: 20,
      priority: 'critical',
      timestamp: now,
    });
  }

  eventDebounce._lastHealth = health;
}

// (Future) checkHazardEdges() can use hazard_edge debounce for lava/fire etc.

// ════════════════════════════════════════════════════════════════════════════════════════════
// Fair Play Mode — perception constraints for realistic gameplay
// ════════════════════════════════════════════════════════════════════════════════════════════

let fairPlayMode = false; // off by default for DaemonCraft profiles
const FAIR_PLAY = {
  LOS_ENTITY_RANGE: 48,       // max entity detection range with LOS
  SNEAK_DETECT_RANGE: 8,      // sneaking players only detected this close
  SOUND_MINE_RADIUS: 16,      // mining sound radius
  SOUND_SPRINT_RADIUS: 8,     // sprinting sound radius
  SOUND_WALK_RADIUS: 4,       // walking sound radius
  SOUND_SNEAK_RADIUS: 1,      // sneaking sound radius
  REACTION_MIN_MS: 100,       // min reaction delay
  REACTION_MAX_MS: 300,       // max reaction delay
  BLOCK_SCAN_RANGE: 16,       // limited block scan (was 64 in find_blocks)
};

// Sound events detected by this bot (populated by nearby activity)
let soundEvents = [];

// Team system
let teamConfig = {
  team: null,        // 'red' or 'blue' or null
  role: null,        // 'commander', 'warrior', 'ranger', 'support'
  teammates: [],     // usernames of teammates
  rallyPoint: null,  // { x, y, z } set by commander
  teamChat: [],      // team-only messages
};

// Kill/death tracking
let combatStats = { kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0 };
let recentDamagers = {}; // { username: lastDamageTime } for assist tracking

// Active furnaces (fire-and-forget tracking)
let activeFurnaces = [];

// Screenshot / ray-tracing camera
let photoCamera = null;
let photoScanReady = false;
let photoScanPromise = null;

// Prismarine-viewer + Puppeteer screenshot pipeline (replaces mine-photo)
let viewerServer = null;
let viewerBrowser = null;
let viewerPage = null;

// Local sneak state tracking (Mineflayer controlState is write-only)
let isSneaking = false; // [{ x, y, z, input, count, startTime, estimatedDone }]

// ═══════════════════════════════════════════════════════════════════
// Chat Handling — Name-Routed Message System
//
// Messages are routed by prefix:
//   "Name1,Name2: message"  → only Name1 and Name2 receive it
//   "all: message"          → broadcast to everyone
//   "message" (no prefix)   → broadcast to everyone (human player style)
//
// Received messages go to chatLog (visible via mc read_chat / mc status)
// Other agents' private conversations go to overheardLog (mc overhear)
// Direct mentions also go to commandQueue (mc commands)
// ═══════════════════════════════════════════════════════════════════

let overheardLog = []; // messages between other agents we can "overhear"
let socialGraph = {};
let socialEvents = [];
let observedBlocks = new Map();

function getMyName() {
  return config.mc.username.toLowerCase();
}

function getNearbyPlayerNames() {
  if (!bot) return [];
  return Object.values(bot.entities || {})
    .map((entity) => entity.username)
    .filter(Boolean);
}

function rememberSocialEvent(event) {
  const withTime = { time: Date.now(), ...event };
  socialEvents.push(withTime);
  socialEvents = socialEvents.filter((entry) => Date.now() - entry.time < 30 * 60 * 1000).slice(-200);
  if (withTime.actor) applySocialEvent(socialGraph, withTime);
}

function getMemoryHints(limit = 4) {
  const hints = [...observedBlocks.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map((entry) => `${entry.name} ${entry.bearing} ${entry.distance}m (${Math.round((Date.now() - entry.lastSeen) / 1000)}s ago)`);
  return hints;
}

// Handle incoming chat message with routing
async function handleChat(username, message) {
  const knownNames = buildKnownNames(getMyName(), getNearbyPlayerNames());
  const routing = parseMessageRouting(message, { knownNames });
  let forMe = isMessageForMe(routing, getMyName());

  // Proximity filter: broadcasts from other known agents only heard when nearby.
  // Human players are not in CURRENT_CAST so they always pass through.
  if (forMe && routing.isBroadcast && bot && botReady) {
    const senderLower = username.toLowerCase();
    const isOtherAgent = CURRENT_CAST.includes(senderLower) && senderLower !== getMyName().toLowerCase();
    if (isOtherAgent) {
      const senderEntity = Object.values(bot.entities || {}).find(
        e => e.username && e.username.toLowerCase() === senderLower
      );
      const dist = senderEntity ? bot.entity.position.distanceTo(senderEntity.position) : Infinity;
      if (dist > FAIR_PLAY.LOS_ENTITY_RANGE) {
        overheardLog.push({ time: Date.now(), from: username, message: routing.body, channel: 'distant_broadcast', to: [] });
        if (overheardLog.length > MAX_LOG) overheardLog.shift();
        rememberSocialEvent({ actor: username, kind: 'heard', channel: 'overheard_distant', message: routing.body });
        return;
      }
    }
  }

  if (forMe) {
    // Message is for us — add to chatLog (visible in mc read_chat / mc status)
    const playerEntry = bot?.players?.[username];
    chatLog.push({
      time: Date.now(),
      from: username,
      message: routing.body,
      private: !routing.isBroadcast,
      channel: routing.channel,
      targets: routing.targets.length > 0 ? routing.targets : undefined,
      world: bot?.game?.dimension || 'unknown',
      uuid: playerEntry?.uuid || null,
    });
    if (chatLog.length > MAX_LOG) chatLog.shift();
    broadcastDashboard('chat', chatLog.slice(-30));
    log(`[Chat${routing.isBroadcast ? '' : ' @me'}] <${username}> ${routing.body}`);
    
    // If directly addressed (Name: msg format), queue as command
    if (!routing.isBroadcast) {
      commandQueue.push({
        time: Date.now(),
        from: username,
        command: routing.body,
        channel: routing.channel,
        originalMessage: message,
        status: 'pending',
      });
      rememberSocialEvent({ actor: username, kind: 'heard', channel: routing.channel, command: true, message: routing.body });
      if (commandQueue.length > MAX_QUEUE) commandQueue.shift();
      log(`[Queued] ${username}: ${routing.body}`);
    } else {
      // Broadcast but mentions our name at start? Also queue as command.
      const mention = broadcastMentionsMe(routing.body, getMyName());
      if (mention) {
        const command = stripMentionPrefix(routing.body, mention);
        if (command) {
          commandQueue.push({
            time: Date.now(),
            from: username,
            command,
            channel: 'public_mention',
            originalMessage: message,
            status: 'pending',
          });
          rememberSocialEvent({ actor: username, kind: 'heard', channel: 'public_mention', command: true, message: command });
          if (commandQueue.length > MAX_QUEUE) commandQueue.shift();
          log(`[Queued via mention] ${username}: ${command}`);
        }
      } else {
        rememberSocialEvent({ actor: username, kind: 'heard', channel: routing.channel, message: routing.body });
      }
    }
  } else {
    // Message is NOT for us — overheard only
    overheardLog.push({ time: Date.now(), from: username, message: routing.body,
                        channel: routing.channel, to: routing.targets });
    if (overheardLog.length > MAX_LOG) overheardLog.shift();
    rememberSocialEvent({ actor: username, kind: 'heard', channel: `overheard_${routing.channel}`, message: routing.body });
    log(`[Overheard] <${username}> → [${routing.targets.join(',')}] ${routing.body}`);
  }
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

async function createBot() {
  // Guard against concurrent reconnect attempts from stale timers
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (isConnecting) {
    log('createBot() called while already connecting — skipping duplicate');
    return;
  }
  isConnecting = true;
  try {
    return await createBotImpl();
  } finally {
    isConnecting = false;
  }
}

async function createBotImpl() {
  // Guard against concurrent reconnect attempts from stale timers
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (bot) {
    // Remove listeners before quit() so the old bot's 'end' handler
    // doesn't schedule a competing reconnect timeout
    bot.removeAllListeners('end');
    bot.removeAllListeners('error');
    try { bot.quit(); } catch {}
    if (motion) {
      motion.dispose();
      motion = null;
    }
    bot = null;
    botReady = false;
    await sleep(2000); // longer delay for server to clean up session
  }

  return new Promise((resolve, reject) => {
    log(`Connecting to ${config.mc.host}:${config.mc.port} as ${config.mc.username}...`);
    
    bot = mineflayer.createBot({
      host: config.mc.host,
      port: config.mc.port,
      username: config.mc.username,
      auth: config.mc.auth,
    });

    const timeout = setTimeout(() => {
      reject(new Error(`Connection timeout — couldn't reach ${config.mc.host}:${config.mc.port}`));
    }, 30000);

    bot.once('spawn', () => {
      clearTimeout(timeout);
      mcData = minecraftData(bot.version);

      // Load plugins
      bot.loadPlugin(pathfinder);
      // bot.loadPlugin(pvpPlugin); // disabled — breaks pathfinder
      bot.loadPlugin(armorManager);
      bot.loadPlugin(autoEatLoader);
      bot.loadPlugin(collectBlock);

      // Configure pathfinder
      const moves = new Movements(bot);
      moves.allowSprinting = PATHFINDER_CFG.allow_sprinting ?? false;
      moves.canDig = PATHFINDER_CFG.can_dig ?? true;
      moves.allowParkour = PATHFINDER_CFG.allow_parkour ?? true;
      moves.allow1by1towers = PATHFINDER_CFG.allow_1by1_towers ?? false;
      moves.scaffoldingBlocks = PATHFINDER_CFG.scaffolding_blocks ?? [];
      bot.pathfinder.setMovements(moves);

      // MotionController owns all pathfinding state
      motion = new MotionController(bot);
      bot.motion = motion;

      // BodyMutex for Phase 1 reactive runner preemption (IDLE/GOAL/REFLEX/REFLEX_YIELD)
      bodyMutex = new BodyMutex(bot);
      bot.bodyMutex = bodyMutex;

      // DEBUG: log pathfinder state every 5 seconds
      setInterval(() => {
        if (!bot || !bot.pathfinder) return;
        const goal = bot.pathfinder.goal;
        const isMoving = bot.pathfinder.isMoving ? bot.pathfinder.isMoving() : false;
        const pos = bot.entity ? bot.entity.position : null;
        const posStr = pos ? `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}` : 'unknown';
        if (goal) {
          log(`[PATHFINDER] moving=${isMoving} pos=${posStr} goal=${goal.constructor.name}`);
        } else if (isMoving) {
          log(`[PATHFINDER] moving=${isMoving} pos=${posStr} goal=null`);
        }
      }, 5000);

      // Auto-disguise disabled — being a mob breaks PvP=false protection.
      // To re-enable, set BOT_DISGUISE=allay in env.
      if (process.env.BOT_DISGUISE) {
        setTimeout(() => {
          bot.chat(`/disguise ${process.env.BOT_DISGUISE}`);
          log(`Auto-disguised as ${process.env.BOT_DISGUISE}`);
        }, 3000);
      }

      // Configure auto-eat: eat to recover health. Minecraft regen needs hunger>=18 + saturation>0.
      // Eat when hunger drops below 18 to keep saturation high and health regenerating.
      // If health is below 19, prioritize high-saturation food for faster healing.
      bot.autoEat.options = {
        priority: 'foodPoints',
        minHunger: 18,
        minHealth: 19,
        bannedFood: BANNED_FOOD,
        returnToLastItem: true,
      };

      // ── Reactive Events ──────────────────────────────

      // Chat listener — name-routed message system
      bot.on('chat', (username, message) => {
        if (username === bot.username) return;
        // All routing (chatLog vs overheardLog, commandQueue) handled by handleChat
        handleChat(username, message).catch(e => log(`Chat handler error: ${e.message}`));
      });

      bot.on('whisper', (username, message) => {
        if (username === bot.username) return;
        // Whispers are always for us — add directly to chatLog + commandQueue
        const playerEntry = bot?.players?.[username];
        chatLog.push({ time: Date.now(), from: username, message, whisper: true, world: bot?.game?.dimension || 'unknown', uuid: playerEntry?.uuid || null });
        if (chatLog.length > MAX_LOG) chatLog.shift();
        broadcastDashboard('chat', chatLog.slice(-30));
        log(`[Whisper] <${username}> ${message}`);
        commandQueue.push({
          time: Date.now(), from: username, command: message,
          originalMessage: message, status: 'pending',
        });
        if (commandQueue.length > MAX_QUEUE) commandQueue.shift();
      });

      // Health tracking + combat stats
      bot.on('health', () => {
        if (bot.health < lastHealth) {
          const damage = lastHealth - bot.health;
          combatStats.damageTaken += damage;
          log(`Took ${damage.toFixed(1)} damage (HP: ${bot.health.toFixed(1)})`);
        }
        lastHealth = bot.health;
      });

      // ── Phase 1 Reactive Runner producers (physicsTick-driven) ──
      // These run on every physicsTick (~20Hz) but are internally debounced.
      // They emit 'runner_event' which is caught below and buffered for /events.
      bot.on('runner_event', (evt) => {
        runnerEventBuffer.push(evt);
        if (runnerEventBuffer.length > EVENT_BUFFER_MAX) {
          runnerEventBuffer.shift();
        }
      });

      // Wire mutex transitions into the runner event buffer
      // so EventPoller → RunnerThread and agent heartbeat can observe L2 state changes
      bot.on('mutex_released', (info) => {
        runnerEventBuffer.push({ type: 'mutex_released', ...info, timestamp: Date.now() });
        if (runnerEventBuffer.length > EVENT_BUFFER_MAX) runnerEventBuffer.shift();
      });

      bot.on('physicsTick', () => {
        try {
          checkEntityProximity();
          checkHealthEdges();
          // checkHazardEdges() can be added here (uses hazard_edge debounce)
        } catch (e) {
          // Never let a tick handler crash the bot's physics loop
          console.error('[runner-events] physicsTick handler error:', e.message || e, String(e));
        }
      });

      // Sound events: detect nearby entity digging
      bot.on('blockBreakProgressObserved', (block, destroyStage, entity) => {
        if (entity && entity !== bot.entity) {
          addSoundEvent('mining', block.position, FAIR_PLAY.SOUND_MINE_RADIUS);
        }
      });

      // Sound events: detect nearby entity sprinting/movement
      bot._soundCheckInterval = setInterval(() => {
        if (!bot || !botReady) return;
        Object.values(bot.entities).forEach(e => {
          if (e === bot.entity || !e.position) return;
          const vel = e.velocity;
          if (!vel) return;
          const speed = Math.sqrt(vel.x*vel.x + vel.z*vel.z);
          if (speed > 0.2) addSoundEvent('sprinting', e.position, FAIR_PLAY.SOUND_SPRINT_RADIUS);
          else if (speed > 0.05) addSoundEvent('walking', e.position, FAIR_PLAY.SOUND_WALK_RADIUS);
        });
      }, 2000);

      // Teleport detection — cancel navigation when forcibly moved by server
      let lastPos = null;
      const TP_DISTANCE_THRESHOLD = PATHFINDER_CFG.tp_distance_threshold ?? 3;
      bot.on('move', () => {
        if (!bot || !bot.entity || !bot.entity.position) return;
        const pos = bot.entity.position;
        if (!lastPos) { lastPos = pos.clone(); return; }
        const dist = pos.distanceTo(lastPos);
        if (dist > TP_DISTANCE_THRESHOLD) {
          // Teleported — nuclear stop: motion, pathfinder, control states, events, mutex
          try {
            if (bot && bot.motion) {
              bot.motion.markTeleported();
              bot.motion.stop().catch(() => {});
            }
            if (bot && bot.pathfinder) { bot.pathfinder.setGoal(null); }
            if (bot) { bot.clearControlStates(); }
          } catch (e) { log(`Teleport stop error: ${e.message || e}`); }
          runnerEventBuffer = [];
          if (bot && bot.bodyMutex) { bot.bodyMutex.emergencyStop('teleport').catch(() => {}); }
          if (currentTask && currentTask.status === 'running') {
            currentTask.status = 'cancelled';
            currentTask.error = `Teleported ${dist.toFixed(1)} blocks`;
            broadcastDashboard('task', currentTask);
          }
          log(`Teleport: moved ${dist.toFixed(1)} blocks — full stop (motion+events+mutex)`);
        }
        lastPos = pos.clone();
      });

      // Death tracking
      // Block changes → WebSocket real-time events for mBit visualizer
      bot.on('blockUpdate', (oldBlock, newBlock) => {
        if (!oldBlock || !newBlock) return;
        broadcastDashboard('block_update', {
          x: newBlock.position.x, y: newBlock.position.y, z: newBlock.position.z,
          old_name: oldBlock.name, new_name: newBlock.name,
          time: Date.now(),
        });
      });

      bot.on('death', () => {
        combatStats.deaths++;
        lastDeath = {
          time: Date.now(),
          position: posObj(),
          inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
          deathNumber: deathLog.length + 1
        };
        const entry = { time: Date.now(), position: posObj() };
        deathLog.push(entry);
        const locs = loadLocations(); locs['death_'+deathLog.length]={...posObj(),saved:new Date().toISOString()};saveLocations(locs);
        
        // Check if hardcore mode — if so, this is PERMANENT death
        if (bot.game?.hardcore || hardcoreDead) {
          hardcoreDead = true;
          log('☠ HARDCORE DEATH! This character is PERMANENTLY DEAD. No reconnect.');
          // Add a final chat message to the log so the agent knows
          chatLog.push({ 
            time: Date.now(), 
            from: 'SYSTEM', 
            message: 'YOU DIED IN HARDCORE MODE. You are permanently dead. Your story is over.',
            whisper: false 
          });
          return; // Don't respawn, don't reconnect
        }
        log('DIED! Respawning...');
      });

      // Kicked — log only, 'end' event fires after and handles reconnect
      bot.on('kicked', (reason) => {
        log(`Kicked: ${JSON.stringify(reason)}`);
        botReady = false;
      });

      // Disconnect — auto-reconnect with backoff (handles both kicks and drops)
      bot.once('end', async (reason) => {
        log(`Disconnected: ${reason}`);
        botReady = false;
        photoScanReady = false;
        photoScanPromise = null;
        photoCamera = null;
        positionHistory = []; // clear stuck detection history
        // Close viewer and puppeteer resources (fire-and-forget)
        try { viewerPage?.close().catch(() => {}); viewerPage = null; } catch {}
        try { viewerBrowser?.close().catch(() => {}); viewerBrowser = null; } catch {}
        try { viewerServer?.close(); viewerServer = null; } catch {}
        if (bot?._soundCheckInterval) { clearInterval(bot._soundCheckInterval); bot._soundCheckInterval = null; }
        
        // In hardcore mode, death = permanent. Don't reconnect.
        if (hardcoreDead) {
          log('☠ Hardcore death — staying disconnected. RIP.');
          return;
        }
        
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
        reconnectAttempts++;
        log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          log('Attempting reconnect...');
          createBot().catch(e => {
            log(`Reconnect failed: ${e.message}`);
            // If createBot() rejects (e.g. timeout), ensure we still retry
            if (!reconnectTimeout && !botReady) {
              const fallbackDelay = Math.min(10000 * Math.pow(2, reconnectAttempts), 60000);
              reconnectTimeout = setTimeout(() => {
                reconnectTimeout = null;
                createBot().catch(err => log(`Fallback reconnect failed: ${err.message}`));
              }, fallbackDelay);
            }
          });
        }, delay);
      });

      // Camera init removed with mine-photo — prismarine-viewer below
      // serves screenshots now. photoCamera/photoScanReady/photoScanPromise
      // remain declared at module scope as harmless null/false placeholders
      // so any older /photo/* request handler that reads them still works.

      botReady = true;
      reconnectAttempts = 0;
      const locs = loadLocations(); if(!locs.spawn){locs.spawn={...posObj(),saved:new Date().toISOString()};saveLocations(locs);}
      log(`Connected! Spawned at ${fmt(bot.entity.position.x)}, ${fmt(bot.entity.position.y)}, ${fmt(bot.entity.position.z)}`);

      // Start prismarine-viewer for screenshot capability
      // DISABLED: causes Chrome zombie processes that consume 900%+ CPU
      // when the bot disconnects/restarts. The viewer's WebSocket retry
      // loop in Chrome headless saturates cores. Re-enable only when
      // screenshot is actively needed, with proper cleanup.
      /*
      try {
        const viewerPort = config.api.port + 1000;
        viewerServer = mineflayerViewer(bot, { port: viewerPort, firstPerson: true });
        log(`[Viewer] Serving at http://localhost:${viewerPort}`);
      } catch (err) {
        log(`[Viewer] Failed to start: ${err.message}`);
      }
      */

      resolve(bot);
    });

    // ── Verbose pathfinder event logging (BOT_VERBOSE) ──
    if (process.env.BOT_VERBOSE) {
      bot.on('goal_updated', (goal, dynamic) => {
        const g = goal ? { x: goal.x?.toFixed(1), y: goal.y?.toFixed(1), z: goal.z?.toFixed(1) } : null;
        console.error(`[mineflayer] goal_updated dynamic=${dynamic} goal=${g ? JSON.stringify(g) : 'null'}`);
      });
      bot.on('goal_reached', (goal) => {
        const g = goal ? { x: goal.x?.toFixed(1), y: goal.y?.toFixed(1), z: goal.z?.toFixed(1) } : null;
        console.error(`[mineflayer] goal_reached at ${g ? JSON.stringify(g) : '?'}`);
      });
      bot.on('path_reset', (reason) => {
        console.error(`[mineflayer] path_reset reason="${reason}"`);
      });
      bot.on('path_stop', () => {
        console.error(`[mineflayer] path_stop`);
      });
      bot.on('path_update', (results) => {
        if (results.status === 'success') {
          const pathStr = results.path.map(n => `${n.x},${n.y},${n.z}`).join(' -> ');
          console.error(`[mineflayer] path_update path_len=${results.path.length} cycles=${results.cycles} path=${pathStr}`);
        } else {
          console.error(`[mineflayer] path_update FAILED status=${results.status}`);
        }
      });
    }

    bot.on('error', (err) => {
      log(`Bot error: ${err.message}`);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(v) { return typeof v === 'number' ? Math.round(v * 10) / 10 : v; }

/** Cardinal direction → unit vector. West = -X, East = +X, North = -Z, South = +Z. */
const CARDINAL_DIRS = {
  west:  { dx: -1, dz:  0 },
  east:  { dx:  1, dz:  0 },
  north: { dx:  0, dz: -1 },
  south: { dx:  0, dz:  1 },
};

/**
 * Mine a 1-wide diagonal staircase upward through solid terrain.
 *
 * Pattern (3 blocks per step, heading in `direction`):
 *   1. Block in front of eyes:   (x + dx, y+1, z + dz)
 *   2. Block above that:         (x + dx, y+2, z + dz)
 *   3. Block directly above head:(x,      y+2, z)
 *
 * Movement: set a pathfinder goal one block forward+up. The pathfinder's
 * allowParkour handles the 1-block step-up. Fast-stuck may cancel the goto
 * but the body often already moved — verify position, not the response.
 *
 * @param {string} direction  - 'west'|'east'|'north'|'south'
 * @param {number} targetY    - stop when bot reaches this Y (floor)
 * @returns {{ steps: number, finalY: number, message: string }}
 */
async function climbStaircase(bot, direction, targetY) {
  const dir = CARDINAL_DIRS[direction];
  if (!dir) throw new Error(`Invalid direction '${direction}'. Use west/east/north/south.`);

  const startY = Math.floor(bot.entity.position.y);
  if (startY >= targetY) return { steps: 0, finalY: startY, message: `Already at or above Y=${targetY}.` };

  let steps = 0;
  const maxSteps = (targetY - startY) * 2; // safety cap

  for (let i = 0; i < maxSteps; i++) {
    const curX = Math.floor(bot.entity.position.x);
    const curY = Math.floor(bot.entity.position.y);
    const curZ = Math.floor(bot.entity.position.z);

    // ── Check for open sky / surface ─────────────────────────
    // Same criteria as /scene: 96-block air column + 2 open cardinals
    let skyHeadroom = 0;
    for (let i = 1; i <= 96; i++) {
      const cb = bot.blockAt(new Vec3(curX, curY + i, curZ));
      if (!cb || cb.name === 'air' || cb.name === 'cave_air' || cb.name === 'void_air') skyHeadroom++;
      else break;
    }
    // Check cardinals around current position
    const skyCardinals = ['north','south','east','west'];
    let openDirs = 0;
    for (const d of skyCardinals) {
      const dd = CARDINAL_DIRS[d];
      const b2 = bot.blockAt(new Vec3(curX + dd.dx, curY + 1, curZ + dd.dz));
      if (!b2 || b2.name === 'air' || b2.name === 'cave_air' || b2.name === 'void_air') openDirs++;
    }
    if (skyHeadroom >= 96 && openDirs >= 2) {
      log(`[staircase] Reached surface at Y=${curY} (headroom=${skyHeadroom}, openCardinals=${openDirs})`);
      break;
    }

    // ── Mine 3 blocks ──────────────────────────────────────
    const targets = [
      { x: curX + dir.dx, y: curY + 1, z: curZ + dir.dz, label: 'eyes' },
      { x: curX + dir.dx, y: curY + 2, z: curZ + dir.dz, label: 'above-eyes' },
      { x: curX,          y: curY + 2, z: curZ,           label: 'above-head' },
    ];

    for (const t of targets) {
      const block = bot.blockAt(new Vec3(t.x, t.y, t.z));
      if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
        try {
          await bot.tool.equipForBlock(block);
          await bot.dig(block, true);
        } catch (e) {
          log(`[staircase] dig failed at ${t.x},${t.y},${t.z} (${t.label}): ${e.message}`);
        }
        await sleep(100);
      }
    }

    // ── Step up ────────────────────────────────────────────
    const beforeY = bot.entity.position.y;
    const targetX = curX + dir.dx + 0.5;
    const targetYstep = curY + 1;
    const targetZ = curZ + dir.dz + 0.5;

    try {
      // Use motion.goto — allowParkour handles 1-block step-up.
      // Fast-stuck may cancel the goto, but the body often already moved.
      // Ignore the response; verify with position after a short delay.
      bot.motion.goto(targetX, targetYstep, targetZ);
      await sleep(600);
    } catch (e) {
      // goto may reject on cancellation — that's fine
    }

    // Verify: did we actually step up?
    const afterY = bot.entity.position.y;
    if (Math.floor(afterY) > curY) {
      steps++;
    } else {
      // Retry once with a nudge (walk forward into the step)
      bot.setControlState('forward', true);
      await sleep(400);
      bot.setControlState('forward', false);
      await sleep(100);
      if (Math.floor(bot.entity.position.y) > curY) {
        steps++;
      }
      // If still no progress, continue loop — next mine cycle will re-clear
    }

    if (Math.floor(bot.entity.position.y) >= targetY) break;
  }

  if (bot.motion) bot.motion.stop().catch(() => {});
  const finalY = Math.floor(bot.entity.position.y);
  const stoppedEarly = finalY < targetY;
  return {
    steps,
    finalY,
    stoppedEarly,
    message: stoppedEarly
      ? `Staircase stopped at Y=${finalY} (open sky detected) after ${steps} steps heading ${direction}. Target was ${targetY}.`
      : `Reached Y=${finalY} (target ${targetY}) in ${steps} steps heading ${direction}.`,
  };
}

/** Rotation order for spiral staircase. */
const SPIRAL_ORDER = ['west', 'north', 'east', 'south'];

/**
 * Mine a 1-wide spiral (caracol) staircase upward.
 *
 * Same 3-block pattern as climbStaircase, but rotates direction 90°
 * every `stepsPerSide` steps. This creates a helical staircase that
 * stays within a compact footprint.
 *
 * @param {number} targetY      - stop when bot reaches this Y (floor)
 * @param {number} stepsPerSide - steps before rotating direction (default 3)
 * @returns {{ steps: number, finalY: number, message: string }}
 */
async function climbSpiral(bot, targetY, stepsPerSide = 3) {
  const startY = Math.floor(bot.entity.position.y);
  if (startY >= targetY) return { steps: 0, finalY: startY, message: `Already at or above Y=${targetY}.` };

  let dirIdx = 0;          // index into SPIRAL_ORDER
  let stepsOnSide = 0;     // steps taken on current side
  let totalSteps = 0;
  const maxSteps = (targetY - startY) * 3; // spiral wastes some movement, allow more

  for (let i = 0; i < maxSteps; i++) {
    const direction = SPIRAL_ORDER[dirIdx];
    const dir = CARDINAL_DIRS[direction];

    const curX = Math.floor(bot.entity.position.x);
    const curY = Math.floor(bot.entity.position.y);
    const curZ = Math.floor(bot.entity.position.z);

    // ── Check for open sky / surface ─────────────────────────
    // Same criteria as /scene: 96-block air column + 2 open cardinals
    let skyHeadroom = 0;
    for (let i = 1; i <= 96; i++) {
      const cb = bot.blockAt(new Vec3(curX, curY + i, curZ));
      if (!cb || cb.name === 'air' || cb.name === 'cave_air' || cb.name === 'void_air') skyHeadroom++;
      else break;
    }
    const skyCardinals = ['north','south','east','west'];
    let openDirs = 0;
    for (const d of skyCardinals) {
      const dd = CARDINAL_DIRS[d];
      const b2 = bot.blockAt(new Vec3(curX + dd.dx, curY + 1, curZ + dd.dz));
      if (!b2 || b2.name === 'air' || b2.name === 'cave_air' || b2.name === 'void_air') openDirs++;
    }
    if (skyHeadroom >= 96 && openDirs >= 2) {
      log(`[spiral] Reached surface at Y=${curY} (headroom=${skyHeadroom}, openCardinals=${openDirs})`);
      break;
    }

    // ── Mine 3 blocks ──────────────────────────────────────
    const targets = [
      { x: curX + dir.dx, y: curY + 1, z: curZ + dir.dz, label: 'eyes' },
      { x: curX + dir.dx, y: curY + 2, z: curZ + dir.dz, label: 'above-eyes' },
      { x: curX,          y: curY + 2, z: curZ,           label: 'above-head' },
    ];

    for (const t of targets) {
      const block = bot.blockAt(new Vec3(t.x, t.y, t.z));
      if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
        try {
          await bot.tool.equipForBlock(block);
          await bot.dig(block, true);
        } catch (e) {
          log(`[spiral] dig failed at ${t.x},${t.y},${t.z} (${t.label}): ${e.message}`);
        }
        await sleep(100);
      }
    }

    // ── Step up ────────────────────────────────────────────
    // Face the cardinal direction so the step-up goes the right way
    const yawByDir = { west: Math.PI, east: 0, north: -Math.PI/2, south: Math.PI/2 };
    const targetYaw = yawByDir[direction];
    await bot.look(targetYaw, 0, true);
    await sleep(100);

    const targetX = curX + dir.dx + 0.5;
    const targetYstep = curY + 1;
    const targetZ = curZ + dir.dz + 0.5;

    try {
      bot.motion.goto(targetX, targetYstep, targetZ);
      await sleep(600);
    } catch (e) {
      // goto may reject on cancellation — that's fine
    }

    const afterY = bot.entity.position.y;
    if (Math.floor(afterY) > curY) {
      totalSteps++;
      stepsOnSide++;

      // Rotate direction after stepsPerSide successful steps
      if (stepsOnSide >= stepsPerSide) {
        stepsOnSide = 0;
        dirIdx = (dirIdx + 1) % SPIRAL_ORDER.length;
      }
    } else {
      // Retry nudge
      bot.setControlState('forward', true);
      await sleep(400);
      bot.setControlState('forward', false);
      await sleep(100);
      if (Math.floor(bot.entity.position.y) > curY) {
        totalSteps++;
        stepsOnSide++;
        if (stepsOnSide >= stepsPerSide) {
          stepsOnSide = 0;
          dirIdx = (dirIdx + 1) % SPIRAL_ORDER.length;
        }
      }
    }

    if (Math.floor(bot.entity.position.y) >= targetY) break;
  }

  if (bot.motion) bot.motion.stop().catch(() => {});
  const finalY = Math.floor(bot.entity.position.y);
  const stoppedEarly = finalY < targetY;
  return {
    steps: totalSteps,
    finalY,
    stoppedEarly,
    message: stoppedEarly
      ? `Spiral stopped at Y=${finalY} (open sky detected) after ${totalSteps} steps. Target was ${targetY}.`
      : `Spiral reached Y=${finalY} (target ${targetY}) in ${totalSteps} steps.`,
  };
}

/**
 * Mine a 1-wide, 2-high horizontal tunnel in a cardinal direction.
 *
 * Pattern (2 blocks per step, heading in `direction` at current Y):
 *   1. Block in front at eye level: (x + dx, y+1, z + dz)
 *   2. Block above that:           (x + dx, y+2, z + dz)
 *
 * Movement: step forward into the cleared space (same Y level).
 * Uses motion.goto for the step; verifies position changes.
 *
 * @param {string} direction  - 'west'|'east'|'north'|'south'
 * @param {number} distance   - how many blocks to tunnel
 * @returns {{ steps: number, startPos: object, endPos: object, message: string }}
 */
async function digTunnel(bot, direction, distance) {
  const dir = CARDINAL_DIRS[direction];
  if (!dir) throw new Error(`Invalid direction '${direction}'. Use west/east/north/south.`);
  if (distance <= 0) return { steps: 0, message: 'Distance must be positive.' };

  const startPos = {
    x: Math.floor(bot.entity.position.x),
    y: Math.floor(bot.entity.position.y),
    z: Math.floor(bot.entity.position.z),
  };
  let steps = 0;

  for (let i = 0; i < distance * 2; i++) {
    const curX = Math.floor(bot.entity.position.x);
    const curY = Math.floor(bot.entity.position.y);
    const curZ = Math.floor(bot.entity.position.z);

    // ── Mine 2-3 blocks (feet level + head level) ─────────
    // For horizontal tunnel, we also need the block at feet level cleared
    const targets = [
      { x: curX + dir.dx, y: curY,     z: curZ + dir.dz, label: 'feet' },
      { x: curX + dir.dx, y: curY + 1, z: curZ + dir.dz, label: 'eyes' },
    ];
    // Add headroom block only if there's a solid ceiling directly above
    const aboveBlock = bot.blockAt(new Vec3(curX + dir.dx, curY + 2, curZ + dir.dz));
    if (aboveBlock && aboveBlock.name !== 'air' && aboveBlock.name !== 'cave_air' && aboveBlock.name !== 'void_air') {
      targets.push({ x: curX + dir.dx, y: curY + 2, z: curZ + dir.dz, label: 'above-eyes' });
    }

    for (const t of targets) {
      const block = bot.blockAt(new Vec3(t.x, t.y, t.z));
      if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
        try {
          await bot.tool.equipForBlock(block);
          await bot.dig(block, true);
        } catch (e) {
          log(`[tunnel] dig failed at ${t.x},${t.y},${t.z} (${t.label}): ${e.message}`);
        }
        await sleep(100);
      }
    }

    // ── Step forward ───────────────────────────────────────
    const targetX = curX + dir.dx + 0.5;
    const targetZ = curZ + dir.dz + 0.5;

    const beforeX = bot.entity.position.x;
    const beforeZ = bot.entity.position.z;
    try {
      bot.motion.goto(targetX, curY, targetZ);
      await sleep(600);
    } catch (e) {
      // cancellation is fine
    }

    // Verify forward movement in the intended direction
    const dx2 = bot.entity.position.x - beforeX;
    const dz2 = bot.entity.position.z - beforeZ;
    const movedCorrectDir = (dir.dx < 0 && dx2 < -0.3) || (dir.dx > 0 && dx2 > 0.3) ||
                            (dir.dz < 0 && dz2 < -0.3) || (dir.dz > 0 && dz2 > 0.3);
    if (movedCorrectDir) {
      steps++;
    } else {
      // Nudge
      bot.setControlState('forward', true);
      await sleep(400);
      bot.setControlState('forward', false);
      await sleep(100);
      const dx3 = bot.entity.position.x - beforeX;
      const dz3 = bot.entity.position.z - beforeZ;
      const nudgeOK = (dir.dx < 0 && dx3 < -0.3) || (dir.dx > 0 && dx3 > 0.3) ||
                      (dir.dz < 0 && dz3 < -0.3) || (dir.dz > 0 && dz3 > 0.3);
      if (nudgeOK) steps++;
    }

    if (steps >= distance) break;
  }

  if (bot.motion) bot.motion.stop().catch(() => {});
  const endPos = {
    x: Math.floor(bot.entity.position.x),
    y: Math.floor(bot.entity.position.y),
    z: Math.floor(bot.entity.position.z),
  };
  return {
    steps,
    startPos,
    endPos,
    message: `Tunneled ${steps} blocks ${direction} (target ${distance}).`,
  };
}

/**
 * Post-action judge — wraps an action, captures before/after state,
 * classifies the outcome, and stores the result in the lastJudge mailbox.
 *
 * @param {object}   intent    - { action, target?, targetY?, direction? }
 * @param {function} actionFn  - async function that performs the action
 */
async function judgeAction(intent, actionFn) {
  const b = ensureBot();
  const before = {
    tick: (b.time && typeof b.time.age === 'number') ? b.time.age : Date.now(),
    pos: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
  };
  let error = null;
  let value;
  try {
    value = await actionFn();
  } catch (e) {
    error = e.message;
  }
  await sleep(50); // let physics settle
  const after = {
    tick: (b.time && typeof b.time.age === 'number') ? b.time.age : Date.now(),
    pos: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
  };

  const dx = after.pos.x - before.pos.x;
  const dy = after.pos.y - before.pos.y;
  const dz = after.pos.z - before.pos.z;
  const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);

  let outcome, confidence, reason_code;
  const runnerActive = bodyMutex && bodyMutex.getStatus().mode === 3; // REFLEX

  if (error) {
    outcome = 'error';
    confidence = 'high';
    reason_code = 'EXCEPTION';
  } else if (runnerActive) {
    outcome = 'preempted';
    confidence = 'high';
    reason_code = 'RUNNER_ACTIVE';
  } else if (moved < 0.05) {
    outcome = 'no_progress';
    confidence = 'high';
    reason_code = 'NO_MOVEMENT';
  } else if (dy > 0.3 && intent.action === 'goto') {
    outcome = 'success';  // step-up counted as success
    confidence = 'medium';
    reason_code = 'STEP_UP';
  } else if (dy < -0.5) {
    outcome = 'displaced';
    confidence = 'high';
    reason_code = 'FELL';
  } else if (moved > 0.05) {
    outcome = 'success';
    confidence = 'high';
    reason_code = 'MOVED';
  } else {
    outcome = 'no_progress';
    confidence = 'low';
    reason_code = 'UNKNOWN';
  }

  const entry = {
    action: intent.action,
    intent: intent.target ? { x: intent.target.x, y: intent.target.y, z: intent.target.z } : null,
    outcome,
    confidence,
    reason_code,
    position_before: before.pos,
    position_after: after.pos,
    position_delta: { dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10, dz: Math.round(dz * 10) / 10 },
    captured_at_tick: after.tick,
    error: error || null,
    initiator: intent.initiator || 'l4_agent', // who requested this action: l2_runner, l3_loop, l4_agent
    consumed_by_l4: false,
  };
  lastJudge = entry;
  judgeRing.push(entry);
  if (judgeRing.length > MAX_JUDGE_RING) judgeRing.shift();
  return { judge: entry, value };
}

// List visible entities by type with distances
function nearbyEntitiesHint(bot, filterFn) {
  const visible = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position && bot.entity.position.distanceTo(e.position) < 32)
    .filter(filterFn || (() => true))
    .sort((a, c) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(c.position))
    .slice(0, 5);
  if (visible.length === 0) return 'No entities visible within 32 blocks.';
  return visible.map(e => `${e.name || e.username || 'unknown'}(${fmt(bot.entity.position.distanceTo(e.position))}m)`).join(', ');
}

function posObj(pos) {
  const p = pos || bot?.entity?.position;
  if (!p) return null;
  return { x: fmt(p.x), y: fmt(p.y), z: fmt(p.z) };
}

function itemStr(item) {
  if (!item) return null;
  return { name: item.name, count: item.count };
}

function ensureBot() {
  if (!bot || !botReady || !bot.entity) {
    throw new Error('Bot not connected. POST /connect to retry.');
  }
  return bot;
}

/** Find nearest safe spot for teleport within 3-block radius.
 *  Feet and head must be walkable; block below must be solid.
 *  Returns adjusted coordinates if original spot is unsafe.
 */
function findSafeTeleportSpot(b, x, y, z) {
  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);

  function spotOk(fx, fy, fz) {
    const feet = b.blockAt(new Vec3(fx, fy, fz));
    const head = b.blockAt(new Vec3(fx, fy + 1, fz));
    const ground = b.blockAt(new Vec3(fx, fy - 1, fz));
    return isWalkable(feet?.name || 'air') && isWalkable(head?.name || 'air') && !isWalkable(ground?.name || 'air');
  }

  if (spotOk(bx, by, bz)) {
    return { x: bx, y: by, z: bz, adjusted: false };
  }

  const candidates = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dz = -3; dz <= 3; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const dist = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (dist > 3) continue;
        candidates.push({ dx, dy, dz, dist });
      }
    }
  }
  candidates.sort((a, c) => a.dist - c.dist);

  for (const c of candidates) {
    const tx = bx + c.dx;
    const ty = by + c.dy;
    const tz = bz + c.dz;
    if (spotOk(tx, ty, tz)) {
      return { x: tx, y: ty, z: tz, adjusted: true };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Chat Chunking & Delivery
// ═══════════════════════════════════════════════════════════════════

function chunkForMc(text, maxChars = MC_FRAGMENT_MAX_CHARS, maxFragments = MC_MAX_FRAGMENTS, byteLimit = MC_PROTOCOL_BYTE_LIMIT) {
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return { fragments: [], truncated: false };

  const sentenceRe = /[^.!?…]+[.!?…]+(?:\s+|$)|[^.!?…]+$/g;
  const sentences = (text.match(sentenceRe) || [text]).map(s => s.trim()).filter(Boolean);

  const fragments = [];
  let buf = "";
  const flush = () => { if (buf) { fragments.push(buf); buf = ""; } };

  for (const s of sentences) {
    if (s.length > maxChars) {
      flush();
      fragments.push(...wordSplit(s, maxChars));
      continue;
    }
    const candidate = buf ? buf + ' ' + s : s;
    if (candidate.length <= maxChars) {
      buf = candidate;
    } else {
      flush();
      buf = s;
    }
  }
  flush();

  let truncated = false;
  if (fragments.length > maxFragments) {
    truncated = true;
    fragments.length = maxFragments;
    const last = fragments[maxFragments - 1];
    const ellipsis = " [...]";
    if (last.length + ellipsis.length <= maxChars) {
      fragments[maxFragments - 1] = last + ellipsis;
    } else {
      fragments[maxFragments - 1] = last.slice(0, maxChars - ellipsis.length).trimEnd() + ellipsis;
    }
  }

  return { fragments: fragments.map(f => byteCap(f, byteLimit)), truncated };
}

function wordSplit(s, maxChars) {
  const out = [];
  let buf = "";
  for (const word of s.split(/\s+/)) {
    if (word.length > maxChars) {
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      continue;
    }
    const candidate = buf ? buf + ' ' + word : word;
    if (candidate.length <= maxChars) buf = candidate;
    else { out.push(buf); buf = word; }
  }
  if (buf) out.push(buf);
  return out;
}

function byteCap(s, limit = MC_PROTOCOL_BYTE_LIMIT) {
  if (Buffer.byteLength(s, 'utf8') <= limit) return s;
  let cut = s;
  while (Buffer.byteLength(cut, 'utf8') > limit) cut = cut.slice(0, -1);
  return cut;
}

async function sendToMcChat(text, { source = "auto", target = null } = {}) {
  const overhead = target ? Buffer.byteLength(`/tell ${target} `, 'utf8') : 0;
  const { fragments, truncated } = chunkForMc(text, MC_FRAGMENT_MAX_CHARS, MC_MAX_FRAGMENTS, MC_PROTOCOL_BYTE_LIMIT - overhead);
  if (fragments.length === 0) {
    return { ok: true, fragments_sent: 0, fragments_dropped: 0, reason: "empty" };
  }

  const now = Date.now();
  recentFragments = recentFragments.filter(t => now - t < MC_THROTTLE_WINDOW_MS);
  let dropped = truncated ? 1 : 0;
  let sent = 0;

  for (const frag of fragments) {
    if (recentFragments.length >= MC_THROTTLE_WINDOW_MAX) {
      log(`[chat] Throttle: dropping fragment (${recentFragments.length}/${MC_THROTTLE_WINDOW_MAX} in window)`);
      dropped++;
      continue;
    }
    const b = ensureBot();
    try {
      const payload = target ? `/tell ${target} ${frag}` : frag;
      b.chat(payload);
    } catch (e) {
      log(`[chat] b.chat() threw: ${e.message}`);
      dropped++;
      continue;
    }
    recentFragments.push(now);
    sent++;
    const entry = {
      time: Date.now(),
      from: config.mc.username,
      message: frag,
      self: true,
      world: b?.game?.dimension || 'unknown',
      uuid: b?.player?.uuid || b?.uuid || null,
    };
    if (target) {
      entry.to = target;
      entry.whisper = true;
    }
    chatLog.push(entry);
    if (chatLog.length > MAX_LOG) chatLog.shift();
    broadcastDashboard('chat', chatLog.slice(-30));
    if (sent < fragments.length) await sleep(MC_FRAGMENT_DELAY_MS);
  }

  return { ok: true, fragments_sent: sent, fragments_dropped: dropped, truncated };
}

// ═══════════════════════════════════════════════════════════════════
// Fair Play — Line-of-Sight & Perception
// ═══════════════════════════════════════════════════════════════════

function hasLineOfSight(from, to) {
  if (!bot || !botReady) return false;
  // Bresenham-style raycast through blocks
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if (dist < 1) return true;
  const steps = Math.ceil(dist * 2); // check every 0.5 blocks
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const z = from.z + dz * t;
    const block = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
    if (block && block.boundingBox === 'block') return false; // solid block blocks LOS
  }
  return true;
}

function canDetectEntity(entity) {
  if (!fairPlayMode || !bot || !botReady) return true; // no filtering if fair play off
  const pos = bot.entity.position;
  const dist = entity.position.distanceTo(pos);
  
  // Always detect entities within 3 blocks (melee range — you can hear/feel them)
  if (dist < 3) return true;
  
  // Sneaking entities: much shorter detection range
  const isSneaking = entity.metadata?.[6] === 5 || entity.crouching || (entity.pose === 'sneaking');
  if (isSneaking && dist > FAIR_PLAY.SNEAK_DETECT_RANGE) return false;
  
  // Beyond max range: invisible
  if (dist > FAIR_PLAY.LOS_ENTITY_RANGE) return false;
  
  // LOS check: raycast from bot eyes to entity center
  const eyeHeight = bot.entity.height * 0.85;
  const eyePos = pos.offset(0, eyeHeight, 0);
  const targetCenter = entity.position.offset(0, (entity.height || 1.8) * 0.5, 0);
  
  if (!hasLineOfSight(eyePos, targetCenter)) {
    // Can't see through walls — but check sound events
    // Mining/sprinting nearby creates sound events
    return false;
  }
  
  return true;
}

function filterEntitiesFairPlay(entities) {
  if (!fairPlayMode) return entities;
  return entities.filter(e => canDetectEntity(e));
}

function eyePosition(entity = bot?.entity) {
  if (!entity?.position) return null;
  return entity.position.offset(0, (entity.height || 1.62) * 0.85, 0);
}

function raycastFirstSolid(origin, direction, maxDistance = 16, step = 0.75) {
  for (let distance = step; distance <= maxDistance; distance += step) {
    const sample = new Vec3(
      origin.x + direction.x * distance,
      origin.y + direction.y * distance,
      origin.z + direction.z * distance,
    );
    const block = bot.blockAt(new Vec3(Math.floor(sample.x), Math.floor(sample.y), Math.floor(sample.z)));
    if (block && block.boundingBox === 'block' && block.name !== 'air' && block.name !== 'cave_air') {
      return { block, distance };
    }
  }
  return null;
}

function rememberObservedBlock(entry) {
  observedBlocks.set(makeBlockMemoryKey(entry.position, entry.name), {
    ...entry,
    lastSeen: Date.now(),
  });
  if (observedBlocks.size > 200) {
    const oldest = [...observedBlocks.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, observedBlocks.size - 200);
    oldest.forEach(([key]) => observedBlocks.delete(key));
  }
}

function scanVisibleBlocks({ range = 16, horizontalFov = 100, verticalFov = 36, horizontalRays = 7, verticalRays = 3 } = {}) {
  const b = ensureBot();
  const origin = eyePosition(b.entity);
  const hits = [];
  const seen = new Set();
  const baseYawDeg = (b.entity.yaw * 180) / Math.PI;
  const basePitchDeg = (b.entity.pitch * 180) / Math.PI;

  for (let yi = 0; yi < verticalRays; yi++) {
    const pitchOffset = verticalRays === 1 ? 0 : -verticalFov / 2 + (verticalFov * yi) / (verticalRays - 1);
    for (let xi = 0; xi < horizontalRays; xi++) {
      const yawOffset = horizontalRays === 1 ? 0 : -horizontalFov / 2 + (horizontalFov * xi) / (horizontalRays - 1);
      const yaw = ((baseYawDeg + yawOffset) * Math.PI) / 180;
      const pitch = ((basePitchDeg + pitchOffset) * Math.PI) / 180;
      const hit = raycastFirstSolid(origin, yawPitchToDir(yaw, pitch), range);
      if (!hit) continue;
      const key = `${hit.block.name}@${hit.block.position.x},${hit.block.position.y},${hit.block.position.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dx = hit.block.position.x - b.entity.position.x;
      const dz = hit.block.position.z - b.entity.position.z;
      const bearing = bearingFromDelta(dx, dz);
      const relativeAngle = angleDiffDegrees(baseYawDeg, (Math.atan2(dx, -dz) * 180) / Math.PI);
      const sector = classifySector(relativeAngle);
      const entry = {
        name: hit.block.name,
        position: posObj(hit.block.position),
        distance: fmt(hit.distance),
        bearing,
        sector,
      };
      hits.push(entry);
      rememberObservedBlock(entry);
    }
  }

  return hits.sort((a, b) => a.distance - b.distance);
}

function detectHazardsFromVisibleBlocks(blocks) {
  return blocks
    .filter((block) => ['lava', 'flowing_lava', 'fire', 'campfire'].includes(block.name))
    .slice(0, 5)
    .map((block) => `${block.name} ${block.sector} ${block.distance}m`);
}

function buildSceneSummary({ range = 16 } = {}) {
  const b = ensureBot();
  const visibleBlocks = fairPlayMode ? scanVisibleBlocks({ range }) : scanVisibleBlocks({ range: Math.min(range, 24), horizontalFov: 140, verticalFov: 50, horizontalRays: 9, verticalRays: 4 });
  const pos = b.entity.position;
  const visibleEntities = filterEntitiesFairPlay(Object.values(b.entities)
    .filter((entity) => entity !== b.entity && entity.position.distanceTo(pos) <= Math.min(range + 8, 24)))
    .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
    .slice(0, 8)
    .map((entity) => ({
      type: entity.username || entity.name || entity.displayName || 'unknown',
      distance: fmt(entity.position.distanceTo(pos)),
      bearing: bearingFromDelta(entity.position.x - pos.x, entity.position.z - pos.z),
      kind: entity.type || (entity.username ? 'player' : 'mob'),
      health: entity.health ?? undefined,
    }));
  const lookingAt = b.blockAtCursor?.(5);
  const hazards = detectHazardsFromVisibleBlocks(visibleBlocks);
  const summary = summarizeSceneText({
    lookingAt: lookingAt ? { name: lookingAt.name, position: posObj(lookingAt.position) } : null,
    visibleBlocks,
    visibleEntities,
    hazards,
    sounds: soundEvents.slice(-5),
    memoryHints: getMemoryHints(),
  });

  return {
    summary,
    visible_blocks: summarizeVisibleBlocks(visibleBlocks),
    visible_block_hits: visibleBlocks,
    visible_entities: visibleEntities,
    hazards,
    looking_at: lookingAt ? { name: lookingAt.name, position: posObj(lookingAt.position) } : null,
    sounds: soundEvents.slice(-5),
    memory_hints: getMemoryHints(),
    fair_play: fairPlayMode,
    range,
  };
}

function findVisibleBlocksByName(blockName, { range = 16, count = 10 } = {}) {
  const needle = String(blockName || '').toLowerCase();
  return scanVisibleBlocks({ range })
    .filter((entry) => entry.name.toLowerCase() === needle)
    .slice(0, count);
}

function addSoundEvent(type, position, radius) {
  if (!bot || !botReady) return;
  const dist = bot.entity.position.distanceTo(position);
  if (dist > radius) return;
  
  // Rough direction (N/S/E/W/NE/etc)
  const dx = position.x - bot.entity.position.x;
  const dz = position.z - bot.entity.position.z;
  const angle = Math.atan2(dz, dx) * 180 / Math.PI;
  let dir;
  if (angle > -22.5 && angle <= 22.5) dir = 'east';
  else if (angle > 22.5 && angle <= 67.5) dir = 'southeast';
  else if (angle > 67.5 && angle <= 112.5) dir = 'south';
  else if (angle > 112.5 && angle <= 157.5) dir = 'southwest';
  else if (angle > 157.5 || angle <= -157.5) dir = 'west';
  else if (angle > -157.5 && angle <= -112.5) dir = 'northwest';
  else if (angle > -112.5 && angle <= -67.5) dir = 'north';
  else dir = 'northeast';
  
  soundEvents.push({
    time: Date.now(),
    type, // 'mining', 'sprinting', 'walking', 'combat', 'explosion'
    direction: dir,
    distance: fmt(dist),
    approximate: true,
  });
  // Keep only last 20 events, last 30 seconds
  soundEvents = soundEvents.filter(e => Date.now() - e.time < 30000).slice(-20);
}

async function reactionDelay() {
  if (!fairPlayMode) return;
  const delay = FAIR_PLAY.REACTION_MIN_MS + Math.random() * (FAIR_PLAY.REACTION_MAX_MS - FAIR_PLAY.REACTION_MIN_MS);
  await sleep(delay);
}

// Brief state snapshot (included in action responses)
// Includes any new chat messages so the AI sees them after every action
function briefState() {
  if (!bot || !botReady) return null;

  // Grab recent chat so AI sees messages that arrived during action.
  // Direct messages (whispers, name-routed DMs) are shown fully.
  // Nearby broadcasts are capped at 2 most recent to reduce cascade noise.
  const now = Date.now();
  const recentAll = chatLog
    .filter(m => now - m.time < 30000 && m.from !== bot.username);
  const directMsgs = recentAll.filter(m => m.private || m.whisper);
  const broadcastMsgs = recentAll.filter(m => !m.private && !m.whisper).slice(-2);
  const recentChat = [...directMsgs, ...broadcastMsgs]
    .sort((a, b) => a.time - b.time)
    .map(m => ({
      from: m.from,
      message: m.message,
      ago: Math.round((now - m.time) / 1000) + 's',
      ...(m.private || m.whisper ? { direct: true } : {}),
    }));

  // Grab pending commands
  const pending = commandQueue.filter(c => c.status === 'pending');

  const state = {
    health: fmt(bot.health),
    food: bot.food,
    position: posObj(),
    holding: bot.heldItem?.name || 'empty',
    time: bot.time.timeOfDay,
    isDay: bot.time.timeOfDay < 12000,
  };

  if (recentChat.length > 0) state.new_chat = recentChat;
  if (pending.length > 0) state.pending_commands = pending.length;
  const recentSocial = socialEvents.filter((entry) => now - entry.time < 60000).slice(-3)
    .map((entry) => `${entry.actor} ${entry.kind} via ${entry.channel}`);
  if (recentSocial.length > 0) state.social = recentSocial;

  // Water hazard — surfaces immediately so agent can react
  if (bot.entity.isInWater) {
    state.hazard = 'SUBMERGED in water — mc stop then mc jump to swim up, navigate to shore';
  }

  // Repeated-failure loop detection
  const recent3 = actionHistory.slice(-3);
  if (recent3.length === 3 && recent3.every(e => e.status !== 'done' && e.action === recent3[0].action)) {
    state.action_loop = `You've tried "${recent3[0].action}" 3 times and failed — check mc inventory first, then try something different`;
  }

  // Show count of overheard messages (other agents' private conversations)
  const recentOverheard = overheardLog.filter(m => now - m.time < 60000).length;
  if (recentOverheard > 0) state.overheard_nearby = recentOverheard;
  if (currentTask && currentTask.status === 'stuck') state.task_stuck = currentTask.error;
  if (currentTask && currentTask.status === 'running') {
    state.task = { action: currentTask.action, elapsed: Math.round((Date.now() - currentTask.started) / 1000) + 's' };
  } else if (currentTask && currentTask.status === 'done') {
    state.task_done = currentTask.result?.result || 'completed';
  } else if (currentTask && currentTask.status === 'error') {
    state.task_error = currentTask.error;
  }

  return state;
}

// ═══════════════════════════════════════════════════════════════════
// State Collection
// ═══════════════════════════════════════════════════════════════════

function getFullState() {
  const b = ensureBot();
  const pos = b.entity.position;
  const inv = b.inventory.items();
  const time = b.time.timeOfDay;

  // Nearby entities (fair-play filtered)
  const rawEntities = Object.values(b.entities)
    .filter(e => e !== b.entity && e.position.distanceTo(pos) < (fairPlayMode ? FAIR_PLAY.LOS_ENTITY_RANGE : 24));
  const visibleEntities = filterEntitiesFairPlay(rawEntities);
  const entities = visibleEntities
    .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
    .slice(0, 15)
    .map(e => ({
      type: e.name || e.mobType || e.displayName || 'unknown',
      kind: e.type || (e.username ? 'player' : 'mob'),
      username: e.username || undefined,
      distance: fmt(e.position.distanceTo(pos)),
      position: posObj(e.position),
      health: e.health ?? undefined,
    }));

  // Nearby blocks (scan 5-block radius, aggregate by type)
  const blockCounts = {};
  const notableBlocks = []; // specific blocks worth calling out
  for (let dx = -5; dx <= 5; dx++) {
    for (let dy = -3; dy <= 4; dy++) {
      for (let dz = -5; dz <= 5; dz++) {
        const block = b.blockAt(pos.offset(dx, dy, dz));
        if (block && block.name !== 'air' && block.name !== 'cave_air') {
          blockCounts[block.name] = (blockCounts[block.name] || 0) + 1;
          // Note ores and interesting blocks with positions
          if (block.name.includes('ore') || block.name === 'crafting_table' || 
              block.name === 'furnace' || block.name === 'chest' ||
              block.name.includes('log') || block.name === 'water' ||
              block.name === 'lava') {
            if (notableBlocks.length < 20) {
              notableBlocks.push({
                name: block.name,
                position: { x: block.position.x, y: block.position.y, z: block.position.z },
              });
            }
          }
        }
      }
    }
  }

  const nearbyBlocks = Object.entries(blockCounts)
    .sort((a, c) => c[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  // What we're looking at
  const scene = buildSceneSummary({ range: 16 });
  const target = b.blockAtCursor?.(5);
  const lookingAt = target ? { name: target.name, position: posObj(target.position) } : null;

  // Biome
  const biome = b.blockAt(pos)?.biome?.name || 'unknown';

  // Unread chat
  const unreadChat = chatLog.length > 0 ? chatLog.slice(-5).map(m => ({
    from: m.from, message: m.message,
    ago: Math.round((Date.now() - m.time) / 1000) + 's',
  })) : [];

  return {
    health: fmt(b.health),
    maxHealth: 20,
    food: b.food,
    saturation: fmt(b.foodSaturation),
    position: posObj(),
    yaw: b.entity.yaw,
    pitch: b.entity.pitch,
    yaw_degrees: fmt((b.entity.yaw * 180) / Math.PI),
    pitch_degrees: fmt((b.entity.pitch * 180) / Math.PI),
    dimension: b.game?.dimension?.replace('minecraft:', '') || 'overworld',
    biome,
    time: time,
    isDay: time < 12000,
    timePhase: time < 6000 ? 'morning' : time < 12000 ? 'afternoon' : time < 18000 ? 'evening' : 'night',
    holding: bot.heldItem ? itemStr(bot.heldItem) : 'empty',
    experience: { level: b.experience?.level || 0 },
    inventory: inv.map(i => ({ name: i.name, count: i.count })),
    inventoryCount: inv.length,
    nearbyBlocks,
    notableBlocks,
    nearbyEntities: entities,
    nearbyPlayers: entities.filter(e => e.kind === 'player').map(p => ({ name: p.username || p.type, distance: p.distance, position: p.position })),
    lookingAt,
    unreadChat: unreadChat.length > 0 ? unreadChat : undefined,
    deaths: deathLog.length,
    lastDeath: lastDeath ? { position: lastDeath.position, seconds_ago: Math.round((Date.now()-lastDeath.time)/1000) } : null,
    onGround: b.entity.onGround,
    isRaining: b.isRaining,
    isSneaking: isSneaking,
    // Fair play: sound events (directional hints without exact positions)
    sounds: soundEvents.length > 0 ? soundEvents.slice(-5) : undefined,
    scene,
    social_summary: summarizeSocialGraph(socialGraph),
    // Team info
    team: teamConfig.team ? {
      name: teamConfig.team,
      role: teamConfig.role,
      rallyPoint: teamConfig.rallyPoint,
      recentTeamChat: teamConfig.teamChat.slice(-3),
    } : undefined,
    // Combat stats
    combatStats: (combatStats.kills + combatStats.deaths > 0) ? combatStats : undefined,
    // Active furnaces
    activeFurnaces: activeFurnaces.length > 0 ? activeFurnaces.map(f => ({
      position: { x: f.x, y: f.y, z: f.z },
      input: f.input,
      estimatedDone: f.estimatedDone ? Math.max(0, Math.round((f.estimatedDone - Date.now()) / 1000)) + 's' : 'unknown',
    })) : undefined,
    fairPlay: fairPlayMode,
    hardcore: bot.game?.hardcore || false,
    permanentlyDead: hardcoreDead,
    // Task state — critical for heartbeat reactivity
    task: currentTask ? {
      status: currentTask.status,
      action: currentTask.action,
      error: currentTask.error || undefined,
      elapsed_s: currentTask.started ? Math.round((Date.now() - currentTask.started) / 1000) : undefined,
    } : null,
    isInWater: b.entity.isInWater,
  };
}

function getInventory() {
  const b = ensureBot();
  const items = b.inventory.items();

  const categories = {};
  items.forEach(item => {
    const n = item.name;
    let cat = 'other';
    if (n.includes('pickaxe') || n.includes('_axe') || n.includes('shovel') || n.includes('hoe') || n === 'shears' || n === 'flint_and_steel') cat = 'tools';
    else if (n.includes('sword') || n.includes('bow') || n === 'crossbow' || n === 'trident') cat = 'weapons';
    else if (n.includes('helmet') || n.includes('chestplate') || n.includes('leggings') || n.includes('boots') || n === 'shield') cat = 'armor';
    else if (n.includes('cooked') || n.includes('bread') || n.includes('apple') || n.includes('steak') || n.includes('porkchop') || n.includes('chicken') || n.includes('salmon') || n.includes('potato') || n === 'mushroom_stew') cat = 'food';
    else if (n.includes('ingot') || n.includes('diamond') || n.includes('coal') || n.includes('redstone') || n.includes('lapis') || n.includes('stick') || n.includes('string') || n.includes('flint') || n.includes('blaze') || n.includes('ender_pearl')) cat = 'materials';
    else if (mcData?.blocksByName[n]) cat = 'blocks';

    if (!categories[cat]) categories[cat] = [];
    categories[cat].push({ name: n, count: item.count });
  });

  // Include equipped armor and offhand (slots outside inventory.items() range)
  const armorSlots = [
    { slot: 5, type: 'helmet' },
    { slot: 6, type: 'chestplate' },
    { slot: 7, type: 'leggings' },
    { slot: 8, type: 'boots' },
  ];
  armorSlots.forEach(({ slot, type }) => {
    const item = b.inventory.slots[slot];
    if (item) {
      if (!categories['armor']) categories['armor'] = [];
      categories['armor'].push({ name: item.name, count: item.count, equipped: true, slot_type: type });
    }
  });
  const offhand = b.inventory.slots[45];
  if (offhand) {
    let cat = 'other';
    const n = offhand.name;
    if (n.includes('sword') || n.includes('bow') || n === 'crossbow' || n === 'trident') cat = 'weapons';
    else if (n === 'shield') cat = 'armor';
    else if (n.includes('pickaxe') || n.includes('_axe') || n.includes('shovel') || n.includes('hoe')) cat = 'tools';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push({ name: n, count: offhand.count, equipped: true, slot_type: 'offhand' });
  }

  const totalSlots = items.length + armorSlots.filter(a => b.inventory.slots[a.slot]).length + (offhand ? 1 : 0);
  return { categories, totalSlots };
}

function getNearby(radius = 32) {
  const b = ensureBot();
  const pos = b.entity.position;

  // Entities (fair-play filtered)
  const rawEnts = Object.values(b.entities)
    .filter(e => e !== b.entity && e.position.distanceTo(pos) < radius);
  const entities = filterEntitiesFairPlay(rawEnts)
    .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
    .slice(0, 20)
    .map(e => ({
      type: e.name || e.mobType || 'unknown',
      distance: fmt(e.position.distanceTo(pos)),
      position: posObj(e.position),
      health: e.kind === 'player' && e.username
        ? (b.players?.[e.username]?.health ?? 20)
        : e.health,
      kind: e.type, // 'mob', 'player', 'object', etc.
    }));

  // Notable blocks in wider radius
  const blockTypes = {};
  const scanR = Math.min(radius, 64); // block scan — decent range for general scans
  for (let dx = -scanR; dx <= scanR; dx += 2) {
    for (let dy = -8; dy <= 8; dy++) {
      for (let dz = -scanR; dz <= scanR; dz += 2) {
        const block = b.blockAt(pos.offset(dx, dy, dz));
        if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'stone' && block.name !== 'dirt' && block.name !== 'grass_block' && block.name !== 'deepslate') {
          if (!blockTypes[block.name]) blockTypes[block.name] = { count: 0, nearest: null, nearestDist: Infinity };
          blockTypes[block.name].count++;
          const dist = pos.distanceTo(block.position);
          if (dist < blockTypes[block.name].nearestDist) {
            blockTypes[block.name].nearest = posObj(block.position);
            blockTypes[block.name].nearestDist = dist;
          }
        }
      }
    }
  }

  const blocks = Object.entries(blockTypes)
    .sort((a, c) => c[1].count - a[1].count)
    .slice(0, 25)
    .map(([name, info]) => ({ name, count: info.count, nearest: info.nearest }));

  return { entities, blocks, scanRadius: scanR };
}

// ═══════════════════════════════════════════════════════════════════
// Spatial Awareness — ASCII Map + Narrative Description
// ═══════════════════════════════════════════════════════════════════

// Generate a top-down ASCII map of the area around the bot
// This gives agents SPATIAL understanding — where things are relative to them
function generateMap(radius = 16) {
  const b = ensureBot();
  const pos = b.entity.position;
  const mapSize = Math.min(radius, 24); // cap at 24 for readability
  const step = mapSize > 16 ? 2 : 1; // downsample for large radii
  const gridR = Math.floor(mapSize / step);
  
  // Build a 2D grid (top-down, X=east, Z=south in MC)
  // Grid is [row][col] where row=north→south (Z), col=west→east (X)
  const grid = [];
  const heightMap = [];
  for (let rz = -gridR; rz <= gridR; rz++) {
    const row = [];
    const hrow = [];
    for (let rx = -gridR; rx <= gridR; rx++) {
      const wx = Math.floor(pos.x) + rx * step;
      const wz = Math.floor(pos.z) + rz * step;
      // Find surface block (scan down from above)
      let surfaceBlock = null;
      let surfaceY = 0;
      for (let dy = 8; dy >= -8; dy--) {
        const wy = Math.floor(pos.y) + dy;
        const block = b.blockAt(new Vec3(wx, wy, wz));
        if (block && block.name !== 'air' && block.name !== 'cave_air') {
          surfaceBlock = block;
          surfaceY = wy;
          break;
        }
      }
      row.push(surfaceBlock);
      hrow.push(surfaceY);
    }
    grid.push(row);
    heightMap.push(hrow);
  }
  
  // Map block types to characters
  function blockChar(block, y) {
    if (!block) return ' ';
    const n = block.name;
    if (n === 'water' || n === 'flowing_water') return '~';
    if (n === 'lava' || n === 'flowing_lava') return '!';
    if (n.includes('log') || n.includes('wood')) return 'T';
    if (n.includes('leaves')) return '*';
    if (n.includes('ore')) return '$';
    if (n === 'sand' || n === 'sandstone') return '.';
    if (n === 'gravel') return ',';
    if (n === 'grass_block') return '.';
    if (n === 'dirt' || n === 'coarse_dirt') return '.';
    if (n.includes('stone') || n === 'cobblestone') return '#';
    if (n === 'deepslate' || n.includes('deepslate')) return '#';
    if (n.includes('plank') || n.includes('slab') || n.includes('stair')) return '=';
    if (n === 'crafting_table') return 'C';
    if (n === 'furnace' || n === 'blast_furnace') return 'F';
    if (n === 'chest' || n === 'barrel') return 'B';
    if (n.includes('door')) return 'D';
    if (n === 'torch' || n === 'wall_torch' || n === 'lantern') return 'i';
    if (n === 'snow' || n === 'snow_block') return 'o';
    if (n.includes('ice')) return '-';
    if (n.includes('flower') || n.includes('tulip') || n.includes('daisy') || n === 'dandelion' || n === 'poppy') return '+';
    if (n === 'tall_grass' || n === 'short_grass' || n === 'fern') return '"';
    if (n === 'cactus') return 'I';
    if (n === 'sugar_cane' || n === 'bamboo') return '|';
    if (n === 'farmland' || n === 'wheat' || n.includes('crop')) return '%';
    if (n === 'bed' || n.includes('bed')) return 'b';
    return '.';
  }
  
  // Place entities on the map
  const entityMarkers = {};
  Object.values(b.entities).forEach(e => {
    if (e === b.entity) return;
    const dx = Math.round((e.position.x - pos.x) / step);
    const dz = Math.round((e.position.z - pos.z) / step);
    if (Math.abs(dx) <= gridR && Math.abs(dz) <= gridR) {
      const key = `${dz + gridR},${dx + gridR}`;
      if (e.type === 'player' || e.username) {
        entityMarkers[key] = '@'; // players
      } else if (e.name && (e.name.includes('zombie') || e.name.includes('skeleton') || 
                 e.name.includes('creeper') || e.name.includes('spider') || e.name.includes('enderman'))) {
        entityMarkers[key] = 'X'; // hostile mobs
      } else if (e.type === 'mob') {
        entityMarkers[key] = 'a'; // passive mobs (animals)
      }
    }
  });
  
  // Build the ASCII string
  const lines = [];
  lines.push('     ' + 'N');
  lines.push('     ' + '|');
  
  const width = gridR * 2 + 1;
  for (let rz = 0; rz < grid.length; rz++) {
    let line = '';
    if (rz === gridR) {
      line += 'W -- ';
    } else {
      line += '     ';
    }
    for (let rx = 0; rx < grid[rz].length; rx++) {
      if (rz === gridR && rx === gridR) {
        line += 'P'; // Player position
      } else {
        const key = `${rz},${rx}`;
        if (entityMarkers[key]) {
          line += entityMarkers[key];
        } else {
          line += blockChar(grid[rz][rx], heightMap[rz][rx]);
        }
      }
    }
    if (rz === gridR) {
      line += ' -- E';
    }
    lines.push(line);
  }
  
  lines.push('     ' + '|');
  lines.push('     ' + 'S');
  
  // Legend for what's on the map
  const legend = [];
  legend.push('P=you @=player X=hostile a=animal');
  legend.push('T=tree ~=water !=lava $=ore #=stone');
  legend.push('C=craft F=furnace B=chest D=door b=bed');
  legend.push('=wall/floor .=ground "=grass +=flower');
  
  // Collect entity labels
  const entityLabels = [];
  Object.values(b.entities).forEach(e => {
    if (e === b.entity) return;
    const dist = e.position.distanceTo(pos);
    if (dist > mapSize) return;
    const dx = e.position.x - pos.x;
    const dz = e.position.z - pos.z;
    const dir = getCardinal(dx, dz);
    if (e.username) {
      entityLabels.push(`${e.username} (${dir}, ${fmt(dist)}m)`);
    } else if (e.name) {
      entityLabels.push(`${e.name} (${dir}, ${fmt(dist)}m)`);
    }
  });
  
  return {
    map: lines.join('\n'),
    legend: legend.join('\n'),
    entities_on_map: entityLabels.slice(0, 15),
    center: posObj(),
    radius: mapSize,
    scale: step > 1 ? `1 char = ${step} blocks` : '1 char = 1 block',
  };
}

function getCardinal(dx, dz) {
  // MC: +X=east, +Z=south
  const angle = Math.atan2(dx, -dz) * 180 / Math.PI; // 0=north
  if (angle > -22.5 && angle <= 22.5) return 'N';
  if (angle > 22.5 && angle <= 67.5) return 'NE';
  if (angle > 67.5 && angle <= 112.5) return 'E';
  if (angle > 112.5 && angle <= 157.5) return 'SE';
  if (angle > 157.5 || angle <= -157.5) return 'S';
  if (angle > -157.5 && angle <= -112.5) return 'SW';
  if (angle > -112.5 && angle <= -67.5) return 'W';
  return 'NW';
}

// Generate a narrative description of surroundings — like what a human would SEE
function generateLookAround() {
  const b = ensureBot();
  const pos = b.entity.position;
  const parts = [];
  
  // Time and weather
  const time = b.time.timeOfDay;
  const phase = time < 3000 ? 'early morning' : time < 6000 ? 'morning' : time < 9000 ? 'midday' : 
                time < 12000 ? 'afternoon' : time < 13500 ? 'sunset' : time < 18000 ? 'evening' : 'night';
  parts.push(`It's ${phase}${b.isRaining ? ', raining' : ''}.`);
  
  // Immediate terrain
  const biome = b.blockAt(pos)?.biome?.name || 'unknown';
  const ground = b.blockAt(pos.offset(0, -1, 0))?.name || 'unknown';
  parts.push(`Standing on ${ground} in ${biome.replace(/_/g, ' ')}.`);
  
  // Height context (above/below ground level approximation)
  const y = Math.floor(pos.y);
  if (y > 90) parts.push(`High up (Y:${y}).`);
  else if (y < 50) parts.push(`Underground (Y:${y}).`);
  else parts.push(`Y:${y}.`);
  
  // Scan each cardinal direction for notable features
  const directions = [
    { name: 'North', dx: 0, dz: -1 },
    { name: 'East', dx: 1, dz: 0 },
    { name: 'South', dx: 0, dz: 1 },
    { name: 'West', dx: -1, dz: 0 },
  ];
  
  for (const dir of directions) {
    const features = [];
    let hasWater = false, hasTrees = false, hasStone = false, hasBuilding = false;
    let terrainDelta = 0;
    
    for (let dist = 2; dist <= 20; dist += 2) {
      const wx = Math.floor(pos.x) + dir.dx * dist;
      const wz = Math.floor(pos.z) + dir.dz * dist;
      
      // Check a column
      for (let dy = -4; dy <= 10; dy++) {
        const block = b.blockAt(new Vec3(wx, Math.floor(pos.y) + dy, wz));
        if (!block || block.name === 'air') continue;
        if (block.name === 'water' || block.name === 'flowing_water') hasWater = true;
        if (block.name.includes('log')) hasTrees = true;
        if (block.name.includes('plank') || block.name.includes('stair') || block.name === 'cobblestone_wall') hasBuilding = true;
        if (dy > 4 && block.name !== 'leaves' && block.name !== 'air') terrainDelta++;
      }
      
      // Check surface height difference
      for (let sy = 20; sy >= -10; sy--) {
        const block = b.blockAt(new Vec3(wx, Math.floor(pos.y) + sy, wz));
        if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'leaves') {
          const surfaceY = Math.floor(pos.y) + sy;
          if (Math.abs(surfaceY - pos.y) > 5) {
            if (surfaceY > pos.y + 5) hasStone = true; // cliff/hill
          }
          break;
        }
      }
    }
    
    const desc = [];
    if (hasBuilding) desc.push('structures');
    if (hasTrees) desc.push('trees');
    if (hasWater) desc.push('water');
    if (hasStone) desc.push('high ground');
    if (desc.length > 0) {
      features.push(`${dir.name}: ${desc.join(', ')}`);
    } else {
      features.push(`${dir.name}: open terrain`);
    }
    parts.push(...features);
  }
  
  // Nearby players with directions
  const players = Object.values(b.entities)
    .filter(e => e !== b.entity && e.username && e.position.distanceTo(pos) < 40)
    .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));
  
  if (players.length > 0) {
    const playerDescs = players.map(p => {
      const dx = p.position.x - pos.x;
      const dz = p.position.z - pos.z;
      return `${p.username} ${getCardinal(dx, dz)} ${fmt(p.position.distanceTo(pos))}m`;
    });
    parts.push(`Players: ${playerDescs.join(', ')}`);
  }
  
  // Nearby threats
  const threats = Object.values(b.entities)
    .filter(e => {
      if (e === b.entity) return false;
      return HOSTILE_NAMES.some(h => (e.name || '').includes(h)) && e.position.distanceTo(pos) < 20;
    })
    .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));
  
  if (threats.length > 0) {
    const threatDescs = threats.slice(0, 5).map(t => {
      const dx = t.position.x - pos.x;
      const dz = t.position.z - pos.z;
      return `${t.name} ${getCardinal(dx, dz)} ${fmt(t.position.distanceTo(pos))}m`;
    });
    parts.push(`⚠ THREATS: ${threatDescs.join(', ')}`);
  }
  
  // Nearby animals (food)
  const animals = Object.values(b.entities)
    .filter(e => {
      if (e === b.entity || e.type !== 'mob') return false;
      const passive = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey'];
      return passive.some(a => (e.name || '').includes(a)) && e.position.distanceTo(pos) < 25;
    });
  
  if (animals.length > 0) {
    const animalCounts = {};
    animals.forEach(a => { animalCounts[a.name] = (animalCounts[a.name] || 0) + 1; });
    const animalDesc = Object.entries(animalCounts).map(([n, c]) => `${c}x${n}`).join(', ');
    parts.push(`Animals nearby: ${animalDesc}`);
  }
  
  return {
    description: parts.join(' '),
    position: posObj(),
    biome: biome.replace(/_/g, ' '),
    time_phase: phase,
    light_level: b.blockAt(pos)?.light || 0,
  };
}


// ═══════════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════════

// Non-solid blocks that fair-play raycasting cannot detect (rays pass through them).
// For these, we fall back to findBlocks() even in fairPlayMode.
const NON_SOLID_BLOCKS = new Set([
  'grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush',
  'peony', 'sweet_berry_bush', 'seagrass', 'tall_seagrass', 'kelp',
  'kelp_plant', 'vine', 'glow_lichen', 'cave_vines', 'cave_vines_plant',
]);

const ACTIONS = {
  // ── Movement ─────────────────────────────────────
  async goto({ x, y, z }) {
    const b = ensureBot();
    const m = b.motion;
    if (!m) throw new Error('Motion controller not initialized');
    return await m.goto(x, y, z);
  },

  async goto_near({ x, y, z, range = 2 }) {
    const b = ensureBot();
    const m = b.motion;
    if (!m) throw new Error('Motion controller not initialized');
    return await m.gotoNear(x, y, z, range);
  },

  async follow({ player }) {
    const b = ensureBot();
    const entity = Object.values(b.entities).find(e =>
      e !== b.entity && (
        (e.username || '').toLowerCase() === player.toLowerCase() ||
        (e.name || '').toLowerCase() === player.toLowerCase()
      )
    );
    if (!entity) {
      const hint = nearbyEntitiesHint(b);
      throw new Error(`Player/entity "${player}" not found nearby. Visible nearby: ${hint}. Move closer, wait for them, or ask for coordinates.`);
    }
    const m = b.motion;
    if (m) return await m.follow(entity);
    throw new Error('Motion controller not initialized');
  },

  async look({ x, y, z }) {
    const b = ensureBot();
    await b.lookAt(new Vec3(x, y, z));
    return { result: `Looking at ${x}, ${y}, ${z}` };
  },

  async stop() {
    const b = ensureBot();
    const m = b.motion;
    if (m) await m.stop();
    if (b.pvp) try { b.pvp.stop(); } catch {}
    return { result: 'Stopped all actions.' };
  },

// ── Mining ───────────────────────────────────────
async collect({ block, count = 1 }) {
  const b = ensureBot();
  const blockType = mcData.blocksByName[block];
  if (!blockType) throw new Error(`Unknown block "${block}". Check spelling (e.g. oak_log, iron_ore, cobblestone).`);

  // Cap at 20 per call — chat piggybacks on the response so AI sees it
  const batchSize = Math.min(count, 20);
  const isNonSolid = NON_SOLID_BLOCKS.has(block.toLowerCase());

  let found = fairPlayMode && !isNonSolid
    ? findVisibleBlocksByName(block, { range: 16, count: batchSize * 3 }).map((entry) => new Vec3(entry.position.x, entry.position.y, entry.position.z))
    : b.findBlocks({
        matching: blockType.id,
        maxDistance: 64,
        count: batchSize * 3,
      });

  if (found.length === 0) {
    const pos = posObj();
    if (fairPlayMode && isNonSolid) {
      // Non-solid blocks aren't visible to raycast — tell the agent to search differently
      throw new Error(`Can't see any ${block} from line-of-sight (it's too small to raycast). Use mc_mine(action="find_blocks", block="${block}") to scan the area, then mc_mine(action="dig", x=..., y=..., z=...) on the exact coordinates.`);
    }
    throw new Error(fairPlayMode
      ? `Can't see any ${block} from ${pos.x}, ${pos.y}, ${pos.z}. Turn around, move closer to likely sources, or use mc_perceive(type="nearby") / mc_scene to inspect before collecting.`
      : `No ${block} found within 64 blocks of ${pos.x}, ${pos.y}, ${pos.z}. Move to a better area or search for a different resource.`);
  }

    // Only mine blocks at the bot's eye level or above.
    // Use bot Y (eye level), not feet — the goto already put us at the block's Y,
    // so comparing against feet would let through blocks at the bot's new lower level.
    const botPos = b.entity.position;
    const botFeetY = Math.floor(botPos.y);
    const botUnderfoot = botFeetY - 1;  // the single block we stand on

    const safe = found.filter(pos => {
      // Skip ONLY the block directly under our feet — never dig ourselves in
      if (Math.abs(pos.x - Math.floor(botPos.x)) < 1 &&
          Math.abs(pos.z - Math.floor(botPos.z)) < 1 &&
          pos.y === botUnderfoot) return false;
      // All other blocks are fair game — including those below us on slopes
      return true;
    }).sort((a, b) => b.y - a.y);

    if (safe.length === 0) throw new Error(
      `Found ${found.length} ${block}, but all are below your feet. ` +
      `Move to lower ground or walk to where the ${block} is at eye level or above.`);

    let collected = 0;
    for (const pos of safe.slice(0, batchSize)) {
      try {
        const target = b.blockAt(pos);
        if (!target || target.name !== block) continue;
        await b.tool.equipForBlock(target);

        // Navigate to beside the target block (X+1 offset), so we mine sideways
        // rather than standing directly on it (which triggers the under-foot safety filter).
        if (b.entity.position.distanceTo(pos) > 4.5) {
          if (b.motion) await b.motion.gotoNear(pos.x + 1, pos.y, pos.z, 3);
        }

        // Safety: never mine the block directly under our feet
        const nowFeet = Math.floor(b.entity.position.y) - 1;
        const dxf = Math.abs(pos.x - Math.floor(b.entity.position.x));
        const dzf = Math.abs(pos.z - Math.floor(b.entity.position.z));
        if (dxf === 0 && dzf === 0 && pos.y === nowFeet) {
          log(`[collect] Skipping ${block} at ${pos.x},${pos.y},${pos.z} — directly under bot`);
          continue;
        }

        await b.dig(target, true);
        collected++;
        await sleep(200);
      } catch (err) {
        log(`[collect] Error mining ${block} at ${pos.x},${pos.y},${pos.z}: ${err.message}`);
      }
    }

    // Auto-pickup: walk through nearby drops to collect them
    await sleep(600);
    for (let attempt = 0; attempt < 3; attempt++) {
      const drops = Object.values(b.entities)
        .filter(e => (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(b.entity.position) < 12)
        .sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position));
      if (drops.length === 0) break;
      for (const drop of drops.slice(0, 6)) {
        try {
          if (b.motion) await b.motion.gotoNear(drop.position.x, drop.position.y, drop.position.z, 1);
          await sleep(400);
        } catch {}
      }
    }

    // Report what we actually have now
    const invCount = b.inventory.items().filter(i => i.name === block).reduce((s, i) => s + i.count, 0);
    if (collected === 0) {
      const nearest = safe[0];
      const nearestText = nearest ? ` Nearest candidate was at ${nearest.x},${nearest.y},${nearest.z}.` : '';
      return { result: `Could not mine any ${block}. I found candidates but pathing/digging failed.${nearestText} Try moving closer, looking at the block, or choosing a different resource.` };
    }

    // Smart drop-rate hints for probabilistic drops
    const dropRateHints = {
      grass: 'wheat_seeds drop ~10% of the time from grass',
      tall_grass: 'wheat_seeds drop ~10% of the time from tall_grass',
      fern: 'wheat_seeds drop ~10% of the time from ferns',
    };
    const dropHint = dropRateHints[block.toLowerCase()];
    const remaining = count - collected;
    let msg = remaining > 0
      ? `Mined ${collected} ${block} (${remaining} more needed). Have ${invCount} ${block} in inventory.`
      : `Mined ${collected}/${count} ${block}. Have ${invCount} ${block} in inventory.`;
    if (dropHint) {
      msg += ` Note: ${dropHint}. If no items appeared, keep breaking more — drops are random.`;
    }
    return { result: msg };
  },

  async dig({ x, y, z }) {
    const b = ensureBot();
    const target = b.blockAt(new Vec3(x, y, z));
    if (!target || target.name === 'air' || target.name === 'cave_air') {
      const actual = target ? target.name : 'nothing (out of world)';
      throw new Error(`No mineable block at ${x}, ${y}, ${z} — it's ${actual}. Check coordinates or use mc_perceive(type="nearby") to scan.`);
    }
    // Safety: don't dig the block directly under your feet
    const botPos = b.entity.position;
    const botFeetX = Math.floor(botPos.x);
    const botFeetY = Math.floor(botPos.y) - 1; // block we are standing ON
    const botFeetZ = Math.floor(botPos.z);
    if (x === botFeetX && y === botFeetY && z === botFeetZ) {
      throw new Error(`Refusing to dig block at ${x},${y},${z}: that's the block under my feet. Move aside first with mc_move(action="goto", ...).`);
    }
    await b.tool.equipForBlock(target);
    if (b.entity.position.distanceTo(target.position) > 4.5) {
      if (b.motion) await b.motion.gotoNear(x, y, z, 3);
    }
    await b.dig(target, true);
    return { result: `Mined ${target.name} at ${x}, ${y}, ${z}` };
  },

  async pickup() {
    const b = ensureBot();
    const invBefore = b.inventory.items().reduce((s, i) => s + i.count, 0);

    for (let attempt = 0; attempt < 3; attempt++) {
      const pos = b.entity.position;
      const drops = Object.values(b.entities)
        .filter(e => (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(pos) < 16)
        .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));

      if (drops.length === 0) break;

      for (const drop of drops.slice(0, 8)) {
        try {
          if (b.motion) await b.motion.gotoNear(drop.position.x, drop.position.y, drop.position.z, 1);
          await sleep(400);
        } catch {}
      }
    }

    const invAfter = b.inventory.items().reduce((s, i) => s + i.count, 0);
    const gained = invAfter - invBefore;
    return { result: gained > 0 ? `Picked up ${gained} items.` : 'No items to pick up.' };
  },

  // ── Find blocks ──────────────────────────────────
  async find_blocks({ block, radius = 32, count = 10 }) {
    const b = ensureBot();
    const blockType = mcData.blocksByName[block];
    if (!blockType) throw new Error(`Unknown block "${block}".`);

    const isNonSolid = NON_SOLID_BLOCKS.has(block.toLowerCase());
    const found = fairPlayMode && !isNonSolid
      ? findVisibleBlocksByName(block, { range: Math.min(radius, 24), count })
      : b.findBlocks({
          matching: blockType.id,
          maxDistance: Math.min(radius, 64),
          count,
        }).map((p) => ({ position: { x: p.x, y: p.y, z: p.z }, distance: fmt(b.entity.position.distanceTo(p)) }));

    if (found.length === 0) {
      return {
        result: fairPlayMode && isNonSolid
          ? `No ${block} found within ${radius} blocks. Note: ${block} is a small plant that doesn't show up in line-of-sight scans. Use mc_mine(action="find_blocks", block="${block}") with fair_play off, or search manually.`
          : fairPlayMode
            ? `No visible ${block} in the current view cone. Turn, move, or use mc scene to inspect.`
            : `No ${block} found within ${radius} blocks.`,
        locations: [],
      };
    }

    const locations = found.map((entry) => ({
      x: entry.position.x,
      y: entry.position.y,
      z: entry.position.z,
      distance: entry.distance,
      bearing: entry.bearing,
      sector: entry.sector,
    }));

    return { result: fairPlayMode ? `Found ${found.length} visible ${block}` : `Found ${found.length} ${block}`, locations };
  },

  // ── Find entities ────────────────────────────────
  async find_entities({ type, radius = 32 }) {
    const b = ensureBot();
    const pos = b.entity.position;
    let entities = Object.values(b.entities)
      .filter(e => e !== b.entity && e.position.distanceTo(pos) < radius);

    // Fair play: filter by line-of-sight
    entities = filterEntitiesFairPlay(entities);

    if (type) {
      entities = entities.filter(e =>
        (e.name || '').toLowerCase().includes(type.toLowerCase()) ||
        (e.username || '').toLowerCase().includes(type.toLowerCase()) ||
        (e.displayName || '').toLowerCase().includes(type.toLowerCase())
      );
    }

    entities = entities
      .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
      .slice(0, 20)
      .map(e => ({
        type: e.username || e.name || e.displayName || 'unknown',
        distance: fmt(e.position.distanceTo(pos)),
        position: posObj(e.position),
        health: e.health ?? undefined,
      }));

    return {
      result: `Found ${entities.length} ${type || 'entities'}`,
      locations: entities.map(e => ({ ...e.position, distance: e.distance, type: e.type })),
      entities,
    };
  },

  // ── Command queue management ────────────────────
  async complete_command({ index = 0 }) {
    if (commandQueue.length === 0) return { result: 'No commands in queue.' };
    const pending = commandQueue.filter(c => c.status === 'pending');
    if (index >= pending.length) return { result: 'No pending command at that index.' };
    pending[index].status = 'completed';
    rememberSocialEvent({ actor: pending[index].from, kind: 'completed_command', channel: pending[index].channel || 'direct', message: pending[index].command });
    return { result: `Marked command as completed: "${pending[index].command}"` };
  },

  // ── Crafting ─────────────────────────────────────
  async craft({ item, count = 1 }) {
    const b = ensureBot();
    const itemType = mcData.itemsByName[item];
    if (!itemType) throw new Error(`Unknown item "${item}". Check spelling.`);

    // Find nearby crafting table
    const table = b.findBlock({
      matching: mcData.blocksByName.crafting_table?.id,
      maxDistance: 4,
    });

    // First ask Mineflayer for currently craftable recipes. recipesAll is only
    // used for diagnostics, never as a craft target, because it includes recipes
    // whose ingredients are missing.
    let recipes = b.recipesFor(itemType.id, null, 1, null);
    if ((!recipes || recipes.length === 0) && table) {
      recipes = b.recipesFor(itemType.id, null, 1, table);
    }

    // Try recipes in order — first one with available ingredients wins
    let recipe = null;
    const available = itemCounts(b.inventory.items());
    for (const r of recipes) {
      const required = recipeIngredientCounts(r, mcData, count);
      const missing = Object.entries(required)
        .filter(([name, need]) => need > (available[name] || 0));
      if (missing.length === 0) {
        recipe = r;
        break;
      }
    }

    if (!recipe) {
      const diagnostics = recipes
        .slice(0, 3)
        .map(r => recipeDiagnostics(r, mcData, available, count, Boolean(table)))
        .join(' OR ');
      throw new Error(`Can't craft ${item} x${count}: ${diagnostics}. ${inventoryHint(b.inventory.items())} Collect missing materials first or place a crafting_table within 4 blocks.`);
    }
    const craftTable = (recipe.requiresTable !== false) ? table : null;
    if (recipe.requiresTable !== false && !craftTable) {
      throw new Error(`Can't craft ${item}: recipe needs a crafting_table nearby. Place one within 4 blocks first.`);
    }

    try {
      await b.craft(recipe, count, craftTable || undefined);
    } catch (err) {
      const available = itemCounts(b.inventory.items());
      const diagnostic = recipeDiagnostics(recipe, mcData, available, count, Boolean(table));
      throw new Error(`Failed to craft ${item} x${count}: ${err.message}. ${diagnostic}. ${inventoryHint(b.inventory.items())}`);
    }
    const resultCount = count * (recipe.result?.count || 1);
    return { result: `Crafted ${item} x${resultCount}` };
  },

  async recipes({ item }) {
    const b = ensureBot();
    const itemType = mcData.itemsByName[item];
    if (!itemType) throw new Error(`Unknown item "${item}".`);

    // Try multiple recipe lookup methods
    let recipes = b.recipesFor(itemType.id);
    if (!recipes || recipes.length === 0) {
      // Try with crafting table
      const table = b.findBlock({
        matching: mcData.blocksByName.crafting_table?.id,
        maxDistance: 4,
      });
      if (table) recipes = b.recipesFor(itemType.id, null, 1, table);
    }
    if (!recipes || recipes.length === 0) {
      // Try recipesAll
      try { recipes = b.recipesAll(itemType.id, null, 1); } catch {}
    }
    if (!recipes || recipes.length === 0) {
      return { result: `No crafting recipe for ${item}.`, recipes: [] };
    }

    const formatted = recipes.slice(0, 3).map(r => {
      return {
        ingredients: recipeIngredientCounts(r, mcData, 1),
        needsTable: r.requiresTable !== false,
        makes: r.result?.count || 1,
      };
    });

    return { result: `${formatted.length} recipe(s) for ${item}`, recipes: formatted };
  },

  async smelt({ input, fuel, count = 1 }) {
    const b = ensureBot();
    const furnaceBlock = b.findBlock({
      matching: block => block.name === 'furnace' || block.name === 'lit_furnace',
      maxDistance: 4,
    });
    if (!furnaceBlock) throw new Error('No furnace within 4 blocks. Craft and place a furnace nearby before smelting.');

    const furnace = await b.openFurnace(furnaceBlock);
    const inputItem = b.inventory.items().find(i => i.name === input);
    if (!inputItem) { furnace.close(); throw new Error(`No ${input} in inventory. ${inventoryHint(b.inventory.items())} Collect or pick up ${input} first.`); }

    await furnace.putInput(inputItem.type, null, Math.min(count, inputItem.count));

    if (!furnace.fuelItem()) {
      const fuelNames = ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick'];
      const fuelItem = fuel
        ? b.inventory.items().find(i => i.name === fuel)
        : b.inventory.items().find(i => fuelNames.includes(i.name));
      if (!fuelItem) { furnace.close(); throw new Error(`No fuel available. Need coal, charcoal, planks, logs, or sticks. ${inventoryHint(b.inventory.items())}`); }
      await furnace.putFuel(fuelItem.type, null, Math.min(8, fuelItem.count));
    }

    // Wait briefly then check
    await sleep(Math.min(count * 10000, 30000));
    const output = furnace.outputItem();
    if (output) await furnace.takeOutput();
    furnace.close();

    return { result: output ? `Smelted ${output.name} x${output.count}` : `Smelting in progress. Check furnace later.` };
  },

  // ── Combat ───────────────────────────────────────
  async attack({ target }) {
    const b = ensureBot();
    await reactionDelay();

    // Auto-equip best weapon (single source: combat-data.js)
    await equipBestWeapon(b);

    // Hostile detection via combat-data.js.
    // IMPORTANT: only choose attackable living entities. A generic fallback that
    // includes items can kick the bot with invalid_entity_attacked.
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    const nameOf = (e) => (e.name || e.mobType || e.displayName || '').toLowerCase();
    const distToBot = (e) => b.entity.position.distanceTo(e.position);
    const byDistance = (a, c) => distToBot(a) - distToBot(c);
    const isAttackableLivingEntity = (e) => {
      if (!e?.position) return false;
      const name = nameOf(e);
      if (!name || name === 'item' || name === 'experience_orb') return false;
      if (e.type === 'player') return false;
      return e.type === 'hostile' || e.type === 'mob' || isHostileName(name);
    };
    const attackable = visible.filter(isAttackableLivingEntity);

    let entity;
    const wanted = (target || '').toLowerCase();
    const isGenericTarget = !wanted || wanted === 'hostile' || wanted === 'mob' || wanted === 'entity';

    // Sticky target: if we attacked an entity recently and it's still alive/nearby, keep hitting it
    let sticky = null;
    if (lastAttackTargetId && Date.now() - lastAttackAt < STICKY_TARGET_MS) {
      sticky = attackable.find(e => e.id === lastAttackTargetId && distToBot(e) <= STICKY_TARGET_MAX_DIST && e.isValid !== false);
    }

    if (sticky) {
      entity = sticky;
    } else if (!isGenericTarget) {
      // Prefer exact target type, then substring matches, always nearest first.
      const exact = attackable.filter(e => nameOf(e) === wanted).sort(byDistance);
      const partial = attackable
        .filter(e => nameOf(e) !== wanted && (nameOf(e).includes(wanted) || wanted.includes(nameOf(e))))
        .sort(byDistance);
      entity = exact[0] || partial[0];
    } else {
      // taking_damage has no reliable entity type; hit the nearest attackable
      // living entity, preferably within melee/reactive range.
      entity = attackable.filter(e => distToBot(e) < 8).sort(byDistance)[0]
        || attackable.sort(byDistance)[0];
    }
    if (!entity) {
      const hint = nearbyEntitiesHint(b);
      throw new Error(`No ${target || 'hostile mob'} found nearby. ${hint} Try specifying a different target or explore further.`);
    }

    // Approach and attack
    if (entity.position.distanceTo(b.entity.position) > 3) {
      if (b.motion) await b.motion.gotoNear(entity.position.x, entity.position.y, entity.position.z, 2);
    }
    // Face the entity before attacking — looks natural
    await b.lookAt(entity.position.offset(0, entity.height || 1.6, 0));
    await b.attack(entity);
    lastAttackTargetId = entity.id;
    lastAttackAt = Date.now();
    return { result: `Attacked ${entity.name || target} (${fmt(entity.position.distanceTo(b.entity.position))}m away)` };
  },

  async eat() {
    const b = ensureBot();
    const foods = b.inventory.items().filter(i => mcData.foodsByName?.[i.name]);
    if (foods.length === 0) throw new Error(`No food in inventory. ${inventoryHint(b.inventory.items())} Find animals/crops or ask another agent for food.`);
    foods.sort((a, c) => (mcData.foodsByName[c.name]?.foodPoints || 0) - (mcData.foodsByName[a.name]?.foodPoints || 0));
    await b.equip(foods[0], 'hand');
    await b.consume();
    return { result: `Ate ${foods[0].name}. Health: ${fmt(b.health)}, Food: ${b.food}` };
  },

  // ── Inventory ────────────────────────────────────
  async equip({ item, slot = 'hand' }) {
    const b = ensureBot();
    const invItem = b.inventory.items().find(i => i.name === item);
    if (!invItem) {
      throw new Error(`No ${item} in inventory. ${inventoryHint(b.inventory.items())}`);
    }
    await b.equip(invItem, slot);
    return { result: `Equipped ${item} to ${slot}` };
  },

  async toss({ item, count }) {
    const b = ensureBot();
    const invItem = b.inventory.items().find(i => i.name === item);
    if (!invItem) throw new Error(`No ${item} in inventory. ${inventoryHint(b.inventory.items())}`);
    if (count && count > 0 && count < invItem.count) {
      await b.toss(invItem.type, null, count);
    } else {
      await b.tossStack(invItem);
    }
    return { result: `Tossed ${count || invItem.count} ${item}` };
  },

  // ── Building ─────────────────────────────────────
  async place({ block: blockName, x, y, z }) {
    const b = ensureBot();
    const item = b.inventory.items().find(i => i.name === blockName);
    if (!item) {
      const hint = inventoryHint(b.inventory.items());
      throw new Error(`No ${blockName} in inventory. ${hint} Collect, craft, or pick up ${blockName} first.`);
    }

    const targetPos = new Vec3(x, y, z);
    const existing = b.blockAt(targetPos);
    if (existing && existing.name !== 'air' && existing.name !== 'cave_air') {
      throw new Error(`Can't place ${blockName} at ${x}, ${y}, ${z}: target space is occupied by ${existing.name}. Dig that block first or choose an empty adjacent space.`);
    }

    // Refuse to place where the bot is standing — can't place at your own feet
    const bx = Math.floor(b.entity.position.x);
    const by = Math.floor(b.entity.position.y);
    const bz = Math.floor(b.entity.position.z);
    if (bx === x && bz === z && (by === y || by === y + 1)) {
      throw new Error(`Refusing to place ${blockName} at ${x}, ${y}, ${z}: that's where you're standing. Move aside first with mc_move(action="goto", ...).`);
    }

    await b.equip(item, 'hand');

    // Approach if far
    if (b.entity.position.distanceTo(targetPos) > 4.5) {
      if (b.motion) await b.motion.gotoNear(x, y, z, 3);
    }

    // Find reference block to place against
    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    for (const [dx, dy, dz] of offsets) {
      const ref = b.blockAt(targetPos.offset(dx, dy, dz));
      if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
        // Use _genericPlace instead of placeBlock to avoid blockUpdate timeout
        await b._genericPlace(ref, new Vec3(-dx, -dy, -dz), { swingArm: 'right', forceLook: true });
        // Verify placement actually materialized — _genericPlace can silently fail
        await new Promise(r => setTimeout(r, 200));
        const placed = b.blockAt(targetPos);
        if (!placed || placed.name === 'air' || placed.name === 'cave_air') {
          throw new Error(`Placed ${blockName} at ${x}, ${y}, ${z} but block did not materialize. Retry or choose different coordinates.`);
        }
        return { result: `Placed ${blockName} at ${x}, ${y}, ${z}` };
      }
    }
    throw new Error(`Can't place ${blockName} at ${x}, ${y}, ${z}: no solid adjacent block to place against. Choose an empty space next to/above an existing block, or place a support block first.`);
  },

  async place_fill({ block: blockName, x1, y1, z1, x2, y2, z2, hollow = false }) {
    const b = ensureBot();
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
    const total = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (total > 500) throw new Error(`Area too large (${total} blocks, max 500). Split into smaller fills.`);

    // Build position list, hollow only places outer shell
    const positions = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (hollow) {
            const onEdge = x === minX || x === maxX || y === minY || y === maxY || z === minZ || z === maxZ;
            if (!onEdge) continue;
          }
          positions.push({ x, y, z });
        }
      }
    }

    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    const openPositions = positions.filter(pos => {
      const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
      return !existing || existing.name === 'air' || existing.name === 'cave_air';
    });
    if (openPositions.length === 0) {
      return { result: `No ${blockName} placed: target area is already occupied.` };
    }
    const have = itemCounts(b.inventory.items())[blockName] || 0;
    if (have === 0) {
      throw new Error(`Can't fill with ${blockName}: none in inventory. ${inventoryHint(b.inventory.items())} Collect, craft, or pick up ${blockName} first.`);
    }
    if (have < openPositions.length) {
      throw new Error(`Can't fill ${openPositions.length} open spaces with ${blockName}: only have ${have}. Need ${openPositions.length - have} more, or reduce the fill area.`);
    }

    // Warn if bot is standing inside the fill volume — can't place where you stand
    const bx = Math.floor(b.entity.position.x);
    const by = Math.floor(b.entity.position.y);
    const bz = Math.floor(b.entity.position.z);
    const botInVolume = bx >= minX && bx <= maxX && bz >= minZ && bz <= maxZ && by >= minY && by <= maxY;
    if (botInVolume) {
      const cardinalDirs = [{ dx: 1, dz: 0, name: 'east' }, { dx: -1, dz: 0, name: 'west' }, { dx: 0, dz: 1, name: 'south' }, { dx: 0, dz: -1, name: 'north' }];
      const suggestions = cardinalDirs
        .filter(d => {
          const neighbor = b.blockAt(new Vec3(bx + d.dx, by, bz + d.dz));
          return neighbor && (neighbor.name === 'air' || neighbor.name === 'cave_air');
        })
        .map(d => `${d.name} to (${bx + d.dx}, ${by}, ${bz + d.dz})`);
      const hint = suggestions.length ? ` Move ${suggestions[0]} first.` : ' Step back to a safe position first.';
      return { result: `Refusing to fill: bot is standing inside the target volume at (${bx}, ${by}, ${bz}).${hint}`, _warn: 'bot_in_volume' };
    }

    let placed = 0;
    let noSupport = 0;
    let failed = 0;
    let notMaterialized = 0;
    for (const pos of openPositions) {
      const item = b.inventory.items().find(i => i.name === blockName);
      if (!item) throw new Error(`Out of ${blockName} after placing ${placed}/${openPositions.length}. ${inventoryHint(b.inventory.items())}`);
      await b.equip(item, 'hand');

      if (b.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4.5) {
        try { if (b.motion) await b.motion.gotoNear(pos.x, pos.y, pos.z, 3); } catch {}
      }

      let hadSupport = false;
      for (const [dx, dy, dz] of offsets) {
        const ref = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
        if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
          hadSupport = true;
          try {
            // Use _genericPlace instead of placeBlock to avoid blockUpdate timeout
            await b._genericPlace(ref, new Vec3(-dx, -dy, -dz), { swingArm: 'right', forceLook: true });
            // Verify placement actually materialized — _genericPlace can silently fail
            await new Promise(r => setTimeout(r, 200));
            const placedBlock = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
            if (placedBlock && placedBlock.name !== 'air' && placedBlock.name !== 'cave_air') {
              placed++;
            } else {
              notMaterialized++;
            }
          } catch {
            failed++;
          }
          break;
        }
      }
      if (!hadSupport) noSupport++;
    }
    const details = [];
    if (noSupport) details.push(`${noSupport} skipped: no adjacent support block`);
    if (failed) details.push(`${failed} failed during placement`);
    if (notMaterialized) details.push(`${notMaterialized} did not materialize`);
    const suffix = details.length ? ` (${details.join('; ')})` : '';
    return { result: `Placed ${placed}/${openPositions.length} ${blockName} blocks (${hollow ? 'hollow' : 'solid'})${suffix}` };
  },

  async place_sign({ block: blockName = 'oak_sign', x, y, z, lines = '' }) {
    const b = ensureBot();
    const item = b.inventory.items().find(i => i.name === blockName);
    if (!item) {
      const hint = inventoryHint(b.inventory.items());
      throw new Error(`No ${blockName} in inventory. ${hint} Collect, craft, or pick up ${blockName} first.`);
    }

    const targetPos = new Vec3(x, y, z);
    const existing = b.blockAt(targetPos);
    if (existing && existing.name !== 'air' && existing.name !== 'cave_air') {
      throw new Error(`Can't place sign at ${x}, ${y}, ${z}: target space is occupied by ${existing.name}. Dig that block first or choose an empty adjacent space.`);
    }

    await b.equip(item, 'hand');

    // Approach if far
    if (b.entity.position.distanceTo(targetPos) > 4.5) {
      if (b.motion) await b.motion.gotoNear(x, y, z, 3);
    }

    // Find reference block to place against
    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    for (const [dx, dy, dz] of offsets) {
      const ref = b.blockAt(targetPos.offset(dx, dy, dz));
      if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
        await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
        // Wait a tick for the sign to be placed server-side
        await new Promise(r => setTimeout(r, 150));
        const signBlock = b.blockAt(targetPos);
        if (signBlock && signBlock.name.includes('sign')) {
          const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
          b.updateSign(signBlock, text);
        }
        return { result: `Placed ${blockName} at ${x}, ${y}, ${z}` };
      }
    }
    throw new Error(`Can't place sign at ${x}, ${y}, ${z}: no solid adjacent block to place against. Choose an empty space next to/above an existing block, or place a support block first.`);
  },

  async interact({ x, y, z }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block || block.name === 'air' || block.name === 'cave_air') {
      const actual = block ? block.name : 'nothing (out of world)';
      throw new Error(`Can't interact at ${x}, ${y}, ${z}: target is ${actual}. Use coordinates of an interactable block like chest, door, furnace, bed, or farmland.`);
    }
    if (b.entity.position.distanceTo(block.position) > 4.5) {
      if (b.motion) await b.motion.gotoNear(x, y, z, 2);
    }
    await b.activateBlock(block);
    return { result: `Interacted with ${block.name} at ${x}, ${y}, ${z}` };
  },

  async till({ x, y, z }) {
    const b = ensureBot();
    const target = b.blockAt(new Vec3(x, y, z));
    if (!target) throw new Error(`Can't till at ${x},${y},${z}: out of world.`);
    const tillable = ['grass_block', 'dirt', 'dirt_path', 'rooted_dirt', 'coarse_dirt'];
    if (!tillable.includes(target.name)) {
      throw new Error(`Can't till ${target.name} at ${x},${y},${z}. Tillable blocks: ${tillable.join(', ')}.`);
    }
    const dist = b.entity.position.distanceTo(target.position);
    if (dist > 4.5) {
      if (b.motion) await b.motion.gotoNear(x, y, z, 2);
    } else if (dist < 1.8) {
      // Too close — back up so the hitbox doesn't overlap the block face
      const away = b.entity.position.minus(target.position).normalize().scale(2.5);
      const dest = target.position.plus(away);
      if (b.motion) await b.motion.gotoNear(dest.x, dest.y, dest.z, 1);
    }
    const held = b.heldItem?.name || 'hand';
    if (!held.includes('hoe')) {
      throw new Error(`Tilling failed at ${x},${y},${z}: you are holding ${held}, not a hoe. Equip a hoe first with mc_combat(action="equip", item="stone_hoe").`);
    }
    // Use mineflayer's internal _genericPlace to send block_place packet targeting top face
    await b._genericPlace(target, new Vec3(0, 1, 0), { swingArm: 'right', forceLook: true });
    await sleep(250);
    const after = b.blockAt(new Vec3(x, y, z));
    if (after.name === 'farmland') {
      return { result: `Tilled ${target.name} into farmland at ${x},${y},${z}` };
    }
    throw new Error(`Tilling failed at ${x},${y},${z}. Block is ${after.name}, expected farmland. The block may be obstructed or too far.`);
  },

  async bonemeal({ x, y, z }) {
    const b = ensureBot();
    const target = b.blockAt(new Vec3(x, y, z));
    if (!target) throw new Error(`Can't bonemeal at ${x},${y},${z}: out of world.`);
    const growable = ['wheat', 'carrots', 'potatoes', 'beetroots', 'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'grass_block', 'melon_stem', 'pumpkin_stem', 'sweet_berry_bush', 'cave_vines', 'cave_vines_plant'];
    if (!growable.includes(target.name)) {
      throw new Error(`Can't bonemeal ${target.name} at ${x},${y},${z}. Growable blocks: ${growable.join(', ')}.`);
    }
    const dist = b.entity.position.distanceTo(target.position);
    if (dist > 4.5) {
      if (b.motion) await b.motion.gotoNear(x, y, z, 2);
    } else if (dist < 1.8) {
      const away = b.entity.position.minus(target.position).normalize().scale(2.5);
      const dest = target.position.plus(away);
      if (b.motion) await b.motion.gotoNear(dest.x, dest.y, dest.z, 1);
    }
    const held = b.heldItem?.name || 'hand';
    if (held !== 'bone_meal') {
      throw new Error(`Bonemeal failed at ${x},${y},${z}: you are holding ${held}, not bone_meal. Equip bonemeal first with mc_combat(action="equip", item="bone_meal").`);
    }
    await b._genericPlace(target, new Vec3(0, 1, 0), { swingArm: 'right', forceLook: true });
    await sleep(250);
    return { result: `Used bonemeal on ${target.name} at ${x},${y},${z}` };
  },

  async flatten({ x, y, z }) {
    const b = ensureBot();
    const target = b.blockAt(new Vec3(x, y, z));
    if (!target) throw new Error(`Can't flatten at ${x},${y},${z}: out of world.`);
    const flattenable = ['grass_block', 'dirt', 'podzol', 'mycelium', 'coarse_dirt', 'rooted_dirt'];
    if (!flattenable.includes(target.name)) {
      throw new Error(`Can't flatten ${target.name} at ${x},${y},${z}. Flattenable blocks: ${flattenable.join(', ')}.`);
    }
    const dist = b.entity.position.distanceTo(target.position);
    if (dist > 4.5) {
      if (b.motion) await b.motion.gotoNear(x, y, z, 2);
    } else if (dist < 1.8) {
      const away = b.entity.position.minus(target.position).normalize().scale(2.5);
      const dest = target.position.plus(away);
      if (b.motion) await b.motion.gotoNear(dest.x, dest.y, dest.z, 1);
    }
    const held = b.heldItem?.name || 'hand';
    if (!held.includes('shovel')) {
      throw new Error(`Flatten failed at ${x},${y},${z}: you are holding ${held}, not a shovel. Equip a shovel first with mc_combat(action="equip", item="wooden_shovel").`);
    }
    await b._genericPlace(target, new Vec3(0, 1, 0), { swingArm: 'right', forceLook: true });
    await sleep(250);
    const after = b.blockAt(new Vec3(x, y, z));
    if (after.name === 'dirt_path') {
      return { result: `Flattened ${target.name} into dirt_path at ${x},${y},${z}` };
    }
    throw new Error(`Flatten failed at ${x},${y},${z}. Block is ${after.name}, expected dirt_path. The block may be obstructed or too far.`);
  },

  async ignite({ x, y, z }) {
    const b = ensureBot();
    const target = b.blockAt(new Vec3(x, y, z));
    if (!target) throw new Error(`Can't ignite at ${x},${y},${z}: out of world.`);
    const ignitable = ['netherrack', 'tnt', 'campfire', 'soul_campfire', 'candle', 'white_candle', 'orange_candle', 'magenta_candle', 'light_blue_candle', 'yellow_candle', 'lime_candle', 'pink_candle', 'gray_candle', 'light_gray_candle', 'cyan_candle', 'purple_candle', 'blue_candle', 'brown_candle', 'green_candle', 'red_candle', 'black_candle'];
    if (!ignitable.includes(target.name)) {
      throw new Error(`Can't ignite ${target.name} at ${x},${y},${z}. Ignitable blocks: netherrack, tnt, campfire, candle, etc.`);
    }
    const dist = b.entity.position.distanceTo(target.position);
    if (dist > 4.5) {
      if (b.motion) await b.motion.gotoNear(x, y, z, 2);
    } else if (dist < 1.8) {
      const away = b.entity.position.minus(target.position).normalize().scale(2.5);
      const dest = target.position.plus(away);
      if (b.motion) await b.motion.gotoNear(dest.x, dest.y, dest.z, 1);
    }
    const held = b.heldItem?.name || 'hand';
    if (held !== 'flint_and_steel') {
      throw new Error(`Ignite failed at ${x},${y},${z}: you are holding ${held}, not flint_and_steel. Equip it first with mc_combat(action="equip", item="flint_and_steel").`);
    }
    await b._genericPlace(target, new Vec3(0, 1, 0), { swingArm: 'right', forceLook: true });
    await sleep(250);
    return { result: `Ignited ${target.name} at ${x},${y},${z}` };
  },

  async fish() {
    const b = ensureBot();
    const held = b.heldItem?.name || 'hand';
    if (held !== 'fishing_rod') {
      throw new Error(`Fishing failed: you are holding ${held}, not fishing_rod. Equip it first with mc_combat(action="equip", item="fishing_rod").`);
    }
    // Find water block in front of bot
    const pos = b.entity.position;
    const yaw = b.entity.yaw;
    const pitch = b.entity.pitch;
    const reach = 4;
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = -Math.sin(pitch);
    const dz = -Math.cos(yaw) * Math.cos(pitch);
    let waterBlock = null;
    for (let i = 1; i <= reach * 2; i++) {
      const check = b.blockAt(new Vec3(Math.floor(pos.x + dx * i * 0.5), Math.floor(pos.y + dy * i * 0.5), Math.floor(pos.z + dz * i * 0.5)));
      if (check && (check.name === 'water' || check.name === 'water_cauldron')) {
        waterBlock = check;
        break;
      }
    }
    if (!waterBlock) {
      throw new Error(`Fishing failed: no water found in front of you. Position yourself facing water (within 4 blocks) and try again.`);
    }
    // Cast
    b.activateItem();
    await sleep(500);
    // Wait for bite (playerCollect event means something was caught)
    let caught = null;
    const onCollect = (player, entity) => {
      if (player.username === b.username && entity.name) {
        caught = entity.name;
      }
    };
    b.on('playerCollect', onCollect);
    // Wait up to 30 seconds for a bite
    await sleep(30000);
    b.deactivateItem(); // reel in
    b.removeListener('playerCollect', onCollect);
    await sleep(500);
    if (caught) {
      return { result: `Caught ${caught} while fishing.` };
    }
    return { result: `Fished for 30s but didn't catch anything. Try again or check for open water.` };
  },

  async close_screen() {
    const b = ensureBot();
    if (b.currentWindow) b.closeWindow(b.currentWindow);
    return { result: 'Closed screen.' };
  },

  // ── Utility ───────────────────────────────────
  async chat({ message }) {
    const result = await sendToMcChat(message, { source: "tool" });
    rememberSocialEvent({
      actor: getMyName(), kind: 'sent', channel: 'public',
      message,
      fragments: result.fragments_sent,
    });
    return {
      result: result.fragments_sent === 0
        ? `Message dropped (throttled or empty).`
        : `Sent: ${result.fragments_sent} fragment(s)${result.truncated ? ' [truncated]' : ''}`,
    };
  },

  async wait({ seconds = 5 }) {
    ensureBot();
    await sleep(Math.min(seconds, 60) * 1000);
    return { result: `Waited ${seconds}s` };
  },

  async use() {
    const b = ensureBot();
    await b.activateItem();
    return { result: `Used ${b.heldItem?.name || 'hand'}` };
  },

  async sleep_bed() {
    const b = ensureBot();
    const bed = b.findBlock({
      matching: block => block.name?.includes('bed'),
      maxDistance: 4,
    });
    if (!bed) throw new Error('No bed within 4 blocks.');
    await b.sleep(bed);
    return { result: 'Sleeping...' };
  },

  // ── Sustained Combat ──────────────────────────────
  async fight({ target, retreat_health = 6, duration = 30 }) {
    const b = ensureBot();

    // Auto-equip best weapon (single source: combat-data.js)
    await equipBestWeapon(b);

    // Find target entity
    const hostiles = HOSTILE_NAMES;
    // Fair play: only fight visible entities
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    let entity;
    if (target) {
      entity = visible.find(e => e.name?.includes(target) || e.displayName?.includes(target));
    } else {
      entity = visible.find(e => hostiles.some(h => e.name?.includes(h)) && e.position?.distanceTo(b.entity.position) < 16);
    }
    if (!entity) return { result: `No ${target || 'hostile'} found nearby` };

    const startHealth = b.health;
    let hits = 0, targetName = entity.name || entity.displayName || 'entity';
    const endTime = Date.now() + duration * 1000;

    while (Date.now() < endTime) {
      if (b.health <= retreat_health) {
        const fleePos = b.entity.position.offset(
          -(entity.position.x - b.entity.position.x) * 2, 0,
          -(entity.position.z - b.entity.position.z) * 2
        );
        try { if (b.motion) await b.motion.gotoNear(fleePos.x, fleePos.y, fleePos.z, 2); } catch {}
        const food = b.inventory.items().find(i => mcData.foodsByName?.[i.name]);
        if (food) { await b.equip(food, 'hand'); try { await b.consume(); } catch {} }
        return { result: `Retreated from ${targetName} at ${b.health} HP. ${hits} hits dealt.` };
      }

      if (!entity.isValid) {
        return { result: `Killed ${targetName}! ${hits} hits. Lost ${Math.round(startHealth - b.health)} HP.` };
      }

      const dist = entity.position.distanceTo(b.entity.position);
      if (dist > 3.5) {
        if (b.motion) await b.motion.follow(entity, 2);
        await sleep(300);
        continue;
      }

      if (b.motion) await b.motion.stop();
      await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
      await b.attack(entity);
      hits++;
      await sleep(600);
    }

    return { result: `Fight timeout. ${hits} hits on ${targetName}. Health: ${b.health}` };
  },

  async flee({ distance = 16, from }) {
    const b = ensureBot();
    await reactionDelay();

    const hostiles = HOSTILE_NAMES;

    // Find the fleeing-from entity (for micro-step reactive) or coords fallback or nearest
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    let entity = null;
    let fleeFromPos = null;

    if (from) {
      const fromStr = String(from).toLowerCase().trim();
      const coordMatch = fromStr.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
      if (coordMatch) {
        fleeFromPos = {
          x: parseFloat(coordMatch[1]),
          y: parseFloat(coordMatch[2]),
          z: parseFloat(coordMatch[3])
        };
      } else {
        // Search by name match first, then fall back to nearest non-player entity
        entity = visible.find(e =>
          (e.name || '').toLowerCase().includes(fromStr) ||
          (e.username || '').toLowerCase().includes(fromStr) ||
          (e.mobType || '').toLowerCase().includes(fromStr) ||
          (e.displayName || '').toLowerCase().includes(fromStr)
        );
        if (!entity) {
          // Fallback: nearest non-player entity within 10m (the one hitting us)
          entity = visible
            .filter(e => e.position && b.entity.position.distanceTo(e.position) < 10)
            .sort((a, c) => b.entity.position.distanceTo(a.position) - b.entity.position.distanceTo(c.position))[0];
        }
      }
    }

    if (!entity && !fleeFromPos) {
      // nearest hostile
      const threats = visible.filter(e => hostiles.some(h => (e.name || e.mobType || e.displayName || '').toLowerCase().includes(h)));
      if (threats.length > 0) {
        threats.sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position));
        entity = threats[0];
      }
    }

    if (entity && entity.isValid === false) {
      return { result: 'Hostile gone' };
    }

    // Compute dist / source pos
    let dist = 99;
    let fromX = null, fromZ = null;
    if (entity && entity.position) {
      dist = entity.position.distanceTo(b.entity.position);
      fromX = entity.position.x;
      fromZ = entity.position.z;
    } else if (fleeFromPos) {
      const dxp = b.entity.position.x - fleeFromPos.x;
      const dzp = b.entity.position.z - fleeFromPos.z;
      dist = Math.sqrt(dxp * dxp + dzp * dzp);
      fromX = fleeFromPos.x;
      fromZ = fleeFromPos.z;
    } else {
      return { result: 'Hostile gone' };
    }

    if (dist > 5) {
      return { result: 'Clear of hostile, can transition' };
    }

    if (!fromX || !fromZ) {
      return { result: 'Hostile gone' };
    }

    // Face the threat (so back/strafe are relative to it)
    try {
      if (entity) {
        await b.lookAt(entity.position.offset(0, (entity.height || 1) * 0.75, 0));
      } else if (fleeFromPos) {
        await b.lookAt(new Vec3(fromX, b.entity.position.y + 1.6, fromZ));
      }
    } catch {}

    if (dist < 3) {
      // 1. If hostile < 3m: crouch backstep (sneak+back 200ms) to disengage
      b.setControlState('sneak', true);
      b.setControlState('back', true);
      await sleep(200);
      b.setControlState('sneak', false);
      b.setControlState('back', false);
      try { b.clearControlStates(); } catch {}
      const who = entity ? (entity.name || entity.mobType || from) : (from || 'threat');
      return { result: `Backstepped from ${who} at ${dist.toFixed(1)}m` };
    } else {
      // 2. If hostile 3-5m: strafe away (turn slightly from hostile, strafe sideways 300ms)
      const slight = (Math.random() - 0.5) * 0.8; // +/- ~23deg
      try {
        await b.look(b.entity.yaw + slight, b.entity.pitch || 0);
      } catch {}
      const dir = Math.random() > 0.5 ? 'left' : 'right';
      b.setControlState('sneak', true);
      b.setControlState(dir, true);
      await sleep(300);
      b.setControlState('sneak', false);
      b.setControlState(dir, false);
      try { b.clearControlStates(); } catch {}
      const who = entity ? (entity.name || entity.mobType || from) : (from || 'threat');
      return { result: `Strafed ${dir} away from ${who} (${dist.toFixed(1)}m)` };
    }
  },

  async chat_to({ player, message }) {
    const b = ensureBot();
    // Alias for whisper — use native /tell for true server-side private message
    b.chat(`/tell ${player} ${message}`);
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'whisper', message });
    return { result: `[→${player}]: ${message}` };
  },

  async whisper({ player, message }) {
    const b = ensureBot();
    b.chat(`/tell ${player} ${message}`);
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'whisper', message });
    return { result: `[→${player}]: ${message}` };
  },

  // ── Death Recovery ────────────────────────────────
  async deathpoint() {
    if (!lastDeath) return { result: 'No deaths recorded.' };
    const pos = lastDeath.position;
    const age = Math.round((Date.now() - lastDeath.time) / 1000);
    const b = ensureBot();
    if (b.motion) await b.motion.gotoNear(pos.x, pos.y, pos.z, 3);
    return { result: `At death #${lastDeath.deathNumber} (${age}s ago). Lost: ${lastDeath.inventory.map(i=>`${i.name}x${i.count}`).join(', ')}` };
  },

  // ── Container Interaction ─────────────────────────
  async list_container({ x, y, z }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) return { result: 'No block at those coordinates' };
    if (b.entity.position.distanceTo(block.position) > 4.5)
      if (b.motion) await b.motion.gotoNear(x, y, z, 3);
    const chest = await b.openContainer(block);
    const items = chest.containerItems();
    const summary = items.length > 0 ? items.map(i => `${i.name}x${i.count}`).join(', ') : '(empty)';
    chest.close();
    return { result: `Container: ${summary}` };
  },

  async deposit({ x, y, z, item, count }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) return { result: 'No block there' };
    if (b.entity.position.distanceTo(block.position) > 4.5)
      if (b.motion) await b.motion.gotoNear(x, y, z, 3);
    const chest = await b.openContainer(block);
    const invItem = b.inventory.items().find(i => i.name.includes(item));
    if (!invItem) { chest.close(); return { result: `No ${item} in inventory` }; }
    const qty = count && count > 0 ? Math.min(count, invItem.count) : invItem.count;
    await chest.deposit(invItem.type, null, qty);
    chest.close();
    return { result: `Deposited ${qty} ${invItem.name}` };
  },

  async withdraw({ x, y, z, item, count }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) return { result: 'No block there' };
    if (b.entity.position.distanceTo(block.position) > 4.5)
      if (b.motion) await b.motion.gotoNear(x, y, z, 3);
    const chest = await b.openContainer(block);
    const chestItem = chest.containerItems().find(i => i.name.includes(item));
    if (!chestItem) { chest.close(); return { result: `No ${item} in container` }; }
    const qty = count && count > 0 ? Math.min(count, chestItem.count) : chestItem.count;
    await chest.withdraw(chestItem.type, null, qty);
    chest.close();
    return { result: `Withdrew ${qty} ${chestItem.name}` };
  },

  // ── Coordinate Memory ────────────────────────────
  async mark({ name, note }) {
    const b = ensureBot();
    const pos = posObj();
    const locs = loadLocations();
    locs[name] = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
      note: note || '', saved: new Date().toISOString() };
    saveLocations(locs);
    return { result: `Saved '${name}' at ${locs[name].x}, ${locs[name].y}, ${locs[name].z}` };
  },
  async marks() {
    const b = ensureBot();
    const locs = loadLocations();
    const entries = Object.entries(locs);
    if (!entries.length) return { result: 'No saved locations' };
    const pos = b.entity.position;
    const lines = entries.map(([name, l]) => {
      const dist = Math.round(Math.sqrt((pos.x-l.x)**2+(pos.y-l.y)**2+(pos.z-l.z)**2));
      return `${name}: ${l.x},${l.y},${l.z} (${dist}m)${l.note ? ' — '+l.note : ''}`;
    });
    return { result: lines.join('\n') };
  },
  async go_mark({ name }) {
    const locs = loadLocations();
    if (!locs[name]) return { result: `No location '${name}'` };
    const l = locs[name];
    const b = ensureBot();
    if (b.motion) await b.motion.gotoNear(l.x, l.y, l.z, 2);
    return { result: `Arrived at '${name}' (${l.x},${l.y},${l.z})` };
  },
  async unmark({ name }) {
    const locs = loadLocations();
    if (!locs[name]) return { result: `No location '${name}'` };
    delete locs[name];
    saveLocations(locs);
    return { result: `Deleted '${name}'` };
  },

  // ═══════════════════════════════════════════════════════════════
  // Advanced Combat — sneaking, shields, bows, crits, combos
  // ═══════════════════════════════════════════════════════════════

  async sneak({ enable = true }) {
    const b = ensureBot();
    b.setControlState('sneak', !!enable);
    isSneaking = !!enable;
    return { result: enable ? 'Sneaking — nameplate hidden, reduced detection range' : 'Stopped sneaking' };
  },

  async shield_block({ duration = 3 }) {
    const b = ensureBot();
    // Check for shield in offhand
    const shield = b.inventory.items().find(i => i.name === 'shield');
    if (!shield) throw new Error('No shield in inventory. Craft one first (1 iron + 6 planks).');
    
    // Equip to offhand if not already there
    if (!b.inventory.slots[45] || b.inventory.slots[45].name !== 'shield') {
      await b.equip(shield, 'off-hand');
    }
    
    // Activate shield (right-click = use = block)
    b.activateItem(true); // true = offhand
    const blockTime = Math.min(duration, 10) * 1000;
    await sleep(blockTime);
    b.deactivateItem();
    return { result: `Blocked with shield for ${duration}s` };
  },

  async shoot({ target, predict = true }) {
    const b = ensureBot();
    await reactionDelay();
    
    // Find and equip bow
    const bow = b.inventory.items().find(i => i.name === 'bow' || i.name === 'crossbow');
    if (!bow) throw new Error('No bow/crossbow in inventory.');
    const arrows = b.inventory.items().find(i => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow');
    if (!arrows) throw new Error('No arrows in inventory.');
    await b.equip(bow, 'hand');
    
    // Find target entity
    let entity;
    if (target) {
      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      entity = visible.find(e =>
        (e.name || '').toLowerCase().includes(target.toLowerCase()) ||
        (e.username || '').toLowerCase().includes(target.toLowerCase())
      );
    } else {
      const hostiles = HOSTILE_NAMES;
      const rawEnts = Object.values(b.entities).filter(e => 
        e !== b.entity && hostiles.some(h => (e.name || '').includes(h)));
      const visible = filterEntitiesFairPlay(rawEnts);
      entity = visible.sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0];
    }
    if (!entity) throw new Error(`No ${target || 'target'} visible.`);
    
    // Calculate aim point (predict movement for leading shots)
    let aimPoint = entity.position.offset(0, entity.height * 0.6, 0);
    if (predict && entity.velocity) {
      const dist = entity.position.distanceTo(b.entity.position);
      const flightTime = dist / 30; // arrows travel ~30 blocks/sec
      aimPoint = aimPoint.offset(
        entity.velocity.x * flightTime * 20,
        entity.velocity.y * flightTime * 20 + 0.05 * dist, // gravity compensation
        entity.velocity.z * flightTime * 20
      );
    }
    
    await b.lookAt(aimPoint);
    // Charge bow (full charge = 1 second for bow)
    b.activateItem();
    await sleep(bow.name === 'crossbow' ? 1250 : 1000);
    b.deactivateItem();
    
    return { result: `Shot ${bow.name} at ${entity.name || target} (${fmt(entity.position.distanceTo(b.entity.position))}m)` };
  },

  async sprint_attack({ target }) {
    const b = ensureBot();
    await reactionDelay();
    
    // Auto-equip best weapon (single source: combat-data.js)
    await equipBestWeapon(b);
    
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    const entity = target
      ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
      : visible.filter(e => ['zombie','skeleton','spider','slime','magma_cube','creeper','player'].some(h => (e.name || '').includes(h)))
               .sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0];
    if (!entity) throw new Error(`No ${target || 'target'} visible.`);
    
    // Sprint toward and attack — extra knockback on first sprint hit
    b.setControlState('sprint', true);
    if (entity.position.distanceTo(b.entity.position) > 3.5) {
      if (b.motion) await b.motion.gotoNear(entity.position.x, entity.position.y, entity.position.z, 2);
    }
    await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
    await b.attack(entity);
    b.setControlState('sprint', false);
    
    return { result: `Sprint-attacked ${entity.name || target}! (extra knockback)` };
  },

  async critical_hit({ target }) {
    const b = ensureBot();
    await reactionDelay();
    
    // Auto-equip best weapon (single source: combat-data.js)
    await equipBestWeapon(b);
    
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    const entity = target
      ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
      : visible.filter(e => e.position.distanceTo(b.entity.position) < 6).sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0];
    if (!entity) throw new Error(`No ${target || 'target'} visible within range.`);
    
    // Approach
    if (entity.position.distanceTo(b.entity.position) > 3.5) {
      if (b.motion) await b.motion.gotoNear(entity.position.x, entity.position.y, entity.position.z, 2);
    }
    
    // Jump + attack on the way down = critical hit (150% damage)
    b.setControlState('jump', true);
    await sleep(200); // apex of jump
    b.setControlState('jump', false);
    await sleep(150); // falling down
    await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
    await b.attack(entity);
    
    return { result: `Critical hit on ${entity.name || target}! (150% damage, star particles)` };
  },

  async strafe({ target, direction = 'random', duration = 5 }) {
    const b = ensureBot();
    await reactionDelay();
    
    // Auto-equip best weapon (single source: combat-data.js)
    await equipBestWeapon(b);
    
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    const entity = target
      ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
      : visible.filter(e => e.position.distanceTo(b.entity.position) < 8)[0];
    if (!entity) throw new Error(`No ${target || 'target'} visible.`);
    
    let hits = 0;
    const endTime = Date.now() + Math.min(duration, 15) * 1000;
    const dir = direction === 'random' ? (Math.random() > 0.5 ? 'left' : 'right') : direction;
    
    while (Date.now() < endTime && entity.isValid) {
      if (b.health <= 6) return { result: `Strafing stopped — low HP (${b.health}). ${hits} hits.` };
      
      // Strafe: move perpendicular to target
      const dx = entity.position.x - b.entity.position.x;
      const dz = entity.position.z - b.entity.position.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
      
      // Perpendicular direction
      const perpX = dir === 'left' ? -dz/dist : dz/dist;
      const perpZ = dir === 'left' ? dx/dist : -dx/dist;
      
      await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
      
      // Move toward strafe position
      b.setControlState(dir === 'left' ? 'left' : 'right', true);
      b.setControlState(dir === 'left' ? 'right' : 'left', false);
      
      // Attack when in range
      if (dist < 4) {
        await b.attack(entity);
        hits++;
      }
      
      await sleep(500);
    }
    
    // Stop strafing
    b.setControlState('left', false);
    b.setControlState('right', false);
    
    return { result: `Strafed ${dir} around ${entity.name || target}. ${hits} hits in ${duration}s.` };
  },

  async combo({ target, style = 'aggressive' }) {
    const b = ensureBot();
    
    // Find target
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    const entity = target
      ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
      : visible.filter(e => e.position.distanceTo(b.entity.position) < 16)[0];
    if (!entity) throw new Error(`No ${target || 'target'} visible.`);
    const tName = entity.name || entity.username || target || 'target';
    
    const results = [];
    try {
      switch (style) {
        case 'aggressive':
          results.push((await ACTIONS.sprint_attack({ target: tName })).result);
          await sleep(600);
          results.push((await ACTIONS.critical_hit({ target: tName })).result);
          await sleep(600);
          results.push((await ACTIONS.critical_hit({ target: tName })).result);
          if (b.inventory.items().find(i => i.name === 'shield')) {
            await sleep(200);
            results.push((await ACTIONS.shield_block({ duration: 1 })).result);
          }
          break;
        case 'defensive':
          if (b.inventory.items().find(i => i.name === 'shield')) {
            results.push((await ACTIONS.shield_block({ duration: 2 })).result);
          }
          results.push((await ACTIONS.critical_hit({ target: tName })).result);
          await sleep(300);
          results.push((await ACTIONS.flee({ distance: 6 })).result);
          break;
        case 'ranged':
          results.push((await ACTIONS.shoot({ target: tName, predict: true })).result);
          await sleep(1200);
          results.push((await ACTIONS.shoot({ target: tName, predict: true })).result);
          if (entity.isValid && entity.position.distanceTo(b.entity.position) < 8) {
            results.push((await ACTIONS.sprint_attack({ target: tName })).result);
          }
          break;
        case 'berserker':
          results.push((await ACTIONS.sprint_attack({ target: tName })).result);
          for (let i = 0; i < 3 && entity.isValid && b.health > 4; i++) {
            await sleep(500);
            results.push((await ACTIONS.critical_hit({ target: tName })).result);
          }
          break;
        default:
          throw new Error(`Unknown combo style: ${style}. Use: aggressive, defensive, ranged, berserker`);
      }
    } catch (err) {
      results.push(`Combo interrupted: ${err.message}`);
    }
    
    return { result: `[${style}] ${results.join(' → ')}` };
  },

  // ═══════════════════════════════════════════════════════════════
  // Fire-and-Forget Smelting
  // ═══════════════════════════════════════════════════════════════

  async smelt_start({ input, fuel, count = 1 }) {
    const b = ensureBot();
    const furnaceBlock = b.findBlock({
      matching: block => block.name === 'furnace' || block.name === 'lit_furnace' || block.name === 'blast_furnace' || block.name === 'smoker',
      maxDistance: 4,
    });
    if (!furnaceBlock) throw new Error('No furnace within 4 blocks. Craft and place a furnace nearby before smelting.');

    const furnace = await b.openFurnace(furnaceBlock);
    const inputItem = b.inventory.items().find(i => i.name === input);
    if (!inputItem) { furnace.close(); throw new Error(`No ${input} in inventory. ${inventoryHint(b.inventory.items())} Collect or pick up ${input} first.`); }

    const qty = Math.min(count, inputItem.count, 64);
    await furnace.putInput(inputItem.type, null, qty);

    if (!furnace.fuelItem()) {
      const fuelNames = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick', 'lava_bucket', 'blaze_rod'];
      const fuelItem = fuel
        ? b.inventory.items().find(i => i.name === fuel)
        : b.inventory.items().find(i => fuelNames.includes(i.name));
      if (!fuelItem) { furnace.close(); throw new Error(`No fuel available. Need coal, charcoal, planks, logs, or sticks. ${inventoryHint(b.inventory.items())}`); }
      // Coal smelts 8 items, planks smelt 1.5, coal_block smelts 80
      const fuelPer = fuelItem.name === 'coal_block' ? 80 : fuelItem.name.includes('coal') || fuelItem.name === 'charcoal' ? 8 : fuelItem.name === 'blaze_rod' ? 12 : fuelItem.name === 'lava_bucket' ? 100 : 1.5;
      const fuelNeeded = Math.ceil(qty / fuelPer);
      await furnace.putFuel(fuelItem.type, null, Math.min(fuelNeeded, fuelItem.count));
    }

    furnace.close();

    // Track this furnace for later retrieval
    const fp = furnaceBlock.position;
    const eta = Date.now() + qty * 10000; // 10s per item
    activeFurnaces.push({
      x: fp.x, y: fp.y, z: fp.z,
      input, count: qty, startTime: Date.now(), estimatedDone: eta,
    });

    const minutes = Math.ceil(qty * 10 / 60);
    return { result: `Loaded ${qty} ${input} into furnace at ${fp.x},${fp.y},${fp.z}. ETA: ~${minutes} min. Go do something else!` };
  },

  async furnace_check({ x, y, z }) {
    const b = ensureBot();
    const furnaceBlock = b.blockAt(new Vec3(x, y, z));
    if (!furnaceBlock || (!furnaceBlock.name.includes('furnace') && furnaceBlock.name !== 'smoker' && furnaceBlock.name !== 'blast_furnace'))
      throw new Error(`No furnace at ${x},${y},${z}`);

    if (b.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
      if (b.motion) await b.motion.gotoNear(x, y, z, 3);
    }
    const furnace = await b.openFurnace(furnaceBlock);
    const inputItem = furnace.inputItem();
    const fuelItem = furnace.fuelItem();
    const outputItem = furnace.outputItem();
    furnace.close();

    return {
      result: `Furnace at ${x},${y},${z}: ` +
        `Input: ${inputItem ? `${inputItem.name} x${inputItem.count}` : 'empty'} | ` +
        `Fuel: ${fuelItem ? `${fuelItem.name} x${fuelItem.count}` : 'empty'} | ` +
        `Output: ${outputItem ? `${outputItem.name} x${outputItem.count}` : 'empty'} | ` +
        `Status: ${outputItem ? 'output ready!' : inputItem ? 'smelting...' : 'idle'}`,
      ready: !!outputItem,
      output: outputItem ? { name: outputItem.name, count: outputItem.count } : null,
    };
  },

  async furnace_take({ x, y, z }) {
    const b = ensureBot();
    const furnaceBlock = b.blockAt(new Vec3(x, y, z));
    if (!furnaceBlock) throw new Error(`No block at ${x},${y},${z}`);

    if (b.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
      if (b.motion) await b.motion.gotoNear(x, y, z, 3);
    }
    const furnace = await b.openFurnace(furnaceBlock);
    const output = furnace.outputItem();
    if (!output) { furnace.close(); return { result: 'Furnace has no output ready yet.' }; }
    await furnace.takeOutput();
    
    // Also grab remaining input if smelting is done
    const remaining = furnace.inputItem();
    furnace.close();

    // Remove from active furnaces tracking
    activeFurnaces = activeFurnaces.filter(f => !(f.x === x && f.y === y && f.z === z));

    return { result: `Collected ${output.name} x${output.count} from furnace.${remaining ? ` (${remaining.count} ${remaining.name} still being smelted)` : ''}` };
  },

  // ═══════════════════════════════════════════════════════════════
  // Team System — communication, coordination
  // ═══════════════════════════════════════════════════════════════

  async team_chat({ message }) {
    const b = ensureBot();
    if (!teamConfig.team) throw new Error('Not assigned to a team. Use /action/set_team first.');
    
    // Send to all teammates via /tell
    for (const mate of teamConfig.teammates) {
      b.chat(`/tell ${mate} [${teamConfig.team.toUpperCase()}] ${message}`);
      await sleep(100); // avoid spam throttle
    }
    teamConfig.teamChat.push({ time: Date.now(), from: config.mc.username, message });
    if (teamConfig.teamChat.length > 50) teamConfig.teamChat.shift();
    return { result: `[${teamConfig.team}] Sent to ${teamConfig.teammates.length} teammates: ${message}` };
  },

  async team_status() {
    const b = ensureBot();
    if (!teamConfig.team) return { result: 'Not on a team.' };
    
    // Find teammates that are visible
    const teammates = [];
    for (const name of teamConfig.teammates) {
      const entity = Object.values(b.entities).find(e => e.username === name);
      if (entity) {
        teammates.push({
          name,
          distance: fmt(entity.position.distanceTo(b.entity.position)),
          position: posObj(entity.position),
          health: entity.health ?? '?',
        });
      } else {
        teammates.push({ name, distance: '?', position: 'not visible', health: '?' });
      }
    }
    
    return {
      result: `Team ${teamConfig.team.toUpperCase()} | Role: ${teamConfig.role} | Rally: ${teamConfig.rallyPoint ? `${teamConfig.rallyPoint.x},${teamConfig.rallyPoint.y},${teamConfig.rallyPoint.z}` : 'none'}`,
      teammates,
    };
  },

  async rally({ x, y, z, message }) {
    const b = ensureBot();
    if (!teamConfig.team) throw new Error('Not on a team.');
    teamConfig.rallyPoint = { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
    
    // Announce to team
    const msg = message || `Rally at ${teamConfig.rallyPoint.x},${teamConfig.rallyPoint.y},${teamConfig.rallyPoint.z}!`;
    for (const mate of teamConfig.teammates) {
      b.chat(`/tell ${mate} [RALLY] ${msg}`);
      await sleep(100);
    }
    return { result: `Rally point set and announced to team: ${msg}` };
  },

  async report({ message }) {
    const b = ensureBot();
    if (!teamConfig.team) throw new Error('Not on a team.');
    const pos = posObj();
    const fullMsg = `[INTEL] ${message} (at ${pos.x},${pos.y},${pos.z})`;
    for (const mate of teamConfig.teammates) {
      b.chat(`/tell ${mate} ${fullMsg}`);
      await sleep(100);
    }
    return { result: `Report sent to team: ${fullMsg}` };
  },

  async set_team({ team, role, teammates }) {
    teamConfig.team = team;
    teamConfig.role = role || 'warrior';
    teamConfig.teammates = teammates || [];
    return { result: `Assigned to team ${team} as ${role}. Teammates: ${teammates?.join(', ') || 'none'}` };
  },

  // ──────────────────────────────────────────────────────────────────
  // Screenshot — Prismarine-viewer + Puppeteer (replaces mine-photo)
  // ──────────────────────────────────────────────────────────────────

  async screenshot({ width = 1280, height = 720, file_name }) {
    ensureBot();
    const viewerPort = config.api.port + 1000;

    // Lazy-init puppeteer browser (reuse across calls)
    if (!viewerBrowser) {
      log('[Screenshot] Launching puppeteer...');
      viewerBrowser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--use-angle=swiftshader',
        ],
      });
    }

    if (!viewerPage) {
      viewerPage = await viewerBrowser.newPage();
      await viewerPage.setViewport({ width, height });
      log(`[Screenshot] Opening viewer at :${viewerPort}...`);
      await viewerPage.goto(`http://localhost:${viewerPort}`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      // Allow WebGL/Three.js to render a few frames
      await new Promise(r => setTimeout(r, 4000));
    }

    await viewerPage.setViewport({ width, height });
    let fname = file_name || `screenshot_${config.mc.username}_${Date.now()}.png`;
    if (!fname.endsWith('.png')) fname += '.png';
    const outPath = path.join(SCREENSHOT_DIR, fname);
    await viewerPage.screenshot({ path: outPath, fullPage: false });
    log(`[Screenshot] Saved ${outPath}`);

    return {
      result: `Screenshot saved: ${outPath}`,
      path: outPath,
      width,
      height,
    };
  },

  // ═══════════════════════════════════════════════════════════════════
  // Planning — Persistent goal & task state
  // ═══════════════════════════════════════════════════════════════════

  async plan({ action, goal, tasks, task_id, status, result, attempt, expected_epoch }) {
    const plan = loadPlan() || { goal: '', tasks: [], epoch: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };

    // Helper to validate epoch for mutating actions
    const validateEpoch = () => {
      if (expected_epoch !== undefined && expected_epoch !== plan.epoch) {
        throw new Error(`STALE_PLAN: expected epoch ${expected_epoch} but current is ${plan.epoch}. Refetch and retry.`);
      }
    };

    if (action === 'set_goal') {
      if (!goal) throw new Error('goal is required for set_goal');
      validateEpoch();
      plan.goal = goal;
      plan.tasks = tasks || [];
      plan.created_at = new Date().toISOString();
      savePlan(plan);
      broadcastDashboard('plan', plan);
      return { result: `Goal set: ${goal} (${plan.tasks.length} tasks)`, epoch: plan.epoch };
    }

    if (action === 'get_plan') {
      if (!plan.goal) return { result: 'No active goal. Use set_goal first.', epoch: plan.epoch };
      const done = plan.tasks.filter(t => t.status === 'done').length;
      const total = plan.tasks.length;
      const active = plan.tasks.find(t => t.status === 'in_progress');
      const lines = [
        `Goal: ${plan.goal}`,
        `Progress: ${done}/${total} tasks done`,
        ...(active ? [`Active: ${active.description}`] : []),
        ...plan.tasks.map((t, i) => {
          const sym = t.status === 'done' ? '✓' : t.status === 'in_progress' ? '→' : t.status === 'blocked' ? '✗' : ' ';
          const att = t.attempts ? ` (attempt ${t.attempts})` : '';
          return `  [${sym}] ${i + 1}. ${t.description}${att}`;
        }),
      ];
      return { result: lines.join('\n'), plan, epoch: plan.epoch };
    }

    if (action === 'update_task') {
      if (task_id == null) throw new Error('task_id is required for update_task');
      validateEpoch();
      const idx = parseInt(task_id);
      if (idx < 0 || idx >= plan.tasks.length) throw new Error(`Invalid task_id ${idx}`);
      if (status) plan.tasks[idx].status = status;
      if (result !== undefined) plan.tasks[idx].result = result;
      if (attempt !== undefined) plan.tasks[idx].attempts = (plan.tasks[idx].attempts || 0) + 1;
      savePlan(plan);
      broadcastDashboard('plan', plan);
      return { result: `Updated task ${idx + 1}: ${plan.tasks[idx].description} → ${status || 'updated'}`, epoch: plan.epoch };
    }

    if (action === 'add_task') {
      if (!goal) throw new Error('goal (task description) is required for add_task');
      validateEpoch();
      plan.tasks.push({ description: goal, status: status || 'pending', attempts: 0 });
      savePlan(plan);
      broadcastDashboard('plan', plan);
      return { result: `Added task: ${goal}`, epoch: plan.epoch };
    }

    if (action === 'remove_task') {
      if (task_id == null) throw new Error('task_id is required for remove_task');
      validateEpoch();
      const idx = parseInt(task_id);
      if (idx < 0 || idx >= plan.tasks.length) throw new Error(`Invalid task_id ${idx}`);
      const removed = plan.tasks.splice(idx, 1)[0];
      savePlan(plan);
      broadcastDashboard('plan', plan);
      return { result: `Removed task: ${removed.description}`, epoch: plan.epoch };
    }

    if (action === 'clear_goal') {
      validateEpoch();
      const emptyPlan = { goal: '', tasks: [], epoch: plan.epoch + 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      savePlan(emptyPlan);
      broadcastDashboard('plan', emptyPlan);
      return { result: 'Goal cleared.', epoch: emptyPlan.epoch };
    }

    throw new Error(`Unknown plan action: ${action}`);
  },

  // ═══════════════════════════════════════════════════════════════════
  // Fair Play Toggle
  // ═══════════════════════════════════════════════════════════════════

  async set_fair_play({ enabled }) {
    fairPlayMode = !!enabled;
    return { result: `Fair play mode: ${fairPlayMode ? 'ON (LOS, sound, reaction delay)' : 'OFF (god-mode perception)'}` };
  },
};

// ═══════════════════════════════════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════════════════════════════════

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function respond(res, status, data) {
  if (process.env.BOT_VERBOSE) {
    const methodPath = res._verbose_req || '';
    // Also skip RES for quiet polling endpoints
    if (!res._verbose_quiet) {
      const bodyStr = JSON.stringify(data);
      const snippet = bodyStr.length > 150 ? bodyStr.slice(0, 150) + '…' : bodyStr;
      console.error(`[res] ${new Date().toISOString()} ${methodPath} → ${status} ${snippet}`);
    }
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const httpServer = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${config.api.port}`);
  const path = url.pathname;

  if (process.env.BOT_VERBOSE) {
    res._verbose_req = `${req.method} ${path}`;
    // Skip logging spammy polling endpoints — only log on POST or interesting GETs
    const QUIET_GETS = new Set(['/status', '/health', '/nearby', '/inventory', '/marks', '/bot/status', '/bot/effects', '/bot/gamemode', '/mutex/status', '/events']);
    const isQuiet = req.method === 'GET' && QUIET_GETS.has(path);
    if (isQuiet) res._verbose_quiet = true;
    if (!isQuiet) {
      console.error(`[req] ${new Date().toISOString()} ${req.method} ${path} (${req.socket?.remoteAddress || ''})`);
    }
  }

  try {
    // ── GET endpoints (observation) ──────────────
    if (req.method === 'GET') {
      if (path === '/health' || path === '/') {
        return respond(res, 200, {
          ok: true,
          connected: botReady,
          username: config.mc.username,
          server: `${config.mc.host}:${config.mc.port}`,
        });
      }

      if (path === '/status') {
        return respond(res, 200, { ok: true, data: getFullState() });
      }

      // Simple block check for verify conditions (orchestrator sync_progress)
      if (path === '/block') {
        const params = new URLSearchParams(req.url.split('?')[1] || '');
        const x = parseInt(params.get('x'));
        const y = parseInt(params.get('y'));
        const z = parseInt(params.get('z'));
        if (isNaN(x) || isNaN(y) || isNaN(z)) {
          return respond(res, 400, { ok: false, error: 'Missing x,y,z params' });
        }
        const b = ensureBot();
        const block = b.blockAt(new Vec3(x, y, z));
        return respond(res, 200, {
          ok: true,
          data: {
            x, y, z,
            name: block?.name || 'air',
            solid: block?.boundingBox === 'block',
            physical: block?.physical ?? false,
          }
        });
      }

      // Aliases for /bot/* consistency
      if (path === '/bot/status') {
        return respond(res, 200, { ok: true, data: getFullState() });
      }

      if (path === '/bot/effects') {
        const b = ensureBot();
        const effects = {};
        const effs = b.entity && b.entity.effects;
        if (effs) {
          const entries = effs instanceof Map ? [...effs.entries()] : Object.entries(effs);
          for (const [id, eff] of entries) {
            const effectInfo = mcData && mcData.effects && mcData.effects[id];
            const name = effectInfo ? effectInfo.name : String(id);
            effects[name] = {
              id: eff.id,
              name: name,
              amplifier: eff.amplifier,
              duration: eff.duration,
            };
          }
        }
        return respond(res, 200, { ok: true, data: effects });
      }

      if (path === '/bot/gamemode') {
        const b = ensureBot();
        return respond(res, 200, { ok: true, data: { gamemode: b.game?.gameMode || 'unknown' } });
      }

      // BodyMutex status (Phase 1 reactive runner)
      if (path === '/mutex/status') {
        const s = bodyMutex ? bodyMutex.getStatus() : { mode: 0, owner: null, sinceMs: 0, actionTag: null, atomicDeadline: 0 };
        return respond(res, 200, { ok: true, data: s });
      }

      // Phase 1 Reactive Runner event drain (polled by EventPoller.py every ~200ms)
      // Returns accumulated 'runner_event' emissions and clears the buffer (max 50 kept)
      if (path === '/events') {
        const events = runnerEventBuffer.splice(0, runnerEventBuffer.length);
        return respond(res, 200, { ok: true, data: { events } });
      }

      // ── Agent feedback: single endpoint with full combat/body picture ──
      if (path === '/combat') {
        const mutex = bodyMutex ? bodyMutex.getStatus() : null;
        const nearbyHostiles = [];
        if (bot && bot.entities) {
          for (const [id, e] of Object.entries(bot.entities)) {
            if (e === bot.entity) continue;
            if (e.type !== 'mob' && e.type !== 'hostile') continue;
            const name = (e.name || e.mobType || e.displayName || '').toLowerCase();
            const H = ['zombie','skeleton','creeper','spider','slime','magma_cube','witch','enderman','drowned','phantom'];
            if (H.some(h => name.includes(h))) {
              nearbyHostiles.push({
                type: name,
                distance: bot.entity.position.distanceTo(e.position).toFixed(1),
                position: {
                  x: Math.round(e.position.x),
                  y: Math.round(e.position.y),
                  z: Math.round(e.position.z),
                },
              });
            }
          }
        }
        return respond(res, 200, { ok: true, data: {
          health: bot?.health,
          food: bot?.food,
          holding: bot?.heldItem?.name || 'empty',
          position: bot?.entity ? {
            x: Math.round(bot.entity.position.x),
            y: Math.round(bot.entity.position.y),
            z: Math.round(bot.entity.position.z),
          } : null,
          onGround: bot?.entity?.onGround ?? true,
          mutex: mutex ? { mode: mutex.mode, owner: mutex.owner } : null,
          hostiles: nearbyHostiles,
          lastActions: actionHistory.slice(-5).map(a => ({
            action: a.action,
            status: a.status,
            secondsAgo: ((Date.now() - a.time) / 1000).toFixed(0),
          })),
          currentTask: currentTask ? {
            action: currentTask.action,
            status: currentTask.status,
            secondsAgo: currentTask.started ? ((Date.now() - currentTask.started) / 1000).toFixed(0) : null,
          } : null,
        }});
      }

      // ── Interoception: body-internal state (health, hunger, runner activity) ──
      // Returns a delta snapshot of what the body has been doing.
      // ?since=<ts> filters reflex history to entries after that timestamp.
      // ?detail=true returns full reflex history (capped at 10). Default: summary.
      if (path === '/interoception' || path.startsWith('/interoception?')) {
        const since = parseFloat(url.searchParams.get('since') || '0');
        const detail = url.searchParams.get('detail') === 'true';
        const runnerState = {}; // populated from shared state file below

        try {
          if (fs.existsSync(RUNNER_STATE_PATH) && botReady) {
            const raw = fs.readFileSync(RUNNER_STATE_PATH, 'utf-8');
            const state = JSON.parse(raw);
            const now = Date.now() / 1000;
            const recent = (state.reflex_history || [])
              .filter(r => (r.at || 0) > since);
            const total = recent.length;

            if (total === 0) {
              runnerState.activity = { total: 0, detail: [], summary: '' };
            } else if (detail) {
              runnerState.activity = {
                total: Math.min(total, 100),
                detail: recent.slice(-100).map(r => ({
                  reflex: r.reflex,
                  target: r.target || '',
                  seconds_ago: Math.round(now - (r.at || now)),
                })),
                summary: '',
              };
            } else {
              const last3 = recent.slice(-3).map(r => ({
                reflex: r.reflex,
                target: r.target || '',
                seconds_ago: Math.round(now - r.at),
              }));
              const byType = {};
              for (const r of recent.slice(0, -3)) {
                byType[r.reflex] = (byType[r.reflex] || 0) + 1;
              }
              const summaryParts = Object.entries(byType)
                .map(([k, v]) => `${v}× ${k}`);
              runnerState.activity = {
                total,
                detail: last3,
                summary: summaryParts.join(', '),
              };
            }
            runnerState.active = !!(state.active_reflex &&
              (now - state.last_reflex_at < 5.0));
          }
        } catch (_) { /* runner state file not yet written */ }

        return respond(res, 200, { ok: true, data: {
          body: {
            health: bot?.health,
            food: bot?.food,
            holding: bot?.heldItem?.name || 'empty',
            position: bot?.entity ? {
              x: Math.round(bot.entity.position.x),
              y: Math.round(bot.entity.position.y),
              z: Math.round(bot.entity.position.z),
            } : null,
            on_ground: bot?.entity?.onGround ?? true,
            dimension: bot?.game?.dimension || 'overworld',
          },
          runner: runnerState.activity || { total: 0, detail: [], summary: '' },
          mutex: bodyMutex ? { mode: bodyMutex.getStatus().mode, owner: bodyMutex.getStatus().owner } : null,
        }});
      }

      if (path === '/inventory') {
        return respond(res, 200, { ok: true, data: getInventory() });
      }

      if (path === '/bot/inventory') {
        return respond(res, 200, { ok: true, data: getInventory() });
      }

      if (path === '/nearby') {
        const radius = parseInt(url.searchParams.get('radius') || '32');
        return respond(res, 200, { ok: true, data: getNearby(radius) });
      }

      if (path === '/bot/nearby') {
        const radius = parseInt(url.searchParams.get('radius') || '32');
        return respond(res, 200, { ok: true, data: getNearby(radius) });
      }

      if (path === '/marks') {
        return respond(res, 200, { ok: true, marks: loadLocations() });
      }

      // ASCII top-down map of surroundings
      if (path === '/map') {
        const radius = parseInt(url.searchParams.get('radius') || '16');
        return respond(res, 200, { ok: true, data: generateMap(radius) });
      }

      // Narrative description of what you see (human-readable)
      if (path === '/look') {
        return respond(res, 200, { ok: true, data: generateLookAround() });
      }

      if (path === '/scene') {
        const b = ensureBot();
        const pos = b.entity.position;
        const px = pos.x, py = pos.y, pz = pos.z;

        // tick (game age if available, else timestamp)
        const tick = (b.time && typeof b.time.age === 'number') ? b.time.age : Date.now();

        // position as whole numbers (matches observed usage)
        const position = {
          x: Math.round(px),
          y: Math.round(py),
          z: Math.round(pz),
        };

        // facing: snap yaw to 4 cardinal using Math.round as specified
        let yaw = b.entity.yaw || 0;
        yaw = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (yaw > Math.PI) yaw -= 2 * Math.PI;
        const i = Math.round(yaw / (Math.PI / 2));
        const normI = ((i % 4) + 4) % 4;
        const FACINGS = ['east', 'south', 'west', 'north'];
        const facing = FACINGS[normI];

        // 6-dir cardinal blocks (exactly as specified)
        const DIRS = {
          north: { dx: 0, dy: 0, dz: -1 },
          south: { dx: 0, dy: 0, dz: 1 },
          east:  { dx: 1, dy: 0, dz: 0 },
          west:  { dx: -1, dy: 0, dz: 0 },
          up:    { dx: 0, dy: 1, dz: 0 },
          down:  { dx: 0, dy: -1, dz: 0 },
        };
        const blocks_cardinal = {};
        for (const [dir, d] of Object.entries(DIRS)) {
          const bx = px + d.dx;
          const by = py + d.dy;
          const bz = pz + d.dz;
          const blk = b.blockAt(new Vec3(bx, by, bz));
          const type = blk ? blk.name : 'air';
          const solid = blk ? (blk.boundingBox !== 'empty') : false;
          blocks_cardinal[dir] = { type, solid };
        }

        // entities: self excluded, nearest 5, minimal fields
        const rawEntities = [];
        for (const [id, e] of Object.entries(b.entities || {})) {
          if (e === b.entity || !e.position) continue;
          const dist = pos.distanceTo(e.position);
          const name = e.username || e.name || e.displayName || e.mobType || 'unknown';
          const type = e.type || (e.username ? 'player' : 'mob');
          rawEntities.push({ name, type, distance: Math.round(dist * 10) / 10 });
        }
        rawEntities.sort((a, c) => a.distance - c.distance);
        const entities = rawEntities.slice(0, 5);

        // headroom: consecutive air above (y+1, y+2, ...)
        const bx = Math.floor(px);
        const by = Math.floor(py);
        const bz = Math.floor(pz);
        let headroom_blocks = 0;
        for (let i = 1; i <= 96; i++) {
          const blk = b.blockAt(new Vec3(bx, by + i, bz));
          const isAir = !blk || blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air';
        if (isAir) headroom_blocks++;
          else break;
        }

        // ── blocks_above: what's directly above the bot (y+1, y+2, y+3) ──
        const blocks_above = [];
        for (let i = 1; i <= 3; i++) {
          const ab = b.blockAt(new Vec3(bx, by + i, bz));
          blocks_above.push({
            y: by + i,
            type: ab ? ab.name : 'air',
            solid: ab ? (ab.boundingBox !== 'empty') : false,
          });
        }

        // Surface: headroom to sky + at least 2 cardinal directions open at feet level
        const openCardinals =
          (blocks_cardinal.north && !blocks_cardinal.north.solid ? 1 : 0) +
          (blocks_cardinal.south && !blocks_cardinal.south.solid ? 1 : 0) +
          (blocks_cardinal.east  && !blocks_cardinal.east.solid  ? 1 : 0) +
          (blocks_cardinal.west  && !blocks_cardinal.west.solid  ? 1 : 0);
        const is_surface = headroom_blocks >= 96 && openCardinals >= 2;

        // risks: lava/water at feet level (and eye) in 4 horiz directions
        const risks = [];
        const feetY = Math.floor(py);
        const riskDirs = ['north', 'south', 'east', 'west'];
        for (const dir of riskDirs) {
          const d = DIRS[dir];
          const rx = bx + d.dx;
          const rz = bz + d.dz;
          for (let dy = 0; dy <= 1; dy++) {
            const rblk = b.blockAt(new Vec3(rx, feetY + dy, rz));
            if (rblk && (rblk.name === 'lava' || rblk.name === 'flowing_lava' ||
                         rblk.name === 'water' || rblk.name === 'flowing_water')) {
              risks.push(`${dir}_hazard`);
              break;
            }
          }
        }
        const standBlk = b.blockAt(new Vec3(bx, feetY, bz));
        if (standBlk && (standBlk.name.includes('lava') || standBlk.name.includes('water'))) {
          risks.push('standing_in_fluid');
        }

        const structured = {
          tick,
          position,
          facing,
          blocks_cardinal,
          blocks_above,
          entities,
          risks,
          is_surface,
          headroom_blocks,
        };

        // deterministic narrative (template, no extra fields)
        const x = position.x, y = position.y, z = position.z;
        let narrative = `You are at (${x},${y},${z}) facing ${facing}.`;
        const solidList = [];
        const openDirs = [];
        for (const dir of ['north', 'south', 'east', 'west', 'up']) {
          const info = blocks_cardinal[dir];
          let label = dir;
          if (dir === 'up') label = 'above';
          if (info.solid) {
            solidList.push(`${info.type} ${label}`);
          } else {
            openDirs.push(dir === 'up' ? 'above' : dir);
          }
        }
        if (solidList.length > 0) {
          narrative += ` Solid ${solidList.join(' and ')}`;
        }
        if (openDirs.length > 0) {
          if (solidList.length > 0) narrative += ', ';
          else narrative += ' ';
          const openPhrase = openDirs.length === 1
            ? (openDirs[0] === 'above' ? 'open air above' : `open air to the ${openDirs[0]}`)
            : 'open air to the ' + openDirs.slice(0, -1).join(', ') + ' and ' + openDirs[openDirs.length-1];
          narrative += `${openPhrase}.`;
        } else if (solidList.length > 0) {
          narrative += '.';
        }

        return respond(res, 200, { ok: true, data: { structured, narrative } });
      }

      // Post-action judge — returns the most recent judgeAction() result
      if (path === '/judge/last') {
        return respond(res, 200, { ok: true, data: lastJudge || null });
      }

      // Judge ring buffer — all unconsumed entries (for L4 agent)
      if (path === '/judge/pending') {
        const pending = judgeRing.filter(j => !j.consumed_by_l4);
        return respond(res, 200, { ok: true, data: pending, total_ring: judgeRing.length });
      }

      // Consume judge entries by tick — L4 marks them as read
      if (path === '/judge/consume' && req.method === 'POST') {
        const ticks = body?.ticks || [];
        let consumed = 0;
        for (const j of judgeRing) {
          if (ticks.includes(j.captured_at_tick) && !j.consumed_by_l4) {
            j.consumed_by_l4 = true;
            consumed++;
          }
        }
        return respond(res, 200, { ok: true, consumed, remaining: judgeRing.filter(j => !j.consumed_by_l4).length });
      }

      // Screenshot via prismarine-viewer + puppeteer
      if (path === '/screenshot') {
        const width = parseInt(url.searchParams.get('width') || '1280');
        const height = parseInt(url.searchParams.get('height') || '720');
        const result = await ACTIONS.screenshot({ width, height });
        return respond(res, 200, { ok: true, data: result });
      }

      if (path === '/social') {
        return respond(res, 200, { ok: true, data: { summary: summarizeSocialGraph(socialGraph), recent_events: socialEvents.slice(-20) } });
      }

      if (path === '/chat') {
        const count = parseInt(url.searchParams.get('count') || '20');
        const clear = url.searchParams.get('clear') === 'true';
        const msgs = chatLog.slice(-count);
        if (clear) chatLog.length = 0;
        return respond(res, 200, { ok: true, data: { messages: msgs } });
      }

      if (path === '/overhear') {
        const count = parseInt(url.searchParams.get('count') || '20');
        const msgs = overheardLog.slice(-count);
        return respond(res, 200, { ok: true, data: { messages: msgs } });
      }

      if (path === '/deaths') {
        return respond(res, 200, { ok: true, data: {
          total: deathLog.length,
          last_death: lastDeath ? {
            ...lastDeath,
            seconds_ago: Math.round((Date.now() - lastDeath.time) / 1000),
            items_lost: lastDeath.inventory.map(i => `${i.name}x${i.count}`).join(', ')
          } : null
        }});
      }

      if (path === '/commands') {
        // Get pending commands queued by in-game chat
        const pending = commandQueue.filter(c => c.status === 'pending');
        return respond(res, 200, { ok: true, data: { commands: pending } });
      }

      // ── Execute a server command via bot.chat (requires op) ──
      if (path === '/command' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { command } = JSON.parse(body || '{}');
            if (!command || !command.startsWith('/')) {
              return respond(res, 400, { ok: false, error: 'Missing or invalid command. Must start with /' });
            }
            const b = ensureBot();
            b.chat(command);
            return respond(res, 200, { ok: true, data: { command } });
          } catch (e) {
            return respond(res, 400, { ok: false, error: e.message });
          }
        });
        return;
      }

      if (path === '/scoreboard') {
        // Read a player's score from a scoreboard objective via Mineflayer's native API
        const objective = url.searchParams.get('objective');
        const player = url.searchParams.get('player');
        if (!objective) {
          return respond(res, 400, { ok: false, error: 'Missing objective query param' });
        }
        if (!player) {
          return respond(res, 400, { ok: false, error: 'Missing player query param' });
        }
        const sb = bot.scoreboard?.get?.(objective);
        let score = 0;
        let note = '';
        if (sb) {
          // itemsMap may be a Map or a plain object depending on prismarine-scoreboard version
          let item;
          if (sb.itemsMap instanceof Map) {
            item = sb.itemsMap.get(player);
          } else {
            item = sb.itemsMap[player];
          }
          score = item?.value ?? 0;
        } else {
          // Fallback: query via server command and parse chat response
          note = 'using_command_fallback';
          try {
            const b = ensureBot();
            const cmd = `/scoreboard players get ${player} ${objective}`;
            // Send command and wait for the chat response
            const chatBefore = chatLog.length;
            b.chat(cmd);
            // Wait up to 500ms for the response to appear in chatLog
            await new Promise(r => setTimeout(r, 500));
            const responses = chatLog.slice(chatBefore).filter(m => m.message && m.message.includes(objective));
            for (const resp of responses) {
              // Parse: "[objective] for PLAYER: SCORE"
              const match = resp.message.match(/for\s+\S+:\s*(\d+)/);
              if (match) {
                score = parseInt(match[1], 10);
                note = 'command_ok';
                break;
              }
            }
          } catch {
            note = 'command_failed';
          }
        }
        return respond(res, 200, { ok: true, data: { objective, player, score, note } });
      }

      if (path === '/sounds') {
        return respond(res, 200, { ok: true, data: { sounds: soundEvents.slice(-10) } });
      }

      if (path === '/team') {
        return respond(res, 200, { ok: true, data: teamConfig });
      }

      if (path === '/stats') {
        return respond(res, 200, { ok: true, data: combatStats });
      }

      if (path === '/furnaces') {
        return respond(res, 200, { ok: true, data: { furnaces: activeFurnaces.map(f => ({
          ...f,
          eta_seconds: f.estimatedDone ? Math.max(0, Math.round((f.estimatedDone - Date.now()) / 1000)) : null,
        })) } });
      }

      if (path === '/plan') {
        const plan = loadPlan();
        if (!plan || !plan.goal) {
          return respond(res, 200, { ok: true, data: { goal: null, tasks: [] } });
        }
        return respond(res, 200, { ok: true, data: plan });
      }

      if (path === '/actions') {
        return respond(res, 200, { ok: true, data: { actions: actionHistory.slice(-50) } });
      }

      if (path === '/agent/log') {
        return respond(res, 200, { ok: true, data: { turns: agentLog.slice(-50) } });
      }

      if (path === '/task') {
        // Check background task status
        if (!currentTask) return respond(res, 200, { ok: true, data: { task: null }, state: briefState() });
        const elapsed = Math.round((Date.now() - currentTask.started) / 1000);
        return respond(res, 200, { ok: true, data: { task: { ...currentTask, elapsed_s: elapsed } }, state: briefState() });
      }

      if (path === '/dashboard') {
        const htmlPath = new URL('dashboard.html', import.meta.url).pathname;
        try {
          let html = fs.readFileSync(htmlPath, 'utf8');
          html = html.replace('<span id="bot-name">Bot</span>', `<span id="bot-name">${config.mc.username}</span>`);
          res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
          return res.end(html);
        } catch {
          return respond(res, 500, { ok: false, error: 'dashboard.html not found' });
        }
      }

      // Serve static .js files from bot directory
      if (path.endsWith('.js') && path.lastIndexOf('/') === 0) {
        const jsPath = new URL(path.slice(1), import.meta.url).pathname;
        try {
          const content = fs.readFileSync(jsPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' });
          return res.end(content);
        } catch {
          return respond(res, 404, { ok: false, error: 'File not found' });
        }
      }

      if (path === '/mbit') {
        const vizPath = new URL('mbit-viz.html', import.meta.url).pathname;
        try {
          const html = fs.readFileSync(vizPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
          return res.end(html);
        } catch {
          return respond(res, 500, { ok: false, error: 'mbit-viz.html not found' });
        }
      }

      if (path === '/mbit3d') {
        const vizPath = new URL('mbit-viz3d.html', import.meta.url).pathname;
        try {
          const html = fs.readFileSync(vizPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
          return res.end(html);
        } catch {
          return respond(res, 500, { ok: false, error: 'mbit-viz3d.html not found' });
        }
      }

      if (path === '/blueprints') {
        try {
          const files = fs.readdirSync(BLUEPRINTS_DIR).filter(f => f.endsWith('.json'));
          const list = files.map(f => {
            try {
              const raw = fs.readFileSync(`${BLUEPRINTS_DIR}/${f}`, 'utf8');
              const data = JSON.parse(raw);
              return {
                name: f.replace(/\.json$/, ''),
                title: data.metadata?.title || f,
                theme: data.metadata?.theme || '',
                author: data.metadata?.author || '',
                version: data.metadata?.version || '',
              };
            } catch {
              return { name: f.replace(/\.json$/, ''), title: f, theme: '', author: '', version: '' };
            }
          });
          return respond(res, 200, { ok: true, data: { blueprints: list } });
        } catch (err) {
          return respond(res, 500, { ok: false, error: 'Failed to read blueprints: ' + err.message });
        }
      }

      // MC_VERSION_SENSITIVE: 1.21.11
      // Serve the shared validation registry to the dashboard and any consumer.
      if (path === '/registry') {
        if (!MC_REGISTRY) {
          return respond(res, 500, { ok: false, error: 'Registry not loaded' });
        }
        return respond(res, 200, { ok: true, data: MC_REGISTRY });
      }

      // ── Bulk block read (mBit / 16x16x16 chunk) ──
      if (path === '/blocks') {
        const x1 = parseInt(url.searchParams.get('x1'));
        const y1 = parseInt(url.searchParams.get('y1'));
        const z1 = parseInt(url.searchParams.get('z1'));
        const x2 = parseInt(url.searchParams.get('x2'));
        const y2 = parseInt(url.searchParams.get('y2'));
        const z2 = parseInt(url.searchParams.get('z2'));
        if ([x1, y1, z1, x2, y2, z2].some(v => Number.isNaN(v))) {
          return respond(res, 400, { ok: false, error: 'Missing or invalid query params: x1, y1, z1, x2, y2, z2' });
        }
        const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
        const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
        const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
        const MAX_VOLUME = 32768; // 32x32x32 safety cap
        if (volume > MAX_VOLUME) {
          return respond(res, 400, { ok: false, error: `Volume ${volume} exceeds max ${MAX_VOLUME}` });
        }
        const b = ensureBot();
        const t0 = Date.now();
        const blocks = [];
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            for (let x = minX; x <= maxX; x++) {
              const block = b.blockAt(new Vec3(x, y, z));
              const name = block ? block.name : 'unknown';
              const info = mcData ? mcData.blocksByName[name] : null;
              blocks.push({
                x,
                y,
                z,
                name,
                boundingBox: info ? info.boundingBox : (block && block.boundingBox) || 'block',
                transparent: info ? info.transparent : (block && block.transparent) || false,
              });
            }
          }
        }
        // Collect entities within the scanned volume
        const entities = [];
        for (const ent of Object.values(b.entities)) {
          if (!ent.position) continue;
          const ex = Math.floor(ent.position.x);
          const ey = Math.floor(ent.position.y);
          const ez = Math.floor(ent.position.z);
          if (ex >= minX && ex <= maxX && ey >= minY && ey <= maxY && ez >= minZ && ez <= maxZ) {
            entities.push({
              id: ent.id,
              type: ent.type || ent.name || 'unknown',
              name: ent.name || ent.username || ent.displayName || null,
              username: ent.username || null,
              x: ent.position.x,
              y: ent.position.y,
              z: ent.position.z,
              health: ent.health || null,
            });
          }
        }
        const elapsed = Date.now() - t0;
        // mBit format encoding
        const format = url.searchParams.get('format');
        if (format) {
          try {
            const centerX = parseInt(url.searchParams.get('cx')) || undefined;
            const centerY = parseInt(url.searchParams.get('cy')) || undefined;
            const centerZ = parseInt(url.searchParams.get('cz')) || undefined;
            const text = encodeMbit(blocks, format, centerX, centerY, centerZ);
            return respond(res, 200, { ok: true, data: { format, text, count: blocks.length, entities, elapsed_ms: elapsed } });
          } catch (err) {
            return respond(res, 400, { ok: false, error: `mBit encoding error: ${err.message}` });
          }
        }
        return respond(res, 200, { ok: true, data: { blocks, entities, count: blocks.length, elapsed_ms: elapsed } });
      }

      // Serve TTS audio files generated by the gateway adapter
      const ttsMatch = path.match(/^\/tts\/audio\/(.+)$/);
      if (ttsMatch) {
        const filename = ttsMatch[1].replace(/[^a-zA-Z0-9._-]/g, '');
        if (!filename) return respond(res, 400, { ok: false, error: 'Invalid filename' });
        const ttsDir = '/tmp/daemoncraft-tts';
        const filePath = `${ttsDir}/${filename}`;
        // Belt-and-suspenders: ensure the resolved path stays inside ttsDir
        if (!filePath.startsWith(ttsDir + '/')) {
          return respond(res, 400, { ok: false, error: 'Invalid filename' });
        }
        try {
          if (!fs.existsSync(filePath)) {
            return respond(res, 404, { ok: false, error: 'Audio file not found' });
          }
          const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
          const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.ogg' ? 'audio/ogg' : ext === '.opus' ? 'audio/opus' : 'audio/mpeg';
          res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
          const stream = fs.createReadStream(filePath);
          stream.pipe(res);
          return;
        } catch (err) {
          return respond(res, 500, { ok: false, error: 'Failed to serve audio: ' + err.message });
        }
      }

      const blueprintMatch = path.match(/^\/blueprints\/(.+)$/);
      if (blueprintMatch) {
        const name = blueprintMatch[1].replace(/[^a-zA-Z0-9_-]/g, '');
        if (!name) return respond(res, 400, { ok: false, error: 'Invalid blueprint name' });
        const filePath = `${BLUEPRINTS_DIR}/${name}.json`;
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(raw);
          return respond(res, 200, { ok: true, data });
        } catch {
          return respond(res, 404, { ok: false, error: `Blueprint '${name}' not found` });
        }
      }
      // ── Controller Mode — GET /controller/mode ──
      if (path === '/controller/mode') {
        return respond(res, 200, { ok: true, data: { mode: controllerMode } });
      }
    }

    // ── POST endpoints (actions) ────────────────
    if (req.method === 'POST') {
      const body = await parseBody(req);
      if (process.env.BOT_VERBOSE) {
        const snippet = JSON.stringify(body).slice(0, 150);
        console.error(`[req-body] ${new Date().toISOString()} ${snippet}${snippet.length >= 150 ? '…' : ''}`);
      }

      // ── Fase 2: Start quantified intent tracking ──
      if (path === '/executor/start-intent') {
        if (!body || !body.intent_type || !body.target_count) {
          return respond(res, 400, { ok: false, error: 'Missing intent_type or target_count' });
        }
        const payload = {
          intent_type: body.intent_type,
          target_count: parseInt(body.target_count) || 1,
          verify_spec: body.verify_spec || null,
          timestamp: Date.now(),
        };
        fs.writeFileSync(EXECUTOR_INTENT_PATH, JSON.stringify(payload));
        return respond(res, 200, { ok: true, data: payload });
      }

      // ── Fase 3: Submit PlanManifest for orchestration ──
      if (path === '/plan/submit') {
        if (!body || !body.manifest) {
          return respond(res, 400, { ok: false, error: 'Missing manifest' });
        }
        const payload = { manifest: body.manifest, timestamp: Date.now() };
        fs.writeFileSync(PLAN_MANIFEST_PATH, JSON.stringify(payload));
        return respond(res, 200, { ok: true, data: { received: true } });
      }

      // ── Controller Mode — POST /controller/mode ──
      if (path === '/controller/mode') {
        const { mode } = body || {};
        if (!mode || !["lab","autonomous"].includes(mode)) {
          return respond(res, 400, { ok: false, error: 'mode must be "lab" or "autonomous"' });
        }
        controllerMode = mode;
        return respond(res, 200, { ok: true, data: { mode: controllerMode } });
      }

      // Cancel current task
      if (path === '/task/cancel') {
        const b = ensureBot();
        if (b.motion) b.motion.stop().catch(() => {});
        if (currentTask && currentTask.status === 'running') {
          currentTask.status = 'cancelled';
        }
        return respond(res, 200, { ok: true, result: 'Task cancelled.', state: briefState() });
      }

      // Interrupt agent loop LLM turn (not just physical actions)
      if (path === '/agent/interrupt') {
        const b = ensureBot();
        if (b.motion) b.motion.stop().catch(() => {});
        if (currentTask && currentTask.status === 'running') {
          currentTask.status = 'cancelled';
        }
        // Broadcast to all WebSocket clients so agent_loop can abort its LLM turn
        broadcastDashboard('interrupt', { reason: body?.reason || 'gateway_request', time: Date.now() });
        return respond(res, 200, { ok: true, result: 'Agent interrupted.', state: briefState() });
      }

      // ═══════════════════════════════════════════════════════════════
      // BodyMutex endpoints (Phase 1 reactive runner preemption)
      // ═══════════════════════════════════════════════════════════════
      if (path === '/mutex/claim') {
        const { requester = 'unknown', critical = false, actionTag = null, maxMs = null } = body || {};
        if (!bodyMutex) {
          return respond(res, 503, { ok: false, error: 'BodyMutex not initialized (bot not ready)' });
        }
        let result;
        if (critical) {
          result = await bodyMutex.claimCritical(requester, actionTag, maxMs);
        } else {
          result = await bodyMutex.claimYield(requester);
        }
        return respond(res, 200, { ok: true, ...result });
      }

      if (path === '/mutex/release') {
        const { requester = 'unknown' } = body || {};
        if (!bodyMutex) {
          return respond(res, 200, { ok: true, released: false });
        }
        const released = await bodyMutex.release(requester);
        return respond(res, 200, { ok: true, released });
      }

      if (path === '/mutex/emergency_stop') {
        const { requester = 'unknown' } = body || {};
        if (!bodyMutex) {
          return respond(res, 200, { ok: true, previousMode: 0, previousOwner: null });
        }
        const r = await bodyMutex.emergencyStop(requester);
        return respond(res, 200, { ok: true, previousMode: r.previousMode, previousOwner: r.previousOwner });
      }

      if (path === '/action/stop') {
        const { requester = 'unknown' } = body || {};
        try {
          const b = ensureBot();
          if (b.motion && typeof b.motion.stop === 'function') {
            await b.motion.stop().catch(() => {});
          } else {
            try { b.pathfinder.stop(); } catch {} // TODO: route through motion.requestReflex(requester)
            try { b.clearControlStates(); } catch {} // TODO: route through motion.requestReflex(requester)
            try { b.stopDigging(); } catch {}
          }
          if (bodyMutex && typeof bodyMutex.emergencyStop === 'function') {
            // Also escalate to mutex hard stop (records event)
            await bodyMutex.emergencyStop(requester || 'action/stop');
          }
          return respond(res, 200, { ok: true, cancelled: true, requester });
        } catch (e) {
          return respond(res, 200, { ok: true, cancelled: false, error: e.message });
        }
      }

      // Direct plan mutation — POST /plan/update
      // Allows gateway (or any authorized client) to mutate the plan with epoch validation.
      if (path === '/plan/update') {
        const { action, goal, tasks, task_id, status, result, attempt, expected_epoch } = body || {};
        if (!action) {
          return respond(res, 400, { ok: false, error: "Missing 'action' field" });
        }
        try {
          const result = await ACTIONS.plan({ action, goal, tasks, task_id, status, result, attempt, expected_epoch });
          return respond(res, 200, { ok: true, ...result });
        } catch (err) {
          if (err.message?.startsWith('STALE_PLAN')) {
            const current = loadPlan();
            return respond(res, 409, { ok: false, error: err.message, epoch: current?.epoch ?? 0 });
          }
          return respond(res, 400, { ok: false, error: err.message });
        }
      }

      // Agent turn log — POST /agent/log
      if (path === '/agent/log') {
        const turn = body || {};
        agentLog.push({
          turn: turn.turn || 0,
          time: turn.time || Date.now(),
          prompt: turn.prompt || '',
          response: turn.response || '',
          tool_calls: turn.tool_calls || [],
          error: turn.error || null,
        });
        if (agentLog.length > MAX_AGENT_LOG) agentLog.shift();
        broadcastDashboard('agent', agentLog.slice(-50));
        return respond(res, 200, { ok: true });
      }

      // Agent heartbeat — POST /agent/heartbeat
      if (path === '/agent/heartbeat') {
        const hb = body || {};
        log(`[heartbeat] received: nextTurnIn=${hb.nextTurnIn} turnInProgress=${hb.turnInProgress}`);
        agentHeartbeat = {
          nextTurnIn: body.nextTurnIn !== undefined ? body.nextTurnIn : agentHeartbeat.nextTurnIn,
          turnInProgress: body.turnInProgress !== undefined ? body.turnInProgress : agentHeartbeat.turnInProgress,
        };
        broadcastDashboard('heartbeat', agentHeartbeat);
        return respond(res, 200, { ok: true });
      }

      // Heartbeat context — POST /heartbeat/context
      // Receives world-state/perception snapshot from agent_loop and broadcasts
      // it as a WebSocket heartbeat_context event to all connected clients
      // (gateway adapter + dashboard).
      if (path === '/heartbeat/context') {
        const ctx = body || {};
        const payload = {
          timestamp: Date.now(),
          bot_username: config.mc.username,
          status: ctx.status || null,
          nearby: ctx.nearby || null,
          inventory: ctx.inventory || null,
          plan: ctx.plan || null,
          events: ctx.events || [],
          body_session: ctx.body_session || null,
        };
        broadcastDashboard('heartbeat_context', payload);
        // Also send fresh plan snapshot on every heartbeat
        const currentPlan = loadPlan();
        if (currentPlan) broadcastDashboard('plan', currentPlan);
        return respond(res, 200, { ok: true });
      }

      // Embodied activity — POST /dashboard/embodied
      // Receives tool dispatch + plan events from the embodied service and
      // broadcasts them to dashboard clients in real time.
      if (path === '/dashboard/embodied') {
        const evt = body || {};
        evt.timestamp = evt.timestamp || Date.now();
        broadcastDashboard('embodied', evt);
        return respond(res, 200, { ok: true });
      }

      // QuestEngine notification — POST /quest/notify
      // Broadcasts a quest_event to all WebSocket clients (agent loop + dashboard).
      if (path === '/quest/notify') {
        const { message, event_type, from_phase, to_phase } = body || {};
        broadcastDashboard('quest_event', { message, event_type, from_phase, to_phase });
        return respond(res, 200, { ok: true });
      }

      // TTS play request — POST /tts/play
      // Relays audio playback request to all dashboard WebSocket clients.
      if (path === '/tts/play') {
        const { audio_url, chat_id } = body || {};
        if (!audio_url || typeof audio_url !== 'string') {
          return respond(res, 400, { ok: false, error: "missing or invalid 'audio_url'" });
        }
        broadcastDashboard('tts_play', { audio_url, chat_id: chat_id || null });
        return respond(res, 200, { ok: true, result: 'TTS relayed to dashboards.' });
      }

      // Execute a command as the bot and return the server response
      if (path === '/command') {
        let command = body?.command;
        if (!command || typeof command !== 'string') {
          return respond(res, 400, { ok: false, error: 'Missing or invalid "command" field' });
        }
        const b = ensureBot();

        // TP safety check: scan destination before teleporting this bot
        let tpMatch = command.match(/^\/tp\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/);
        let targetPlayer = null;
        let tx, ty, tz;
        if (tpMatch) {
          targetPlayer = tpMatch[1];
          tx = parseFloat(tpMatch[2]);
          ty = parseFloat(tpMatch[3]);
          tz = parseFloat(tpMatch[4]);
        } else {
          const selfTpMatch = command.match(/^\/tp\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/);
          if (selfTpMatch) {
            targetPlayer = b.username;
            tx = parseFloat(selfTpMatch[1]);
            ty = parseFloat(selfTpMatch[2]);
            tz = parseFloat(selfTpMatch[3]);
          }
        }
        if (targetPlayer && targetPlayer.toLowerCase() === b.username.toLowerCase()) {
            const safe = findSafeTeleportSpot(b, tx, ty, tz);
            if (safe === null) {
              return res.status(422).json({ ok: false, error: `TP aborted: destination ${tx} ${ty} ${tz} is solid and no safe spot found within 3 blocks.` });
            }
            if (safe.adjusted) {
              command = `/tp ${targetPlayer} ${safe.x} ${safe.y} ${safe.z}`;
              log(`[TP Safety] Adjusted ${b.username} destination from ${tx} ${ty} ${tz} -> ${safe.x} ${safe.y} ${safe.z}`);
            }
          }

        const responses = [];
        const onMessage = (msg) => {
          const text = msg.toString ? msg.toString() : String(msg);
          if (text) responses.push(text);
        };
        const onSystemChat = (packet) => {
          try {
            let text = '';
            if (typeof packet.content === 'string') {
              const parsed = JSON.parse(packet.content);
              text = parsed.text || (parsed.extra && parsed.extra.map(e => e.text || '').join('')) || '';
            } else if (packet.content) {
              text = packet.content.text || (packet.content.extra && packet.content.extra.map(e => e.text || '').join('')) || '';
            }
            if (text) responses.push(text);
          } catch (e) {
            if (packet.content) responses.push(String(packet.content));
          }
        };
        b.on('message', onMessage);
        b._client.on('system_chat', onSystemChat);
        b.chat(command);

        await new Promise(r => setTimeout(r, 1500));
        b.removeListener('message', onMessage);
        b._client.removeListener('system_chat', onSystemChat);

        return respond(res, 200, {
          ok: true,
          output: responses.join('\n'),
        });
      }

      // Send chat message from agent to Minecraft — POST /chat/send
      // Optional body.as: "Server" | player_name — sends as that identity instead of the bot.
      // Optional body.target: "broadcast" | player_name — destination. Non-broadcast targets are always whispered.
      if (path === '/chat/send') {
        const message = body?.message;
        const sender = body?.as;
        const target = body?.target;
        if (!message || typeof message !== 'string') {
          return respond(res, 400, { ok: false, error: "missing or invalid 'message'" });
        }
        if (message.length > 10_000) {
          return respond(res, 413, { ok: false, error: "message too large" });
        }

        // TP safety: intercept /tp commands sent via chat/send (used by mc_command tool)
        const b = ensureBot();
        let tpMatchChat = message.match(/^\/tp\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/);
        let chatTargetPlayer = null;
        let chtx, chty, chtz;
        if (tpMatchChat) {
          chatTargetPlayer = tpMatchChat[1];
          chtx = parseFloat(tpMatchChat[2]);
          chty = parseFloat(tpMatchChat[3]);
          chtz = parseFloat(tpMatchChat[4]);
        } else {
          const selfTpMatchChat = message.match(/^\/tp\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/);
          if (selfTpMatchChat) {
            chatTargetPlayer = b.username;
            chtx = parseFloat(selfTpMatchChat[1]);
            chty = parseFloat(selfTpMatchChat[2]);
            chtz = parseFloat(selfTpMatchChat[3]);
          }
        }
        if (chatTargetPlayer && chatTargetPlayer.toLowerCase() === b.username.toLowerCase()) {
          const safeChat = findSafeTeleportSpot(b, chtx, chty, chtz);
          if (safeChat === null) {
            return respond(res, 422, { ok: false, error: `TP aborted: destination ${chtx} ${chty} ${chtz} is solid and no safe spot found within 3 blocks.` });
          }
          if (safeChat.adjusted) {
            log(`[TP Safety chat/send] Adjusted ${b.username} destination from ${chtx} ${chty} ${chtz} -> ${safeChat.x} ${safeChat.y} ${safeChat.z}`);
            body.message = `/tp ${chatTargetPlayer} ${safeChat.x} ${safeChat.y} ${safeChat.z}`;
          }
        }

        const botName = b.username;

        if (sender && typeof sender === 'string' && sender.toLowerCase() !== botName.toLowerCase()) {
          // Send as someone else via /say (Server) or /tellraw (custom name)
          let chatFrom = botName;
          if (sender.toLowerCase() === 'server') {
            b.chat('/say ' + message);
            chatFrom = 'Server';
          } else {
            const tellrawCmd = `/tellraw @a ["",{"text":"${sender}: ","color":"yellow","bold":true},{"text":"${message}"}]`;
            b.chat(tellrawCmd);
            chatFrom = sender;
          }
          chatLog.push({
            time: Date.now(),
            from: chatFrom,
            message,
            self: chatFrom.toLowerCase() === botName.toLowerCase(),
            world: b?.game?.dimension || 'unknown',
            uuid: b?.player?.uuid || b?.uuid || null,
          });
          if (chatLog.length > MAX_LOG) chatLog.shift();
          broadcastDashboard('chat', chatLog.slice(-30));
          return respond(res, 200, { ok: true, result: 'Message sent.', from: chatFrom });
        }

        // Gateway-routed messaging: directed whisper or broadcast
        if (target && typeof target === 'string' && target.toLowerCase() !== 'broadcast') {
          // Directed messages are always delivered as whispers
          const result = await sendToMcChat(message, { source: "http", target });
          return respond(res, 200, { ...result, target });
        }

        // Default: broadcast / public chat
        const result = await sendToMcChat(message, { source: "http" });
        return respond(res, 200, result);
      }

      // Save blueprint edits — POST /blueprints/:name
      const bpPostMatch = path.match(/^\/blueprints\/(.+)$/);
      if (bpPostMatch) {
        const name = bpPostMatch[1].replace(/[^a-zA-Z0-9_-]/g, '');
        if (!name) return respond(res, 400, { ok: false, error: 'Invalid blueprint name' });
        const filePath = `${BLUEPRINTS_DIR}/${name}.json`;
        try {
          // Validate: must be valid JSON and have metadata object
          if (!body || typeof body !== 'object') {
            return respond(res, 400, { ok: false, error: 'Body must be a JSON object' });
          }
          if (!body.metadata || typeof body.metadata !== 'object') {
            return respond(res, 400, { ok: false, error: 'Blueprint must have a metadata object' });
          }
          // MC_VERSION_SENSITIVE: 1.21.11
          // Validate hard fields against the shared registry.
          if (MC_REGISTRY) {
            const validBiomes = new Set(MC_REGISTRY.biomes.map(b => b.name));
            if (body.setting?.biome && !validBiomes.has(body.setting.biome)) {
              return respond(res, 400, { ok: false, error: `Invalid biome: '${body.setting.biome}'` });
            }
            const validEntities = new Set(MC_REGISTRY.entities.map(e => e.name));
            if (body.entities) {
              for (const ent of body.entities) {
                if (ent.type && !validEntities.has(ent.type)) {
                  return respond(res, 400, { ok: false, error: `Invalid entity type: '${ent.type}'` });
                }
              }
            }
            const validItems = new Set(MC_REGISTRY.items.map(i => i.name));
            if (body.objects) {
              for (const obj of body.objects) {
                if (obj.type && !validItems.has(obj.type)) {
                  return respond(res, 400, { ok: false, error: `Invalid item type: '${obj.type}'` });
                }
              }
            }
          }
          // Write atomically: stringify first, then write
          const json = JSON.stringify(body, null, 2);
          fs.writeFileSync(filePath, json, 'utf8');
          // Notify all connected dashboard clients and the agent
          broadcastDashboard('blueprint_updated', { name, saved_at: Date.now() });
          return respond(res, 200, { ok: true, result: `Blueprint '${name}' saved.` });
        } catch (err) {
          return respond(res, 500, { ok: false, error: 'Failed to save blueprint: ' + err.message });
        }
      }

      // Background task system: POST /task/ACTION runs async, returns task_id
      const taskMatch = path.match(/^\/task\/(\w+)$/);
      if (taskMatch) {
        const actionName = taskMatch[1];
        const actionFn = ACTIONS[actionName];
        if (!actionFn) {
          const available = Object.keys(ACTIONS).join(', ');
          return respond(res, 400, { ok: false, error: `Unknown action "${actionName}". Available: ${available}` });
        }
        if (currentTask && currentTask.status === 'running') {
          return respond(res, 409, { ok: false, error: `Task "${currentTask.action}" is already running (${Math.round((Date.now() - currentTask.started) / 1000)}s). POST /task/cancel first.`, state: briefState() });
        }
        const taskId = `${actionName}_${Date.now()}`;
        currentTask = { id: taskId, action: actionName, status: 'running', started: Date.now(), result: null, error: null };
        // Fire and forget — runs in background
        actionFn(body).then(result => {
          if (currentTask && currentTask.id === taskId && currentTask.status === 'running') {
            currentTask.status = 'done';
            currentTask.result = result;
          }
          actionHistory.push({ action: actionName, status: 'done', time: Date.now() });
          if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();
          broadcastDashboard('actions', actionHistory.slice(-50));
          broadcastDashboard('task', currentTask);
        }).catch(err => {
          if (currentTask && currentTask.id === taskId && currentTask.status === 'running') {
            currentTask.status = 'error';
            currentTask.error = err.message;
          }
          actionHistory.push({ action: actionName, status: 'error', time: Date.now() });
          if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();
          broadcastDashboard('actions', actionHistory.slice(-50));
          broadcastDashboard('task', currentTask);
        });
        return respond(res, 200, { ok: true, task_id: taskId, status: 'started', state: briefState() });
      }

      // ── Macro endpoint: pre-canned multi-step skills (staircase, spiral, bridge, etc.) ──
      if (path === '/macro') {
        const { macro, direction, target_y, steps_per_side } = body || {};
        if (!macro) return respond(res, 400, { ok: false, error: "Missing 'macro' field. Available: staircase, spiral" });
        const b = ensureBot();

        if (macro === 'staircase') {
          if (!direction || !CARDINAL_DIRS[direction]) {
            return respond(res, 400, { ok: false, error: "Missing or invalid 'direction'. Use: west, east, north, south" });
          }
          if (target_y == null || typeof target_y !== 'number') {
            return respond(res, 400, { ok: false, error: "Missing 'target_y' (number)" });
          }
          try {
            const result = await climbStaircase(b, direction, target_y);
            return respond(res, 200, { ok: true, ...result, state: briefState() });
          } catch (e) {
            return respond(res, 500, { ok: false, error: e.message });
          }
        }

        if (macro === 'spiral') {
          if (target_y == null || typeof target_y !== 'number') {
            return respond(res, 400, { ok: false, error: "Missing 'target_y' (number)" });
          }
          const sps = steps_per_side != null ? parseInt(steps_per_side) : 3;
          try {
            const result = await climbSpiral(b, target_y, sps);
            return respond(res, 200, { ok: true, ...result, state: briefState() });
          } catch (e) {
            return respond(res, 500, { ok: false, error: e.message });
          }
        }

        if (macro === 'tunnel') {
          if (!direction || !CARDINAL_DIRS[direction]) {
            return respond(res, 400, { ok: false, error: "Missing or invalid 'direction'. Use: west, east, north, south" });
          }
          const dist = body.distance != null ? parseInt(body.distance) : 10;
          if (dist <= 0) return respond(res, 400, { ok: false, error: "distance must be positive" });
          try {
            const result = await digTunnel(b, direction, dist);
            return respond(res, 200, { ok: true, ...result, state: briefState() });
          } catch (e) {
            return respond(res, 500, { ok: false, error: e.message });
          }
        }

        return respond(res, 400, { ok: false, error: `Unknown macro '${macro}'. Available: staircase, spiral, tunnel` });
      }

      // Synchronous action: POST /action/ACTION (still supported for quick stuff)
      const actionMatch = path.match(/^\/action\/(\w+)$/);
      if (!actionMatch) {
        // Special: /connect
        if (path === '/connect') {
          await createBot();
          return respond(res, 200, { ok: true, result: 'Connected', state: briefState() });
        }
        return respond(res, 404, { ok: false, error: `Unknown endpoint: ${path}` });
      }

      const actionName = actionMatch[1];
      const actionFn = ACTIONS[actionName];
      if (!actionFn) {
        const available = Object.keys(ACTIONS).join(', ');
        return respond(res, 400, { ok: false, error: `Unknown action "${actionName}". Available: ${available}` });
      }

      // Light ACTION_REGISTRY integration (Phase 3): for 'interaction' category actions
      // (those with maxMs = atomic short ops), claim via BodyMutex before running.
      // Movement/navigation use MotionController session as their claim.
      // Unregistered actions default to preemptible (no explicit claim here).
      let mutexClaimed = false;
      const actionDef = ACTION_REGISTRY[actionName];
      if (actionDef && actionDef.tag === 'atomic' && bodyMutex) {
        // atomic actions claim via BodyMutex (preemptible ones do not)
        const claimResult = await bodyMutex.claimCritical('action:' + actionName, actionName, actionDef.maxMs);
        if (!claimResult.allowed) {
          return respond(res, 423, { ok: false, error: claimResult.reason || 'body busy' });
        }
        mutexClaimed = true;
      }

      actionInProgress = true;
      try {
        // Wrap judgeable actions with judgeAction() for post-action feedback
        const judgeIntents = new Set(['goto', 'gotoNear', 'dig', 'place', 'fill', 'attack', 'collect', 'follow']);
        let result;
        if (judgeIntents.has(actionName)) {
          const intent = {
            action: actionName,
            target: (body.x != null) ? { x: body.x, y: body.y, z: body.z } : null,
            direction: body.direction || null,
            targetY: body.target_y || null,
          };
          // judgeAction runs the action AND captures before/after
          const { judge, value } = await judgeAction(intent, () => actionFn(body));
          result = value;
          if (typeof result === 'object' && result !== null) {
            result._judge = judge;
          }
        } else {
          result = await actionFn(body);
        }
        actionHistory.push({ action: actionName, status: 'done', time: Date.now() });
        if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();
        broadcastDashboard('actions', actionHistory.slice(-50));
        return respond(res, 200, { ok: true, ...result, state: briefState() });
      } finally {
        actionInProgress = false;
        if (mutexClaimed && bodyMutex) {
          try { await bodyMutex.release('action:' + actionName); } catch {}
        }
      }
    }

    respond(res, 404, { ok: false, error: `Not found: ${req.method} ${path}` });

  } catch (err) {
    const status = err.message.includes('not connected') ? 503 : 400;
    respond(res, status, { ok: false, error: err.message, state: briefState() });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Stuck Detection Watchdog
// ═══════════════════════════════════════════════════════════════════
// Position tracking (kept for dashboard state only, no auto-cleanup)
// MotionController owns all pathfinding lifecycle — no watchdog needed.
// ═══════════════════════════════════════════════════════════════════

let positionHistory = [];

// ═══════════════════════════════════════════════════════════════════
// Live Dashboard WebSocket
// ═══════════════════════════════════════════════════════════════════

const dashboardClients = new Set();

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  dashboardClients.add(ws);
  log(`[dashboard] Client connected (${dashboardClients.size} total)`);

  // Send immediate snapshot
  try {
    ws.send(JSON.stringify({ type: 'status', data: getFullState() }));
    ws.send(JSON.stringify({ type: 'plan', data: loadPlan() || { goal: null, tasks: [] } }));
    ws.send(JSON.stringify({ type: 'actions', data: actionHistory.slice(-50) }));
    ws.send(JSON.stringify({ type: 'chat', data: chatLog.slice(-30) }));
    ws.send(JSON.stringify({ type: 'task', data: currentTask || null }));
    ws.send(JSON.stringify({ type: 'agent', data: agentLog.slice(-50) }));
  } catch {}

  ws.on('close', () => {
    dashboardClients.delete(ws);
    log(`[dashboard] Client disconnected (${dashboardClients.size} remaining)`);
  });

  ws.on('error', () => dashboardClients.delete(ws));
});

function broadcastDashboard(type, data) {
  if (dashboardClients.size === 0) return;
  const msg = JSON.stringify({ type, data });
  for (const ws of dashboardClients) {
    try { ws.send(msg); } catch { dashboardClients.delete(ws); }
  }
}

// Periodic status broadcast for live dashboard
setInterval(() => {
  if (dashboardClients.size === 0) return;
  try {
    const state = getFullState();
    broadcastDashboard('status', state);
  } catch {}
}, 2000);

// Ensure torch is always in offhand for lighting
setInterval(async () => {
  try {
    const b = bot;
    if (!b || !b.inventory || !b.entity) return;

    // Already holding torch — nothing to do
    if (b.inventory.slots[45] && b.inventory.slots[45].name === 'torch') return;

    // Find torch in main inventory
    const torch = b.inventory.items().find(item => item.name === 'torch');
    if (!torch) return;

    // Don't replace shield if hostiles are nearby (combat safety)
    const hasShield = b.inventory.slots[45] && b.inventory.slots[45].name === 'shield';
    if (hasShield) {
      const pos = b.entity.position;
      const hostilesNear = Object.values(b.entities).some(e =>
        e !== b.entity &&
        e.position &&
        e.position.distanceTo(pos) < 8 &&
        HOSTILE_NAMES.some(h => (e.name || '').includes(h))
      );
      if (hostilesNear) return;
    }

    await b.equip(torch, 'off-hand');
    log('[offhand] Equipped torch');
  } catch {
    // Ignore equip errors (e.g. mid-action)
  }
}, 5000);

// ═══════════════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════════════

httpServer.listen(config.api.port, () => {
  log(`╔═══════════════════════════════════════╗`);
  log(`║     HermesCraft Bot Server v4.0      ║`);
  log(`╠═══════════════════════════════════════╣`);
  log(`║  API:  http://localhost:${config.api.port}          ║`);
  log(`║  MC:   ${config.mc.host}:${config.mc.port}                ║`);
  log(`║  User: ${config.mc.username.padEnd(28)}║`);
  log(`╚═══════════════════════════════════════╝`);

  // Connect bot
  createBot().catch(e => {
    log(`Initial connection failed: ${e.message}`);
    log('Bot server is running — POST /connect when Minecraft is ready.');
  });
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err}`);
});

// Graceful shutdown: close Chrome/Puppeteer on SIGTERM/SIGINT to prevent zombie processes
function cleanupChrome() {
  log('[Cleanup] Closing Chrome/Puppeteer...');
  try { viewerPage?.close().catch(() => {}); viewerPage = null; } catch {}
  try { viewerBrowser?.close().catch(() => {}); viewerBrowser = null; } catch {}
  try { viewerServer?.close(); viewerServer = null; } catch {}
}

process.on('SIGTERM', () => {
  log('SIGTERM received. Cleaning up...');
  cleanupChrome();
  httpServer.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log('SIGINT received. Cleaning up...');
  cleanupChrome();
  httpServer.close(() => process.exit(0));
});
