import { describe, expect, it } from "vitest";
import {
  ACCEPT_ATTR, LIMITS_HINT, MAX_UPLOAD_BYTES, checkBytes, checkDuration,
} from "./uploadLimits";

const ok = { size: 1_000_000, name: "take.mp3", type: "audio/mpeg" };

describe("checkBytes", () => {
  it("accepts a normal recording", () => {
    expect(checkBytes(ok)).toBeNull();
  });

  it("rejects an empty file", () => {
    expect(checkBytes({ ...ok, size: 0 })).toMatch(/empty/);
  });

  it("rejects over the byte cap and names it", () => {
    const msg = checkBytes({ ...ok, size: MAX_UPLOAD_BYTES + 1 });
    expect(msg).toMatch(/too large/);
    expect(msg).toContain(`${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`);
  });

  it("accepts an extension on the backend whitelist even with a useless mime", () => {
    // .amr / .mkv arrive with an empty or bogus `type` from most browsers; the
    // backend takes them, so the client must not be stricter than the gate.
    expect(checkBytes({ size: 10, name: "field.amr", type: "" })).toBeNull();
    expect(checkBytes({ size: 10, name: "session.mkv", type: "application/octet-stream" })).toBeNull();
  });

  it("accepts an audio/video mime even with no extension", () => {
    expect(checkBytes({ size: 10, name: "recording", type: "audio/webm" })).toBeNull();
    expect(checkBytes({ size: 10, name: "clip", type: "video/mp4" })).toBeNull();
  });

  it("rejects a file that is neither", () => {
    expect(checkBytes({ size: 10, name: "notes.pdf", type: "application/pdf" }))
      .toMatch(/unsupported file type/);
  });
});

describe("checkDuration", () => {
  it("accepts a length inside the window", () => {
    expect(checkDuration(60, true)).toBeNull();
  });

  it("rejects below the floor", () => {
    expect(checkDuration(1.2, true)).toMatch(/too short/);
  });

  it("rejects above the ceiling — the cap the client used to ignore entirely", () => {
    expect(checkDuration(20 * 60, true)).toMatch(/too long/);
  });

  it("fails closed when a decodable file yields no length", () => {
    expect(checkDuration(null, true)).toMatch(/couldn't read this recording's length/);
  });

  it("defers to the server when the browser simply cannot decode the type", () => {
    // ffprobe reads these; refusing here would block files the backend accepts.
    expect(checkDuration(null, false)).toBeNull();
  });
});

describe("published limits", () => {
  it("states the caps from the same constants the checks use", () => {
    expect(LIMITS_HINT).toContain("50 MB");
    expect(LIMITS_HINT).toContain("15 minutes");
  });

  it("offers every whitelisted extension to the file picker", () => {
    expect(ACCEPT_ATTR).toContain(".flac");
    expect(ACCEPT_ATTR).toContain("audio/*");
  });
});
