import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../../core/config/app_config.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/data/auth_models.dart';
import '../../chat/data/messages_api.dart';
import '../../servers/data/servers_api.dart';
import '../../users/data/users_api.dart';
import '../data/sync_models.dart';

final syncControllerProvider = NotifierProvider<SyncController, SyncSnapshot>(
  SyncController.new,
);

class SyncController extends Notifier<SyncSnapshot> {
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _heartbeat;
  String? _connectedToken;
  final _voiceJoinCompleters =
      <String, Completer<SyrnikeVoiceServerCredentials>>{};
  final _voiceNonceToOperation = <String, String>{};

  @override
  SyncSnapshot build() {
    ref.onDispose(_closeSocket);
    ref.listen<AuthState>(authControllerProvider, (_, next) {
      final token = next.session?.token;
      if (!next.isAuthenticated || token == null) {
        _connectedToken = null;
        _closeSocket();
        state = const SyncSnapshot();
        return;
      }
      if (_connectedToken != token) {
        Future<void>.microtask(() => connect(token));
      }
    });
    return const SyncSnapshot();
  }

  Future<void> connect(String token) async {
    _connectedToken = token;
    _closeSocket();
    state = state.copyWith(
      gatewayState: GatewayConnectionState.connecting,
      clearError: true,
    );

    final config = ref.read(appConfigProvider);
    final uri = Uri.parse(config.wsUrl).replace(
      queryParameters: {
        'version': '1',
        'format': 'json',
        'token': token,
        'client': 'mobile',
        'ready': 'users',
      },
    );
    final readyFields = [
      'users',
      'servers',
      'channels',
      'members',
      'emojis',
      'voice_states',
      'voice_calls',
      'channel_unreads',
    ];
    final gatewayUri = uri.replace(
      query:
          'version=1&format=json&token=${Uri.encodeQueryComponent(token)}&client=mobile&${readyFields.map((field) => 'ready=$field').join('&')}',
    );

    try {
      final channel = WebSocketChannel.connect(gatewayUri);
      _channel = channel;
      _subscription = channel.stream.listen(
        _handleFrame,
        onError: (_) => _handleDisconnect('Gateway connection failed'),
        onDone: () => _handleDisconnect(null),
      );
      _heartbeat = Timer.periodic(const Duration(seconds: 30), (_) {
        _send({'type': 'Ping', 'data': DateTime.now().millisecondsSinceEpoch});
      });
    } catch (error) {
      state = state.copyWith(
        gatewayState: GatewayConnectionState.error,
        errorMessage: 'Не удалось подключиться к gateway.',
      );
    }
  }

  void selectServer(String? serverId) {
    state = state.copyWith(selectedServerId: serverId);
  }

  void selectChannelPanel() {
    state = state.copyWith(selectedChannelId: null);
  }

  Future<void> selectChannel(String channelId, String token) async {
    state = state.copyWith(selectedChannelId: channelId);
    if (state.messages[channelId]?.isNotEmpty != true) {
      final api = ref.read(messagesApiProvider);
      try {
        final result = await api.fetchChannelMessages(
          token: token,
          channelId: channelId,
        );
        final users = {...state.users};
        for (final user in result.users) {
          users[user.id] = user;
        }
        state = state.copyWith(
          users: users,
          messages: {...state.messages, channelId: result.messages},
        );
      } catch (error) {
        state = state.copyWith(errorMessage: 'Не удалось загрузить сообщения.');
      }
    }
    await _acknowledgeChannel(channelId: channelId, token: token);
  }

  Future<void> openDirectMessage({
    required String token,
    required String userId,
  }) async {
    final api = ref.read(usersApiProvider);
    try {
      final channel = await api.openDirectMessage(token: token, userId: userId);
      _upsertChannel(channel);
      state = state.copyWith(selectedServerId: null);
      await selectChannel(channel.id, token);
    } catch (error) {
      state = state.copyWith(errorMessage: 'Не удалось открыть личный чат.');
    }
  }

  Future<void> sendFriendRequest({
    required String token,
    required String username,
  }) async {
    final trimmed = username.trim();
    if (trimmed.isEmpty) return;

    final api = ref.read(usersApiProvider);
    try {
      final user = await api.sendFriendRequest(token: token, username: trimmed);
      state = state.copyWith(users: {...state.users, user.id: user});
    } catch (error) {
      state = state.copyWith(errorMessage: 'Не удалось отправить заявку.');
      rethrow;
    }
  }

  Future<void> acceptFriendRequest({
    required String token,
    required String userId,
  }) async {
    try {
      final user = await ref
          .read(usersApiProvider)
          .acceptFriendRequest(token: token, userId: userId);
      state = state.copyWith(users: {...state.users, user.id: user});
    } catch (error) {
      state = state.copyWith(errorMessage: 'Не удалось принять заявку.');
      rethrow;
    }
  }

  Future<void> declineFriendRequest({
    required String token,
    required String userId,
  }) async {
    try {
      final user = await ref
          .read(usersApiProvider)
          .declineFriendRequest(token: token, userId: userId);
      state = state.copyWith(users: {...state.users, user.id: user});
    } catch (error) {
      state = state.copyWith(errorMessage: 'Не удалось отклонить заявку.');
      rethrow;
    }
  }

  Future<SyrnikeServer> createServer({
    required String token,
    required String name,
  }) async {
    final trimmed = name.trim();
    if (trimmed.isEmpty) {
      throw StateError('Введите название сервера');
    }
    final result = await ref
        .read(serversApiProvider)
        .createServer(token: token, name: trimmed);
    _upsertServer(result.server);
    for (final channel in result.channels) {
      _upsertChannel(channel);
    }
    state = state.copyWith(
      selectedServerId: result.server.id,
      selectedChannelId: null,
    );
    return result.server;
  }

  Future<SyrnikeServer?> joinServerInvite({
    required String token,
    required String invite,
  }) async {
    final result = await ref
        .read(serversApiProvider)
        .joinInvite(token: token, input: invite);
    if (result == null) return null;

    _upsertServer(result.server);
    for (final channel in result.channels) {
      _upsertChannel(channel);
    }
    state = state.copyWith(
      selectedServerId: result.server.id,
      selectedChannelId: null,
    );
    return result.server;
  }

  Future<void> sendMessage({
    required String token,
    required String channelId,
    required String content,
  }) async {
    final trimmed = content.trim();
    if (trimmed.isEmpty) return;

    final api = ref.read(messagesApiProvider);
    final message = await api.sendChannelMessage(
      token: token,
      channelId: channelId,
      content: trimmed,
    );
    _upsertMessage(message);
  }

  void upsertCurrentUser(SyrnikeUser user) {
    final existing = state.users[user.id];
    final summary = SyrnikeUserSummary(
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      discriminator: user.discriminator,
      relationship: existing?.relationship,
      avatar: user.avatar,
      statusText: user.statusText,
      online: user.online || existing?.online == true,
      bot: existing?.bot ?? false,
    );
    state = state.copyWith(users: {...state.users, user.id: summary});
  }

  Future<void> _acknowledgeChannel({
    required String channelId,
    required String token,
  }) async {
    final lastMessageId = state.channels[channelId]?.lastMessageId;
    if (lastMessageId == null || state.unreads[channelId] == lastMessageId) {
      return;
    }

    final unreads = {...state.unreads, channelId: lastMessageId};
    state = state.copyWith(unreads: unreads);
    try {
      await ref
          .read(messagesApiProvider)
          .acknowledgeChannel(
            token: token,
            channelId: channelId,
            messageId: lastMessageId,
          );
    } catch (_) {
      // Gateway will reconcile unread state after the next sync.
    }
  }

  Future<SyrnikeVoiceServerCredentials> requestVoiceJoin({
    required String channelId,
    required String node,
    required bool selfMute,
    required bool selfDeaf,
  }) {
    final operationId = 'mobile-${DateTime.now().microsecondsSinceEpoch}';
    final completer = Completer<SyrnikeVoiceServerCredentials>();
    _voiceJoinCompleters[operationId] = completer;
    final nonce = sendVoiceStateUpdate(
      channelId: channelId,
      selfMute: selfMute,
      selfDeaf: selfDeaf,
      operationId: operationId,
      node: node,
      refreshCredentials: true,
    );
    _voiceNonceToOperation[nonce] = operationId;

    return completer.future
        .timeout(
          const Duration(seconds: 15),
          onTimeout: () {
            throw TimeoutException('Не дождались ответа voice сервера.');
          },
        )
        .whenComplete(() {
          _voiceJoinCompleters.remove(operationId);
          _voiceNonceToOperation.remove(nonce);
        });
  }

  String sendVoiceStateUpdate({
    required String? channelId,
    required bool selfMute,
    required bool selfDeaf,
    String? operationId,
    String? node,
    bool suppressCallNotifications = false,
    bool refreshCredentials = false,
  }) {
    final nonce = '${DateTime.now().microsecondsSinceEpoch}';
    final payload = <String, Object?>{
      'type': 'VoiceStateUpdate',
      'nonce': nonce,
      'channel_id': channelId,
      'self_mute': selfMute,
      'self_deaf': selfDeaf,
    };
    if (operationId != null) payload['operation_id'] = operationId;
    if (node != null) payload['node'] = node;
    if (suppressCallNotifications) {
      payload['suppress_call_notifications'] = true;
    }
    if (refreshCredentials) payload['refresh_credentials'] = true;
    _send(payload);
    return nonce;
  }

  void _handleFrame(dynamic frame) {
    if (frame is! String) return;
    final decoded = jsonDecode(frame);
    if (decoded is! Map<String, Object?>) return;
    final type = decoded['type'];

    if (type == 'Ping') {
      _send({'type': 'Pong', 'data': decoded['data']});
      return;
    }
    if (type == 'Pong') return;

    _handleGatewayEvent(decoded);
  }

  void _handleGatewayEvent(Map<String, Object?> event) {
    switch (event['type']) {
      case 'Bulk':
        final items = event['v'];
        if (items is List<dynamic>) {
          for (final item in items.whereType<Map<String, Object?>>()) {
            _handleGatewayEvent(item);
          }
        }
      case 'Ready':
        _applyReady(event);
      case 'Message':
        _upsertMessage(SyrnikeMessage.fromJson(event));
      case 'MessageUpdate':
        final channelId = event['channel'] as String?;
        final messageId = event['id'] as String?;
        final data = event['data'];
        if (channelId != null &&
            messageId != null &&
            data is Map<String, Object?>) {
          _patchMessage(channelId, messageId, data);
        }
      case 'MessageDelete':
        final channelId = event['channel'] as String?;
        final messageId = event['id'] as String?;
        if (channelId != null && messageId != null) {
          _removeMessage(channelId, messageId);
        }
      case 'ChannelCreate':
        _upsertChannel(SyrnikeChannel.fromJson(event));
      case 'ChannelUpdate':
        final channelId = event['id'] as String?;
        final data = event['data'];
        if (channelId != null && data is Map<String, Object?>) {
          final existing = state.channels[channelId];
          if (existing != null) {
            _upsertChannel(
              SyrnikeChannel.fromJson({
                '_id': existing.id,
                'channel_type': existing.type,
                'name': existing.name,
                'server': existing.serverId,
                'description': existing.description,
                'recipients': existing.recipients,
                'last_message_id': existing.lastMessageId,
                'voice': existing.hasVoice ? const {} : null,
                ...data,
              }),
            );
          }
        }
      case 'VoiceChannelJoin':
        final channelId =
            event['channel'] as String? ??
            event['channel_id'] as String? ??
            event['id'] as String?;
        final participant = SyrnikeVoiceParticipant.fromJson(event['state']);
        if (channelId != null && participant.id.isNotEmpty) {
          _addVoiceParticipant(channelId, participant);
        }
      case 'VoiceChannelLeave':
        final channelId =
            event['channel'] as String? ??
            event['channel_id'] as String? ??
            event['id'] as String?;
        final userId = event['user'] as String? ?? event['user_id'] as String?;
        if (channelId != null && userId != null) {
          _removeVoiceParticipant(channelId, userId);
        }
      case 'VoiceChannelMove':
        final userId = event['user'] as String? ?? event['user_id'] as String?;
        final fromChannelId = event['from'] as String?;
        final toChannelId = event['to'] as String?;
        final participant = SyrnikeVoiceParticipant.fromJson(event['state']);
        if (userId != null &&
            fromChannelId != null &&
            toChannelId != null &&
            participant.id.isNotEmpty) {
          _moveVoiceParticipant(
            userId: userId,
            fromChannelId: fromChannelId,
            toChannelId: toChannelId,
            participant: participant,
          );
        }
      case 'VoiceStateUpdate':
        final channelId = event['channel_id'] as String?;
        final participant = SyrnikeVoiceParticipant.fromJson(event['state']);
        if (channelId != null && participant.id.isNotEmpty) {
          _addVoiceParticipant(channelId, participant);
        } else if (participant.id.isNotEmpty) {
          _removeVoiceParticipantFromAll(participant.id);
        }
      case 'VoiceStateAck':
        final ok = event['ok'] as bool? ?? true;
        if (ok) return;
        final nonce = event['nonce'] as String?;
        final operationId = nonce == null
            ? null
            : _voiceNonceToOperation[nonce];
        if (operationId != null) {
          _completeVoiceJoinError(operationId, 'VoiceStateUpdate отклонён.');
        }
      case 'VoiceServerUpdate':
        final credentials = SyrnikeVoiceServerCredentials.fromJson(event);
        if (credentials.isComplete) {
          final completer = _voiceJoinCompleters[credentials.operationId];
          if (completer != null && !completer.isCompleted) {
            completer.complete(credentials);
          }
        }
      case 'Error':
        _handleGatewayError(event);
      case 'ServerCreate':
        final server = event['server'];
        if (server is Map<String, Object?>) {
          _upsertServer(SyrnikeServer.fromJson(server));
        }
        final channels = event['channels'];
        if (channels is List<dynamic>) {
          for (final item in channels.whereType<Map<String, Object?>>()) {
            _upsertChannel(SyrnikeChannel.fromJson(item));
          }
        }
      case 'ServerUpdate':
        final serverId = event['id'] as String?;
        final data = event['data'];
        final existing = serverId == null ? null : state.servers[serverId];
        if (existing != null && data is Map<String, Object?>) {
          _upsertServer(
            SyrnikeServer.fromJson({
              '_id': existing.id,
              'name': existing.name,
              'description': existing.description,
              'channels': existing.channelIds,
              ...data,
            }),
          );
        }
    }
  }

  void _applyReady(Map<String, Object?> event) {
    final servers = {...state.servers};
    for (final item
        in (event['servers'] as List<dynamic>? ?? const [])
            .whereType<Map<String, Object?>>()) {
      final server = SyrnikeServer.fromJson(item);
      servers[server.id] = server;
    }

    final channels = {...state.channels};
    for (final item
        in (event['channels'] as List<dynamic>? ?? const [])
            .whereType<Map<String, Object?>>()) {
      final channel = SyrnikeChannel.fromJson(item);
      channels[channel.id] = channel;
    }

    final users = {...state.users};
    for (final item
        in (event['users'] as List<dynamic>? ?? const [])
            .whereType<Map<String, Object?>>()) {
      final user = SyrnikeUserSummary.fromJson(item);
      users[user.id] = user;
    }

    final unreads = {...state.unreads};
    for (final item
        in (event['channel_unreads'] as List<dynamic>? ?? const [])
            .whereType<Map<String, Object?>>()) {
      final id = item['_id'];
      if (id is Map<String, Object?>) {
        final channelId = id['channel'] as String?;
        if (channelId != null) unreads[channelId] = item['last_id'] as String?;
      }
    }

    state = state.copyWith(
      ready: true,
      gatewayState: GatewayConnectionState.connected,
      servers: servers,
      channels: channels,
      users: users,
      unreads: unreads,
      voiceParticipants: _voiceParticipantsFromReady(event['voice_states']),
      selectedServerId: state.selectedServerId,
      clearError: true,
    );
  }

  void _upsertServer(SyrnikeServer server) {
    state = state.copyWith(servers: {...state.servers, server.id: server});
  }

  void _upsertChannel(SyrnikeChannel channel) {
    state = state.copyWith(channels: {...state.channels, channel.id: channel});
  }

  void _upsertMessage(SyrnikeMessage message) {
    final users = {...state.users};
    if (message.author != null) users[message.author!.id] = message.author!;
    final current = <SyrnikeMessage>[
      ...(state.messages[message.channelId] ?? const <SyrnikeMessage>[]),
    ];
    final index = current.indexWhere((item) => item.id == message.id);
    if (index == -1) {
      current.add(message);
    } else {
      current[index] = message;
    }
    current.sort((a, b) => a.id.compareTo(b.id));
    state = state.copyWith(
      users: users,
      messages: {...state.messages, message.channelId: current},
    );
  }

  void _patchMessage(
    String channelId,
    String messageId,
    Map<String, Object?> data,
  ) {
    final current = <SyrnikeMessage>[
      ...(state.messages[channelId] ?? const <SyrnikeMessage>[]),
    ];
    final index = current.indexWhere((item) => item.id == messageId);
    if (index == -1) return;
    final existing = current[index];
    current[index] = SyrnikeMessage(
      id: existing.id,
      channelId: existing.channelId,
      authorId: existing.authorId,
      content: data['content'] as String? ?? existing.content,
      author: existing.author,
      attachmentsCount: existing.attachmentsCount,
      pinned: data['pinned'] as bool? ?? existing.pinned,
      edited: data['edited'] != null || existing.edited,
    );
    state = state.copyWith(messages: {...state.messages, channelId: current});
  }

  void _removeMessage(String channelId, String messageId) {
    final current = <SyrnikeMessage>[
      ...(state.messages[channelId] ?? const <SyrnikeMessage>[]),
    ]..removeWhere((item) => item.id == messageId);
    state = state.copyWith(messages: {...state.messages, channelId: current});
  }

  Map<String, Map<String, SyrnikeVoiceParticipant>> _voiceParticipantsFromReady(
    Object? raw,
  ) {
    if (raw is! List<dynamic>) return state.voiceParticipants;

    final result = <String, Map<String, SyrnikeVoiceParticipant>>{};
    for (final entry in raw.whereType<Map<String, Object?>>()) {
      final channelId =
          entry['id'] as String? ??
          entry['channel_id'] as String? ??
          entry['channel'] as String?;
      if (channelId == null) continue;

      final rawParticipants =
          entry['participants'] ?? entry['users'] ?? const <Object?>[];
      final participants = <String, SyrnikeVoiceParticipant>{};
      if (rawParticipants is List<dynamic>) {
        for (final rawParticipant in rawParticipants) {
          final participant = SyrnikeVoiceParticipant.fromJson(rawParticipant);
          if (participant.id.isNotEmpty) {
            participants[participant.id] = participant;
          }
        }
      }
      result[channelId] = participants;
    }
    return result;
  }

  void _addVoiceParticipant(
    String channelId,
    SyrnikeVoiceParticipant participant,
  ) {
    final existing = state.voiceParticipants[channelId]?[participant.id];
    if (!_shouldApplyVoiceParticipant(existing, participant)) return;

    final voiceParticipants = _mutableVoiceParticipants();
    for (final entry in voiceParticipants.entries) {
      if (entry.key != channelId) entry.value.remove(participant.id);
    }
    voiceParticipants.removeWhere((_, participants) => participants.isEmpty);
    voiceParticipants[channelId] = {
      ...(voiceParticipants[channelId] ?? const {}),
      participant.id: participant,
    };
    state = state.copyWith(voiceParticipants: voiceParticipants);
  }

  void _removeVoiceParticipant(String channelId, String userId) {
    final channelMap = state.voiceParticipants[channelId];
    if (channelMap == null || !channelMap.containsKey(userId)) return;

    final voiceParticipants = _mutableVoiceParticipants();
    voiceParticipants[channelId]?.remove(userId);
    voiceParticipants.removeWhere((_, participants) => participants.isEmpty);
    state = state.copyWith(voiceParticipants: voiceParticipants);
  }

  void _removeVoiceParticipantFromAll(String userId) {
    var changed = false;
    final voiceParticipants = _mutableVoiceParticipants();
    for (final participants in voiceParticipants.values) {
      changed = participants.remove(userId) != null || changed;
    }
    if (!changed) return;
    voiceParticipants.removeWhere((_, participants) => participants.isEmpty);
    state = state.copyWith(voiceParticipants: voiceParticipants);
  }

  void _moveVoiceParticipant({
    required String userId,
    required String fromChannelId,
    required String toChannelId,
    required SyrnikeVoiceParticipant participant,
  }) {
    final existing =
        state.voiceParticipants[fromChannelId]?[userId] ??
        state.voiceParticipants[toChannelId]?[userId];
    if (!_shouldApplyVoiceParticipant(existing, participant)) return;

    final voiceParticipants = _mutableVoiceParticipants();
    voiceParticipants[fromChannelId]?.remove(userId);
    voiceParticipants[toChannelId] = {
      ...(voiceParticipants[toChannelId] ?? const {}),
      participant.id: participant,
    };
    voiceParticipants.removeWhere((_, participants) => participants.isEmpty);
    state = state.copyWith(voiceParticipants: voiceParticipants);
  }

  Map<String, Map<String, SyrnikeVoiceParticipant>>
  _mutableVoiceParticipants() {
    return {
      for (final entry in state.voiceParticipants.entries)
        entry.key: {...entry.value},
    };
  }

  bool _shouldApplyVoiceParticipant(
    SyrnikeVoiceParticipant? existing,
    SyrnikeVoiceParticipant incoming,
  ) {
    if (existing == null) return true;
    if (incoming.version > existing.version) return true;
    if (incoming.version < existing.version) return false;
    return incoming.joinedAt >= existing.joinedAt;
  }

  void _handleGatewayError(Map<String, Object?> event) {
    if (event['scope'] != 'VoiceStateUpdate') return;
    final request = event['request'];
    final operationId = request is Map<String, Object?>
        ? request['operation_id'] as String?
        : null;
    if (operationId == null) return;
    _completeVoiceJoinError(operationId, _gatewayErrorMessage(event));
  }

  String _gatewayErrorMessage(Map<String, Object?> event) {
    final data = event['data'];
    if (data is Map<String, Object?>) {
      final message = data['message'];
      if (message is String && message.isNotEmpty) return message;
      final type = data['type'];
      if (type is String && type.isNotEmpty) return type;
    }
    return 'Не удалось подключиться к голосовому каналу.';
  }

  void _completeVoiceJoinError(String operationId, String message) {
    final completer = _voiceJoinCompleters[operationId];
    if (completer == null || completer.isCompleted) return;
    completer.completeError(StateError(message));
  }

  void _send(Map<String, Object?> payload) {
    _channel?.sink.add(jsonEncode(payload));
  }

  void _handleDisconnect(String? message) {
    _heartbeat?.cancel();
    _heartbeat = null;
    state = state.copyWith(
      gatewayState: message == null
          ? GatewayConnectionState.reconnecting
          : GatewayConnectionState.error,
      errorMessage: message,
    );
  }

  void _closeSocket() {
    for (final completer in _voiceJoinCompleters.values) {
      if (!completer.isCompleted) {
        completer.completeError(StateError('Gateway отключён.'));
      }
    }
    _voiceJoinCompleters.clear();
    _voiceNonceToOperation.clear();
    _heartbeat?.cancel();
    _heartbeat = null;
    _subscription?.cancel();
    _subscription = null;
    _channel?.sink.close();
    _channel = null;
  }
}
