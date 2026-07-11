# Voice Context

This context names the concepts shared by web voice, Windows native voice, the
backend voice authority, and the LiveKit transport. The same behavioural model
is used on every platform even when the RTC implementation differs.

## User intent and session

**Voice Intent**:
The voice channel the user currently wants to occupy, or `none` after an
explicit leave. A newer Voice Intent always supersedes unfinished older work.
_Avoid_: Target room, desired room, local voice state

**Voice Session**:
The client-side lifetime that reconciles one Voice Intent with one authoritative
Voice Membership and its independent Media Tracks. It survives renderer reload
on Windows, but not full application restart or Windows sleep.
_Avoid_: Call instance, RTC session, media session

**Voice Director**:
The single module that owns Voice Intent, Voice Operation recency, Voice
Membership transitions, recovery policy, and the public Voice Session snapshot.
It never captures, renders, publishes, or decodes media itself.
_Avoid_: Voice orchestrator, recovery runner, session manager

**Voice Operation**:
A client-generated identifier for one requested join, move, recovery, or leave
transaction. Only the Voice Director may create or supersede it.
_Avoid_: Request ID, session ID, generation

**Client Instance**:
A stable identifier for one running web owner-tab or one running desktop main
process. One account may have only one active Client Instance in voice.
_Avoid_: Device ID, window ID, participant ID

## Authority and membership

**Voice Authority**:
The backend module that reserves Voice Operations and commits Voice Membership
only after observing a matching signed LiveKit participant.
_Avoid_: Gateway state, roster cache, client commit

**Voice Reservation**:
The provisional backend record created before RTC connection. It binds user,
channel, RTC Engine, Voice Operation, Client Instance, and Connection Epoch to
one signed credential lease.
_Avoid_: Pending session, token response, candidate room

**Voice Membership**:
The backend-confirmed fact that the selected RTC Engine has a matching
participant in a voice channel. Media Track readiness is not part of membership.
_Avoid_: Local connected flag, microphone ready, gateway ACK

**Connection Epoch**:
A unique identifier for one physical RTC connection attempt within a Voice
Operation. Recovery always uses a new Connection Epoch and participant identity.
_Avoid_: Native generation, reconnect count, request ID

**RTC Engine**:
The platform-selected implementation of one LiveKit Room and participant: the
browser adapter on web or the native adapter on Windows desktop.
_Avoid_: Sidecar, helper, publisher kind

**Authoritative Voice Snapshot**:
A complete backend snapshot carrying a monotonically ordered authority version
and the account's current Voice Membership. Missing data before such a snapshot
is not evidence of leave.
_Avoid_: Sync store contents, gateway connected event, participant delta

## Media

**Media Track**:
An independently controlled microphone, camera, screen video, or screen-audio
publication inside the RTC Engine's single participant. Track failure never
changes Voice Membership.
_Avoid_: Media session, native participant, sidecar room

**Microphone Pipeline**:
The single warm capture and DSP path for the selected input device. Publication,
meter preview, and voice activity detection consume this pipeline without
opening another capture path.
_Avoid_: Preview microphone, publication capture, room microphone

**Native Media Session**:
The Windows-native implementation behind the media utility host. It owns one
LiveKit Room, remote audio output, the Microphone Pipeline, and independent
Media Track actors for microphone, camera, screen video, and screen audio.
_Avoid_: Native publisher, microphone room, screen room

**User Mute**:
The mute choice represented by the user's button. Administrative, deafen,
push-to-talk, and lock-screen restrictions never overwrite it.
_Avoid_: Effective mute, track mute, server mute

**Effective Mute**:
The value applied to the published microphone track: User Mute, server mute,
deafen, server deafen, lock-screen privacy mute, or inactive push-to-talk may
each force it on. Muting keeps the Microphone Pipeline and publication alive.
_Avoid_: User mute, microphone disabled, capture stopped

**Media Demand**:
The renderer's current request for a visible remote camera or screen track and
its desired quality. Remote audio is always subscribed; remote video is
subscribed and decoded only while demanded.
_Avoid_: Video membership, renderer RTC, auto-subscribe state

## Failure and recovery

**Voice Recovery**:
Restoration of a previously committed Voice Membership after terminal RTC or
media-host failure. It preserves Voice Intent but creates a new Connection
Epoch; it is distinct from retrying an initial failed join.
_Avoid_: Rejoin click, media retry, gateway reconciliation

**Media Failure**:
A terminal failure of one Media Track, capture device, decoder, or output path.
It produces a typed media-specific error and never initiates Voice Recovery by
itself.
_Avoid_: Native media execution failed, voice disconnected, generic failure

**Runtime Loss**:
Termination or unresponsiveness of one Windows utility host. Media, hotkey, and
overlay runtime losses are isolated and recovered independently.
_Avoid_: Sidecar lost, application crash, voice state update failed
