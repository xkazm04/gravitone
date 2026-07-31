---
slug: one-emotion-grammar
type: perfect/direction
context: "[[Voice & Emotion Library]]"
lens: ux
status: rejected
size: S
proposed: 2026-07-13
---
## What & why
Three regexes disagree on emotion names (tags no digits; normalize allows digits; demand a third); patch_voice skips normalization + collision check.
## Rejection
2026-07-13 — user declined. The patch_voice collision gap remains a latent bug; fold into a future robustness direction if the context comes off cooldown.
