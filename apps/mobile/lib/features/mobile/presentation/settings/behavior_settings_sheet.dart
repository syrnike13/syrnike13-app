part of '../mobile_discord_shell.dart';

void _showBehaviorSettingsSheet(BuildContext context) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    builder: (_) => const _BehaviorSettingsSheet(),
  );
}

class _BehaviorSettingsSheet extends ConsumerWidget {
  const _BehaviorSettingsSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final asyncSettings = ref.watch(mobileBehaviorControllerProvider);
    final settings = asyncSettings.value ?? const MobileBehaviorSettings();

    return _SheetContainer(
      heightFactor: 0.92,
      child: Column(
        children: [
          _SheetTitle(
            title: 'Поведение',
            onClose: () => Navigator.of(context).pop(),
          ),
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(
                18,
                8,
                18,
                24 + MediaQuery.paddingOf(context).bottom,
              ),
              children: [
                _BehaviorSection(
                  title: 'Интерфейс',
                  children: [
                    _BehaviorSwitch(
                      icon: Icons.density_small_rounded,
                      title: 'Компактный бар серверов',
                      subtitle: 'Узкий левый список с меньшими иконками.',
                      value: settings.compactServerRail,
                      onChanged: (value) => _patch(
                        ref,
                        (current) => current.copyWith(compactServerRail: value),
                      ),
                    ),
                    _BehaviorSwitch(
                      icon: Icons.circle_rounded,
                      title: 'Показывать статус у аватаров',
                      subtitle: 'Индикаторы онлайна возле аватаров.',
                      value: settings.showPresenceDots,
                      onChanged: (value) => _patch(
                        ref,
                        (current) => current.copyWith(showPresenceDots: value),
                      ),
                    ),
                    _BehaviorSwitch(
                      icon: Icons.animation_rounded,
                      title: 'Меньше анимаций',
                      subtitle: 'Более резкие переходы без лишнего движения.',
                      value: settings.reduceMotion,
                      onChanged: (value) => _patch(
                        ref,
                        (current) => current.copyWith(reduceMotion: value),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                _BehaviorSection(
                  title: 'Чаты',
                  children: [
                    _BehaviorSwitch(
                      icon: Icons.swipe_rounded,
                      title: 'Свайпы в списке личных сообщений',
                      subtitle: 'Быстрые действия в списке диалогов.',
                      value: settings.chatSwipeActions,
                      onChanged: (value) => _patch(
                        ref,
                        (current) => current.copyWith(chatSwipeActions: value),
                      ),
                    ),
                    _BehaviorSwitch(
                      icon: Icons.keyboard_rounded,
                      title: 'Фокус на поле ввода при входе в чат',
                      subtitle: 'Сразу готовить composer к набору текста.',
                      value: settings.openKeyboardInChats,
                      onChanged: (value) => _patch(
                        ref,
                        (current) =>
                            current.copyWith(openKeyboardInChats: value),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                _BehaviorSection(
                  title: 'Голос',
                  children: [
                    _BehaviorSwitch(
                      icon: Icons.mic_off_rounded,
                      title: 'Заходить в голос с выключенным микрофоном',
                      subtitle: 'Первое подключение к каналу будет muted.',
                      value: settings.joinVoiceMuted,
                      onChanged: (value) => _patch(
                        ref,
                        (current) => current.copyWith(joinVoiceMuted: value),
                      ),
                    ),
                    _BehaviorSwitch(
                      icon: Icons.music_note_rounded,
                      title: 'Звуки голосового чата',
                      subtitle:
                          'Подключение, выход, микрофон и режим заглушения.',
                      value: settings.voiceSounds,
                      onChanged: (value) => _patch(
                        ref,
                        (current) => current.copyWith(voiceSounds: value),
                      ),
                    ),
                    _BehaviorAction(
                      icon: Icons.graphic_eq_rounded,
                      title: 'Проверить микрофон',
                      subtitle:
                          'Посмотреть уровень сигнала и прослушать запись.',
                      onTap: () => _showMicrophoneTestSheet(context),
                    ),
                    _BehaviorSwitch(
                      icon: Icons.vibration_rounded,
                      title: 'Тактильные отклики',
                      subtitle: 'Короткие отклики на важные действия.',
                      value: settings.hapticFeedback,
                      onChanged: (value) => _patch(
                        ref,
                        (current) => current.copyWith(hapticFeedback: value),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  void _patch(
    WidgetRef ref,
    MobileBehaviorSettings Function(MobileBehaviorSettings) update,
  ) {
    ref.read(mobileBehaviorControllerProvider.notifier).patch(update);
  }
}

class _BehaviorAction extends StatelessWidget {
  const _BehaviorAction({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
      subtitle: Text(subtitle),
      trailing: const Icon(Icons.chevron_right_rounded),
      onTap: onTap,
    );
  }
}

class _BehaviorSection extends StatelessWidget {
  const _BehaviorSection({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<SyrnikeThemeColors>()!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 8),
          child: Text(
            title,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontWeight: FontWeight.w900,
            ),
          ),
        ),
        DecoratedBox(
          decoration: BoxDecoration(
            color: colors.muted,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: colors.border),
          ),
          child: Column(children: children),
        ),
      ],
    );
  }
}

class _BehaviorSwitch extends StatelessWidget {
  const _BehaviorSwitch({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      secondary: Icon(icon),
      title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
      subtitle: Text(subtitle),
      value: value,
      onChanged: onChanged,
    );
  }
}
