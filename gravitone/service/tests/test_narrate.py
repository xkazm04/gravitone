"""/v1/narrate - extraction, plan shape, the bounded store, and the SSRF guards.

The SSRF cases are the reason this file exists. `POST {url}` asks the service to
make an outbound request chosen by whoever is calling, from inside whatever
network it runs in, and the interesting failures are all the ones where the URL
looks fine and the REQUEST does not: an allowlisted host that resolves to
169.254.169.254, a 302 that lands on loopback, a page that streams forever.
Each of those has a test here, and each asserts the REFUSAL SENTENCE, not just
the status -- an unnamed 403 is indistinguishable from a bug at the call site.

No engine and no app.py: the router is mounted on a bare FastAPI app, because
/v1/narrate synthesizes nothing and importing the whole service to test a text
transformation would make these tests slower and less honest, not more.
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
import urllib.error
from email.message import Message
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import service.narrate as narrate


def _headers(**pairs: str) -> Message:
    msg = Message()
    for key, value in pairs.items():
        msg[key.replace("_", "-")] = value
    return msg


class _FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, **header_pairs: str) -> None:
        super().__init__(body)
        self.headers = _headers(**header_pairs)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class _FakeOpener:
    """Stands in for the urllib opener. Records the handler it was built with
    so redirect behaviour can be driven directly."""

    def __init__(self, result):
        self.result = result

    def open(self, req, timeout=None):  # noqa: ANN001
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class _NarrateBase(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._dir = narrate.NARRATIONS_DIR
        self._max = narrate.MAX_NARRATIONS
        self._opener = narrate._build_opener
        self._getaddrinfo = narrate.socket.getaddrinfo
        self._env = {k: os.environ.get(k) for k in
                     ("NARRATE_ALLOW_HOSTS", "NARRATE_MAX_BYTES", "NARRATE_TIMEOUT_S")}
        for key in self._env:
            os.environ.pop(key, None)
        narrate.NARRATIONS_DIR = Path(self._td.name) / "narrations"

        app = FastAPI()
        app.include_router(narrate.router)
        self.client = TestClient(app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        narrate.NARRATIONS_DIR = self._dir
        narrate.MAX_NARRATIONS = self._max
        narrate._build_opener = self._opener
        narrate.socket.getaddrinfo = self._getaddrinfo
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._td.cleanup()

    # -- helpers ----------------------------------------------------------
    def _resolves_to(self, *addresses: str) -> None:
        narrate.socket.getaddrinfo = lambda host, port, **kw: [
            (2, 1, 6, "", (addr, port)) for addr in addresses]

    def _serves(self, body: bytes, **header_pairs: str) -> None:
        header_pairs.setdefault("Content_Type", "text/html")
        narrate._build_opener = lambda *h: _FakeOpener(
            _FakeResponse(body, **header_pairs))


# -- the hash contract with the browser ---------------------------------------

class ContentHashTest(unittest.TestCase):
    """These are GOLDEN values, cross-checked against
    web/lib/narratable.ts::contentHash. If an edit changes them, every clip
    baked by web/scripts/bake-narration.ts stops matching what the dock looks
    up -- silently, because a miss just re-synthesizes. So they are pinned."""

    def test_golden_values(self) -> None:
        self.assertEqual(narrate.content_hash("hello"), "4f9f2cabb5d9fd2b")
        self.assertEqual(narrate.hash_parts("calm", "Hello there."),
                         "f782dba7fe9fc5f7")

    def test_astral_characters_walk_utf16_units(self) -> None:
        # An emoji is TWO charCodeAt iterations in JS; a code-point loop would
        # disagree here and nowhere else.
        self.assertEqual(narrate.content_hash("caf\u00e9 \U0001f3b5"),
                         "20b651f7175c98ae")

    def test_separator_prevents_field_collision(self) -> None:
        self.assertNotEqual(narrate.hash_parts("a b", "c"),
                            narrate.hash_parts("a", "b c"))

    def test_empty_string_is_the_seed(self) -> None:
        self.assertEqual(narrate.content_hash(""), "811c9dc501000193")


class SpeakableTest(unittest.TestCase):
    def test_symbols_become_words(self) -> None:
        self.assertEqual(narrate.speakable("1.9\u00d7 faster"), "1.9 times faster")
        self.assertEqual(narrate.speakable("warm \u00b7 en"), "warm, en")
        self.assertEqual(narrate.speakable("a \u2192 b"), "a then b")

    def test_whitespace_and_curly_quotes_fold(self) -> None:
        self.assertEqual(narrate.speakable("  it\u2019s\n\n  fine "), "it's fine")


# -- extraction ---------------------------------------------------------------

class ExtractionTest(unittest.TestCase):
    HTML = (
        "<html><head><title>Docs</title></head><body>"
        "<nav><a>Home</a><a>Pricing</a></nav>"
        "<h1>Getting started</h1><p>Install it with pip.</p>"
        "<script>alert('no')</script><style>p{color:red}</style>"
        "<h2>Next steps</h2><ul><li>Run the server</li></ul>"
        "<footer>copyright 2026</footer></body></html>")

    def test_chrome_is_never_spoken(self) -> None:
        title, pieces = narrate.extract_html(self.HTML)
        self.assertEqual(title, "Docs")
        spoken = " ".join(text for _, text in pieces)
        for chrome in ("Home", "Pricing", "alert", "color:red", "copyright"):
            self.assertNotIn(chrome, spoken)
        self.assertIn("Install it with pip.", spoken)

    def test_nested_skip_tags_do_not_re_enable_capture(self) -> None:
        # The classic bug: </aside> inside <nav> ends the skip early and the
        # rest of the menu gets read aloud.
        _, pieces = narrate.extract_html(
            "<nav><aside><p>menu</p></aside><p>also menu</p></nav><p>real</p>")
        self.assertEqual([t for _, t in pieces], ["real"])

    def test_markdown_headings_lists_and_fences(self) -> None:
        title, pieces = narrate.extract_markdown(
            "# Title\n\nSome **bold** prose with a [link](http://x).\n\n"
            "```\nnpm install thing\n```\n\n- one item\n\n> a quote\n")
        self.assertEqual(title, "Title")
        kinds = [k for k, _ in pieces]
        texts = [t for _, t in pieces]
        self.assertIn("heading", kinds)
        self.assertIn("Some bold prose with a link.", texts)
        self.assertNotIn("npm install thing", " ".join(texts))
        self.assertIn("list", kinds)
        self.assertIn("quote", kinds)

    def test_blocks_carry_scale_emotions_and_a_warm_lead(self) -> None:
        _, pieces = narrate.extract_html(self.HTML)
        blocks = narrate.build_blocks(pieces)
        self.assertEqual(blocks[0]["character_hint"], "warm")
        self.assertEqual(blocks[0]["role"], "lead")
        for block in blocks:
            self.assertIn(block["emotion"], narrate.EMOTION_SCALE)
            self.assertIn(block["character_hint"], ("warm", "measured"))

    def test_blocks_are_bounded(self) -> None:
        pieces = [("body", "sentence number %d." % i) for i in range(4000)]
        blocks = narrate.build_blocks(pieces)
        self.assertLessEqual(len(blocks), narrate.MAX_BLOCKS)
        for block in blocks:
            self.assertLessEqual(len(block["text"]), narrate.MAX_BLOCK_CHARS + 200)


# -- the plan -----------------------------------------------------------------

class PlanTest(_NarrateBase):
    def test_markdown_plan_round_trips(self) -> None:
        res = self.client.post("/v1/narrate", json={
            "markdown": "# Hello\n\nThis is a page.\n", "character_id": "sarah"})
        self.assertEqual(res.status_code, 201, res.text)
        plan = res.json()
        self.assertTrue(plan["narration_id"])
        self.assertEqual(plan["source"], "markdown")
        self.assertGreater(len(plan["blocks"]), 0)
        block = plan["blocks"][0]
        emotion = block["emotion"]
        self.assertEqual(block["tagged_text"],
                         f"[{emotion}]{block['text']}[/{emotion}]")
        self.assertEqual(block["hash"], narrate.hash_parts(emotion, block["text"]))
        # Addressing points at ROUTES THAT ALREADY EXIST; no new synthesis path.
        self.assertEqual(block["addressing"]["speak"]["route"], "/v1/speak")
        self.assertEqual(block["addressing"]["voice_id"], f"sarah:{emotion}")
        self.assertEqual(
            block["addressing"]["drop_in"]["route"],
            f"/v1/text-to-speech/sarah:{emotion}")

        again = self.client.get(f"/v1/narrate/{plan['narration_id']}")
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json(), plan)

    def test_no_character_leaves_addressing_open(self) -> None:
        plan = self.client.post("/v1/narrate", json={"markdown": "# Hi\n\nText."}).json()
        block = plan["blocks"][0]
        self.assertIsNone(block["addressing"]["voice_id"])
        self.assertIsNone(block["addressing"]["drop_in"]["route"])
        # The hint is what the client picks with, so it must still be there.
        self.assertIn(block["character_hint"], ("warm", "measured"))

    def test_the_body_is_never_stored(self) -> None:
        plan = self.client.post("/v1/narrate", json={
            "markdown": "# T\n\nA secret sentence that should not be echoed raw."}).json()
        stored = json.loads(
            (narrate.NARRATIONS_DIR / f"{plan['narration_id']}.json").read_text("utf-8"))
        self.assertNotIn("markdown", stored)
        self.assertIsNone(stored["url"])

    def test_exactly_one_source(self) -> None:
        for payload in ({}, {"markdown": "# a\n\nb", "html": "<p>c</p>"}):
            res = self.client.post("/v1/narrate", json=payload)
            self.assertEqual(res.status_code, 400, payload)
            self.assertIn("exactly one", res.json()["detail"])

    def test_unreadable_content_names_the_way_out(self) -> None:
        res = self.client.post("/v1/narrate", json={"html": "<nav><a>only chrome</a></nav>"})
        self.assertEqual(res.status_code, 422)
        self.assertIn("paste the text instead", res.json()["detail"])

    def test_missing_plan_is_named(self) -> None:
        res = self.client.get("/v1/narrate/deadbeef01")
        self.assertEqual(res.status_code, 404)
        self.assertIn("evicted oldest-first", res.json()["detail"])

    def test_a_path_traversing_id_is_a_404_not_a_read(self) -> None:
        res = self.client.get("/v1/narrate/..%2F..%2Fconfig")
        self.assertIn(res.status_code, (404, 400))

    def test_store_is_bounded(self) -> None:
        narrate.MAX_NARRATIONS = 3
        for i in range(6):
            res = self.client.post("/v1/narrate", json={"markdown": f"# T{i}\n\nBody {i}."})
            self.assertEqual(res.status_code, 201)
        self.assertLessEqual(len(list(narrate.NARRATIONS_DIR.glob("*.json"))), 3)


# -- SSRF ---------------------------------------------------------------------

class AllowlistTest(unittest.TestCase):
    def test_suffix_entries_do_not_cover_the_apex(self) -> None:
        allow = [".example.com", "docs.other.org"]
        self.assertTrue(narrate.host_allowed("docs.example.com", allow))
        self.assertFalse(narrate.host_allowed("example.com", allow))
        self.assertTrue(narrate.host_allowed("docs.other.org", allow))
        self.assertFalse(narrate.host_allowed("evil.docs.other.org", allow))
        # The near-miss that catches naive endswith checks.
        self.assertFalse(narrate.host_allowed("notexample.com", [".example.com"]))

    def test_empty_allowlist_allows_nothing(self) -> None:
        self.assertFalse(narrate.host_allowed("anything.com", []))


class SsrfTest(_NarrateBase):
    def _refusal(self, url: str) -> tuple[int, str]:
        res = self.client.post("/v1/narrate", json={"url": url})
        return res.status_code, res.json()["detail"]

    def test_urls_are_off_by_default(self) -> None:
        status, detail = self._refusal("http://docs.example.com/page")
        self.assertEqual(status, 403)
        self.assertIn("does not fetch remote URLs", detail)
        self.assertIn("NARRATE_ALLOW_HOSTS", detail)
        self.assertIn("paste the text instead", detail)

    def test_host_outside_the_allowlist(self) -> None:
        os.environ["NARRATE_ALLOW_HOSTS"] = "docs.example.com"
        status, detail = self._refusal("http://evil.test/page")
        self.assertEqual(status, 403)
        self.assertIn("'evil.test' is not in NARRATE_ALLOW_HOSTS", detail)

    def test_non_http_schemes(self) -> None:
        os.environ["NARRATE_ALLOW_HOSTS"] = "docs.example.com"
        status, detail = self._refusal("file:///etc/passwd")
        self.assertEqual(status, 400)
        self.assertIn("only http and https", detail)

    def test_allowlisted_host_that_resolves_to_loopback(self) -> None:
        os.environ["NARRATE_ALLOW_HOSTS"] = "docs.example.com"
        self._resolves_to("127.0.0.1")
        status, detail = self._refusal("http://docs.example.com/x")
        self.assertEqual(status, 403)
        self.assertIn("127.0.0.1", detail)
        self.assertIn("not a public address", detail)

    def test_cloud_metadata_link_local(self) -> None:
        os.environ["NARRATE_ALLOW_HOSTS"] = "docs.example.com"
        self._resolves_to("169.254.169.254")
        status, detail = self._refusal("http://docs.example.com/x")
        self.assertEqual(status, 403)
        self.assertIn("169.254.169.254", detail)

    def test_every_resolved_address_is_checked(self) -> None:
        # One public + one private record must NOT be a coin flip.
        os.environ["NARRATE_ALLOW_HOSTS"] = "docs.example.com"
        self._resolves_to("93.184.216.34", "10.0.0.5")
        status, detail = self._refusal("http://docs.example.com/x")
        self.assertEqual(status, 403)
        self.assertIn("10.0.0.5", detail)

    def test_ipv6_private_ranges(self) -> None:
        for addr in ("::1", "fd00::1", "fe80::1"):
            with self.assertRaises(narrate.NarrateRefusal) as caught:
                narrate.check_public_ip(addr)
            self.assertIn("not a public address", caught.exception.message)

    def test_public_addresses_pass(self) -> None:
        narrate.check_public_ip("93.184.216.34")
        narrate.check_public_ip("2606:2800:220:1:248:1893:25c8:1946")

    def test_redirect_to_a_private_host_is_refused_by_hop(self) -> None:
        handler = narrate._GuardedRedirects(["docs.example.com"])
        with self.assertRaises(narrate.NarrateRefusal) as caught:
            handler.redirect_request(None, None, 302, "Found", {},
                                     "http://169.254.169.254/latest/meta-data/")
        self.assertIn("'169.254.169.254' is not in NARRATE_ALLOW_HOSTS",
                      caught.exception.message)

    def test_redirects_are_capped(self) -> None:
        os.environ["NARRATE_ALLOW_HOSTS"] = "docs.example.com"
        self._resolves_to("93.184.216.34")
        handler = narrate._GuardedRedirects(["docs.example.com"])
        handler.hops = narrate.MAX_REDIRECTS
        with self.assertRaises(narrate.NarrateRefusal) as caught:
            handler.redirect_request(None, None, 302, "Found", {},
                                     "http://docs.example.com/again")
        self.assertIn("redirected more than", caught.exception.message)

    def test_declared_oversize_is_refused_before_reading(self) -> None:
        os.environ["NARRATE_ALLOW_HOSTS"] = "docs.example.com"
        os.environ["NARRATE_MAX_BYTES"] = "2048"
        self._resolves_to("93.184.216.34")
        self._serves(b"<p>hi</p>", Content_Length="9999999")
        status, detail = self._refusal("http://docs.example.com/x")
        self.assertEqual(status, 413)
        self.assertIn("over the 2048-byte narration cap", detail)

    def test_a_lying_content_length_is_still_capped(self) -> None:
        os.environ["NARRATE_ALLOW_HOSTS"] = "docs.example.com"
        os.environ["NARRATE_MAX_BYTES"] = "2048"
        self._resolves_to("93.184.216.34")
        self._serves(b"<p>" + b"x" * 5000 + b"</p>", Content_Length="10")
        status, detail = self._refusal("http://docs.example.com/x")
        self.assertEqual(status, 413)
        self.assertIn("larger than the 2048-byte narration cap", detail)

    def test_non_textual_content_type(self) -> None:
        os.environ["NARRATE_ALLOW_HOSTS"] = "docs.example.com"
        self._resolves_to("93.184.216.34")
        self._serves(b"\x00\x01", Content_Type="application/zip")
        status, detail = self._refusal("http://docs.example.com/x")
        self.assertEqual(status, 415)
        self.assertIn("not a readable page", detail)

    def test_a_timeout_is_named_with_the_budget(self) -> None:
        os.environ["NARRATE_ALLOW_HOSTS"] = "docs.example.com"
        os.environ["NARRATE_TIMEOUT_S"] = "3"
        self._resolves_to("93.184.216.34")
        narrate._build_opener = lambda *h: _FakeOpener(
            urllib.error.URLError("timed out"))
        status, detail = self._refusal("http://docs.example.com/x")
        self.assertEqual(status, 504)
        self.assertIn("within 3s", detail)

    def test_an_allowed_public_page_narrates(self) -> None:
        os.environ["NARRATE_ALLOW_HOSTS"] = ".example.com"
        self._resolves_to("93.184.216.34")
        self._serves(b"<html><head><title>Guide</title></head><body>"
                     b"<nav>menu</nav><h1>How it works</h1>"
                     b"<p>It reads the page aloud.</p></body></html>")
        res = self.client.post("/v1/narrate", json={"url": "http://docs.example.com/g"})
        self.assertEqual(res.status_code, 201, res.text)
        plan = res.json()
        self.assertEqual(plan["source"], "url")
        self.assertEqual(plan["url"], "http://docs.example.com/g")
        self.assertIn("It reads the page aloud.", plan["blocks"][0]["text"])
        self.assertNotIn("menu", plan["blocks"][0]["text"])


if __name__ == "__main__":
    unittest.main()
