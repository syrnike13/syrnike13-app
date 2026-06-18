import 'package:flutter_test/flutter_test.dart';
import 'package:syrnike13_mobile/features/settings/application/mobile_behavior_controller.dart';
import 'package:syrnike13_mobile/features/voice/application/mobile_voice_controller.dart';

void main() {
  test('voice sounds are enabled by default and persist in settings', () {
    const settings = MobileBehaviorSettings();

    expect(settings.voiceSounds, isTrue);
    expect(
      MobileBehaviorSettings.fromJson({
        ...settings.toJson(),
        'voiceSounds': false,
      }).voiceSounds,
      isFalse,
    );
  });

  test('voice state keeps microphone publication diagnostics', () {
    const state = MobileVoiceState();
    final next = state.copyWith(
      microphonePublished: true,
      microphoneLevel: 0.42,
      microphoneBytesSent: 2048,
      microphoneIssue: 'test',
    );

    expect(next.microphonePublished, isTrue);
    expect(next.microphoneLevel, 0.42);
    expect(next.microphoneBytesSent, 2048);
    expect(next.copyWith(clearMicrophoneIssue: true).microphoneIssue, isNull);
  });
}
