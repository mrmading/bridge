import 'package:bridge_mobile/core/models.dart';
import 'package:bridge_mobile/core/store.dart';
import 'package:bridge_mobile/core/theme.dart';
import 'package:bridge_mobile/features/projects/project_actions.dart';
import 'package:bridge_mobile/features/projects/projects_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 12; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

Future<void> seed() async {
  SharedPreferences.setMockInitialValues({'serverOverride': ''});
  final s = AppStore.instance;
  await s.init();
  final now = DateTime.now().millisecondsSinceEpoch;
  s.projects = [
    Project(key: '-home-u-work-alpha', path: '/home/u/work/alpha', name: 'alpha', sessions: 3, lastActivity: now, exists: true),
    Project(key: '-home-u-work-beta', path: '/home/u/work/beta', name: 'beta', sessions: 1, lastActivity: now - 1000, exists: true),
  ];
  s.roots = ['/home/u/work/gamma'];
  s.changed();
}

Widget app() => MaterialApp(theme: buildTheme(Brightness.dark), home: const ProjectsScreen());

void main() {
  test('bridgeProjects lists folders with threads, then Bridge folders with none', () async {
    await seed();
    expect(bridgeProjects(AppStore.instance).map((p) => p.name).toList(), ['alpha', 'beta', 'gamma']);
  });

  testWidgets('Projects: every row has a ⋯ menu with merge and delete', (tester) async {
    await tester.binding.setSurfaceSize(const Size(402, 874));
    await seed();
    await tester.pumpWidget(app());
    await tester.pump();
    expect(find.byTooltip('Project options'), findsNWidgets(3));
    await tester.tap(find.byTooltip('Project options').first);
    await settle(tester);
    expect(find.text('Merge into another project'), findsOneWidget);
    expect(find.text('Delete project'), findsOneWidget);
    expect(find.text('Removes it from Bridge. The folder on disk stays.'), findsOneWidget);
  });

  testWidgets('Merge offers every other project, never the project itself', (tester) async {
    await tester.binding.setSurfaceSize(const Size(402, 874));
    await seed();
    await tester.pumpWidget(app());
    await tester.pump();
    await tester.tap(find.byTooltip('Project options').first);
    await settle(tester);
    await tester.tap(find.text('Merge into another project'));
    await settle(tester);
    expect(find.text('Merge alpha into…'), findsOneWidget);
    expect(find.text('/home/u/work/beta'), findsOneWidget);
    expect(find.text('/home/u/work/gamma'), findsOneWidget);
    expect(find.text('/home/u/work/alpha'), findsNothing);
  });

  testWidgets('Delete asks first and says the folder stays', (tester) async {
    await tester.binding.setSurfaceSize(const Size(402, 874));
    await seed();
    await tester.pumpWidget(app());
    await tester.pump();
    await tester.tap(find.byTooltip('Project options').first);
    await settle(tester);
    await tester.tap(find.text('Delete project'));
    await settle(tester);
    expect(find.text('Delete alpha?'), findsOneWidget);
    expect(find.textContaining("Its 3 threads move to Bridge's trash"), findsOneWidget);
    expect(find.textContaining('/home/u/work/alpha and its files stay on disk'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await settle(tester);
    expect(find.text('Delete alpha?'), findsNothing);
  });
}
