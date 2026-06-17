# Use A Discord-Like Activity Shape

Activity payloads should follow a Discord-like shape instead of a narrow kind-specific model. The shared fields should cover activity type, name, details, state, timestamps, assets, party, buttons, and future joinability metadata so the product can grow toward rich presence features without redesigning the gateway contract for each activity kind.

We still keep Syrnike-specific ownership and history rules: activities belong to Activity Source IDs, realtime slots expire on the server, and historical sessions are created only for verified games. Discord's field names and concepts are useful as a compatibility model, but Syrnike does not inherit Discord snowflake IDs or platform-specific application ownership semantics.

Client-provided activity secrets are not accepted for now. Join, spectate, match, lobby, or deeplink secrets require a separate invite/join design so rich presence cannot accidentally become a token or private-session leakage channel.

Activity buttons and URLs are allowed only through source-specific policy. Music can expose known external track URLs, verified games can expose trusted store or profile URLs from verified metadata, and IDE or generic app activities should not publish arbitrary client-provided buttons.
