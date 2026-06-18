part of '../mobile_discord_shell.dart';

Future<void> _showProfileSettingsSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    builder: (_) => const _ProfileSettingsSheet(),
  );
}

class _ProfileSettingsSheet extends ConsumerStatefulWidget {
  const _ProfileSettingsSheet();

  @override
  ConsumerState<_ProfileSettingsSheet> createState() =>
      _ProfileSettingsSheetState();
}

class _ProfileSettingsSheetState extends ConsumerState<_ProfileSettingsSheet> {
  final _displayNameController = TextEditingController();
  final _statusController = TextEditingController();
  final _bioController = TextEditingController();
  final _picker = ImagePicker();

  SyrnikeUserProfile? _profile;
  bool _loading = true;
  bool _busy = false;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    final user = ref.read(authControllerProvider).user;
    _displayNameController.text = user?.displayName ?? '';
    _statusController.text = user?.statusText ?? '';
    Future<void>.microtask(_loadProfile);
  }

  @override
  void dispose() {
    _displayNameController.dispose();
    _statusController.dispose();
    _bioController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final user = auth.user;
    final token = auth.session?.token;
    final scheme = Theme.of(context).colorScheme;
    final mediaUrl = ref.watch(appConfigProvider).mediaUrl;
    final background = _profile?.background;
    final backgroundUrl = background?.url(mediaUrl, fallbackTag: 'backgrounds');

    return _SheetContainer(
      heightFactor: 0.94,
      child: Column(
        children: [
          _SheetTitle(
            title: 'Редактировать профиль',
            onClose: () => Navigator.of(context).pop(),
          ),
          if (_errorMessage != null)
            _InlineBanner(
              icon: Icons.warning_amber_rounded,
              text: _errorMessage!,
              destructive: true,
            ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : ListView(
                    padding: EdgeInsets.fromLTRB(
                      18,
                      10,
                      18,
                      24 + MediaQuery.paddingOf(context).bottom,
                    ),
                    children: [
                      _ProfilePreviewCard(
                        user: user,
                        backgroundUrl: backgroundUrl,
                        busy: _busy,
                        onPickAvatar: token == null ? null : _pickAvatar,
                        onRemoveAvatar: token == null || user?.avatar == null
                            ? null
                            : _removeAvatar,
                        onPickBackground: token == null
                            ? null
                            : _pickBackground,
                        onRemoveBackground:
                            token == null || _profile?.background == null
                            ? null
                            : _removeBackground,
                      ),
                      const SizedBox(height: 18),
                      _SettingsTextField(
                        controller: _displayNameController,
                        label: 'Отображаемое имя',
                        icon: Icons.badge_rounded,
                        enabled: !_busy,
                      ),
                      const SizedBox(height: 12),
                      _SettingsTextField(
                        controller: _statusController,
                        label: 'Статус',
                        icon: Icons.mode_comment_rounded,
                        enabled: !_busy,
                      ),
                      const SizedBox(height: 12),
                      _SettingsTextField(
                        controller: _bioController,
                        label: 'О себе',
                        icon: Icons.notes_rounded,
                        maxLines: 4,
                        enabled: !_busy,
                      ),
                      const SizedBox(height: 18),
                      FilledButton.icon(
                        onPressed: token == null || _busy ? null : _saveProfile,
                        icon: _busy
                            ? SizedBox.square(
                                dimension: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: scheme.onPrimary,
                                ),
                              )
                            : const Icon(Icons.save_rounded),
                        label: const Text('Сохранить'),
                      ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  Future<void> _loadProfile() async {
    final auth = ref.read(authControllerProvider);
    final token = auth.session?.token;
    final userId = auth.user?.id;
    if (token == null || userId == null) {
      if (mounted) setState(() => _loading = false);
      return;
    }

    try {
      final profile = await ref
          .read(usersApiProvider)
          .fetchUserProfile(token: token, userId: userId);
      if (!mounted) return;
      setState(() {
        _profile = profile;
        _bioController.text = profile.content ?? '';
        _loading = false;
        _errorMessage = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _errorMessage = _friendlyProfileError(error);
      });
    }
  }

  Future<void> _saveProfile() async {
    await _runProfileAction(() async {
      final remove = <String>[];
      final profile = <String, Object?>{};
      final body = <String, Object?>{};

      final displayName = _displayNameController.text.trim();
      body['display_name'] = displayName.isEmpty ? null : displayName;

      final statusText = _statusController.text.trim();
      if (statusText.isEmpty) {
        remove.add('StatusText');
      } else {
        body['status'] = {'text': statusText};
      }

      final bio = _bioController.text.trim();
      if (bio.isEmpty) {
        remove.add('ProfileContent');
      } else {
        profile['content'] = bio;
      }

      if (profile.isNotEmpty) body['profile'] = profile;
      if (remove.isNotEmpty) body['remove'] = remove;

      final updated = await ref
          .read(usersApiProvider)
          .updateCurrentUser(token: _requiredToken(), body: body);
      _applyUpdatedUser(updated);
      _showSnack('Профиль сохранён');
    });
  }

  Future<void> _pickAvatar() async {
    final file = await _picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 90,
      maxWidth: 1600,
    );
    if (file == null) return;

    await _runProfileAction(() async {
      final id = await ref
          .read(mediaApiProvider)
          .uploadMediaFile(
            token: _requiredToken(),
            tag: 'avatars',
            filePath: file.path,
          );
      final updated = await ref
          .read(usersApiProvider)
          .updateCurrentUser(token: _requiredToken(), body: {'avatar': id});
      _applyUpdatedUser(updated);
      _showSnack('Аватар обновлён');
    });
  }

  Future<void> _removeAvatar() async {
    await _runProfileAction(() async {
      final updated = await ref
          .read(usersApiProvider)
          .updateCurrentUser(
            token: _requiredToken(),
            body: {
              'remove': ['Avatar'],
            },
          );
      _applyUpdatedUser(updated);
      _showSnack('Аватар удалён');
    });
  }

  Future<void> _pickBackground() async {
    final file = await _picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 90,
      maxWidth: 2200,
    );
    if (file == null) return;

    await _runProfileAction(() async {
      final id = await ref
          .read(mediaApiProvider)
          .uploadMediaFile(
            token: _requiredToken(),
            tag: 'backgrounds',
            filePath: file.path,
          );
      await ref
          .read(usersApiProvider)
          .updateCurrentUser(
            token: _requiredToken(),
            body: {
              'profile': {'background': id},
            },
          );
      await _reloadProfileAfterMediaChange(
        fallback: SyrnikeUserProfile(
          content: _bioController.text.trim().isEmpty
              ? null
              : _bioController.text.trim(),
          background: SyrnikeFileAsset(id: id, tag: 'backgrounds'),
        ),
      );
      _showSnack('Баннер обновлён');
    });
  }

  Future<void> _removeBackground() async {
    await _runProfileAction(() async {
      await ref
          .read(usersApiProvider)
          .updateCurrentUser(
            token: _requiredToken(),
            body: {
              'remove': ['ProfileBackground'],
            },
          );
      await _reloadProfileAfterMediaChange(
        fallback: SyrnikeUserProfile(
          content: _bioController.text.trim().isEmpty
              ? null
              : _bioController.text.trim(),
        ),
      );
      _showSnack('Баннер удалён');
    });
  }

  Future<void> _reloadProfileAfterMediaChange({
    required SyrnikeUserProfile fallback,
  }) async {
    final auth = ref.read(authControllerProvider);
    final token = auth.session?.token;
    final userId = auth.user?.id;
    if (token == null || userId == null) return;
    try {
      final profile = await ref
          .read(usersApiProvider)
          .fetchUserProfile(token: token, userId: userId);
      if (!mounted) return;
      setState(() => _profile = profile);
    } catch (_) {
      if (!mounted) return;
      setState(() => _profile = fallback);
    }
  }

  Future<void> _runProfileAction(Future<void> Function() action) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _errorMessage = null;
    });
    try {
      await action();
    } catch (error) {
      if (!mounted) return;
      setState(() => _errorMessage = _friendlyProfileError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _applyUpdatedUser(SyrnikeUser user) {
    ref.read(authControllerProvider.notifier).replaceCurrentUser(user);
    ref.read(syncControllerProvider.notifier).upsertCurrentUser(user);
  }

  String _requiredToken() {
    final token = ref.read(authControllerProvider).session?.token;
    if (token == null) throw StateError('Нужна активная сессия.');
    return token;
  }

  String _friendlyProfileError(Object error) {
    if (error is ApiException) return error.message;
    return 'Не удалось обновить профиль.';
  }

  void _showSnack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }
}

class _ProfilePreviewCard extends ConsumerWidget {
  const _ProfilePreviewCard({
    required this.user,
    required this.backgroundUrl,
    required this.busy,
    required this.onPickAvatar,
    required this.onRemoveAvatar,
    required this.onPickBackground,
    required this.onRemoveBackground,
  });

  final SyrnikeUser? user;
  final String? backgroundUrl;
  final bool busy;
  final VoidCallback? onPickAvatar;
  final VoidCallback? onRemoveAvatar;
  final VoidCallback? onPickBackground;
  final VoidCallback? onRemoveBackground;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        children: [
          Stack(
            clipBehavior: Clip.none,
            children: [
              Container(
                height: 132,
                decoration: BoxDecoration(
                  color: const Color(0xFFAE7E45),
                  borderRadius: const BorderRadius.vertical(
                    top: Radius.circular(18),
                  ),
                  image: backgroundUrl == null
                      ? null
                      : DecorationImage(
                          image: NetworkImage(backgroundUrl!),
                          fit: BoxFit.cover,
                        ),
                ),
              ),
              Positioned(
                right: 10,
                top: 10,
                child: Row(
                  children: [
                    _RoundIconButton(
                      tooltip: 'Сменить баннер',
                      icon: Icons.image_rounded,
                      onPressed: busy ? null : onPickBackground,
                    ),
                    const SizedBox(width: 8),
                    _RoundIconButton(
                      tooltip: 'Убрать баннер',
                      icon: Icons.delete_outline_rounded,
                      onPressed: busy ? null : onRemoveBackground,
                    ),
                  ],
                ),
              ),
              Positioned(
                left: 18,
                bottom: -36,
                child: _Avatar(
                  name: user?.effectiveName ?? 'Я',
                  online: true,
                  avatar: user?.avatar,
                  radius: 42,
                ),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 46, 18, 16),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    user?.effectiveName ?? 'Аккаунт',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
                _RoundIconButton(
                  tooltip: 'Сменить аватар',
                  icon: Icons.photo_camera_rounded,
                  onPressed: busy ? null : onPickAvatar,
                ),
                const SizedBox(width: 8),
                _RoundIconButton(
                  tooltip: 'Убрать аватар',
                  icon: Icons.delete_outline_rounded,
                  onPressed: busy ? null : onRemoveAvatar,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SettingsTextField extends StatelessWidget {
  const _SettingsTextField({
    required this.controller,
    required this.label,
    required this.icon,
    required this.enabled,
    this.maxLines = 1,
  });

  final TextEditingController controller;
  final String label;
  final IconData icon;
  final bool enabled;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      enabled: enabled,
      maxLines: maxLines,
      decoration: InputDecoration(labelText: label, prefixIcon: Icon(icon)),
    );
  }
}

class _RoundIconButton extends StatelessWidget {
  const _RoundIconButton({
    required this.tooltip,
    required this.icon,
    required this.onPressed,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton.filledTonal(
      tooltip: tooltip,
      onPressed: onPressed,
      icon: Icon(icon),
    );
  }
}
