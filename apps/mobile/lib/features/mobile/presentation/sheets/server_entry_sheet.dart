part of '../mobile_discord_shell.dart';

class _ServerEntrySheet extends ConsumerStatefulWidget {
  const _ServerEntrySheet();

  @override
  ConsumerState<_ServerEntrySheet> createState() => _ServerEntrySheetState();
}

class _ServerEntrySheetState extends ConsumerState<_ServerEntrySheet> {
  final _nameController = TextEditingController();
  final _inviteController = TextEditingController();
  var _mode = _ServerEntryMode.create;
  var _busy = false;

  @override
  void dispose() {
    _nameController.dispose();
    _inviteController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return _SheetContainer(
      heightFactor: 0.62,
      child: Column(
        children: [
          _SheetTitle(
            title: _mode == _ServerEntryMode.create
                ? 'Создать сервер'
                : 'Зайти на сервер',
            onClose: () => Navigator.of(context).pop(),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 18),
            child: Column(
              children: [
                if (_mode == _ServerEntryMode.create) ...[
                  TextField(
                    controller: _nameController,
                    autofocus: true,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _submitCreate(),
                    decoration: const InputDecoration(
                      labelText: 'Название',
                      hintText: 'Мой сервер',
                      prefixIcon: Icon(Icons.tag_faces_rounded),
                    ),
                  ),
                  const SizedBox(height: 14),
                  FilledButton.icon(
                    onPressed: _busy ? null : _submitCreate,
                    icon: _busy
                        ? const SizedBox.square(
                            dimension: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.add_rounded),
                    label: const Text('Создать'),
                  ),
                  const SizedBox(height: 22),
                  DecoratedBox(
                    decoration: BoxDecoration(
                      color: scheme.surfaceContainerHigh,
                      borderRadius: BorderRadius.circular(18),
                    ),
                    child: _SheetActionTile(
                      icon: Icons.login_rounded,
                      title: 'Зайти по приглашению',
                      onTap: () {
                        setState(() => _mode = _ServerEntryMode.join);
                      },
                    ),
                  ),
                ] else ...[
                  TextField(
                    controller: _inviteController,
                    autofocus: true,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _submitJoin(),
                    decoration: const InputDecoration(
                      labelText: 'Ссылка или код приглашения',
                      hintText: 'https://syrnike13.ru/invite/...',
                      prefixIcon: Icon(Icons.link_rounded),
                    ),
                  ),
                  const SizedBox(height: 14),
                  FilledButton.icon(
                    onPressed: _busy ? null : _submitJoin,
                    icon: _busy
                        ? const SizedBox.square(
                            dimension: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.login_rounded),
                    label: const Text('Присоединиться'),
                  ),
                  const SizedBox(height: 12),
                  TextButton.icon(
                    onPressed: _busy
                        ? null
                        : () => setState(() => _mode = _ServerEntryMode.create),
                    icon: const Icon(Icons.arrow_back_rounded),
                    label: const Text('Назад'),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _submitCreate() async {
    final auth = ref.read(authControllerProvider);
    final token = auth.session?.token;
    final name = _nameController.text.trim();
    if (token == null || name.isEmpty || _busy) return;

    setState(() => _busy = true);
    try {
      final server = await ref
          .read(syncControllerProvider.notifier)
          .createServer(token: token, name: name);
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Сервер «${server.name}» создан.')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(_friendlySheetError(error))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submitJoin() async {
    final auth = ref.read(authControllerProvider);
    final token = auth.session?.token;
    final invite = _inviteController.text.trim();
    if (token == null || invite.isEmpty || _busy) return;

    setState(() => _busy = true);
    try {
      final server = await ref
          .read(syncControllerProvider.notifier)
          .joinServerInvite(token: token, invite: invite);
      if (!mounted) return;
      if (server == null) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Это приглашение не ведёт на сервер.')),
        );
        return;
      }
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Вы присоединились к «${server.name}».')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(_friendlySheetError(error))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

enum _ServerEntryMode { create, join }

String _friendlySheetError(Object error) {
  final text = error.toString();
  if (text.startsWith('Bad state: ')) return text.substring(11);
  if (text.startsWith('ApiException: ')) return text.substring(14);
  return text;
}
