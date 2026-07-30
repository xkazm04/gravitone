# REPORT — APPLIANCE (Sealed Appliance), Batch 3

> Saved by the orchestrator from the builder's inline report.

**Status: DONE** (E6 + Dockerfile bake + airgap + CI authored).
**⚠ NOT-BUILD-TESTED:** no image was ever built — Windows x86 host, aarch64-only base, no
docker. Dockerfile + sealed.yml are structural review only; sealed.yml labelled
authored-never-run in-file. Model-licence redistribution = listed legal TODO (workflow
header + manifest `license_review`).

Files:
- `service/appliance.py` (new) + `service/tests/test_appliance.py` (new, 30 tests)
- `Dockerfile` rewritten: base/bake/nobake/models/runtime stages; installs
  `-r requirements.txt` under a pinned-torch constraint that FAILS the build if pip replaces
  the Arm torch; build-time capability import gate; `MODELS_STAGE=nobake` +
  `HF_HUB_OFFLINE=0` = slim variant.
- `requirements.txt` (comments only), `deploy/gravitone-unit.sh` (new shared unit lib),
  `deploy/bootstrap.sh` (sources it — unit text exists once), `deploy/README.md` §4,
  `scripts/airgap-install.sh` (save/verify/install), `.github/workflows/sealed.yml`.

Tests: test_appliance + test_pack_safety + test_private_surface = 62/62; py_compile ok;
bash -n clean on all touched .sh + every extracted run: step of sealed.yml. Full-suite noise:
test_cache single-flight timing (nobody's files — check at final gate).

Router wiring (applied by orchestrator):
`from service.appliance import router as appliance_router`
`app.include_router(appliance_router, dependencies=[Depends(require_scope("admin"))])`
(admin = fail-closed default; revisit to `tts` if the studio should read it.)

Hooks: none.
