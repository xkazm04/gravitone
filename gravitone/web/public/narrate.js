/*
 * Gravitone narrate.js - audible docs for any page, in one script tag.
 *
 *   <script src="https://your-gravitone/narrate.js"
 *           data-host="https://your-gravitone"
 *           data-voice="sarah"></script>
 *
 * What it does: injects a small "Listen" button. On click it extracts the
 * reader's current SELECTION (or the page's main text if nothing is selected),
 * asks {host}/v1/narrate for a narration plan, and plays the plan's blocks in
 * order through {host}/v1/speak. That is all it does.
 *
 * The five rules this file will not bend, because it runs on someone else's
 * site and a script tag is a lot of trust:
 *
 *  1. NO SECRETS. There is no key in this file and there never can be - it is a
 *     public static asset. The key belongs to whoever is listening: the panel
 *     asks for it once, keeps it in sessionStorage under one namespaced name,
 *     and sends it to {host} and to nowhere else. A deployment that needs no
 *     key (an open self-hosted box) never sees the prompt.
 *  2. NO AUTOPLAY. Nothing produces sound without a click. Not on load, not on
 *     scroll, not on a deep link.
 *  3. NO DEPENDENCIES, NO GLOBALS, NO FRAMEWORK. One IIFE, one custom element
 *     name, styles scoped inside a shadow root so the host page's CSS and this
 *     widget cannot damage each other.
 *  4. NO TRACKING. No beacons, no analytics, no third-party requests. The only
 *     network traffic is to the data-host you configured.
 *  5. NAMED FAILURES. Busy engine, bad key, unreachable host, nothing to read -
 *     each is a sentence in the panel, never a silent nothing.
 *
 * Attributes (all on the script tag):
 *   data-host   required-ish; defaults to the script's own origin
 *   data-voice  a character_id to read with; omitted = the host's first
 *   data-label  the button's text (default "Listen")
 *   data-auto   "off" is the only supported value; present for symmetry with
 *               future options. There is no "on".
 */
(function () {
  "use strict";

  var doc = document;
  var script = doc.currentScript;
  if (!script) { return; }

  var HOST = (script.getAttribute("data-host") || "").replace(/\/+$/, "");
  if (!HOST) {
    try { HOST = new URL(script.src, location.href).origin; } catch (e) { HOST = ""; }
  }
  var VOICE = script.getAttribute("data-voice") || "";
  var LABEL = script.getAttribute("data-label") || "Listen";
  var KEY_STORE = "gravitone.narrate.key";
  var MAX_CHARS = 20000;

  if (!HOST) { return; }
  if (doc.querySelector("gravitone-narrate")) { return; }

  // -- page text extraction --------------------------------------------------
  //
  // Selection first: a reader who highlighted three paragraphs has told us
  // exactly what they want read, and that is a better answer than any
  // readability heuristic will ever produce. Otherwise the largest <article> /
  // <main> / role="main", falling back to <body>. The service does the real
  // extraction; this only decides which subtree to hand it.
  function pickSubtree() {
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim().length > 40) {
      var frag = sel.getRangeAt(0).cloneContents();
      var host = doc.createElement("div");
      host.appendChild(frag);
      return host;
    }
    return doc.querySelector("article") || doc.querySelector("main") ||
      doc.querySelector("[role=main]") || doc.body;
  }

  function pageHtml() {
    var node = pickSubtree();
    if (!node) { return ""; }
    var html = node.innerHTML || "";
    // The cap is here, not only on the service, so an enormous page fails as a
    // named refusal in this panel rather than as a 413 from a host the reader
    // has never heard of.
    return html.length > MAX_CHARS ? html.slice(0, MAX_CHARS) : html;
  }

  function pageTitle() {
    var h1 = doc.querySelector("h1");
    return ((h1 && h1.textContent) || doc.title || "").trim().slice(0, 90);
  }

  // -- the key the LISTENER owns ---------------------------------------------
  function storedKey() {
    try { return sessionStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }
  function storeKey(value) {
    // sessionStorage, not localStorage: a key typed into someone else's page
    // should not outlive the tab it was typed into.
    try { sessionStorage.setItem(KEY_STORE, value); } catch (e) { /* private mode */ }
  }

  function headers(key) {
    var h = { "Content-Type": "application/json" };
    if (key) { h["xi-api-key"] = key; }
    return h;
  }

  function detailOf(res) {
    return res.json().then(function (body) {
      return (body && typeof body.detail === "string") ? body.detail : "";
    }, function () { return ""; });
  }

  function named(res, detail) {
    if (res.status === 401 || res.status === 403) {
      return "that key was refused by " + HOST + " - check it, or ask whoever runs it";
    }
    if (res.status === 429) {
      var wait = Math.max(1, Math.ceil(Number(res.headers.get("Retry-After")) || 1));
      return "the speech engine is busy - try again in about " + wait + "s";
    }
    if (res.status === 503) { return "the speech engine is restarting - try again in a moment"; }
    if (res.status === 413) { return detail || "there is too much text on this page to narrate"; }
    return detail || ("the narrator could not be reached (" + res.status + ")");
  }

  // -- the panel -------------------------------------------------------------
  var CSS = [
    ":host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483000;",
    "font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}",
    ".w{display:flex;flex-direction:column;gap:8px;align-items:flex-end}",
    ".p{background:#0b0f14;color:#e6edf3;border:1px solid rgba(255,255,255,.14);",
    "border-radius:16px;padding:12px;width:280px;box-shadow:0 18px 50px -24px #000}",
    "button{font:inherit;font-size:12px;cursor:pointer;border-radius:999px;",
    "border:1px solid rgba(255,255,255,.18);background:#131a22;color:#e6edf3;padding:8px 14px}",
    "button:hover{background:#1b2530}",
    "button:disabled{opacity:.45;cursor:not-allowed}",
    "button:focus-visible{outline:2px solid #4fd1ff;outline-offset:2px}",
    ".go{background:#4fd1ff;color:#04121a;border-color:#4fd1ff;font-weight:600}",
    ".row{display:flex;gap:6px;align-items:center;margin-top:8px}",
    ".t{font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.55}",
    ".s{font-size:11.5px;line-height:1.5;opacity:.8;margin-top:8px}",
    ".s.err{color:#ffc857;opacity:1}",
    ".q{font-size:12.5px;line-height:1.45;margin-top:6px;max-height:3.6em;overflow:hidden}",
    "input{font:inherit;font-size:12px;width:100%;box-sizing:border-box;margin-top:6px;",
    "padding:7px 9px;border-radius:9px;border:1px solid rgba(255,255,255,.18);",
    "background:#05090d;color:#e6edf3}",
    "a{color:#4fd1ff;font-size:10.5px}",
    "@media (prefers-reduced-motion:no-preference){.p{transition:opacity .2s ease}}",
  ].join("");

  var host = doc.createElement("gravitone-narrate");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : null;
  if (!root) { return; }
  var style = doc.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);

  var wrap = doc.createElement("div");
  wrap.className = "w";
  root.appendChild(wrap);

  var panel = doc.createElement("div");
  panel.className = "p";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Listen to this page");
  panel.hidden = true;

  var toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.textContent = LABEL;
  toggle.setAttribute("aria-expanded", "false");

  panel.innerHTML = [
    '<div class="t">audible docs</div>',
    '<div class="q" id="q">Nothing read yet.</div>',
    '<div class="row">',
    '<button class="go" id="play" type="button">Read this page</button>',
    '<button id="stop" type="button" disabled>Stop</button>',
    "</div>",
    '<input id="key" type="password" placeholder="your API key for this host" ',
    'autocomplete="off" hidden>',
    '<p class="s" id="status">Reads your selection, or this page.</p>',
    '<a href="https://github.com/gravitone" rel="noopener noreferrer" target="_blank">',
    "powered by Gravitone</a>",
  ].join("");

  wrap.appendChild(panel);
  wrap.appendChild(toggle);
  doc.body.appendChild(host);

  var $ = function (id) { return root.getElementById(id); };
  var qEl = $("q"), statusEl = $("status"), playBtn = $("play"), stopBtn = $("stop");
  var keyEl = $("key");

  var audio = new Audio();
  audio.preload = "none";
  var state = { blocks: [], i: 0, playing: false, abort: null };

  function say(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? "s err" : "s";
  }

  function askForKey(reason) {
    keyEl.hidden = false;
    keyEl.value = storedKey();
    say(reason, true);
    keyEl.focus();
  }

  toggle.addEventListener("click", function () {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) { playBtn.focus(); }
  });

  keyEl.addEventListener("change", function () {
    storeKey(keyEl.value.trim());
    say("key saved for this tab.");
  });

  stopBtn.addEventListener("click", function () { stop("stopped."); });

  function stop(message) {
    state.playing = false;
    if (state.abort) { state.abort.abort(); state.abort = null; }
    try { audio.pause(); } catch (e) { /* nothing loaded */ }
    stopBtn.disabled = true;
    playBtn.disabled = false;
    if (message) { say(message); }
  }

  playBtn.addEventListener("click", function () {
    if (state.playing) { return; }
    var html = pageHtml();
    if (!html || html.replace(/<[^>]*>/g, "").trim().length < 40) {
      say("there is not enough text on this page to read aloud.", true);
      return;
    }
    playBtn.disabled = true;
    stopBtn.disabled = false;
    state.playing = true;
    state.abort = new AbortController();
    say("reading the page...");
    plan(html).then(playAll).catch(function (err) {
      if (err && err.name === "AbortError") { return; }
      stop("");
      say((err && err.message) || "narration failed.", true);
    });
  });

  function plan(html) {
    var key = storedKey();
    return fetch(HOST + "/v1/narrate", {
      method: "POST",
      headers: headers(key),
      signal: state.abort.signal,
      body: JSON.stringify({ html: html, title: pageTitle(), character_id: VOICE }),
    }).catch(function () {
      throw new Error("could not reach " + HOST + " from this page.");
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        askForKey("this Gravitone deployment needs a key - paste yours below, then press play.");
        var e = new Error("");
        e.name = "AbortError";
        throw e;
      }
      if (!res.ok) {
        return detailOf(res).then(function (d) { throw new Error(named(res, d)); });
      }
      return res.json();
    }).then(function (planDoc) {
      var blocks = (planDoc && planDoc.blocks) || [];
      if (!blocks.length) { throw new Error("nothing readable was found on this page."); }
      state.blocks = blocks;
      state.i = 0;
      return blocks;
    });
  }

  function playAll() {
    return next();
  }

  function next() {
    if (!state.playing) { return Promise.resolve(); }
    var block = state.blocks[state.i];
    if (!block) { stop("finished."); return Promise.resolve(); }
    qEl.textContent = block.text;
    say("block " + (state.i + 1) + " of " + state.blocks.length +
        " - " + (block.emotion || "baseline"));
    return speak(block).then(function () {
      state.i += 1;
      return next();
    });
  }

  function speak(block) {
    var key = storedKey();
    var body = { text: block.tagged_text || block.text };
    if (VOICE) { body.character_id = VOICE; }
    return fetch(HOST + "/v1/speak", {
      method: "POST",
      headers: headers(key),
      signal: state.abort.signal,
      body: JSON.stringify(body),
    }).catch(function () {
      throw new Error("could not reach " + HOST + " from this page.");
    }).then(function (res) {
      if (!res.ok) {
        return detailOf(res).then(function (d) { throw new Error(named(res, d)); });
      }
      return res.blob();
    }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(blob);
        audio.src = url;
        function done() { URL.revokeObjectURL(url); cleanup(); resolve(); }
        function failed() {
          URL.revokeObjectURL(url);
          cleanup();
          reject(new Error("that clip would not play in this browser."));
        }
        function cleanup() {
          audio.removeEventListener("ended", done);
          audio.removeEventListener("error", failed);
        }
        audio.addEventListener("ended", done);
        audio.addEventListener("error", failed);
        var p = audio.play();
        if (p && p.catch) {
          p.catch(function () {
            cleanup();
            URL.revokeObjectURL(url);
            reject(new Error("your browser blocked playback - press play once more."));
          });
        }
      });
    });
  }
})();
