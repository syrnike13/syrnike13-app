part of '../mobile_discord_shell.dart';

const _profileBg = Color(0xFF323339);
const _profileMuted = Color(0xFF2E2F35);
const _profileBorder = Color(0xFF505157);
const _profilePrimary = Color(0xFF5865F2);
const _profileText = Color(0xFFFFFFFF);
const _profileSubtle = Color(0xFFA4A5AB);
const _profileAvatarBg = Color(0xFF414248);

void _showProfileOverviewSheet(
  BuildContext context, {
  required SyrnikeUser? user,
  required List<SyrnikeUserSummary> friends,
  required Future<SyrnikeUserProfile?> Function()? loadProfile,
  required VoidCallback onOpenFriends,
}) {
  final size = MediaQuery.sizeOf(context);
  showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Закрыть профиль',
    barrierColor: Colors.black.withValues(alpha: 0.58),
    transitionDuration: const Duration(milliseconds: 220),
    pageBuilder: (dialogContext, _, _) => SafeArea(
      top: false,
      child: Align(
        alignment: Alignment.bottomCenter,
        child: Material(
          color: Colors.transparent,
          child: SizedBox(
            width: size.width,
            height: size.height * 0.94,
            child: _ProfileOverviewFallbackContent(
              user: user,
              friends: friends,
              loadProfile: loadProfile,
              onOpenFriends: () {
                Navigator.of(dialogContext).pop();
                onOpenFriends();
              },
            ),
          ),
        ),
      ),
    ),
    transitionBuilder: (context, animation, _, child) {
      final curved = CurvedAnimation(
        parent: animation,
        curve: Curves.easeOutCubic,
        reverseCurve: Curves.easeInCubic,
      );
      return SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(0, 1),
          end: Offset.zero,
        ).animate(curved),
        child: child,
      );
    },
  );
}

class _ProfileOverviewFallbackContent extends StatefulWidget {
  const _ProfileOverviewFallbackContent({
    required this.user,
    required this.friends,
    required this.loadProfile,
    required this.onOpenFriends,
  });

  final SyrnikeUser? user;
  final List<SyrnikeUserSummary> friends;
  final Future<SyrnikeUserProfile?> Function()? loadProfile;
  final VoidCallback onOpenFriends;

  @override
  State<_ProfileOverviewFallbackContent> createState() =>
      _ProfileOverviewFallbackContentState();
}

class _ProfileOverviewFallbackContentState
    extends State<_ProfileOverviewFallbackContent> {
  Future<SyrnikeUserProfile?>? _profileFuture;

  @override
  void initState() {
    super.initState();
    _profileFuture = widget.loadProfile?.call();
  }

  @override
  void didUpdateWidget(covariant _ProfileOverviewFallbackContent oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.loadProfile != widget.loadProfile) {
      _profileFuture = widget.loadProfile?.call();
    }
  }

  void _reloadProfile() {
    final loader = widget.loadProfile;
    if (loader == null) return;
    setState(() => _profileFuture = loader());
  }

  @override
  Widget build(BuildContext context) {
    final mediaUrl = AppConfig.fromEnvironment().mediaUrl;
    return FutureBuilder<SyrnikeUserProfile?>(
      future: _profileFuture,
      builder: (context, snapshot) {
        final profile = snapshot.data;
        final backgroundUrl = profile?.background?.url(
          mediaUrl,
          fallbackTag: 'backgrounds',
        );
        final bio = profile?.content?.trim();
        final status = widget.user?.statusText?.trim();

        return Container(
          decoration: const BoxDecoration(
            color: _profileBg,
            borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
          ),
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(
              18,
              14,
              18,
              24 + MediaQuery.paddingOf(context).bottom,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(
                  height: status?.isNotEmpty == true ? 190 : 154,
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Positioned.fill(
                        bottom: 42,
                        child: _ProfileBanner(imageUrl: backgroundUrl),
                      ),
                      Positioned(
                        left: 10,
                        top: 10,
                        child: _ProfileCircleAction(
                          icon: Icons.close_rounded,
                          onTap: () => Navigator.of(context).pop(),
                        ),
                      ),
                      Positioned(
                        right: 10,
                        top: 10,
                        child: _ProfileCircleAction(
                          icon: Icons.settings_rounded,
                          onTap: () => _showBehaviorSettingsSheet(context),
                        ),
                      ),
                      Positioned(
                        left: 4,
                        bottom: 0,
                        child: _PlainAvatar(
                          name: widget.user?.effectiveName ?? 'Я',
                          avatar: widget.user?.avatar,
                          mediaUrl: mediaUrl,
                          radius: 48,
                        ),
                      ),
                      if (status?.isNotEmpty == true)
                        Positioned(
                          left: 126,
                          right: 0,
                          bottom: 12,
                          child: _ProfileStatusBubble(text: status!),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  widget.user?.effectiveName ?? 'Аккаунт',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: _profileText,
                    fontSize: 38,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        widget.user?.username ?? 'username',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: _profileSubtle,
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 9,
                        vertical: 5,
                      ),
                      decoration: BoxDecoration(
                        color: _profileMuted,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Text(
                        '#',
                        style: TextStyle(
                          color: _profilePrimary,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 22),
                _ProfileWideAction(
                  icon: Icons.edit_rounded,
                  text: 'Редактировать профиль',
                  primary: true,
                  onTap: () async {
                    await _showProfileSettingsSheet(context);
                    if (!mounted) return;
                    _reloadProfile();
                  },
                ),
                if (bio?.isNotEmpty == true) ...[
                  const SizedBox(height: 16),
                  _ProfileSimpleCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('О себе'),
                        const SizedBox(height: 8),
                        Text(
                          bio!,
                          style: const TextStyle(
                            color: _profileSubtle,
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                            height: 1.3,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                _ProfileSimpleCard(
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: widget.onOpenFriends,
                    child: Row(
                      children: [
                        const Expanded(child: Text('Друзья')),
                        if (widget.friends.isNotEmpty)
                          SizedBox(
                            height: 34,
                            width: 112,
                            child: Stack(
                              children: [
                                for (
                                  var i = 0;
                                  i < widget.friends.length;
                                  i += 1
                                )
                                  Positioned(
                                    left: i * 20,
                                    child: _PlainAvatar(
                                      name: widget.friends[i].effectiveName,
                                      avatar: widget.friends[i].avatar,
                                      mediaUrl: mediaUrl,
                                      radius: 17,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        const Icon(
                          Icons.chevron_right_rounded,
                          color: _profileText,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _ProfileBanner extends StatelessWidget {
  const _ProfileBanner({required this.imageUrl});

  final String? imageUrl;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: _profileMuted,
        borderRadius: BorderRadius.circular(24),
        image: imageUrl == null
            ? null
            : DecorationImage(
                image: NetworkImage(imageUrl!),
                fit: BoxFit.cover,
              ),
      ),
    );
  }
}

class _ProfileStatusBubble extends StatelessWidget {
  const _ProfileStatusBubble({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: _profileMuted,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _profileBorder),
      ),
      child: Row(
        children: [
          const Icon(Icons.mode_comment_rounded, color: _profileText, size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: _profileText,
                fontSize: 16,
                fontStyle: FontStyle.italic,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ProfileCircleAction extends StatelessWidget {
  const _ProfileCircleAction({required this.icon, required this.onTap});

  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.42),
          shape: BoxShape.circle,
        ),
        child: Icon(icon, color: Colors.white, size: 24),
      ),
    );
  }
}

class _ProfileWideAction extends StatelessWidget {
  const _ProfileWideAction({
    required this.icon,
    required this.text,
    required this.primary,
    required this.onTap,
  });

  final IconData icon;
  final String text;
  final bool primary;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 56,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: primary ? _profilePrimary : _profileMuted,
          borderRadius: BorderRadius.circular(28),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: Colors.white),
            const SizedBox(width: 10),
            Text(
              text,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 18,
                fontWeight: FontWeight.w900,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProfileSimpleCard extends StatelessWidget {
  const _ProfileSimpleCard({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DefaultTextStyle(
      style: const TextStyle(
        color: _profileText,
        fontSize: 17,
        fontWeight: FontWeight.w800,
      ),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
        decoration: BoxDecoration(
          color: _profileMuted,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: _profileBorder),
        ),
        child: child,
      ),
    );
  }
}

class _PlainAvatar extends StatelessWidget {
  const _PlainAvatar({
    required this.name,
    required this.avatar,
    required this.mediaUrl,
    required this.radius,
  });

  final String name;
  final SyrnikeFileAsset? avatar;
  final String mediaUrl;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final imageUrl = avatar?.url(mediaUrl, fallbackTag: 'avatars');
    final initial = name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase();
    return CircleAvatar(
      radius: radius,
      backgroundColor: _profileAvatarBg,
      foregroundColor: _profileText,
      backgroundImage: imageUrl == null ? null : NetworkImage(imageUrl),
      child: imageUrl == null
          ? Text(
              initial,
              style: TextStyle(
                fontSize: radius * 0.85,
                fontWeight: FontWeight.w900,
              ),
            )
          : null,
    );
  }
}
