# Dual-lens scan — svc-loadtest
> Files: 1 | Findings: 5 (crit 0 / high 1 / med 3 / low 1)
> Lenses: bug-hunter + code-refactor

## 1. Successful synth is miscounted as an error (and its latency double-recorded) when a response header fails to parse
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: silent-failure / state-corruption
- **File**: `service/loadtest.py:400`
- **Scenario**: A request returns HTTP 200 (bucket == "ok"), `results["lat"].append(dt)` runs, then `float(r.headers.get("X-Realtime-Factor", "nan"))` or `float(r.headers.get("X-Audio-Seconds", "0"))` hits a present-but-non-numeric header value (e.g. `""`, `"N/A"`, `"inf%"`). `float()` raises `ValueError`, which is caught by the broad `except Exception` at line 410 and increments `results["errors"]`.
- **Root cause**: The latency sample is appended *before* the header parsing that can throw, and the outer try/except treats a header-parse failure identically to a transport failure. The "ok" path is not atomic: partial state (a recorded latency) survives while the request is simultaneously tallied as an error. Defaults only cover *missing* headers, not malformed ones.
- **Impact**: One malformed header on an otherwise-successful synth leaves a phantom entry in `lat` AND bumps `errors`. Because `level_degraded` (line 102) treats ANY error as degradation, a single bad header falsely flags the whole concurrency level as degraded, moving the detected "knee" down and producing an incorrect deployment cap — corrupting the exact number this tool exists to produce.
- **Fix sketch**: Wrap only the header parsing in its own try/except that defaults to `nan`/`0` on failure (never re-buckets a 200 as an error), and append `lat` only after the row is fully constructed. e.g. compute rtf/audio into locals with a guarded parse, then append all three together.

## 2. Degradation at the baseline level yields `recommended=None`, so the sizing plan recommends the MOST degraded concurrency as the safe cap
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: edge-case / inverted-recommendation
- **File**: `service/loadtest.py:716`
- **Scenario**: If degradation is first seen at `levels[0]` (the baseline itself trips — e.g. the box is already loaded, or errors occur at concurrency 1), then `knee == levels[0]` and the loop `for c in levels: if knee is None or c < knee` finds no `c < knee`, leaving `recommended = None`. `print_plan` then executes `cap = result.get("recommended_cap") or rows[-1]["concurrency"]`, selecting the LAST (highest, most degraded) level.
- **Root cause**: The "last healthy level" computation has no defined answer when even the first level is unhealthy, and the downstream `or rows[-1][...]` fallback silently substitutes the worst level instead of failing closed to the smallest/safest.
- **Impact**: In the very scenario the tool should protect against (degradation everywhere), it advises the operator to run the highest measured concurrency — the opposite of safe. The advisor emits confident `TTS_WORKERS`/`TTS_QUEUE_MAX` numbers built on a degraded row.
- **Fix sketch**: When `knee == levels[0]`, set `recommended` to `None`/`0` and have `print_plan` fall back to the *smallest* level (`rows[0]["concurrency"]`) with an explicit "baseline already degraded — no safe cap found" warning, rather than defaulting to `rows[-1]`.

## 3. Stream-route 501 (unsupported) failures never trip degradation — an all-501 run reports "no degradation" and emits a bogus plan
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: silent-failure / success-theater
- **File**: `service/loadtest.py:102`
- **Scenario**: Run `--route stream --format mp3...`. Every request returns 501 and is tallied under `results["unsupported"]` → `unsupported_501` (lines 450-451, 560). `level_degraded` only inspects `rejected_429`, `errors`, `timeouts`, `lat_p95_s`, and the CPU/rtf gate — it never looks at `unsupported_501`. With `ok == 0`, `lat_p95_s` is `None`, so no branch trips.
- **Root cause**: `unsupported_501` was added as a distinct outcome bucket but was never wired into the degradation predicate, so a 100%-failed level looks identical to a perfectly healthy one to the knee detector.
- **Impact**: A fully-failing stream run prints "No degradation across tested levels" and writes a result whose `recommended_cap` is the top level — success theater over total failure. The upfront line-848 warning is only advisory; the machine-readable JSON and plan still lie.
- **Fix sketch**: In `level_degraded`, treat `row.get("unsupported_501")` as degradation (same class as errors), or short-circuit the ramp when a level's `ok == 0` and `unsupported_501 == n_requests`.

## 4. Knee CPU gate uses whole-host CPU even when the honest server/driver split is available, letting the co-located driver falsely trip degradation
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: measurement-correctness
- **File**: `service/loadtest.py:109`
- **Scenario**: On a co-located run with `--server-pid`/`--replicas` set, `run_level` computes `server_cpu_mean_pct` (server process tree, line 548) apart from `driver_cpu_mean_pct`. But `level_degraded` reads `row.get("cpu_mean_pct")`, which is deliberately kept as **whole-host** CPU (line 543). If the load generator's own CPU pushes host past `--cpu-ceiling` (95%) while the server alone is below it, and `server_rtf_mean < 1.0`, the CPU branch trips.
- **Root cause**: The module goes to significant lengths to separate server CPU from driver CPU for "honest accounting", yet the degradation decision still consumes the double-counted host figure — the split is reported but not used where the verdict is made.
- **Impact**: A false knee on co-located runs: the tool blames the server for CPU saturation actually caused by its own driver, recommending a lower cap and understating real server capacity — undercutting the whole `--server-pid` feature.
- **Fix sketch**: In `level_degraded`, prefer `row.get("server_cpu_mean_pct")` when present and fall back to `cpu_mean_pct` only when the split is unavailable (`None`).

## 5. Redundant local `import os` inside `print_plan` shadows the module-level import
- **Severity**: low
- **Lens**: code-refactor
- **Category**: dead-code / cleanup
- **File**: `service/loadtest.py:589`
- **Scenario**: `os` is already imported at module scope (line 34) and used in `runtime_metadata`. `print_plan` re-imports it locally with `import os` at line 589 before calling `os.cpu_count()`.
- **Root cause**: Leftover local import that duplicates an already-available module-level binding (unlike `torch`/`torch.__version__`, `os` is not an optional dependency needing lazy import).
- **Impact**: None functional — purely noise that implies `os` might be optional here and invites confusion; a trivial maintainability nit.
- **Fix sketch**: Delete the `import os` on line 589; the module-level import already covers `os.cpu_count()`.
