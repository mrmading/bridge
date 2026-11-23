import 'package:bridge_mobile/core/store.dart';
import 'package:bridge_mobile/core/theme.dart';
import 'package:bridge_mobile/features/starting/starting_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('launch on the sprite says Paquito is starting, and counts up while it wakes', (tester) async {
    SharedPreferences.setMockInitialValues({'serverOverride': 'https://bridge-x2x6.sprites.app'});
    final s = AppStore.instance;
    await s.load();
    expect(s.conn, ConnState.connecting, reason: 'the first frame already shows the starting screen');
    s.connectStarted = DateTime.now().subtract(const Duration(seconds: 12));
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.dark), home: const StartingScreen()));
    expect(find.text('Starting Paquito machine'), findsOneWidget);
    expect(find.textContaining('can take up to a minute'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a machine that never answers gets a retry, never a server form', (tester) async {
    SharedPreferences.setMockInitialValues({'serverOverride': 'https://bridge-x2x6.sprites.app'});
    final s = AppStore.instance;
    await s.load();
    s.conn = ConnState.failed;
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.dark), home: const StartingScreen()));
    expect(find.text("Can't reach your machine"), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
