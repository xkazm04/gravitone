// The ONE canonical ownership-attestation statement. It is sent to the backend
// with every direct clone (POST /v1/voices) and with the ingest commit, and is
// stored verbatim in each voice's consent receipt — so the record reflects
// exactly what the user agreed to. Keep this the single source of truth; do not
// inline a divergent copy anywhere.
export const CONSENT_STATEMENT =
  "I own this voice or have the speaker's explicit consent to clone it.";

// The attestation for audio this box FETCHED rather than the user recorded —
// today, a pasted YouTube link. The sentence above is simply false for a video
// somebody else published, and storing a false sentence in a consent receipt
// launders the claim rather than recording it. So link-sourced jobs attest this
// instead, and the backend REQUIRES it verbatim for them
// (service/ingest_url.py::EXTERNAL_STATEMENT — keep the two in step; the commit
// is refused with a 422 naming the exact sentence if they drift).
//
// The requirement is not weakened by being different: a link job with no
// attestation is refused exactly like an upload with none.
export const EXTERNAL_CONSENT_STATEMENT =
  "I have the right to use this recording and to clone the voice in it.";
