// What the bridge needs to exist, read from the environment and validated
// LOUDLY. An MCP server that starts without a usable configuration presents an
// empty toolbox, and an empty toolbox is indistinguishable from a key that
// grants nothing — so a missing variable is a startup failure with a named
// cause, never a quiet degradation.
//
// TWO hosts, deliberately separate:
//   GRAVITONE_STUDIO_URL  where the key MANIFEST lives (the Next studio). The
//                         bridge asks it what this key opens.
//   GRAVITONE_URL         the SERVICE the tools actually call. Optional: the
//                         manifest names it, and this only overrides it (useful
//                         when the studio reports a loopback address it can
//                         reach and the agent cannot).

export const DEFAULT_STUDIO_URL = "http://127.0.0.1:3000";

export class ConfigError extends Error {}

const trim = (v) => (typeof v === "string" ? v.trim().replace(/\/+$/, "") : "");

export function loadConfig(env = process.env) {
  const apiKey = typeof env.GRAVITONE_API_KEY === "string" ? env.GRAVITONE_API_KEY.trim() : "";
  const keyId = typeof env.GRAVITONE_KEY_ID === "string" ? env.GRAVITONE_KEY_ID.trim() : "";
  const studioUrl = trim(env.GRAVITONE_STUDIO_URL) || DEFAULT_STUDIO_URL;
  const serviceOverride = trim(env.GRAVITONE_URL);

  if (!apiKey) {
    throw new ConfigError(
      "GRAVITONE_API_KEY is not set. The bridge presents this key on every call; without it there is " +
        "nothing to present and every tool would fail at the auth boundary. Export it (or put it in the " +
        "MCP client's env block) and restart.",
    );
  }
  if (!keyId) {
    throw new ConfigError(
      "GRAVITONE_KEY_ID is not set. The toolbox is derived from ONE key's manifest, so the bridge has to " +
        "know which key — copy the id from the studio's keys page (the 'agent config' row action fills it in).",
    );
  }
  // A secret that looks like the placeholder is a config that was copied and
  // never finished. Failing here beats 401s that look like a broken deployment.
  if (apiKey === "YOUR_GRAVITONE_KEY" || apiKey.startsWith("${")) {
    throw new ConfigError(
      `GRAVITONE_API_KEY is still the placeholder ("${apiKey}"). The config block references an environment ` +
        "variable on purpose — export the real secret in the shell that launches this server.",
    );
  }

  return { apiKey, keyId, studioUrl, serviceOverride };
}

/** Where the manifest for this key lives. */
export function manifestUrl(config) {
  return `${config.studioUrl}/api/keys/${encodeURIComponent(config.keyId)}/manifest`;
}
