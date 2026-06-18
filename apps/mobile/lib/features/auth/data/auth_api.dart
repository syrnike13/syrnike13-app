import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/app_config.dart';
import '../../../core/network/api_client.dart';
import 'auth_models.dart';

final authApiProvider = Provider<AuthApi>((ref) {
  return AuthApi(ref.watch(apiClientProvider), ref.watch(appConfigProvider));
});

class AuthApi {
  const AuthApi(this._client, this._config);

  final ApiClient _client;
  final AppConfig _config;

  Future<LoginResponse> loginWithPassword({
    required String email,
    required String password,
  }) async {
    final json = await _client.post<Map<String, Object?>>(
      '/auth/session/login',
      body: {
        'email': email,
        'password': password,
        'friendly_name': _config.friendlySessionName,
      },
    );

    return LoginResponse.fromJson(json);
  }

  Future<void> createAccount({
    required String email,
    required String password,
    String? invite,
  }) async {
    await _client.post<Object?>(
      '/auth/account/create',
      body: {
        'email': email,
        'password': password,
        if (invite?.trim().isNotEmpty == true) 'invite': invite!.trim(),
      },
    );
  }

  Future<LoginResponse> loginWithMfaPassword({
    required String ticket,
    required String password,
  }) async {
    final json = await _client.post<Map<String, Object?>>(
      '/auth/session/login',
      body: {
        'mfa_ticket': ticket,
        'mfa_response': {'password': password},
        'friendly_name': _config.friendlySessionName,
      },
    );

    return LoginResponse.fromJson(json);
  }

  Future<SyrnikeUser> fetchCurrentUser(String token) async {
    final json = await _client.get<Map<String, Object?>>(
      '/users/@me',
      sessionToken: token,
    );
    return SyrnikeUser.fromJson(json);
  }

  Future<OnboardingStatus> fetchOnboardingStatus(String token) async {
    final json = await _client.get<Map<String, Object?>>(
      '/onboard/hello',
      sessionToken: token,
    );
    return OnboardingStatus.fromJson(json);
  }

  Future<SyrnikeUser> completeOnboarding({
    required String token,
    required String username,
  }) async {
    final json = await _client.post<Map<String, Object?>>(
      '/onboard/complete',
      body: {'username': username},
      sessionToken: token,
    );
    return SyrnikeUser.fromJson(json);
  }

  Future<void> logout(String token) async {
    await _client.post<Object?>('/auth/session/logout', sessionToken: token);
  }
}
