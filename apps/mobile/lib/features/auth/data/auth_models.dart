import '../../media/data/media_models.dart';

sealed class LoginResponse {
  const LoginResponse();

  factory LoginResponse.fromJson(Map<String, Object?> json) {
    return switch (json['result']) {
      'Success' => LoginSuccess(
        session: Session(
          id: json['_id'] as String,
          token: json['token'] as String,
          userId: json['user_id'] as String,
        ),
      ),
      'MFA' => LoginMfa(
        ticket: json['ticket'] as String,
        allowedMethods: (json['allowed_methods'] as List<dynamic>? ?? const [])
            .whereType<String>()
            .toList(),
      ),
      _ => const LoginDisabled(),
    };
  }
}

class LoginSuccess extends LoginResponse {
  const LoginSuccess({required this.session});

  final Session session;
}

class LoginMfa extends LoginResponse {
  const LoginMfa({required this.ticket, required this.allowedMethods});

  final String ticket;
  final List<String> allowedMethods;
}

class LoginDisabled extends LoginResponse {
  const LoginDisabled();
}

class Session {
  const Session({required this.id, required this.token, required this.userId});

  final String id;
  final String token;
  final String userId;
}

class SyrnikeUser {
  const SyrnikeUser({
    required this.id,
    required this.username,
    required this.discriminator,
    required this.online,
    this.displayName,
    this.avatar,
    this.statusText,
  });

  factory SyrnikeUser.fromJson(Map<String, Object?> json) {
    final status = json['status'];
    return SyrnikeUser(
      id: json['_id'] as String,
      username: json['username'] as String,
      discriminator: json['discriminator'] as String? ?? '0000',
      displayName: json['display_name'] as String?,
      avatar: parseSyrnikeFileAsset(json['avatar'], fallbackTag: 'avatars'),
      statusText: status is Map<String, Object?>
          ? status['text'] as String?
          : null,
      online: json['online'] as bool? ?? false,
    );
  }

  final String id;
  final String username;
  final String discriminator;
  final String? displayName;
  final SyrnikeFileAsset? avatar;
  final String? statusText;
  final bool online;

  String get effectiveName =>
      displayName?.trim().isNotEmpty == true ? displayName!.trim() : username;

  SyrnikeUser copyWith({
    String? username,
    String? discriminator,
    String? displayName,
    SyrnikeFileAsset? avatar,
    String? statusText,
    bool? online,
    bool clearDisplayName = false,
    bool clearAvatar = false,
    bool clearStatusText = false,
  }) {
    return SyrnikeUser(
      id: id,
      username: username ?? this.username,
      discriminator: discriminator ?? this.discriminator,
      displayName: clearDisplayName ? null : displayName ?? this.displayName,
      avatar: clearAvatar ? null : avatar ?? this.avatar,
      statusText: clearStatusText ? null : statusText ?? this.statusText,
      online: online ?? this.online,
    );
  }
}

class OnboardingStatus {
  const OnboardingStatus({required this.required});

  factory OnboardingStatus.fromJson(Map<String, Object?> json) {
    return OnboardingStatus(required: json['onboarding'] as bool? ?? false);
  }

  final bool required;
}
