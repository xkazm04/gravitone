# REPORT — TABLE-READ (Table Read / Live mode), Batch 2

> Saved by the orchestrator from the builder's inline report.

**Status: complete.** 9 files, all inside §4 scope. page.tsx untouched (console is the mount point).

Files: `web/app/api/convai/{signed-url,agents}/route.ts` (+signed-url test);
`web/app/playground/_live/{pcm,worklet,conversation,LiveStage}` (+3 colocated tests).

Gates: tsc clean. Full vitest 37 files / 436 tests / 0 failed (the PlaygroundConsole flake
passed that run). Own files: 51 tests.

## Mount diff for PlaygroundConsole.tsx (orchestrator applies after PUNCH-IN lands)
```diff
@@ after import TakeCode from "./TakeCode";
+import LiveStage from "../_live/LiveStage";
@@ after const [mode, setMode] = useState<"solo" | "script">("solo");
+  const [liveOn, setLiveOn] = useState(false); const [liveActive, setLiveActive] = useState(false);
@@ inside the mode-toggle flex, after the solo/script map's ))}
+              <button onClick={() => setLiveOn((v) => !v)} aria-pressed={liveOn}
+                title="Talk to this Character in real time — every turn becomes a take"
+                className={`rounded-full border px-2.5 py-0.5 transition ${liveOn ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200" : "border-transparent text-white/50 hover:text-white/80"}`}>live</button>
@@ after the </div> closing the composer/expression grid, before {/* takes log */}
+      {liveOn && (
+        <LiveStage characters={characters} charId={charId} generateBusy={busy} onTake={addTake}
+          onScript={(lines) => { setScript(lines); setMode("script"); }} scriptLines={script}
+          onActiveChange={setLiveActive} />
+      )}
@@ the generate Button
-              <Button onClick={generate} disabled={busy || !canGenerate}
+              <Button onClick={generate} disabled={busy || liveActive || !canGenerate}
```

## UX decisions
Character rail REUSED (LiveStage reads charId; agent voice overridden with that Character's
baseline voice_id — a character id is not an engine voice id). Refusals named before dialling:
CONVAI_ENABLED=0, "Line busy" (matches the socket's 1013 close), "the engine is rendering —
same cores", agent's own `problem`, denied mic, no AudioWorklet. Agent turns become real Takes
(PCM→WAV→computePeaks) with rtf: 0, empty segments, absent format — absent, not
zero-dressed-as-measured. Barge-in keeps the whole reply, marks it `interrupted`. Headphones
advisory always (no AEC), never blocking.

## Hooks
1. "Rehearse this script" with NO LLM blocked at the service: `dialog.apply_overrides` accepts
   only prompt/first_message/language/voice_id and there's no agent-create endpoint. Fix = one
   field in dialog.py: accept `override["script"]` (list[str]) + "script" in
   `Agent.allow_overrides` defaults. → RELAYED to POLYGLOT mid-flight by the orchestrator.
2. `_live/pcm.ts::encodeWav` duplicates PUNCH-IN's forthcoming `lib/wavEncode.ts` header
   writer — merge candidate after both land.
3. Deployment: signed_url names the SERVICE origin; behind a proxy set `CONVAI_PUBLIC_URL`
   (named verbatim in the transport refusal).
