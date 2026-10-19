/// App-wide state: which server, who we are, what is live. One ChangeNotifier, read with
/// `AppStore.of(context)`. Screens call the API through `store.api`.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'models.dart';

enum ConnState { idle, connecting, ready, failed }

class AppStore extends ChangeNotifier {
  AppStore._();
  static final AppStore instance = AppStore._();
  static AppStore of(BuildContext context) => instance;

  late SharedPreferences _prefs;
  BridgeApi? _api;
  BridgeApi get api => _api!;
  bool get hasServer => _api != null && _api!.base.isNotEmpty;

  String serverUrl = '';
  ConnState conn = ConnState.idle;
  String connError = '';
  Bootstrap? boot;
  AuthStatus auth = AuthStatus.signedOut;
  VoiceHealth voice = VoiceHealth.unknown;
  LiveSnapshot live = LiveSnapshot(now: 0, sessions: const [], events: const []);
  List<SessionMeta> recent = const [];
  List<AgentInfo> agents = const [];
  List<String> roots = const [];
  TurnOptions turn = TurnOptions();
  bool speakReplies = true;
  bool handsFree = false;
  ThemeMode themeMode = ThemeMode.system;
  /// The id of a session this app started that is still running (sessionId → cwd).
  final Map<String, String> runningTurns = {};

  Timer? _liveTimer;
  bool _foreground = true;

  String get assistantName => boot?.assistant.isNotEmpty == true ? boot!.assistant : 'Assistant';
  Color get accent {
    final c = boot?.color ?? '';
    final m = RegExp(r'^#?([0-9a-fA-F]{6})$').firstMatch(c);
    return m == null ? const Color(0xFF4AA8FF) : Color(int.parse('FF${m.group(1)}', radix: 16));
  }

  int get waitingCount => live.sessions.where((s) => s.waiting != null).length;

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    serverUrl = _prefs.getString('server') ?? _defaultServer();
    speakReplies = _prefs.getBool('speak') ?? true;
    handsFree = _prefs.getBool('handsFree') ?? false;
    themeMode = ThemeMode.values[_prefs.getInt('theme') ?? 0];
    try {
      turn = TurnOptions.fromJson(jsonDecode(_prefs.getString('turn') ?? '{}') as Map<String, dynamic>);
    } catch (_) {}
    if (serverUrl.isNotEmpty) await connect(serverUrl);
  }

  /// On the web the app is served by the Bridge server itself, so the page origin is the server.
  String _defaultServer() {
    if (kIsWeb) {
      final u = Uri.base;
      if (u.host.isNotEmpty && u.host != 'localhost' || u.port == 4270 || u.port == 4271) return '${u.scheme}://${u.host}${u.hasPort ? ':${u.port}' : ''}';
    }
    return '';
  }

  Future<bool> connect(String url) async {
    serverUrl = url.trim();
    _api?.close();
    _api = BridgeApi(serverUrl);
    conn = ConnState.connecting;
    connError = '';
    notifyListeners();
    try {
      boot = await api.bootstrap();
      auth = boot!.auth;
      conn = ConnState.ready;
      await _prefs.setString('server', serverUrl);
      notifyListeners();
      unawaited(refreshAll());
      _startLivePolling();
      return true;
    } catch (e) {
      conn = ConnState.failed;
      connError = e.toString();
      notifyListeners();
      return false;
    }
  }

  Future<void> refreshAll() async {
    if (!hasServer || conn != ConnState.ready) return;
    final results = await Future.wait<dynamic>([
      api.voiceHealth().catchError((_) => VoiceHealth.unknown),
      api.recent(limit: 80).catchError((_) => <SessionMeta>[]),
      api.agents().catchError((_) => <AgentInfo>[]),
      api.roots().catchError((_) => <String>[]),
    ]);
    voice = results[0] as VoiceHealth;
    recent = results[1] as List<SessionMeta>;
    agents = results[2] as List<AgentInfo>;
    roots = results[3] as List<String>;
    notifyListeners();
  }

  Future<void> refreshRecent() async {
    if (!hasServer) return;
    recent = await api.recent(limit: 80).catchError((_) => recent);
    notifyListeners();
  }

  Future<void> refreshAuth() async {
    if (!hasServer) return;
    auth = await api.auth(fresh: true).catchError((_) => auth);
    notifyListeners();
  }

  void _startLivePolling() {
    _liveTimer?.cancel();
    _liveTimer = Timer.periodic(const Duration(seconds: 5), (_) => pollLive());
    pollLive();
  }

  Future<void> pollLive() async {
    if (!hasServer || !_foreground || conn != ConnState.ready) return;
    try {
      live = await api.live();
      notifyListeners();
    } catch (_) {}
  }

  void setForeground(bool fg) {
    _foreground = fg;
    if (fg) pollLive();
  }

  Future<void> setTurn(TurnOptions t) async {
    turn = t;
    await _prefs.setString('turn', jsonEncode(t.toJson()));
    notifyListeners();
  }

  Future<void> setSpeak(bool v) async {
    speakReplies = v;
    await _prefs.setBool('speak', v);
    notifyListeners();
  }

  Future<void> setHandsFree(bool v) async {
    handsFree = v;
    await _prefs.setBool('handsFree', v);
    notifyListeners();
  }

  Future<void> setTheme(ThemeMode m) async {
    themeMode = m;
    await _prefs.setInt('theme', m.index);
    notifyListeners();
  }

  Future<void> forgetServer() async {
    _liveTimer?.cancel();
    _api?.close();
    _api = null;
    serverUrl = '';
    boot = null;
    conn = ConnState.idle;
    await _prefs.remove('server');
    notifyListeners();
  }
}
