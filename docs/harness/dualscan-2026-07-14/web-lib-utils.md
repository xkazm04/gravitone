# Dual-lens scan — web-lib-utils
> Files: 6 | Findings: 5 (crit 0 / high 1 / med 4 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Consent-provenance write silently lost while clone succeeds
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: silent-failure
- **File**: `web/lib/voiceVault.ts:74`
- **Scenario**: A user clones a voice, the TTS backend creates it successfully, then the Firestore `setDoc` at `users/{uid}/voices/{voice_id}` fails (offline, rules denial, quota, transient). Each write is wrapped in `.catch((e) => console.warn(...))`, so `recordVoiceOwnership` resolves normally and the clone flow reports success.
- **Root cause**: The function is deliberately "never throws — provenance must not break the clone flow," but it also has no fallback queue, retry, or user-visible signal. For a consent-first product the consent receipt is the record of what the user attested, yet its persistence is best-effort and unobserved.
- **Impact**: A usable cloned voice exists in the engine with NO consent/ownership record. "My Voices" silently omits it and there is no attestation trail if consent is later questioned. Failures are invisible to both user and operator beyond a console line.
- **Fix sketch**: Collect settled results (`Promise.allSettled`), and on any rejection surface a non-blocking "provenance not saved — retry" state to the caller and/or enqueue a retry (e.g., localStorage outbox flushed on next load). At minimum return a boolean/summary so the clone flow can warn.

## 2. Vault consent receipt stores a divergent statement, not the canonical attestation
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/lib/voiceVault.ts:17`
- **Scenario**: `consent.ts:6` declares `CONSENT_STATEMENT` the single source of truth — "stored verbatim in each voice's consent receipt … Keep this the single source of truth; do not inline a divergent copy anywhere." The vault (the per-voice consent receipt, with a `consent.statement` field) instead stores `CONSENT_STATEMENTS[method]` (a method descriptor), and `CONSENT_PROMPT` (line 26) is a third, differently worded paraphrase of the same attestation.
- **Root cause**: Two consent-record systems evolved independently (backend receipt via `consent.ts` vs Firestore vault via `voiceVault.ts`), so the vault's stored `statement` is not the verbatim text the user agreed to, directly contradicting the canonical-source directive.
- **Impact**: The provenance ledger does not reflect the exact attestation the user accepted; three phrasings of "do you consent" drift independently, and a wording change in `consent.ts` never reaches the vault records.
- **Fix sketch**: Store `CONSENT_STATEMENT` (imported from `consent.ts`) verbatim in the vault receipt, keeping the method descriptor as a separate `methodNote` field; derive `CONSENT_PROMPT` from the same constant rather than re-inlining it.

## 3. markRevoked failure leaves vault out of sync with the deleted voice
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: silent-failure
- **File**: `web/lib/voiceVault.ts:95`
- **Scenario**: User revokes a voice: the API deletes the underlying voice file, then `markRevoked` updates the vault to `revoked:true`. If that `updateDoc` fails, the `.catch` swallows it (`console.warn` only) and the caller sees no error.
- **Root cause**: The revoke path is two independent, non-atomic steps (engine delete + ledger mark) with the ledger step best-effort. There is no reconciliation between the engine state and the vault record.
- **Impact**: "My Voices" keeps listing the voice as active (`revoked:false`) even though its file no longer exists in the engine. The user believes it is still usable; any later synthesis with it fails, and the provenance ledger misreports revocation status.
- **Fix sketch**: Let `markRevoked` reject (or return a status) so the UI can show "revocation not fully recorded — retry," and/or reconcile vault entries against the engine's voice list on load, flagging entries whose file is gone.

## 4. Savings clamped to $0 hides a net loss at low volume
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: money-honesty
- **File**: `web/lib/switchkit.ts:62`
- **Scenario**: Slide the calculator down to Starter-tier volume (~30k chars). `elUsd` = $5/mo but the Arm box runs 24/7 at `0.0168 × 730` = $12.26/mo. `savingsUsd = Math.max(0, elUsd - boxUsd)` clamps the –$7.26 result to 0, and `SwitchKit.tsx:91-96` renders an emerald "you keep $0.00/mo · $0.00/yr" pill.
- **Root cause**: The comparison is ElevenLabs' marginal tier price vs an always-on box; below the crossover the box is more expensive, but the clamp plus positive "you keep" framing never expresses a loss.
- **Impact**: At low/mid volume the calculator implies break-even when the user would actually pay more with an always-on box — a misleading claim in the core money/marketing path (the two raw numbers are shown, but the highlighted takeaway contradicts them).
- **Fix sketch**: Drop the clamp for display purposes and, when `boxUsd > elUsd`, switch the pill copy/color to show the extra cost or a "worth it above ~N chars/mo" break-even hint instead of a green "$0 kept."

## 5. scriptFor silently serves the baseline script for any uncovered emotion
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: latent-failure
- **File**: `web/lib/emotionScripts.ts:108`
- **Scenario**: The file comment requires `EMOTION_SCRIPTS` to cover every id in `lib/emotions.ts` / the service `EMOTION_SCALE`. If an emotion is added to the scale (e.g. "terrified") without a matching script, `scriptFor` falls back to a generic direction plus `EMOTION_SCRIPTS.baseline.script`.
- **Root cause**: The keep-in-sync requirement is enforced only by a comment — there is no assertion or test — and the fallback substitutes neutral baseline text rather than failing loudly.
- **Impact**: During guided capture the user reads a calm, everyday "baseline" passage while trying to convey a strong emotion, producing a poor reference clip for that mood, with no signal that a script was missing. Silent, hard-to-diagnose quality regression.
- **Fix sketch**: In dev, assert `EMOTION_SCRIPTS` covers the emotion id set (or add a unit test iterating `EMOTIONS`); for the runtime fallback keep the generic direction but surface a visible "no tuned script for this emotion" note so the gap is obvious.
