/// App-wide state: which server, who we are, what is running and waiting. One ChangeNotifier,
/// read with `AppStore.of(context)`. Screens call the API through `store.api`.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'auth.dart';
import 'models.dart';
import 'url_clean_io.dart' if (dart.library.js_interop) 'url_clean_web.dart';

/// login: the server requires Bridge sign-in and there is no session.
enum ConnState { idle, connecting, ready, failed, login }

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
  /// Claude Code's own sign-in on the server (not the Bridge sign-in below).
  AuthStatus auth = AuthStatus.signedOut;
  /// Bridge sign-in: what the server asks for, and our Supabase session.
  AuthConfig authCfg = AuthConfig.open;
  AuthSession? session;
  /// Why the last sign-in attempt failed (e.g. an expired link), shown on the login screen.
  String authError = '';
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

  /// The server itself runs on a Fly sprite (the app was pointed at the cloud computer directly).
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

  /// The server's own machine, by name.
  String get computerName {
    if (isCloud) return 'Cloud computer';
    final u = displayName;
    return u.isEmpty ? 'Your Mac' : "$u's Mac";
  }

  /// Where chats can run (/api/computers). Before it loads, or on a server without cloud support,
  /// there is one computer: the server itself.
  List<Computer> get computers => _computers.any((c) => c.configured) ? _computers.where((c) => c.configured).toList() : [Computer(id: 'mac', name: computerName, kind: 'local', online: conn == ConnState.ready)];
  List<Computer> _computers = const [];

  @visibleForTesting
  void debugSetComputers(List<Computer> c) {
    _computers = c;
    notifyListeners();
  }

  Computer? computerById(String id) {
    for (final c in computers) {
      if (c.id == id) return c;
    }
    return null;
  }

  bool get hasCloud => computerById('cloud') != null;
  /// The cloud computer exists and is not answering (from /api/computers or /api/home).
  bool get cloudOffline => hasCloud && (computerById('cloud')!.online == false || home.cloudOffline);

  /// What to call a computer: "Nestor's Mac" (not the server's own "Mac"), "Cloud computer".
  String computerLabel(String id) {
    if (id == 'cloud') return computerById('cloud')?.name ?? 'Cloud computer';
    return computerName;
  }

  /// Where new chats run when the server is a Mac hub with a cloud computer: the last one used,
  /// kept across launches. Falls back to the Mac while the cloud is not set up or offline.
  String get computer => _computer == 'cloud' && hasCloud && !cloudOffline ? 'cloud' : 'mac';
  String _computer = 'mac';

  Future<void> setComputer(String id) async {
    _computer = id == 'cloud' ? 'cloud' : 'mac';
    await _prefs.setString('computer', _computer);
    notifyListeners();
  }

  /// The backend's host, for "Runs on …" when there is no cloud to choose: the sprite or Worker
  /// domain, or the Mac by name.
  String get serverHost {
    final u = Uri.tryParse(serverUrl.contains('://') ? serverUrl : 'https://$serverUrl');
    final h = u?.host ?? '';
    if (h.isEmpty || h == 'localhost' || h == '127.0.0.1') return computerName;
    return h;
  }

  bool get isLocalHost => serverHost == computerName && !isCloud;

  Future<void> refreshComputers() async {
    if (!hasServer || conn != ConnState.ready) return;
    try {
      _computers = await api.computers();
    } on ApiException catch (e) {
      if (e.status == 404) _computers = const [];
    } catch (_) {
      return;
    }
    notifyListeners();
  }

  /// Tests and screens that mutate fields directly call this to repaint listeners.
  void changed() => notifyListeners();

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    serverUrl = _prefs.getString('server') ?? _defaultServer();
    speakReplies = _prefs.getBool('speak') ?? true;
    handsFree = _prefs.getBool('handsFree') ?? false;
    showTech = _prefs.getBool('showTech') ?? false;
    _computer = _prefs.getString('computer') ?? 'mac';
    try {
      _chatProviders = Map<String, String>.from(jsonDecode(_prefs.getString('chatProviders') ?? '{}') as Map);
    } catch (_) {}
    themeMode = ThemeMode.values[_prefs.getInt('theme') ?? 0];
    try {
      turn = TurnOptions.fromJson(jsonDecode(_prefs.getString('turn') ?? '{}') as Map<String, dynamic>);
    } catch (_) {}
    try {
      final raw = _prefs.getString('bridgeSession');
      if (raw != null) session = AuthSession.fromJson(Map<String, dynamic>.from(jsonDecode(raw) as Map));
    } catch (_) {}
    if (kIsWeb) _takeRedirect(Uri.base);
    if (serverUrl.isNotEmpty) await connect(serverUrl);
  }

  /// A magic link lands back on /m/ with the session (or an error) in the URL fragment.
  void _takeRedirect(Uri uri) {
    final r = parseRedirect(uri);
    if (r.session == null && r.error.isEmpty) return;
    if (r.session != null) {
      _saveSession(r.session);
    } else {
      authError = r.error;
    }
    replaceUrl(uri.replace(fragment: '', query: '').toString().replaceAll(RegExp(r'[#?]+$'), ''));
  }

  Future<String?>? _refreshing;

  /// The access token for the next request, refreshed first when it is about to expire.
  Future<String?> validToken() async {
    final s = session;
    if (s == null) return null;
    if (!s.expiringSoon || s.refreshToken.isEmpty || !authCfg.required) return s.accessToken;
    return _refreshing ??= () async {
      try {
        final next = await SupaAuth(authCfg).refresh(s.refreshToken);
        await _saveSession(next);
        return next.accessToken;
      } catch (_) {
        // A network blip should not sign anyone out: keep the old token; a 401 decides.
        return s.accessToken;
      } finally {
        _refreshing = null;
      }
    }();
  }

  /// The email of the last session, so the login screen can offer it again.
  String get lastEmail => _prefs.getString('bridgeEmail') ?? '';

  Future<void> _saveSession(AuthSession? s) async {
    session = s;
    if (s != null && s.email.isNotEmpty) await _prefs.setString('bridgeEmail', s.email);
    if (s == null) {
      await _prefs.remove('bridgeSession');
    } else {
      await _prefs.setString('bridgeSession', jsonEncode(s.toJson()));
    }
  }

  bool _signingOut = false;

  /// Any 401 {error:"auth"}: the session is gone; back to the login screen.
  void _onUnauthorized() {
    if (!authCfg.required || _signingOut || conn == ConnState.login) return;
    _signingOut = true;
    _homeTimer?.cancel();
    _saveSession(null).whenComplete(() {
      _signingOut = false;
      authError = 'Your session ended. Sign in again.';
      conn = ConnState.login;
      notifyListeners();
    });
  }

  /// Where the magic link comes back to: the web app on this origin, or the server's /m/.
  String get redirectUrl {
    if (kIsWeb && Uri.base.host.isNotEmpty) return '${Uri.base.origin}/m/';
    return '${api.base}/m/';
  }

  Future<void> sendSignInLink(String email) async {
    authError = '';
    await SupaAuth(authCfg).sendLink(email, redirectTo: redirectUrl);
  }

  /// Native: the link or 6-digit code pasted from the email.
  Future<void> signInWithPasted(String text, {required String email}) async {
    final hash = tokenHashFromLink(text);
    final code = text.replaceAll(RegExp(r'\s'), '');
    if (hash.isEmpty && !RegExp(r'^\d{6,10}$').hasMatch(code)) throw AuthException('Paste the whole link from the email, or its code');
    final s = await SupaAuth(authCfg).verify(tokenHash: hash, email: email, code: hash.isEmpty ? code : '');
    await completeSignIn(s);
  }

  Future<void> completeSignIn(AuthSession s) async {
    await _saveSession(s);
    authError = '';
    await connect(serverUrl);
  }

  Future<void> signOut() async {
    final s = session;
    if (s != null && authCfg.required) await SupaAuth(authCfg).signOut(s.accessToken);
    _homeTimer?.cancel();
    await _saveSession(null);
    conn = authCfg.required ? ConnState.login : conn;
    notifyListeners();
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
    _api = BridgeApi(serverUrl, token: validToken, cachedToken: () => session?.accessToken, onUnauthorized: _onUnauthorized);
    conn = ConnState.connecting;
    connError = '';
    notifyListeners();
    try {
      authCfg = await api.authConfig();
      if (authCfg.required && session == null) {
        conn = ConnState.login;
        await _prefs.setString('server', serverUrl);
        notifyListeners();
        return true;
      }
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
    await Future.wait([pollHome(), refreshComputers()]);
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
      if (++_homeTicks % 4 == 0) {
        unawaited(refreshRecent());
        unawaited(refreshComputers());
      }
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

  /// Which provider each chat ran on (chat id → qwen), so reopening a chat keeps it.
  Map<String, String> _chatProviders = {};

  /// '' for Claude, or e.g. qwen: what this device remembers, else what the server says.
  String providerOf(String id) {
    final p = _chatProviders[id];
    if (p != null) return p;
    for (final s in recent) {
      if (s.id == id) return s.provider == 'claude' ? '' : s.provider;
    }
    return '';
  }

  Future<void> rememberProvider(String id, String provider) async {
    if (id.isEmpty || (_chatProviders[id] ?? '') == provider) return;
    if (provider.isEmpty) {
      _chatProviders.remove(id);
    } else {
      _chatProviders[id] = provider;
    }
    // Keep the newest few hundred; this is a convenience, not a record.
    if (_chatProviders.length > 400) _chatProviders = Map.fromEntries(_chatProviders.entries.skip(_chatProviders.length - 400));
    await _prefs.setString('chatProviders', jsonEncode(_chatProviders));
    notifyListeners();
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
    _computers = const [];
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
