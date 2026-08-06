# Deploy — your Private ElevenLabs in minutes

Three ways to get a running, key-protected, ElevenLabs-compatible TTS
endpoint on an Arm box. All of them end the same way: a base URL + an
`xi-api-key`, and any existing ElevenLabs client migrates with one env change.

> **Before you trust this page:** it has been walked verbatim once, on
> 2026-08-05, and the walk found six defects — including a `up` command that
> printed a success banner after every one of its AWS calls failed. Those are
> fixed; the write-up is
> [`docs/DEPLOY_REHEARSAL.md`](../docs/DEPLOY_REHEARSAL.md). What that rehearsal
> did **not** do is reach a running service (credentials expired), so the
> `1.33×` below is still an uncertified observation and the "4-8 min" first boot
> is still unverified. Both are flagged there.

Instance presets come from the measured benchmarks (`/benchmarks` in the
studio, or README "Measured performance"):

| Preset | Instance | Why |
|---|---|---|
| Demo | `t4g.small` | free-tier eligible, 1.33× realtime — personal use |
| Production | `c8g.2xlarge` | 4.26× realtime single stream, ~650 audio-min/hour |

## 1. One command (AWS CLI)

```bash
# uses profile "gravitone" (see aws/README.md); TYPE=c8g.2xlarge for production
deploy/aws-oneclick.sh up
# → prints Base URL + xi-api-key when /health answers (4-8 min first boot)
deploy/aws-oneclick.sh stop        # park it (~$0 compute, voices kept)
```

Needs `ec2:CreateSecurityGroup` + `ec2:AuthorizeSecurityGroupIngress` on top
of `aws/iam-policy.json`, or pass `SG=sg-...` to reuse an existing group.
Port 8080 is opened only to your current IP by default (`CIDR=` to override).

## 2. CloudFormation (the marketplace-shaped path)

```bash
aws cloudformation deploy \
  --template-file deploy/cloudformation.yaml \
  --stack-name gravitone \
  --parameter-overrides \
      ApiKey=gvt_root_$(openssl rand -hex 24) \
      AllowedCidr=$(curl -s https://checkip.amazonaws.com)/32 \
      InstanceType=t4g.small
aws cloudformation describe-stacks --stack-name gravitone \
  --query 'Stacks[0].Outputs'   # BaseUrl / HealthCheck / TryIt
```

This template is exactly what an AWS Marketplace / quick-launch listing
wraps: parameterized instance size, your key, your CIDR, latest Ubuntu Arm64
AMI resolved automatically. GCP (Axion) and Azure (Cobalt) equivalents reuse
`deploy/bootstrap.sh` unchanged — only the launch wrapper differs.

## 3. Any Arm box you already have

```bash
export TTS_API_KEY=gvt_root_...   # optional; generated if unset
curl -sL https://raw.githubusercontent.com/xkazm04/gravitone/main/gravitone/deploy/bootstrap.sh | sudo -E bash
```

Works on Graviton, Axion, Ampere, or an Arm devboard. Installs docker,
builds the Arm-tuned image, and registers a systemd service (`gravitone`)
with a named volume so cloned voices survive rebuilds.

## 4. Air-gapped (USB stick, no registry, no internet)

The image bakes every model weight at build time (Dockerfile `bake` stage), so
a disconnected box needs no egress at all — not even on first boot.

```bash
# on a connected Arm64 build box
docker build -t gravitone:1.0 .
scripts/airgap-install.sh save gravitone:1.0 gravitone-1.0.tar
#   -> gravitone-1.0.tar + .sha256 + gravitone-1.0.manifest.json

# carry all three across, then on the air-gapped box (root, Arm64):
./airgap-install.sh install gravitone-1.0.tar
```

`airgap-install.sh` and `bootstrap.sh` register the SAME systemd unit — both
source `deploy/gravitone-unit.sh`, which is the only place that unit exists.
Copy `gravitone-unit.sh` onto the stick beside the tarball (the installer looks
for it next to itself, in `./deploy/`, and in `/opt/gravitone/gravitone/deploy/`
— `bootstrap.sh` clones the repo to `/opt/gravitone`, and the application root
is the `gravitone/` directory inside it).

**Sealed vs slim.** The default build is sealed. For a fast build on a
connected box:

```bash
docker build --build-arg MODELS_STAGE=nobake --build-arg HF_HUB_OFFLINE=0 -t gravitone:slim .
BUILD_ARGS="--build-arg MODELS_STAGE=nobake --build-arg HF_HUB_OFFLINE=0" ./bootstrap.sh
```

A slim image downloads weights on first use exactly as the old image did. You
never have to guess which one a box got:

```bash
curl -s -H "xi-api-key: $KEY" localhost:8080/v1/appliance | python3 -m json.tool
```

`GET /v1/appliance` (service/appliance.py) reports `seal: sealed|unsealed`, every
baked model file with its sha256 and upstream provenance, the locales and
capabilities that follow, and — when unsealed — the NAME of each missing
component with the command that fetches it. Set `TTS_APPLIANCE_SECRET` (or
reuse `TTS_PACK_SECRET`) and the manifest is HMAC-signed, so the document that
shipped with the tarball can be diffed against the running box.

Which Piper locales are baked in is a build-time decision (image size grows with
each voice): `--build-arg BAKE_PIPER_VOICES="cs_CZ-jirka-medium pl_PL-darkman-medium"`.
Whisper size likewise: `--build-arg BAKE_STT_MODEL=base`.

> Model licences for redistribution INSIDE an image are still an open legal
> review (Piper is MIT; the Whisper/CTranslate2 and sherpa-onnx model releases
> need confirming). The manifest says so in band as `license_review`.

## 5. Measure → plan → deploy (the deployment compiler)

"What should I set for my box?" is not a question anyone should answer from a
README. Measure the box once, and it writes its own topology:

```bash
bash benchmark_arm.sh                     # ramp concurrency, find the knee
python -m service.certify                 # → certification.json (+ verdict)
python -m service.plan certification.json # → deployment-plan.json
```

`deployment-plan.json` carries `replicas`, `torch_threads`, `queue_max`,
per-replica `resources`, an `autoscaling` mode with the reason it was chosen,
the three `roles`, and `provenance` (certificate sha256 + hardware fingerprint)
so any artifact can be traced back to the measurement it came from.

**It refuses more than it emits.** A failing certificate, a cache-contaminated
run, a v1 certificate, or a v3 whose rate was *predicted* rather than measured
all exit `2` with a named reason and write nothing — a wrong plan is worse than
a conservative default, and `service.certify` already refuses to sign a curve
fit for the same reason. `--verify` additionally checks the certificate's
hash/HMAC before planning.

Render the same plan into whatever runs it:

```bash
python -m service.plan certification.json --emit helm-values  # → gravitone-values.yaml
python -m service.plan certification.json --emit compose      # → docker-compose.yml
```

On a box (bootstrap path), drop the plan where the unit looks for it:

```bash
sudo install -D -m644 deployment-plan.json /etc/gravitone/deployment-plan.json
sudo -E bash deploy/bootstrap.sh        # or PLAN=/path/to/plan.json sudo -E bash ...
```

`bootstrap.sh` then takes `TTS_TORCH_THREADS`/`TTS_QUEUE_MAX` from the plan and,
when `replicas > 1`, runs `python -m service.replicas --replicas N` inside the
container — the supervisor that does SO_REUSEPORT port sharing, per-replica
thread pinning and restart-on-death. **With no plan present nothing changes**:
one container, `TTS_TORCH_THREADS=min(4, cores)`, `TTS_QUEUE_MAX=32`, exactly as
before. A plan is an upgrade to a measured box, never a prerequisite, and the
`PLAN=` override exists so a first boot never has to probe.

### Which autoscaling metric, and why it is not always queue depth

The plan picks `autoscaling.mode` from the *measured topology*, not preference:

| Topology | Mode | Why |
|---|---|---|
| 1 replica | `off` | a single-replica box scales by resizing, not by count |
| SO_REUSEPORT (shared port) | `cpu` | aggregated `/metrics` is a `single_replica_sample` with `totals: null` — KEDA on `metrics.queued` would size the fleet from one arbitrary replica |
| sequential ports / k8s pods | `keda` | every replica is individually addressable, so queue depth (the pre-429 signal) is a real pool figure |

### Roles

The plan places three roles rather than one do-everything pod: `synth`
(stateless, scales freely), `converse` (needs STT+VAD+TTS co-resident and holds
a latency budget) and `ingest` — which is `affine: true` **as a field**, so the
404 footgun documented below is a machine-readable placement constraint instead
of a paragraph somebody may not read. Below 4 replicas the roles are colocated
and the plan says so (`roles.colocated`).

Role-scoped images are the Dockerfile's existing build args, not a new build:
each role carries `image_build_args` (`MODELS_STAGE`, `BAKE_STT_MODEL`,
`BAKE_PIPER_VOICES`). Note the image's capability gate imports all four
capability modules, so roles differ in baked **weights** (image size), not in
installed code.

## What the bootstrap sets up

- `TTS_API_KEY` enforced on every endpoint (see `service/auth.py`) — the
  printed root key, or scoped keys minted via `/v1/keys`.
- Tuning from the measured scaling law: `TTS_WORKERS=1`,
  `TTS_TORCH_THREADS=min(4, cores)`, bf16 via the image's oneDNN/ACL torch.
  These are the no-plan defaults; with a `deployment-plan.json` present the
  thread budget, queue depth and replica count come from the measurement
  instead (section 5) — that is how a big box stops being deliberately
  underused.
- `docker volume gravitone-voices` — persisted voices; the service survives
  reboots via systemd `Restart=always`.
- `docker volume gravitone-ingest` — ingest job workdirs + `state.json`.
  Required for durability: jobs are rehydrated on restart, which only works
  if the directory outlives the container.

## Shutdown budget

Three timeouts must stay ordered, longest last:

| Setting | Default | Where |
|---|---|---|
| `TTS_DRAIN_TIMEOUT_S` | 20s | how long `engine.stop()` waits for in-flight generations |
| `docker stop -t` / `terminationGracePeriodSeconds` | 30s / 45s | when the orchestrator SIGKILLs |
| `TTS_REQUEST_TIMEOUT_S` | 120s | the caller's own ceiling (independent) |

If the stop grace is shorter than the drain budget the process is killed
mid-drain — in-flight generations die and a clone commit can be cut between
registering a voice and recording it in the job state. `docker stop`'s 10s
default is too short; `bootstrap.sh` passes `-t 30`.

During the drain `/health` returns 503 `{"status": "draining"}` so a load
balancer stops sending new work; liveness is a TCP probe, so failing readiness
does not get the pod killed mid-drain.

## Ingest is replica-affine

Ingest jobs live in the creating process's memory (`JOBS` in
`service/ingest_api.py`) and are only rehydrated from disk at startup. A
multi-replica fleet behind `SO_REUSEPORT` (or a k8s Service) will round-robin
the follow-up `GET /v1/ingest/{job}` to a replica that has never heard of the
job and answer 404 `{"status": "expired"}`.

What is no longer true is that the replicas *fight* over that shared directory.
A job is OWNED by exactly one process: the owner record in the job's directory
is written under `atomicio.file_lock`, ownership is claimed once at rehydrate,
and a process advertises liveness through a heartbeat under
`INGEST_WORK_DIR/.owners`. A replica therefore rehydrates only its own jobs,
and its GC never reaps a directory a beating sibling owns — only its own, or
one whose owner stopped beating. Admission is divided across the pool the same
way (`ingest_api.admission_shape`), and the 429 states the pool-wide number.

So: run the **voice-creation flow against a single replica** (sticky sessions,
a dedicated ingest pod, or `replicaCount: 1` while cloning). Synthesis
(`/v1/text-to-speech`, `/v1/speak`, `/v1/performance`) has no such constraint —
it is stateless and scales across replicas freely. The registry itself is safe
either way: `mutate_meta` takes a cross-process file lock, so concurrent clones
on different replicas cannot drop each other's voices.

## Link ingest is brittle by design

`POST /v1/ingest/scan-url` fetches the audio behind a pasted YouTube link
(`service/ingest_url.py`) and then joins the ordinary upload path. Two things
an operator should know before relying on it:

- **The extractor is pinned and it ages.** `yt-dlp==2026.7.4` in
  `requirements.txt`. yt-dlp tracks a site that changes its player weekly, and
  the project ships releases at roughly that cadence in response. A pin that is
  a few months old will eventually start answering "couldn't get audio from
  that link" for videos that are perfectly fine — that is the pin expiring, not
  a bug in the service. **Bump the pin and rebuild.** The pin is deliberate:
  the alternative is a service whose behaviour changes without a deploy.
- **YouTube may demand a JS runtime.** Some player variants are only solvable
  with a JavaScript interpreter; when yt-dlp needs one and cannot find Deno or
  Node on the box, extraction fails for those videos. The image does not ship
  one today. If link ingest fails broadly while file upload is healthy, check
  the service log for yt-dlp's own message (it is logged in full there and
  deliberately never returned to the client) before suspecting the network.

- **A long video is trimmed, not refused.** `POST /v1/ingest/link/probe` reads
  the metadata BEFORE any media moves and answers what will happen; anything
  over `INGEST_MAX_CLIP_SECONDS` (default 900s) is fetched head-first with
  yt-dlp's `--download-sections`, which uses the ffmpeg already required by the
  pipeline — no new dependency — and the delivered file's length is re-checked
  and cut locally if the extractor did not honour the section. Over-cap audio
  never reaches the paid analyze calls. The probe carries its own per-IP budget
  (`ingest-link`, `TTS_BUDGET_INGEST_LINK`, default 30 per 10 min); the scan
  itself shares the scan budget.

Neither failure is a dead end for the user: every refusal on this path names
the file-drop fallback, which needs no network at all. Link ingest is a
convenience on top of the upload flow, and nothing downstream depends on it.

Deployments that must not fetch anything from the internet can simply not use
the route — it is the only outbound-from-the-box path in ingest, and it is
allowlisted to `youtube.com`/`youtu.be` with every resolved address checked to
be publicly routable (`service/narrate.check_public_ip`, reused).

## Per-IP budgets, and who the service thinks you are

Every compute route carries a per-IP budget (`service/ratelimit.py`): the
drop-in `/v1/text-to-speech`, `/v1/speak`, `/v1/performance`, the clone route,
public re-perform and the anonymous take upload. Each is a fixed window plus a
1-second burst, and each is env-tunable:

| Budget | Env | Default | Route |
|---|---|---|---|
| `demo-tts` | `TTS_BUDGET_TTS` | 60 / 60s | `POST /v1/text-to-speech/{voice}` |
| `speak` | `TTS_BUDGET_SPEAK` | 120 / 60s | `POST /v1/speak` |
| `performance` | `TTS_BUDGET_PERFORMANCE` | 30 / 60s | `POST /v1/performance` |
| `demo-clone` | `TTS_BUDGET_CLONE` | 20 / 600s | the clone route |
| `take-upload` | `TTS_BUDGET_TAKE_UPLOAD` | 60 / 600s | `POST /v1/takes` (25 MB each) |
| `reperform` | — | 5 / 300s | `POST /v1/takes/{id}/reperform` |
| `ingest-scan` | `TTS_BUDGET_INGEST_SCAN` | 12 / 600s | `POST /v1/ingest/scan` |
| `ingest-audition` | `TTS_BUDGET_INGEST_AUDITION` | 40 / 600s | `POST /v1/ingest/{job}/audition` |

`ingest-scan` is the most expensive request the service takes from outside: two
duration-billed ElevenLabs calls, five to eight Gemini calls and a torch model
load. The ingest job cap (`INGEST_MAX_JOBS`) bounds how many run AT ONCE and
releases as soon as one finishes — it is not a rate limit, and a client that
waits its turn spends without one. The progress poller (`GET /v1/ingest/{job}`)
is deliberately unbudgeted: refusing the poller for the scan it is watching
would be worse than no budget at all.

**These defaults assume one address is a ROOM, not a person.** The studio
relays to the service server-side with the deployment's own key, so until you
turn proxy trust on, every studio visitor arrives as the studio host's single
address and shares one budget. Size them for the audience you expect at once.

### `TTS_TRUST_PROXY` — read it before you scale

`X-Forwarded-For` is honoured **only** when `TTS_TRUST_PROXY=1`, because any
client can send that header: on a directly-exposed port, trusting it lets every
caller pick their own bucket and the limiter becomes decoration. Turn it on
when — and only when — a proxy you control is the only thing that can reach the
service port.

Two consequences worth knowing before an incident:

- **With it OFF and a proxy in front** (the studio relay, or the launcher's
  `--router`), every caller in the world budgets as one address: the proxy's.
  The limits above become the limits for the entire internet, together.
- **With it ON**, the entry believed is the `TTS_TRUSTED_HOPS`-th from the
  RIGHT (default 1) — the address the last proxy you trust actually observed.
  Proxies append, so the leftmost entry is caller-typed text. Raise the count
  by one for each additional proxy of yours in front (a CDN, an ingress) and by
  no more: every hop you claim is one more entry a caller can forge.

`replicas.py`'s `--router` appends the caller's address to `X-Forwarded-For`, so
`TTS_TRUST_PROXY=1` + `TTS_TRUSTED_HOPS=1` is the correct pairing when the
router is your front door.

### Budgets across replicas

The pool is N processes, so an in-memory counter in one of them counts nothing
that happened in the others. The launcher exports `TTS_REPLICAS`, and with it
above 1 the budgets are counted **across** the processes through a small file
under `<data>/ratelimit/` (leased a few requests at a time under the same
cross-process lock the registry uses, so the request path touches it at most
once per lease and never once a budget is spent). Force it either way with
`TTS_RATELIMIT_SHARED=1|0`; point it elsewhere with `TTS_RATELIMIT_DIR`.

Running replicas some other way (a k8s Deployment, several containers) and want
one honest pool budget? Set `TTS_REPLICAS` to the replica count and give every
replica the same `TTS_RATELIMIT_DIR` on shared storage — or leave it, accept
per-replica budgets, and note that the 429 body will then say so out loud
(`... PER REPLICA — with 4 replicas the pool allows up to 240`).

## What the metrics port publishes

`--metrics-port` binds `--host` (routinely `0.0.0.0`); the per-replica admin
ports bind loopback and nothing else. So the launcher's front door applies one
rule: **capacity detail is loopback-only.**

- `GET /metrics` — public on any bind, unchanged: aggregated pool counters.
- `GET /introspect` — per-replica permits, queue depth, hot voices. Served on a
  loopback bind; **403 by name** on a public one.
- `GET /pool` — the full fold (per-replica entries, the voice→replica map, the
  drained set) on loopback; on a public bind it degrades to what `/metrics`
  already says, plus the routing mode, and marks itself `"restricted": true`.

Set `TTS_METRICS_PUBLIC_INTROSPECT=1` to publish it anyway — do that only when
the port is already behind your own auth. Nothing is hidden from an operator on
the box: `curl` it from `127.0.0.1`, or read the replicas' admin ports directly.

## Operating it

```bash
curl http://<ip>:8080/health                    # ready + live metrics
journalctl -u gravitone -f                      # service logs (on the box)
sudo systemctl restart gravitone                # restart
curl -sL .../bootstrap.sh | sudo -E bash        # upgrade to latest main
```

## 6. Rollback / teardown

Every path above creates things that outlive the thing you notice. `deploy/rollback.sh`
is the complete undo — **and it is the only one**: `aws-oneclick.sh terminate`
kills the instance and leaves the security group, orphaned volumes and your root
key file behind.

```bash
deploy/rollback.sh verify           # read-only: what exists, and what it costs you
deploy/rollback.sh cloud  --yes     # undo aws-oneclick.sh: instance + SG + volumes + key file
deploy/rollback.sh stack  --yes     # undo cloudformation.yaml: delete + wait for DELETE_COMPLETE
sudo deploy/rollback.sh box  --yes  # undo bootstrap.sh ON the box: unit, container, image, /etc, /opt
```

**Nothing is destroyed without `--yes`.** Bare, it prints the plan and exits —
so you can see the blast radius before you accept it.

| | |
|---|---|
| **Cloned voices survive** | `box` keeps the `gravitone-voices` / `gravitone-ingest` volumes so a bad upgrade can be re-bootstrapped without re-cloning. `--purge-voices` destroys them; that is not recoverable. |
| **Secrets are shredded** | `cloud` removes `.gravitone-deploy-key`; `box` removes `/etc/gravitone.env`. Both hold the root API key. |
| **It verifies itself** | Every `--yes` run ends by re-listing resources, so teardown is confirmed rather than assumed. |
| **It refuses to guess** | If AWS is unreachable it exits `2` instead of reporting an empty account — an unreachable account and a clean one look identical to a failed `describe`, and confusing the two is how a live instance gets recorded as gone. |

Order matters when rolling back by hand: **terminate and wait for the instance
before deleting the security group**, or the delete fails on a dependency
violation while an ENI still holds it. `rollback.sh` waits.

Rollback procedure for a bad *upgrade* (as opposed to a full teardown): on the
box, `sudo deploy/rollback.sh box --yes` (voices survive), then re-run
`bootstrap.sh` pinned to the last good commit with
`REPO=... git -C /opt/gravitone checkout <sha>` before the build step.
