# The Arm Performance Ledger

An append-only, machine-generated record of what this model did on named
silicon, at a named commit, under a named torch version and fast-math mode.

`docs/SUPPORTED_HARDWARE.md` is a table someone typed. This directory is the
thing that makes it falsifiable: every row points at a certificate that carries
its own integrity hash, and the row can be re-derived from that certificate - so
an edit to the history is detectable rather than persuasive.

**This ledger is currently EMPTY, on purpose.** `ledger.json` has zero rows
because no benchmark has been run through `--append-ledger` yet: the authoring
machine is a Windows x86 box with no Arm runner and no AWS profile. A row here
would be a number nobody measured, which is the exact failure this whole
subsystem exists to prevent (`service/certify.py` refuses to sign a run it
cannot substantiate; it would be absurd for its own ledger to open with
fabricated data). The first real row arrives from the first real run.

## Layout

```
docs/certifications/
  README.md                          this file
  ledger.json                        the append-only index
  <hw_fingerprint>/<git_sha>.json    the raw certificate for one run
  <hw_fingerprint>/<git_sha>-<sha8>.json   a re-run of the SAME commit
```

`<hw_fingerprint>` is a 16-hex hash naming a **box class**: the stable
hardware fields (`machine`, `cpu_count`, `cpu_model`, `processor`,
`memory_gb`) plus the cloud instance type when one is given
(`--instance-type c8g.2xlarge`). It deliberately excludes the kernel release  - 
a kernel upgrade is a change worth *measuring* on the same series, not a reason
to start a new history. Every row sharing a fingerprint is one comparable time
series, which is the only condition under which a trend line means anything.

Re-benchmarking one commit on one box keeps **both** certificates (the second
gets the `-<sha8>` suffix). Nothing in this directory is ever overwritten.

## The row schema (`ledger.json`)

```json
{
  "version": "gravitone-ledger/1",
  "note": "...",
  "rows": [
    {
      "hw_fingerprint": "0123456789abcdef",
      "instance_type": "c8g.2xlarge",
      "cpu_model": "Neoverse-V2",
      "cores": 8,
      "git_sha": "abc1234",
      "issued": "2026-07-30T12:00:00+00:00",
      "torch_version": "2.9.0",
      "fpmath": "bf16",
      "single_stream_rtf": 4.26,
      "cap": 4,
      "aud_s_at_cap": 10.8,
      "verdict": "certified",
      "sha256": "<the certificate's own payload hash>",
      "cert_path": "0123456789abcdef/abc1234.json"
    }
  ]
}
```

| field | meaning | verifiable from the certificate |
|---|---|---|
| `hw_fingerprint` | box class (see above) | yes |
| `instance_type` | cloud instance type, or `null` | no (an input to the fingerprint) |
| `cpu_model` / `cores` | from `gather_hardware()` | yes |
| `git_sha` | commit the harness ran at | yes - it is the artifact's file name |
| `issued` | certificate timestamp (UTC) | yes |
| `torch_version` | `torch.__version__` on the box | **no** |
| `fpmath` | `ONEDNN_DEFAULT_FPMATH_MODE` | **no** |
| `single_stream_rtf` | realtime factor at concurrency 1 | yes |
| `cap` | recommended concurrency cap | yes |
| `aud_s_at_cap` | audio-seconds per wall-second at the cap | yes |
| `verdict` | `certified` or `failed` (both are recorded) | yes |
| `sha256` | the certificate's payload hash | yes |
| `cert_path` | path to the artifact, relative to this directory | yes |

**On the two "no" rows.** `torch_version` and `fpmath` live in the load-test
*result*, not in the certificate, so the certificate's hash does not cover them.
They are provenance - they tell you which run you are looking at - and nothing
gates on them. Recording them as unknown when the result is absent is
deliberate: an unknown torch version is information, an invented one is a lie.
Making them covered would mean putting them in the certificate payload, which
is a `CERT_VERSION` bump and a separate change.

## Writing a row

```bash
python -m service.loadtest --url http://127.0.0.1:8080 --voice alba
python -m service.certify --append-ledger --instance-type c8g.2xlarge
```

`--append-ledger` does three things and refuses in three ways:

1. **Verify** the certificate against its own hash (and its HMAC, when
   `GRAVITONE_CERT_SECRET` is set). A certificate that fails is not recorded.
2. **Re-derive every existing row** from its certificate. If any row disagrees
   with the artifact it claims to summarise, the append is REFUSED - history
   gets repaired, never quietly extended over an edit. A row whose artifact has
   been pruned is reported as *unverifiable* and is not fatal: it simply proves
   nothing on its own.
3. **Append.** A no-op when the ledger already holds this measurement - either
   the same certificate `sha256`, or a row agreeing on every field a row
   claims (`hw_fingerprint`, `instance_type`, `git_sha`, `torch_version`,
   `fpmath`, `single_stream_rtf`, `cap`, `aud_s_at_cap`, `verdict`) and
   differing only in `issued`. The second test matters because re-running
   `certify` over one result JSON mints a fresh certificate with a new
   timestamp and therefore a new hash: without it, a retried CI step would
   write the same benchmark into history twice. Identical commit but different
   numbers (a torch upgrade, a quieter box) IS a new fact and does append.

Failed certifications are recorded too. A ledger that keeps only its good days
is marketing.

## Reading a row

```bash
# what changed since the last run on this hardware class?
python -m service.compare --old docs/certifications/<fp>/<sha>.json \
    --new service/loadtest_result.json --fail-on-regress 5%
```

`service/compare.py` REFUSES to diff runs whose `schema_version`, `cache_mode`,
`route`, `corpus` or `onednn_fpmath_mode` differ, and refuses either side that
cannot show it measured synthesis. Levels flagged `low_confidence` or
`driver_saturated` are shown but excluded from the verdict by name. Exit 0 =
inside tolerance, 2 = a regression or a comparison that could not be made.

## What is deliberately NOT here yet

* **`web/lib/benchmarks.ts` generation.** The web dataset stays hand-written
  until a real row exists. Generating a chart from an empty ledger would put a
  fabricated series in front of buyers, which is the one thing this subsystem
  cannot do.
* **`--bisect` attribution.** The knob-level A/B (`benchmark_arm_ab.sh`) that
  explains *which* change moved the number is a follow-up; it needs a real
  failing gate to be designed against.
* **Third-party submissions.** Accepting an HMAC-signed certificate by PR (and
  generating `docs/SUPPORTED_HARDWARE.md` from the ledger) waits on the CI
  workflow having run at least once.
