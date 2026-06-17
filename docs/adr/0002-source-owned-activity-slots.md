# Use Source-Owned Activity Slots

Realtime activities are owned by canonical activity sources. Each canonical source publishes or clears one activity slot identified by an Activity Source ID, so desktop game detection, music detection, IDE detection, and future integrations cannot overwrite each other.

We choose source-owned slots instead of a single client snapshot because different activity domains may update at different cadences and fail independently. Internal desktop detectors are local inputs to a canonical source, such as `desktop:game`, `desktop:music`, or `desktop:ide`; they should not each publish their own server-visible activity slot.

The backend can combine canonical slots into a user's current activity set, while historical game sessions can be derived only from verified game slots.
