import 'package:flutter_riverpod/flutter_riverpod.dart';

final appConfigProvider = Provider<AppConfig>((ref) {
  return AppConfig.fromEnvironment();
});

class AppConfig {
  const AppConfig({
    required this.apiUrl,
    required this.wsUrl,
    required this.mediaUrl,
    required this.proxyUrl,
    required this.friendlySessionName,
  });

  factory AppConfig.fromEnvironment() {
    return const AppConfig(
      apiUrl: String.fromEnvironment(
        'SYRNIKE_API_URL',
        defaultValue: 'https://syrnike13.ru/api',
      ),
      wsUrl: String.fromEnvironment(
        'SYRNIKE_WS_URL',
        defaultValue: 'wss://syrnike13.ru/ws',
      ),
      mediaUrl: String.fromEnvironment(
        'SYRNIKE_MEDIA_URL',
        defaultValue: 'https://syrnike13.ru/autumn',
      ),
      proxyUrl: String.fromEnvironment(
        'SYRNIKE_PROXY_URL',
        defaultValue: 'https://syrnike13.ru/january',
      ),
      friendlySessionName: 'syrnike13 Flutter',
    );
  }

  final String apiUrl;
  final String wsUrl;
  final String mediaUrl;
  final String proxyUrl;
  final String friendlySessionName;
}
