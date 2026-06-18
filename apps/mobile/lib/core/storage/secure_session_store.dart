import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../features/auth/data/auth_models.dart';

final secureSessionStoreProvider = Provider<SecureSessionStore>((ref) {
  return const SecureSessionStore();
});

class SecureSessionStore {
  const SecureSessionStore();

  static const _storage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
    mOptions: MacOsOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );

  static const _idKey = 'session_id';
  static const _tokenKey = 'session_token';
  static const _userIdKey = 'session_user_id';

  Future<Session?> read() async {
    final id = await _storage.read(key: _idKey);
    final token = await _storage.read(key: _tokenKey);
    final userId = await _storage.read(key: _userIdKey);

    if (id == null || token == null || userId == null) return null;
    return Session(id: id, token: token, userId: userId);
  }

  Future<void> write(Session session) async {
    await Future.wait([
      _storage.write(key: _idKey, value: session.id),
      _storage.write(key: _tokenKey, value: session.token),
      _storage.write(key: _userIdKey, value: session.userId),
    ]);
  }

  Future<void> clear() async {
    await Future.wait([
      _storage.delete(key: _idKey),
      _storage.delete(key: _tokenKey),
      _storage.delete(key: _userIdKey),
    ]);
  }
}
