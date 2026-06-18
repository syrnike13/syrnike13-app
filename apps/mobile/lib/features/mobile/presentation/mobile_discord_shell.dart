import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:record/record.dart';

import '../../../app/theme.dart';
import '../../../core/config/app_config.dart';
import '../../../core/network/api_client.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/data/auth_models.dart';
import '../../chat/data/messages_api.dart';
import '../../media/data/media_api.dart';
import '../../media/data/media_models.dart';
import '../../settings/application/mobile_behavior_controller.dart';
import '../../sync/application/sync_controller.dart';
import '../../sync/data/sync_models.dart';
import '../../users/data/users_api.dart';
import '../../voice/application/mobile_voice_controller.dart';

part 'widgets/server_rail.dart';
part 'sheets/server_entry_sheet.dart';
part 'dm/dm_home_screen.dart';
part 'shared/sheet_widgets.dart';
part 'shared/mobile_helpers.dart';
part 'servers/server_directory.dart';
part 'servers/server_search_sheet.dart';
part 'settings/behavior_settings_sheet.dart';
part 'settings/microphone_test_sheet.dart';
part 'notifications/notification_center_sheet.dart';
part 'settings/profile_overview_sheet.dart';
part 'settings/profile_settings_sheet.dart';
part 'channels/channel_widgets.dart';
part 'chat/chat_screen.dart';
part 'voice/voice_stage_screen.dart';
part 'widgets/mobile_user_bar.dart';
part 'shared/common_widgets.dart';

class MobileDiscordShell extends ConsumerStatefulWidget {
  const MobileDiscordShell({super.key});

  @override
  ConsumerState<MobileDiscordShell> createState() => _MobileDiscordShellState();
}

class _MobileDiscordShellState extends ConsumerState<MobileDiscordShell> {
  @override
  void initState() {
    super.initState();
    Future<void>.microtask(_connectSync);
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final sync = ref.watch(syncControllerProvider);
    final voice = ref.watch(mobileVoiceControllerProvider);
    final user = auth.user;

    if (user == null || auth.session == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final activeChannel = sync.selectedChannelId == null
        ? null
        : sync.channels[sync.selectedChannelId];
    final activeVoiceChannel = voice.channelId == null
        ? null
        : sync.channels[voice.channelId];

    return Scaffold(
      body: SafeArea(
        child: Row(
          children: [
            _ServerRail(currentUserId: user.id),
            Expanded(
              child: voice.stageOpen && activeVoiceChannel != null
                  ? _VoiceStageScreen(
                      channel: activeVoiceChannel,
                      currentUserId: user.id,
                    )
                  : activeChannel == null
                  ? sync.selectedServerId == null
                        ? _DmHomeScreen(currentUserId: user.id)
                        : _ChannelDirectory(currentUserId: user.id)
                  : _ChatScreen(
                      channel: activeChannel,
                      currentUserId: user.id,
                      token: auth.session!.token,
                    ),
            ),
          ],
        ),
      ),
    );
  }

  void _connectSync() {
    final auth = ref.read(authControllerProvider);
    final token = auth.session?.token;
    if (auth.isAuthenticated && token != null) {
      ref.read(syncControllerProvider.notifier).connect(token);
    }
  }
}
