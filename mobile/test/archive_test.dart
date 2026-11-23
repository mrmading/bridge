// Archived threads: the "Archived" chip on list rows and the muted "screenshot" line where an image used to be.
import 'package:bridge_mobile/core/models.dart';
import 'package:bridge_mobile/core/nav.dart';
import 'package:bridge_mobile/core/store.dart';
import 'package:bridge_mobile/core/theme.dart';
import 'package:bridge_mobile/main.dart';
import 'package:bridge_mobile/widgets/common.dart';
import 'package:bridge_mobile/widgets/transcript.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

Widget app(Widget child) => MaterialApp(theme: buildTheme(Brightness.dark), home: Scaffold(body: SingleChildScrollView(child: child)));

void main() {
  test('SessionMeta and Transcript carry the archived flag; it defaults to false', () {
    expect(SessionMeta.fromJson({'id': 'a', 'key': '-k', 'title': 'Old', 'archived': true}).archived, isTrue);
    expect(SessionMeta.fromJson({'id': 'b', 'key': '-k', 'title': 'New'}).archived, isFalse);
    expect(Transcript.fromJson({'events': [], 'meta': {'archived': true}}).archived, isTrue);
    expect(Transcript.fromJson({'events': [], 'meta': {}}).archived, isFalse);
  });

  test('archived notes are recognised and split from ordinary text', () {
    expect(archivedNote('[screenshot archived: Login page with an error banner.]'), (kind: 'screenshot', text: 'Login page with an error banner.'));
    expect(archivedNote('[image archived: A photo of a padel court.]'), (kind: 'image', text: 'A photo of a padel court.'));
    expect(archivedNote('[screenshot archived: not closed'), isNull);
    expect(archivedNote('plain result text'), isNull);
    final s = splitArchived('Screenshot taken\n[screenshot archived: Dashboard with three cards.]\nDone');
    expect(s.notes.single.text, 'Dashboard with three cards.');
    expect(s.rest, 'Screenshot taken\nDone');
  });

  testWidgets('a tool card renders an archived screenshot as a muted italic line, not raw text', (tester) async {
    await tester.binding.setSurfaceSize(const Size(402, 874));
    final msg = Msg(
      kind: 'tool',
      id: 't1',
      name: 'Read',
      input: {'file_path': '/shots/login.png'},
      result: ToolResult(content: 'Screenshot taken\n[screenshot archived: Login page with a red error banner saying wrong password.]', isError: false),
    );
    await tester.pumpWidget(app(ToolCard(msg: msg)));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.byType(InkWell).first);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(ArchivedImageLine), findsOneWidget);
    expect(find.textContaining('[screenshot archived:'), findsNothing);
    // the description is italic and muted; the remaining result text keeps its mono block
    final rich = tester.widget<Text>(find.descendant(of: find.byType(ArchivedImageLine), matching: find.byType(Text)));
    final spans = (rich.textSpan as TextSpan).children!.cast<TextSpan>();
    expect(spans.first.text, 'Screenshot · ');
    expect(spans.last.text, 'Login page with a red error banner saying wrong password.');
    expect(spans.last.style!.fontStyle, FontStyle.italic);
    final t = buildTheme(Brightness.dark).extension<Tokens>()!;
    expect(spans.last.style!.color, t.muted);
    expect(find.text('Screenshot taken'), findsOneWidget);
  });

  testWidgets('a pasted image the policy archived shows under the user bubble', (tester) async {
    await tester.binding.setSurfaceSize(const Size(402, 874));
    await tester.pumpWidget(app(const UserBubble(text: 'what is this?\n[image archived: A photo of a padel court at night.]')));
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('what is this?'), findsOneWidget);
    expect(find.byType(ArchivedImageLine), findsOneWidget);
    expect(find.textContaining('[image archived:'), findsNothing);
  });

  testWidgets('the Archived chip', (tester) async {
    await tester.pumpWidget(app(const Row(children: [ArchivedChip()])));
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Archived'), findsOneWidget);
    expect(find.byIcon(Icons.inventory_2_outlined), findsOneWidget);
  });

  testWidgets('the drawer marks an archived thread with the chip and leaves the others alone', (tester) async {
    await tester.binding.setSurfaceSize(const Size(402, 874));
    SharedPreferences.setMockInitialValues({'serverOverride': ''});
    final s = AppStore.instance;
    await s.init();
    final now = DateTime.now().millisecondsSinceEpoch;
    s.auth = AuthStatus(loggedIn: true, email: 'nestor@example.com', subscriptionType: 'max');
    s.home = HomeData(user: 'nestor');
    s.recent = [
      SessionMeta.fromJson({'id': 'fresh', 'key': '-x', 'title': 'POS nightly sync', 'mtime': now - 3600000}),
      SessionMeta.fromJson({'id': 'old', 'key': '-x', 'title': 'Championship screenshots', 'mtime': now - 45 * 86400000, 'archived': true}),
    ];
    Nav.instance.view = RootView.home;
    s.changed();
    await tester.pumpWidget(MaterialApp(navigatorKey: Nav.instance.navigatorKey, theme: buildTheme(Brightness.dark), home: const Shell()));
    await tester.pump(const Duration(milliseconds: 100));
    Nav.instance.openDrawer();
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    final drawer = find.byType(Drawer);
    expect(find.descendant(of: drawer, matching: find.text('Championship screenshots')), findsOneWidget);
    expect(find.descendant(of: drawer, matching: find.byType(ArchivedChip)), findsOneWidget);
    // the chip sits on the archived row, not the fresh one
    final chipRow = find.ancestor(of: find.byType(ArchivedChip), matching: find.byType(Row)).first;
    expect(find.descendant(of: chipRow, matching: find.text('Championship screenshots')), findsOneWidget);
    expect(find.descendant(of: chipRow, matching: find.text('POS nightly sync')), findsNothing);
  });
}
