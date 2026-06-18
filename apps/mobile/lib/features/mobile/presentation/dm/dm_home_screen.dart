part of '../mobile_discord_shell.dart';

class _DmHomeScreen extends ConsumerStatefulWidget {
  const _DmHomeScreen({required this.currentUserId});

  final String currentUserId;

  @override
  ConsumerState<_DmHomeScreen> createState() => _DmHomeScreenState();
}

class _DmHomeScreenState extends ConsumerState<_DmHomeScreen> {
  final _searchController = TextEditingController();
  var _showFriends = false;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final sync = ref.watch(syncControllerProvider);
    final auth = ref.watch(authControllerProvider);
    final token = auth.session?.token;
    final query = _searchController.text.trim().toLowerCase();
    final dmChannels = sync.dmChannels(widget.currentUserId).where((channel) {
      if (query.isEmpty) return true;
      final label = sync.channelLabel(channel, widget.currentUserId);
      final peer = sync.dmPeer(channel, widget.currentUserId);
      return label.toLowerCase().contains(query) ||
          (peer?.username.toLowerCase().contains(query) ?? false);
    }).toList();
    final friends = sync.friends(widget.currentUserId).where((user) {
      if (query.isEmpty) return true;
      return user.effectiveName.toLowerCase().contains(query) ||
          user.username.toLowerCase().contains(query);
    }).toList();

    return Column(
      children: [
        _DmHomeHeader(
          friendsMode: _showFriends,
          onToggleFriends: () {
            setState(() => _showFriends = !_showFriends);
          },
          onNewMessage: token == null ? null : () => _showNewMessage(token),
          onAddFriend: token == null ? null : () => _showAddFriend(token),
        ),
        if (sync.errorMessage != null)
          _InlineBanner(
            icon: Icons.wifi_off_rounded,
            text: sync.errorMessage!,
            destructive: true,
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 6),
          child: TextField(
            controller: _searchController,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              hintText: 'Найти чат или друга',
              prefixIcon: Icon(Icons.search_rounded),
            ),
          ),
        ),
        Expanded(
          child: sync.ready
              ? _showFriends
                    ? _FriendsList(
                        friends: friends,
                        currentUserId: widget.currentUserId,
                        token: token,
                        onAddFriend: token == null
                            ? null
                            : () => _showAddFriend(token),
                      )
                    : _DmConversationList(
                        channels: dmChannels,
                        currentUserId: widget.currentUserId,
                        token: token,
                      )
              : const Center(child: CircularProgressIndicator()),
        ),
        _MobileUserBar(currentUserId: widget.currentUserId),
      ],
    );
  }

  void _showNewMessage(String token) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (_) =>
          _NewMessageSheet(currentUserId: widget.currentUserId, token: token),
    );
  }

  void _showAddFriend(String token) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _AddFriendSheet(token: token),
    );
  }
}

class _DmHomeHeader extends StatelessWidget {
  const _DmHomeHeader({
    required this.friendsMode,
    required this.onToggleFriends,
    required this.onNewMessage,
    required this.onAddFriend,
  });

  final bool friendsMode;
  final VoidCallback onToggleFriends;
  final VoidCallback? onNewMessage;
  final VoidCallback? onAddFriend;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 12),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            friendsMode ? 'Друзья' : 'Сообщения',
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w900,
              letterSpacing: 0,
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              _RoundActionButton(
                tooltip: friendsMode ? 'Сообщения' : 'Друзья',
                icon: friendsMode
                    ? Icons.chat_bubble_rounded
                    : Icons.people_alt_rounded,
                onPressed: onToggleFriends,
              ),
              const SizedBox(width: 10),
              _RoundActionButton(
                tooltip: 'Новое сообщение',
                icon: Icons.mail_rounded,
                onPressed: onNewMessage,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton.icon(
                  onPressed: onAddFriend,
                  icon: const Icon(Icons.person_add_alt_1_rounded),
                  label: const Text('Добавить друзей'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _RoundActionButton extends StatelessWidget {
  const _RoundActionButton({
    required this.tooltip,
    required this.icon,
    required this.onPressed,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Tooltip(
      message: tooltip,
      child: IconButton.filledTonal(
        style: IconButton.styleFrom(
          fixedSize: const Size.square(48),
          backgroundColor: scheme.surfaceContainerHighest,
          foregroundColor: scheme.onSurface,
        ),
        onPressed: onPressed,
        icon: Icon(icon),
      ),
    );
  }
}

class _DmConversationList extends ConsumerWidget {
  const _DmConversationList({
    required this.channels,
    required this.currentUserId,
    required this.token,
  });

  final List<SyrnikeChannel> channels;
  final String currentUserId;
  final String? token;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (channels.isEmpty) {
      return const _EmptyState(
        icon: Icons.chat_bubble_outline_rounded,
        title: 'Личных чатов пока нет',
        subtitle: 'Нажми новое сообщение, чтобы начать диалог с другом.',
      );
    }

    return Stack(
      children: [
        ListView.builder(
          padding: const EdgeInsets.fromLTRB(18, 8, 18, 104),
          itemCount: channels.length + 1,
          itemBuilder: (context, index) {
            if (index == 0) {
              return _DmHighlights(
                channels: channels.take(4).toList(),
                currentUserId: currentUserId,
                token: token,
              );
            }
            final channel = channels[index - 1];
            return _DmConversationTile(
              channel: channel,
              currentUserId: currentUserId,
              token: token,
            );
          },
        ),
        Positioned(
          right: 20,
          bottom: 18,
          child: FloatingActionButton(
            onPressed: token == null
                ? null
                : () {
                    showModalBottomSheet<void>(
                      context: context,
                      isScrollControlled: true,
                      useSafeArea: true,
                      backgroundColor: Colors.transparent,
                      builder: (_) => _NewMessageSheet(
                        currentUserId: currentUserId,
                        token: token!,
                      ),
                    );
                  },
            child: const Icon(Icons.add_comment_rounded),
          ),
        ),
      ],
    );
  }
}

class _DmHighlights extends ConsumerWidget {
  const _DmHighlights({
    required this.channels,
    required this.currentUserId,
    required this.token,
  });

  final List<SyrnikeChannel> channels;
  final String currentUserId;
  final String? token;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (channels.isEmpty) return const SizedBox.shrink();
    final sync = ref.watch(syncControllerProvider);
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      height: 122,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: channels.length,
        separatorBuilder: (_, _) => const SizedBox(width: 12),
        itemBuilder: (context, index) {
          final channel = channels[index];
          final peer = sync.dmPeer(channel, currentUserId);
          final label = sync.channelLabel(channel, currentUserId);
          final preview = _channelPreview(sync, channel);
          return InkWell(
            borderRadius: BorderRadius.circular(18),
            onTap: token == null
                ? null
                : () => ref
                      .read(syncControllerProvider.notifier)
                      .selectChannel(channel.id, token!),
            child: Container(
              width: 260,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: scheme.outlineVariant),
              ),
              child: Row(
                children: [
                  _Avatar(
                    name: peer?.effectiveName ?? label,
                    online: peer?.online ?? false,
                    avatar: peer?.avatar,
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          preview,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.volume_up_rounded),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _DmConversationTile extends ConsumerWidget {
  const _DmConversationTile({
    required this.channel,
    required this.currentUserId,
    required this.token,
  });

  final SyrnikeChannel channel;
  final String currentUserId;
  final String? token;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sync = ref.watch(syncControllerProvider);
    final scheme = Theme.of(context).colorScheme;
    final label = sync.channelLabel(channel, currentUserId);
    final peer = sync.dmPeer(channel, currentUserId);
    final unread = _isUnread(channel, sync);
    final behavior =
        ref.watch(mobileBehaviorControllerProvider).value ??
        const MobileBehaviorSettings();

    final tile = InkWell(
      borderRadius: BorderRadius.circular(18),
      onTap: token == null
          ? null
          : () => ref
                .read(syncControllerProvider.notifier)
                .selectChannel(channel.id, token!),
      child: Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: unread ? scheme.surfaceContainerHighest : Colors.transparent,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Row(
          children: [
            _Avatar(
              name: peer?.effectiveName ?? label,
              online: peer?.online ?? false,
              avatar: peer?.avatar,
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: unread ? FontWeight.w900 : FontWeight.w700,
                      color: unread
                          ? scheme.onSurface
                          : scheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    _channelPreview(sync, channel),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Text(
              unread ? 'новое' : '',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: unread ? scheme.primary : scheme.onSurfaceVariant,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
      ),
    );

    if (!behavior.chatSwipeActions) return tile;

    return Dismissible(
      key: ValueKey('dm-${channel.id}'),
      direction: DismissDirection.horizontal,
      confirmDismiss: (direction) async {
        if (direction == DismissDirection.startToEnd && token != null) {
          await ref
              .read(syncControllerProvider.notifier)
              .selectChannel(channel.id, token!);
        } else if (direction == DismissDirection.endToStart) {
          final ok = await ref
              .read(mobileVoiceControllerProvider.notifier)
              .join(channel.id);
          if (context.mounted && !ok) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(
                  ref.read(mobileVoiceControllerProvider).errorMessage ??
                      'Не удалось начать звонок в $label.',
                ),
              ),
            );
          }
        }
        return false;
      },
      background: _SwipeActionBackground(
        alignment: Alignment.centerLeft,
        icon: Icons.open_in_new_rounded,
        label: 'Открыть',
        color: scheme.primary,
      ),
      secondaryBackground: _SwipeActionBackground(
        alignment: Alignment.centerRight,
        icon: Icons.call_rounded,
        label: 'Позвонить',
        color: Colors.green,
      ),
      child: tile,
    );
  }
}

class _SwipeActionBackground extends StatelessWidget {
  const _SwipeActionBackground({
    required this.alignment,
    required this.icon,
    required this.label,
    required this.color,
  });

  final Alignment alignment;
  final IconData icon;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      alignment: alignment,
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 18),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.22),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (alignment == Alignment.centerRight) Text(label),
          if (alignment == Alignment.centerRight) const SizedBox(width: 8),
          Icon(icon),
          if (alignment == Alignment.centerLeft) const SizedBox(width: 8),
          if (alignment == Alignment.centerLeft) Text(label),
        ],
      ),
    );
  }
}

class _FriendsList extends ConsumerWidget {
  const _FriendsList({
    required this.friends,
    required this.currentUserId,
    required this.token,
    required this.onAddFriend,
  });

  final List<SyrnikeUserSummary> friends;
  final String currentUserId;
  final String? token;
  final VoidCallback? onAddFriend;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (friends.isEmpty) {
      return _EmptyState(
        icon: Icons.people_alt_outlined,
        title: 'Список друзей пуст',
        subtitle: 'Добавь друга по username, чтобы начать переписку.',
        action: FilledButton.icon(
          onPressed: onAddFriend,
          icon: const Icon(Icons.person_add_alt_1_rounded),
          label: const Text('Добавить друга'),
        ),
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(18, 8, 18, 104),
      itemCount: friends.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final user = friends[index];
        return ListTile(
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 4,
            vertical: 8,
          ),
          leading: _Avatar(
            name: user.effectiveName,
            online: user.online,
            avatar: user.avatar,
          ),
          title: Text(
            user.effectiveName,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w800),
          ),
          subtitle: Text(
            '@${user.username}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          trailing: IconButton.filledTonal(
            tooltip: 'Написать',
            onPressed: token == null
                ? null
                : () => ref
                      .read(syncControllerProvider.notifier)
                      .openDirectMessage(token: token!, userId: user.id),
            icon: const Icon(Icons.chat_bubble_rounded),
          ),
        );
      },
    );
  }
}

class _NewMessageSheet extends ConsumerStatefulWidget {
  const _NewMessageSheet({required this.currentUserId, required this.token});

  final String currentUserId;
  final String token;

  @override
  ConsumerState<_NewMessageSheet> createState() => _NewMessageSheetState();
}

class _NewMessageSheetState extends ConsumerState<_NewMessageSheet> {
  final _queryController = TextEditingController();

  @override
  void dispose() {
    _queryController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final sync = ref.watch(syncControllerProvider);
    final query = _queryController.text.trim().toLowerCase();
    final candidates = query.isEmpty
        ? sync.friends(widget.currentUserId, limit: 30)
        : _searchUsers(sync, widget.currentUserId, query);

    return _SheetContainer(
      child: Column(
        children: [
          _SheetTitle(
            title: 'Новое сообщение',
            onClose: () => Navigator.of(context).pop(),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 14),
            child: TextField(
              controller: _queryController,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                hintText: 'Кому: Найдите друзей',
                prefixIcon: Icon(Icons.search_rounded),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(18),
              ),
              child: Column(
                children: [
                  _SheetActionTile(
                    icon: Icons.group_add_rounded,
                    title: 'Новая группа',
                    onTap: () {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text(
                            'Групповые ЛС перенесём следующим этапом.',
                          ),
                        ),
                      );
                    },
                  ),
                  const Divider(height: 1),
                  _SheetActionTile(
                    icon: Icons.person_add_alt_1_rounded,
                    title: 'Добавить друга',
                    onTap: () {
                      Navigator.of(context).pop();
                      showModalBottomSheet<void>(
                        context: context,
                        isScrollControlled: true,
                        useSafeArea: true,
                        backgroundColor: Colors.transparent,
                        builder: (_) => _AddFriendSheet(token: widget.token),
                      );
                    },
                  ),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 20, 18, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                query.isEmpty ? 'Рекомендации' : 'Найдено',
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
          ),
          Expanded(
            child: candidates.isEmpty
                ? const _EmptyState(
                    icon: Icons.search_off_rounded,
                    title: 'Никого не нашли',
                    subtitle: 'Попробуй username или добавь друга.',
                  )
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(18, 0, 18, 24),
                    itemCount: candidates.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final user = candidates[index];
                      return ListTile(
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 4,
                          vertical: 8,
                        ),
                        leading: _Avatar(
                          name: user.effectiveName,
                          online: user.online,
                          avatar: user.avatar,
                        ),
                        title: Text(
                          user.effectiveName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                        subtitle: Text(
                          '@${user.username}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        onTap: () async {
                          await ref
                              .read(syncControllerProvider.notifier)
                              .openDirectMessage(
                                token: widget.token,
                                userId: user.id,
                              );
                          if (context.mounted) Navigator.of(context).pop();
                        },
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

List<SyrnikeUserSummary> _searchUsers(
  SyncSnapshot sync,
  String currentUserId,
  String query,
) {
  final result = <SyrnikeUserSummary>[];
  for (final user in sync.users.values) {
    if (user.id == currentUserId || user.bot) continue;
    if (!user.effectiveName.toLowerCase().contains(query) &&
        !user.username.toLowerCase().contains(query)) {
      continue;
    }
    result.add(user);
    if (result.length >= 40) break;
  }
  return result..sort(
    (a, b) =>
        a.effectiveName.toLowerCase().compareTo(b.effectiveName.toLowerCase()),
  );
}

class _AddFriendSheet extends ConsumerStatefulWidget {
  const _AddFriendSheet({required this.token});

  final String token;

  @override
  ConsumerState<_AddFriendSheet> createState() => _AddFriendSheetState();
}

class _AddFriendSheetState extends ConsumerState<_AddFriendSheet> {
  final _usernameController = TextEditingController();
  var _sending = false;

  @override
  void dispose() {
    _usernameController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return _SheetContainer(
      heightFactor: 0.56,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _SheetTitle(
            title: 'Добавить друга',
            onClose: () => Navigator.of(context).pop(),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 0),
            child: Text(
              'Введите username или name#0000. Если пользователь найден, ему уйдёт заявка.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 12),
            child: TextField(
              controller: _usernameController,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _submit(),
              decoration: const InputDecoration(
                hintText: 'username или name#0000',
                prefixIcon: Icon(Icons.alternate_email_rounded),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: FilledButton.icon(
              onPressed: _sending ? null : _submit,
              icon: _sending
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.person_add_alt_1_rounded),
              label: const Text('Отправить заявку'),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _submit() async {
    final username = _usernameController.text.trim();
    if (username.isEmpty || _sending) return;

    setState(() => _sending = true);
    try {
      await ref
          .read(syncControllerProvider.notifier)
          .sendFriendRequest(token: widget.token, username: username);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Заявка для $username отправлена.')),
      );
      Navigator.of(context).pop();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Не удалось отправить заявку.')),
      );
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }
}
