import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final mobileSoundServiceProvider = Provider<MobileSoundService>((ref) {
  final service = MobileSoundService();
  ref.onDispose(service.dispose);
  return service;
});

enum MobileSoundEffect {
  userJoin('user-join.ogg'),
  userLeave('user-leave.ogg'),
  mute('mute.ogg'),
  unmute('unmute.ogg'),
  deafen('deafen.ogg'),
  undeafen('undeafen.ogg');

  const MobileSoundEffect(this.fileName);

  final String fileName;
}

class MobileSoundService {
  final Set<AudioPlayer> _players = {};

  Future<void> play(MobileSoundEffect effect, {double volume = 0.8}) async {
    final player = AudioPlayer();
    _players.add(player);
    try {
      await player.setAudioContext(
        AudioContext(
          android: const AudioContextAndroid(
            isSpeakerphoneOn: true,
            audioMode: AndroidAudioMode.inCommunication,
            contentType: AndroidContentType.sonification,
            usageType: AndroidUsageType.voiceCommunicationSignalling,
            audioFocus: AndroidAudioFocus.none,
          ),
          iOS: AudioContextIOS(
            category: AVAudioSessionCategory.playAndRecord,
            options: const {
              AVAudioSessionOptions.mixWithOthers,
              AVAudioSessionOptions.defaultToSpeaker,
              AVAudioSessionOptions.allowBluetooth,
            },
          ),
        ),
      );
      await player.play(
        AssetSource('sounds/${effect.fileName}'),
        volume: volume.clamp(0, 1),
      );
      unawaited(player.onPlayerComplete.first.then((_) => _release(player)));
    } catch (_) {
      await _release(player);
    }
  }

  Future<void> _release(AudioPlayer player) async {
    if (!_players.remove(player)) return;
    await player.dispose();
  }

  void dispose() {
    final players = _players.toList();
    _players.clear();
    for (final player in players) {
      unawaited(player.dispose());
    }
  }
}
