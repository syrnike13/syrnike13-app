import 'package:flutter/material.dart';

@immutable
class SyrnikeThemeColors extends ThemeExtension<SyrnikeThemeColors> {
  const SyrnikeThemeColors({
    required this.background,
    required this.foreground,
    required this.card,
    required this.primary,
    required this.primaryForeground,
    required this.secondary,
    required this.muted,
    required this.mutedForeground,
    required this.accent,
    required this.destructive,
    required this.border,
    required this.input,
    required this.sidebar,
    required this.sidebarForeground,
    required this.sidebarPrimary,
    required this.sidebarAccent,
    required this.sidebarBorder,
    required this.shellDivider,
  });

  final Color background;
  final Color foreground;
  final Color card;
  final Color primary;
  final Color primaryForeground;
  final Color secondary;
  final Color muted;
  final Color mutedForeground;
  final Color accent;
  final Color destructive;
  final Color border;
  final Color input;
  final Color sidebar;
  final Color sidebarForeground;
  final Color sidebarPrimary;
  final Color sidebarAccent;
  final Color sidebarBorder;
  final Color shellDivider;

  @override
  SyrnikeThemeColors copyWith({
    Color? background,
    Color? foreground,
    Color? card,
    Color? primary,
    Color? primaryForeground,
    Color? secondary,
    Color? muted,
    Color? mutedForeground,
    Color? accent,
    Color? destructive,
    Color? border,
    Color? input,
    Color? sidebar,
    Color? sidebarForeground,
    Color? sidebarPrimary,
    Color? sidebarAccent,
    Color? sidebarBorder,
    Color? shellDivider,
  }) {
    return SyrnikeThemeColors(
      background: background ?? this.background,
      foreground: foreground ?? this.foreground,
      card: card ?? this.card,
      primary: primary ?? this.primary,
      primaryForeground: primaryForeground ?? this.primaryForeground,
      secondary: secondary ?? this.secondary,
      muted: muted ?? this.muted,
      mutedForeground: mutedForeground ?? this.mutedForeground,
      accent: accent ?? this.accent,
      destructive: destructive ?? this.destructive,
      border: border ?? this.border,
      input: input ?? this.input,
      sidebar: sidebar ?? this.sidebar,
      sidebarForeground: sidebarForeground ?? this.sidebarForeground,
      sidebarPrimary: sidebarPrimary ?? this.sidebarPrimary,
      sidebarAccent: sidebarAccent ?? this.sidebarAccent,
      sidebarBorder: sidebarBorder ?? this.sidebarBorder,
      shellDivider: shellDivider ?? this.shellDivider,
    );
  }

  @override
  SyrnikeThemeColors lerp(ThemeExtension<SyrnikeThemeColors>? other, double t) {
    if (other is! SyrnikeThemeColors) return this;
    return SyrnikeThemeColors(
      background: Color.lerp(background, other.background, t)!,
      foreground: Color.lerp(foreground, other.foreground, t)!,
      card: Color.lerp(card, other.card, t)!,
      primary: Color.lerp(primary, other.primary, t)!,
      primaryForeground: Color.lerp(
        primaryForeground,
        other.primaryForeground,
        t,
      )!,
      secondary: Color.lerp(secondary, other.secondary, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      mutedForeground: Color.lerp(mutedForeground, other.mutedForeground, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      destructive: Color.lerp(destructive, other.destructive, t)!,
      border: Color.lerp(border, other.border, t)!,
      input: Color.lerp(input, other.input, t)!,
      sidebar: Color.lerp(sidebar, other.sidebar, t)!,
      sidebarForeground: Color.lerp(
        sidebarForeground,
        other.sidebarForeground,
        t,
      )!,
      sidebarPrimary: Color.lerp(sidebarPrimary, other.sidebarPrimary, t)!,
      sidebarAccent: Color.lerp(sidebarAccent, other.sidebarAccent, t)!,
      sidebarBorder: Color.lerp(sidebarBorder, other.sidebarBorder, t)!,
      shellDivider: Color.lerp(shellDivider, other.shellDivider, t)!,
    );
  }
}

const _lightColors = SyrnikeThemeColors(
  background: Color(0xFFFBFBFB),
  foreground: Color(0xFF28282D),
  card: Color(0xFFFFFFFF),
  primary: Color(0xFF5865F2),
  primaryForeground: Color(0xFFFFFFFF),
  secondary: Color(0xFFF2F2F3),
  muted: Color(0xFFF0F0F1),
  mutedForeground: Color(0xFF5C5D67),
  accent: Color(0xFFE9E9EC),
  destructive: Color(0xFFB92733),
  border: Color(0xFFD4D4D7),
  input: Color(0xFFF6F6F8),
  sidebar: Color(0xFFF3F3F4),
  sidebarForeground: Color(0xFF666770),
  sidebarPrimary: Color(0xFFDDDDE0),
  sidebarAccent: Color(0xFFE7E7E9),
  sidebarBorder: Color(0xFFD9D9DC),
  shellDivider: Color(0xFFD9D9DC),
);

const _darkColors = SyrnikeThemeColors(
  background: Color(0xFF323339),
  foreground: Color(0xFFFFFFFF),
  card: Color(0xFF393A41),
  primary: Color(0xFF5865F2),
  primaryForeground: Color(0xFFFFFFFF),
  secondary: Color(0xFF414148),
  muted: Color(0xFF2E2F35),
  mutedForeground: Color(0xFFA4A5AB),
  accent: Color(0xFF484951),
  destructive: Color(0xFFFFA09B),
  border: Color(0xFF3E3F45),
  input: Color(0xFF2E2F35),
  sidebar: Color(0xFF2C2D32),
  sidebarForeground: Color(0xFF999AA1),
  sidebarPrimary: Color(0xFF414248),
  sidebarAccent: Color(0xFF35353A),
  sidebarBorder: Color(0xFF393A3F),
  shellDivider: Color(0xFF505157),
);

ThemeData buildSyrnikeTheme(Brightness brightness) {
  final colors = brightness == Brightness.dark ? _darkColors : _lightColors;
  final scheme = _colorScheme(brightness, colors);
  final textTheme = _textTheme(brightness, colors);

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: colors.background,
    canvasColor: colors.background,
    dividerColor: colors.shellDivider,
    textTheme: textTheme,
    extensions: <ThemeExtension<dynamic>>[colors],
    appBarTheme: AppBarTheme(
      centerTitle: false,
      backgroundColor: colors.background,
      foregroundColor: colors.foreground,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
    ),
    cardTheme: CardThemeData(
      clipBehavior: Clip.antiAlias,
      color: colors.card,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shadowColor: Colors.black.withValues(alpha: 0.10),
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: colors.border),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: ButtonStyle(
        minimumSize: const WidgetStatePropertyAll(Size.fromHeight(36)),
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(horizontal: 16),
        ),
        backgroundColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.disabled)) {
            return colors.primary.withValues(alpha: 0.50);
          }
          return colors.primary;
        }),
        foregroundColor: WidgetStatePropertyAll(colors.primaryForeground),
        textStyle: WidgetStatePropertyAll(
          textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600),
        ),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: ButtonStyle(
        minimumSize: const WidgetStatePropertyAll(Size.fromHeight(36)),
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(horizontal: 16),
        ),
        foregroundColor: WidgetStatePropertyAll(colors.foreground),
        side: WidgetStateProperty.resolveWith((states) {
          final color = states.contains(WidgetState.disabled)
              ? colors.border.withValues(alpha: 0.55)
              : colors.border;
          return BorderSide(color: color);
        }),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: ButtonStyle(
        minimumSize: const WidgetStatePropertyAll(Size(0, 32)),
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(horizontal: 8),
        ),
        foregroundColor: WidgetStatePropertyAll(colors.primary),
        textStyle: WidgetStatePropertyAll(
          textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w500),
        ),
        overlayColor: WidgetStatePropertyAll(
          colors.accent.withValues(alpha: 0.62),
        ),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: brightness == Brightness.dark
          ? colors.secondary
          : colors.muted.withValues(alpha: 0.40),
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      hintStyle: TextStyle(color: colors.mutedForeground),
      labelStyle: TextStyle(color: colors.foreground),
      errorStyle: TextStyle(color: colors.destructive),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(
          color: brightness == Brightness.dark ? colors.border : colors.input,
        ),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: colors.primary, width: 1.5),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: colors.destructive),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: colors.destructive, width: 1.5),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: ButtonStyle(
        foregroundColor: WidgetStatePropertyAll(colors.foreground),
        overlayColor: WidgetStatePropertyAll(
          colors.accent.withValues(alpha: 0.72),
        ),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
      ),
    ),
    listTileTheme: ListTileThemeData(
      iconColor: colors.mutedForeground,
      textColor: colors.foreground,
      selectedColor: colors.foreground,
      selectedTileColor: colors.accent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: colors.foreground,
      contentTextStyle: TextStyle(color: colors.background),
      behavior: SnackBarBehavior.floating,
    ),
  );
}

ColorScheme _colorScheme(Brightness brightness, SyrnikeThemeColors colors) {
  return ColorScheme(
    brightness: brightness,
    primary: colors.primary,
    onPrimary: colors.primaryForeground,
    primaryContainer: colors.primary.withValues(alpha: 0.16),
    onPrimaryContainer: colors.primary,
    secondary: colors.secondary,
    onSecondary: colors.foreground,
    secondaryContainer: colors.secondary,
    onSecondaryContainer: colors.foreground,
    tertiary: colors.accent,
    onTertiary: colors.foreground,
    tertiaryContainer: colors.accent,
    onTertiaryContainer: colors.foreground,
    error: colors.destructive,
    onError: colors.primaryForeground,
    errorContainer: colors.destructive.withValues(alpha: 0.12),
    onErrorContainer: colors.destructive,
    surface: colors.background,
    onSurface: colors.foreground,
    surfaceContainerLowest: colors.background,
    surfaceContainerLow: colors.card,
    surfaceContainer: colors.secondary,
    surfaceContainerHigh: colors.muted,
    surfaceContainerHighest: colors.accent,
    onSurfaceVariant: colors.mutedForeground,
    outline: colors.border,
    outlineVariant: colors.shellDivider,
    shadow: Colors.black,
    scrim: Colors.black,
    inverseSurface: colors.foreground,
    onInverseSurface: colors.background,
    inversePrimary: colors.primary,
    surfaceTint: Colors.transparent,
  );
}

TextTheme _textTheme(Brightness brightness, SyrnikeThemeColors colors) {
  final base = brightness == Brightness.dark
      ? Typography.material2021().white
      : Typography.material2021().black;

  return base
      .apply(bodyColor: colors.foreground, displayColor: colors.foreground)
      .copyWith(
        titleLarge: base.titleLarge?.copyWith(
          color: colors.foreground,
          fontSize: 20,
          fontWeight: FontWeight.w700,
          letterSpacing: 0,
        ),
        titleMedium: base.titleMedium?.copyWith(
          color: colors.foreground,
          fontSize: 16,
          fontWeight: FontWeight.w600,
          letterSpacing: 0,
        ),
        bodyLarge: base.bodyLarge?.copyWith(
          color: colors.foreground,
          fontSize: 16,
          letterSpacing: 0,
        ),
        bodyMedium: base.bodyMedium?.copyWith(
          color: colors.foreground,
          fontSize: 14,
          letterSpacing: 0,
        ),
        bodySmall: base.bodySmall?.copyWith(
          color: colors.mutedForeground,
          fontSize: 12,
          letterSpacing: 0,
        ),
        labelLarge: base.labelLarge?.copyWith(
          color: colors.foreground,
          fontSize: 14,
          fontWeight: FontWeight.w600,
          letterSpacing: 0,
        ),
        labelMedium: base.labelMedium?.copyWith(
          color: colors.foreground,
          fontSize: 13,
          fontWeight: FontWeight.w600,
          letterSpacing: 0,
        ),
      );
}
