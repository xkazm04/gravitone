// Turning one tool call into one HTTP request, using ONLY what the manifest
// said about the capability: its method, its path template, and where each
// parameter goes on the wire. There is no per-tool code here — a capability the
// studio adds tomorrow is callable today.
//
// The key is presented on every call, and the failure path is the point: an
// upstream refusal comes back as an ERROR RESULT carrying the service's own
// detail ("key does not hold scope 'performance'"), never as an empty success.
// An agent that cannot tell a refusal from a result will plan around a tool
// that does not work for it.

/** Audio comes back as bytes; MCP carries them base64 in an audio content
 *  block. Everything else is text (JSON, mostly). */
function isAudio(contentType) {
  return typeof contentType === "string" && contentType.startsWith("audio/");
}

function fill(endpoint, args) {
  return endpoint.replace(/\{(\w+)\}/g, (_m, name) => {
    const v = args[name];
    if (v === undefined || v === null || v === "") {
      throw new Error(`missing required path parameter "${name}"`);
    }
    return encodeURIComponent(String(v));
  });
}

/** Build the request this tool call means. Exported for tests: the wire shape
 *  is the contract, so it is asserted directly rather than through a socket. */
export function buildRequest(tool, args, { baseUrl, apiKey }) {
  const path = fill(tool.endpoint, args);
  const url = new URL(`${baseUrl}${path}`);
  const body = {};
  let file = null;
  const fields = {};

  for (const p of tool.params ?? []) {
    const value = args[p.name];
    if (p.in === "path") continue; // already in the path
    if (value === undefined || value === null) {
      if (p.required && p.in !== "path") {
        throw new Error(`missing required parameter "${p.name}"`);
      }
      continue;
    }
    if (p.in === "query") {
      url.searchParams.set(p.name, String(value));
    } else if (p.in === "file") {
      file = { name: p.name, base64: String(value) };
    } else {
      // A body field. Kept in both shapes because the same capability may be
      // JSON (most) or multipart (transcribe) — which one is decided below,
      // once we know whether a file came with it.
      body[p.name] = value;
      fields[p.name] = value;
    }
  }

  const headers = { "xi-api-key": apiKey };

  if (file) {
    // A multipart upload: the agent handed us base64 because a tool call is
    // JSON, and this is where that becomes a real file part. Content-Type is
    // left to FormData so the boundary is correct.
    const form = new FormData();
    const bytes = Buffer.from(file.base64, "base64");
    form.set(file.name, new Blob([bytes]), "recording.wav");
    for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
    return { url: url.toString(), init: { method: tool.method, headers, body: form } };
  }

  if (tool.method === "GET" || tool.method === "DELETE") {
    return { url: url.toString(), init: { method: tool.method, headers } };
  }
  return {
    url: url.toString(),
    init: {
      method: tool.method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

/** Execute a tool call and shape the MCP result. */
export async function callTool(tool, args, { baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 180000 }) {
  let request;
  try {
    request = buildRequest(tool, args ?? {}, { baseUrl, apiKey });
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `${tool.id}: ${err.message}` }] };
  }

  let res;
  try {
    res = await fetchImpl(request.url, { ...request.init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `${tool.id}: could not reach ${request.url} — ${err.message}` }],
    };
  }

  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* a body we could not read changes nothing about the status */
    }
    const hint =
      res.status === 401 || res.status === 403
        ? " This key does not hold the scope this endpoint requires (or the deployment does not recognise it)."
        : res.status === 429
          ? " The deployment is at capacity; retry after the Retry-After it sent."
          : "";
    return {
      isError: true,
      content: [{ type: "text", text: `${tool.id} failed (${res.status}): ${detail || "no detail"}.${hint}` }],
    };
  }

  if (isAudio(contentType)) {
    const buf = Buffer.from(await res.arrayBuffer());
    const seconds = res.headers.get("x-audio-seconds");
    return {
      content: [
        { type: "audio", data: buf.toString("base64"), mimeType: contentType.split(";")[0] },
        {
          type: "text",
          text: `${tool.id}: ${buf.length} bytes of ${contentType.split(";")[0]}${seconds ? ` (${seconds}s of audio)` : ""}.`,
        },
      ],
    };
  }

  const text = await res.text();
  return { content: [{ type: "text", text: text || "(empty response)" }] };
}
