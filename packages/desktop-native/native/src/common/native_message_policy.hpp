#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string_view>

namespace syrnike::desktop_native {

enum class NativeMessageLane : std::uint8_t {
  Control,
  VoiceControl,
  Query,
  Media,
  Telemetry,
  Realtime,
  Hooks,
};

enum class NativeMessageLoss : std::uint8_t {
  Lossless,
  CoalescedLatest,
  Sampled,
};

enum class NativeMessageOwner : std::uint8_t {
  None,
  Runtime,
  VoiceRoom,
  Publication,
  Capture,
  RendererLease,
  Hooks,
};

enum class NativeResourceDropPolicy : std::uint8_t {
  None,
  RequiredExactOnce,
};

enum class NativeDeliveryGuarantee : std::uint8_t {
  Standard,
  AcceptedExactOnce,
};

enum class NativeMessageVisibility : std::uint8_t {
  External,
  Internal,
  TestOnly,
};

enum class NativeMessageDestination : std::uint8_t {
  Runtime,
  Query,
  Voice,
  Microphone,
  Screen,
  Camera,
  Hooks,
  Node,
};

enum class NativePayloadProfile : std::uint8_t {
  Generic,
  Reply,
  Lifecycle,
  Session,
  Devices,
  DisplaySources,
  Input,
  ForegroundWindow,
  VideoFrame,
  VideoPublication,
  ActiveSpeakers,
  Statistics,
  MicrophoneMetrics,
  Configuration,
  SessionLifecycle,
  SessionStarted,
  SessionStopped,
  VoiceConnectionState,
  VoiceStatistics,
  ScreenStatistics,
  ScreenBackendRestart,
  ScreenCaptureEnded,
  MicrophonePreviewStarted,
  RemoteVideoPublication,
  LocalVideoTrackRemoved,
  RemoteVideoTrackRemoved,
  RemoteVideoFailed,
};

#define SYRNIKE_NATIVE_COMMAND_POLICY(X)                                       \
  X(Shutdown, "shutdown", External, Runtime, Control, Runtime, Lossless,       \
    Standard, None, Generic, CommandShutdown, HandleShutdown)                  \
  X(ListDevices, "listDevices", External, Query, Query, Runtime, Lossless,     \
    Standard, None, Devices, CommandListDevices, HandleListDevices)            \
  X(ListDisplaySources, "listDisplaySources", External, Query, Query, Runtime, \
    Lossless, Standard, None, DisplaySources, CommandListDisplaySources,       \
    HandleListDisplaySources)                                                  \
  X(ProbeQueryWorker, "probeQueryWorker", External, Query, Query, Runtime,     \
    Lossless, Standard, None, Generic, CommandProbeQueryWorker,                \
    HandleProbeQueryWorker)                                                    \
  X(WarmMicrophone, "warmMicrophone", External, Microphone, Control, Capture,  \
    Lossless, Standard, None, Configuration, CommandWarmMicrophone,            \
    HandleWarmMicrophone)                                                      \
  X(ConfigureMicrophone, "configureMicrophone", External, Microphone, Control, \
    Capture, Lossless, Standard, None, Configuration,                          \
    CommandConfigureMicrophone, HandleConfigureMicrophone)                     \
  X(ConnectMicrophone, "connectMicrophone", External, Microphone, Control,     \
    Publication, Lossless, Standard, None, Session, CommandConnectMicrophone,  \
    HandleConnectMicrophone)                                                   \
  X(SetMicrophoneMuted, "setMicrophoneMuted", External, Microphone, Control,   \
    Publication, Lossless, Standard, None, Configuration,                      \
    CommandSetMicrophoneMuted, HandleSetMicrophoneMuted)                       \
  X(DisconnectMicrophone, "disconnectMicrophone", External, Microphone,        \
    Control, Publication, Lossless, Standard, None, Session,                   \
    CommandDisconnectMicrophone, HandleDisconnectMicrophone)                   \
  X(InvalidateMicrophone, "invalidateMicrophone", External, Microphone,        \
    Control, Capture, Lossless, Standard, None, Generic,                       \
    CommandInvalidateMicrophone, HandleInvalidateMicrophone)                   \
  X(StartPreview, "startPreview", External, Microphone, Control, Capture,      \
    Lossless, Standard, None, Session, CommandStartPreview,                    \
    HandleStartPreview)                                                        \
  X(StopPreview, "stopPreview", External, Microphone, Control, Capture,        \
    Lossless, Standard, None, Session, CommandStopPreview, HandleStopPreview)  \
  X(StartMicrophonePreview, "startMicrophonePreview", TestOnly, Microphone,    \
    Control, Capture, Lossless, Standard, None, Session,                       \
    CommandStartMicrophonePreview, HandleStartMicrophonePreview)               \
  X(ProbeMicrophoneActor, "probeMicrophoneActor", External, Microphone,        \
    Control, Capture, Lossless, Standard, None, Generic,                       \
    CommandProbeMicrophoneActor, HandleProbeMicrophoneActor)                   \
  X(ConnectVoice, "connectVoice", External, Voice, Control, VoiceRoom,         \
    Lossless, Standard, None, Session, CommandConnectVoice,                    \
    HandleConnectVoice)                                                        \
  X(DisconnectVoice, "disconnectVoice", External, Voice, Control, VoiceRoom,   \
    Lossless, Standard, None, Session, CommandDisconnectVoice,                 \
    HandleDisconnectVoice)                                                     \
  X(ConfigureVoiceOutput, "configureVoiceOutput", External, Voice,             \
    VoiceControl, VoiceRoom, Lossless, Standard, None, Configuration,          \
    CommandConfigureVoiceOutput, HandleConfigureVoiceOutput)                   \
  X(ConfigureRemoteAudio, "configureRemoteAudio", External, Voice,             \
    VoiceControl, VoiceRoom, Lossless, Standard, None, Configuration,          \
    CommandConfigureRemoteAudio, HandleConfigureRemoteAudio)                   \
  X(ReleaseRemoteVideoFrame, "releaseRemoteVideoFrame", External, Voice,       \
    VoiceControl, RendererLease, Lossless, Standard, None, VideoFrame,         \
    CommandReleaseRemoteVideoFrame, HandleReleaseRemoteVideoFrame)             \
  X(SetRemoteVideoDemand, "setRemoteVideoDemand", External, Voice,             \
    VoiceControl, VoiceRoom, Lossless, Standard, None, VideoPublication,       \
    CommandSetRemoteVideoDemand, HandleSetRemoteVideoDemand)                   \
  X(RetryRemoteVideo, "retryRemoteVideo", External, Voice, VoiceControl,       \
    VoiceRoom, Lossless, Standard, None, VideoPublication,                     \
    CommandRetryRemoteVideo, HandleRetryRemoteVideo)                           \
  X(ProbeVoiceControl, "probeVoiceControl", External, Voice, VoiceControl,     \
    Runtime, Lossless, Standard, None, Generic, CommandProbeVoiceControl,      \
    HandleProbeVoiceControl)                                                   \
  X(ConnectScreen, "connectScreen", External, Screen, Control, Publication,    \
    Lossless, Standard, None, Session, CommandConnectScreen,                   \
    HandleConnectScreen)                                                       \
  X(StartScreenCapture, "startScreenCapture", External, Screen, Control,       \
    Capture, Lossless, Standard, None, Session, CommandStartScreenCapture,     \
    HandleStartScreenCapture)                                                  \
  X(StopScreenCapture, "stopScreenCapture", External, Screen, Control,         \
    Capture, Lossless, Standard, None, Session, CommandStopScreenCapture,      \
    HandleStopScreenCapture)                                                   \
  X(DisconnectScreen, "disconnectScreen", External, Screen, Control,           \
    Publication, Lossless, Standard, None, Session, CommandDisconnectScreen,   \
    HandleDisconnectScreen)                                                    \
  X(ProbeScreenActor, "probeScreenActor", External, Screen, Control, Capture,  \
    Lossless, Standard, None, Generic, CommandProbeScreenActor,                \
    HandleProbeScreenActor)                                                    \
  X(SetLocalScreenPreviewDemand, "setLocalScreenPreviewDemand", External,      \
    Screen, VoiceControl, RendererLease, Lossless, Standard, None,             \
    VideoPublication, CommandSetLocalScreenPreviewDemand,                      \
    HandleSetLocalScreenPreviewDemand)                                         \
  X(ReleaseLocalScreenPreviewFrame, "releaseLocalScreenPreviewFrame",          \
    External, Screen, VoiceControl, RendererLease, Lossless, Standard, None,   \
    VideoFrame, CommandReleaseLocalScreenPreviewFrame,                         \
    HandleReleaseLocalScreenPreviewFrame)                                      \
  X(ConnectCamera, "connectCamera", External, Camera, Control, Publication,    \
    Lossless, Standard, None, Session, CommandConnectCamera,                   \
    HandleConnectCamera)                                                       \
  X(DisconnectCamera, "disconnectCamera", External, Camera, Control,           \
    Publication, Lossless, Standard, None, Session, CommandDisconnectCamera,   \
    HandleDisconnectCamera)                                                    \
  X(ProbeCameraActor, "probeCameraActor", External, Camera, Control, Capture,  \
    Lossless, Standard, None, Generic, CommandProbeCameraActor,                \
    HandleProbeCameraActor)                                                    \
  X(ReleaseLocalCameraPreviewFrame, "releaseLocalCameraPreviewFrame",          \
    External, Camera, VoiceControl, RendererLease, Lossless, Standard, None,   \
    VideoFrame, CommandReleaseLocalCameraPreviewFrame,                         \
    HandleReleaseLocalCameraPreviewFrame)                                      \
  X(SetLocalCameraPreviewDemand, "setLocalCameraPreviewDemand", External,     \
    Camera, VoiceControl, RendererLease, Lossless, Standard, None,             \
    VideoPublication, CommandSetLocalCameraPreviewDemand,                      \
    HandleSetLocalCameraPreviewDemand)                                         \
  X(RetryLocalCameraPreview, "retryLocalCameraPreview", External, Camera,     \
    VoiceControl, RendererLease, Lossless, Standard, None, VideoPublication,   \
    CommandRetryLocalCameraPreview, HandleRetryLocalCameraPreview)             \
  X(StartHotkeys, "startHotkeys", External, Hooks, Hooks, Hooks, Lossless,     \
    Standard, None, Configuration, CommandStartHotkeys, HandleStartHotkeys)    \
  X(StopHotkeys, "stopHotkeys", External, Hooks, Hooks, Hooks, Lossless,       \
    Standard, None, Generic, CommandStopHotkeys, HandleStopHotkeys)            \
  X(StartOverlay, "startOverlay", External, Hooks, Hooks, Hooks, Lossless,     \
    Standard, None, Configuration, CommandStartOverlay, HandleStartOverlay)    \
  X(StopOverlay, "stopOverlay", External, Hooks, Hooks, Hooks, Lossless,       \
    Standard, None, Generic, CommandStopOverlay, HandleStopOverlay)            \
  X(ProbeHooksRuntime, "probeHooksRuntime", External, Hooks, Hooks, Hooks,     \
    Lossless, Standard, None, Generic, CommandProbeHooksRuntime,               \
    HandleProbeHooksRuntime)                                                   \
  X(VoiceTerminal, "__voiceTerminal", Internal, Voice, Control, VoiceRoom,     \
    Lossless, AcceptedExactOnce, None, Lifecycle, CommandVoiceTerminal,        \
    HandleVoiceTerminal)                                                       \
  X(VoiceConnectCompleted, "__voiceConnectCompleted", Internal, Voice,         \
    Control, VoiceRoom, Lossless, Standard, None, Lifecycle,                   \
    CommandVoiceConnectCompleted, HandleVoiceConnectCompleted)                 \
  X(VoiceConnectionStateChanged, "__voiceConnectionStateChanged", Internal,    \
    Voice, Control, VoiceRoom, Lossless, Standard, None, Lifecycle,            \
    CommandVoiceConnectionStateChanged, HandleVoiceConnectionStateChanged)     \
  X(VoiceOutputStateChanged, "__voiceOutputStateChanged", Internal, Voice,     \
    Control, VoiceRoom, Lossless, Standard, None, Configuration,               \
    CommandVoiceOutputStateChanged, HandleVoiceOutputStateChanged)             \
  X(VoiceRemoteAudioTrackFailed, "__voiceRemoteAudioTrackFailed", Internal,    \
    Voice, Control, VoiceRoom, Lossless, Standard, None, VideoPublication,     \
    CommandVoiceRemoteAudioTrackFailed, HandleVoiceRemoteAudioTrackFailed)     \
  X(ReconcileRemotePublication, "__reconcileRemotePublication", Internal,      \
    Voice, VoiceControl, VoiceRoom, Lossless, Standard, None,                  \
    VideoPublication, CommandReconcileRemotePublication,                       \
    HandleReconcileRemotePublication)                                          \
  X(VoiceStats, "__voiceStats", Internal, Voice, Telemetry, VoiceRoom,         \
    Sampled, Standard, None, Statistics, CommandVoiceStats, HandleVoiceStats)  \
  X(VoiceActiveSpeakers, "__voiceActiveSpeakers", Internal, Voice, Media,      \
    VoiceRoom, CoalescedLatest, Standard, None, ActiveSpeakers,                \
    CommandVoiceActiveSpeakers, HandleVoiceActiveSpeakers)                     \
  X(LocalMicrophoneUnpublished, "__localMicrophoneUnpublished", Internal,      \
    Voice, Control, Publication, Lossless, Standard, None, VideoPublication,   \
    CommandLocalMicrophoneUnpublished, HandleLocalMicrophoneUnpublished)       \
  X(MicrophonePublicationUnpublished, "__microphonePublicationUnpublished",    \
    Internal, Microphone, Control, Publication, Lossless, Standard, None,      \
    VideoPublication, CommandMicrophonePublicationUnpublished,                 \
    HandleMicrophonePublicationUnpublished)                                    \
  X(MicrophoneAttemptReady, "__microphoneAttemptReady", Internal, Microphone,  \
    Control, Publication, Lossless, Standard, None, Lifecycle,                 \
    CommandMicrophoneAttemptReady, HandleMicrophoneAttemptReady)               \
  X(MicrophoneAttemptFailed, "__microphoneAttemptFailed", Internal,            \
    Microphone, Control, Publication, Lossless, Standard, None, Lifecycle,     \
    CommandMicrophoneAttemptFailed, HandleMicrophoneAttemptFailed)             \
  X(MicrophoneRetireDone, "__microphoneRetireDone", Internal, Microphone,      \
    Control, Publication, Lossless, Standard, None, Lifecycle,                 \
    CommandMicrophoneRetireDone, HandleMicrophoneRetireDone)                   \
  X(MicrophoneEndpointChanged, "__microphoneEndpointChanged", Internal,        \
    Microphone, Control, Capture, Lossless, Standard, None, Configuration,     \
    CommandMicrophoneEndpointChanged, HandleMicrophoneEndpointChanged)         \
  X(MicrophoneProcessingStatus, "__microphoneProcessingStatus", Internal,      \
    Microphone, Control, Capture, Lossless, Standard, None, Configuration,     \
    CommandMicrophoneProcessingStatus, HandleMicrophoneProcessingStatus)       \
  X(MicrophoneIdleExpired, "__microphoneIdleExpired", Internal, Microphone,    \
    Control, Capture, Lossless, Standard, None, Lifecycle,                     \
    CommandMicrophoneIdleExpired, HandleMicrophoneIdleExpired)                 \
  X(MicrophoneTerminal, "__microphoneTerminal", Internal, Microphone, Control, \
    Capture, Lossless, AcceptedExactOnce, None, Lifecycle,                     \
    CommandMicrophoneTerminal, HandleMicrophoneTerminal)                       \
  X(ScreenAttemptReady, "__screenAttemptReady", Internal, Screen, Control,     \
    Publication, Lossless, Standard, None, Lifecycle,                          \
    CommandScreenAttemptReady, HandleScreenAttemptReady)                       \
  X(ScreenAttemptFailed, "__screenAttemptFailed", Internal, Screen, Control,   \
    Publication, Lossless, Standard, None, Lifecycle,                          \
    CommandScreenAttemptFailed, HandleScreenAttemptFailed)                     \
  X(ScreenRetireDone, "__screenRetireDone", Internal, Screen, Control,         \
    Publication, Lossless, Standard, None, Lifecycle, CommandScreenRetireDone, \
    HandleScreenRetireDone)                                                    \
  X(ScreenTerminal, "__screenTerminal", Internal, Screen, Control, Capture,    \
    Lossless, AcceptedExactOnce, None, Lifecycle, CommandScreenTerminal,       \
    HandleScreenTerminal)                                                      \
  X(ScreenAudioAttemptReady, "__screenAudioAttemptReady", Internal, Screen,    \
    Control, Publication, Lossless, Standard, None, Lifecycle,                 \
    CommandScreenAudioAttemptReady, HandleScreenAudioAttemptReady)             \
  X(ScreenAudioAttemptFailed, "__screenAudioAttemptFailed", Internal, Screen,  \
    Control, Publication, Lossless, Standard, None, Lifecycle,                 \
    CommandScreenAudioAttemptFailed, HandleScreenAudioAttemptFailed)           \
  X(ScreenAudioTerminal, "__screenAudioTerminal", Internal, Screen, Control,   \
    Capture, Lossless, AcceptedExactOnce, None, Lifecycle,                     \
    CommandScreenAudioTerminal, HandleScreenAudioTerminal)                     \
  X(LocalScreenPreviewFrame, "__localScreenPreviewFrame", Internal, Screen,    \
    Media, RendererLease, CoalescedLatest, Standard, RequiredExactOnce,        \
    VideoFrame, CommandLocalScreenPreviewFrame, HandleLocalScreenPreviewFrame) \
  X(LocalScreenPreviewFailed, "__localScreenPreviewFailed", Internal, Screen,  \
    Control, RendererLease, Lossless, Standard, None, Lifecycle,               \
    CommandLocalScreenPreviewFailed, HandleLocalScreenPreviewFailed)           \
  X(LocalScreenPreviewTrackRemoved, "__localScreenPreviewTrackRemoved",        \
    Internal, Screen, Control, RendererLease, Lossless, Standard, None,        \
    VideoPublication, CommandLocalScreenPreviewTrackRemoved,                   \
    HandleLocalScreenPreviewTrackRemoved)                                      \
  X(CameraTerminal, "__cameraTerminal", Internal, Camera, Control, Capture,    \
    Lossless, AcceptedExactOnce, None, Lifecycle, CommandCameraTerminal,       \
    HandleCameraTerminal)                                                      \
  X(LocalCameraPreviewFrame, "__localCameraPreviewFrame", Internal, Camera,    \
    Media, RendererLease, CoalescedLatest, Standard, RequiredExactOnce,        \
    VideoFrame, CommandLocalCameraPreviewFrame, HandleLocalCameraPreviewFrame) \
  X(LocalCameraPreviewFailed, "__localCameraPreviewFailed", Internal, Camera,  \
    Control, RendererLease, Lossless, Standard, None, Lifecycle,               \
    CommandLocalCameraPreviewFailed, HandleLocalCameraPreviewFailed)           \
  X(LocalCameraPreviewTrackRemoved, "__localCameraPreviewTrackRemoved",        \
    Internal, Camera, Control, RendererLease, Lossless, Standard, None,        \
    VideoPublication, CommandLocalCameraPreviewTrackRemoved,                   \
    HandleLocalCameraPreviewTrackRemoved)                                      \
  X(RemoteVideoFrame, "__remoteVideoFrame", Internal, Voice, Media,            \
    RendererLease, CoalescedLatest, Standard, RequiredExactOnce, VideoFrame,   \
    CommandRemoteVideoFrame, HandleRemoteVideoFrame)                           \
  X(RemoteVideoFailed, "__remoteVideoFailed", Internal, Voice, Control,        \
    RendererLease, Lossless, Standard, None, Lifecycle,                        \
    CommandRemoteVideoFailed, HandleRemoteVideoFailed)                         \
  X(RemoteVideoTrackRemoved, "__remoteVideoTrackRemoved", Internal, Voice,     \
    Control, RendererLease, Lossless, Standard, None, VideoPublication,        \
    CommandRemoteVideoTrackRemoved, HandleRemoteVideoTrackRemoved)             \
  X(RemoteVideoPublicationAvailable, "__remoteVideoPublicationAvailable",      \
    Internal, Voice, Control, VoiceRoom, Lossless, Standard, None,             \
    VideoPublication, CommandRemoteVideoPublicationAvailable,                  \
    HandleRemoteVideoPublicationAvailable)                                     \
  X(RemoteVideoPublicationUnavailable, "__remoteVideoPublicationUnavailable",  \
    Internal, Voice, Control, VoiceRoom, Lossless, Standard, None,             \
    VideoPublication, CommandRemoteVideoPublicationUnavailable,                \
    HandleRemoteVideoPublicationUnavailable)

enum class NativeCommandType : std::uint16_t {
#define SYRNIKE_COMMAND_ENUM(name, ...) name,
  SYRNIKE_NATIVE_COMMAND_POLICY(SYRNIKE_COMMAND_ENUM)
#undef SYRNIKE_COMMAND_ENUM
      Count,
};

#define SYRNIKE_NATIVE_EVENT_POLICY(X)                                         \
  X(Reply, "reply", External, Node, Control, Runtime, Lossless, Standard,      \
    None, Reply, EventReply, SerializeReply)                                   \
  X(RuntimeError, "runtimeError", External, Node, Control, Runtime, Lossless,  \
    Standard, None, Lifecycle, EventRuntimeError, SerializeRuntimeError)       \
  X(SessionLifecycle, "sessionLifecycle", External, Node, Control, Runtime,    \
    Lossless, Standard, None, SessionLifecycle, EventSessionLifecycle,         \
    SerializeSessionLifecycle)                                                 \
  X(SessionStarted, "sessionStarted", External, Node, Control, Publication,    \
    Lossless, Standard, None, SessionStarted, EventSessionStarted,             \
    SerializeSessionStarted)                                                   \
  X(SessionStopped, "sessionStopped", External, Node, Control, Publication,    \
    Lossless, Standard, None, SessionStopped, EventSessionStopped,             \
    SerializeSessionStopped)                                                   \
  X(VoiceConnectionState, "voiceConnectionState", External, Node, Control,     \
    VoiceRoom, Lossless, Standard, None, VoiceConnectionState,                 \
    EventVoiceConnectionState, SerializeVoiceConnectionState)                  \
  X(VoiceTerminal, "voiceTerminal", External, Node, Control, VoiceRoom,        \
    Lossless, Standard, None, Lifecycle, EventVoiceTerminal,                   \
    SerializeVoiceTerminal)                                                    \
  X(VoiceStats, "voiceStats", External, Node, Telemetry, VoiceRoom, Sampled,   \
    Standard, None, VoiceStatistics, EventVoiceStats, SerializeVoiceStats)     \
  X(ActiveSpeakers, "activeSpeakers", External, Node, Media, VoiceRoom,        \
    CoalescedLatest, Standard, None, ActiveSpeakers, EventActiveSpeakers,      \
    SerializeActiveSpeakers)                                                   \
  X(LocalMicrophoneUnpublished, "localMicrophoneUnpublished", External, Node,  \
    Control, Publication, Lossless, Standard, None, VideoPublication,          \
    EventLocalMicrophoneUnpublished, SerializeLocalMicrophoneUnpublished)      \
  X(MicrophoneMetrics, "microphoneMetrics", External, Node, Telemetry,         \
    Capture, Sampled, Standard, None, MicrophoneMetrics,                       \
    EventMicrophoneMetrics, SerializeMicrophoneMetrics)                        \
  X(MicrophonePreviewStarted, "microphonePreviewStarted", External, Node,      \
    Control, Capture, Lossless, Standard, None, MicrophonePreviewStarted,      \
    EventMicrophonePreviewStarted, SerializeMicrophonePreviewStarted)          \
  X(DeviceList, "deviceList", External, Node, Control, Runtime, Lossless,      \
    Standard, None, Devices, EventDeviceList, SerializeDeviceList)             \
  X(DisplaySourceList, "displaySourceList", External, Node, Control, Runtime,  \
    Lossless, Standard, None, DisplaySources, EventDisplaySourceList,          \
    SerializeDisplaySourceList)                                                \
  X(ScreenBackendRestart, "screenBackendRestart", External, Node, Control,     \
    Capture, Lossless, Standard, None, ScreenBackendRestart,                   \
    EventScreenBackendRestart, SerializeScreenBackendRestart)                  \
  X(ScreenCaptureEnded, "screenCaptureEnded", External, Node, Control,         \
    Capture, Lossless, Standard, None, ScreenCaptureEnded,                     \
    EventScreenCaptureEnded, SerializeScreenCaptureEnded)                      \
  X(Stats, "stats", External, Node, Telemetry, Capture, Sampled, Standard,     \
    None, ScreenStatistics, EventStats, SerializeStats)                        \
  X(RemoteVideoFrame, "remoteVideoFrame", External, Node, Media,               \
    RendererLease, CoalescedLatest, Standard, RequiredExactOnce, VideoFrame,   \
    EventRemoteVideoFrame, SerializeRemoteVideoFrame)                          \
  X(RemoteVideoFailed, "remoteVideoFailed", External, Node, Control,           \
    RendererLease, Lossless, Standard, None, RemoteVideoFailed,                \
    EventRemoteVideoFailed, SerializeRemoteVideoFailed)                        \
  X(RemoteVideoTrackRemoved, "remoteVideoTrackRemoved", External, Node,        \
    Control, RendererLease, Lossless, Standard, None, RemoteVideoTrackRemoved, \
    EventRemoteVideoTrackRemoved, SerializeRemoteVideoTrackRemoved)            \
  X(RemoteVideoPublicationAvailable, "remoteVideoPublicationAvailable",        \
    External, Node, Control, VoiceRoom, Lossless, Standard, None,              \
    RemoteVideoPublication, EventRemoteVideoPublicationAvailable,              \
    SerializeRemoteVideoPublicationAvailable)                                  \
  X(RemoteVideoPublicationUnavailable, "remoteVideoPublicationUnavailable",    \
    External, Node, Control, VoiceRoom, Lossless, Standard, None,              \
    RemoteVideoPublication, EventRemoteVideoPublicationUnavailable,            \
    SerializeRemoteVideoPublicationUnavailable)                                \
  X(LocalScreenPreviewFrame, "localScreenPreviewFrame", External, Node, Media, \
    RendererLease, CoalescedLatest, Standard, RequiredExactOnce, VideoFrame,   \
    EventLocalScreenPreviewFrame, SerializeLocalScreenPreviewFrame)            \
  X(LocalScreenPreviewFailed, "localScreenPreviewFailed", External, Node,      \
    Control, RendererLease, Lossless, Standard, None, Lifecycle,               \
    EventLocalScreenPreviewFailed, SerializeLocalScreenPreviewFailed)          \
  X(LocalScreenPreviewTrackRemoved, "localScreenPreviewTrackRemoved",          \
    External, Node, Control, RendererLease, Lossless, Standard, None,          \
    LocalVideoTrackRemoved, EventLocalScreenPreviewTrackRemoved,               \
    SerializeLocalScreenPreviewTrackRemoved)                                   \
  X(LocalCameraPreviewFrame, "localCameraPreviewFrame", External, Node, Media, \
    RendererLease, CoalescedLatest, Standard, RequiredExactOnce, VideoFrame,   \
    EventLocalCameraPreviewFrame, SerializeLocalCameraPreviewFrame)            \
  X(LocalCameraPreviewFailed, "localCameraPreviewFailed", External, Node,      \
    Control, RendererLease, Lossless, Standard, None, Lifecycle,               \
    EventLocalCameraPreviewFailed, SerializeLocalCameraPreviewFailed)          \
  X(LocalCameraPreviewTrackRemoved, "localCameraPreviewTrackRemoved",          \
    External, Node, Control, RendererLease, Lossless, Standard, None,          \
    LocalVideoTrackRemoved, EventLocalCameraPreviewTrackRemoved,               \
    SerializeLocalCameraPreviewTrackRemoved)                                   \
  X(CameraTerminal, "cameraTerminal", External, Node, Control, Capture,        \
    Lossless, Standard, None, Lifecycle, EventCameraTerminal,                  \
    SerializeCameraTerminal)                                                   \
  X(Input, "input", External, Node, Realtime, Hooks, CoalescedLatest,          \
    Standard, None, Input, EventInput, SerializeInput)                         \
  X(ForegroundWindow, "foregroundWindow", External, Node, Realtime, Hooks,     \
    CoalescedLatest, Standard, None, ForegroundWindow, EventForegroundWindow,  \
    SerializeForegroundWindow)                                                 \
  X(NativeSmokeQuarantineBlockEntered, "nativeSmokeQuarantineBlockEntered",    \
    TestOnly, Node, Control, Runtime, Lossless, Standard, None, Generic,       \
    EventNativeSmokeQuarantineBlockEntered,                                    \
    SerializeNativeSmokeQuarantineBlockEntered)                                \
  X(Test, "test", TestOnly, Node, Control, Runtime, Lossless, Standard, None,  \
    Generic, EventTest, SerializeTest)

enum class NativeEventType : std::uint16_t {
#define SYRNIKE_EVENT_ENUM(name, ...) name,
  SYRNIKE_NATIVE_EVENT_POLICY(SYRNIKE_EVENT_ENUM)
#undef SYRNIKE_EVENT_ENUM
      Count,
};

enum class NativeMessageSchema : std::uint16_t {
#define SYRNIKE_COMMAND_SCHEMA(_name, _wire, _visibility, _destination, _lane, \
                               _owner, _loss, _delivery, _drop, _payload,      \
                               schema, _action)                                \
  schema,
  SYRNIKE_NATIVE_COMMAND_POLICY(SYRNIKE_COMMAND_SCHEMA)
#undef SYRNIKE_COMMAND_SCHEMA
#define SYRNIKE_EVENT_SCHEMA(_name, _wire, _visibility, _destination, _lane,   \
                             _owner, _loss, _delivery, _drop, _payload,        \
                             schema, _action)                                  \
  schema,
      SYRNIKE_NATIVE_EVENT_POLICY(SYRNIKE_EVENT_SCHEMA)
#undef SYRNIKE_EVENT_SCHEMA
          Count,
};

enum class NativeMessageAction : std::uint16_t {
#define SYRNIKE_COMMAND_ACTION(_name, _wire, _visibility, _destination, _lane, \
                               _owner, _loss, _delivery, _drop, _payload,      \
                               _schema, action)                                \
  action,
  SYRNIKE_NATIVE_COMMAND_POLICY(SYRNIKE_COMMAND_ACTION)
#undef SYRNIKE_COMMAND_ACTION
#define SYRNIKE_EVENT_ACTION(_name, _wire, _visibility, _destination, _lane,   \
                             _owner, _loss, _delivery, _drop, _payload,        \
                             _schema, action)                                  \
  action,
      SYRNIKE_NATIVE_EVENT_POLICY(SYRNIKE_EVENT_ACTION)
#undef SYRNIKE_EVENT_ACTION
          Count,
};

template <typename Type> struct NativeMessagePolicy {
  Type type;
  std::string_view wire_name;
  NativeMessageVisibility visibility;
  NativeMessageDestination destination;
  NativeMessageLane lane;
  NativeMessageOwner owner;
  NativeMessageLoss loss;
  NativeDeliveryGuarantee delivery;
  NativeResourceDropPolicy resource_drop;
  NativePayloadProfile payload;
  NativeMessageSchema schema;
  NativeMessageAction action;
};

inline constexpr auto kNativeCommandPolicies = std::array{
#define SYRNIKE_COMMAND_ROW(name, wire, visibility, destination, lane, owner,  \
                            loss, delivery, drop, payload, schema, action)     \
  NativeMessagePolicy<NativeCommandType>{                                      \
      NativeCommandType::name,                                                 \
      wire,                                                                    \
      NativeMessageVisibility::visibility,                                     \
      NativeMessageDestination::destination,                                   \
      NativeMessageLane::lane,                                                 \
      NativeMessageOwner::owner,                                               \
      NativeMessageLoss::loss,                                                 \
      NativeDeliveryGuarantee::delivery,                                       \
      NativeResourceDropPolicy::drop,                                          \
      NativePayloadProfile::payload,                                           \
      NativeMessageSchema::schema,                                             \
      NativeMessageAction::action},
    SYRNIKE_NATIVE_COMMAND_POLICY(SYRNIKE_COMMAND_ROW)
#undef SYRNIKE_COMMAND_ROW
};

inline constexpr auto kNativeEventPolicies = std::array{
#define SYRNIKE_EVENT_ROW(name, wire, visibility, destination, lane, owner,    \
                          loss, delivery, drop, payload, schema, action)       \
  NativeMessagePolicy<NativeEventType>{NativeEventType::name,                  \
                                       wire,                                   \
                                       NativeMessageVisibility::visibility,    \
                                       NativeMessageDestination::destination,  \
                                       NativeMessageLane::lane,                \
                                       NativeMessageOwner::owner,              \
                                       NativeMessageLoss::loss,                \
                                       NativeDeliveryGuarantee::delivery,      \
                                       NativeResourceDropPolicy::drop,         \
                                       NativePayloadProfile::payload,          \
                                       NativeMessageSchema::schema,            \
                                       NativeMessageAction::action},
    SYRNIKE_NATIVE_EVENT_POLICY(SYRNIKE_EVENT_ROW)
#undef SYRNIKE_EVENT_ROW
};

static_assert(kNativeCommandPolicies.size() ==
              static_cast<std::size_t>(NativeCommandType::Count));
static_assert(kNativeEventPolicies.size() ==
              static_cast<std::size_t>(NativeEventType::Count));

template <typename Type, std::size_t Size>
constexpr const NativeMessagePolicy<Type> &nativeMessagePolicy(
    Type type,
    const std::array<NativeMessagePolicy<Type>, Size> &policies) noexcept {
  return policies[static_cast<std::size_t>(type)];
}

constexpr const auto &nativeCommandPolicy(NativeCommandType type) noexcept {
  return nativeMessagePolicy(type, kNativeCommandPolicies);
}

constexpr const auto &nativeEventPolicy(NativeEventType type) noexcept {
  return nativeMessagePolicy(type, kNativeEventPolicies);
}

template <typename Type, std::size_t Size>
constexpr std::optional<Type> parseNativeMessageType(
    std::string_view wire_name,
    const std::array<NativeMessagePolicy<Type>, Size> &policies) noexcept {
  for (const auto &policy : policies) {
    if (policy.wire_name == wire_name)
      return policy.type;
  }
  return std::nullopt;
}

constexpr std::optional<NativeCommandType>
parseNativeCommandType(std::string_view wire_name) noexcept {
  return parseNativeMessageType(wire_name, kNativeCommandPolicies);
}

constexpr std::optional<NativeEventType>
parseNativeEventType(std::string_view wire_name) noexcept {
  return parseNativeMessageType(wire_name, kNativeEventPolicies);
}

constexpr bool isValidNativeCommandType(NativeCommandType type) noexcept {
  return static_cast<std::size_t>(type) <
         static_cast<std::size_t>(NativeCommandType::Count);
}

constexpr bool isValidNativeEventType(NativeEventType type) noexcept {
  return static_cast<std::size_t>(type) <
         static_cast<std::size_t>(NativeEventType::Count);
}

constexpr std::string_view nativeCommandName(NativeCommandType type) noexcept {
  return isValidNativeCommandType(type) ? nativeCommandPolicy(type).wire_name
                                        : std::string_view{};
}

constexpr std::string_view nativeEventName(NativeEventType type) noexcept {
  return isValidNativeEventType(type) ? nativeEventPolicy(type).wire_name
                                      : std::string_view{};
}

constexpr bool nativeResourcePoliciesAreSafe() noexcept {
  std::size_t accepted_terminal_count = 0;
  for (const auto &policy : kNativeCommandPolicies) {
    const bool owns_renderer_frame =
        policy.visibility == NativeMessageVisibility::Internal &&
        policy.payload == NativePayloadProfile::VideoFrame;
    if (owns_renderer_frame &&
        policy.resource_drop != NativeResourceDropPolicy::RequiredExactOnce) {
      return false;
    }
    if (policy.resource_drop == NativeResourceDropPolicy::RequiredExactOnce &&
        (policy.owner != NativeMessageOwner::RendererLease ||
         policy.lane != NativeMessageLane::Media ||
         policy.loss != NativeMessageLoss::CoalescedLatest)) {
      return false;
    }
    if (policy.delivery == NativeDeliveryGuarantee::AcceptedExactOnce) {
      ++accepted_terminal_count;
      if (policy.visibility != NativeMessageVisibility::Internal ||
          policy.lane != NativeMessageLane::Control ||
          policy.loss != NativeMessageLoss::Lossless) {
        return false;
      }
    }
  }
  for (const auto &policy : kNativeEventPolicies) {
    const bool owns_renderer_frame =
        policy.payload == NativePayloadProfile::VideoFrame;
    if (owns_renderer_frame &&
        policy.resource_drop != NativeResourceDropPolicy::RequiredExactOnce) {
      return false;
    }
    if (policy.resource_drop == NativeResourceDropPolicy::RequiredExactOnce &&
        (policy.owner != NativeMessageOwner::RendererLease ||
         policy.lane != NativeMessageLane::Media ||
         policy.loss != NativeMessageLoss::CoalescedLatest)) {
      return false;
    }
  }
  return accepted_terminal_count == 5;
}

static_assert(
    nativeResourcePoliciesAreSafe(),
    "resource-bearing native variants require exact-once media drop policy");

#undef SYRNIKE_NATIVE_COMMAND_POLICY
#undef SYRNIKE_NATIVE_EVENT_POLICY

} // namespace syrnike::desktop_native
