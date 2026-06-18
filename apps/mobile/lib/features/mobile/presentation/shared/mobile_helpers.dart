part of '../mobile_discord_shell.dart';

bool _isUnread(SyrnikeChannel channel, SyncSnapshot sync) {
  final lastMessageId = channel.lastMessageId;
  if (lastMessageId == null) return false;
  final lastReadId = sync.unreads[channel.id];
  if (lastReadId == null) return true;
  return lastReadId.compareTo(lastMessageId) < 0;
}

String _channelPreview(SyncSnapshot sync, SyrnikeChannel channel) {
  final messages = sync.channelMessages(channel.id);
  if (messages.isEmpty) {
    if (channel.type == 'SavedMessages') {
      return 'Заметки и сохранённые сообщения';
    }
    return channel.description?.trim().isNotEmpty == true
        ? channel.description!.trim()
        : 'Открыть переписку';
  }

  final last = messages.last;
  if (last.hasText) {
    final author = last.author ?? sync.users[last.authorId];
    final prefix = author == null ? '' : '${author.effectiveName}: ';
    return '$prefix${last.content!.trim()}';
  }
  if (last.attachmentsCount > 0) return '${last.attachmentsCount} файл';
  return 'Новое сообщение';
}

List<SyrnikeVoiceParticipant> _voiceParticipantsForChannel(
  SyncSnapshot sync,
  String channelId,
  MobileVoiceState voice,
  String currentUserId,
) {
  final participants = sync.voiceUsers(channelId);
  if (voice.channelId != channelId) return participants;

  final localIndex = participants.indexWhere(
    (item) => item.id == currentUserId,
  );
  if (localIndex == -1) {
    return [
      ...participants,
      SyrnikeVoiceParticipant(
        id: currentUserId,
        joinedAt: DateTime.now().millisecondsSinceEpoch,
        selfMute: voice.muted,
        selfDeaf: voice.deafened,
        camera: voice.cameraEnabled,
      ),
    ];
  }

  final next = [...participants];
  next[localIndex] = next[localIndex].copyWith(
    selfMute: voice.muted,
    selfDeaf: voice.deafened,
    camera: voice.cameraEnabled,
  );
  return next;
}
