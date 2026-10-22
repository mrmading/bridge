import 'package:bridge_mobile/core/models.dart';
import 'package:bridge_mobile/core/nav.dart';
import 'package:bridge_mobile/core/store.dart';
import 'package:bridge_mobile/core/theme.dart';
import 'package:bridge_mobile/main.dart';
import 'package:bridge_mobile/widgets/bridge.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

final mac = Computer(id: 'mac', name: 'Mac', kind: 'local', online: true);
Computer cloud({bool online = true}) => Computer(id: 'cloud', name: 'Cloud computer', kind: 'remote', online: online, url: 'https://bridge-x2x6.sprites.app', reason: online ? '' : 'Sprite is asleep');

Future<AppStore> fresh() async {
  SharedPreferences.setMockInitialValues({});
  final s = AppStore.instance;
  await s.init();
  s.auth = AuthStatus(loggedIn: true, email: 'nestor@example.com');
  s.home = HomeData();
  s.recent = const [];
  s.debugSetComputers(const []);
  Nav.instance.view = RootView.home;
  return s;
}

void main() {
  test('computer fields default to the Mac; only "cloud" is the cloud', () {
    expect(SessionMeta.fromJson({'id': 'a'}).computer, 'mac');
    expect(SessionMeta.fromJson({'id': 'a', 'computer': 'cloud'}).computer, 'cloud');
    expect(SessionMeta.fromJson({'id': 'a', 'computer': 'weird'}).computer, 'mac');
    final h = HomeData.fromJson({
      'cloudOffline': true,
      'running': [{'id': 'r', 'computer': 'cloud'}],
      'needs': [{'id': 'n'}],
      'made': [{'path': '/a.md', 'computer': 'cloud'}],
    });
    expect(h.cloudOffline, isTrue);
    expect(h.running.single.computer, 'cloud');
    expect(h.needs.single.computer, 'mac');
    expect(h.made.single.computer, 'cloud');
    expect(HomeData.fromJson({}).cloudOffline, isFalse);
  });

  test('computers parse leniently', () {
    final c = Computer.fromJson({'id': 'cloud', 'online': false, 'error': 'asleep'});
    expect(c.isCloud, isTrue);
    expect(c.name, 'Cloud computer');
    expect(c.online, isFalse);
    expect(c.reason, 'asleep');
    expect(Computer.fromJson({'id': 'cloud', 'configured': false}).configured, isFalse);
    final m = Computer.fromJson({});
    expect(m.id, 'mac');
    expect(m.online, isTrue);
  });

  Widget app() => MaterialApp(navigatorKey: Nav.instance.navigatorKey, theme: buildTheme(Brightness.dark), home: const Shell());

  testWidgets('cloud chats carry a badge in the drawer and Home warns when the cloud is offline', (tester) async {
    await tester.binding.setSurfaceSize(const Size(402, 874));
    final s = await fresh();
    s.debugSetComputers([mac, cloud(online: false)]);
    final now = DateTime.now().millisecondsSinceEpoch;
    s.home = HomeData(needs: [Need(id: 'n1', key: 'k', title: 'Cloud question', projectName: 'p', ask: 'Ship it?', since: now, computer: 'cloud')]);
    s.recent = [SessionMeta.fromJson({'id': 'm1', 'key': 'k', 'title': 'Mac chat', 'mtime': now})];
    s.changed();
    await tester.pumpWidget(app());
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Cloud computer offline'), findsOneWidget);
    expect(find.textContaining('Sprite is asleep'), findsOneWidget);
    expect(find.byType(CloudBadge), findsOneWidget); // the Need card
    Nav.instance.openDrawer();
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    final drawer = find.byType(Drawer);
    expect(find.descendant(of: drawer, matching: find.byType(CloudBadge)), findsOneWidget);
    await tester.binding.setSurfaceSize(null);
  });
}
