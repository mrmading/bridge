import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Bridge colour tokens. They mirror the desktop client so the two feel like one product.
class Tokens extends ThemeExtension<Tokens> {
  const Tokens({
    required this.bg,
    required this.sunken,
    required this.raised,
    required this.hover,
    required this.active,
    required this.code,
    required this.fg,
    required this.muted,
    required this.faint,
    required this.border,
    required this.borderStrong,
    required this.accent,
    required this.accentFg,
    required this.accentSoft,
    required this.accent2,
    required this.ok,
    required this.okSoft,
    required this.warn,
    required this.warnSoft,
    required this.err,
    required this.errSoft,
    required this.think,
    required this.thinkSoft,
  });

  final Color bg, sunken, raised, hover, active, code;
  final Color fg, muted, faint, border, borderStrong;
  final Color accent, accentFg, accentSoft, accent2;
  final Color ok, okSoft, warn, warnSoft, err, errSoft, think, thinkSoft;

  static const dark = Tokens(
    bg: Color(0xFF080A0F),
    sunken: Color(0xFF06070B),
    raised: Color(0xFF11141B),
    hover: Color(0xFF171B24),
    active: Color(0xFF1E2430),
    code: Color(0xFF0D1016),
    fg: Color(0xFFE9EDF4),
    muted: Color(0xFF98A3B4),
    faint: Color(0xFF667184),
    border: Color(0xFF1D222C),
    borderStrong: Color(0xFF2B3240),
    accent: Color(0xFF4AA8FF),
    accentFg: Color(0xFF02101F),
    accentSoft: Color(0xFF0E2540),
    accent2: Color(0xFF7FD0FF),
    ok: Color(0xFF4ECF95),
    okSoft: Color(0xFF0F2A1F),
    warn: Color(0xFFE3A955),
    warnSoft: Color(0xFF2B2110),
    err: Color(0xFFFF7B72),
    errSoft: Color(0xFF2D1618),
    think: Color(0xFFB79CF5),
    thinkSoft: Color(0xFF1E1830),
  );

  static const light = Tokens(
    bg: Color(0xFFFFFFFF),
    sunken: Color(0xFFF6F7F9),
    raised: Color(0xFFFFFFFF),
    hover: Color(0xFFF0F1F4),
    active: Color(0xFFE8EAEE),
    code: Color(0xFFF6F7F9),
    fg: Color(0xFF12141A),
    muted: Color(0xFF5B6270),
    faint: Color(0xFF8B929E),
    border: Color(0xFFE4E6EA),
    borderStrong: Color(0xFFD3D6DC),
    accent: Color(0xFF1668C9),
    accentFg: Color(0xFFFFFFFF),
    accentSoft: Color(0xFFE8F1FE),
    accent2: Color(0xFF3F9AE0),
    ok: Color(0xFF137A4B),
    okSoft: Color(0xFFE6F5EE),
    warn: Color(0xFF9A5B00),
    warnSoft: Color(0xFFFDF1DE),
    err: Color(0xFFC02828),
    errSoft: Color(0xFFFDECEC),
    think: Color(0xFF7A4FD0),
    thinkSoft: Color(0xFFF2EDFE),
  );

  @override
  Tokens copyWith() => this;

  @override
  Tokens lerp(ThemeExtension<Tokens>? other, double t) => t < 0.5 ? this : (other as Tokens? ?? this);
}

extension TokensX on BuildContext {
  Tokens get t => Theme.of(this).extension<Tokens>()!;
}

ThemeData buildTheme(Brightness b) {
  final k = b == Brightness.dark ? Tokens.dark : Tokens.light;
  final base = ThemeData(brightness: b, useMaterial3: true);
  final scheme = ColorScheme(
    brightness: b,
    primary: k.accent,
    onPrimary: k.accentFg,
    secondary: k.accent2,
    onSecondary: k.accentFg,
    error: k.err,
    onError: Colors.white,
    surface: k.bg,
    onSurface: k.fg,
  );
  final text = base.textTheme.apply(bodyColor: k.fg, displayColor: k.fg);
  return base.copyWith(
    colorScheme: scheme,
    scaffoldBackgroundColor: k.bg,
    canvasColor: k.bg,
    extensions: [k],
    textTheme: text.copyWith(
      bodyLarge: text.bodyLarge?.copyWith(fontSize: 17, height: 1.4),
      bodyMedium: text.bodyMedium?.copyWith(fontSize: 15, height: 1.4),
      bodySmall: text.bodySmall?.copyWith(fontSize: 13, color: k.muted),
      labelSmall: text.labelSmall?.copyWith(fontSize: 11, color: k.faint, letterSpacing: .6),
      titleLarge: text.titleLarge?.copyWith(fontSize: 20, fontWeight: FontWeight.w700),
      titleMedium: text.titleMedium?.copyWith(fontSize: 16, fontWeight: FontWeight.w600),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: k.bg,
      foregroundColor: k.fg,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(color: k.fg, fontSize: 17, fontWeight: FontWeight.w700),
      // Transparent app bars (Home, New chat) cannot guess the status bar colour from their own.
      systemOverlayStyle: b == Brightness.dark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark,
    ),
    dividerColor: k.border,
    splashFactory: NoSplash.splashFactory,
    highlightColor: k.hover,
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: k.raised,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      showDragHandle: true,
      dragHandleColor: k.borderStrong,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: k.raised,
      hintStyle: TextStyle(color: k.faint),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: k.borderStrong)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: k.borderStrong)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: k.accent, width: 1.4)),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: k.sunken,
      indicatorColor: k.active,
      surfaceTintColor: Colors.transparent,
      height: 64,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: s.contains(WidgetState.selected) ? k.accent : k.faint)),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(size: 22, color: s.contains(WidgetState.selected) ? k.accent : k.muted)),
    ),
    snackBarTheme: SnackBarThemeData(backgroundColor: k.fg, contentTextStyle: TextStyle(color: k.bg), behavior: SnackBarBehavior.floating),
    chipTheme: ChipThemeData(backgroundColor: k.active, labelStyle: TextStyle(color: k.muted, fontSize: 12), side: BorderSide.none, padding: const EdgeInsets.symmetric(horizontal: 8)),
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
      TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
      TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
    }),
  );
}
