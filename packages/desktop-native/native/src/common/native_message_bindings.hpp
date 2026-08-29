#pragma once

#include <array>
#include <cstddef>
#include <optional>
#include <string_view>

#include "native_message_policy.hpp"

namespace syrnike::desktop_native {

// These lists are the concrete native implementation registry. They are
// intentionally independent from the policy catalog: adding a catalog row
// without a dispatch/codec implementation makes the coverage assertion fail.
// BEGIN GENERATED EXTERNAL MESSAGE FIELD SHAPES
#define SYRNIKE_NATIVE_EXTERNAL_FIELD_SHAPES(X) \
  X(CommandShutdown, "{type:literal(\"shutdown\")}") \
  X(CommandListDevices, "{kind:literal(\"audioinput\")|literal(\"audiooutput\")|literal(\"videoinput\"),type:literal(\"listDevices\")}") \
  X(CommandListDisplaySources, "{action:literal(\"cancel\"),enumerationId:string,type:literal(\"listDisplaySources\")}|{action:literal(\"metadata\"),enumerationId:string,page:number,selfWindowHwnd?:string|undefined,type:literal(\"listDisplaySources\")}|{action:literal(\"thumbnail\"),enumerationId:string,selfWindowHwnd?:string|undefined,sourceId:string,type:literal(\"listDisplaySources\")}") \
  X(CommandProbeQueryWorker, "{type:literal(\"probeQueryWorker\")}") \
  X(CommandWarmMicrophone, "{config:{automaticGainControl:boolean,bypassSystemAudioInputProcessing:boolean,deviceId:null|string,echoCancellation:boolean,inputVolume:number,noiseSuppression:boolean,voiceGateAutoThreshold:boolean,voiceGateEnabled:boolean,voiceGateThresholdDb:number},generation:number,type:literal(\"warmMicrophone\")}") \
  X(CommandConfigureMicrophone, "{config:{automaticGainControl:boolean,bypassSystemAudioInputProcessing:boolean,deviceId:null|string,echoCancellation:boolean,inputVolume:number,noiseSuppression:boolean,voiceGateAutoThreshold:boolean,voiceGateEnabled:boolean,voiceGateThresholdDb:number},revision:number,type:literal(\"configureMicrophone\")}") \
  X(CommandConnectMicrophone, "{excludeProcessId:number,generation:number,options:{audioBitrate?:number|undefined,kind:literal(\"microphone\"),livekit?:never|undefined,muted?:boolean|undefined,participantIdentity:string,requestId:string},sessionId:string,type:literal(\"connectMicrophone\")}") \
  X(CommandSetMicrophoneMuted, "{generation:number,muted:boolean,sessionId:string,type:literal(\"setMicrophoneMuted\")}") \
  X(CommandDisconnectMicrophone, "{generation:number,sessionId:string,type:literal(\"disconnectMicrophone\")}") \
  X(CommandInvalidateMicrophone, "{generation:number,sessionId:string,type:literal(\"invalidateMicrophone\")}") \
  X(CommandStartPreview, "{generation:number,sessionId:string,type:literal(\"startPreview\")}") \
  X(CommandStopPreview, "{generation?:number|undefined,sessionId?:string|undefined,type:literal(\"stopPreview\")}") \
  X(CommandProbeMicrophoneActor, "{type:literal(\"probeMicrophoneActor\")}") \
  X(CommandConnectVoice, "{generation:number,options:{livekit:{participantIdentity:string,token:string,url:string}},sessionId:string,type:literal(\"connectVoice\")}") \
  X(CommandDisconnectVoice, "{generation:number,sessionId:string,type:literal(\"disconnectVoice\")}") \
  X(CommandConfigureVoiceOutput, "{deafened:boolean,deviceId?:string|undefined,generation:number,sessionId:string,type:literal(\"configureVoiceOutput\"),volume?:number|undefined}") \
  X(CommandConfigureRemoteAudio, "{generation:number,sessionId:string,settings:{revision:number,streamMutes:{[string]:boolean},streamVolumes:{[string]:number},userMutes:{[string]:boolean},userVolumes:{[string]:number}},type:literal(\"configureRemoteAudio\")}") \
  X(CommandReleaseRemoteVideoFrame, "{generation:number,sequence:number,sessionId:string,trackId:string,type:literal(\"releaseRemoteVideoFrame\")}") \
  X(CommandSetRemoteVideoDemand, "{demanded:boolean,generation:number,sessionId:string,trackId:string,type:literal(\"setRemoteVideoDemand\")}") \
  X(CommandRetryRemoteVideo, "{generation:number,reason:string,sessionId:string,trackId:string,type:literal(\"retryRemoteVideo\")}") \
  X(CommandProbeVoiceControl, "{type:literal(\"probeVoiceControl\")}") \
  X(CommandConnectScreen, "{generation:number,options:{livekit?:never|undefined,participantIdentity:string},sessionId:string,type:literal(\"connectScreen\")}") \
  X(CommandStartScreenCapture, "{excludeProcessId:number,generation:number,options:{audio?:undefined|{requested:boolean},audioBitrate?:number|undefined,bitrate:number,fps:number,height:number,kind:literal(\"screen\"),livekit?:never|undefined,participantIdentity:string,requestId:string,sourceId:string,width:number},selfWindowHwnd?:string|undefined,sessionId:string,type:literal(\"startScreenCapture\")}") \
  X(CommandStopScreenCapture, "{generation:number,sessionId:string,type:literal(\"stopScreenCapture\")}") \
  X(CommandDisconnectScreen, "{generation:number,sessionId?:string|undefined,terminal?:boolean|undefined,type:literal(\"disconnectScreen\")}") \
  X(CommandProbeScreenActor, "{type:literal(\"probeScreenActor\")}") \
  X(CommandSetLocalScreenPreviewDemand, "{demanded:boolean,electronMainPid:number,generation:number,options:{fps:number,height:number,width:number},sessionId:string,type:literal(\"setLocalScreenPreviewDemand\")}") \
  X(CommandReleaseLocalScreenPreviewFrame, "{generation:number,sequence:number,sessionId:string,trackId:string,type:literal(\"releaseLocalScreenPreviewFrame\")}") \
  X(CommandConnectCamera, "{generation:number,options:{bitrate?:number|undefined,deviceId?:string|undefined,fps?:number|undefined,height?:number|undefined,livekit?:never|undefined,participantIdentity:string,width?:number|undefined},sessionId:string,type:literal(\"connectCamera\")}") \
  X(CommandDisconnectCamera, "{generation:number,sessionId:string,type:literal(\"disconnectCamera\")}") \
  X(CommandProbeCameraActor, "{type:literal(\"probeCameraActor\")}") \
  X(CommandReleaseLocalCameraPreviewFrame, "{generation:number,sequence:number,sessionId:string,trackId:string,type:literal(\"releaseLocalCameraPreviewFrame\")}") \
  X(CommandSetLocalCameraPreviewDemand, "{demanded:boolean,generation:number,sessionId:string,type:literal(\"setLocalCameraPreviewDemand\")}") \
  X(CommandRetryLocalCameraPreview, "{generation:number,reason:string,sessionId:string,type:literal(\"retryLocalCameraPreview\")}") \
  X(CommandStartHotkeys, "{type:literal(\"startHotkeys\")}") \
  X(CommandStopHotkeys, "{type:literal(\"stopHotkeys\")}") \
  X(CommandStartOverlay, "{type:literal(\"startOverlay\")}") \
  X(CommandStopOverlay, "{type:literal(\"stopOverlay\")}") \
  X(CommandProbeHooksRuntime, "{type:literal(\"probeHooksRuntime\")}") \
  X(EventReply, "{error:{code:string,generation?:number|undefined,hresult?:number|undefined,message:string,retryable:boolean,sessionId?:string|undefined,stage?:string|undefined},ok:literal(false),requestId:string,type:literal(\"reply\")}|{ok:literal(true),requestId:string,result?:undefined|unknown,type:literal(\"reply\")}") \
  X(EventRuntimeError, "{error:{code:string,generation?:number|undefined,hresult?:number|undefined,message:string,retryable:boolean,sessionId?:string|undefined,stage?:string|undefined},generation?:number|undefined,sequence:number,sessionId?:string|undefined,type:literal(\"runtimeError\")}") \
  X(EventSessionLifecycle, "{error?:undefined|{code:string,generation?:number|undefined,hresult?:number|undefined,message:string,retryable:boolean,sessionId?:string|undefined,stage?:string|undefined},generation:number,kind?:literal(\"camera\")|literal(\"microphone\")|literal(\"output\")|literal(\"screen\")|literal(\"screen_audio\")|literal(\"voice\")|undefined,requestId?:string|undefined,sequence:number,sessionId:string,state:{audio?:undefined|{mode:literal(\"microphone\")|literal(\"none\")|literal(\"process\")|literal(\"system_exclude\")},bitrate?:number|undefined,deviceId?:string|undefined,fps?:number|undefined,height?:number|undefined,message:string,sessionId?:string|undefined,status:literal(\"error\"),width?:number|undefined}|{audio?:undefined|{mode:literal(\"microphone\")|literal(\"none\")|literal(\"process\")|literal(\"system_exclude\")},bitrate?:number|undefined,deviceId?:string|undefined,fps?:number|undefined,height?:number|undefined,message?:string|undefined,sessionId:string,status:literal(\"running\"),width?:number|undefined}|{audio?:undefined|{mode:literal(\"microphone\")|literal(\"none\")|literal(\"process\")|literal(\"system_exclude\")},bitrate?:number|undefined,deviceId?:string|undefined,fps?:number|undefined,height?:number|undefined,message?:string|undefined,sessionId?:string|undefined,status:literal(\"idle\"),width?:number|undefined}|{audio?:undefined|{mode:literal(\"microphone\")|literal(\"none\")|literal(\"process\")|literal(\"system_exclude\")},bitrate?:number|undefined,deviceId?:string|undefined,fps?:number|undefined,height?:number|undefined,message?:string|undefined,sessionId?:string|undefined,status:literal(\"starting\"),width?:number|undefined},type:literal(\"sessionLifecycle\")}") \
  X(EventSessionStarted, "{generation:number,requestId?:string|undefined,sequence:number,session:{audio:{channels:literal(1),echoCancellation:literal(\"disabled\")|literal(\"software\")|literal(\"unavailable\"),mode:literal(\"microphone\"),noiseSuppression:literal(\"disabled\")|literal(\"software\")|literal(\"unavailable\"),sampleRate:literal(48000)},kind:literal(\"microphone\"),nativeParticipantIdentity:string,sessionId:string}|{audio?:undefined|{loopbackMode?:literal(\"exclude_target_process_tree\")|literal(\"include_target_process_tree\")|undefined,mode:literal(\"none\")|literal(\"process\")|literal(\"system_exclude\"),targetProcessId?:number|undefined},bitrate?:number|undefined,encoder:literal(\"mf_h264_d3d11\"),fps?:number|undefined,height?:number|undefined,kind:literal(\"screen\"),nativeParticipantIdentity?:string|undefined,sessionId:string,width?:number|undefined},sessionId:string,type:literal(\"sessionStarted\")}") \
  X(EventSessionStopped, "{generation:number,reason?:string|undefined,requestId?:string|undefined,sequence:number,sessionId:string,type:literal(\"sessionStopped\")}") \
  X(EventVoiceConnectionState, "{generation:number,requestId?:string|undefined,sequence:number,sessionId:string,state:literal(\"connected\")|literal(\"reconnecting\"),type:literal(\"voiceConnectionState\")}") \
  X(EventVoiceTerminal, "{error:{code:string,generation?:number|undefined,hresult?:number|undefined,message:string,retryable:boolean,sessionId?:string|undefined,stage?:string|undefined},generation:number,requestId?:string|undefined,sequence:number,sessionId:string,type:literal(\"voiceTerminal\")}") \
  X(EventVoiceStats, "{generation:number,requestId?:string|undefined,sequence:number,sessionId:string,stats:{inbound:[...{audioLevel?:number|undefined,bytesReceived?:number|undefined,bytesSent?:number|undefined,codec?:string|undefined,concealedSamples?:number|undefined,concealmentEvents?:number|undefined,decoderImplementation?:string|undefined,encoderImplementation?:string|undefined,firCount?:number|undefined,frameHeight?:number|undefined,framesDecoded?:number|undefined,framesDropped?:number|undefined,framesEncoded?:number|undefined,framesPerSecond?:number|undefined,framesReceived?:number|undefined,framesRendered?:number|undefined,framesSent?:number|undefined,frameWidth?:number|undefined,freezeCount?:number|undefined,id:string,jitter?:number|undefined,jitterBufferDelay?:number|undefined,jitterBufferEmittedCount?:number|undefined,jitterBufferTargetDelay?:number|undefined,kind:literal(\"audio\")|literal(\"video\"),mid?:string|undefined,nackCount?:number|undefined,packetLossPercent?:number|undefined,packetsDiscarded?:number|undefined,packetsLost?:number|undefined,packetsReceived?:number|undefined,packetsSent?:number|undefined,pauseCount?:number|undefined,pcRole:literal(\"publisher\")|literal(\"subscriber\"),pliCount?:number|undefined,qualityLimitationReason?:string|undefined,retransmittedBytesReceived?:number|undefined,retransmittedBytesSent?:number|undefined,retransmittedPacketsReceived?:number|undefined,retransmittedPacketsSent?:number|undefined,roundTripTimeMs?:number|undefined,silentConcealedSamples?:number|undefined,ssrc?:number|undefined,targetBitrate?:number|undefined,totalAudioEnergy?:number|undefined,totalFreezesDuration?:number|undefined,totalPauseDuration?:number|undefined,totalSamplesDuration?:number|undefined,totalSamplesReceived?:number|undefined,trackIdentifier?:string|undefined}],outbound:[...{audioLevel?:number|undefined,bytesReceived?:number|undefined,bytesSent?:number|undefined,codec?:string|undefined,concealedSamples?:number|undefined,concealmentEvents?:number|undefined,decoderImplementation?:string|undefined,encoderImplementation?:string|undefined,firCount?:number|undefined,frameHeight?:number|undefined,framesDecoded?:number|undefined,framesDropped?:number|undefined,framesEncoded?:number|undefined,framesPerSecond?:number|undefined,framesReceived?:number|undefined,framesRendered?:number|undefined,framesSent?:number|undefined,frameWidth?:number|undefined,freezeCount?:number|undefined,id:string,jitter?:number|undefined,jitterBufferDelay?:number|undefined,jitterBufferEmittedCount?:number|undefined,jitterBufferTargetDelay?:number|undefined,kind:literal(\"audio\")|literal(\"video\"),mid?:string|undefined,nackCount?:number|undefined,packetLossPercent?:number|undefined,packetsDiscarded?:number|undefined,packetsLost?:number|undefined,packetsReceived?:number|undefined,packetsSent?:number|undefined,pauseCount?:number|undefined,pcRole:literal(\"publisher\")|literal(\"subscriber\"),pliCount?:number|undefined,qualityLimitationReason?:string|undefined,retransmittedBytesReceived?:number|undefined,retransmittedBytesSent?:number|undefined,retransmittedPacketsReceived?:number|undefined,retransmittedPacketsSent?:number|undefined,roundTripTimeMs?:number|undefined,silentConcealedSamples?:number|undefined,ssrc?:number|undefined,targetBitrate?:number|undefined,totalAudioEnergy?:number|undefined,totalFreezesDuration?:number|undefined,totalPauseDuration?:number|undefined,totalSamplesDuration?:number|undefined,totalSamplesReceived?:number|undefined,trackIdentifier?:string|undefined}],transport:{availableIncomingBitrate?:number|undefined,availableOutgoingBitrate?:number|undefined,bytesReceived?:number|undefined,bytesSent?:number|undefined,localAddress?:string|undefined,packetsReceived?:number|undefined,packetsSent?:number|undefined,pingMs?:number|undefined,remoteAddress?:string|undefined,selectedCandidatePairId?:string|undefined}},type:literal(\"voiceStats\")}") \
  X(EventActiveSpeakers, "{generation:number,participantIdentities:[...string],requestId?:string|undefined,sequence:number,sessionId:string,type:literal(\"activeSpeakers\")}") \
  X(EventLocalMicrophoneUnpublished, "{generation:number,requestId?:string|undefined,sequence:number,sessionId:string,trackId:string,type:literal(\"localMicrophoneUnpublished\")}") \
  X(EventMicrophoneMetrics, "{metrics:{inputDb:number,open:boolean,revision:number,thresholdDb:number},sequence:number,type:literal(\"microphoneMetrics\")}") \
  X(EventMicrophonePreviewStarted, "{generation:number,preview:{sessionId:string},requestId?:string|undefined,sequence:number,sessionId:string,type:literal(\"microphonePreviewStarted\")}") \
  X(EventDeviceList, "{devices:[...{deviceId:string,kind:literal(\"audioinput\")|literal(\"audiooutput\")|literal(\"videoinput\"),label:string}],sequence:number,type:literal(\"deviceList\")}") \
  X(EventDisplaySourceList, "{sequence:number,sources:[...{id:string,name:string,type:literal(\"game\")|literal(\"screen\")|literal(\"window\")}],type:literal(\"displaySourceList\")}") \
  X(EventScreenBackendRestart, "{backend:literal(\"dxgi_gpu\")|literal(\"wgc_gpu\"),count:number,errorCode?:string|undefined,generation:number,hresult?:number|undefined,reason:literal(\"probe_preferred_backend\")|literal(\"recreate_active_pipeline\")|literal(\"recreate_device\")|literal(\"reinitialize_active\")|literal(\"switch_backend\"),requestId?:string|undefined,sequence:number,sessionId:string,type:literal(\"screenBackendRestart\")}") \
  X(EventScreenCaptureEnded, "{generation:number,message?:string|undefined,reason:string,requestId?:string|undefined,sequence:number,sessionId:string,type:literal(\"screenCaptureEnded\")}") \
  X(EventStats, "{generation:number,requestId?:string|undefined,sequence:number,sessionId:string,stats:{activeMethod?:literal(\"dxgi_gpu\")|literal(\"wgc_gpu\")|undefined,audioBacklogPackets?:number|undefined,audioDiscontinuities?:number|undefined,audioFrames?:number|undefined,audioPackets?:number|undefined,audioPeakDb?:number|undefined,audioRmsDb?:number|undefined,captureThreadMmcss?:boolean|undefined,encoderImplementation?:string|undefined,methods:{dxgi_gpu:number,wgc_gpu:number},publishedAudio?:boolean|undefined,publishedVideo?:boolean|undefined,rtpBytesSent?:number|undefined,rtpFramesEncoded?:number|undefined,rtpFramesSent?:number|undefined,rtpPacketsSent?:number|undefined,rtpStatsAvailable?:boolean|undefined,sessionId:string,videoAvgCaptureUs?:number|undefined,videoAvgPublishUs?:number|undefined,videoAvgReadbackUs?:number|undefined,videoAvgScaleUs?:number|undefined,videoCoalescedSourceUpdates?:number|undefined,videoContentHeight?:number|undefined,videoContentWidth?:number|undefined,videoDxgiDuplicationHoldUsMax?:number|undefined,videoEncoderBackpressureTicks?:number|undefined,videoFrames?:number|undefined,videoGpuCompletionMaxUs?:number|undefined,videoGpuCompletionP50Us?:number|undefined,videoGpuCompletionP95Us?:number|undefined,videoGpuFramesDroppedStale?:number|undefined,videoGpuPoolRollovers?:number|undefined,videoGpuPoolSlotsAvailable?:number|undefined,videoGpuPoolSlotsTotal?:number|undefined,videoGpuRetiredGenerations?:number|undefined,videoGpuRolloversBlocked?:number|undefined,videoGpuSlotsQuarantined?:number|undefined,videoGpuSlotsRecovered?:number|undefined,videoGpuSlotTimeouts?:number|undefined,videoGpuSubmissions?:number|undefined,videoIdleRefreshes?:number|undefined,videoIntervalFrames?:number|undefined,videoLateFrames?:number|undefined,videoNoFrameCount?:number|undefined,videoPreviewBridgeAcquires?:number|undefined,videoPreviewBridgeSlotsRecovered?:number|undefined,videoPreviewBridgeSubmissions?:number|undefined,videoPreviewBridgeTimeouts?:number|undefined,videoPreviewDeviceResets?:number|undefined,videoPreviewFramesCompleted?:number|undefined,videoPreviewFramesDroppedStale?:number|undefined,videoPreviewGpuSubmissions?:number|undefined,videoPreviewSlotTimeouts?:number|undefined,videoRecoverableLostCount?:number|undefined,videoRepeatedFrameCount?:number|undefined,videoSourceHeight?:number|undefined,videoSourceUpdates?:number|undefined,videoSourceWidth?:number|undefined,videoSupersededReadyFrames?:number|undefined},type:literal(\"stats\")}") \
  X(EventRemoteVideoFrame, "{frameSequence:number,generation:number,height:number,ntHandle:declaration(anonymous),participantIdentity:string,requestId?:string|undefined,sequence:number,sessionId:string,source:literal(\"camera\")|literal(\"screen\"),timestampUs:number,trackId:string,type:literal(\"remoteVideoFrame\"),width:number}") \
  X(EventRemoteVideoFailed, "{generation:number,reason?:literal(\"local\")|literal(\"subscription\")|undefined,requestId?:string|undefined,sequence:number,sessionId:string,source?:literal(\"camera\")|literal(\"screen\")|undefined,trackId:string,type:literal(\"remoteVideoFailed\")}") \
  X(EventRemoteVideoTrackRemoved, "{generation:number,requestId?:string|undefined,sequence:number,sessionId:string,trackId:string,type:literal(\"remoteVideoTrackRemoved\")}") \
  X(EventRemoteVideoPublicationAvailable, "{generation:number,participantIdentity:string,requestId?:string|undefined,sequence:number,sessionId:string,source:literal(\"camera\")|literal(\"screen\"),trackId:string,type:literal(\"remoteVideoPublicationAvailable\")}") \
  X(EventRemoteVideoPublicationUnavailable, "{generation:number,participantIdentity:string,requestId?:string|undefined,sequence:number,sessionId:string,source:literal(\"camera\")|literal(\"screen\"),trackId:string,type:literal(\"remoteVideoPublicationUnavailable\")}") \
  X(EventLocalScreenPreviewFrame, "{frameSequence:number,generation:number,height:number,ntHandle:declaration(anonymous),participantIdentity:string,requestId?:string|undefined,sequence:number,sessionId:string,source:literal(\"screen\"),timestampUs:number,trackId:string,type:literal(\"localScreenPreviewFrame\"),width:number}") \
  X(EventLocalScreenPreviewFailed, "{error:{code:string,generation?:number|undefined,hresult?:number|undefined,message:string,retryable:boolean,sessionId?:string|undefined,stage?:string|undefined},generation:number,requestId?:string|undefined,sequence:number,sessionId:string,trackId:string,type:literal(\"localScreenPreviewFailed\")}") \
  X(EventLocalScreenPreviewTrackRemoved, "{generation:number,requestId?:string|undefined,sequence:number,sessionId:string,source:literal(\"screen\"),trackId:string,type:literal(\"localScreenPreviewTrackRemoved\")}") \
  X(EventLocalCameraPreviewFrame, "{frameSequence:number,generation:number,height:number,ntHandle:declaration(anonymous),participantIdentity:string,requestId?:string|undefined,sequence:number,sessionId:string,source:literal(\"camera\"),timestampUs:number,trackId:string,type:literal(\"localCameraPreviewFrame\"),width:number}") \
  X(EventLocalCameraPreviewFailed, "{error:{code:string,generation?:number|undefined,hresult?:number|undefined,message:string,retryable:boolean,sessionId?:string|undefined,stage?:string|undefined},generation:number,requestId?:string|undefined,sequence:number,sessionId:string,trackId:string,type:literal(\"localCameraPreviewFailed\")}") \
  X(EventLocalCameraPreviewTrackRemoved, "{generation:number,requestId?:string|undefined,sequence:number,sessionId:string,source:literal(\"camera\"),trackId:string,type:literal(\"localCameraPreviewTrackRemoved\")}") \
  X(EventCameraTerminal, "{error:{code:string,generation?:number|undefined,hresult?:number|undefined,message:string,retryable:boolean,sessionId?:string|undefined,stage?:string|undefined},generation:number,requestId?:string|undefined,sequence:number,sessionId:string,type:literal(\"cameraTerminal\")}") \
  X(EventInput, "{input:{code:string,label:string,pressedCodes:[...string],source:literal(\"keyboard\")|literal(\"mouse\"),type:literal(\"inputDown\")|literal(\"inputUp\")},sequence:number,type:literal(\"input\")}") \
  X(EventForegroundWindow, "{sequence:number,type:literal(\"foregroundWindow\"),window:{bounds:{height:number,width:number,x:number,y:number},className:string,fullscreenLike:boolean,pid:number,processName:string,processPath:null|string,title:string,visible:boolean}}")
// END GENERATED EXTERNAL MESSAGE FIELD SHAPES

#define SYRNIKE_NATIVE_COMMAND_DISPATCH_BINDINGS(X)                            \
  X(Shutdown, Runtime, CommandShutdown, HandleShutdown)                        \
  X(ListDevices, Query, CommandListDevices, HandleListDevices)                 \
  X(ListDisplaySources, Query, CommandListDisplaySources,                      \
    HandleListDisplaySources)                                                  \
  X(ProbeQueryWorker, Query, CommandProbeQueryWorker, HandleProbeQueryWorker)  \
  X(WarmMicrophone, Microphone, CommandWarmMicrophone, HandleWarmMicrophone)   \
  X(ConfigureMicrophone, Microphone, CommandConfigureMicrophone,               \
    HandleConfigureMicrophone)                                                 \
  X(ConnectMicrophone, Microphone, CommandConnectMicrophone,                   \
    HandleConnectMicrophone)                                                   \
  X(SetMicrophoneMuted, Microphone, CommandSetMicrophoneMuted,                 \
    HandleSetMicrophoneMuted)                                                  \
  X(DisconnectMicrophone, Microphone, CommandDisconnectMicrophone,             \
    HandleDisconnectMicrophone)                                                \
  X(InvalidateMicrophone, Microphone, CommandInvalidateMicrophone,             \
    HandleInvalidateMicrophone)                                                \
  X(StartPreview, Microphone, CommandStartPreview, HandleStartPreview)         \
  X(StopPreview, Microphone, CommandStopPreview, HandleStopPreview)            \
  X(StartMicrophonePreview, Microphone, CommandStartMicrophonePreview,         \
    HandleStartMicrophonePreview)                                              \
  X(ProbeMicrophoneActor, Microphone, CommandProbeMicrophoneActor,             \
    HandleProbeMicrophoneActor)                                                \
  X(ConnectVoice, Voice, CommandConnectVoice, HandleConnectVoice)              \
  X(DisconnectVoice, Voice, CommandDisconnectVoice, HandleDisconnectVoice)    \
  X(ConfigureVoiceOutput, Voice, CommandConfigureVoiceOutput,                  \
    HandleConfigureVoiceOutput)                                                \
  X(ConfigureRemoteAudio, Voice, CommandConfigureRemoteAudio,                  \
    HandleConfigureRemoteAudio)                                                \
  X(ReleaseRemoteVideoFrame, Voice, CommandReleaseRemoteVideoFrame,            \
    HandleReleaseRemoteVideoFrame)                                             \
  X(SetRemoteVideoDemand, Voice, CommandSetRemoteVideoDemand,                  \
    HandleSetRemoteVideoDemand)                                                \
  X(RetryRemoteVideo, Voice, CommandRetryRemoteVideo, HandleRetryRemoteVideo)  \
  X(ProbeVoiceControl, Voice, CommandProbeVoiceControl, HandleProbeVoiceControl) \
  X(ConnectScreen, Screen, CommandConnectScreen, HandleConnectScreen)          \
  X(StartScreenCapture, Screen, CommandStartScreenCapture,                     \
    HandleStartScreenCapture)                                                  \
  X(StopScreenCapture, Screen, CommandStopScreenCapture,                       \
    HandleStopScreenCapture)                                                   \
  X(DisconnectScreen, Screen, CommandDisconnectScreen, HandleDisconnectScreen) \
  X(ProbeScreenActor, Screen, CommandProbeScreenActor, HandleProbeScreenActor) \
  X(SetLocalScreenPreviewDemand, Screen, CommandSetLocalScreenPreviewDemand,   \
    HandleSetLocalScreenPreviewDemand)                                         \
  X(ReleaseLocalScreenPreviewFrame, Screen,                                    \
    CommandReleaseLocalScreenPreviewFrame, HandleReleaseLocalScreenPreviewFrame) \
  X(ConnectCamera, Camera, CommandConnectCamera, HandleConnectCamera)          \
  X(DisconnectCamera, Camera, CommandDisconnectCamera, HandleDisconnectCamera) \
  X(ProbeCameraActor, Camera, CommandProbeCameraActor, HandleProbeCameraActor) \
  X(ReleaseLocalCameraPreviewFrame, Camera,                                    \
    CommandReleaseLocalCameraPreviewFrame, HandleReleaseLocalCameraPreviewFrame) \
  X(SetLocalCameraPreviewDemand, Camera,                                       \
    CommandSetLocalCameraPreviewDemand, HandleSetLocalCameraPreviewDemand)     \
  X(RetryLocalCameraPreview, Camera, CommandRetryLocalCameraPreview,           \
    HandleRetryLocalCameraPreview)                                             \
  X(StartHotkeys, Hooks, CommandStartHotkeys, HandleStartHotkeys)              \
  X(StopHotkeys, Hooks, CommandStopHotkeys, HandleStopHotkeys)                 \
  X(StartOverlay, Hooks, CommandStartOverlay, HandleStartOverlay)              \
  X(StopOverlay, Hooks, CommandStopOverlay, HandleStopOverlay)                 \
  X(ProbeHooksRuntime, Hooks, CommandProbeHooksRuntime, HandleProbeHooksRuntime) \
  X(VoiceTerminal, Voice, CommandVoiceTerminal, HandleVoiceTerminal)           \
  X(VoiceConnectCompleted, Voice, CommandVoiceConnectCompleted,                \
    HandleVoiceConnectCompleted)                                               \
  X(VoiceConnectionStateChanged, Voice, CommandVoiceConnectionStateChanged,   \
    HandleVoiceConnectionStateChanged)                                         \
  X(VoiceOutputStateChanged, Voice, CommandVoiceOutputStateChanged,            \
    HandleVoiceOutputStateChanged)                                             \
  X(VoiceRemoteAudioTrackFailed, Voice, CommandVoiceRemoteAudioTrackFailed,    \
    HandleVoiceRemoteAudioTrackFailed)                                         \
  X(ReconcileRemotePublication, Voice, CommandReconcileRemotePublication,     \
    HandleReconcileRemotePublication)                                          \
  X(VoiceStats, Voice, CommandVoiceStats, HandleVoiceStats)                    \
  X(VoiceActiveSpeakers, Voice, CommandVoiceActiveSpeakers,                    \
    HandleVoiceActiveSpeakers)                                                 \
  X(LocalMicrophoneUnpublished, Voice, CommandLocalMicrophoneUnpublished,      \
    HandleLocalMicrophoneUnpublished)                                          \
  X(MicrophonePublicationUnpublished, Microphone,                              \
    CommandMicrophonePublicationUnpublished, HandleMicrophonePublicationUnpublished) \
  X(MicrophoneAttemptReady, Microphone, CommandMicrophoneAttemptReady,         \
    HandleMicrophoneAttemptReady)                                              \
  X(MicrophoneAttemptFailed, Microphone, CommandMicrophoneAttemptFailed,       \
    HandleMicrophoneAttemptFailed)                                             \
  X(MicrophoneRetireDone, Microphone, CommandMicrophoneRetireDone,             \
    HandleMicrophoneRetireDone)                                                \
  X(MicrophoneEndpointChanged, Microphone, CommandMicrophoneEndpointChanged,   \
    HandleMicrophoneEndpointChanged)                                           \
  X(MicrophoneProcessingStatus, Microphone, CommandMicrophoneProcessingStatus, \
    HandleMicrophoneProcessingStatus)                                          \
  X(MicrophoneIdleExpired, Microphone, CommandMicrophoneIdleExpired,           \
    HandleMicrophoneIdleExpired)                                               \
  X(MicrophoneTerminal, Microphone, CommandMicrophoneTerminal,                 \
    HandleMicrophoneTerminal)                                                  \
  X(ScreenAttemptReady, Screen, CommandScreenAttemptReady, HandleScreenAttemptReady) \
  X(ScreenAttemptFailed, Screen, CommandScreenAttemptFailed, HandleScreenAttemptFailed) \
  X(ScreenRetireDone, Screen, CommandScreenRetireDone, HandleScreenRetireDone) \
  X(ScreenTerminal, Screen, CommandScreenTerminal, HandleScreenTerminal)       \
  X(ScreenAudioAttemptReady, Screen, CommandScreenAudioAttemptReady,           \
    HandleScreenAudioAttemptReady)                                             \
  X(ScreenAudioAttemptFailed, Screen, CommandScreenAudioAttemptFailed,         \
    HandleScreenAudioAttemptFailed)                                            \
  X(ScreenAudioTerminal, Screen, CommandScreenAudioTerminal,                   \
    HandleScreenAudioTerminal)                                                 \
  X(LocalScreenPreviewFrame, Screen, CommandLocalScreenPreviewFrame,           \
    HandleLocalScreenPreviewFrame)                                             \
  X(LocalScreenPreviewFailed, Screen, CommandLocalScreenPreviewFailed,         \
    HandleLocalScreenPreviewFailed)                                            \
  X(LocalScreenPreviewTrackRemoved, Screen,                                    \
    CommandLocalScreenPreviewTrackRemoved, HandleLocalScreenPreviewTrackRemoved) \
  X(CameraTerminal, Camera, CommandCameraTerminal, HandleCameraTerminal)       \
  X(LocalCameraPreviewFrame, Camera, CommandLocalCameraPreviewFrame,           \
    HandleLocalCameraPreviewFrame)                                             \
  X(LocalCameraPreviewFailed, Camera, CommandLocalCameraPreviewFailed,         \
    HandleLocalCameraPreviewFailed)                                            \
  X(LocalCameraPreviewTrackRemoved, Camera,                                    \
    CommandLocalCameraPreviewTrackRemoved, HandleLocalCameraPreviewTrackRemoved) \
  X(RemoteVideoFrame, Voice, CommandRemoteVideoFrame, HandleRemoteVideoFrame)  \
  X(RemoteVideoFailed, Voice, CommandRemoteVideoFailed, HandleRemoteVideoFailed) \
  X(RemoteVideoTrackRemoved, Voice, CommandRemoteVideoTrackRemoved,            \
    HandleRemoteVideoTrackRemoved)                                             \
  X(RemoteVideoPublicationAvailable, Voice,                                    \
    CommandRemoteVideoPublicationAvailable, HandleRemoteVideoPublicationAvailable) \
  X(RemoteVideoPublicationUnavailable, Voice,                                  \
    CommandRemoteVideoPublicationUnavailable, HandleRemoteVideoPublicationUnavailable)

#define SYRNIKE_NATIVE_EVENT_CODEC_BINDINGS(X)                                 \
  X(Reply, Reply, EventReply, SerializeReply)                                  \
  X(RuntimeError, Lifecycle, EventRuntimeError, SerializeRuntimeError)         \
  X(SessionLifecycle, SessionLifecycle, EventSessionLifecycle,                 \
    SerializeSessionLifecycle)                                                 \
  X(SessionStarted, SessionStarted, EventSessionStarted, SerializeSessionStarted) \
  X(SessionStopped, SessionStopped, EventSessionStopped, SerializeSessionStopped) \
  X(VoiceConnectionState, VoiceConnectionState, EventVoiceConnectionState,    \
    SerializeVoiceConnectionState)                                             \
  X(VoiceTerminal, Lifecycle, EventVoiceTerminal, SerializeVoiceTerminal)      \
  X(VoiceStats, VoiceStatistics, EventVoiceStats, SerializeVoiceStats)         \
  X(ActiveSpeakers, ActiveSpeakers, EventActiveSpeakers, SerializeActiveSpeakers) \
  X(LocalMicrophoneUnpublished, VideoPublication, EventLocalMicrophoneUnpublished, \
    SerializeLocalMicrophoneUnpublished)                                       \
  X(MicrophoneMetrics, MicrophoneMetrics, EventMicrophoneMetrics,              \
    SerializeMicrophoneMetrics)                                                \
  X(MicrophonePreviewStarted, MicrophonePreviewStarted,                        \
    EventMicrophonePreviewStarted, SerializeMicrophonePreviewStarted)          \
  X(DeviceList, Devices, EventDeviceList, SerializeDeviceList)                 \
  X(DisplaySourceList, DisplaySources, EventDisplaySourceList,                 \
    SerializeDisplaySourceList)                                                \
  X(ScreenBackendRestart, ScreenBackendRestart, EventScreenBackendRestart,    \
    SerializeScreenBackendRestart)                                             \
  X(ScreenCaptureEnded, ScreenCaptureEnded, EventScreenCaptureEnded,           \
    SerializeScreenCaptureEnded)                                               \
  X(Stats, ScreenStatistics, EventStats, SerializeStats)                       \
  X(RemoteVideoFrame, VideoFrame, EventRemoteVideoFrame, SerializeRemoteVideoFrame) \
  X(RemoteVideoFailed, RemoteVideoFailed, EventRemoteVideoFailed,              \
    SerializeRemoteVideoFailed)                                                \
  X(RemoteVideoTrackRemoved, RemoteVideoTrackRemoved, EventRemoteVideoTrackRemoved, \
    SerializeRemoteVideoTrackRemoved)                                          \
  X(RemoteVideoPublicationAvailable, RemoteVideoPublication,                   \
    EventRemoteVideoPublicationAvailable, SerializeRemoteVideoPublicationAvailable) \
  X(RemoteVideoPublicationUnavailable, RemoteVideoPublication,                 \
    EventRemoteVideoPublicationUnavailable, SerializeRemoteVideoPublicationUnavailable) \
  X(LocalScreenPreviewFrame, VideoFrame, EventLocalScreenPreviewFrame,         \
    SerializeLocalScreenPreviewFrame)                                          \
  X(LocalScreenPreviewFailed, Lifecycle, EventLocalScreenPreviewFailed,        \
    SerializeLocalScreenPreviewFailed)                                         \
  X(LocalScreenPreviewTrackRemoved, LocalVideoTrackRemoved,                    \
    EventLocalScreenPreviewTrackRemoved, SerializeLocalScreenPreviewTrackRemoved) \
  X(LocalCameraPreviewFrame, VideoFrame, EventLocalCameraPreviewFrame,         \
    SerializeLocalCameraPreviewFrame)                                          \
  X(LocalCameraPreviewFailed, Lifecycle, EventLocalCameraPreviewFailed,        \
    SerializeLocalCameraPreviewFailed)                                         \
  X(LocalCameraPreviewTrackRemoved, LocalVideoTrackRemoved,                    \
    EventLocalCameraPreviewTrackRemoved, SerializeLocalCameraPreviewTrackRemoved) \
  X(CameraTerminal, Lifecycle, EventCameraTerminal, SerializeCameraTerminal)   \
  X(Input, Input, EventInput, SerializeInput)                                  \
  X(ForegroundWindow, ForegroundWindow, EventForegroundWindow, SerializeForegroundWindow) \
  X(NativeSmokeQuarantineBlockEntered, Generic,                                \
    EventNativeSmokeQuarantineBlockEntered, SerializeNativeSmokeQuarantineBlockEntered) \
  X(Test, Generic, EventTest, SerializeTest)

struct NativeCommandDispatchBinding {
  NativeCommandType type;
  NativeMessageDestination destination;
  NativeMessageSchema schema;
  NativeMessageAction action;
};

struct NativeEventCodecBinding {
  NativeEventType type;
  NativePayloadProfile payload;
  NativeMessageSchema schema;
  NativeMessageAction action;
};

struct NativeExternalFieldShape {
  NativeMessageSchema schema;
  std::string_view shape;
};

enum class NativeExternalTopLevelField : std::uint16_t {
  Sequence = 1u << 0,
  RequestId = 1u << 1,
  Kind = 1u << 2,
  TrackId = 1u << 3,
  SessionId = 1u << 4,
  Generation = 1u << 5,
  Error = 1u << 6,
};

constexpr std::uint16_t nativeExternalTopLevelMask(std::string_view shape) {
  std::uint16_t mask = 0;
  int braces = 0;
  int brackets = 0;
  int parentheses = 0;
  bool quoted = false;
  bool escaped = false;
  for (std::size_t index = 0; index < shape.size(); ++index) {
    const char current = shape[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (current == '\\') escaped = true;
      else if (current == '"') quoted = false;
      continue;
    }
    if (current == '"') {
      quoted = true;
      continue;
    }
    if (current == '{') {
      ++braces;
      continue;
    }
    if (current == '}') {
      --braces;
      continue;
    }
    if (current == '[') ++brackets;
    else if (current == ']') --brackets;
    else if (current == '(') ++parentheses;
    else if (current == ')') --parentheses;
    if (braces != 1 || brackets != 0 || parentheses != 0) continue;
    if (index != 0 && shape[index - 1] != '{' && shape[index - 1] != ',') {
      continue;
    }
    const auto token = shape.substr(index);
    const auto add = [&](std::string_view name, NativeExternalTopLevelField field) {
      if (!token.starts_with(name)) return;
      const auto suffix = name.size();
      if (suffix < token.size() &&
          (token[suffix] == ':' || token[suffix] == '?')) {
        mask |= static_cast<std::uint16_t>(field);
      }
    };
    add("sequence", NativeExternalTopLevelField::Sequence);
    add("requestId", NativeExternalTopLevelField::RequestId);
    add("kind", NativeExternalTopLevelField::Kind);
    add("trackId", NativeExternalTopLevelField::TrackId);
    add("sessionId", NativeExternalTopLevelField::SessionId);
    add("generation", NativeExternalTopLevelField::Generation);
    add("error", NativeExternalTopLevelField::Error);
  }
  return mask;
}

inline constexpr auto kNativeCommandDispatchBindings = std::array{
#define SYRNIKE_COMMAND_DISPATCH_ROW(type, destination, schema, action)         \
  NativeCommandDispatchBinding{NativeCommandType::type,                        \
                               NativeMessageDestination::destination,          \
                               NativeMessageSchema::schema,                    \
                               NativeMessageAction::action},
    SYRNIKE_NATIVE_COMMAND_DISPATCH_BINDINGS(SYRNIKE_COMMAND_DISPATCH_ROW)
#undef SYRNIKE_COMMAND_DISPATCH_ROW
};

inline constexpr auto kNativeEventCodecBindings = std::array{
#define SYRNIKE_EVENT_CODEC_ROW(type, payload, schema, action)                  \
  NativeEventCodecBinding{NativeEventType::type, NativePayloadProfile::payload, \
                          NativeMessageSchema::schema,                         \
                          NativeMessageAction::action},
    SYRNIKE_NATIVE_EVENT_CODEC_BINDINGS(SYRNIKE_EVENT_CODEC_ROW)
#undef SYRNIKE_EVENT_CODEC_ROW
};

inline constexpr auto kNativeExternalFieldShapes = std::array{
#define SYRNIKE_EXTERNAL_FIELD_SHAPE_ROW(schema, shape)                        \
  NativeExternalFieldShape{NativeMessageSchema::schema, shape},
    SYRNIKE_NATIVE_EXTERNAL_FIELD_SHAPES(SYRNIKE_EXTERNAL_FIELD_SHAPE_ROW)
#undef SYRNIKE_EXTERNAL_FIELD_SHAPE_ROW
};

constexpr auto makeNativeExternalTopLevelMasks() {
  std::array<
    std::uint16_t,
    static_cast<std::size_t>(NativeMessageSchema::Count)> masks{};
  for (const auto& field_shape : kNativeExternalFieldShapes) {
    masks[static_cast<std::size_t>(field_shape.schema)] =
      nativeExternalTopLevelMask(field_shape.shape);
  }
  return masks;
}

inline constexpr auto kNativeExternalTopLevelMasks =
  makeNativeExternalTopLevelMasks();

constexpr bool nativeExternalHasTopLevelField(
  NativeMessageSchema schema,
  NativeExternalTopLevelField field
) noexcept {
  const auto index = static_cast<std::size_t>(schema);
  if (index >= kNativeExternalTopLevelMasks.size()) return false;
  return (kNativeExternalTopLevelMasks[index] &
          static_cast<std::uint16_t>(field)) != 0;
}

constexpr const NativeCommandDispatchBinding *
nativeCommandDispatchBinding(NativeCommandType type) noexcept {
  for (const auto &binding : kNativeCommandDispatchBindings) {
    if (binding.type == type)
      return &binding;
  }
  return nullptr;
}

constexpr const NativeEventCodecBinding *
nativeEventCodecBinding(NativeEventType type) noexcept {
  for (const auto &binding : kNativeEventCodecBindings) {
    if (binding.type == type)
      return &binding;
  }
  return nullptr;
}

constexpr const NativeExternalFieldShape *
nativeExternalFieldShape(NativeMessageSchema schema) noexcept {
  for (const auto &field_shape : kNativeExternalFieldShapes) {
    if (field_shape.schema == schema)
      return &field_shape;
  }
  return nullptr;
}

constexpr std::optional<NativeCommandType>
nativeCommandTypeForSchema(NativeMessageSchema schema) noexcept {
  for (const auto &binding : kNativeCommandDispatchBindings) {
    if (binding.schema == schema)
      return binding.type;
  }
  return std::nullopt;
}

constexpr std::optional<NativeEventType>
nativeEventTypeForSchema(NativeMessageSchema schema) noexcept {
  for (const auto &binding : kNativeEventCodecBindings) {
    if (binding.schema == schema)
      return binding.type;
  }
  return std::nullopt;
}

constexpr std::optional<NativeCommandType>
nativeCommandTypeForAction(NativeMessageAction action) noexcept {
  for (const auto &binding : kNativeCommandDispatchBindings) {
    if (binding.action == action)
      return binding.type;
  }
  return std::nullopt;
}

constexpr std::optional<NativeEventType>
nativeEventTypeForAction(NativeMessageAction action) noexcept {
  for (const auto &binding : kNativeEventCodecBindings) {
    if (binding.action == action)
      return binding.type;
  }
  return std::nullopt;
}

constexpr NativePayloadProfile
nativeEventSerializationProfile(NativeMessageAction action) noexcept {
  for (const auto &binding : kNativeEventCodecBindings) {
    if (binding.action == action)
      return binding.payload;
  }
  return NativePayloadProfile::Generic;
}

template <std::size_t CommandCount, std::size_t EventCount>
constexpr bool nativeExternalFieldShapesAreExhaustive(
    const std::array<NativeMessagePolicy<NativeCommandType>, CommandCount>
        &command_policies,
    const std::array<NativeMessagePolicy<NativeEventType>, EventCount>
        &event_policies) noexcept {
  std::size_t external_count = 0;
  for (const auto &policy : command_policies) {
    if (policy.visibility != NativeMessageVisibility::External)
      continue;
    ++external_count;
    const auto *shape = nativeExternalFieldShape(policy.schema);
    const auto *binding = nativeCommandDispatchBinding(policy.type);
    if (!shape || shape->shape.empty() || !binding ||
        binding->schema != shape->schema) {
      return false;
    }
  }
  for (const auto &policy : event_policies) {
    if (policy.visibility != NativeMessageVisibility::External)
      continue;
    ++external_count;
    const auto *shape = nativeExternalFieldShape(policy.schema);
    const auto *binding = nativeEventCodecBinding(policy.type);
    if (!shape || shape->shape.empty() || !binding ||
        binding->schema != shape->schema) {
      return false;
    }
  }
  if (external_count != kNativeExternalFieldShapes.size())
    return false;
  for (std::size_t left = 0; left < kNativeExternalFieldShapes.size(); ++left) {
    for (std::size_t right = left + 1;
         right < kNativeExternalFieldShapes.size(); ++right) {
      if (kNativeExternalFieldShapes[left].schema ==
          kNativeExternalFieldShapes[right].schema) {
        return false;
      }
    }
  }
  return true;
}

template <std::size_t CommandCount, std::size_t EventCount>
constexpr bool nativeImplementationBindingsAreExhaustive(
    const std::array<NativeMessagePolicy<NativeCommandType>, CommandCount>
        &command_policies,
    const std::array<NativeMessagePolicy<NativeEventType>, EventCount>
        &event_policies) noexcept {
  if (kNativeCommandDispatchBindings.size() != command_policies.size() ||
      kNativeEventCodecBindings.size() != event_policies.size()) {
    return false;
  }
  for (const auto &policy : command_policies) {
    const auto *binding = nativeCommandDispatchBinding(policy.type);
    if (!binding || binding->destination != policy.destination ||
        binding->schema != policy.schema || binding->action != policy.action) {
      return false;
    }
  }
  for (const auto &policy : event_policies) {
    const auto *binding = nativeEventCodecBinding(policy.type);
    if (!binding || binding->payload != policy.payload ||
        binding->schema != policy.schema || binding->action != policy.action) {
      return false;
    }
  }
  return true;
}

static_assert(nativeImplementationBindingsAreExhaustive(
                  kNativeCommandPolicies, kNativeEventPolicies),
              "every catalog row requires a concrete dispatch or codec binding");
static_assert(nativeExternalFieldShapesAreExhaustive(
                  kNativeCommandPolicies, kNativeEventPolicies),
              "every external parser/serializer binding requires its generated "
              "Effect Schema field shape");

#undef SYRNIKE_NATIVE_EXTERNAL_FIELD_SHAPES
#undef SYRNIKE_NATIVE_COMMAND_DISPATCH_BINDINGS
#undef SYRNIKE_NATIVE_EVENT_CODEC_BINDINGS

} // namespace syrnike::desktop_native
