"""
primitives_lab/ladder.py — run multiple experiments in sequence,
aggregate cross-experiment summary.

Usage:
    python ladder.py experiments/             # run all *.yaml in dir
    python ladder.py experiments/ --filter "00[12]"  # subset by id glob
    python ladder.py experiments/ --samples 5

Outputs:
    results/ladder_<ts>.json  — per-experiment + cross-summary
    stdout                     — readable progress

The ladder is a thin orchestrator over runner.py. For deeper analysis
the AutoResearcher will eventually consume the per-experiment JSON in
results/ and produce vault-bound lesson pages.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import subprocess
import sys
from pathlib import Path

LAB_ROOT = Path(__file__).resolve().parent
RESULTS_DIR = LAB_ROOT / "results"


def list_experiments(experiments_dir: Path, filter_re: str | None) -> list[Path]:
    paths = sorted(experiments_dir.glob("*.yaml"))
    if filter_re:
        rx = re.compile(filter_re)
        paths = [p for p in paths if rx.search(p.name)]
    return paths


def run_one(path: Path, samples: int | None, deadline: int) -> dict:
    """Run runner.py as subprocess, parse the saved JSON output."""
    cmd = [sys.executable, str(LAB_ROOT / "runner.py"), str(path)]
    if samples is not None:
        cmd += ["--samples", str(samples)]
    cmd += ["--deadline", str(deadline)]
    print(f"\n{'═' * 70}\n▶ {path.name}\n{'═' * 70}")
    completed = subprocess.run(cmd, capture_output=False)
    if completed.returncode != 0:
        return {"path": str(path), "error": f"runner exit {completed.returncode}"}

    # Find the most recent results file matching this experiment id
    spec_id = path.stem.split("_", 1)[0] if "_" in path.stem else path.stem
    candidates = sorted(RESULTS_DIR.glob(f"*{spec_id}*.json"), reverse=True)
    if not candidates:
        return {"path": str(path), "error": "no results file produced"}
    return {"path": str(path), "result_file": str(candidates[0]), "result": json.loads(candidates[0].read_text())}


def cross_summary(runs: list[dict]) -> dict:
    """Aggregate metrics across all experiments for a quick scan."""
    summary = []
    for run in runs:
        if "error" in run: continue
        r = run["result"]
        spec = r["spec"]
        for variant_result in r["results"]:
            m = variant_result.get("metrics", {})
            summary.append({
                "experiment": spec["id"],
                "variant": variant_result["id"],
                "n": m.get("n"),
                "success_rate": m.get("success_rate"),
                "latency_p50": m.get("latency_p50"),
                "mean_tool_count": m.get("mean_tool_count"),
                "mitigation_rate": m.get("mitigation_rate"),
                "top_tools": list(m.get("tool_freq", {}).keys())[:5],
            })
    return {"variants": summary}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("experiments_dir", type=Path)
    p.add_argument("--filter", help="regex filter on filename")
    p.add_argument("--samples", type=int, help="override per-experiment sample count")
    p.add_argument("--deadline", type=int, default=45)
    args = p.parse_args()

    experiments = list_experiments(args.experiments_dir, args.filter)
    if not experiments:
        print("(no experiments matched)")
        return

    runs = [run_one(p, args.samples, args.deadline) for p in experiments]
    summary = cross_summary(runs)

    ts = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    out = RESULTS_DIR / f"ladder_{ts}.json"
    out.write_text(json.dumps({
        "ts": ts,
        "experiments": [str(p) for p in experiments],
        "runs": runs,
        "summary": summary,
    }, indent=2))

    print(f"\n{'═' * 70}\n▶ LADDER SUMMARY\n{'═' * 70}")
    print(f"{'experiment':<28} {'variant':<28} {'success':>8} {'p50':>6} {'tools':>6} {'mit%':>6}")
    for s in summary["variants"]:
        sr = f"{s['success_rate']:.0%}" if s.get("success_rate") is not None else "—"
        p50 = f"{s['latency_p50']:.1f}" if s.get("latency_p50") is not None else "—"
        tc = f"{s['mean_tool_count']:.1f}" if s.get("mean_tool_count") is not None else "—"
        mr = f"{s['mitigation_rate']:.0%}" if s.get("mitigation_rate") is not None else "—"
        print(f"{s['experiment']:<28} {s['variant']:<28} {sr:>8} {p50:>6} {tc:>6} {mr:>6}")
    print(f"\n→ saved: {out}")


if __name__ == "__main__":
    main()
