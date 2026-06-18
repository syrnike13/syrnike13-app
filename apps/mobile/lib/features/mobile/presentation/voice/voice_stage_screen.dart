part of '../mobile_discord_shell.dart';

class _VoiceStageScreen extends ConsumerWidget {
  const _VoiceStageScreen({required this.channel, required this.currentUserId});

  final SyrnikeChannel channel;
  final String currentUserId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sync = ref.watch(syncControllerProvider);
    final auth = ref.watch(authControllerProvider);
    final voice = ref.watch(mobileVoiceControllerProvider);
    final voiceController = ref.read(mobileVoiceControllerProvider.notifier);
    final colors = Theme.of(context).extension<SyrnikeThemeColors>()!;
    final label = sync.channelLabel(channel, currentUserId);
    final participants = _voiceParticipantsForChannel(
      sync,
      channel.id,
      voice,
      currentUserId,
    );

    return Column(
      children: [
        Container(
          height: 64,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Row(
            children: [
              IconButton(
                tooltip: 'Свернуть',
                onPressed: voiceController.closeStage,
                icon: const Icon(Icons.keyboard_arrow_down_rounded),
              ),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(
                    context,
                  ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
                ),
              ),
              IconButton(
                tooltip: 'Звук',
                onPressed: voiceController.toggleDeafen,
                icon: Icon(
                  voice.deafened
                      ? Icons.volume_off_rounded
                      : Icons.volume_up_rounded,
                ),
              ),
              IconButton(
                tooltip: 'Добавить людей',
                onPressed: () => _showVoiceInviteHint(context),
                icon: const Icon(Icons.group_add_rounded),
              ),
            ],
          ),
        ),
        if (voice.errorMessage != null)
          _InlineBanner(
            icon: Icons.warning_amber_rounded,
            text: voice.errorMessage!,
            destructive: true,
          ),
        _MicrophonePublishStatus(voice: voice),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 18),
            children: [
              if (participants.isEmpty)
                SizedBox(
                  height: 360,
                  child: _EmptyState(
                    icon: Icons.graphic_eq_rounded,
                    title: voice.joining ? 'Подключаемся' : 'В голосе пусто',
                    subtitle: voice.joining
                        ? 'Запрашиваем разрешения и отправляем voice state.'
                        : 'Нажми на канал ещё раз, чтобы зайти.',
                  ),
                )
              else
                _VoiceStageGrid(
                  participants: participants,
                  currentUserId: currentUserId,
                  currentUserName: auth.user?.effectiveName ?? 'Вы',
                  currentUserAvatar: auth.user?.avatar,
                  speakingUserIds: voice.speakingUserIds,
                ),
              const SizedBox(height: 18),
              _VoiceInviteCard(onTap: () => _showVoiceInviteHint(context)),
            ],
          ),
        ),
        Container(
          margin: EdgeInsets.fromLTRB(
            16,
            0,
            16,
            12 + MediaQuery.paddingOf(context).bottom,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: colors.muted,
            borderRadius: BorderRadius.circular(28),
            border: Border.all(color: colors.border),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              _VoiceControlButton(
                tooltip: voice.cameraEnabled ? 'Выключить камеру' : 'Камера',
                active: voice.cameraEnabled,
                icon: voice.cameraEnabled
                    ? Icons.videocam_rounded
                    : Icons.videocam_off_rounded,
                onPressed: voiceController.toggleCamera,
              ),
              _VoiceControlButton(
                tooltip: voice.muted ? 'Включить микрофон' : 'Микрофон',
                active: !voice.muted,
                icon: voice.muted ? Icons.mic_off_rounded : Icons.mic_rounded,
                onPressed: voiceController.toggleMute,
              ),
              _VoiceControlButton(
                tooltip: 'Чат канала',
                icon: Icons.chat_bubble_rounded,
                onPressed: () {
                  voiceController.closeStage();
                  ref
                      .read(syncControllerProvider.notifier)
                      .selectChannelPanel();
                },
              ),
              _VoiceControlButton(
                tooltip: voice.deafened ? 'Включить звук' : 'Заглушить звук',
                active: !voice.deafened,
                icon: voice.deafened
                    ? Icons.headset_off_rounded
                    : Icons.headphones_rounded,
                onPressed: voiceController.toggleDeafen,
              ),
              _VoiceControlButton(
                tooltip: 'Отключиться',
                destructive: true,
                icon: Icons.call_end_rounded,
                onPressed: voiceController.leave,
              ),
            ],
          ),
        ),
      ],
    );
  }

  void _showVoiceInviteHint(BuildContext context) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Приглашения в голосовой чат перенесём следующим шагом.'),
      ),
    );
  }
}

class _MicrophonePublishStatus extends StatelessWidget {
  const _MicrophonePublishStatus({required this.voice});

  final MobileVoiceState voice;

  @override
  Widget build(BuildContext context) {
    if (voice.joining || !voice.connected) return const SizedBox.shrink();

    final hasSignal = voice.microphoneLevel > 0.02;
    final healthy = voice.muted || voice.microphonePublished;
    final text = voice.muted
        ? 'Микрофон выключен'
        : voice.microphoneIssue != null
        ? voice.microphoneIssue!
        : hasSignal
        ? 'Ваш голос отправляется участникам'
        : voice.microphonePublished
        ? 'Микрофон подключён — скажите что-нибудь'
        : 'Микрофон не отправляется в звонок';

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 4),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: healthy
                ? Theme.of(context).colorScheme.outlineVariant
                : Theme.of(context).colorScheme.error,
          ),
        ),
        child: Row(
          children: [
            Icon(
              voice.muted
                  ? Icons.mic_off_rounded
                  : hasSignal
                  ? Icons.graphic_eq_rounded
                  : Icons.mic_rounded,
              color: !healthy
                  ? Theme.of(context).colorScheme.error
                  : hasSignal
                  ? Colors.greenAccent.shade400
                  : Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    text,
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                  if (!voice.muted && voice.microphonePublished) ...[
                    const SizedBox(height: 6),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(999),
                      child: LinearProgressIndicator(
                        value: voice.microphoneLevel,
                        minHeight: 6,
                        backgroundColor: Theme.of(
                          context,
                        ).colorScheme.surfaceContainerHighest,
                        color: Colors.greenAccent.shade400,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _VoiceStageGrid extends ConsumerWidget {
  const _VoiceStageGrid({
    required this.participants,
    required this.currentUserId,
    required this.currentUserName,
    required this.currentUserAvatar,
    required this.speakingUserIds,
  });

  final List<SyrnikeVoiceParticipant> participants;
  final String currentUserId;
  final String currentUserName;
  final SyrnikeFileAsset? currentUserAvatar;
  final Set<String> speakingUserIds;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sync = ref.watch(syncControllerProvider);
    return LayoutBuilder(
      builder: (context, constraints) {
        final single = participants.length == 1;
        final tileWidth = single
            ? constraints.maxWidth
            : (constraints.maxWidth - 12) / 2;
        return Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            for (final participant in participants)
              _VoiceStageGridItem(
                participant: participant,
                tileWidth: tileWidth,
                height: single ? 360 : 190,
                currentUserId: currentUserId,
                currentUserName: currentUserName,
                currentUserAvatar: currentUserAvatar,
                sync: sync,
                speaking: speakingUserIds.contains(participant.id),
              ),
          ],
        );
      },
    );
  }
}

class _VoiceStageGridItem extends StatelessWidget {
  const _VoiceStageGridItem({
    required this.participant,
    required this.tileWidth,
    required this.height,
    required this.currentUserId,
    required this.currentUserName,
    required this.currentUserAvatar,
    required this.sync,
    required this.speaking,
  });

  final SyrnikeVoiceParticipant participant;
  final double tileWidth;
  final double height;
  final String currentUserId;
  final String currentUserName;
  final SyrnikeFileAsset? currentUserAvatar;
  final SyncSnapshot sync;
  final bool speaking;

  @override
  Widget build(BuildContext context) {
    final user = sync.users[participant.id];
    final local = participant.id == currentUserId;
    return SizedBox(
      width: tileWidth,
      height: height,
      child: _VoiceStageParticipantTile(
        participant: participant,
        name: user?.effectiveName ?? (local ? currentUserName : 'Участник'),
        avatar: user?.avatar ?? (local ? currentUserAvatar : null),
        local: local,
        speaking: speaking,
      ),
    );
  }
}

class _VoiceStageParticipantTile extends StatelessWidget {
  const _VoiceStageParticipantTile({
    required this.participant,
    required this.name,
    required this.avatar,
    required this.local,
    required this.speaking,
  });

  final SyrnikeVoiceParticipant participant;
  final String name;
  final SyrnikeFileAsset? avatar;
  final bool local;
  final bool speaking;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0xFFAE7E45),
        borderRadius: BorderRadius.circular(24),
        border: Border.all(
          color: speaking ? Colors.green.shade400 : scheme.outlineVariant,
          width: speaking ? 3 : 1,
        ),
      ),
      child: Stack(
        children: [
          Center(
            child: _Avatar(
              name: name,
              online: true,
              avatar: avatar,
              radius: 42,
              showStatus: false,
            ),
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: Container(
              margin: const EdgeInsets.only(bottom: 12),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.42),
                borderRadius: BorderRadius.circular(18),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  if (participant.muted) ...[
                    const SizedBox(width: 6),
                    const Icon(
                      Icons.mic_off_rounded,
                      size: 14,
                      color: Colors.white,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _VoiceInviteCard extends StatelessWidget {
  const _VoiceInviteCard({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      borderRadius: BorderRadius.circular(18),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: scheme.outlineVariant),
        ),
        child: Row(
          children: [
            const Icon(Icons.group_add_rounded, size: 28),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Добавить людей в голосовой чат',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Дайте группе знать, что вы здесь!',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded),
          ],
        ),
      ),
    );
  }
}

class _VoiceControlButton extends StatelessWidget {
  const _VoiceControlButton({
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    this.active = false,
    this.destructive = false,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback onPressed;
  final bool active;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final background = destructive
        ? Colors.red.shade600
        : active
        ? scheme.primary
        : scheme.surfaceContainerHighest;
    final foreground = destructive || active
        ? Colors.white
        : scheme.onSurfaceVariant;

    return Tooltip(
      message: tooltip,
      child: IconButton.filled(
        style: IconButton.styleFrom(
          backgroundColor: background,
          foregroundColor: foreground,
          fixedSize: const Size.square(50),
        ),
        onPressed: onPressed,
        icon: Icon(icon),
      ),
    );
  }
}
