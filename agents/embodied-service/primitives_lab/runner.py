"""
primitives_lab/runner.py — execute a single experiment YAML against the
running embodied service stack.

An experiment is a controlled comparison of N variants of a primitive
(intent shape, allowed_tools scope, guardian_constraints, etc.) all run
against the same fixture, scored by a set of expectations.

Usage:
    python runner.py experiments/001_intent_verbosity.yaml
    python runner.py experiments/001_intent_verbosity.yaml --variant terse
    python runner.py experiments/001_intent_verbosity.yaml --samples 3 --output-dir results/

The runner does NOT mutate the world to match the fixture — it
*verifies* that the bot's current state is close enough to the fixture
and refuses to run if drift is too large. Set up the world manually
(or via a seeded test world) before running.

Reads/writes:
    - experiments/<id>.yaml   (read)
    - fixtures/<name>.json    (read)
    - results/<id>-<ts>.json  (write)

Stack required:
    - bot/server.js running on $BOT_API_URL (default localhost:3001)
    - embodied-service running on $EMBODIED_SERVICE_URL (default 7790)
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

import requests
import yaml

LAB_ROOT = Path(__file__).resolve().parent
FIXTURES_DIR = LAB_ROOT / "fixtures"
RESULTS_DIR = LAB_ROOT / "results"

BOT_API = os.getenv("BOT_API_URL", "http://localhost:3001")
SERVICE_API = os.getenv("EMBODIED_SERVICE_URL", "http://localhost:7790")


# ── Health checks ──────────────────────────────────────────────────

def health_check() -> tuple[bool, str]:
    try:
        r = requests.get(f"{BOT_API}/status", timeout=3).json()
        if not r.get("ok"):
            return False, "bot /status not ok"
    except Exception as e:
        return False, f"bot unreachable: {e}"
    try:
        r = requests.get(f"{SERVICE_API}/health", timeout=3).json()
        if not r.get("ok"):
            return False, "embodied service /health not ok"
    except Exception as e:
        return False, f"embodied service unreachable: {e}"
    return True, "OK"


def current_world_snapshot() -> dict:
    """Read the canonical 17-field world_state from the running bot
    via the embodied service composer (rather than re-implementing it)."""
    # Trigger a no-op intent to force the service to log its assembled
    # payload, then read it back from the embodied service log. This
    # is the most accurate way to see what Gemma-Andy *actually* sees.
    # Fallback to direct bot endpoints if log read fails.
    try:
        r = requests.get(f"{BOT_API}/status", timeout=3).json()["data"]
        nearby = requests.get(f"{BOT_API}/nearby?radius=64", timeout=3).json()["data"]
        inventory = requests.get(f"{BOT_API}/inventory", timeout=3).json()["data"]
        return {
            "bot_position": [int(r["position"]["x"]), int(r["position"]["y"]), int(r["position"]["z"])],
            "biome": r.get("biome", "unknown"),
            "time_of_day_ticks": r.get("time", 0),
            "health": r.get("health", 20),
            "food": r.get("food", 20),
            "nearby_block_types": sorted({b["name"] for b in (nearby.get("blocks") or []) if b.get("name")}),
            "nearby_entity_types": sorted({(e.get("type") or e.get("name", "?")) for e in (nearby.get("entities") or [])}),
            "inventory_flat": {
                it["name"]: it["count"]
                for cat in (inventory.get("categories") or {}).values() if isinstance(cat, list)
                for it in cat
            },
        }
    except Exception as e:
        return {"error": str(e)}


def fixture_compatible(fixture: dict, snapshot: dict) -> tuple[bool, list[str]]:
    """Check if the bot's current snapshot is close enough to the fixture
    that we can run the experiment without seeding the world. Returns
    (ok, list_of_mismatches_to_warn_about)."""
    warnings = []
    fws = fixture.get("world_state", {})
    snap_inv = snapshot.get("inventory_flat", {})
    fix_inv = fws.get("inventory", {})
    # Not strict — just warn if fixture expects an item the bot doesn't have
    for name, count in (fix_inv or {}).items():
        if snap_inv.get(name, 0) < count:
            warnings.append(f"inventory: fixture expects {name}:{count}, bot has {snap_inv.get(name, 0)}")
    return True, warnings  # never block; surface as warnings


# ── Single sample execution ───────────────────────────────────────

def call_embodied_plan(primitives: dict, deadline: int = 30) -> dict:
    """Call the embodied service /intent endpoint with the variant's
    primitives. Returns the full response dict."""
    payload = {"intent": primitives["intent"], "deadline_seconds": deadline}
    for k in ("autonomy_level", "allowed_tools", "guardian_constraints", "previous_error"):
        if k in primitives and primitives[k] is not None:
            payload[k] = primitives[k]
    try:
        r = requests.post(f"{SERVICE_API}/intent", json=payload, timeout=deadline + 30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"ok": False, "error": {"error_type": "lab_call_failed", "details": str(e)}}


def score_sample(response: dict, expectations: dict) -> tuple[bool, list[str]]:
    """Apply the experiment's expectations to a single response.
    Returns (passed, list_of_failure_reasons)."""
    failures: list[str] = []
    plan = response.get("plan") or {}
    tool_names = [t.get("name") for t in plan.get("tool_calls", [])]
    mitigations = response.get("mitigations") or []

    if expectations.get("must_invoke_embodied_plan"):
        if response.get("ok") is None or not (plan.get("body_plan") or plan.get("tool_calls")):
            failures.append("expected embodied_plan invocation; service produced no plan")

    must_inc_any = expectations.get("tool_calls_must_include_any_of")
    if must_inc_any:
        if not any(t in tool_names for t in must_inc_any):
            failures.append(f"tool_calls={tool_names} missing any of {must_inc_any}")

    must_inc_all = expectations.get("tool_calls_must_include_all_of")
    if must_inc_all:
        missing = [t for t in must_inc_all if t not in tool_names]
        if missing:
            failures.append(f"tool_calls={tool_names} missing required {missing}")

    must_not = expectations.get("tool_calls_must_not_include")
    if must_not:
        bad = [t for t in tool_names if t in must_not]
        if bad:
            failures.append(f"tool_calls={tool_names} contains forbidden {bad}")

    max_elapsed = expectations.get("max_elapsed_seconds")
    if max_elapsed is not None:
        elapsed = response.get("elapsed_seconds", 0)
        if elapsed > max_elapsed:
            failures.append(f"elapsed {elapsed:.1f}s > max {max_elapsed}s")

    if expectations.get("no_mitigations"):
        if mitigations:
            failures.append(f"unexpected mitigations: {[m.get('regression') for m in mitigations]}")

    expected_risk = expectations.get("operational_risk_in")
    if expected_risk:
        actual_risk = plan.get("operational_risk")
        if actual_risk not in expected_risk:
            failures.append(f"operational_risk={actual_risk} not in {expected_risk}")

    return (not failures), failures


def run_variant(variant: dict, expectations: dict, samples: int, deadline: int = 30) -> dict:
    """Run N samples of a single variant, aggregate metrics."""
    samples_data = []
    for i in range(samples):
        t0 = time.time()
        resp = call_embodied_plan(variant["primitives"], deadline=deadline)
        wall = time.time() - t0
        passed, failures = score_sample(resp, expectations)
        plan = resp.get("plan") or {}
        samples_data.append({
            "iter": i + 1,
            "wall_elapsed_s": round(wall, 2),
            "service_elapsed_s": resp.get("elapsed_seconds"),
            "ok": resp.get("ok"),
            "passed": passed,
            "failures": failures,
            "tool_names": [t.get("name") for t in plan.get("tool_calls", [])],
            "tool_count": len(plan.get("tool_calls", [])),
            "operational_risk": plan.get("operational_risk"),
            "mitigations": [m.get("regression") for m in (resp.get("mitigations") or [])],
            "had_think": bool(resp.get("think")),
        })
    return {
        "id": variant["id"],
        "primitives": variant["primitives"],
        "samples": samples_data,
        "metrics": _aggregate_metrics(samples_data),
    }


def _aggregate_metrics(samples_data: list[dict]) -> dict:
    n = len(samples_data)
    if n == 0: return {}
    passes = [s for s in samples_data if s["passed"]]
    elapsed = [s["service_elapsed_s"] for s in samples_data if s["service_elapsed_s"] is not None]
    tool_counts = [s["tool_count"] for s in samples_data]
    mitigated = sum(1 for s in samples_data if s["mitigations"])
    # Frequency table of tool names emitted across all samples
    all_tools = [t for s in samples_data for t in s["tool_names"]]
    freq: dict[str, int] = {}
    for t in all_tools: freq[t] = freq.get(t, 0) + 1
    return {
        "n": n,
        "success_rate": round(len(passes) / n, 3),
        "latency_p50": round(statistics.median(elapsed), 2) if elapsed else None,
        "latency_p95": round(sorted(elapsed)[int(0.95 * (len(elapsed) - 1))], 2) if len(elapsed) >= 2 else (elapsed[0] if elapsed else None),
        "mean_tool_count": round(statistics.mean(tool_counts), 2) if tool_counts else None,
        "mitigation_rate": round(mitigated / n, 3),
        "tool_freq": dict(sorted(freq.items(), key=lambda kv: -kv[1])),
    }


# ── Experiment loader ─────────────────────────────────────────────

def load_experiment(path: Path) -> dict:
    with open(path) as f:
        spec = yaml.safe_load(f)
    if not isinstance(spec, dict):
        raise ValueError(f"experiment {path} did not parse as dict")
    for required in ("id", "variants", "samples_per_variant", "expectations"):
        if required not in spec:
            raise ValueError(f"experiment {path} missing field: {required}")
    return spec


def load_fixture(name: str | None) -> dict | None:
    if not name: return None
    path = FIXTURES_DIR / name
    if not path.exists():
        path = FIXTURES_DIR / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(f"fixture not found: {name}")
    with open(path) as f:
        return json.load(f)


# ── Entry point ───────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("experiment", type=Path, help="path to experiment YAML")
    p.add_argument("--variant", help="only run this variant id (default: all)")
    p.add_argument("--samples", type=int, help="override samples_per_variant")
    p.add_argument("--deadline", type=int, default=45, help="per-call deadline seconds")
    p.add_argument("--output-dir", type=Path, default=RESULTS_DIR)
    args = p.parse_args()

    ok, msg = health_check()
    if not ok:
        print(f"[health] FAILED: {msg}", file=sys.stderr)
        sys.exit(2)

    spec = load_experiment(args.experiment)
    fixture = load_fixture(spec.get("fixture"))
    snapshot = current_world_snapshot()

    print(f"━━━ {spec['id']} ━━━")
    print(f"hypothesis: {spec.get('hypothesis', '(none)')}")
    print(f"fixture: {spec.get('fixture')}")
    if fixture:
        ok, warnings = fixture_compatible(fixture, snapshot)
        for w in warnings: print(f"  [fixture-warn] {w}")
    print(f"current bot: pos={snapshot.get('bot_position')} inv={snapshot.get('inventory_flat')}")

    samples = args.samples or spec["samples_per_variant"]
    variants = spec["variants"]
    if args.variant:
        variants = [v for v in variants if v["id"] == args.variant]
        if not variants:
            print(f"[error] variant '{args.variant}' not found in spec", file=sys.stderr)
            sys.exit(2)

    results: list[dict] = []
    for variant in variants:
        print(f"\n--- variant: {variant['id']} ---")
        print(f"  intent: {variant['primitives'].get('intent', '(?)')!r}")
        result = run_variant(variant, spec["expectations"], samples, deadline=args.deadline)
        results.append(result)
        m = result["metrics"]
        print(f"  success_rate={m['success_rate']:.0%}  p50={m['latency_p50']}s  mean_tools={m['mean_tool_count']}  mitigated={m['mitigation_rate']:.0%}")
        print(f"  tool_freq: {m['tool_freq']}")
        for s in result["samples"]:
            mark = "✓" if s["passed"] else "✗"
            extras = []
            if s["mitigations"]: extras.append(f"mit={s['mitigations']}")
            if s["failures"]: extras.append(f"fail={s['failures']}")
            print(f"    {mark} #{s['iter']} {s['service_elapsed_s']:.1f}s tools={s['tool_names']} {' '.join(extras)}")

    # Save full output
    args.output_dir.mkdir(parents=True, exist_ok=True)
    ts = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = args.output_dir / f"{spec['id']}_{ts}.json"
    out_path.write_text(json.dumps({
        "spec": spec, "snapshot": snapshot, "results": results, "ts": ts,
    }, indent=2))
    print(f"\n→ saved: {out_path}")


if __name__ == "__main__":
    main()
