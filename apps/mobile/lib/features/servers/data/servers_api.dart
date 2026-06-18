import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../sync/data/sync_models.dart';

final serversApiProvider = Provider<ServersApi>((ref) {
  return ServersApi(ref.watch(apiClientProvider));
});

class ServersApi {
  const ServersApi(this._client);

  final ApiClient _client;

  Future<({SyrnikeServer server, List<SyrnikeChannel> channels})> createServer({
    required String token,
    required String name,
  }) async {
    final response = await _client.post<Map<String, Object?>>(
      '/servers/create',
      sessionToken: token,
      body: {'name': name.trim()},
    );
    return _serverResponse(response);
  }

  Future<({SyrnikeServer server, List<SyrnikeChannel> channels})?> joinInvite({
    required String token,
    required String input,
  }) async {
    final code = parseInviteCode(input);
    if (code == null) return null;

    final response = await _client.post<Map<String, Object?>>(
      '/invites/$code',
      sessionToken: token,
    );
    if (response['type'] != 'Server') return null;
    return _serverResponse(response);
  }

  ({SyrnikeServer server, List<SyrnikeChannel> channels}) _serverResponse(
    Map<String, Object?> response,
  ) {
    final serverJson = response['server'];
    if (serverJson is! Map<String, Object?>) {
      throw StateError('Сервер не найден в ответе API');
    }
    final channels = (response['channels'] as List<dynamic>? ?? const [])
        .whereType<Map<String, Object?>>()
        .map(SyrnikeChannel.fromJson)
        .toList();
    return (server: SyrnikeServer.fromJson(serverJson), channels: channels);
  }
}

String? parseInviteCode(String input) {
  final trimmed = input.trim();
  if (trimmed.isEmpty) return null;

  final uri = Uri.tryParse(trimmed);
  if (uri != null && uri.pathSegments.isNotEmpty) {
    final inviteIndex = uri.pathSegments.indexOf('invite');
    if (inviteIndex >= 0 && inviteIndex + 1 < uri.pathSegments.length) {
      return uri.pathSegments[inviteIndex + 1];
    }
    if (uri.hasScheme || uri.host.isNotEmpty) {
      return uri.pathSegments.last;
    }
  }

  final withoutQuery = trimmed.split(RegExp(r'[?#]')).first;
  final parts = withoutQuery.split('/').where((part) => part.isNotEmpty);
  return parts.isEmpty ? null : parts.last;
}
