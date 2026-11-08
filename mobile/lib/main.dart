import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'core/nav.dart';
import 'core/store.dart';
import 'core/theme.dart';
import 'features/agents/agents_screen.dart';
import 'features/auth/login_screen.dart';
import 'features/files/files_screen.dart';
import 'features/home/home_screen.dart';
import 'features/home/new_chat_screen.dart';
import 'features/inbox/inbox_screen.dart';
import 'features/projects/projects_screen.dart';
import 'features/session/session_screen.dart';
import 'features/session/session_utils.dart';
import 'features/starting/starting_screen.dart';
import 'features/shell/drawer.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppStore.instance.load();
  runApp(const BridgeApp());
  unawaited(AppStore.instance.connectSaved());
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
        navigatorKey: Nav.instance.navigatorKey,
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        themeMode: store.themeMode,
        // Before the first answer from the server (boot == null); later reconnects keep the Shell.
        home: store.conn == ConnState.login
            ? const LoginScreen()
            // Until the first answer (and if it never comes) the Starting screen stays: it retries, never asks for a server.
            : store.boot == null
            ? const StartingScreen()
            : const Shell(),
      ),
    );
  }
}

/// The drawer plus one root view (Home, a chat, Inbox, Projects, Files, Agents, New chat).
/// Project pages, files, search and settings push on top.
class Shell extends StatefulWidget {
  const Shell({super.key});
  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> with WidgetsBindingObserver {
  final _store = AppStore.instance;
  final _nav = Nav.instance;
  Set<String> _wasRunning = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _nav.addListener(_onChange);
    _store.addListener(_onStore);
    _wasRunning = _store.home.running.map((r) => r.id).toSet();
  }

  @override
  void dispose() {
    _nav.removeListener(_onChange);
    _store.removeListener(_onStore);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  /// "You can leave, I'll notify you": when a chat stops running, say so wherever the user is.
  void _onStore() {
    final now = _store.home.running.map((r) => r.id).toSet();
    final done = _wasRunning.difference(now);
    _wasRunning = now;
    if (done.isEmpty || !mounted) return;
    final id = done.first;
    if (_nav.view == RootView.chat && _nav.chat?.id == id) return;
    final s = _store.recent.where((r) => r.id == id).firstOrNull;
    final title = s?.title ?? 'A thread';
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text('${_store.needsYou(id) ? 'Needs you' : 'Finished'}: $title', maxLines: 2, overflow: TextOverflow.ellipsis),
        duration: const Duration(seconds: 5),
        action: s == null ? null : SnackBarAction(label: 'Open', onPressed: () => openSession(key: s.key, id: s.id, cwd: s.cwd, title: s.title, computer: s.computer)),
      ));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _store.setForeground(state == AppLifecycleState.resumed);
  }

  Widget _root() {
    switch (_nav.view) {
      case RootView.chat:
        final c = _nav.chat;
        if (c != null) return SessionScreen(key: ValueKey('chat:${c.id}'), chat: c, onMenu: _nav.docked ? null : _nav.openDrawer);
        return const HomeScreen();
      case RootView.newChat:
        return const NewChatScreen();
      case RootView.inbox:
        return const InboxScreen();
      case RootView.projects:
        return const ProjectsScreen();
      case RootView.files:
        return const FilesScreen();
      case RootView.agents:
        return const AgentsScreen();
      case RootView.home:
        return const HomeScreen();
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final dark = Theme.of(context).brightness == Brightness.dark;
    SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: dark ? Brightness.light : Brightness.dark,
      statusBarBrightness: Theme.of(context).brightness,
      systemNavigationBarColor: t.bg,
    ));
    final animated = AnimatedSwitcher(duration: const Duration(milliseconds: 160), child: KeyedSubtree(key: ValueKey('${_nav.view}:${_nav.chat?.id}'), child: _root()));
    final wide = MediaQuery.sizeOf(context).width >= 900;
    _nav.docked = wide;
    if (wide) {
      // Desktop: sidebar docked on the left; the current view and anything pushed from it fill the
      // pane on the right. Screens that need a reading width (a chat) set their own.
      return Scaffold(
        key: _nav.shellKey,
        backgroundColor: t.bg,
        body: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const AppDrawer(docked: true),
          Expanded(
            child: Navigator(
              key: _nav.paneKey,
              onGenerateRoute: (_) => PageRouteBuilder(
                pageBuilder: (context, a, b) => ListenableBuilder(listenable: _nav, builder: (context, _) => AnimatedSwitcher(duration: const Duration(milliseconds: 160), child: KeyedSubtree(key: ValueKey('${_nav.view}:${_nav.chat?.id}'), child: _root()))),
              ),
            ),
          ),
        ]),
      );
    }
    return PopScope(
      // Back from any root view lands on Home before it leaves the app.
      canPop: _nav.view == RootView.home,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _nav.go(RootView.home);
      },
      child: Scaffold(
        key: _nav.shellKey,
        drawer: const AppDrawer(),
        drawerEdgeDragWidth: 48,
        drawerScrimColor: Colors.black.withValues(alpha: .5),
        body: animated,
      ),
    );
  }
}
