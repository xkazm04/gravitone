// The "close, but..." round trip that used to happen over email.
//
// A pick is final by design, so the ONLY way forward from a decided review is a
// new link. That makes this action a mint: what it hands back is the link the
// client sends on, and what it says when it fails is the difference between
// "try again" and "your note is lost". The backend's own `detail` (request id
// included) is what tells the client which of those it is — a house-style
// paraphrase here would throw that away.

import { afterEach, expect, it, vi } from "vitest";

import { requestRevision } from "./actions";

type Call = { url: string; init: RequestInit };

function stubFetch(reply: () => Response | Error) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const r = reply();
    if (r instanceof Error) throw r;
    return r;
  }));
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); });

it("opens the next round and hands back its link", async () => {
  const calls = stubFetch(() => json({ review_id: "rev2", round: 2 }));
  const result = await requestRevision("rev1", {
    note: "  warmer on the last line  ", reviewer: " Dana ", direction: " line 3: angry ",
  });

  expect(result).toEqual({ ok: true, reviewId: "rev2", round: 2 });
  expect(calls[0].url).toMatch(/\/v1\/reviews\/rev1\/revise$/);
  expect(calls[0].init.method).toBe("POST");
  // trimmed, capped, and nothing invented
  expect(JSON.parse(String(calls[0].init.body))).toEqual({
    note: "warmer on the last line", reviewer: "Dana", direction: "line 3: angry",
  });
});

it("refuses an empty note before spending a request", async () => {
  const calls = stubFetch(() => json({ review_id: "rev2" }));
  expect(await requestRevision("rev1", { note: "   " }))
    .toEqual({ ok: false, error: "say what should change" });
  expect(calls).toHaveLength(0);
});

it("caps a very long note rather than letting the backend refuse it", async () => {
  const calls = stubFetch(() => json({ review_id: "rev2", round: 3 }));
  await requestRevision("rev1", { note: "x".repeat(900), reviewer: "y".repeat(200) });
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.note).toHaveLength(500);
  expect(body.reviewer).toHaveLength(80);
});

it("passes the backend's own sentence through on a refusal", async () => {
  stubFetch(() => json({ detail: "this review has no decision to revise" }, 409));
  expect(await requestRevision("rev1", { note: "warmer" }))
    .toEqual({ ok: false, error: "this review has no decision to revise" });
});

it("does not report success on a 200 with no review id", async () => {
  stubFetch(() => json({ round: 2 }));
  const result = await requestRevision("rev1", { note: "warmer" });
  expect(result.ok).toBe(false);
});

it("says nothing was sent when the studio could not be reached", async () => {
  stubFetch(() => new Error("ECONNREFUSED"));
  expect(await requestRevision("rev1", { note: "warmer" }))
    .toEqual({ ok: false, error: "the studio could not be reached — nothing was sent" });
});

it("survives a non-JSON body instead of throwing at the reviewer", async () => {
  stubFetch(() => new Response("<html>502</html>", { status: 502 }));
  const result = await requestRevision("rev1", { note: "warmer" });
  expect(result).toEqual({ ok: false, error: "the revision round could not be opened" });
});

it("encodes the review id into the path", async () => {
  const calls = stubFetch(() => json({ review_id: "rev2", round: 2 }));
  await requestRevision("a/b c", { note: "warmer" });
  expect(calls[0].url).toContain("/v1/reviews/a%2Fb%20c/revise");
});
