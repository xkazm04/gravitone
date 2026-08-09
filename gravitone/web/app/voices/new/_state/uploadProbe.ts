"use client";

import { checkBytes, checkDuration } from "./uploadLimits";

// ── client-side upload pre-check ──────────────────────────────────────────────
// The rules and the numbers live in _state/uploadLimits.ts — ONE mirror of the
// backend gate. Only the browser-side probing lives here.

/** Can this browser decode the type at all? Decides what an unknown duration
 *  MEANS: a broken file (it can, and still got nothing) or simply a container
 *  the browser does not speak while ffprobe does (.amr, .wma, .mkv …). */
function browserCanDecode(file: File): boolean {
  if (!file.type) return false;
  try {
    return document.createElement("audio").canPlayType(file.type) !== "";
  } catch {
    return false; // no verdict available → the server's probe is the only one
  }
}

// Probe duration by loading metadata into a throwaway <audio> element.
// Resolves null when the browser can't determine it (backend re-probes).
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("audio");
    a.preload = "metadata";
    let settled = false;
    const finish = (v: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(t); URL.revokeObjectURL(url); a.removeAttribute("src"); resolve(v);
    };
    // Some containers the backend accepts (mkv/amr/…) may never fire an event
    // in the browser — never block the picker: fall back to "unknown" (null),
    // and let the server re-probe.
    const t = setTimeout(() => finish(null), 4000);
    a.onloadedmetadata = () => finish(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => finish(null);
    a.src = url;
  });
}

export async function validateUpload(file: File): Promise<string | null> {
  const bytes = checkBytes(file);
  if (bytes) return bytes;
  // Floor AND ceiling, and fail-closed on a length the browser should have been
  // able to read: a 20-minute recording used to upload 50 MB to earn a 400.
  return checkDuration(await probeDuration(file), browserCanDecode(file));
}
