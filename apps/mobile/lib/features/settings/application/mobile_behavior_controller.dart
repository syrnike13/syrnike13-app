import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

final mobileBehaviorControllerProvider =
    AsyncNotifierProvider<MobileBehaviorController, MobileBehaviorSettings>(
      MobileBehaviorController.new,
    );

class MobileBehaviorSettings {
  const MobileBehaviorSettings({
    this.compactServerRail = false,
    this.showPresenceDots = true,
    this.reduceMotion = false,
    this.chatSwipeActions = true,
    this.openKeyboardInChats = true,
    this.joinVoiceMuted = false,
    this.voiceSounds = true,
    this.hapticFeedback = true,
  });

  factory MobileBehaviorSettings.fromJson(Map<String, Object?> json) {
    return MobileBehaviorSettings(
      compactServerRail: json['compactServerRail'] as bool? ?? false,
      showPresenceDots: json['showPresenceDots'] as bool? ?? true,
      reduceMotion: json['reduceMotion'] as bool? ?? false,
      chatSwipeActions: json['chatSwipeActions'] as bool? ?? true,
      openKeyboardInChats: json['openKeyboardInChats'] as bool? ?? true,
      joinVoiceMuted: json['joinVoiceMuted'] as bool? ?? false,
      voiceSounds: json['voiceSounds'] as bool? ?? true,
      hapticFeedback: json['hapticFeedback'] as bool? ?? true,
    );
  }

  final bool compactServerRail;
  final bool showPresenceDots;
  final bool reduceMotion;
  final bool chatSwipeActions;
  final bool openKeyboardInChats;
  final bool joinVoiceMuted;
  final bool voiceSounds;
  final bool hapticFeedback;

  Map<String, Object?> toJson() {
    return {
      'compactServerRail': compactServerRail,
      'showPresenceDots': showPresenceDots,
      'reduceMotion': reduceMotion,
      'chatSwipeActions': chatSwipeActions,
      'openKeyboardInChats': openKeyboardInChats,
      'joinVoiceMuted': joinVoiceMuted,
      'voiceSounds': voiceSounds,
      'hapticFeedback': hapticFeedback,
    };
  }

  MobileBehaviorSettings copyWith({
    bool? compactServerRail,
    bool? showPresenceDots,
    bool? reduceMotion,
    bool? chatSwipeActions,
    bool? openKeyboardInChats,
    bool? joinVoiceMuted,
    bool? voiceSounds,
    bool? hapticFeedback,
  }) {
    return MobileBehaviorSettings(
      compactServerRail: compactServerRail ?? this.compactServerRail,
      showPresenceDots: showPresenceDots ?? this.showPresenceDots,
      reduceMotion: reduceMotion ?? this.reduceMotion,
      chatSwipeActions: chatSwipeActions ?? this.chatSwipeActions,
      openKeyboardInChats: openKeyboardInChats ?? this.openKeyboardInChats,
      joinVoiceMuted: joinVoiceMuted ?? this.joinVoiceMuted,
      voiceSounds: voiceSounds ?? this.voiceSounds,
      hapticFeedback: hapticFeedback ?? this.hapticFeedback,
    );
  }
}

class MobileBehaviorController extends AsyncNotifier<MobileBehaviorSettings> {
  static const _storage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
    mOptions: MacOsOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );
  static const _settingsKey = 'mobile_behavior_settings';

  @override
  Future<MobileBehaviorSettings> build() async {
    final raw = await _storage.read(key: _settingsKey);
    if (raw == null || raw.isEmpty) return const MobileBehaviorSettings();
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, Object?>) {
        return MobileBehaviorSettings.fromJson(decoded);
      }
    } catch (_) {
      return const MobileBehaviorSettings();
    }
    return const MobileBehaviorSettings();
  }

  Future<void> persist(MobileBehaviorSettings settings) async {
    state = AsyncData(settings);
    await _storage.write(key: _settingsKey, value: jsonEncode(settings));
  }

  Future<void> patch(
    MobileBehaviorSettings Function(MobileBehaviorSettings) fn,
  ) {
    return persist(fn(state.value ?? const MobileBehaviorSettings()));
  }
}
