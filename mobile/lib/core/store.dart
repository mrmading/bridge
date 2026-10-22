/// App-wide state: which server, who we are, what is running and waiting. One ChangeNotifier,
/// read with `AppStore.of(context)`. Screens call the API through `store.api`.
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
  /// Needs you · working now · made for you · projects. Polled every 5 s in the foreground.
  HomeData home = HomeData.empty;
  List<SessionMeta> recent = const [];
  List<Project> projects = const [];
  List<AgentInfo> agents = const [];
  List<String> roots = const [];
  TurnOptions turn = TurnOptions();
  bool speakReplies = true;
  bool handsFree = false;
  /// Settings › Advanced: raw tool calls in chats instead of the one-line work summary.
  bool showTech = false;
  ThemeMode themeMode = ThemeMode.system;

  Timer? _homeTimer;
  int _homeTicks = 0;
  bool _foreground = true;

  String get assistantName => boot?.assistant.isNotEmpty == true ? boot!.assistant : 'Assistant';
  Color get accent {
    final c = boot?.color ?? '';
    final m = RegExp(r'^#?([0-9a-fA-F]{6})$').firstMatch(c);
    return m == null ? const Color(0xFF4AA8FF) : Color(int.parse('FF${m.group(1)}', radix: 16));
  }

  int get waitingCount => home.needs.length;
  bool isRunning(String id) => home.running.any((r) => r.id == id);
  bool needsYou(String id) => home.needs.any((n) => n.id == id);
  Run? runFor(String id) {
    for (final r in home.running) {
      if (r.id == id) return r;
    }
    return null;
  }

  /// Where chats run: a Fly sprite is the cloud computer, anything else is the user's Mac.
  bool get isCloud {
    final h = Uri.tryParse(serverUrl.contains('://') ? serverUrl : 'https://$serverUrl')?.host ?? '';
    return h.endsWith('sprites.app') || h.endsWith('fly.dev');
  }

  /// What to call the user: the name in their Claude email ("nestor@…" → Nestor), else the
  /// account name on the server.
  String get displayName {
    final local = auth.email.split('@').first;
    final u = RegExp(r'^[A-Za-z]{2,}$').hasMatch(local) ? local : (boot?.user ?? '');
    return u.isEmpty ? '' : '${u[0].toUpperCase()}${u.substring(1)}';
  }

  String get computerName {
    if (isCloud) return 'Cloud computer';
    final u = displayName;
    return u.isEmpty ? 'Your Mac' : "$u's Mac";
  }

  /// Tests and screens that mutate fields directly call this to repaint listeners.
  void changed() => notifyListeners();

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    serverUrl = _prefs.getString('server') ?? _defaultServer();
    speakReplies = _prefs.getBool('speak') ?? true;
    handsFree = _prefs.getBool('handsFree') ?? false;
    showTech = _prefs.getBool('showTech') ?? false;
    themeMode = ThemeMode.values[_prefs.getInt('theme') ?? 0];
    try {
      turn = TurnOptions.fromJson(jsonDecode(_prefs.getString('turn') ?? '{}') as Map<String, dynamic>);
    } catch (_) {}
    if (serverUrl.isNotEmpty) await connect(serverUrl);
  }

  /// On the web the app is served by the Bridge server itself, so the page origin is the server.
  String _defaultServer() {
    // Dev builds: `flutter run --dart-define=BRIDGE_SERVER=http://localhost:4291` skips onboarding.
    const dev = String.fromEnvironment('BRIDGE_SERVER');
    if (dev.isNotEmpty) return dev;
    if (kIsWeb) {
      final u = Uri.base;
      // Served by Bridge itself at /m/ (any port), or from a real host: the origin is the server.
      if (u.path.startsWith('/m/') || (u.host.isNotEmpty && u.host != 'localhost') || u.port == 4270 || u.port == 4271) return '${u.scheme}://${u.host}${u.hasPort ? ':${u.port}' : ''}';
    }
    return '';
  }

  Future<bool> connect(String url) async {
    serverUrl = url.trim();
    _homeMissing = false;
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
      _startHomePolling();
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
      api.projects().catchError((_) => <Project>[]),
    ]);
    voice = results[0] as VoiceHealth;
    recent = results[1] as List<SessionMeta>;
    agents = results[2] as List<AgentInfo>;
    roots = results[3] as List<String>;
    projects = results[4] as List<Project>;
    notifyListeners();
    await pollHome();
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

  void _startHomePolling() {
    _homeTimer?.cancel();
    _homeTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      // The drawer's chat list changes slower than running work: refresh it every 20 s.
      if (++_homeTicks % 4 == 0) unawaited(refreshRecent());
      pollHome();
    });
  }

  bool _homeMissing = false;

  Future<void> pollHome() async {
    if (!hasServer || !_foreground || conn != ConnState.ready) return;
    if (!_homeMissing) {
      try {
        home = await api.home();
        notifyListeners();
        return;
      } on ApiException catch (e) {
        // An older server: derive what we can from /api/recent and stop asking.
        if (e.status == 404) _homeMissing = true;
      } catch (_) {
        return;
      }
    }
    if (_homeMissing) {
      home = HomeData.derive(recent, projects);
      notifyListeners();
    }
  }

  void setForeground(bool fg) {
    _foreground = fg;
    if (fg) pollHome();
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

  Future<void> setShowTech(bool v) async {
    showTech = v;
    await _prefs.setBool('showTech', v);
    notifyListeners();
  }

  Future<void> setTheme(ThemeMode m) async {
    themeMode = m;
    await _prefs.setInt('theme', m.index);
    notifyListeners();
  }

  Future<void> forgetServer() async {
    _homeTimer?.cancel();
    _homeMissing = false;
    home = HomeData.empty;
    _api?.close();
    _api = null;
    serverUrl = '';
    boot = null;
    conn = ConnState.idle;
    await _prefs.remove('server');
    notifyListeners();
  }
}
