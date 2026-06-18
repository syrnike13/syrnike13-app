part of '../mobile_discord_shell.dart';

class _DirectoryHeader extends StatelessWidget {
  const _DirectoryHeader({required this.title, this.subtitle, this.onSearch});

  final String title;
  final String? subtitle;
  final VoidCallback? onSearch;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 64,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(
            color: Theme.of(context).colorScheme.outlineVariant,
          ),
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                if (subtitle?.trim().isNotEmpty == true)
                  Text(
                    subtitle!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
          IconButton(
            tooltip: onSearch == null ? 'Поиск доступен на сервере' : 'Поиск',
            onPressed: onSearch,
            icon: const Icon(Icons.search_rounded),
          ),
        ],
      ),
    );
  }
}

class _ChannelSectionHeader extends StatelessWidget {
  const _ChannelSectionHeader({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 10, 8, 6),
      child: Row(
        children: [
          Icon(
            Icons.keyboard_arrow_down_rounded,
            size: 18,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: 4),
          Expanded(
            child: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelLarge?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ChannelTile extends StatelessWidget {
  const _ChannelTile({
    required this.title,
    required this.icon,
    required this.unread,
    required this.onTap,
    this.subtitle,
  });

  final String title;
  final String? subtitle;
  final IconData icon;
  final bool unread;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: ListTile(
        minLeadingWidth: 24,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        leading: Icon(icon, size: 20),
        title: Text(
          title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontWeight: unread ? FontWeight.w800 : FontWeight.w600,
          ),
        ),
        subtitle: subtitle?.trim().isNotEmpty == true
            ? Text(subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis)
            : null,
        trailing: unread
            ? Icon(Icons.circle, size: 10, color: scheme.primary)
            : null,
        onTap: onTap,
      ),
    );
  }
}

class _VoiceChannelTile extends StatelessWidget {
  const _VoiceChannelTile({
    required this.channel,
    required this.title,
    required this.participants,
    required this.currentUserId,
    required this.active,
    required this.joining,
    required this.onTap,
  });

  final SyrnikeChannel channel;
  final String title;
  final List<SyrnikeVoiceParticipant> participants;
  final String currentUserId;
  final bool active;
  final bool joining;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final activeColor = Colors.green.shade400;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            minLeadingWidth: 24,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(8),
            ),
            tileColor: active
                ? scheme.surfaceContainerHighest.withValues(alpha: 0.72)
                : null,
            leading: Icon(
              channel.hasVoice ? Icons.volume_up_rounded : Icons.lock_rounded,
              size: 22,
              color: active ? activeColor : scheme.onSurfaceVariant,
            ),
            title: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: active ? activeColor : scheme.onSurfaceVariant,
                fontWeight: active ? FontWeight.w900 : FontWeight.w700,
              ),
            ),
            subtitle: participants.isEmpty
                ? null
                : Text(
                    '${participants.length} в голосе',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
            trailing: joining
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : active
                ? Icon(Icons.graphic_eq_rounded, color: activeColor, size: 18)
                : null,
            onTap: onTap,
          ),
          for (final participant in participants)
            _VoiceParticipantRow(
              participant: participant,
              currentUserId: currentUserId,
            ),
        ],
      ),
    );
  }
}

class _VoiceParticipantRow extends ConsumerWidget {
  const _VoiceParticipantRow({
    required this.participant,
    required this.currentUserId,
  });

  final SyrnikeVoiceParticipant participant;
  final String currentUserId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sync = ref.watch(syncControllerProvider);
    final auth = ref.watch(authControllerProvider);
    final scheme = Theme.of(context).colorScheme;
    final participantUser = sync.users[participant.id];
    final name =
        participantUser?.effectiveName ??
        (participant.id == currentUserId
            ? auth.user?.effectiveName ?? 'Вы'
            : 'Участник');
    return Padding(
      padding: const EdgeInsets.only(left: 46, right: 8, bottom: 6),
      child: Row(
        children: [
          _Avatar(
            name: name,
            online: true,
            avatar:
                participantUser?.avatar ??
                (participant.id == currentUserId ? auth.user?.avatar : null),
            radius: 13,
            showStatus: false,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              participant.id == currentUserId ? '$name (вы)' : name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: scheme.onSurfaceVariant,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          if (participant.camera)
            Icon(Icons.videocam_rounded, size: 15, color: scheme.primary),
          if (participant.muted)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: Icon(
                Icons.mic_off_rounded,
                size: 15,
                color: scheme.onSurfaceVariant,
              ),
            ),
          if (participant.deafened)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: Icon(
                Icons.headset_off_rounded,
                size: 15,
                color: scheme.onSurfaceVariant,
              ),
            ),
        ],
      ),
    );
  }
}
