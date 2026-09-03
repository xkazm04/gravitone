# Deploy rehearsal — 2026-08-05

A record of walking `deploy/README.md` the way a judge would: verbatim, on a
clean machine, without insider knowledge.

**Headline: the rehearsal did not reach a running service.** AWS credentials on
the rehearsal machine had expired, so no instance was launched and **no
performance number in this document is measured — because none was measured.**
What the run did produce is better than nothing and worse than a green tick:
executing the documented first command surfaced **three real defects**, one of
them a security bug, all of which are fixed here.

Read this as: *the deploy path has now been exercised far enough to find its
bugs, and not far enough to certify its numbers.*

## Status of the published `t4g.small` figure

`README.md`, `deploy/README.md` and `docs/SUPPORTED_HARDWARE.md` all publish
**1.33× realtime** for `t4g.small`. **This rehearsal neither confirmed nor
contradicted that figure** — it never got as far as synthesising audio. The
number's provenance remains what `SUPPORTED_HARDWARE.md` already admits:
*"measured (2026-07, project benchmarks; no certificate checked in)"* — i.e. an
observation with no certificate behind it.

Nothing here should be read as corroboration. An end-to-end cloud measurement
with a checked-in certificate is still outstanding, and remains the single most
valuable missing piece of evidence for a Track 2 (Cloud AI) submission.

## What was actually run

```bash
aws --version                 # aws-cli/2.35.20 — installed
aws sts get-caller-identity   # FAILED: "Your session has expired."
```

Credentials were not repaired (out of scope and off-limits for this run), so
everything below is either (a) the documented path executed against a
non-functioning credential, which is exactly how it behaves for anyone whose
setup is incomplete, or (b) static review of the scripts and template.

## Finding 1 — the one-click script could not fail (CRITICAL, fixed)

`deploy/README.md` §1 says the first command is:

```bash
deploy/aws-oneclick.sh up
```

Run verbatim, every AWS call inside it failed. The script did not stop. Real
transcript, trimmed:

```
aws: [ERROR]: The config profile (gravitone) could not be found
created security group  (8080 open to 109.81.88.29/32)     <- empty group id
aws: [ERROR]: The config profile (gravitone) could not be found
launching t4g.small from  ...                              <- empty AMI
aws: [ERROR]: The config profile (gravitone) could not be found
launched                                                   <- empty instance id
waiting for public IP ...
waiting for the service (docker build + model load, usually 4-8 min) ...
```

It then sat in two unguarded retry loops — 30 × 5s for the IP, 120 × 10s for
health, **20 minutes 10 seconds** — and proceeded to the final heredoc, which
has no guard and no exit before it, printing:

```
Your Private ElevenLabs:
  Base URL   : http://:8080
```

**Root cause.** Line 20 is `set -uo pipefail` — note the absent `-e`. No command
substitution in the script was checked for failure or for an empty result, so
six consecutive API errors propagated as empty strings straight into a success
banner.

Why this matters more than an ordinary bug: a deploy script that reports success
when nothing was deployed is worse than one that crashes. The operator's next
move is to debug a *network* problem against a URL with no host in it.

**Fixed.** `aws-oneclick.sh` now runs an `sts get-caller-identity` preflight
before anything else and hard-fails on every empty capture (`die`/`require`).
The identical broken-credential run now ends in **4.5 seconds**:

```
!! cannot authenticate to AWS with profile "gravitone" in us-east-1:
   aws: [ERROR]: The config profile (gravitone) could not be found
   Set up the profile first (see aws/README.md step 3: aws configure --profile gravitone),
   or point at an existing one:  PROFILE=default deploy/aws-oneclick.sh up
```

## Finding 2 — the root API key lands in the repo, ungitignored (SECURITY, fixed)

`aws-oneclick.sh` mints the deployment's root key into `.gravitone-deploy-key`
**in the current working directory** — and the README tells you to run it from
the repo root. The failed rehearsal run above created exactly that file:

```
?? gravitone/.gravitone-deploy-key       # untracked... and NOT ignored
$ git check-ignore -v gravitone/.gravitone-deploy-key
$ echo $?
1                                        # no rule matched
```

A live root credential, sitting in a git working tree, one `git add -A` away
from being published. It was also minted *before* the script knew whether it
could deploy anything at all.

**Fixed** on both axes: `.gravitone-deploy-key` added to `gravitone/.gitignore`,
and the preflight now runs before `api_key()`, so a failed launch no longer
leaves a stray secret behind. `deploy/rollback.sh` shreds the file as part of
teardown. (The file created during this rehearsal was destroyed; it never
protected anything, as no instance existed.)

## Finding 3 — nothing could be reached to debug it if it broke

Neither launch path attaches a way in:

| Path | SSH key pair | SSM instance profile | Result if bootstrap fails |
|---|---|---|---|
| `aws-oneclick.sh` | none | none | unreachable |
| `cloudformation.yaml` | none | none | unreachable |

`cloudformation.yaml` line 43 even describes its security group as
`"no inbound SSH (use SSM)"` — but the template declares no
`IamInstanceProfile`, so the instance never registers with SSM. **The stated
debugging channel does not exist.**

The practical consequence: if `bootstrap.sh` fails inside UserData (a build
error, an ARM64 wheel problem, a rate-limited clone), the operator's only
recourse is to terminate and retry blind. `/var/log/cloud-init-output.log` — the
file both scripts point at — is on a box nobody can log into.

Not fixed here: attaching an SSM profile means shipping the IAM role in the
template, which changes the stack's required capabilities and deserves its own
decision. **It is the highest-value remaining gap in the deploy path** and is
now flagged in the failure message the script prints.

## Finding 4 — `aws/iam-policy.json` grants the wrong direction

The policy grants `ec2:AuthorizeSecurityGroupEgress`. The code
(`aws-oneclick.sh`, `ensure_sg`) calls **`AuthorizeSecurityGroup*Ingress*`**,
which the policy does not grant. Under the documented `gravitone` profile the
group is created and then **port 8080 is never opened** — a launch that appears
to work and produces an endpoint nothing can reach.

`deploy/README.md` §1 compounds it by saying you need `ec2:CreateSecurityGroup`
*and* `ec2:AuthorizeSecurityGroupIngress` "on top of `aws/iam-policy.json`" —
but `CreateSecurityGroup` is *already* in the policy, so the sentence trains the
reader to distrust an accurate list, and the one permission genuinely missing is
buried next to one that is not.

Not silently repaired: the policy is the account-owner's blast-radius contract
and widening it is their call. `ensure_sg` now fails with the exact missing
permission named, instead of leaving a half-configured group behind.

## Finding 5 — the CloudFormation path needs permissions the policy lacks

`deploy/README.md` §2 is presented as an equal alternative and is the
"marketplace-shaped path". The `gravitone` profile from `aws/README.md` cannot
run it: `iam-policy.json` grants no `cloudformation:*` at all. Section 2 is
usable only with a broader (e.g. admin) credential — which the README does not
say.

Also note `AllowedCidr` defaults to `0.0.0.0/0` (world-open on 8080, key-gated
but publicly reachable) whereas `aws-oneclick.sh` defaults to your own `/32`.
Two documented paths, opposite security postures, no mention of the difference.

## Finding 6 — multiple instances produce one nonsense id (fixed)

`find_instance` queried `Reservations[].Instances[0].InstanceId` and piped it
through `tr -d '[:space:]'`. With two matching reservations that *concatenates*
the ids — `i-0abci-0def` — which is then passed to `stop`/`terminate`. Fixed to
take the first id explicitly.

## What did verify cleanly

Not everything was broken. Confirmed working:

- **The bootstrap URL resolves.** Both `aws-oneclick.sh` UserData and
  `cloudformation.yaml` fetch
  `https://raw.githubusercontent.com/xkazm04/gravitone/main/gravitone/deploy/bootstrap.sh`
  → **HTTP 200**. The `gravitone/` path prefix is correct for this repo layout
  (the bare `/deploy/bootstrap.sh` variant 404s, and the script's own
  `CLONE_DIR`/`APP_DIR` comment shows this trap was already found and fixed once).
- **`bootstrap.sh` guards its own assumption** — it checks `uname -m` is
  `aarch64` and that `$APP_DIR/Dockerfile` exists before building, and exits
  with a named reason otherwise. This is the standard the rest of the deploy
  path should have been held to.
- **`cloudformation.yaml` resolves its AMI via SSM public parameter**, which is
  more robust than `aws-oneclick.sh`'s `describe-images` + sort.

## Reproducing this rehearsal properly

The sequence a judge (or the next session) should run once credentials are live.
**Nothing below has been executed end to end** — it is the corrected path, not a
transcript.

```bash
# 0. verify you can reach AWS AT ALL (the step whose absence caused Finding 1)
aws sts get-caller-identity

# 1. launch (t4g.small, free-tier). Use an existing profile if you skipped
#    aws/README.md's one-time setup:
PROFILE=default deploy/aws-oneclick.sh up

# 2. probe. Substitute the printed base URL and key.
curl -s "$BASE/health"
curl -s -H "xi-api-key: $KEY" "$BASE/v1/voices"
curl -s "$BASE/metrics" | head

# 3. the measurement that matters — capture the timing headers
curl -sS -D headers.txt -X POST "$BASE/v1/text-to-speech/alba" \
  -H "xi-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"text":"My own voice cloud, on one Arm box."}' --output hello.wav
grep -iE 'X-Audio-Seconds|X-Synth-Seconds|X-Realtime-Factor' headers.txt
file hello.wav        # must say "RIFF (little-endian) data, WAVE audio"

# 4. TEAR DOWN — and verify, don't assume
deploy/rollback.sh verify
deploy/rollback.sh cloud --yes
```

Record in this file, replacing the placeholders: wall-clock from `up` to first
`/health` 200 (the README claims 4-8 min; **unverified**), the observed
`X-Realtime-Factor` against the published 1.33×, and whether `hello.wav` is a
valid RIFF/WAVE.

If the observed factor is below 1.33×, **publish the lower number.** A `t4g` is
burstable: a fresh instance runs on accumulated CPU credits and a sustained run
will drift down as they deplete. Any single-shot figure is an optimistic one,
and the honest framing is a range with the credit state named.

## Rollback

There was none. `aws-oneclick.sh terminate` killed the instance and left the
security group, any orphaned volume, and the root-key file; the on-box install
(`bootstrap.sh`, `airgap-install.sh` — systemd unit, image, `/etc/gravitone.env`
holding the root key, `/opt/gravitone`, two named volumes) had no documented
undo at all.

`deploy/rollback.sh` now covers both halves. See
[`deploy/README.md` §6](../deploy/README.md#6-rollback--teardown) for the
procedure.

**Tested:** the enumeration, dry-run and `--yes` paths were exercised against a
stubbed AWS CLI (fake instance/SG/volume ids), plus one real destructive action
— shredding the rehearsal's own `.gravitone-deploy-key`, verified gone.
**Untested against live AWS**, for the same reason as everything else here: the
`terminate → wait → delete-security-group` ordering and the CloudFormation
`stack-delete-complete` wait have not faced real API latency or a real
dependency-violation error.

## Teardown status for this rehearsal

**No AWS resources were created, so none required teardown.** Every API call
failed authentication before reaching AWS. This is asserted from the transcript
above rather than from a post-run `describe-instances`, because the same expired
credential that prevented the launch also prevents the confirming query — an
important caveat, and precisely the ambiguity `rollback.sh`'s preflight now
refuses to paper over: it aborts with exit 2 rather than reporting an
unreachable account as an empty one.

Local artifacts created and destroyed: `gravitone/.gravitone-deploy-key`
(shredded; now gitignored).

## Open items

1. **Run this rehearsal for real.** Everything above is a bug report; a Track 2
   submission needs a transcript. Highest priority.
2. **Attach an SSM instance profile** to both launch paths (Finding 3) — without
   it, the first real failure is undiagnosable.
3. **Fix `iam-policy.json`'s Ingress/Egress** and correct §1 of the deploy
   README (Finding 4).
4. **Say that §2 needs CloudFormation permissions** the documented profile lacks,
   and reconcile the two paths' opposite CIDR defaults (Finding 5).
5. **Certify `t4g.small` end to end** and check the certificate in, so the
   published 1.33× stops resting on an uncertified observation.
