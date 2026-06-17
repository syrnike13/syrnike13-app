# Canonicalize Game Activity Before Publishing

Desktop game detection should canonicalize raw detector results before publishing to the gateway. Foreground window detection, platform manifests, curated overrides, and future game SDK data are local inputs to one canonical game activity slot rather than independent server-visible activities.

The server should not merge duplicate game payloads or infer a richer activity by combining fields from multiple sources. If local detection has multiple candidate payloads for the same game, it chooses one whole payload by source priority, such as game SDK over platform integration over desktop foreground heuristics, and publishes only that canonical payload.

The server remains responsible for payload validation, realtime slot TTL, and server-side verification before creating historical game sessions. Historical sessions are keyed by user and Verified Game ID, but this is history aggregation rather than realtime payload deduplication.
