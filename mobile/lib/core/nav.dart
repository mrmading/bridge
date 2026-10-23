/// Where the app is: one root view behind the drawer (home, a chat, inbox, projects, files,
/// agents, new chat) plus whatever is pushed on top (project page, file, settings). Every screen
/// moves through here so the drawer, Home cards and Inbox all open things the same way.
library;

import 'dart:math';

import 'package:flutter/material.dart';

/// Everything needed to open (or start) one chat.
class ChatRef {
  ChatRef({required this.key, required this.id, required this.cwd, this.title = '', this.isNew = false, this.prefill = '', this.sendPrefill = false, this.focus = false, this.computer = 'mac'});
  final String key, id, cwd, title, prefill;
  /// mac · cloud: every per-chat call names it for cloud chats.
  final String computer;
  final bool isNew, sendPrefill, focus;
}

enum RootView { home, newChat, chat, inbox, projects, files, agents }

class Nav extends ChangeNotifier {
  Nav._();
  static final Nav instance = Nav._();

  final navigatorKey = GlobalKey<NavigatorState>();
  final shellKey = GlobalKey<ScaffoldState>();

  RootView view = RootView.home;
  ChatRef? chat;
  /// Project folder preselected in the New chat composer, and text to start it with.
  String newChatCwd = '';
  String newChatText = '';
  /// Bumped to ask the visible composer to take focus (e.g. after "Give a task").
  final ValueNotifier<int> focusComposer = ValueNotifier(0);

  void _toRoot() {
    final nav = navigatorKey.currentState;
    nav?.popUntil((r) => r.isFirst);
    final s = shellKey.currentState;
    if (s != null && s.isDrawerOpen) s.closeDrawer();
  }

  void go(RootView v) {
    _toRoot();
    view = v;
    if (v != RootView.chat) chat = null;
    notifyListeners();
  }

  void openChat(ChatRef c) {
    _toRoot();
    view = RootView.chat;
    chat = c;
    notifyListeners();
  }

  /// A brand-new chat in [cwd]; [message] is sent right away when set.
  void startChat({required String cwd, String message = '', String computer = 'mac'}) => openChat(ChatRef(
        computer: computer,
        key: projectKeyFor(cwd),
        id: uuidV4(),
        cwd: cwd,
        isNew: true,
        prefill: message,
        sendPrefill: message.trim().isNotEmpty,
        focus: message.trim().isEmpty,
      ));

  void newChat({String cwd = '', String text = ''}) {
    newChatCwd = cwd;
    newChatText = text;
    go(RootView.newChat);
    focusComposer.value++;
  }

  void openDrawer() => shellKey.currentState?.openDrawer();

  Future<T?> push<T>(Widget page) {
    final s = shellKey.currentState;
    if (s != null && s.isDrawerOpen) s.closeDrawer();
    return navigatorKey.currentState!.push<T>(MaterialPageRoute(builder: (_) => page));
  }
}

final _rng = Random.secure();

/// RFC 4122 v4 uuid, lower-case, no package.
String uuidV4() {
  final b = List<int>.generate(16, (_) => _rng.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// Same encoding as the server (contract §2): every non-alphanumeric char becomes `-`.
/// Lossy: never decode a key back into a path.
String projectKeyFor(String cwd) => cwd.replaceAll(RegExp(r'[^A-Za-z0-9]'), '-');
