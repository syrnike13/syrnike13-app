# Store History For Game Activities Only

Activity history is stored only for game activities by default. Realtime activities may include music, games, IDEs, utilities, and future activity kinds, but historical activity sessions are limited to games because they are the clearest fit for friend summaries while music and productivity tools are more sensitive and noisy.

This means future features can answer questions like "what did my friend play yesterday" without silently creating a broader behavioral history. Expanding history to other activity kinds should be a deliberate opt-in decision, not a side effect of adding new realtime sources.

Realtime game activities may use the same heuristic detection policy as the desktop overlay, because a temporary realtime card can tolerate occasional uncertainty. Historical game activity sessions require a verified game identity from a game platform manifest or curated override. Unknown processes, launchers, overlays, anti-cheat helpers, generic desktop applications, and bare process allowlist matches should not create historical activity sessions.
