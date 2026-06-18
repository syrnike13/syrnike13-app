import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/data/auth_models.dart';
import '../../sync/data/sync_models.dart';

final usersApiProvider = Provider<UsersApi>((ref) {
  return UsersApi(ref.watch(apiClientProvider));
});

class UsersApi {
  const UsersApi(this._client);

  final ApiClient _client;

  Future<SyrnikeChannel> openDirectMessage({
    required String token,
    required String userId,
  }) async {
    final json = await _client.get<Map<String, Object?>>(
      '/users/$userId/dm',
      sessionToken: token,
    );
    return SyrnikeChannel.fromJson(json);
  }

  Future<SyrnikeUserSummary> sendFriendRequest({
    required String token,
    required String username,
  }) async {
    final json = await _client.post<Map<String, Object?>>(
      '/users/friend',
      sessionToken: token,
      body: {'username': username.trim()},
    );
    return SyrnikeUserSummary.fromJson(json);
  }

  Future<SyrnikeUserSummary> acceptFriendRequest({
    required String token,
    required String userId,
  }) async {
    final json = await _client.request<Map<String, Object?>>(
      '/users/$userId/friend',
      method: 'PUT',
      sessionToken: token,
    );
    return SyrnikeUserSummary.fromJson(json);
  }

  Future<SyrnikeUserSummary> declineFriendRequest({
    required String token,
    required String userId,
  }) async {
    final json = await _client.request<Map<String, Object?>>(
      '/users/$userId/friend',
      method: 'DELETE',
      sessionToken: token,
    );
    return SyrnikeUserSummary.fromJson(json);
  }

  Future<SyrnikeUserProfile> fetchUserProfile({
    required String token,
    required String userId,
  }) async {
    final json = await _client.get<Map<String, Object?>>(
      '/users/$userId/profile',
      sessionToken: token,
    );
    return SyrnikeUserProfile.fromJson(json);
  }

  Future<SyrnikeUser> updateCurrentUser({
    required String token,
    required Map<String, Object?> body,
  }) async {
    final json = await _client.request<Map<String, Object?>>(
      '/users/@me',
      method: 'PATCH',
      sessionToken: token,
      body: body,
    );
    return SyrnikeUser.fromJson(json);
  }
}
