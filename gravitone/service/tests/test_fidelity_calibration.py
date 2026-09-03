"""The fixture set behind the rule that throws audio out of a clone.

``ingest.measure_segments`` is the only thing standing between a bystander voice
and somebody's clone, and until this file existed its two constants carried a
comment admitting they were "NOT calibrated against a fixture set". This is that
fixture set, and it is deliberately made of REAL recorded humans (see
``service/tests/real_speech.py``): the embedder these constants govern is the
one ``diarize.py`` measured as unreliable on synthetic speech, so a sweep over
TTS clips would produce a worse number wearing the authority of a measurement.

    GRAVITONE_FIDELITY_CALIBRATION=1 python -m pytest \
        service/tests/test_fidelity_calibration.py -q -s

Opt-in, because it needs the 29 MB embedder, the two fixture recordings, and
about a minute. `-s` is worth it: every test prints the table it asserts on, and
the tables are the artifact — the numbers quoted in ingest.py's calibration
comment came from this run and are reproduced by it.

WHAT THIS ESTABLISHES, AND WHAT IT DOES NOT
-------------------------------------------
It establishes the SAFETY of ``FOREIGN_SIMILARITY = 0.25``: no real segment of a
real speaker came within 0.35 of it. It also establishes that the same constant
has poor RECALL — most genuinely foreign segments score far above it — which is
a fact about the rule that belongs in the payload rather than in a comment, and
now is (``fidelity["rule"]``).

It does NOT establish a better constant. The set is small (5 speaker pools, two
recordings, two languages, ~15 segments) and the two populations overlap, so any
floor high enough to catch most bystanders is also high enough to start deleting
a real speaker's own audio. Raising an audio-destroying threshold on this much
evidence would be the same failure as never measuring it.
"""
from __future__ import annotations

import itertools
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from service import diarize, ingest, voiceprint
from service.emotions import BASELINE
from service.tests import real_speech

CALIBRATE = os.environ.get("GRAVITONE_FIDELITY_CALIBRATION") == "1"

# The chunkings the pipeline can produce. `label_and_stem` cuts at min 1.2 s /
# max 15 s; 4 s is the same recording cut into more, shorter clips, which is what
# a conversational recording with short turns actually yields. Both are measured
# because segment length turned out to move the answer more than anything else.
CHUNKINGS = ((1.2, 15.0), (1.2, 4.0))


def _pools(tmp: Path) -> dict[tuple[float, float], dict[str, list[np.ndarray]]]:
    """{chunking: {"file:speaker": [embedding, ...]}} from the real fixtures."""
    out: dict[tuple[float, float], dict[str, list[np.ndarray]]] = {}
    for min_dur, max_dur in CHUNKINGS:
        pools: dict[str, list[np.ndarray]] = {}
        for name in real_speech.FIXTURES:
            path = real_speech.fixture(name)
            if path is None:
                continue
            audio = real_speech.read_mono16k(path)
            cut = real_speech.segment_wavs(
                audio, diarize.diarize(audio), tmp, f"{name[0]}_{max_dur:g}",
                min_dur=min_dur, max_dur=max_dur)
            for speaker, wavs in cut.items():
                vectors = []
                for wav in wavs:
                    try:
                        vectors.append(voiceprint.embed(wav))
                    except Exception as exc:   # noqa: BLE001 - reported, not fatal
                        print(f"    (could not embed {wav.name}: {exc})")
                if vectors:
                    pools[f"{name[0]}:{speaker}"] = vectors
        out[(min_dur, max_dur)] = pools
    return out


def _same_and_cross(pools: dict[str, list[np.ndarray]]) -> tuple[list[float], list[float]]:
    """Every segment against its OWN speaker's centroid, and against every other
    speaker's. The two populations the drop rule has to tell apart."""
    same: list[float] = []
    cross: list[float] = []
    centres = {k: voiceprint.centroid(v) for k, v in pools.items() if len(v) >= 2}
    for key, centre in centres.items():
        same += [voiceprint.similarity(v, centre) for v in pools[key]]
    for a, b in itertools.permutations(centres, 2):
        cross += [voiceprint.similarity(v, centres[b]) for v in pools[a]]
    return same, cross


def _contaminated(pools: dict[str, list[np.ndarray]]) -> list[dict]:
    """Recordings shaped like the real problem: one speaker's segments with one
    or two segments of somebody else mixed in — the bystander pulls the centroid
    too, exactly as it does in a real ingest."""
    rows = []
    for host, guest in itertools.permutations(pools, 2):
        H, G = pools[host], pools[guest]
        if len(H) < 4 or not G:
            continue
        for f in (1, 2):
            if f > len(G):
                continue
            vectors = list(H) + list(G[:f])
            centre = voiceprint.centroid(vectors)
            sims = [voiceprint.similarity(v, centre) for v in vectors]
            rows.append({"host": host, "guest": guest,
                         "host_sims": sims[:len(H)], "guest_sims": sims[len(H):]})
    return rows


@unittest.skipUnless(CALIBRATE, "set GRAVITONE_FIDELITY_CALIBRATION=1 (real "
                                "audio, the embedding model, ~1 min)")
class CalibrationTests(unittest.TestCase):
    """Everything runs off ONE set of embeddings — they cost seconds each."""

    pools: dict[tuple[float, float], dict[str, list[np.ndarray]]]

    @classmethod
    def setUpClass(cls) -> None:
        if voiceprint.unavailable_reason():
            raise unittest.SkipTest(voiceprint.unavailable_reason())
        if not diarize.available():
            raise unittest.SkipTest("run `python -m service.diarize --download`")
        cls._tmp = TemporaryDirectory()
        cls.pools = _pools(Path(cls._tmp.name))
        if not any(len(p) >= 2 for p in cls.pools.values()):
            cls._tmp.cleanup()
            raise unittest.SkipTest("the fixture recordings could not be fetched")
        print("\n  pools (chunking -> speaker -> segments):")
        for chunking, pools in cls.pools.items():
            print(f"    {chunking}: { {k: len(v) for k, v in pools.items()} }")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    # -- the claim the drop rule rests on ------------------------------------
    def test_no_real_speaker_segment_comes_near_the_drop_floor(self) -> None:
        """`FOREIGN_SIMILARITY` is "deliberately far below anything a real
        speaker's own clip reaches". That was an intention; this measures it."""
        worst = 1.0
        print("\n  same-speaker similarity to the speaker's own centroid")
        for chunking, pools in self.pools.items():
            same, _ = _same_and_cross(pools)
            if not same:
                continue
            print(f"    {chunking}: n={len(same)} min={min(same):.3f} "
                  f"p5={np.percentile(same, 5):.3f} median={np.median(same):.3f}")
            worst = min(worst, min(same))
        print(f"    worst real segment {worst:.3f} vs the floor "
              f"{ingest.FOREIGN_SIMILARITY} — margin {worst - ingest.FOREIGN_SIMILARITY:.3f}")
        # 0.2 of margin, not merely "above": the floor deletes audio, and a
        # constant that only just clears the worst clip in a 15-segment sample is
        # not clear of the clip this sample did not contain.
        self.assertGreater(worst, ingest.FOREIGN_SIMILARITY + 0.2)

    def test_the_floor_sweep_is_reproduced(self) -> None:
        """The table quoted in ingest.py, regenerated.

        Two things are asserted, and they are the two halves of the honest
        answer: at the shipped floor NO real segment is dropped, and MOST
        genuine bystanders are not caught either.
        """
        for chunking, pools in self.pools.items():
            same, cross = _same_and_cross(pools)
            if not same or not cross:
                continue
            print(f"\n  floor sweep, chunking {chunking} "
                  f"({len(cross)} foreign / {len(same)} own segment scores)")
            print("    floor | foreign caught | OWN AUDIO DELETED")
            for floor in (0.10, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60):
                caught = sum(1 for s in cross if s < floor)
                false = sum(1 for s in same if s < floor)
                mark = "  <- shipped" if floor == ingest.FOREIGN_SIMILARITY else ""
                print(f"     {floor:.2f} |     {caught:3d}/{len(cross)}    |"
                      f"     {false:3d}/{len(same)}{mark}")
            with self.subTest(chunking=chunking, claim="no false drops"):
                self.assertEqual(
                    0, sum(1 for s in same if s < ingest.FOREIGN_SIMILARITY),
                    "the shipped floor deleted a real speaker's own audio")
            with self.subTest(chunking=chunking, claim="partial recall"):
                caught = sum(1 for s in cross if s < ingest.FOREIGN_SIMILARITY)
                self.assertLess(caught, len(cross) / 2,
                                "the floor now catches most bystanders — good "
                                "news, but ingest.py's payload still tells users "
                                "it catches a minority. Re-measure and re-word.")

    def test_the_two_populations_overlap_so_no_floor_can_separate_them(self) -> None:
        """Why the floor is not simply raised until it works.

        A different person's segment can score HIGHER against a speaker's
        centroid than that speaker's own worst segment does. There is therefore
        no absolute threshold that catches every bystander without deleting real
        audio, and the statistical rule (MAD) plus flag-don't-drop is the answer
        to that, not a better constant.
        """
        same_all: list[float] = []
        cross_all: list[float] = []
        for pools in self.pools.values():
            s, c = _same_and_cross(pools)
            same_all += s
            cross_all += c
        print(f"\n  overlap: worst own segment {min(same_all):.3f}, best foreign "
              f"segment {max(cross_all):.3f}")
        self.assertGreater(max(cross_all), min(same_all))

    def test_the_mad_rule_flags_more_bystanders_than_it_misjudges(self) -> None:
        """`OUTLIER_MAD_K` only ever FLAGS, so its cost is a false note and its
        benefit is a caught bystander. Both are counted here."""
        for chunking, pools in self.pools.items():
            rows = _contaminated(pools)
            if not rows:
                continue
            own = sum(len(r["host_sims"]) for r in rows)
            foreign = sum(len(r["guest_sims"]) for r in rows)
            print(f"\n  MAD sweep, chunking {chunking} ({len(rows)} contaminated "
                  f"recordings, {own} own / {foreign} foreign segment scores)")
            print("    K   | foreign flagged | own segments flagged")
            measured: dict[float, tuple[int, int]] = {}
            for k in (1.5, 2.0, 2.5, 3.0, 3.5, 5.0):
                caught = false = 0
                for r in rows:
                    sims = r["host_sims"] + r["guest_sims"]
                    median = float(np.median(sims))
                    mad = float(np.median([abs(s - median) for s in sims]))
                    if len(sims) < ingest.OUTLIER_MIN_SEGMENTS or mad <= 0.0:
                        continue
                    cut = median - k * mad
                    caught += sum(1 for s in r["guest_sims"] if s < cut)
                    false += sum(1 for s in r["host_sims"] if s < cut)
                measured[k] = (caught, false)
                mark = "  <- shipped" if k == ingest.OUTLIER_MAD_K else ""
                print(f"    {k:.1f} |      {caught:3d}/{foreign}     |"
                      f"       {false:3d}/{own}{mark}")
            caught, false = measured[ingest.OUTLIER_MAD_K]
            # A flag costs a sentence in the report, so the bar is only that it
            # is not mostly noise: no more than a tenth of the speaker's own
            # segments may be flagged.
            self.assertLessEqual(false, own / 10.0)

    # -- and the shipped function itself, on real audio ----------------------
    def test_the_shipped_rule_keeps_a_real_speakers_own_segments(self) -> None:
        """`measure_segments` end to end with the REAL embedder over the REAL
        fixtures: the failure this whole rule must never have is deleting the
        audio of the person being cloned."""
        pools = self.pools[CHUNKINGS[0]]
        with TemporaryDirectory() as td:
            tmp = Path(td)
            wavs = _fixture_wavs(tmp)
            if len(wavs) < 2:
                self.skipTest("no fixture audio to run the shipped rule over")
            host_key = max(wavs, key=lambda k: len(wavs[k]))
            guest_key = next(k for k in wavs if k != host_key)
            host, guest = wavs[host_key], wavs[guest_key][:1]
            labels = [{"i": i, "emotion": BASELINE, "wav": str(p)}
                      for i, p in enumerate(host + guest)]
            scan = ingest.measure_segments(labels)
        caught = bool(scan.dropped or scan.payload["flagged"])
        print(f"\n  shipped rule over {len(host)} real segments of {host_key} "
              f"+ 1 of {guest_key}: reference={scan.payload['reference_similarity']} "
              f"dropped={scan.payload['dropped']} flagged={scan.payload['flagged']}"
              f" — the bystander was {'caught' if caught else 'NOT caught'}")
        # Deliberately not asserted either way. On this fixture the stranger
        # usually survives, which is the recall weakness in the flesh rather
        # than a bug; asserting "not caught" would pin a shortcoming in place,
        # and asserting "caught" would claim a power the sweep says it lacks.
        self.assertTrue(scan.payload["available"], scan.payload["reason"])
        self.assertFalse({i for i in scan.dropped if i < len(host)},
                         "the speaker's OWN audio was dropped")
        self.assertTrue(pools, "pools were built")
        # The rule's own disclosure travels with the numbers.
        self.assertIn("rule", scan.payload)
        self.assertEqual(ingest.FOREIGN_SIMILARITY,
                         scan.payload["rule"]["foreign_similarity"])


def _fixture_wavs(tmp: Path) -> dict[str, list[Path]]:
    """Per-speaker segment wavs on disk (the embeddings alone are not enough —
    `measure_segments` reads files)."""
    out: dict[str, list[Path]] = {}
    for name in real_speech.FIXTURES:
        path = real_speech.fixture(name)
        if path is None:
            continue
        audio = real_speech.read_mono16k(path)
        for speaker, wavs in real_speech.segment_wavs(
                audio, diarize.diarize(audio), tmp, name[0]).items():
            out[f"{name[0]}:{speaker}"] = wavs
    return out


if __name__ == "__main__":
    unittest.main()
