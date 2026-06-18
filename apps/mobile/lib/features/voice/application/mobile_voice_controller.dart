import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart' as livekit;

import '../../../core/audio/mobile_sound_service.dart';
import '../../sync/application/sync_controller.dart';
import '../../settings/application/mobile_behavior_controller.dart';
import '../data/livekit_voice_service.dart';
import '../data/voice_api.dart';
import 'native_permissions.dart';

const _unset = Object();

final mobileVoiceControllerProvider =
    NotifierProvider<MobileVoiceController, MobileVoiceState>(
      MobileVoiceController.new,
    );

class MobileVoiceState {
  const MobileVoiceState({
    this.channelId,
    this.stageOpen = false,
    this.joining = false,
    this.muted = false,
    this.deafened = false,
    this.cameraEnabled = false,
    this.speakingUserIds = const {},
    this.microphonePublished = false,
    this.microphoneLevel = 0,
    this.microphoneBytesSent = 0,
    this.microphoneIssue,
    this.errorMessage,
  });

  final String? channelId;
  final bool stageOpen;
  final bool joining;
  final bool muted;
  final bool deafened;
  final bool cameraEnabled;
  final Set<String> speakingUserIds;
  final bool microphonePublished;
  final double microphoneLevel;
  final int microphoneBytesSent;
  final String? microphoneIssue;
  final String? errorMessage;

  bool get connected => channelId != null;

  MobileVoiceState copyWith({
    Object? channelId = _unset,
    bool? stageOpen,
    bool? joining,
    bool? muted,
    bool? deafened,
    bool? cameraEnabled,
    Set<String>? speakingUserIds,
    bool? microphonePublished,
    double? microphoneLevel,
    int? microphoneBytesSent,
    String? microphoneIssue,
    bool clearMicrophoneIssue = false,
    String? errorMessage,
    bool clearError = false,
  }) {
    return MobileVoiceState(
      channelId: identical(channelId, _unset)
          ? this.channelId
          : channelId as String?,
      stageOpen: stageOpen ?? this.stageOpen,
      joining: joining ?? this.joining,
      muted: muted ?? this.muted,
      deafened: deafened ?? this.deafened,
      cameraEnabled: cameraEnabled ?? this.cameraEnabled,
      speakingUserIds: speakingUserIds ?? this.speakingUserIds,
      microphonePublished: microphonePublished ?? this.microphonePublished,
      microphoneLevel: microphoneLevel ?? this.microphoneLevel,
      microphoneBytesSent: microphoneBytesSent ?? this.microphoneBytesSent,
      microphoneIssue: clearMicrophoneIssue
          ? null
          : microphoneIssue ?? this.microphoneIssue,
      errorMessage: clearError ? null : errorMessage ?? this.errorMessage,
    );
  }
}

class MobileVoiceController extends Notifier<MobileVoiceState> {
  livekit.Room? _room;
  livekit.EventsListener<livekit.RoomEvent>? _roomListener;
  Timer? _microphoneStatsTimer;
  bool _readingMicrophoneStats = false;
  final Set<String> _remoteVoiceUserIds = {};

  @override
  MobileVoiceState build() {
    ref.onDispose(() {
      unawaited(_disconnectRoom());
    });
    return const MobileVoiceState();
  }

  Future<bool> join(String channelId) async {
    if (state.channelId == channelId && !state.joining) {
      state = state.copyWith(stageOpen: true, clearError: true);
      return true;
    }

    final behavior =
        ref.read(mobileBehaviorControllerProvider).value ??
        const MobileBehaviorSettings();
    final mutedOnJoin = behavior.joinVoiceMuted || state.muted;
    state = state.copyWith(
      joining: true,
      stageOpen: true,
      muted: mutedOnJoin,
      clearError: true,
    );
    final allowed = await ensureMicrophonePermission();
    if (!allowed) {
      state = state.copyWith(
        joining: false,
        errorMessage: 'Нужен доступ к микрофону и камере.',
      );
      return false;
    }

    try {
      await _disconnectRoom();
      final node = await ref.read(voiceApiProvider).resolveVoiceNodeName();
      final credentials = await ref
          .read(syncControllerProvider.notifier)
          .requestVoiceJoin(
            channelId: channelId,
            node: node,
            selfMute: mutedOnJoin,
            selfDeaf: state.deafened,
          );
      final room = await ref
          .read(liveKitVoiceServiceProvider)
          .connect(url: credentials.url, token: credentials.token);
      _room = room;
      _listenToRoom(room);
      await _setRemoteAudioEnabled(!state.deafened);
      final microphonePublication = await room.localParticipant
          ?.setMicrophoneEnabled(!mutedOnJoin);
      if (!mutedOnJoin &&
          microphonePublication?.track is! livekit.LocalAudioTrack) {
        throw StateError(
          'Микрофон разрешён, но голосовой сервер не принял аудиотрек.',
        );
      }
      if (state.cameraEnabled) {
        await room.localParticipant?.setCameraEnabled(true);
      }
      state = state.copyWith(
        channelId: channelId,
        joining: false,
        stageOpen: true,
        speakingUserIds: _speakingIds(room.activeSpeakers),
        microphonePublished:
            microphonePublication?.track is livekit.LocalAudioTrack,
        microphoneLevel: 0,
        microphoneBytesSent: 0,
        clearMicrophoneIssue: true,
        clearError: true,
      );
      _startMicrophoneStatsMonitor();
      _playSound(MobileSoundEffect.userJoin);
      return true;
    } catch (error) {
      debugPrint('[mobile-voice] join failed: ${error.runtimeType}: $error');
      await _disconnectRoom();
      ref
          .read(syncControllerProvider.notifier)
          .sendVoiceStateUpdate(
            channelId: null,
            selfMute: false,
            selfDeaf: false,
          );
      state = state.copyWith(
        channelId: null,
        joining: false,
        errorMessage: _voiceErrorMessage(error),
      );
      return false;
    }
  }

  void openStage() {
    if (state.channelId == null) return;
    state = state.copyWith(stageOpen: true, clearError: true);
  }

  void closeStage() {
    state = state.copyWith(stageOpen: false);
  }

  void leave() {
    final wasConnected = state.connected;
    ref
        .read(syncControllerProvider.notifier)
        .sendVoiceStateUpdate(
          channelId: null,
          selfMute: false,
          selfDeaf: false,
        );
    unawaited(_disconnectRoom());
    state = const MobileVoiceState();
    if (wasConnected) _playSound(MobileSoundEffect.userLeave);
  }

  Future<void> toggleMute() async {
    final muted = !state.muted;
    final localId = _room?.localParticipant?.identity;
    final speaking = {...state.speakingUserIds};
    if (muted && localId != null) {
      speaking.remove(_baseVoiceIdentity(localId));
    }
    state = state.copyWith(
      muted: muted,
      speakingUserIds: speaking,
      microphoneLevel: muted ? 0 : state.microphoneLevel,
      clearMicrophoneIssue: true,
    );
    try {
      final publication = await _room?.localParticipant?.setMicrophoneEnabled(
        !muted,
      );
      if (!muted && publication?.track is! livekit.LocalAudioTrack) {
        throw StateError('Аудиотрек микрофона не был опубликован.');
      }
      state = state.copyWith(
        microphonePublished:
            !muted && publication?.track is livekit.LocalAudioTrack,
        microphoneLevel: muted ? 0 : state.microphoneLevel,
        clearMicrophoneIssue: true,
      );
      if (!muted) _startMicrophoneStatsMonitor();
      _sendFlags();
      _playSound(muted ? MobileSoundEffect.mute : MobileSoundEffect.unmute);
    } catch (error) {
      state = state.copyWith(
        muted: true,
        microphonePublished: false,
        microphoneLevel: 0,
        microphoneIssue: _microphoneErrorMessage(error),
      );
      _sendFlags();
    }
  }

  void toggleDeafen() {
    final deafened = !state.deafened;
    state = state.copyWith(
      deafened: deafened,
      speakingUserIds: deafened ? const <String>{} : state.speakingUserIds,
    );
    unawaited(_setRemoteAudioEnabled(!deafened));
    _sendFlags();
    _playSound(
      deafened ? MobileSoundEffect.deafen : MobileSoundEffect.undeafen,
    );
  }

  Future<void> toggleCamera() async {
    final cameraEnabled = !state.cameraEnabled;
    if (cameraEnabled && !await ensureCameraPermission()) {
      state = state.copyWith(errorMessage: 'Нужен доступ к камере.');
      return;
    }
    state = state.copyWith(cameraEnabled: cameraEnabled);
    await _room?.localParticipant?.setCameraEnabled(cameraEnabled);
  }

  void _sendFlags() {
    final channelId = state.channelId;
    if (channelId == null) return;
    ref
        .read(syncControllerProvider.notifier)
        .sendVoiceStateUpdate(
          channelId: channelId,
          selfMute: state.muted,
          selfDeaf: state.deafened,
          suppressCallNotifications: true,
        );
  }

  Future<void> _disconnectRoom() async {
    _microphoneStatsTimer?.cancel();
    _microphoneStatsTimer = null;
    _readingMicrophoneStats = false;
    _remoteVoiceUserIds.clear();
    final listener = _roomListener;
    _roomListener = null;
    await listener?.dispose();
    final room = _room;
    _room = null;
    await room?.disconnect();
  }

  void _listenToRoom(livekit.Room room) {
    _remoteVoiceUserIds
      ..clear()
      ..addAll(
        room.remoteParticipants.values.map(
          (participant) => _baseVoiceIdentity(participant.identity),
        ),
      );
    final listener = room.createListener();
    _roomListener = listener
      ..on<livekit.ActiveSpeakersChangedEvent>((event) {
        if (!identical(_room, room)) return;
        state = state.copyWith(
          speakingUserIds: state.deafened
              ? const <String>{}
              : _speakingIds(event.speakers),
        );
      })
      ..on<livekit.TrackSubscribedEvent>((event) async {
        if (!identical(_room, room) ||
            event.track is! livekit.RemoteAudioTrack) {
          return;
        }
        final track = event.track as livekit.RemoteAudioTrack;
        await Future<void>.delayed(Duration.zero);
        if (state.deafened) {
          await track.disable();
        } else {
          await track.enable();
        }
      })
      ..on<livekit.ParticipantConnectedEvent>((event) {
        if (!identical(_room, room)) return;
        final userId = _baseVoiceIdentity(event.participant.identity);
        if (_remoteVoiceUserIds.add(userId)) {
          _playSound(MobileSoundEffect.userJoin);
        }
      })
      ..on<livekit.ParticipantDisconnectedEvent>((event) {
        if (!identical(_room, room)) return;
        final userId = _baseVoiceIdentity(event.participant.identity);
        final stillConnected = room.remoteParticipants.values.any(
          (participant) => _baseVoiceIdentity(participant.identity) == userId,
        );
        if (!stillConnected && _remoteVoiceUserIds.remove(userId)) {
          _playSound(MobileSoundEffect.userLeave);
        }
      })
      ..on<livekit.LocalTrackPublishedEvent>((event) {
        if (!identical(_room, room) ||
            event.publication.source != livekit.TrackSource.microphone) {
          return;
        }
        state = state.copyWith(
          microphonePublished:
              event.publication.track is livekit.LocalAudioTrack,
          clearMicrophoneIssue: true,
        );
        _startMicrophoneStatsMonitor();
      })
      ..on<livekit.TrackMutedEvent>((event) {
        if (!identical(_room, room) ||
            event.participant != room.localParticipant ||
            event.publication.source != livekit.TrackSource.microphone) {
          return;
        }
        state = state.copyWith(microphonePublished: false, microphoneLevel: 0);
      })
      ..on<livekit.TrackUnmutedEvent>((event) {
        if (!identical(_room, room) ||
            event.participant != room.localParticipant ||
            event.publication.source != livekit.TrackSource.microphone) {
          return;
        }
        state = state.copyWith(
          microphonePublished: true,
          clearMicrophoneIssue: true,
        );
        _startMicrophoneStatsMonitor();
      })
      ..on<livekit.RoomDisconnectedEvent>((event) {
        if (!identical(_room, room)) return;
        debugPrint('[mobile-voice] room disconnected: ${event.reason}');
        _microphoneStatsTimer?.cancel();
        _microphoneStatsTimer = null;
        _room = null;
        final reason = event.reason?.name;
        state = MobileVoiceState(
          errorMessage: reason == null
              ? 'Соединение с голосовым каналом завершено.'
              : 'Голосовое соединение завершено: $reason.',
        );
        _playSound(MobileSoundEffect.userLeave);
      });
  }

  void _startMicrophoneStatsMonitor() {
    _microphoneStatsTimer?.cancel();
    _microphoneStatsTimer = Timer.periodic(
      const Duration(milliseconds: 350),
      (_) => unawaited(_readMicrophoneStats()),
    );
    unawaited(_readMicrophoneStats());
  }

  Future<void> _readMicrophoneStats() async {
    if (_readingMicrophoneStats || state.muted) return;
    final publication = _room?.localParticipant?.getTrackPublicationBySource(
      livekit.TrackSource.microphone,
    );
    final track = publication?.track;
    if (track is! livekit.LocalAudioTrack) {
      state = state.copyWith(
        microphonePublished: false,
        microphoneLevel: 0,
        microphoneIssue: 'LiveKit не видит опубликованный аудиотрек.',
      );
      return;
    }

    _readingMicrophoneStats = true;
    try {
      final stats = await track.getSenderStats();
      final level = stats?.audioSourceStats?.audioLevel?.toDouble() ?? 0;
      final bytesSent = stats?.bytesSent?.toInt() ?? 0;
      state = state.copyWith(
        microphonePublished: !publication!.muted && track.isActive,
        microphoneLevel: level.clamp(0, 1),
        microphoneBytesSent: bytesSent,
        clearMicrophoneIssue: true,
      );
    } catch (error) {
      state = state.copyWith(
        microphoneIssue: 'Не удалось проверить исходящий звук.',
      );
      debugPrint('[mobile-voice] microphone stats failed: $error');
    } finally {
      _readingMicrophoneStats = false;
    }
  }

  void _playSound(MobileSoundEffect effect) {
    final settings =
        ref.read(mobileBehaviorControllerProvider).value ??
        const MobileBehaviorSettings();
    if (!settings.voiceSounds) return;
    unawaited(ref.read(mobileSoundServiceProvider).play(effect));
  }

  String _microphoneErrorMessage(Object error) {
    final text = error.toString();
    if (text.startsWith('Bad state: ')) {
      return text.substring('Bad state: '.length);
    }
    return 'Не удалось включить или опубликовать микрофон.';
  }

  Set<String> _speakingIds(Iterable<livekit.Participant> participants) {
    final ids = <String>{};
    for (final participant in participants) {
      if (!participant.isSpeaking || participant.audioLevel <= 0.001) continue;
      if (participant == _room?.localParticipant && state.muted) continue;
      ids.add(_baseVoiceIdentity(participant.identity));
    }
    return ids;
  }

  String _baseVoiceIdentity(String identity) {
    const marker = ':desktop-native';
    final markerIndex = identity.indexOf(marker);
    return markerIndex == -1 ? identity : identity.substring(0, markerIndex);
  }

  Future<void> _setRemoteAudioEnabled(bool enabled) async {
    final room = _room;
    if (room == null) return;
    if (enabled) {
      await room.setSpeakerOn(true);
    }
    for (final participant in room.remoteParticipants.values) {
      for (final publication in participant.audioTrackPublications) {
        final track = publication.track;
        if (track == null || !track.isActive) continue;
        if (enabled) {
          await track.enable();
        } else {
          await track.disable();
        }
      }
    }
  }

  String _voiceErrorMessage(Object error) {
    final text = error.toString();
    if (text.startsWith('Bad state: ')) {
      return text.substring('Bad state: '.length);
    }
    if (text.contains('timed out')) {
      return 'Не дождались ответа voice сервера.';
    }
    return 'Не удалось подключиться к голосовому каналу.';
  }
}
