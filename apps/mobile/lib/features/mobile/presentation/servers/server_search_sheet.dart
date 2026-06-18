part of '../mobile_discord_shell.dart';

class _ServerSearchSheet extends ConsumerStatefulWidget {
  const _ServerSearchSheet({
    required this.serverId,
    required this.currentUserId,
    required this.token,
  });

  final String serverId;
  final String currentUserId;
  final String token;

  @override
  ConsumerState<_ServerSearchSheet> createState() => _ServerSearchSheetState();
}

class _ServerSearchSheetState extends ConsumerState<_ServerSearchSheet> {
  final _queryController = TextEditingController();
  Timer? _debounce;
  var _searching = false;
  var _results = const <_ServerSearchResult>[];
  var _foundUsers = const <String, SyrnikeUserSummary>{};

  @override
  void dispose() {
    _debounce?.cancel();
    _queryController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final query = _queryController.text.trim();
    return _SheetContainer(
      child: Column(
        children: [
          _SheetTitle(
            title: 'Поиск по серверу',
            onClose: () => Navigator.of(context).pop(),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 12),
            child: TextField(
              controller: _queryController,
              autofocus: true,
              textInputAction: TextInputAction.search,
              onChanged: _scheduleSearch,
              onSubmitted: (_) => _runSearch(),
              decoration: const InputDecoration(
                hintText: 'Каналы, сообщения, люди',
                prefixIcon: Icon(Icons.search_rounded),
              ),
            ),
          ),
          if (_searching) const LinearProgressIndicator(minHeight: 2),
          Expanded(
            child: query.length < 2
                ? const _EmptyState(
                    icon: Icons.search_rounded,
                    title: 'Введите минимум 2 символа',
                    subtitle: 'Ищем по каналам, людям и сообщениям сервера.',
                  )
                : _results.isEmpty && !_searching
                ? const _EmptyState(
                    icon: Icons.search_off_rounded,
                    title: 'Ничего не найдено',
                    subtitle: 'Попробуй другой запрос.',
                  )
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(18, 8, 18, 24),
                    itemCount: _results.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final result = _results[index];
                      return _ServerSearchResultTile(
                        result: result,
                        author: result.message == null
                            ? null
                            : _foundUsers[result.message!.authorId] ??
                                  ref
                                      .watch(syncControllerProvider)
                                      .users[result.message!.authorId],
                        onTap: () => _openResult(result),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  void _scheduleSearch(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 260), _runSearch);
    setState(() {});
  }

  Future<void> _runSearch() async {
    final query = _queryController.text.trim();
    _debounce?.cancel();
    if (query.length < 2) {
      setState(() {
        _searching = false;
        _results = const [];
        _foundUsers = const {};
      });
      return;
    }

    final sync = ref.read(syncControllerProvider);
    final lowered = query.toLowerCase();
    final localResults = <_ServerSearchResult>[];

    for (final channel in sync.serverChannels(widget.serverId)) {
      final label = sync.channelLabel(channel, widget.currentUserId);
      final haystack = '${label.toLowerCase()} ${channel.description ?? ''}';
      if (haystack.toLowerCase().contains(lowered)) {
        localResults.add(
          _ServerSearchResult.channel(channel: channel, title: label),
        );
      }
      if (localResults.length >= 12) break;
    }

    var usersAdded = 0;
    for (final user in sync.users.values) {
      final haystack = '${user.effectiveName} ${user.username}'.toLowerCase();
      if (user.id != widget.currentUserId && haystack.contains(lowered)) {
        localResults.add(_ServerSearchResult.user(user: user));
        usersAdded += 1;
      }
      if (usersAdded >= 8) break;
    }

    setState(() {
      _searching = true;
      _results = localResults;
    });

    final messageResults = <_ServerSearchResult>[];
    final foundUsers = <String, SyrnikeUserSummary>{};
    final api = ref.read(messagesApiProvider);
    final channels = sync.serverTextChannels(widget.serverId).take(24).toList();
    final batches = await Future.wait(
      channels.map((channel) async {
        try {
          final result = await api.searchChannelMessages(
            token: widget.token,
            channelId: channel.id,
            query: query,
            limit: 4,
          );
          return (channel: channel, result: result);
        } catch (_) {
          return null;
        }
      }),
    );

    if (!mounted || query != _queryController.text.trim()) return;

    for (final batch in batches) {
      if (batch == null) continue;
      for (final user in batch.result.users) {
        foundUsers[user.id] = user;
      }
      for (final message in batch.result.messages) {
        messageResults.add(
          _ServerSearchResult.message(
            channel: batch.channel,
            channelTitle: sync.channelLabel(
              batch.channel,
              widget.currentUserId,
            ),
            message: message,
          ),
        );
      }
    }

    messageResults.sort(
      (a, b) => (b.message?.id ?? '').compareTo(a.message?.id ?? ''),
    );

    setState(() {
      _searching = false;
      _foundUsers = foundUsers;
      _results = [...localResults, ...messageResults.take(40)];
    });
  }

  Future<void> _openResult(_ServerSearchResult result) async {
    final syncController = ref.read(syncControllerProvider.notifier);
    switch (result.kind) {
      case _ServerSearchResultKind.channel:
        final channel = result.channel!;
        if (channel.isServerVoice) {
          await ref
              .read(mobileVoiceControllerProvider.notifier)
              .join(channel.id);
        } else {
          await syncController.selectChannel(channel.id, widget.token);
        }
      case _ServerSearchResultKind.user:
        await syncController.openDirectMessage(
          token: widget.token,
          userId: result.user!.id,
        );
      case _ServerSearchResultKind.message:
        await syncController.selectChannel(result.channel!.id, widget.token);
    }
    if (mounted) Navigator.of(context).pop();
  }
}

class _ServerSearchResultTile extends StatelessWidget {
  const _ServerSearchResultTile({
    required this.result,
    required this.onTap,
    this.author,
  });

  final _ServerSearchResult result;
  final SyrnikeUserSummary? author;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final icon = switch (result.kind) {
      _ServerSearchResultKind.channel =>
        result.channel!.isServerVoice
            ? Icons.volume_up_rounded
            : Icons.tag_rounded,
      _ServerSearchResultKind.user => Icons.person_rounded,
      _ServerSearchResultKind.message => Icons.chat_bubble_rounded,
    };
    final eyebrow = switch (result.kind) {
      _ServerSearchResultKind.channel =>
        result.channel!.isServerVoice ? 'Голосовой канал' : 'Текстовый канал',
      _ServerSearchResultKind.user => 'Пользователь',
      _ServerSearchResultKind.message =>
        '${result.channelTitle} · ${author?.effectiveName ?? 'Сообщение'}',
    };
    final title = switch (result.kind) {
      _ServerSearchResultKind.channel => result.title,
      _ServerSearchResultKind.user => result.user!.effectiveName,
      _ServerSearchResultKind.message =>
        result.message!.content?.trim().isNotEmpty == true
            ? result.message!.content!.trim()
            : '[без текста]',
    };

    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
      leading: Icon(icon, color: scheme.onSurfaceVariant),
      title: Text(
        title,
        maxLines: result.kind == _ServerSearchResultKind.message ? 2 : 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontWeight: FontWeight.w800),
      ),
      subtitle: Text(eyebrow, maxLines: 1, overflow: TextOverflow.ellipsis),
      onTap: onTap,
    );
  }
}

enum _ServerSearchResultKind { channel, user, message }

class _ServerSearchResult {
  const _ServerSearchResult._({
    required this.kind,
    required this.title,
    this.channelTitle = '',
    this.channel,
    this.user,
    this.message,
  });

  factory _ServerSearchResult.channel({
    required SyrnikeChannel channel,
    required String title,
  }) {
    return _ServerSearchResult._(
      kind: _ServerSearchResultKind.channel,
      title: title,
      channel: channel,
    );
  }

  factory _ServerSearchResult.user({required SyrnikeUserSummary user}) {
    return _ServerSearchResult._(
      kind: _ServerSearchResultKind.user,
      title: user.effectiveName,
      user: user,
    );
  }

  factory _ServerSearchResult.message({
    required SyrnikeChannel channel,
    required String channelTitle,
    required SyrnikeMessage message,
  }) {
    return _ServerSearchResult._(
      kind: _ServerSearchResultKind.message,
      title: message.content ?? '',
      channelTitle: channelTitle,
      channel: channel,
      message: message,
    );
  }

  final _ServerSearchResultKind kind;
  final String title;
  final String channelTitle;
  final SyrnikeChannel? channel;
  final SyrnikeUserSummary? user;
  final SyrnikeMessage? message;
}
