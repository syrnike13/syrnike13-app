import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../sync/data/sync_models.dart';

final messagesApiProvider = Provider<MessagesApi>((ref) {
  return MessagesApi(ref.watch(apiClientProvider));
});

class MessagesApi {
  const MessagesApi(this._client);

  final ApiClient _client;

  Future<({List<SyrnikeMessage> messages, List<SyrnikeUserSummary> users})>
  fetchChannelMessages({
    required String token,
    required String channelId,
    int limit = 50,
  }) async {
    final response = await _client.get<Object?>(
      '/channels/$channelId/messages?limit=$limit&sort=Latest&include_users=true',
      sessionToken: token,
    );
    return _normalizeBulkMessages(response);
  }

  Future<SyrnikeMessage> sendChannelMessage({
    required String token,
    required String channelId,
    required String content,
  }) async {
    final json = await _client.post<Map<String, Object?>>(
      '/channels/$channelId/messages',
      sessionToken: token,
      body: {'content': content.trim()},
    );
    return SyrnikeMessage.fromJson(json);
  }

  Future<void> acknowledgeChannel({
    required String token,
    required String channelId,
    required String messageId,
  }) async {
    await _client.request<Object?>(
      '/channels/$channelId/ack/$messageId',
      method: 'PUT',
      sessionToken: token,
    );
  }

  Future<({List<SyrnikeMessage> messages, List<SyrnikeUserSummary> users})>
  searchChannelMessages({
    required String token,
    required String channelId,
    required String query,
    int limit = 8,
  }) async {
    final response = await _client.post<Object?>(
      '/channels/$channelId/search',
      sessionToken: token,
      body: {'query': query.trim(), 'limit': limit, 'include_users': true},
    );
    return _normalizeBulkMessages(response);
  }

  ({List<SyrnikeMessage> messages, List<SyrnikeUserSummary> users})
  _normalizeBulkMessages(Object? response) {
    if (response is List<dynamic>) {
      final messages = response
          .whereType<Map<String, Object?>>()
          .map(SyrnikeMessage.fromJson)
          .toList();
      messages.sort((a, b) => a.id.compareTo(b.id));
      return (messages: messages, users: const []);
    }

    if (response is Map<String, Object?>) {
      final messages = (response['messages'] as List<dynamic>? ?? const [])
          .whereType<Map<String, Object?>>()
          .map(SyrnikeMessage.fromJson)
          .toList();
      final users = (response['users'] as List<dynamic>? ?? const [])
          .whereType<Map<String, Object?>>()
          .map(SyrnikeUserSummary.fromJson)
          .toList();
      messages.sort((a, b) => a.id.compareTo(b.id));
      return (messages: messages, users: users);
    }

    return (messages: const [], users: const []);
  }
}
