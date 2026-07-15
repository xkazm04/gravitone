// The ONE canonical ownership-attestation statement. It is sent to the backend
// with every direct clone (POST /v1/voices) and with the ingest commit, and is
// stored verbatim in each voice's consent receipt — so the record reflects
// exactly what the user agreed to. Keep this the single source of truth; do not
// inline a divergent copy anywhere.
export const CONSENT_STATEMENT =
  "I own this voice or have the speaker's explicit consent to clone it.";
