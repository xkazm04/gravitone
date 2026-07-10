// Per-emotion elicitation scripts for guided capture. Each is a ~30-60s read
// engineered to pull the target emotion out of an untrained speaker: concrete
// scenario, escalating lines, performable punctuation. Pocket TTS captures
// whatever prosody is in the reference audio, so the script IS the knob.
//
// Must cover every id in lib/emotions.ts EMOTIONS (= service EMOTION_SCALE).

export type EmotionScript = {
  emotion: string;
  direction: string; // one-line acting note shown above the script
  script: string;
};

export const EMOTION_SCRIPTS: Record<string, EmotionScript> = {
  baseline: {
    emotion: "baseline",
    direction: "Your natural voice — relaxed, conversational, unhurried. This is the anchor every other emotion falls back to.",
    script:
      "Hi, this is my everyday voice. I'm just talking the way I normally would, " +
      "like I'm explaining something to a friend across the table. The weather's been " +
      "decent lately, I've been keeping busy, and there's fresh coffee in the kitchen. " +
      "Nothing dramatic — just me, speaking naturally, at my own pace, " +
      "with the kind of tone I'd use on any ordinary afternoon.",
  },
  calm: {
    emotion: "calm",
    direction: "Slow everything down. Longer pauses, softer landings, like guiding a meditation.",
    script:
      "Take a slow breath in… and let it go. There's nowhere you need to be right now. " +
      "The evening settles in quietly, the light turns gold, and everything can wait. " +
      "Let your shoulders drop. Notice how still the room is. " +
      "One thing at a time, gently, without any rush at all. " +
      "It's all going to unfold exactly as it should.",
  },
  happy: {
    emotion: "happy",
    direction: "Smile while you read — it changes the sound. Warm, bright, easy.",
    script:
      "Oh, this is such a good day! The sun is out, the coffee is perfect, " +
      "and my favorite song just came on. You know that feeling when everything " +
      "clicks into place? That's today. We're getting the whole crew together this " +
      "weekend, the garden is finally blooming, and honestly — I can't stop smiling. " +
      "Life is genuinely good right now.",
  },
  excited: {
    emotion: "excited",
    direction: "Big energy, faster pace, punch the exclamations. You just got incredible news.",
    script:
      "No way — no WAY! It actually happened! We got it, we actually got it! " +
      "I've been waiting months for this and it's finally here! Pack your bags, " +
      "because we leave Friday! This is going to be the best trip of our lives — " +
      "I can barely sit still! Call everyone, tell them the news — " +
      "this changes everything!",
  },
  sad: {
    emotion: "sad",
    direction: "Let the voice drop and slow. Heavy pauses, falling sentences, quiet at the edges.",
    script:
      "I keep thinking about the last time we spoke… and I didn't know it would be the last. " +
      "The house feels so quiet now. Their coat is still hanging by the door, " +
      "and I can't bring myself to move it. Some mornings I forget, just for a second… " +
      "and then I remember, and it all comes back. " +
      "I really thought we'd have more time.",
  },
  angry: {
    emotion: "angry",
    direction: "Tight jaw, hard consonants, controlled fury building to a boil. Don't shout — seethe.",
    script:
      "Are you serious right now? We had a deal. I held up my end — every single part of it — " +
      "and you just threw it away without even a phone call. Do you have any idea " +
      "what that cost me? No. Don't. I don't want another excuse. " +
      "I have had it up to HERE with the excuses. " +
      "This ends today. Right now. Do you understand me?",
  },
  whisper: {
    emotion: "whisper",
    direction: "Actually whisper — real breath, no voice. Lean into the mic like sharing a secret at midnight.",
    script:
      "Shhh… keep your voice down. They're in the next room and I don't want them to hear. " +
      "Listen carefully, because I'm only going to say this once. " +
      "The key is under the third flowerpot on the left. Wait until the lights go out, " +
      "count to twenty, and then move — quietly. " +
      "Not a word of this to anyone. Promise me.",
  },
  confused: {
    emotion: "confused",
    direction: "Rising question marks, halting rhythm, genuine puzzlement. Re-read things that don't add up.",
    script:
      "Wait… what? That doesn't make any sense. It was right here a minute ago — " +
      "I literally just put it down. Hold on, let me think. If the meeting was moved to " +
      "Tuesday… then who did I talk to on Monday? And why would she say the report was " +
      "finished when… hmm. Am I losing my mind, or did the schedule just change again? " +
      "I genuinely have no idea what's going on anymore.",
  },
};

/** Recording order for the guided session: baseline first, then the moods
 *  developers request most in scripts. */
export const CAPTURE_ORDER = [
  "baseline", "excited", "sad", "angry", "calm", "happy", "whisper", "confused",
];

export function nextEmotionToRecord(filled: string[]): string | null {
  return CAPTURE_ORDER.find((e) => !filled.includes(e)) ?? null;
}

export function scriptFor(emotion: string): EmotionScript {
  return (
    EMOTION_SCRIPTS[emotion] ?? {
      emotion,
      direction: `Read in a strongly ${emotion} tone of voice, and keep it consistent.`,
      script: EMOTION_SCRIPTS.baseline.script,
    }
  );
}
