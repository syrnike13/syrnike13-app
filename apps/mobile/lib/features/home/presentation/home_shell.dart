import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/app_config.dart';
import '../../auth/application/auth_controller.dart';
import '../../voice/application/native_permissions.dart';

class HomeShell extends ConsumerStatefulWidget {
  const HomeShell({super.key});

  @override
  ConsumerState<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends ConsumerState<HomeShell> {
  var _selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final config = ref.watch(appConfigProvider);
    final wide = MediaQuery.sizeOf(context).width >= 840;

    final pages = [
      _OverviewPage(auth: auth, config: config),
      const _VoiceReadinessPage(),
      const _SettingsPage(),
    ];

    return Scaffold(
      appBar: AppBar(
        title: const Text('syrnike13'),
        actions: [
          IconButton(
            tooltip: 'Обновить сессию',
            onPressed: auth.busy
                ? null
                : () => ref.read(authControllerProvider.notifier).hydrate(),
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: Row(
        children: [
          if (wide)
            NavigationRail(
              selectedIndex: _selectedIndex,
              onDestinationSelected: (index) {
                setState(() => _selectedIndex = index);
              },
              labelType: NavigationRailLabelType.all,
              destinations: const [
                NavigationRailDestination(
                  icon: Icon(Icons.chat_bubble_outline_rounded),
                  selectedIcon: Icon(Icons.chat_bubble_rounded),
                  label: Text('Чаты'),
                ),
                NavigationRailDestination(
                  icon: Icon(Icons.graphic_eq_rounded),
                  label: Text('Voice'),
                ),
                NavigationRailDestination(
                  icon: Icon(Icons.settings_outlined),
                  selectedIcon: Icon(Icons.settings_rounded),
                  label: Text('Настройки'),
                ),
              ],
            ),
          Expanded(child: pages[_selectedIndex]),
        ],
      ),
      bottomNavigationBar: wide
          ? null
          : NavigationBar(
              selectedIndex: _selectedIndex,
              onDestinationSelected: (index) {
                setState(() => _selectedIndex = index);
              },
              destinations: const [
                NavigationDestination(
                  icon: Icon(Icons.chat_bubble_outline_rounded),
                  selectedIcon: Icon(Icons.chat_bubble_rounded),
                  label: 'Чаты',
                ),
                NavigationDestination(
                  icon: Icon(Icons.graphic_eq_rounded),
                  label: 'Voice',
                ),
                NavigationDestination(
                  icon: Icon(Icons.settings_outlined),
                  selectedIcon: Icon(Icons.settings_rounded),
                  label: 'Настройки',
                ),
              ],
            ),
    );
  }
}

class _OverviewPage extends StatelessWidget {
  const _OverviewPage({required this.auth, required this.config});

  final AuthState auth;
  final AppConfig config;

  @override
  Widget build(BuildContext context) {
    final user = auth.user;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _SectionCard(
          icon: Icons.person_rounded,
          title: user == null ? 'Сессия активна' : user.effectiveName,
          subtitle: user == null
              ? 'Нужно завершить onboarding перед загрузкой профиля.'
              : '@${user.username}#${user.discriminator}',
          trailing: user == null
              ? null
              : Chip(
                  label: Text(user.online ? 'online' : 'offline'),
                  avatar: Icon(
                    Icons.circle,
                    size: 12,
                    color: user.online ? Colors.green : Colors.grey,
                  ),
                ),
        ),
        const SizedBox(height: 12),
        _SectionCard(
          icon: Icons.hub_outlined,
          title: 'Backend',
          subtitle: config.apiUrl,
        ),
        const SizedBox(height: 12),
        const _SectionCard(
          icon: Icons.schema_outlined,
          title: 'Следующий слой',
          subtitle:
              'Здесь подключаются список серверов, каналы, лента сообщений, composer и WebSocket sync.',
        ),
      ],
    );
  }
}

class _VoiceReadinessPage extends ConsumerStatefulWidget {
  const _VoiceReadinessPage();

  @override
  ConsumerState<_VoiceReadinessPage> createState() =>
      _VoiceReadinessPageState();
}

class _VoiceReadinessPageState extends ConsumerState<_VoiceReadinessPage> {
  String? _status;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _SectionCard(
          icon: Icons.mic_external_on_outlined,
          title: 'Нативный voice слой',
          subtitle:
              _status ??
              'LiveKit dependency подключена. Проверьте разрешения платформы перед входом в комнату.',
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: () async {
            final result = await ensureMicrophonePermission();
            if (!mounted) return;
            setState(() {
              _status = result
                  ? 'Разрешения на микрофон и камеру доступны.'
                  : 'Не все разрешения выданы. Проверьте настройки системы.';
            });
          },
          icon: const Icon(Icons.privacy_tip_outlined),
          label: const Text('Проверить разрешения'),
        ),
      ],
    );
  }
}

class _SettingsPage extends ConsumerWidget {
  const _SettingsPage();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const _SectionCard(
          icon: Icons.info_outline_rounded,
          title: 'Приложение',
          subtitle: 'syrnike13 Flutter 0.4.13',
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: () => ref.read(authControllerProvider.notifier).logout(),
          icon: const Icon(Icons.logout_rounded),
          label: const Text('Выйти'),
        ),
      ],
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.trailing,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: Theme.of(context).colorScheme.primary),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    subtitle,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            if (trailing != null) ...[const SizedBox(width: 12), trailing!],
          ],
        ),
      ),
    );
  }
}
