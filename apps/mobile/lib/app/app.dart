import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'router.dart';
import 'theme.dart';

class SyrnikeMobileApp extends ConsumerWidget {
  const SyrnikeMobileApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: const SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: Brightness.light,
        statusBarBrightness: Brightness.dark,
        systemNavigationBarColor: Color(0xFF323339),
        systemNavigationBarIconBrightness: Brightness.light,
      ),
      child: MaterialApp.router(
        title: 'syrnike13',
        debugShowCheckedModeBanner: false,
        theme: buildSyrnikeTheme(Brightness.light),
        darkTheme: buildSyrnikeTheme(Brightness.dark),
        themeMode: ThemeMode.dark,
        routerConfig: router,
      ),
    );
  }
}
