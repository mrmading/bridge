import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'core/store.dart';
import 'core/theme.dart';
import 'features/assistant/assistant_tab.dart';
import 'features/onboarding/onboarding_screen.dart';
import 'features/projects/projects_tab.dart';
import 'features/sessions/sessions_tab.dart';
import 'features/settings/settings_tab.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppStore.instance.init();
  runApp(const BridgeApp());
}

class BridgeApp extends StatelessWidget {
  const BridgeApp({super.key});
  @override
  Widget build(BuildContext context) {
    final store = AppStore.instance;
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) => MaterialApp(
        title: 'Bridge',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        themeMode: store.themeMode,
        home: store.hasServer && store.conn != ConnState.failed ? const Shell() : const OnboardingScreen(),
      ),
    );
  }
}

/// The four tabs. The tab bar is the only persistent chrome; everything else is a push.
class Shell extends StatefulWidget {
  const Shell({super.key});
  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> with WidgetsBindingObserver {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    AssistantTab.requestedTab.addListener(_onRequestedTab);
  }

  void _onRequestedTab() {
    final v = AssistantTab.requestedTab.value;
    if (v >= 0 && mounted) {
      setState(() => _tab = v);
      AssistantTab.requestedTab.value = -1;
    }
  }

  @override
  void dispose() {
    AssistantTab.requestedTab.removeListener(_onRequestedTab);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    AppStore.instance.setForeground(state == AppLifecycleState.resumed);
  }

  @override
  Widget build(BuildContext context) {
    final store = AppStore.of(context);
    final t = context.t;
    SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Theme.of(context).brightness == Brightness.dark ? Brightness.light : Brightness.dark,
      statusBarBrightness: Theme.of(context).brightness,
      systemNavigationBarColor: t.sunken,
    ));
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) => Scaffold(
        body: IndexedStack(index: _tab, children: const [AssistantTab(), SessionsTab(), ProjectsTab(), SettingsTab()]),
        bottomNavigationBar: Container(
          decoration: BoxDecoration(border: Border(top: BorderSide(color: t.border))),
          child: NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: (i) => setState(() => _tab = i),
            labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
            destinations: [
              NavigationDestination(icon: const Icon(Icons.blur_on_rounded), selectedIcon: const Icon(Icons.blur_circular_rounded), label: store.assistantName),
              NavigationDestination(
                icon: Badge(isLabelVisible: store.waitingCount > 0, label: Text('${store.waitingCount}'), backgroundColor: t.err, child: const Icon(Icons.forum_outlined)),
                selectedIcon: Badge(isLabelVisible: store.waitingCount > 0, label: Text('${store.waitingCount}'), backgroundColor: t.err, child: const Icon(Icons.forum_rounded)),
                label: 'Sessions',
              ),
              const NavigationDestination(icon: Icon(Icons.folder_outlined), selectedIcon: Icon(Icons.folder_rounded), label: 'Projects'),
              const NavigationDestination(icon: Icon(Icons.tune_rounded), selectedIcon: Icon(Icons.tune_rounded), label: 'Settings'),
            ],
          ),
        ),
      ),
    );
  }
}
