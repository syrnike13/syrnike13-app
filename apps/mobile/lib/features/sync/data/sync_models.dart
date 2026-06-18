import '../../media/data/media_models.dart';

const _unset = Object();

class SyncSnapshot {
  const SyncSnapshot({
    this.ready = false,
    this.gatewayState = GatewayConnectionState.idle,
    this.selectedServerId,
    this.selectedChannelId,
    this.servers = const {},
    this.channels = const {},
    this.users = const {},
    this.messages = const {},
    this.unreads = const {},
    this.voiceParticipants = const {},
    this.errorMessage,
  });

  final bool ready;
  final GatewayConnectionState gatewayState;
  final String? selectedServerId;
  final String? selectedChannelId;
  final Map<String, SyrnikeServer> servers;
  final Map<String, SyrnikeChannel> channels;
  final Map<String, SyrnikeUserSummary> users;
  final Map<String, List<SyrnikeMessage>> messages;
  final Map<String, String?> unreads;
  final Map<String, Map<String, SyrnikeVoiceParticipant>> voiceParticipants;
  final String? errorMessage;

  SyncSnapshot copyWith({
    bool? ready,
    GatewayConnectionState? gatewayState,
    Object? selectedServerId = _unset,
    Object? selectedChannelId = _unset,
    Map<String, SyrnikeServer>? servers,
    Map<String, SyrnikeChannel>? channels,
    Map<String, SyrnikeUserSummary>? users,
    Map<String, List<SyrnikeMessage>>? messages,
    Map<String, String?>? unreads,
    Map<String, Map<String, SyrnikeVoiceParticipant>>? voiceParticipants,
    String? errorMessage,
    bool clearError = false,
  }) {
    return SyncSnapshot(
      ready: ready ?? this.ready,
      gatewayState: gatewayState ?? this.gatewayState,
      selectedServerId: identical(selectedServerId, _unset)
          ? this.selectedServerId
          : selectedServerId as String?,
      selectedChannelId: identical(selectedChannelId, _unset)
          ? this.selectedChannelId
          : selectedChannelId as String?,
      servers: servers ?? this.servers,
      channels: channels ?? this.channels,
      users: users ?? this.users,
      messages: messages ?? this.messages,
      unreads: unreads ?? this.unreads,
      voiceParticipants: voiceParticipants ?? this.voiceParticipants,
      errorMessage: clearError ? null : errorMessage ?? this.errorMessage,
    );
  }

  List<SyrnikeServer> get sortedServers {
    return servers.values.toList()
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  }

  List<SyrnikeChannel> serverChannels(String serverId) {
    return _orderedServerChannels(
      serverId,
      (channel) => channel.serverId == serverId,
    );
  }

  List<SyrnikeChannel> serverTextChannels(String serverId) {
    return _orderedServerChannels(
      serverId,
      (channel) => channel.serverId == serverId && channel.isTextLike,
    );
  }

  List<SyrnikeChannel> serverVoiceChannels(String serverId) {
    return _orderedServerChannels(
      serverId,
      (channel) => channel.serverId == serverId && channel.isServerVoice,
    );
  }

  List<SyrnikeChannel> _orderedServerChannels(
    String serverId,
    bool Function(SyrnikeChannel channel) filter,
  ) {
    final server = servers[serverId];
    final list = channels.values.where(filter).toList();

    if (server == null || server.channelIds.isEmpty) {
      list.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
      return list;
    }

    final order = <String, int>{};
    for (var i = 0; i < server.channelIds.length; i += 1) {
      order[server.channelIds[i]] = i;
    }
    list.sort((a, b) {
      final aIndex = order[a.id] ?? 1 << 30;
      final bIndex = order[b.id] ?? 1 << 30;
      if (aIndex != bIndex) return aIndex.compareTo(bIndex);
      return a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });
    return list;
  }

  List<SyrnikeVoiceParticipant> voiceUsers(String channelId) {
    final participants = <SyrnikeVoiceParticipant>[
      ...?voiceParticipants[channelId]?.values,
    ];
    participants.sort((a, b) => a.joinedAt.compareTo(b.joinedAt));
    return participants;
  }

  List<SyrnikeChannel> dmChannels(String currentUserId) {
    return channels.values
        .where((channel) => channel.isDmLike && channel.isTextLike)
        .toList()
      ..sort((a, b) {
        final lastCompare = (b.lastMessageId ?? '').compareTo(
          a.lastMessageId ?? '',
        );
        if (lastCompare != 0) return lastCompare;
        return channelLabel(
          a,
          currentUserId,
        ).toLowerCase().compareTo(channelLabel(b, currentUserId).toLowerCase());
      });
  }

  List<SyrnikeMessage> channelMessages(String channelId) {
    return messages[channelId] ?? const [];
  }

  List<SyrnikeUserSummary> friends(String currentUserId, {int limit = 80}) {
    final result = <SyrnikeUserSummary>[];
    for (final user in users.values) {
      if (user.id == currentUserId ||
          user.relationship != 'Friend' ||
          user.bot) {
        continue;
      }
      result.add(user);
      if (result.length >= limit) break;
    }
    return result..sort(
      (a, b) => a.effectiveName.toLowerCase().compareTo(
        b.effectiveName.toLowerCase(),
      ),
    );
  }

  SyrnikeUserSummary? dmPeer(SyrnikeChannel channel, String currentUserId) {
    if (channel.type != 'DirectMessage') return null;
    final otherId = channel.recipients.firstWhere(
      (id) => id != currentUserId,
      orElse: () => '',
    );
    return users[otherId];
  }

  String channelLabel(SyrnikeChannel channel, String currentUserId) {
    switch (channel.type) {
      case 'SavedMessages':
        return 'Сохранённые';
      case 'DirectMessage':
        final otherId = channel.recipients.firstWhere(
          (id) => id != currentUserId,
          orElse: () => '',
        );
        final other = users[otherId];
        return other?.effectiveName ?? 'Личные сообщения';
      case 'Group':
      case 'TextChannel':
        return channel.name;
      default:
        return channel.name.isEmpty ? 'Канал' : channel.name;
    }
  }
}

enum GatewayConnectionState { idle, connecting, connected, reconnecting, error }

class SyrnikeServer {
  const SyrnikeServer({
    required this.id,
    required this.name,
    this.description,
    this.channelIds = const [],
  });

  factory SyrnikeServer.fromJson(Map<String, Object?> json) {
    return SyrnikeServer(
      id: json['_id'] as String,
      name: json['name'] as String? ?? 'Сервер',
      description: json['description'] as String?,
      channelIds: (json['channels'] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toList(),
    );
  }

  final String id;
  final String name;
  final String? description;
  final List<String> channelIds;

  String get initials {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return '??';
    final parts = trimmed.split(RegExp(r'\s+')).where((p) => p.isNotEmpty);
    final letters = parts.take(2).map((p) => p[0]).join();
    return letters.toUpperCase();
  }
}

class SyrnikeChannel {
  const SyrnikeChannel({
    required this.id,
    required this.type,
    this.name = '',
    this.serverId,
    this.description,
    this.recipients = const [],
    this.lastMessageId,
    this.hasVoice = false,
  });

  factory SyrnikeChannel.fromJson(Map<String, Object?> json) {
    final type = json['channel_type'] as String? ?? 'TextChannel';
    return SyrnikeChannel(
      id: json['_id'] as String,
      type: type,
      name: json['name'] as String? ?? '',
      serverId: json['server'] as String?,
      description: json['description'] as String?,
      recipients: (json['recipients'] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toList(),
      lastMessageId: json['last_message_id'] as String?,
      hasVoice: json['voice'] != null || type == 'VoiceChannel',
    );
  }

  final String id;
  final String type;
  final String name;
  final String? serverId;
  final String? description;
  final List<String> recipients;
  final String? lastMessageId;
  final bool hasVoice;

  bool get isDmLike =>
      type == 'DirectMessage' || type == 'Group' || type == 'SavedMessages';

  bool get isServerVoice =>
      serverId != null && (hasVoice || type == 'VoiceChannel');

  bool get isTextLike =>
      !isServerVoice &&
      (type == 'TextChannel' ||
          type == 'DirectMessage' ||
          type == 'Group' ||
          type == 'SavedMessages');
}

class SyrnikeVoiceParticipant {
  const SyrnikeVoiceParticipant({
    required this.id,
    required this.joinedAt,
    this.selfMute = false,
    this.selfDeaf = false,
    this.serverMuted = false,
    this.serverDeafened = false,
    this.screensharing = false,
    this.camera = false,
    this.version = 0,
  });

  factory SyrnikeVoiceParticipant.fromJson(Object? raw) {
    if (raw is String) {
      return SyrnikeVoiceParticipant(
        id: raw,
        joinedAt: DateTime.now().millisecondsSinceEpoch,
      );
    }
    final json = raw is Map<String, Object?> ? raw : const <String, Object?>{};
    final id = (json['id'] ?? json['user'] ?? json['user_id']) as String? ?? '';
    return SyrnikeVoiceParticipant(
      id: id,
      joinedAt: _parseVoiceTimestamp(json['joined_at']),
      selfMute: _parseVoiceFlag(json['self_mute']),
      selfDeaf: _parseVoiceFlag(json['self_deaf']),
      serverMuted: _parseVoiceFlag(json['server_muted']),
      serverDeafened: _parseVoiceFlag(json['server_deafened']),
      screensharing: _parseVoiceFlag(json['screensharing']),
      camera: _parseVoiceFlag(json['camera']),
      version: _parseVoiceVersion(json['version']),
    );
  }

  final String id;
  final int joinedAt;
  final bool selfMute;
  final bool selfDeaf;
  final bool serverMuted;
  final bool serverDeafened;
  final bool screensharing;
  final bool camera;
  final int version;

  bool get muted => selfMute || serverMuted;
  bool get deafened => selfDeaf || serverDeafened;

  SyrnikeVoiceParticipant copyWith({
    bool? selfMute,
    bool? selfDeaf,
    bool? camera,
    int? version,
  }) {
    return SyrnikeVoiceParticipant(
      id: id,
      joinedAt: joinedAt,
      selfMute: selfMute ?? this.selfMute,
      selfDeaf: selfDeaf ?? this.selfDeaf,
      serverMuted: serverMuted,
      serverDeafened: serverDeafened,
      screensharing: screensharing,
      camera: camera ?? this.camera,
      version: version ?? this.version,
    );
  }
}

class SyrnikeVoiceServerCredentials {
  const SyrnikeVoiceServerCredentials({
    required this.operationId,
    required this.channelId,
    required this.node,
    required this.url,
    required this.token,
    required this.identity,
  });

  factory SyrnikeVoiceServerCredentials.fromJson(Map<String, Object?> json) {
    final nativeMicrophone = json['native_microphone'];
    final nativeCredentials = nativeMicrophone is Map<String, Object?>
        ? nativeMicrophone
        : const <String, Object?>{};
    return SyrnikeVoiceServerCredentials(
      operationId: json['operation_id'] as String? ?? '',
      channelId: json['channel_id'] as String? ?? '',
      node: json['node'] as String? ?? '',
      url: json['url'] as String? ?? '',
      token:
          nativeCredentials['token'] as String? ??
          json['token'] as String? ??
          '',
      identity: nativeCredentials['identity'] as String? ?? '',
    );
  }

  final String operationId;
  final String channelId;
  final String node;
  final String url;
  final String token;
  final String identity;

  bool get isComplete =>
      operationId.isNotEmpty &&
      channelId.isNotEmpty &&
      url.isNotEmpty &&
      token.isNotEmpty &&
      identity.isNotEmpty;
}

bool _parseVoiceFlag(Object? value, [bool defaultValue = false]) {
  if (value == null) return defaultValue;
  if (value is bool) return value;
  if (value is num) return value != 0;
  if (value is String) {
    final normalized = value.trim().toLowerCase();
    if (normalized == 'true' || normalized == '1') return true;
    if (normalized == 'false' || normalized == '0') return false;
  }
  return defaultValue;
}

int _parseVoiceTimestamp(Object? value) {
  if (value is num && value.isFinite) return value.toInt();
  if (value is String) {
    final asInt = int.tryParse(value);
    if (asInt != null) return asInt;
    final parsed = DateTime.tryParse(value);
    if (parsed != null) return parsed.millisecondsSinceEpoch;
  }
  return DateTime.now().millisecondsSinceEpoch;
}

int _parseVoiceVersion(Object? value) {
  if (value is num && value.isFinite) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}

class SyrnikeUserSummary {
  const SyrnikeUserSummary({
    required this.id,
    required this.username,
    this.displayName,
    this.discriminator,
    this.relationship,
    this.avatar,
    this.statusText,
    this.online = false,
    this.bot = false,
  });

  factory SyrnikeUserSummary.fromJson(Map<String, Object?> json) {
    final bot = json['bot'];
    final status = json['status'];
    return SyrnikeUserSummary(
      id: json['_id'] as String,
      username: json['username'] as String? ?? 'user',
      displayName: json['display_name'] as String?,
      discriminator: json['discriminator'] as String?,
      relationship: json['relationship'] as String?,
      avatar: parseSyrnikeFileAsset(json['avatar'], fallbackTag: 'avatars'),
      statusText: status is Map<String, Object?>
          ? status['text'] as String?
          : null,
      online: json['online'] as bool? ?? false,
      bot: bot != null,
    );
  }

  final String id;
  final String username;
  final String? displayName;
  final String? discriminator;
  final String? relationship;
  final SyrnikeFileAsset? avatar;
  final String? statusText;
  final bool online;
  final bool bot;

  String get effectiveName {
    final name = displayName?.trim();
    return name == null || name.isEmpty ? username : name;
  }

  SyrnikeUserSummary copyWith({
    String? username,
    String? displayName,
    String? discriminator,
    String? relationship,
    SyrnikeFileAsset? avatar,
    String? statusText,
    bool? online,
    bool? bot,
    bool clearDisplayName = false,
    bool clearAvatar = false,
    bool clearStatusText = false,
  }) {
    return SyrnikeUserSummary(
      id: id,
      username: username ?? this.username,
      displayName: clearDisplayName ? null : displayName ?? this.displayName,
      discriminator: discriminator ?? this.discriminator,
      relationship: relationship ?? this.relationship,
      avatar: clearAvatar ? null : avatar ?? this.avatar,
      statusText: clearStatusText ? null : statusText ?? this.statusText,
      online: online ?? this.online,
      bot: bot ?? this.bot,
    );
  }
}

class SyrnikeUserProfile {
  const SyrnikeUserProfile({this.content, this.background});

  factory SyrnikeUserProfile.fromJson(Map<String, Object?> json) {
    return SyrnikeUserProfile(
      content: json['content'] as String?,
      background: parseSyrnikeFileAsset(
        json['background'],
        fallbackTag: 'backgrounds',
      ),
    );
  }

  final String? content;
  final SyrnikeFileAsset? background;
}

class SyrnikeMessage {
  const SyrnikeMessage({
    required this.id,
    required this.channelId,
    required this.authorId,
    this.content,
    this.author,
    this.attachmentsCount = 0,
    this.pinned = false,
    this.edited = false,
  });

  factory SyrnikeMessage.fromJson(Map<String, Object?> json) {
    final userJson = json['user'];
    return SyrnikeMessage(
      id: json['_id'] as String,
      channelId: json['channel'] as String,
      authorId: json['author'] as String? ?? '',
      content: json['content'] as String?,
      author: userJson is Map<String, Object?>
          ? SyrnikeUserSummary.fromJson(userJson)
          : null,
      attachmentsCount:
          (json['attachments'] as List<dynamic>? ?? const []).length,
      pinned: json['pinned'] as bool? ?? false,
      edited: json['edited'] != null,
    );
  }

  final String id;
  final String channelId;
  final String authorId;
  final String? content;
  final SyrnikeUserSummary? author;
  final int attachmentsCount;
  final bool pinned;
  final bool edited;

  bool get hasText => content?.trim().isNotEmpty == true;
}
