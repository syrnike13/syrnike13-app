# Expire Realtime Activity Slots On The Server

Realtime activity slots expire on the server. Activity sources should clear their own slots when they know an activity ended, but each upsert also renews a server-side TTL so stale activities disappear after client crashes, detector failures, disconnects, or lost clear messages.

We choose server-side expiration as the final authority because realtime activity visibility should not depend on a well-behaved desktop process. Client clear messages make the UI update faster, while TTL makes incorrect long-lived activity cards self-healing.
