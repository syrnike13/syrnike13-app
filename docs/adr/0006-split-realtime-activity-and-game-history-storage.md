# Split Realtime Activity And Game History Storage

Realtime activity slots are stored in Redis with server-side expiration. Historical activity sessions are stored in the primary database, and only verified game activities create those durable sessions.

This split keeps live presence fanout fast and self-healing while avoiding database writes for every activity heartbeat. The database stores durable intervals that future summaries can query, while Redis remains the source for current activity visibility.

Historical game sessions use a short merge window: if the same verified game for the same user disappears and returns within five minutes, the existing session continues instead of creating a new session. Longer gaps close the old session and start a new one.
