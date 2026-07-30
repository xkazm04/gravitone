// The STT proxy's guarantees, driven through the real handler with fetch stubbed
// at the backend boundary: what is asserted is what a browser would receive.
//
// The two answers that MUST survive the proxy are both "no": a 503 saying
// faster-whisper is not installed (a legitimate state on a fresh box) and a 413
// saying the clip is too long. Flattened into one generic error, the punch-in
// editor could not tell the user which of them to fix.

import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => { vi.unstubAllGlobals(); });

// The multipart body is written by hand rather than with `new FormData()`: in
// the jsdom environment FormData is jsdom's and Request is Node's, so the
// constructor never stamps the multipart Content-Type and the handler would see
// a body it cannot parse — an artefact of the test environment, not the route.
const BOUNDARY = "----gravitone-test";

function upload(parts: Array<{ name: string; filename?: string; body: string }> =
  [{ name: "file", filename: "take.wav", body: "RIFF" }]): Request {
  const chunks = parts.map(({ name, filename, body }) =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"` +
    (filename ? `; filename="${filename}"\r\nContent-Type: audio/wav` : "") +
    `\r\n\r\n${body}\r\n`);
  return new Request("http://studio.local/api/stt", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: `${chunks.join("")}--${BOUNDARY}--\r\n`,
  });
}

function stubFetch(res: Response | Error) {
  const fn = vi.fn((..._args: unknown[]) =>
    res instanceof Error ? Promise.reject(res) : Promise.resolve(res));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const transcript = () => new Response(JSON.stringify({
  text: "one two", words: [{ text: "one", start: 0, end: 0.4, type: "word" }],
}), { status: 200, headers: { "Content-Type": "application/json" } });

describe("/api/stt", () => {
  it("forwards the upload to the service's own speech-to-text", async () => {
    const f = stubFetch(transcript());
    const res = await POST(upload());
    expect(res.status).toBe(200);
    expect(String(f.mock.calls[0][0])).toContain("/v1/speech-to-text");
    expect(await res.json()).toMatchObject({ text: "one two" });
  });

  it("keeps the 503 that says the model is not installed", async () => {
    stubFetch(new Response(JSON.stringify({ detail: "local speech-to-text needs faster-whisper" }),
      { status: 503 }));
    const res = await POST(upload());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: "local speech-to-text needs faster-whisper" });
  });

  it("keeps the 413 that says the clip is too long", async () => {
    stubFetch(new Response(JSON.stringify({ detail: "recording is 12.0 min, over the 10 min limit" }),
      { status: 413 }));
    const res = await POST(upload());
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ detail: expect.stringContaining("min limit") });
  });

  it("answers 503 with a JSON detail when the backend is unreachable", async () => {
    stubFetch(new TypeError("connect ECONNREFUSED"));
    const res = await POST(upload());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: "backend unreachable" });
  });

  it("forwards the envelope byte for byte, with every field the caller sent", async () => {
    // The service owns the field grammar; re-encoding the upload here would be a
    // second place for the two to disagree and would drop unknown fields.
    const f = stubFetch(transcript());
    await POST(upload([
      { name: "file", filename: "take.wav", body: "RIFFDATA" },
      { name: "timestamps_granularity", body: "word" },
      { name: "language_code", body: "en" },
    ]));
    const init = f.mock.calls[0][1] as RequestInit;
    const sent = new TextDecoder().decode(init.body as Uint8Array);
    expect(sent).toContain("RIFFDATA");
    expect(sent).toContain("timestamps_granularity");
    expect(sent).toContain("language_code");
    expect(new Headers(init.headers).get("Content-Type")).toContain("multipart/form-data");
  });

  it("refuses a body that is not an upload at all before calling the backend", async () => {
    const f = stubFetch(transcript());
    const res = await POST(new Request("http://studio.local/api/stt", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ detail: expect.stringContaining("multipart") });
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a body it will not forward, by its declared size", async () => {
    const f = stubFetch(transcript());
    const res = await POST(new Request("http://studio.local/api/stt", {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=x",
        "Content-Length": String(64 * 1024 * 1024),
      },
      body: "--x--",
    }));
    expect(res.status).toBe(413);
    expect(f).not.toHaveBeenCalled();
  });

  it("says so instead of forwarding an empty upload", async () => {
    const f = stubFetch(transcript());
    const res = await POST(new Request("http://studio.local/api/stt", {
      method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: "",
    }));
    expect(res.status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });
});
