import 'package:flutter_test/flutter_test.dart';
import 'package:syrnike13_mobile/features/sync/data/sync_models.dart';

void main() {
  test('uses dedicated microphone credentials for mobile voice', () {
    final credentials = SyrnikeVoiceServerCredentials.fromJson({
      'operation_id': 'operation-1',
      'channel_id': 'channel-1',
      'node': 'voice-1',
      'url': 'wss://voice.example.test',
      'token': 'shared-user-token',
      'native_microphone': {
        'token': 'native-microphone-token',
        'identity': 'user-1:desktop-native:microphone',
      },
    });

    expect(credentials.token, 'native-microphone-token');
    expect(credentials.identity, 'user-1:desktop-native:microphone');
    expect(credentials.isComplete, isTrue);
  });
}
