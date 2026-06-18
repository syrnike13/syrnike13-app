part of '../mobile_discord_shell.dart';

class _ChatScreen extends ConsumerStatefulWidget {
  const _ChatScreen({
    required this.channel,
    required this.currentUserId,
    required this.token,
  });

  final SyrnikeChannel channel;
  final String currentUserId;
  final String token;

  @override
  ConsumerState<_ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<_ChatScreen> {
  final _composer = TextEditingController();
  final _searchController = TextEditingController();
  var _sending = false;
  var _searching = false;

  @override
  void dispose() {
    _composer.dispose();
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final sync = ref.watch(syncControllerProvider);
    final label = sync.channelLabel(widget.channel, widget.currentUserId);
    final allMessages = sync.channelMessages(widget.channel.id);
    final searchQuery = _searchController.text.trim().toLowerCase();
    final messages = searchQuery.isEmpty
        ? allMessages
        : allMessages.where((message) {
            final author = message.author ?? sync.users[message.authorId];
            return (message.content?.toLowerCase().contains(searchQuery) ??
                    false) ||
                (author?.effectiveName.toLowerCase().contains(searchQuery) ??
                    false);
          }).toList();

    return Column(
      children: [
        Container(
          height: 64,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(
                color: Theme.of(context).colorScheme.outlineVariant,
              ),
            ),
          ),
          child: Row(
            children: [
              IconButton(
                tooltip: 'Назад',
                onPressed: () {
                  ref
                      .read(syncControllerProvider.notifier)
                      .selectChannelPanel();
                },
                icon: const Icon(Icons.arrow_back_rounded),
              ),
              Icon(
                widget.channel.isDmLike
                    ? Icons.person_rounded
                    : Icons.tag_rounded,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Поиск',
                onPressed: () {
                  setState(() {
                    _searching = !_searching;
                    if (!_searching) _searchController.clear();
                  });
                },
                icon: Icon(
                  _searching ? Icons.close_rounded : Icons.search_rounded,
                ),
              ),
              IconButton(
                tooltip: 'Голос',
                onPressed: () async {
                  if (!widget.channel.isDmLike && !widget.channel.hasVoice) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Откройте голосовой канал сервера.'),
                      ),
                    );
                    return;
                  }
                  final ok = await ref
                      .read(mobileVoiceControllerProvider.notifier)
                      .join(widget.channel.id);
                  if (!context.mounted || ok) return;
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        ref.read(mobileVoiceControllerProvider).errorMessage ??
                            'Не удалось начать звонок в $label.',
                      ),
                    ),
                  );
                },
                icon: const Icon(Icons.call_rounded),
              ),
            ],
          ),
        ),
        if (_searching)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 2),
            child: TextField(
              controller: _searchController,
              autofocus: true,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                hintText: 'Поиск по диалогу',
                prefixIcon: Icon(Icons.search_rounded),
              ),
            ),
          ),
        if (widget.channel.description?.trim().isNotEmpty == true)
          _InlineBanner(
            icon: Icons.info_outline_rounded,
            text: widget.channel.description!,
            destructive: false,
          ),
        Expanded(
          child: messages.isEmpty
              ? _EmptyState(
                  icon: Icons.chat_bubble_outline_rounded,
                  title: searchQuery.isEmpty
                      ? 'Пока нет сообщений'
                      : 'Ничего не найдено',
                  subtitle: searchQuery.isEmpty
                      ? 'Напиши первым в #$label.'
                      : 'Попробуй другой запрос.',
                )
              : ListView.builder(
                  reverse: true,
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
                  itemCount: messages.length,
                  itemBuilder: (context, index) {
                    final message = messages[messages.length - index - 1];
                    final author =
                        message.author ??
                        sync.users[message.authorId] ??
                        SyrnikeUserSummary(
                          id: message.authorId,
                          username: 'unknown',
                        );
                    return _MessageBubble(
                      author: author,
                      message: message,
                      own: author.id == widget.currentUserId,
                    );
                  },
                ),
        ),
        _ComposerBar(
          controller: _composer,
          sending: _sending,
          hint: 'Сообщение в $label',
          onSend: _send,
        ),
      ],
    );
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await ref
          .read(syncControllerProvider.notifier)
          .sendMessage(
            token: widget.token,
            channelId: widget.channel.id,
            content: text,
          );
      _composer.clear();
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    required this.author,
    required this.message,
    required this.own,
  });

  final SyrnikeUserSummary author;
  final SyrnikeMessage message;
  final bool own;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: own
            ? MainAxisAlignment.end
            : MainAxisAlignment.start,
        children: [
          if (!own)
            _Avatar(
              name: author.effectiveName,
              online: author.online,
              avatar: author.avatar,
            ),
          if (!own) const SizedBox(width: 10),
          Flexible(
            child: Column(
              crossAxisAlignment: own
                  ? CrossAxisAlignment.end
                  : CrossAxisAlignment.start,
              children: [
                Text(
                  author.effectiveName,
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: scheme.onSurfaceVariant,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 3),
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: own
                        ? scheme.primaryContainer
                        : scheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: scheme.outlineVariant),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 9,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (message.hasText) Text(message.content!),
                        if (message.attachmentsCount > 0) ...[
                          if (message.hasText) const SizedBox(height: 8),
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(Icons.attach_file_rounded, size: 16),
                              const SizedBox(width: 4),
                              Text('${message.attachmentsCount} влож.'),
                            ],
                          ),
                        ],
                        if (message.edited)
                          Padding(
                            padding: const EdgeInsets.only(top: 4),
                            child: Text(
                              'изменено',
                              style: Theme.of(context).textTheme.labelSmall
                                  ?.copyWith(color: scheme.onSurfaceVariant),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          if (own) const SizedBox(width: 10),
          if (own)
            _Avatar(
              name: author.effectiveName,
              online: author.online,
              avatar: author.avatar,
            ),
        ],
      ),
    );
  }
}

class _ComposerBar extends StatelessWidget {
  const _ComposerBar({
    required this.controller,
    required this.sending,
    required this.hint,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool sending;
  final String hint;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: EdgeInsets.fromLTRB(
        10,
        8,
        10,
        8 + MediaQuery.paddingOf(context).bottom,
      ),
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Row(
        children: [
          IconButton(
            tooltip: 'Вложение',
            onPressed: () {},
            icon: const Icon(Icons.add_circle_outline_rounded),
          ),
          Expanded(
            child: TextField(
              controller: controller,
              minLines: 1,
              maxLines: 5,
              decoration: InputDecoration(
                hintText: hint,
                filled: true,
                fillColor: scheme.surfaceContainerHighest,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide.none,
                ),
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
              ),
            ),
          ),
          const SizedBox(width: 6),
          IconButton.filled(
            tooltip: 'Отправить',
            onPressed: sending ? null : onSend,
            icon: sending
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.send_rounded),
          ),
        ],
      ),
    );
  }
}
