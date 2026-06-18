part of '../mobile_discord_shell.dart';

void _showNotificationCenterSheet(
  BuildContext context, {
  required String currentUserId,
}) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _NotificationCenterSheet(currentUserId: currentUserId),
  );
}

class _NotificationCenterSheet extends ConsumerStatefulWidget {
  const _NotificationCenterSheet({required this.currentUserId});

  final String currentUserId;

  @override
  ConsumerState<_NotificationCenterSheet> createState() =>
      _NotificationCenterSheetState();
}

class _NotificationCenterSheetState
    extends ConsumerState<_NotificationCenterSheet> {
  final Set<String> _busyRequests = {};

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final sync = ref.watch(syncControllerProvider);
    final token = auth.session?.token;
    final unreadDms = sync
        .dmChannels(widget.currentUserId)
        .where((channel) => _isUnread(channel, sync))
        .toList();
    final incomingRequests =
        sync.users.values
            .where(
              (user) =>
                  user.id != widget.currentUserId &&
                  user.relationship == 'Incoming',
            )
            .toList()
          ..sort(
            (a, b) => a.effectiveName.toLowerCase().compareTo(
              b.effectiveName.toLowerCase(),
            ),
          );

    return DefaultTabController(
      length: 4,
      child: _SheetContainer(
        heightFactor: 0.92,
        child: Column(
          children: [
            _NotificationHeader(
              onClose: () => Navigator.of(context).pop(),
              onSettings: () {
                final navigator = Navigator.of(context);
                navigator.pop();
                Future<void>.delayed(const Duration(milliseconds: 180), () {
                  if (!navigator.mounted) return;
                  _showBehaviorSettingsSheet(navigator.context);
                });
              },
            ),
            TabBar(
              isScrollable: true,
              tabAlignment: TabAlignment.start,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              tabs: [
                _NotificationTab(
                  text: 'Все',
                  count: unreadDms.length + incomingRequests.length,
                ),
                _NotificationTab(text: 'Личные', count: unreadDms.length),
                _NotificationTab(
                  text: 'Заявки',
                  count: incomingRequests.length,
                ),
                const _NotificationTab(text: 'Обновления'),
              ],
            ),
            const Divider(height: 1),
            Expanded(
              child: TabBarView(
                children: [
                  _NotificationAllView(
                    unreadDms: unreadDms,
                    incomingRequests: incomingRequests,
                    sync: sync,
                    currentUserId: widget.currentUserId,
                    onOpenDm: token == null
                        ? null
                        : (channel) => _openDm(channel, token),
                    requestBuilder: (user) => _buildRequestTile(user, token),
                  ),
                  _NotificationDmList(
                    channels: unreadDms,
                    sync: sync,
                    currentUserId: widget.currentUserId,
                    onOpen: token == null
                        ? null
                        : (channel) => _openDm(channel, token),
                  ),
                  _NotificationRequestList(
                    users: incomingRequests,
                    itemBuilder: (user) => _buildRequestTile(user, token),
                  ),
                  const _NotificationEmpty(
                    icon: Icons.system_update_alt_rounded,
                    title: 'Обновлений пока нет',
                    subtitle:
                        'Здесь появятся важные изменения приложения и сервиса.',
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRequestTile(SyrnikeUserSummary user, String? token) {
    final busy = _busyRequests.contains(user.id);
    return _NotificationRequestTile(
      user: user,
      busy: busy,
      onAccept: token == null || busy
          ? null
          : () => _runRequestAction(
              user.id,
              () => ref
                  .read(syncControllerProvider.notifier)
                  .acceptFriendRequest(token: token, userId: user.id),
            ),
      onDecline: token == null || busy
          ? null
          : () => _runRequestAction(
              user.id,
              () => ref
                  .read(syncControllerProvider.notifier)
                  .declineFriendRequest(token: token, userId: user.id),
            ),
    );
  }

  Future<void> _openDm(SyrnikeChannel channel, String token) async {
    Navigator.of(context).pop();
    final controller = ref.read(syncControllerProvider.notifier);
    controller.selectServer(null);
    await controller.selectChannel(channel.id, token);
  }

  Future<void> _runRequestAction(
    String userId,
    Future<void> Function() action,
  ) async {
    setState(() => _busyRequests.add(userId));
    try {
      await action();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Не удалось обработать заявку.')),
      );
    } finally {
      if (mounted) setState(() => _busyRequests.remove(userId));
    }
  }
}

class _NotificationHeader extends StatelessWidget {
  const _NotificationHeader({required this.onClose, required this.onSettings});

  final VoidCallback onClose;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 14, 8, 8),
      child: Row(
        children: [
          IconButton(
            tooltip: 'Закрыть',
            onPressed: onClose,
            icon: const Icon(Icons.close_rounded),
          ),
          Expanded(
            child: Text(
              'Уведомления',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.w900,
                letterSpacing: 0,
              ),
            ),
          ),
          IconButton(
            tooltip: 'Настройки уведомлений',
            onPressed: onSettings,
            icon: const Icon(Icons.tune_rounded),
          ),
        ],
      ),
    );
  }
}

class _NotificationTab extends StatelessWidget {
  const _NotificationTab({required this.text, this.count = 0});

  final String text;
  final int count;

  @override
  Widget build(BuildContext context) {
    return Tab(
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(text),
          if (count > 0) ...[
            const SizedBox(width: 6),
            Badge.count(count: count),
          ],
        ],
      ),
    );
  }
}

class _NotificationAllView extends StatelessWidget {
  const _NotificationAllView({
    required this.unreadDms,
    required this.incomingRequests,
    required this.sync,
    required this.currentUserId,
    required this.onOpenDm,
    required this.requestBuilder,
  });

  final List<SyrnikeChannel> unreadDms;
  final List<SyrnikeUserSummary> incomingRequests;
  final SyncSnapshot sync;
  final String currentUserId;
  final ValueChanged<SyrnikeChannel>? onOpenDm;
  final Widget Function(SyrnikeUserSummary user) requestBuilder;

  @override
  Widget build(BuildContext context) {
    if (unreadDms.isEmpty && incomingRequests.isEmpty) {
      return const _NotificationEmpty(
        icon: Icons.notifications_none_rounded,
        title: 'Всё прочитано',
        subtitle: 'Новые сообщения и заявки появятся здесь.',
      );
    }

    return ListView(
      padding: EdgeInsets.fromLTRB(
        18,
        14,
        18,
        24 + MediaQuery.paddingOf(context).bottom,
      ),
      children: [
        if (unreadDms.isNotEmpty) ...[
          const _NotificationSectionTitle('Личные сообщения'),
          for (final channel in unreadDms)
            _NotificationDmTile(
              channel: channel,
              sync: sync,
              currentUserId: currentUserId,
              onTap: onOpenDm == null ? null : () => onOpenDm!(channel),
            ),
        ],
        if (incomingRequests.isNotEmpty) ...[
          if (unreadDms.isNotEmpty) const SizedBox(height: 18),
          const _NotificationSectionTitle('Заявки в друзья'),
          for (final user in incomingRequests) requestBuilder(user),
        ],
      ],
    );
  }
}

class _NotificationDmList extends StatelessWidget {
  const _NotificationDmList({
    required this.channels,
    required this.sync,
    required this.currentUserId,
    required this.onOpen,
  });

  final List<SyrnikeChannel> channels;
  final SyncSnapshot sync;
  final String currentUserId;
  final ValueChanged<SyrnikeChannel>? onOpen;

  @override
  Widget build(BuildContext context) {
    if (channels.isEmpty) {
      return const _NotificationEmpty(
        icon: Icons.mark_chat_read_outlined,
        title: 'Нет непрочитанных сообщений',
        subtitle: 'Новые личные сообщения появятся в этой вкладке.',
      );
    }
    return ListView(
      padding: EdgeInsets.fromLTRB(
        18,
        14,
        18,
        24 + MediaQuery.paddingOf(context).bottom,
      ),
      children: [
        for (final channel in channels)
          _NotificationDmTile(
            channel: channel,
            sync: sync,
            currentUserId: currentUserId,
            onTap: onOpen == null ? null : () => onOpen!(channel),
          ),
      ],
    );
  }
}

class _NotificationDmTile extends StatelessWidget {
  const _NotificationDmTile({
    required this.channel,
    required this.sync,
    required this.currentUserId,
    required this.onTap,
  });

  final SyrnikeChannel channel;
  final SyncSnapshot sync;
  final String currentUserId;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final peer = sync.dmPeer(channel, currentUserId);
    final label = sync.channelLabel(channel, currentUserId);
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        leading: _Avatar(
          name: peer?.effectiveName ?? label,
          online: peer?.online ?? false,
          avatar: peer?.avatar,
        ),
        title: Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontWeight: FontWeight.w900),
        ),
        subtitle: Text(
          _channelPreview(sync, channel),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: const Icon(Icons.chevron_right_rounded),
        onTap: onTap,
      ),
    );
  }
}

class _NotificationRequestList extends StatelessWidget {
  const _NotificationRequestList({
    required this.users,
    required this.itemBuilder,
  });

  final List<SyrnikeUserSummary> users;
  final Widget Function(SyrnikeUserSummary user) itemBuilder;

  @override
  Widget build(BuildContext context) {
    if (users.isEmpty) {
      return const _NotificationEmpty(
        icon: Icons.person_add_disabled_rounded,
        title: 'Нет новых заявок',
        subtitle: 'Входящие заявки в друзья появятся здесь.',
      );
    }
    return ListView(
      padding: EdgeInsets.fromLTRB(
        18,
        14,
        18,
        24 + MediaQuery.paddingOf(context).bottom,
      ),
      children: [for (final user in users) itemBuilder(user)],
    );
  }
}

class _NotificationRequestTile extends StatelessWidget {
  const _NotificationRequestTile({
    required this.user,
    required this.busy,
    required this.onAccept,
    required this.onDecline,
  });

  final SyrnikeUserSummary user;
  final bool busy;
  final VoidCallback? onAccept;
  final VoidCallback? onDecline;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
        child: Row(
          children: [
            _Avatar(
              name: user.effectiveName,
              online: user.online,
              avatar: user.avatar,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    user.effectiveName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w900),
                  ),
                  Text(
                    'Хочет добавить вас в друзья',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            if (busy)
              const Padding(
                padding: EdgeInsets.all(12),
                child: SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              )
            else ...[
              IconButton.filled(
                tooltip: 'Принять',
                onPressed: onAccept,
                icon: const Icon(Icons.check_rounded),
              ),
              const SizedBox(width: 6),
              IconButton.filledTonal(
                tooltip: 'Отклонить',
                onPressed: onDecline,
                icon: const Icon(Icons.close_rounded),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _NotificationSectionTitle extends StatelessWidget {
  const _NotificationSectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 2, 4, 8),
      child: Text(
        text,
        style: Theme.of(
          context,
        ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w900),
      ),
    );
  }
}

class _NotificationEmpty extends StatelessWidget {
  const _NotificationEmpty({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 52, color: scheme.primary),
            const SizedBox(height: 16),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
            ),
            const SizedBox(height: 8),
            Text(
              subtitle,
              textAlign: TextAlign.center,
              style: TextStyle(color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
