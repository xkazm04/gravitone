// The backend's upload gate, mirrored in ONE place.
//
// service/ingest_api.py decides what may be ingested — `validate_upload_bytes`
// (empty / 50 MB / extension whitelist) and `check_duration` (floor, ceiling,
// and a fail-CLOSED stance on a length it could not read). The studio runs the
// same rules before it uploads so a 20-minute file does not spend 50 MB of the
// user's bandwidth to earn a 400 the client could have predicted.
//
// This is an OPTIMISATION FOR THE USER, never the enforcement point. The server
// re-runs every rule on the bytes, with ffprobe rather than a browser decoder,
// and its verdict is the one that counts.
//
// WHY A COPY AT ALL: nothing serves these numbers. GET /v1/ingest/modes serves
// sovereign_limits() and resolve_mode() but not the caps, and putting them there
// is a service/ change this wave cannot make. Until it does, this module — not
// a scattering of consts next to the validator and a hand-typed sentence in the
// dropzone — is the single web-side copy. The previous arrangement is exactly
// what let MAX_CLIP_SECONDS ship with no mirror at all.
//
// DRIFT: MAX_CLIP_SECONDS is Settings.ingest_max_clip_seconds (env
// INGEST_MAX_CLIP_SECONDS, default 900). A backend that overrides it disagrees
// with the number below; the disagreement can only cost a round-trip, because
// the client never admits what the server rejects — it only declines early.

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // ingest_api.MAX_UPLOAD_BYTES
export const MIN_CLIP_SECONDS = 3;                // ingest_api.MIN_CLIP_SECONDS
export const MAX_CLIP_SECONDS = 900;              // ingest_api.MAX_CLIP_SECONDS

/** ingest_api._AUDIO_EXTS. */
export const ACCEPTED_EXTS = [
  ".mp3", ".wav", ".wave", ".m4a", ".m4b", ".mp4", ".mov", ".ogg", ".oga",
  ".opus", ".flac", ".aac", ".webm", ".wma", ".aiff", ".aif", ".aifc",
  ".amr", ".3gp", ".mkv",
] as const;

/** Picker accept: broad mime families + every accepted extension. */
export const ACCEPT_ATTR = ["audio/*", "video/*", ...ACCEPTED_EXTS].join(",");

/** The caps, said out loud, from the same constants the check uses. */
export const LIMITS_HINT =
  `up to ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB · ` +
  `${MIN_CLIP_SECONDS}s to ${Math.round(MAX_CLIP_SECONDS / 60)} minutes of audio`;

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/** Size + type verdict, mirroring `validate_upload_bytes`. Null = acceptable. */
export function checkBytes(file: { size: number; name: string; type: string }): string | null {
  if (file.size === 0) return "empty file — choose an audio recording";
  if (file.size > MAX_UPLOAD_BYTES) {
    return `file too large — keep it under ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`;
  }
  const mimeOk = /^(audio|video)\//.test(file.type);
  if (!ACCEPTED_EXTS.includes(extOf(file.name) as typeof ACCEPTED_EXTS[number]) && !mimeOk) {
    return "unsupported file type — upload an audio or video recording";
  }
  return null;
}

/**
 * Duration verdict, mirroring `check_duration` — floor AND ceiling, and the
 * fail-closed stance on an unreadable length.
 *
 * The one place the mirror is deliberately NOT literal: the backend's `None`
 * means ffprobe failed, which means ffmpeg will fail too, so it refuses. The
 * browser's `null` means one of two very different things, and only one of them
 * is the backend's:
 *
 *   - the browser CAN decode this type but still produced no length → the file
 *     is damaged/truncated; refuse, exactly like the server would.
 *   - the browser cannot decode this type at all (.amr, .wma, .mkv … all of
 *     which ffprobe reads fine) → the length is unknown TO US, not unreadable.
 *     Refusing here would make the client an enforcement point, and a wrong
 *     one: it would block files the backend accepts. Let the server decide.
 */
export function checkDuration(
  seconds: number | null,
  browserCanDecode: boolean,
): string | null {
  if (seconds === null) {
    return browserCanDecode
      ? "couldn't read this recording's length — re-export it as WAV or MP3 and try again"
      : null;
  }
  if (seconds < MIN_CLIP_SECONDS) {
    return `clip too short — record at least ${MIN_CLIP_SECONDS} seconds of speech`;
  }
  if (seconds > MAX_CLIP_SECONDS) {
    return `recording too long — keep it under ${Math.round(MAX_CLIP_SECONDS / 60)} minutes ` +
      "(trim to the part you want cloned)";
  }
  return null;
}
