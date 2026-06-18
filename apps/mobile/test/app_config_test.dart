import 'package:flutter_test/flutter_test.dart';
import 'package:syrnike13_mobile/core/config/app_config.dart';

void main() {
  test('uses production endpoints by default', () {
    final config = AppConfig.fromEnvironment();

    expect(config.apiUrl, 'https://syrnike13.ru/api');
    expect(config.wsUrl, 'wss://syrnike13.ru/ws');
    expect(config.mediaUrl, 'https://syrnike13.ru/autumn');
    expect(config.proxyUrl, 'https://syrnike13.ru/january');
  });
}
