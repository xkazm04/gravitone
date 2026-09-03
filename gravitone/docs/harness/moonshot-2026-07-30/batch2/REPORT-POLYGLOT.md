# REPORT — POLYGLOT (The Polyglot Turn), Batch 2

> **APPLICATION RECORD (2nd pass):** POLYGLOT itself applied H1–H14 to convai.py after
> ZERO-GAP landed (orchestrator-authorized), incl. H14 into the new `_speculate`. TWO
> deviations, both fixing real defects its new socket test exposed: (1) `_Session._stamp()` —
> parts freeze their spoken language at direct-time, because rendering runs concurrently with
> the reply stream and sentence one was being spoken by sentence two's voice; (2) the refusal
> apology is stamped with the current language, not None. New `service/tests/test_polyglot_turn.py`
> (13 socket-driven tests: agents matrix, two engines in one turn at a sentence boundary,
> switch-back, no directive leakage, pre-warm at connect, transcriber pin dropped only for
> polyglot agents, refuse-once semantics, end_call → close 1000 after goodbye audio).
> Gate set (10 modules incl. test_zero_gap + test_gym) = 336 OK (2 skipped). Speculated
> replies/openers coerced to TurnPart; `_speculate` gets the same directing brief; pre-warm
> future kept separate from `_warming`.

> Saved by the orchestrator from the builder's inline report. Contains the FULL convai patch
> (H1–H14) to be applied by the orchestrator AFTER ZERO-GAP's convai edits land.

**Status: done.** `service/dialog.py` + `service/piper.py` + 3 test modules. Existing
dialog/claude/piper tests pass UNMODIFIED (the D1 safety proof) — 106 → 160 tests green;
py_compile clean. Full 981-test suite: 1 unrelated flake
(`test_longform.test_n_segments_occupy_n_workers_concurrently`, timing under load, passes
standalone).

## Key decisions
- `TurnPart` is a frozen dataclass **subclassing str** (`eq=False` → string equality/hash) —
  that IS the shim: every `" ".join`, `.strip()`, `synthesize_pcm(voice, part)` and every
  list-of-strings assertion keeps working.
- `[end_call]` arrives as a wordless part (`speakable() == False`) after the last sentence —
  holding sentences back would forfeit streaming latency.
- Directives stripped on the RAW TAIL — no chunk split can leak (tested at every cut point of
  `[lang:cs]`, one char at a time). Unknown/truncated → dropped + logged.
- Ear and mouth separate: `LanguageTracker.caller` moves on 2 confirmed utterances (informs
  the prompt only); `.language` moves only on the brain's `[lang:xx]`.
- TABLE-READ's `script` override: added to `apply_overrides` + `allow_overrides` defaults,
  lines may carry directives, round-trip test included.
- Emotion→Pocket voice-variant mapping deliberately NOT guessed (registry question); emotion
  rides on the part.

## New dialog.py API used by the patch
`TurnPart` (`.language/.emotion/.end_call/.speakable()/.directed()`), `language_tag`,
`LanguageTracker` (`.language/.caller/.heard/.directed/.declined` — install-this-voice demand
signal), `directing_prompt`, `switch_apology`, `Agent.languages/.switch_languages()/.honours()`;
`piper.prewarm(languages, voice_ids) -> {warmed, missing, skipped}` (capped at LRU bound,
reports instead of raising).

## THE CONVAI PATCH (apply after ZERO-GAP; anchored on names, verified against 1270-line convai.py)

H1. imports — add to the stdlib block (beside `import binascii`):
```
+import dataclasses
```

H2. new close code — beside _CLOSE_INTERNAL / _CLOSE_BUSY / _CLOSE_POLICY:
```
+_CLOSE_NORMAL = 1000   # the agent said goodbye; not a failure
```

H3. _describe_agent — replace the two return statements:
```
-    try:
-        voice, is_piper = _resolve_voice(agent)
-    except VoiceUnavailable as exc:
-        return dict(described, voice_id=None, tts=None, speakable=False,
-                    problem=str(exc))
-    return dict(described, voice_id=voice,
-                tts="piper" if is_piper else "pocket-tts", speakable=True)
+    described["languages"] = _speakable_matrix(agent)
+    try:
+        voice, is_piper = _resolve_voice(agent)
+    except VoiceUnavailable as exc:
+        return dict(described, voice_id=None, tts=None, speakable=False,
+                    problem=str(exc))
+    return dict(described, voice_id=voice,
+                tts="piper" if is_piper else "pocket-tts", speakable=True)
+
+
+def _speakable_matrix(agent: dialog.Agent) -> dict:
+    """Every language this agent declared, and whether there is a mouth for it.
+
+    A boolean cannot describe a bilingual agent: "speakable" for an agent that
+    speaks English and would follow a caller into Czech is true and useless. The
+    matrix is resolved through the SAME rule the session uses, so what this
+    surface promises is exactly what a mid-call switch will find.
+    """
+    matrix: dict[str, dict] = {}
+    base = dialog.language_tag(agent.language)
+    for tag in agent.switch_languages():
+        probe = agent if tag == base else dataclasses.replace(
+            agent, language=tag, voice_id="")
+        try:
+            voice, is_piper = _resolve_voice(probe)
+        except VoiceUnavailable as exc:
+            matrix[tag] = {"speakable": False, "voice_id": None, "tts": None,
+                           "problem": str(exc)}
+            continue
+        matrix[tag] = {"speakable": True, "voice_id": voice,
+                       "tts": "piper" if is_piper else "pocket-tts"}
+    return matrix
```

H4. _Session.__init__ — after `self.is_piper = False`:
```
         self.voice = ""
         self.is_piper = False
+        # Which language we are SPEAKING and which one we are HEARING; rebuilt in
+        # run() once overrides have landed, because an override may change both.
+        self.languages = dialog.LanguageTracker(agent)
+        # Resolved mouths per language, so a switch back and forth does not
+        # re-walk the voice directory every sentence.
+        self._mouths: dict[str, tuple[str, bool]] = {}
+        # Languages we already apologized for. One refusal per language per call:
+        # a whole Czech reply must not become five identical apologies.
+        self._refused: set[str] = set()
```

H5. run() — insert immediately BEFORE `await self._send({` / "conversation_initiation_metadata":
```
+            self.languages = dialog.LanguageTracker(self.agent)
             await self._send({
                 "type": "conversation_initiation_metadata",
```

H6. run() — extend the recorder.note(...) at connect:
```
                                language=self.agent.language,
+                               languages=self.agent.switch_languages(),
                                brain=backend().describe(), stt=stt.describe_model())
```

H7. run() — after the `self._warming = asyncio.ensure_future(...)` statement, before
`if self.agent.first_message:`:
```
+            # Keep the second mouth hot. The first sentence after a language
+            # switch is the one moment this feature is judged, and a cold ONNX
+            # load lands exactly there; here it overlaps the greeting instead.
+            declared = [l for l in self.agent.switch_languages()
+                        if l != dialog.language_tag(self.agent.language)]
+            if declared:
+                asyncio.ensure_future(asyncio.get_event_loop().run_in_executor(
+                    None, piper.prewarm, declared))
```

H8. _answer — replace the remember + reply block:
```
-        self._remember("user", text)
+        heard = dialog.language_tag(transcript.language_code)
+        switched = self.languages.heard(heard, transcript.language_probability)
+        if switched:
+            logger.info("convai %s: the caller is now speaking %s",
+                        self.conversation_id, switched)
+            self.recorder.note(caller_language=switched)
+        self._remember("user", text, language=heard)
         speculated = self._take_speculation(text)
         sentences = (_aiter(speculated) if speculated is not None
-                     else backend().reply(self.agent, list(self.history)))
+                     else backend().reply(self._directing_agent(heard),
+                                          list(self.history)))
         await self._speak(sentences, heard_at=t0)
```

H9. _transcribe — replace the body (+ add _directing_agent method):
```
-        return stt.transcribe_pcm(
-            utterance.pcm, rate=self.rate, language=self.agent.language or None,
-            hotwords=" ".join(self.agent.keywords) or None)
+        # Pinning the language is what makes a monolingual transcription
+        # accurate — and also what would stop the ear from ever REPORTING the
+        # switch this feature follows. So the pin is dropped exactly when the
+        # agent declared it would follow the caller, and kept otherwise.
+        pin = (None if len(self.agent.switch_languages()) > 1
+               else (self.agent.language or None))
+        return stt.transcribe_pcm(
+            utterance.pcm, rate=self.rate, language=pin,
+            hotwords=" ".join(self.agent.keywords) or None)
+
+    def _directing_agent(self, heard: str | None = None) -> dialog.Agent:
+        """The agent as the BRAIN sees it this turn.
+
+        The stored prompt stays the operator's text; the directing clauses (which
+        languages this call may switch into, which one the ear just heard, and the
+        directive grammar itself) are assembled per turn from what the session
+        knows right now.
+        """
+        return dataclasses.replace(self.agent, prompt=dialog.directing_prompt(
+            self.agent, speaking=self.languages.language, heard=heard))
```

H10. _speak — signature, the collect loop, and the hang-up:
```
-    async def _speak(self, sentences: AsyncIterator[str], *,
+    async def _speak(self, sentences: AsyncIterator[dialog.TurnPart], *,
                      full_text: str | None = None,
                      heard_at: float | None = None) -> None:
...
-        parts: list[str] = []
+        parts: list[dialog.TurnPart] = []
+        hang_up = False
         try:
-            async for sentence in sentences:
-                parts.append(sentence)
-                to_render.put_nowait(sentence)
+            async for part in sentences:
+                part = self._direct(part)
+                if part.end_call:
+                    hang_up = True
+                if not part.speakable():
+                    continue   # a pure direction: nothing to say, nothing to render
+                parts.append(part)
+                to_render.put_nowait(part)
             to_render.put_nowait(None)  # the reply is complete
...
                     first_audio = False
+            if hang_up:
+                # The brain wrote [end_call]. The closing words have already gone
+                # out, so this is the goodbye landing — 1000, not a failure code.
+                await self._close(_CLOSE_NORMAL, "the agent ended the call")
         except dialog.DialogError as exc:
```

H11. new methods — put them next to _synthesize:
```
+    def _mouth(self, language: str | None = None) -> tuple[str, bool]:
+        """Which voice speaks a part. One character, several engines.
+
+        Resolved through the SAME rule as connect, so a mid-call switch can never
+        reach a mouth the agents surface reported as absent. ``voice_id`` is
+        cleared for a non-native language on purpose: the agent's explicit voice
+        belongs to the language it was chosen for, and reusing it for another is
+        the mispronunciation this refuses.
+        """
+        tag = dialog.language_tag(language) or self.languages.language
+        if tag == dialog.language_tag(self.agent.language):
+            return self.voice, self.is_piper
+        found = self._mouths.get(tag)
+        if found is None:
+            found = _resolve_voice(dataclasses.replace(
+                self.agent, language=tag, voice_id=""))
+            self._mouths[tag] = found
+        return found
+
+    def _direct(self, part: dialog.TurnPart) -> dialog.TurnPart:
+        """Honour one part's direction, or refuse it out loud.
+
+        Called once per part, and a part is a sentence — which IS the mitigation
+        for the audible seam: the mouth can only change where a sentence ended.
+        """
+        if not isinstance(part, dialog.TurnPart):
+            part = dialog.TurnPart(str(part))   # a speculated line, or an opener
+        wanted = part.language
+        if not wanted or wanted == self.languages.language:
+            return part
+        if wanted in self._refused:
+            # Already apologized for this one; the rest of the reply is dropped
+            # rather than read with the wrong phonemes or apologized for again.
+            logger.info("convai %s: dropping an unspeakable %s sentence",
+                        self.conversation_id, wanted)
+            return dataclasses.replace(part, text="", language=None)
+        problem = None
+        try:
+            voice, is_piper = self._mouth(wanted)
+        except VoiceUnavailable as exc:
+            problem = str(exc)
+        else:
+            if self.languages.directed(wanted) is not None:
+                logger.info("convai %s: the mouth follows the brain into %s "
+                            "(%s, %s)", self.conversation_id, wanted, voice,
+                            "piper" if is_piper else "pocket-tts")
+                self.recorder.note(spoken_language=wanted)
+                return part
+            problem = (f"agent '{self.agent.agent_id}' did not declare {wanted!r} "
+                       "among its languages")
+        logger.warning("convai %s: refusing a switch into %s (%s)",
+                       self.conversation_id, wanted, problem)
+        self._refused.add(wanted)
+        # Spoken in the language we CAN still speak. end_call and emotion are
+        # preserved, so a refused switch cannot swallow a hang-up.
+        return dataclasses.replace(part, text=dialog.switch_apology(
+            self.languages.language, wanted), language=None)
```

H12. _remember — accept the heard language:
```
-    def _remember(self, role: str, content: str) -> None:
-        self.history.append({"role": role, "content": content})
+    def _remember(self, role: str, content: str, language: str | None = None) -> None:
+        # The language annotation is for the BRAIN only (it cannot follow the
+        # caller without being told). dialog.OpenAiCompatBackend strips it before
+        # the wire; ClaudeCliBackend renders it as "Candidate [cs]:".
+        turn = {"role": role, "content": content}
+        if language:
+            turn["language"] = language
+        self.history.append(turn)
         if len(self.history) > _HISTORY_MAX:
             del self.history[:len(self.history) - _HISTORY_MAX]
```

H13. _synthesize / _synthesize_piper — per-part mouth + per-engine resample:
```
-        if self.is_piper:
+        voice, is_piper = self._mouth(getattr(text, "language", None))
+        if is_piper:
             return await asyncio.get_event_loop().run_in_executor(
-                None, self._synthesize_piper, text)
+                None, self._synthesize_piper, str(text), voice)
         engine = _engine_provider()
         if engine is None:
             raise RuntimeError("the synthesis engine is not running")
-        job = engine.submit(voice_id=self.voice, text=text, overrides={})
+        job = engine.submit(voice_id=voice, text=str(text), overrides={})
...
-    def _synthesize_piper(self, text: str) -> bytes:
+    def _synthesize_piper(self, text: str, voice: str | None = None) -> bytes:
...
-        pcm, rate = piper.synthesize_pcm(self.voice, text)
+        pcm, rate = piper.synthesize_pcm(voice or self.voice, text)
```

H14 (OPTIONAL, ZERO-GAP's _speculate) — so a speculated turn gets the same brief:
```
-            async for sentence in backend().reply(self.agent, history):
+            async for sentence in backend().reply(self._directing_agent(), history):
```
