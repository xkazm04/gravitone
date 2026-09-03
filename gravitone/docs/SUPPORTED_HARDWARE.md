# Supported hardware matrix

Boxes this project has measured with `benchmark_arm.sh` → `service/loadtest.py`.
Every row is reproducible: run the benchmark on the same instance type and you
can re-derive it.

**Read the Status column precisely.** "measured" means we ran the harness on
that box and typed the result here. It does **not** mean a signed certificate
for it is checked in — `docs/certifications/ledger.json` is still empty, on
purpose, and [`docs/certifications/README.md`](certifications/README.md)
explains why (no run has gone through `--append-ledger` yet). This table is a
table someone typed; the ledger is what will make it falsifiable. The gap is
stated rather than papered over.

| Platform | CPU | Cores | Single-stream RTF | Cap | ~audio-min/hour | Plan | Status |
|---|---|---|---:|---:|---:|---|---|
| AWS Graviton4 `c8g.2xlarge` | Neoverse V2 | 8 | 4.26× | 4 | ~650 | compile from the row's certificate | ✅ measured (2026-07, project benchmarks; no certificate checked in) |
| AWS Graviton2 `t4g.small` | Neoverse N1 | 2 | 1.33× | 1 | ~80 | compile from the row's certificate | ✅ measured (2026-07, project benchmarks; no certificate checked in) |
| Windows-ARM64 dev box | Snapdragon-class | 12 | 1.9× | 4 | ~250 | compile from the row's certificate | ✅ measured (2026-07, unoptimized reference; no certificate checked in) |
| GCP Axion | Neoverse V2 | — | — | — | — | — | ⬜ wanted — run certify and PR your row |
| Azure Cobalt | Neoverse N2 | — | — | — | — | — | ⬜ wanted |
| Ampere Altra | Neoverse N1 | — | — | — | — | — | ⬜ wanted |
| Raspberry Pi 5 | Cortex-A76 | 4 | — | — | — | — | ⬜ wanted |
| Apple Silicon (Linux VM) | M-series | — | — | — | — | — | ⬜ wanted |

### About the Plan column

A **plan** is a `deployment-plan.json` compiled from that row's certificate by
`python -m service.plan certification.json`: replica count, thread budget,
queue depth, per-replica resources, autoscaling mode and role placement, with
the certificate sha256 and hardware fingerprint in its provenance.

The three certified rows above were measured before the compiler existed, so
**no plan file is checked in for any of them yet** — the numbers a plan needs
live in each row's certificate, and a plan is one command away once that
certificate is submitted (see "Submit a row"). Nothing here is fabricated for a
box we have not measured: a `—` in the Plan column means no plan exists, and a
plan invented for an unmeasured box would be exactly the "hand-tuned constants
copied out of a README" the compiler exists to abolish.

Plans link here as `docs/certifications/<row>.plan.json` alongside the
certificate they came from, once submitted.

## Certify your box

```bash
# on the box (any Arm64 Linux with the service installed):
bash benchmark_arm.sh                 # ramps concurrency, finds the knee
python -m service.certify             # → certification.json + verdict
python -m service.plan certification.json   # → deployment-plan.json
```

The third command is optional for the matrix and required for the box: it
compiles the certificate into the topology that box should actually run (and
refuses, with a named reason, on a failing or predicted-only certificate). See
`deploy/README.md`, "Measure → plan → deploy".

The certificate records the hardware facts, the three pass/fail checks
(realtime single-stream, healthy concurrency cap, zero errors at cap), the
measured capacity, and the recommended replica config. It is
integrity-hashed; setting `GRAVITONE_CERT_SECRET` on both sides adds an
HMAC signature (the enterprise-tier gate verifies it with
`service.certify.verify_certificate`).

## Submit a row

Open a PR adding your `certification.json` under `docs/certifications/`
and a row to the table above. Opt-in only — the matrix is community-built.
Include your `deployment-plan.json` as `docs/certifications/<row>.plan.json`
and link it in the Plan column: that is what turns this table of numbers into a
library of ready deployments.
