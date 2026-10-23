import 'package:bridge_mobile/core/models.dart';
import 'package:bridge_mobile/core/nav.dart';
import 'package:bridge_mobile/core/store.dart';
import 'package:bridge_mobile/core/theme.dart';
import 'package:bridge_mobile/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The store with no server, seeded the way /api/home and /api/recent would fill it.
Future<void> seed() async {
  SharedPreferences.setMockInitialValues({});
  final s = AppStore.instance;
  await s.init();
  final now = DateTime.now().millisecondsSinceEpoch;
  s.auth = AuthStatus(loggedIn: true, email: 'nestor@example.com', subscriptionType: 'max');
  s.home = HomeData(
    user: 'nestor',
    running: [
      Run(id: 'r1', key: '-p', title: 'Polaris product work', projectName: 'polaris', cwd: '/p', started: now - 492000, prompt: '', model: 'opus', step: 'Running 696 tests', jobs: [
        Job(kind: 'subagent', title: 'Inbox UI', since: now - 300000, agent: 'Engineer'),
      ]),
    ],
    needs: [Need(id: 'n1', key: '-o', title: 'Championship deploy', projectName: 'openrally', ask: 'Deploy the Fly switch now or wait for Alba?', since: now - 120000)],
    made: [Made(path: '/o/GO-LIVE.md', name: 'GO-LIVE.md', ext: 'MD', sessionId: 'n1', key: '-o', sessionTitle: 'Championship deploy', mtime: now - 60000)],
    projects: [HomeProject(key: '-p', name: 'polaris', path: '/p', count: 41, mtime: now)],
  );
  s.recent = [
    SessionMeta.fromJson({'id': 'd1', 'key': '-x', 'title': 'POS nightly sync', 'mtime': now - 3600000}),
    SessionMeta.fromJson({'id': 'd2', 'key': '-x', 'title': 'Bali strategy doc', 'mtime': now - 3 * 86400000}),
  ];
  Nav.instance.view = RootView.home;
  s.changed();
}

Widget app() => MaterialApp(navigatorKey: Nav.instance.navigatorKey, theme: buildTheme(Brightness.dark), home: const Shell());

void main() {
  testWidgets('Home: catch-up, needs you, working now with live jobs, made for you', (tester) async {
    await tester.binding.setSurfaceSize(const Size(402, 874));
    await seed();
    await tester.pumpWidget(app());
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.textContaining(', Nestor'), findsOneWidget); // greeted by the Claude account's name
    expect(find.textContaining('1 thing needs you', findRichText: true), findsOneWidget);
    expect(find.text('Needs you'), findsOneWidget);
    expect(find.text('Deploy the Fly switch now or wait for Alba?'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Running 696 tests'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Working now'), findsOneWidget);
    expect(find.text('Polaris product work'), findsOneWidget);
    expect(find.text('Running 696 tests'), findsOneWidget);
    expect(find.text('Inbox UI'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('GO-LIVE.md'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Recently made for you'), findsOneWidget);
    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('Drawer: places, inbox badge, working now with a timer, chats by day', (tester) async {
    await tester.binding.setSurfaceSize(const Size(402, 874));
    await seed();
    await tester.pumpWidget(app());
    await tester.pump(const Duration(milliseconds: 100));
    Nav.instance.openDrawer();
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    for (final l in ['New chat', 'Search', 'Home', 'Inbox', 'Projects', 'Files', 'Agents & skills']) {
      expect(find.text(l), findsWidgets, reason: l);
    }
    expect(find.descendant(of: find.byType(Drawer), matching: find.text('1')), findsOneWidget); // inbox badge = needs count
    expect(find.text('WORKING NOW'), findsOneWidget);
    expect(find.text('needs you'), findsOneWidget);
    expect(find.textContaining('8m'), findsWidgets); // the running chat's elapsed
    expect(find.text('TODAY'), findsOneWidget);
    expect(find.text('THIS WEEK'), findsOneWidget);
    expect(find.text('POS nightly sync'), findsOneWidget);

    await tester.tap(find.text('Inbox').first);
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    expect(Nav.instance.view, RootView.inbox);
    expect(find.text('Answer'), findsOneWidget);
    await tester.binding.setSurfaceSize(null);
  });
}
