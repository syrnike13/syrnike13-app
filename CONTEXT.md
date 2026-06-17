# syrnike13

Syrnike13 is a realtime communication product where a user's availability and current activities are visible to other users.

## Language

**Presence**:
User availability state such as online, idle, focus, busy, or invisible. Presence answers whether and how a user is reachable, not what the user is doing.
_Avoid_: Rich presence, activity

**Activity**:
A user-visible rich presence item that describes one thing the user is currently doing, such as listening to music, playing a game, or using an IDE. A user may have multiple activities at the same time.
_Avoid_: Music presence, rich presence item

**Activity Type**:
The Discord-like presentation type of an activity, such as playing, streaming, listening, watching, custom, or competing. Activity type describes how the activity should read to other users.
_Avoid_: Activity kind

**Activity Session**:
A time-bounded occurrence of an activity used for history and summaries, such as a game played yesterday or a listening session. Activity sessions describe what happened over time, not the realtime publication mechanics.
_Avoid_: Activity log entry, raw event

**Game Activity**:
An activity that represents a game the user is currently playing. Realtime game activities may come from confident heuristics, but historical game activity sessions require a verified game.
_Avoid_: Game process, app activity

**Verified Game**:
A known game identity trusted enough to create historical activity sessions. A game becomes verified through a game platform manifest or a curated override, not only by matching a running process name.
_Avoid_: Likely game, detected process

**Verified Game ID**:
A stable identity for a verified game used to recognize the same game across multiple activity sources.
_Avoid_: Process path, executable name

**Activity Source**:
The integration or detector that observes and publishes an activity, such as desktop now playing, a music API, a process detector, or an IDE integration.
_Avoid_: Provider, presence source

**Activity Slot**:
The realtime place owned by one activity source for one user. An activity slot may contain a current activity or be empty.
_Avoid_: Activity record, history row

**Activity Source ID**:
A stable identifier for the activity source that owns one realtime activity slot for a user. It is distinct from screen capture source IDs.
_Avoid_: Source ID, provider ID

**Activity Source Priority**:
The trust order used when local activity detection has multiple candidate payloads for the same user activity. Higher-priority sources win; lower-priority payloads are not merged into the published activity.
_Avoid_: Merge order, source rank
