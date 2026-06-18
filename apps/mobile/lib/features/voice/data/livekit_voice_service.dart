import 'package:livekit_client/livekit_client.dart' as livekit;
import 'package:flutter_riverpod/flutter_riverpod.dart';

final liveKitVoiceServiceProvider = Provider<LiveKitVoiceService>((ref) {
  return const LiveKitVoiceService();
});

class LiveKitVoiceService {
  const LiveKitVoiceService();

  Future<livekit.Room> connect({
    required String url,
    required String token,
  }) async {
    final room = livekit.Room(
      roomOptions: const livekit.RoomOptions(
        defaultAudioOutputOptions: livekit.AudioOutputOptions(speakerOn: true),
      ),
    );
    await room.connect(
      url,
      token,
      connectOptions: const livekit.ConnectOptions(autoSubscribe: true),
    );
    await room.setSpeakerOn(true);
    return room;
  }
}
