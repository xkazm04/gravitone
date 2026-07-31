# Architect Coverage

Heatmap of themes and areas scanned, with last-scan date.

## Themes

### error-handling
- Last scanned: 2026-07-26 (run 1)
- Last scan: [[Architect/scans/2026-07-26-error-handling]]
- Findings (last scans): [8]
- Findings actioned: [8]
- Yield density: 1.0
- Notes: service core healthy (engine best-in-repo); fragmentation lived in the proxy and UI layers. Don't re-scan for ~2 quarters unless routes proliferate.

### async-patterns
- Last scanned: 2026-07-26 (run 2)
- Last scan: [[Architect/scans/2026-07-26-async-patterns]]
- Findings (last scans): [8]
- Findings actioned: [8]
- Yield density: 1.0
- Notes: highest-severity run so far (two angles at smell 4). Same shape as run 1 — a strong core (engine) whose discipline wasn't applied at its edges. Now guarded by test_handler_modes + test_file_lock, so a re-scan should be low-yield for ≥1 quarter. If `replicas.py` deployment changes, re-check the cross-process assumptions first.

### Unswept
`data-modeling`, `api-contract`, `type-safety`, `testing-strategy`,
`build-deploy`, `state-management`. Next scan should prefer **data-modeling**
(registry/JSON schemas — both runs kept touching `_meta.json` semantics from
the outside) or **build-deploy** (this run found the deploy config silently
contradicting the code; nobody has swept it deliberately).

## Runs

| # | Mode | Theme | Findings | Actioned | Commits |
|---|---|---|---|---|---|
| 1 | scan | error-handling | 8 | 8 | ceeb6eb..5345246 |
| 2 | scan | async-patterns | 8 | 8 | 4c20acf..de2f6cf |
| 3 | resume | backlog drain | 4 | 4 | 440eecd..4413dda |

Test totals: service 164 → 219; web 0 → 30 (runner added in run 3).

## Areas
_No area-mode scans yet._
