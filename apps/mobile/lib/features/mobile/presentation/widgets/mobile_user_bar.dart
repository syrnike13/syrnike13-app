part of '../mobile_discord_shell.dart';

class _MobileUserBar extends ConsumerWidget {
  const _MobileUserBar({required this.currentUserId});

  final String currentUserId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    final user = auth.user;
    final sync = ref.watch(syncControllerProvider);
    final scheme = Theme.of(context).colorScheme;
    final colors = Theme.of(context).extension<SyrnikeThemeColors>()!;
    final notificationCount =
        sync
            .dmChannels(currentUserId)
            .where((channel) => _isUnread(channel, sync))
            .length +
        sync.users.values
            .where(
              (candidate) =>
                  candidate.id != currentUserId &&
                  candidate.relationship == 'Incoming',
            )
            .length;

    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Material(
        color: colors.muted,
        borderRadius: BorderRadius.circular(26),
        child: InkWell(
          borderRadius: BorderRadius.circular(26),
          onTap: () {
            final controller = ref.read(syncControllerProvider.notifier);
            final token = auth.session?.token;
            _showProfileOverviewSheet(
              context,
              user: user,
              friends: user == null
                  ? const <SyrnikeUserSummary>[]
                  : sync.friends(user.id, limit: 5),
              loadProfile: user == null || token == null
                  ? null
                  : () => ref
                        .read(usersApiProvider)
                        .fetchUserProfile(token: token, userId: user.id),
              onOpenFriends: () {
                controller.selectServer(null);
                controller.selectChannelPanel();
              },
            );
          },
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 8, 8),
            child: Row(
              children: [
                _Avatar(
                  name: user?.effectiveName ?? 'Я',
                  online: true,
                  avatar: user?.avatar,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              user?.effectiveName ?? 'Аккаунт',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                          ),
                          const SizedBox(width: 2),
                          Icon(
                            Icons.keyboard_arrow_down_rounded,
                            size: 18,
                            color: scheme.onSurfaceVariant,
                          ),
                        ],
                      ),
                      Text(
                        'В сети',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                Badge.count(
                  count: notificationCount,
                  isLabelVisible: notificationCount > 0,
                  child: IconButton.filledTonal(
                    tooltip: 'Уведомления',
                    onPressed: () => _showNotificationCenterSheet(
                      context,
                      currentUserId: currentUserId,
                    ),
                    icon: const Icon(Icons.notifications_rounded),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _MiniAvatar extends ConsumerWidget {
  const _MiniAvatar({
    required this.name,
    required this.avatar,
    required this.radius,
  });

  final String name;
  final SyrnikeFileAsset? avatar;
  final double radius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final mediaUrl = ref.watch(appConfigProvider).mediaUrl;
    final imageUrl = avatar?.url(mediaUrl, fallbackTag: 'avatars');
    final initial = name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase();
    return CircleAvatar(
      radius: radius,
      backgroundColor: scheme.secondaryContainer,
      foregroundColor: scheme.onSecondaryContainer,
      backgroundImage: imageUrl == null ? null : NetworkImage(imageUrl),
      child: imageUrl == null
          ? Text(
              initial,
              style: TextStyle(
                fontSize: radius * 0.85,
                fontWeight: FontWeight.w900,
              ),
            )
          : null,
    );
  }
}

class _Avatar extends ConsumerWidget {
  const _Avatar({
    required this.name,
    required this.online,
    this.avatar,
    this.radius = 18,
    this.showStatus = true,
  });

  final String name;
  final bool online;
  final SyrnikeFileAsset? avatar;
  final double radius;
  final bool showStatus;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final behavior =
        ref.watch(mobileBehaviorControllerProvider).value ??
        const MobileBehaviorSettings();
    final scheme = Theme.of(context).colorScheme;
    return Stack(
      clipBehavior: Clip.none,
      children: [
        _MiniAvatar(name: name, avatar: avatar, radius: radius),
        if (showStatus && behavior.showPresenceDots)
          Positioned(
            right: -1,
            bottom: -1,
            child: DecoratedBox(
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: scheme.surface, width: 2),
                color: online ? Colors.green : Colors.grey,
              ),
              child: const SizedBox.square(dimension: 11),
            ),
          ),
      ],
    );
  }
}
