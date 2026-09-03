# REPORT — FABRIC (Gravitone Fabric), Batch 5

> Saved by the orchestrator from the builder's inline report.

**Status: complete.** service/replicas.py + 51 new tests (17 pre-existing + AggKeys contract
untouched, green). 68 total in test_replicas.

1. Admin port per replica — always sequential, always 127.0.0.1 (host is not a parameter of
   make_admin_server, by design). /metrics + /introspect {live_workers, available_permits,
   queue_depth, in_flight, ready, draining} from counters() not snapshot() (drain-polling
   never sorts latency windows). Replicas spawn via a new `--child` entrypoint (admin thread
   then uvicorn); replica_command() without admin_port byte-identical. Service imports lazy,
   child-only — pinned by an AST test on top-level imports.
2. pool_total in ALL modes via metrics_targets(admin_base=); single_replica_sample label
   survives exactly where still true (--no-admin + SO_REUSEPORT).
3. Router (--router, default OFF): choose_replica = free permits > voice affinity > free
   count > queue > in-flight > index; stdlib proxy, X-Gravitone-Replica; refuses
   --router --reuse-port by name.
4. Drain — drain_replica/drain_and_replace: stop routing → poll to in_flight==0 → replace
   without crash backoff. Router-off/no-admin/timeout → degraded + named reason.
5. GET /pool — per-replica introspection + totals + voice→replica map + drained set +
   aggregated metrics + routing mode.

## HOOK — engine.py accessor (apply AFTER DEADLINE lands; voice_lru_keys lights up via getattr)
```python
# service/engine.py — add to class TtsEngine (near live_workers/available_permits)
    def voice_lru_keys(self) -> list[str]:
        """Voice ids currently resident in some worker's LRU (read-only).

        Fabric's router uses this for affinity: routing to a replica that
        already holds the voice skips get_state_for_audio_prompt, the largest
        avoidable cost on a cold voice. Snapshot of a live OrderedDict, so
        treat it as advisory.
        """
        keys: set[str] = set()
        for w in self._workers:
            keys.update(list(w._voice_cache.keys()))
        return sorted(keys)
```

Evidence: test_replicas 68 OK; private_surface + AggKeysContract 22 OK; admission/abandon/
worker_supervision/drain 28 OK; py_compile clean.

Deferred (per design): utterance fan-out across replicas + seam-quality gating.
