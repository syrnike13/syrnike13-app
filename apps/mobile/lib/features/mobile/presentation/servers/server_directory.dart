part of '../mobile_discord_shell.dart';

class _ChannelDirectory extends ConsumerWidget {
  const _ChannelDirectory({required this.currentUserId});

  final String currentUserId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sync = ref.watch(syncControllerProvider);
    final auth = ref.watch(authControllerProvider);
    final controller = ref.read(syncControllerProvider.notifier);
    final voice = ref.watch(mobileVoiceControllerProvider);
    final voiceController = ref.read(mobileVoiceControllerProvider.notifier);
    final selectedServer = sync.selectedServerId == null
        ? null
        : sync.servers[sync.selectedServerId];
    final dmChannels = sync.dmChannels(currentUserId);
    final textChannels = selectedServer == null
        ? dmChannels
        : sync.serverTextChannels(selectedServer.id);
    final voiceChannels = selectedServer == null
        ? const <SyrnikeChannel>[]
        : sync.serverVoiceChannels(selectedServer.id);
    final channelsCount = textChannels.length + voiceChannels.length;

    return Column(
      children: [
        _DirectoryHeader(
          title: selectedServer?.name ?? 'Личные сообщения',
          subtitle: selectedServer?.description ?? '$channelsCount каналов',
          onSearch: selectedServer == null || auth.session == null
              ? null
              : () {
                  showModalBottomSheet<void>(
                    context: context,
                    isScrollControlled: true,
                    useSafeArea: true,
                    backgroundColor: Colors.transparent,
                    builder: (_) => _ServerSearchSheet(
                      serverId: selectedServer.id,
                      currentUserId: currentUserId,
                      token: auth.session!.token,
                    ),
                  );
                },
        ),
        if (sync.errorMessage != null)
          _InlineBanner(
            icon: Icons.wifi_off_rounded,
            text: sync.errorMessage!,
            destructive: true,
          ),
        Expanded(
          child: sync.ready
              ? channelsCount == 0
                    ? const _EmptyState(
                        icon: Icons.tag_rounded,
                        title: 'Каналов пока нет',
                        subtitle: 'Они появятся здесь после sync Ready.',
                      )
                    : ListView(
                        padding: const EdgeInsets.fromLTRB(12, 8, 12, 96),
                        children: [
                          if (textChannels.isNotEmpty) ...[
                            _ChannelSectionHeader(
                              title: selectedServer == null
                                  ? 'Личные сообщения'
                                  : 'Текстовые каналы',
                            ),
                            for (final channel in textChannels)
                              _ChannelTile(
                                title: sync.channelLabel(
                                  channel,
                                  currentUserId,
                                ),
                                subtitle: channel.description,
                                icon: channel.isDmLike
                                    ? Icons.person_rounded
                                    : Icons.tag_rounded,
                                unread: _isUnread(channel, sync),
                                onTap: auth.session == null
                                    ? null
                                    : () => controller.selectChannel(
                                        channel.id,
                                        auth.session!.token,
                                      ),
                              ),
                          ],
                          if (voiceChannels.isNotEmpty) ...[
                            const SizedBox(height: 12),
                            const _ChannelSectionHeader(
                              title: 'Голосовые каналы',
                            ),
                            for (final channel in voiceChannels)
                              _VoiceChannelTile(
                                channel: channel,
                                title: sync.channelLabel(
                                  channel,
                                  currentUserId,
                                ),
                                participants: _voiceParticipantsForChannel(
                                  sync,
                                  channel.id,
                                  voice,
                                  currentUserId,
                                ),
                                currentUserId: currentUserId,
                                active: voice.channelId == channel.id,
                                joining:
                                    voice.channelId == channel.id &&
                                    voice.joining,
                                onTap: () async {
                                  final ok = await voiceController.join(
                                    channel.id,
                                  );
                                  if (!context.mounted || ok) return;
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    SnackBar(
                                      content: Text(
                                        ref
                                                .read(
                                                  mobileVoiceControllerProvider,
                                                )
                                                .errorMessage ??
                                            'Не удалось подключиться к голосу.',
                                      ),
                                    ),
                                  );
                                },
                              ),
                          ],
                        ],
                      )
              : const Center(child: CircularProgressIndicator()),
        ),
        _MobileUserBar(currentUserId: currentUserId),
      ],
    );
  }

  bool _isUnread(SyrnikeChannel channel, SyncSnapshot sync) {
    final lastMessageId = channel.lastMessageId;
    if (lastMessageId == null) return false;
    final lastReadId = sync.unreads[channel.id];
    if (lastReadId == null) return true;
    return lastReadId.compareTo(lastMessageId) < 0;
  }
}
