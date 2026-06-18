part of '../mobile_discord_shell.dart';

class _ServerRail extends ConsumerWidget {
  const _ServerRail({required this.currentUserId});

  final String currentUserId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sync = ref.watch(syncControllerProvider);
    final controller = ref.read(syncControllerProvider.notifier);
    final colors = Theme.of(context).extension<SyrnikeThemeColors>()!;
    final behavior =
        ref.watch(mobileBehaviorControllerProvider).value ??
        const MobileBehaviorSettings();
    final width = behavior.compactServerRail ? 58.0 : 68.0;
    final buttonSize = behavior.compactServerRail ? 42.0 : 48.0;

    return Container(
      width: width,
      decoration: BoxDecoration(
        color: colors.sidebar,
        border: Border(right: BorderSide(color: colors.shellDivider)),
      ),
      child: Column(
        children: [
          const SizedBox(height: 10),
          _RailButton(
            active: sync.selectedServerId == null,
            tooltip: 'Личные сообщения',
            size: buttonSize,
            reduceMotion: behavior.reduceMotion,
            child: const Icon(Icons.home_rounded),
            onTap: () {
              controller.selectServer(null);
              controller.selectChannelPanel();
            },
          ),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: SizedBox(width: 36, child: Divider(height: 1)),
          ),
          Expanded(
            child: sync.ready
                ? ListView.separated(
                    padding: EdgeInsets.symmetric(
                      horizontal: behavior.compactServerRail ? 8 : 10,
                    ),
                    itemCount: sync.sortedServers.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 8),
                    itemBuilder: (context, index) {
                      final server = sync.sortedServers[index];
                      return _RailButton(
                        active: sync.selectedServerId == server.id,
                        tooltip: server.name,
                        label: server.initials,
                        size: buttonSize,
                        reduceMotion: behavior.reduceMotion,
                        onTap: () {
                          controller.selectServer(server.id);
                          controller.selectChannelPanel();
                        },
                      );
                    },
                  )
                : const Center(
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: SizedBox(width: 36, child: Divider(height: 1)),
          ),
          _RailButton(
            active: false,
            tooltip: 'Создать или зайти на сервер',
            size: buttonSize,
            reduceMotion: behavior.reduceMotion,
            child: const Icon(Icons.add_rounded),
            onTap: () {
              showModalBottomSheet<void>(
                context: context,
                isScrollControlled: true,
                useSafeArea: true,
                backgroundColor: Colors.transparent,
                builder: (_) => const _ServerEntrySheet(),
              );
            },
          ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }
}

class _RailButton extends StatelessWidget {
  const _RailButton({
    required this.active,
    required this.tooltip,
    required this.onTap,
    required this.size,
    required this.reduceMotion,
    this.child,
    this.label,
  });

  final bool active;
  final String tooltip;
  final VoidCallback onTap;
  final double size;
  final bool reduceMotion;
  final Widget? child;
  final String? label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final colors = Theme.of(context).extension<SyrnikeThemeColors>()!;
    return Tooltip(
      message: tooltip,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: AnimatedContainer(
          duration: reduceMotion
              ? Duration.zero
              : const Duration(milliseconds: 160),
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: active ? scheme.primary : colors.card,
            borderRadius: BorderRadius.circular(active ? 16 : 24),
            border: Border.all(
              color: active ? scheme.primary : colors.sidebarBorder,
            ),
          ),
          alignment: Alignment.center,
          child: child != null
              ? IconTheme(
                  data: IconThemeData(
                    color: active ? scheme.onPrimary : colors.sidebarForeground,
                  ),
                  child: child!,
                )
              : Text(
                  label ?? '?',
                  maxLines: 1,
                  overflow: TextOverflow.clip,
                  style: TextStyle(
                    color: active ? scheme.onPrimary : colors.sidebarForeground,
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                  ),
                ),
        ),
      ),
    );
  }
}
