# Supported hardware matrix

Boxes with a passing Gravitone certification (`python -m service.certify`).
Every row is reproducible: run the benchmark on the same instance type and
you get the same certificate.

| Platform | CPU | Cores | Single-stream RTF | Cap | ~audio-min/hour | Status |
|---|---|---|---:|---:|---:|---|
| AWS Graviton4 `c8g.2xlarge` | Neoverse V2 | 8 | 4.26× | 4 | ~650 | ✅ certified (2026-07, project benchmarks) |
| AWS Graviton2 `t4g.small` | Neoverse N1 | 2 | 1.33× | 1 | ~80 | ✅ certified (2026-07, project benchmarks) |
| Windows-ARM64 dev box | Snapdragon-class | 12 | 1.9× | 4 | ~250 | ✅ certified (2026-07, unoptimized reference) |
| GCP Axion | Neoverse V2 | — | — | — | — | ⬜ wanted — run certify and PR your row |
| Azure Cobalt | Neoverse N2 | — | — | — | — | ⬜ wanted |
| Ampere Altra | Neoverse N1 | — | — | — | — | ⬜ wanted |
| Raspberry Pi 5 | Cortex-A76 | 4 | — | — | — | ⬜ wanted |
| Apple Silicon (Linux VM) | M-series | — | — | — | — | ⬜ wanted |

## Certify your box

```bash
# on the box (any Arm64 Linux with the service installed):
bash benchmark_arm.sh                 # ramps concurrency, finds the knee
python -m service.certify             # → certification.json + verdict
```

The certificate records the hardware facts, the three pass/fail checks
(realtime single-stream, healthy concurrency cap, zero errors at cap), the
measured capacity, and the recommended replica config. It is
integrity-hashed; setting `GRAVITONE_CERT_SECRET` on both sides adds an
HMAC signature (the enterprise-tier gate verifies it with
`service.certify.verify_certificate`).

## Submit a row

Open a PR adding your `certification.json` under `docs/certifications/`
and a row to the table above. Opt-in only — the matrix is community-built.
