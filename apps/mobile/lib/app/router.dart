import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/application/auth_controller.dart';
import '../features/auth/presentation/login_screen.dart';
import '../features/mobile/presentation/mobile_discord_shell.dart';

final appRouterProvider = Provider<GoRouter>((ref) {
  final refreshListenable = ValueNotifier<AuthPhase>(AuthPhase.loading);

  ref
    ..listen<AuthState>(authControllerProvider, (_, next) {
      refreshListenable.value = next.phase;
    })
    ..onDispose(refreshListenable.dispose);

  return GoRouter(
    initialLocation: '/login',
    refreshListenable: refreshListenable,
    routes: [
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      GoRoute(
        path: '/login/register',
        builder: (context, state) => const RegisterScreen(),
      ),
      GoRoute(
        path: '/login/onboard',
        builder: (context, state) => const OnboardScreen(),
      ),
      GoRoute(
        path: '/app',
        builder: (context, state) => const MobileDiscordShell(),
      ),
    ],
    redirect: (context, state) {
      final auth = ref.read(authControllerProvider);
      final location = state.matchedLocation;

      if (auth.phase == AuthPhase.loading) return null;

      final isAuthRoute =
          location == '/login' ||
          location == '/login/register' ||
          location == '/login/onboard';
      final isOnboard = location == '/login/onboard';

      if (!auth.isAuthenticated && !isAuthRoute) return '/login';
      if (!auth.isAuthenticated && isOnboard) return '/login';
      if (auth.phase == AuthPhase.onboardingRequired && !isOnboard) {
        return '/login/onboard';
      }
      if (auth.phase == AuthPhase.authenticated && isAuthRoute) return '/app';

      return null;
    },
  );
});
