"""Diff two load-test results - the primitive the performance ledger gates on.

`service/loadtest.py` already emits a self-describing result document: it says
which schema it is, what it spoke (`corpus`), where it sent it (`route`),
whether the synthesis cache was allowed to answer (`cache_mode`), and which Arm
fast-math mode the box ran in (`onednn_fpmath_mode`). That metadata is the
whole reason a diff can be honest, because it lets this module REFUSE the
comparisons that would otherwise quietly produce a number.

Two rules carry all the honesty here, and both are refusals rather than
adjustments:

  * **Different basis, no comparison.** A bf16 run against an fp32 run, a
    `--cache-mode allow` run against a bypass run, a stream run against a synth
    run, a v3 result against a v2 one: these measure different things. There is
    no correction factor that makes them comparable, so the diff comes back
    ``comparable: false`` with the mismatched field NAMED. Silently diffing them
    is how a "regression" gets blamed on a commit that changed nothing.
  * **A run that cannot show it measured synthesis proves nothing.** Mirrors
    `certify.measurement_status`: if either side has
    ``measures_synthesis: false``, its latency and realtime factor describe an
    LRU lookup in part, and subtracting one such number from another produces
    fiction. Refused for the same reason a certificate is refused.

Levels flagged ``low_confidence`` (too few successful samples for a trustworthy
p95) or ``driver_saturated`` (the load generator was itself the bottleneck) are
still REPORTED - their deltas are visible - but they are excluded from the
verdict, by name, so a noisy shared runner cannot fail a merge on a percentile
computed from nine samples.

Pure over dicts: no server, no torch, no filesystem except in ``main``.

    python -m service.compare --old docs/certifications/<fp>/<sha>.json \
        --new service/loadtest_result.json --fail-on-regress 5%

Exit codes mirror `service/certify.py`: 0 = compared and inside tolerance,
2 = a regression, a refused comparison, or nothing left to gate on, 1 = usage
(a missing file). A gate that cannot substantiate a pass must not pass.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

# The fields that must MATCH before two results may be subtracted. Every one of
# them changes what the numbers mean, not merely how large they are.
COMPARE_BASIS = ("schema_version", "cache_mode", "route", "corpus",
                 "onednn_fpmath_mode")

BASIS_WHY = {
    "schema_version": ("the result schemas differ: the two files were produced "
                       "by harnesses that recorded different things"),
    "cache_mode": ("one run let the synthesis cache answer and the other did "
                   "not - they measure different systems"),
    "route": "one run measured /stream (first-chunk work) and the other /synth",
    "corpus": ("different text was spoken, so the audio produced per request "
               "differs before any performance difference is considered"),
    "onednn_fpmath_mode": ("the Arm fast-math mode differs (the single biggest "
                           "perf lever on Neoverse): this is a configuration "
                           "difference, not a regression"),
}

# Per-level metrics and which way is BETTER: +1 = higher is better,
# -1 = lower is better. Named here so the direction can never be guessed at a
# call site (a sign error would report every improvement as a regression).
LEVEL_METRICS = {
    "server_rtf_mean": 1,
    "audio_s_per_wall_s": 1,
    "lat_p95_s": -1,
}

# Run-level metrics: not attached to any single concurrency level.
RUN_METRICS = {"recommended_cap": 1}

# Level flags that disqualify a level from the VERDICT (never from the report).
EXCLUSION_FLAGS = {
    "low_confidence": ("too few successful samples for a trustworthy p95 "
                       "(loadtest.LOW_CONFIDENCE_N)"),
    "driver_saturated": ("the load generator's own CPU saturated a core, so "
                         "this level measures the driver as much as the server"),
}

# 5% is the proposal's default gate band: below it, run-to-run variance on a
# shared runner produces more noise than signal.
DEFAULT_TOLERANCE = 0.05

# Results older than this cannot say whether their numbers came from the model
# or from the synthesis cache (see loadtest.SCHEMA_VERSION history).
MIN_RESULT_SCHEMA = 3


def parse_tolerance(spec) -> float:
    """"5%" / "0.05" / "5" -> 0.05 (a fraction).

    Both spellings are accepted because both are natural on a CLI, and the
    ambiguous middle is resolved ONE way, always: a bare value of 1 or more is
    read as a PERCENT (nobody gates on a 500% band), a bare value below 1 is
    read as a fraction. Anything else is refused loudly rather than silently
    turning a 5% gate into a 500% one.
    """
    if isinstance(spec, (int, float)):
        raw, percent = float(spec), False
    else:
        text = str(spec).strip()
        percent = text.endswith("%")
        if percent:
            text = text[:-1].strip()
        try:
            raw = float(text)
        except ValueError:
            raise ValueError(f"tolerance {spec!r} is not a number "
                             f"(use e.g. 5% or 0.05)") from None
    if raw < 0:
        raise ValueError(f"tolerance {spec!r} is negative")
    if percent or raw >= 1:
        raw = raw / 100.0
    if raw > 1:
        raise ValueError(f"tolerance {spec!r} exceeds 100%")
    return raw


def basis_of(result: dict) -> dict:
    """The comparison basis a result declares (missing fields stay None)."""
    return {k: result.get(k) for k in COMPARE_BASIS}


def measures_synthesis(result: dict) -> tuple[bool, str | None]:
    """Did this run exercise the MODEL, and can it say so itself?

    Deliberately duplicates `certify.measurement_status`'s judgement rather
    than importing it: certify decides whether to SIGN a run, this module
    decides whether to SUBTRACT two, and the two bars must be free to move
    apart. The reasoning is identical - schema < 3 has no cache accounting at
    all, so absence of evidence is not evidence of absence.
    """
    schema = result.get("schema_version") or 1
    if schema < MIN_RESULT_SCHEMA:
        return False, (f"result schema v{schema} predates cache-aware "
                       f"benchmarking: it cannot show whether its numbers came "
                       f"from the model or from the synthesis cache")
    measurement = result.get("measurement") or {}
    flag = measurement.get("measures_synthesis")
    if flag is None:
        hits = sum(int(r.get("cache_hits") or 0)
                   for r in (result.get("levels") or []))
        mode = result.get("cache_mode")
        flag = mode != "allow" and hits == 0
    if not flag:
        note = measurement.get("note") or "the run recorded cache hits"
        return False, f"measures_synthesis is false: {note}"
    return True, None


def comparability(old: dict, new: dict) -> dict:
    """Whether these two results may be diffed at all, and why not if not."""
    reasons: list[str] = []
    old_basis, new_basis = basis_of(old), basis_of(new)
    for field in COMPARE_BASIS:
        a, b = old_basis[field], new_basis[field]
        if a != b:
            reasons.append(f"{field} differs ({a!r} -> {b!r}): "
                           f"{BASIS_WHY[field]}")
    for label, result in (("old", old), ("new", new)):
        ok, why = measures_synthesis(result)
        if not ok:
            reasons.append(f"the {label} run does not measure synthesis - {why}")
    return {
        "comparable": not reasons,
        "reasons": reasons,
        "basis": {"old": old_basis, "new": new_basis},
    }


def level_exclusions(old_row: dict, new_row: dict) -> list[str]:
    """Named reasons this level may not decide the verdict (either side)."""
    out = []
    for label, row in (("old", old_row), ("new", new_row)):
        for flag, why in EXCLUSION_FLAGS.items():
            if row.get(flag):
                out.append(f"{label} level is {flag}: {why}")
    return out


def metric_delta(old_val, new_val, direction: int, tolerance: float) -> dict:
    """One metric's movement, with the regression judgement attached.

    ``delta_pct`` is None when the baseline is absent or zero - a percentage of
    nothing is not a small number, it is an undefined one - and a metric with
    no percentage never votes for a regression.
    """
    entry = {
        "old": old_val,
        "new": new_val,
        "direction": "higher_is_better" if direction > 0 else "lower_is_better",
        "delta": None,
        "delta_pct": None,
        "regressed": False,
        "note": None,
    }
    if old_val is None or new_val is None:
        entry["note"] = "missing on one side"
        return entry
    old_f, new_f = float(old_val), float(new_val)
    entry["delta"] = round(new_f - old_f, 6)
    if old_f == 0:
        entry["note"] = "baseline is zero: no percentage can be formed"
        return entry
    pct = (new_f - old_f) / abs(old_f)
    entry["delta_pct"] = round(pct * 100.0, 3)
    # Signed the direction's way: a worsening is always a positive `moved`.
    moved = -pct if direction > 0 else pct
    entry["regressed"] = moved > tolerance
    return entry


def pair_levels(old: dict, new: dict):
    """Pair levels by ``concurrency``; unmatched levels are reported, not fudged."""
    old_rows = {r.get("concurrency"): r for r in (old.get("levels") or [])}
    new_rows = {r.get("concurrency"): r for r in (new.get("levels") or [])}
    shared = sorted(k for k in old_rows if k in new_rows and k is not None)
    pairs = [(k, old_rows[k], new_rows[k]) for k in shared]
    old_only = sorted(k for k in old_rows if k not in new_rows and k is not None)
    new_only = sorted(k for k in new_rows if k not in old_rows and k is not None)
    return pairs, old_only, new_only


def diff_results(old: dict, new: dict,
                 tolerance: float = DEFAULT_TOLERANCE) -> dict:
    """Compare two load-test results. Pure; the only judgement is regression.

    Returns a document that is safe to print, to store, and to gate on:

      * ``comparable`` / ``reasons`` - the refusal, with the field named.
      * ``levels`` - per concurrency, each tracked metric's old/new/delta and
        whether it regressed, plus ``excluded`` + ``exclusion_reasons``.
      * ``capacity`` - the run-level metrics (``recommended_cap``).
      * ``unpaired`` - concurrencies present on only one side.
      * ``regressions`` - the flat list a CI job prints.
      * ``gateable`` - False when nothing survived exclusion, which a gate must
        treat as a failure to prove a pass, not as a pass.
    """
    tolerance = float(tolerance)
    verdict = comparability(old, new)
    diff = {
        "tolerance": tolerance,
        "comparable": verdict["comparable"],
        "reasons": verdict["reasons"],
        "basis": verdict["basis"],
        "levels": [],
        "capacity": {},
        "unpaired": {"old_only": [], "new_only": []},
        "regressions": [],
        "regressed": False,
        "gateable": False,
    }
    if not verdict["comparable"]:
        return diff

    pairs, old_only, new_only = pair_levels(old, new)
    diff["unpaired"] = {"old_only": old_only, "new_only": new_only}

    for concurrency, old_row, new_row in pairs:
        excluded = level_exclusions(old_row, new_row)
        entry = {
            "concurrency": concurrency,
            "excluded": bool(excluded),
            "exclusion_reasons": excluded,
            "metrics": {},
        }
        for metric, direction in LEVEL_METRICS.items():
            entry["metrics"][metric] = metric_delta(
                old_row.get(metric), new_row.get(metric), direction, tolerance)
        diff["levels"].append(entry)

    for metric, direction in RUN_METRICS.items():
        diff["capacity"][metric] = metric_delta(
            old.get(metric), new.get(metric), direction, tolerance)

    included = [lv for lv in diff["levels"] if not lv["excluded"]]
    diff["gateable"] = bool(included)
    for level in included:
        for metric, entry in level["metrics"].items():
            if entry["regressed"]:
                diff["regressions"].append({
                    "scope": f"concurrency={level['concurrency']}",
                    "metric": metric,
                    "old": entry["old"],
                    "new": entry["new"],
                    "delta_pct": entry["delta_pct"],
                })
    # The capacity cap is a property of the whole run, so it is gated whenever
    # ANY level survived exclusion: a cap that fell is a regression even if the
    # level that produced it happened to be noisy.
    if diff["gateable"]:
        for metric, entry in diff["capacity"].items():
            if entry["regressed"]:
                diff["regressions"].append({
                    "scope": "run",
                    "metric": metric,
                    "old": entry["old"],
                    "new": entry["new"],
                    "delta_pct": entry["delta_pct"],
                })
    diff["regressed"] = bool(diff["regressions"])
    return diff


def gate_verdict(diff: dict) -> tuple[bool, str]:
    """(passed, one-line reason) - the CI gate's whole decision.

    Three ways to fail and only one to pass, on purpose: a refused comparison
    and an all-excluded comparison are both "this run did not prove the absence
    of a regression", which is not the same as proving one.
    """
    if not diff["comparable"]:
        return False, ("refused to compare: " + "; ".join(diff["reasons"]))
    if not diff["gateable"]:
        return False, ("every paired level was excluded (low confidence or a "
                       "saturated driver): this run cannot substantiate a pass "
                       "- re-run on an idle box with more requests per level")
    if diff["regressed"]:
        worst = max(diff["regressions"],
                    key=lambda r: abs(r["delta_pct"] or 0.0))
        return False, (f"{len(diff['regressions'])} regression(s) beyond "
                       f"{round(diff['tolerance'] * 100, 3)}%, worst: "
                       f"{worst['metric']} at {worst['scope']} "
                       f"{worst['old']} -> {worst['new']} "
                       f"({worst['delta_pct']}%)")
    return True, (f"no metric moved more than "
                  f"{round(diff['tolerance'] * 100, 3)}% the wrong way across "
                  f"{len([lv for lv in diff['levels'] if not lv['excluded']])} "
                  f"gated level(s)")


def format_report(diff: dict) -> str:
    """Human-readable diff (ASCII), suitable for a CI log or a PR comment."""
    lines = ["-" * 66, "Gravitone performance diff", "-" * 66]
    if not diff["comparable"]:
        lines.append("NOT COMPARABLE:")
        lines += [f"  - {r}" for r in diff["reasons"]]
        lines.append("-" * 66)
        return "\n".join(lines)
    lines.append(f"basis: {json.dumps(diff['basis']['new'], sort_keys=True)}")
    header = (f"{'conc':>5} {'metric':>20} {'old':>12} {'new':>12} "
              f"{'delta%':>9}  flag")
    lines.append(header)
    for level in diff["levels"]:
        for metric, entry in level["metrics"].items():
            flag = ""
            if level["excluded"]:
                flag = "excluded"
            elif entry["regressed"]:
                flag = "REGRESSED"
            elif entry["note"]:
                flag = entry["note"]
            lines.append(f"{level['concurrency']:>5} {metric:>20} "
                         f"{str(entry['old']):>12} {str(entry['new']):>12} "
                         f"{str(entry['delta_pct']):>9}  {flag}")
    for metric, entry in diff["capacity"].items():
        flag = "REGRESSED" if entry["regressed"] else (entry["note"] or "")
        lines.append(f"{'run':>5} {metric:>20} {str(entry['old']):>12} "
                     f"{str(entry['new']):>12} {str(entry['delta_pct']):>9}  "
                     f"{flag}")
    for level in diff["levels"]:
        for reason in level["exclusion_reasons"]:
            lines.append(f"  ! concurrency={level['concurrency']} excluded: "
                         f"{reason}")
    unpaired = diff["unpaired"]
    if unpaired["old_only"] or unpaired["new_only"]:
        lines.append(f"  ! unpaired levels: only in old {unpaired['old_only']}, "
                     f"only in new {unpaired['new_only']} (not compared)")
    passed, why = gate_verdict(diff)
    lines.append("-" * 66)
    lines.append(f"{'PASS' if passed else 'FAIL'}: {why}")
    return "\n".join(lines)


def _load(path: str) -> dict:
    try:
        return json.loads(Path(path).read_text("utf-8"))
    except FileNotFoundError:
        print(f"{path} not found -- run 'python -m service.loadtest' first")
        raise SystemExit(1) from None


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Diff two service.loadtest result JSONs and gate on it.")
    ap.add_argument("--old", required=True, help="baseline result JSON")
    ap.add_argument("--new", default="service/loadtest_result.json",
                    help="candidate result JSON")
    ap.add_argument("--fail-on-regress", default="5%",
                    help="regression band, e.g. 5%% or 0.05 (default 5%%)")
    ap.add_argument("--json", dest="json_out", default=None,
                    help="also write the diff document here")
    a = ap.parse_args()

    try:
        tolerance = parse_tolerance(a.fail_on_regress)
    except ValueError as exc:
        print(f"!! {exc}")
        raise SystemExit(1) from None

    diff = diff_results(_load(a.old), _load(a.new), tolerance)
    print(format_report(diff))
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(diff, indent=2), "utf-8")
        print(f"wrote {a.json_out}")
    passed, _ = gate_verdict(diff)
    raise SystemExit(0 if passed else 2)


if __name__ == "__main__":
    main()
