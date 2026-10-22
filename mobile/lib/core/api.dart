/// The only file that knows Bridge URLs. Typed calls plus an SSE reader that works on native
/// and web. Contract: docs/api-contract.md in the Bridge repo.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'http_client_io.dart' if (dart.library.js_interop) 'http_client_web.dart';
import 'models.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.status = 0});
  final String message;
  final int status;
  @override
  String toString() => message;
}

/// One SSE frame: `{"t": ..., ...}`.
class Frame {
  Frame(this.json);
  final Map<String, dynamic> json;
  String get t => (json['t'] ?? '').toString();
  dynamic get d => json['d'];
  Map<String, dynamic>? get dMap => d is Map ? Map<String, dynamic>.from(d as Map) : null;
}

class TtsResult {
  TtsResult({this.audio, this.mime = '', this.playedOnServer = false, this.words = 0});
  final Uint8List? audio;
  final String mime;
  final bool playedOnServer;
  final int words;
}

class BridgeApi {
  BridgeApi(String base) : base = _norm(base);
  final String base;
  final http.Client _client = makeClient();

  static String _norm(String b) {
    var s = b.trim();
    if (s.isEmpty) return s;
    if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'https://$s';
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    return s;
  }

  Uri _u(String path, [Map<String, String>? q]) {
    final u = Uri.parse('$base$path');
    return q == null ? u : u.replace(queryParameters: {...u.queryParameters, ...q});
  }

  Future<dynamic> _get(String path, {Map<String, String>? q, Duration timeout = const Duration(seconds: 25)}) async {
    final r = await _client.get(_u(path, q)).timeout(timeout);
    return _decode(r);
  }

  Future<dynamic> _post(String path, Map<String, dynamic> body, {Duration timeout = const Duration(seconds: 25)}) async {
    final r = await _client.post(_u(path), headers: {'content-type': 'application/json'}, body: jsonEncode(body)).timeout(timeout);
    return _decode(r);
  }

  dynamic _decode(http.Response r) {
    dynamic j;
    try {
      j = jsonDecode(utf8.decode(r.bodyBytes));
    } catch (_) {
      if (r.statusCode >= 400) throw ApiException('HTTP ${r.statusCode}', status: r.statusCode);
      throw ApiException('Bridge answered with something that is not JSON');
    }
    if (r.statusCode >= 400) {
      throw ApiException(j is Map && j['error'] != null ? j['error'].toString() : 'HTTP ${r.statusCode}', status: r.statusCode);
    }
    return j;
  }

  /// Per-chat calls name the computer only for cloud chats, so a server without cloud support sees
  /// exactly the requests it always did.
  Map<String, String> _cq(String computer) => computer == 'cloud' ? const {'computer': 'cloud'} : const {};

  Map<String, dynamic> _m(dynamic j) => j is Map ? Map<String, dynamic>.from(j) : <String, dynamic>{};
  List<Map<String, dynamic>> _l(dynamic j) => j is List ? [for (final e in j) _m(e)] : const [];

  /// Reads an SSE body (GET or POST) and yields one Frame per `data:` line. Ends when the server
  /// closes the stream. Cancel the subscription to drop the connection (the server keeps running
  /// a chat turn regardless: call abort()).
  Stream<Frame> sse(String path, {Map<String, String>? q, Map<String, dynamic>? post}) async* {
    final req = http.Request(post == null ? 'GET' : 'POST', _u(path, q));
    req.headers['accept'] = 'text/event-stream';
    if (post != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(post);
    }
    final res = await _client.send(req);
    if (res.statusCode >= 400) {
      final body = await res.stream.bytesToString();
      String msg = 'HTTP ${res.statusCode}';
      try {
        final j = jsonDecode(body);
        if (j is Map && j['error'] != null) msg = j['error'].toString();
      } catch (_) {}
      throw ApiException(msg, status: res.statusCode);
    }
    var buf = '';
    await for (final chunk in res.stream.transform(utf8.decoder)) {
      buf += chunk;
      int i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        final block = buf.substring(0, i);
        buf = buf.substring(i + 2);
        for (final line in block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            final j = jsonDecode(line.substring(6));
            if (j is Map) yield Frame(Map<String, dynamic>.from(j));
          } catch (_) {}
        }
      }
    }
  }

  // ── bootstrap / auth ─────────────────────────────────────────────────
  Future<Bootstrap> bootstrap() async => Bootstrap.fromJson(_m(await _get('/api/bootstrap', timeout: const Duration(seconds: 15))));
  Future<AuthStatus> auth({bool fresh = false}) async => AuthStatus.fromJson(_m(await _get('/api/auth', q: fresh ? {'fresh': '1'} : null)));

  /// Starts the CLI login. Returns the URL to open, or throws with the CLI's message.
  Future<String> authLogin({String mode = 'claudeai', String? email}) async {
    final j = _m(await _post('/api/auth/login', {'mode': mode, if (email != null && email.isNotEmpty) 'email': email}, timeout: const Duration(seconds: 40)));
    if (j['url'] == null) throw ApiException((j['error'] ?? 'login did not start').toString());
    return j['url'].toString();
  }

  /// Submits the pasted code. Blocks up to two minutes. Returns (ok, message, restart).
  Future<({bool ok, String message, bool restart, AuthStatus? status})> authCode(String code) async {
    final j = _m(await _post('/api/auth/code', {'code': code.trim()}, timeout: const Duration(seconds: 150)));
    return (
      ok: j['ok'] == true,
      message: (j['error'] ?? '').toString(),
      restart: j['restart'] == true,
      status: j['status'] is Map ? AuthStatus.fromJson(_m(j['status'])) : null,
    );
  }

  Future<void> authCancel() => _post('/api/auth/cancel', {});
  Future<AuthStatus> authLogout() async => AuthStatus.fromJson(_m(_m(await _post('/api/auth/logout', {}, timeout: const Duration(seconds: 40)))['status']));

  // ── projects / sessions ──────────────────────────────────────────────
  Future<List<Project>> projects() async => [for (final j in _l(await _get('/api/projects'))) Project.fromJson(j)];
  Future<List<SessionMeta>> sessions(String key) async => [for (final j in _l(await _get('/api/sessions', q: {'key': key}))) SessionMeta.fromJson(j)];
  Future<List<SessionMeta>> recent({int limit = 60}) async => [for (final j in _l(await _get('/api/recent', q: {'limit': '$limit'}))) SessionMeta.fromJson(j)];
  Future<List<SessionMeta>> search(String q) async => q.trim().length < 2 ? const [] : [for (final j in _l(await _get('/api/search', q: {'q': q.trim()}))) SessionMeta.fromJson(j)];
  Future<List<SessionMeta>> find(String q, {String scope = 'all', String? key, String? cwd}) async =>
      [for (final j in _l(await _get('/api/find', q: {'q': q, 'scope': scope, 'key': ?key, 'cwd': ?cwd}, timeout: const Duration(seconds: 60)))) SessionMeta.fromJson(j)];
  Future<Transcript> session(String key, String id, {String computer = 'mac'}) async =>
      Transcript.fromJson(_m(await _get('/api/session', q: {'key': key, 'id': id, ..._cq(computer)}, timeout: const Duration(seconds: 60))));
  Future<void> rename(String id, String title, {String computer = 'mac'}) => _post('/api/rename', {'id': id, 'title': title, ..._cq(computer)});

  /// Live follow of a transcript file. Frames: events (events, patches, usage, offset) · ping · gone · error.
  Stream<Frame> follow(String key, String id, int from, {String computer = 'mac'}) => sse('/api/follow', q: {'key': key, 'id': id, 'from': '$from', ..._cq(computer)});

  // ── turns ────────────────────────────────────────────────────────────
  /// Runs one turn. Frames: auth · start · msg · stderr · raw · ping · end · error.
  Stream<Frame> chat({
    required String prompt,
    String? resume,
    String? sessionId,
    required String cwd,
    TurnOptions? options,
    String computer = 'mac',
    List<Map<String, dynamic>> attachments = const [],
  }) =>
      sse('/api/chat', post: {
        'prompt': prompt,
        if (resume != null && resume.isNotEmpty) 'resume': resume,
        if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
        'cwd': cwd,
        if (options != null && options.model.isNotEmpty) 'model': options.model,
        'permissionMode': options?.permissionMode ?? 'acceptEdits',
        if (options != null && options.effort.isNotEmpty) 'effort': options.effort,
        if (options != null && options.agent.isNotEmpty && options.agent != 'auto') 'agent': options.agent,
        if (attachments.isNotEmpty) 'attachments': attachments,
        ..._cq(computer),
      });
  Future<bool> abort(String sessionId, {String computer = 'mac'}) async => _m(await _post('/api/abort', {'sessionId': sessionId, ..._cq(computer)}))['ok'] == true;
  Future<String> route(String prompt, {String previous = ''}) async => (_m(await _post('/api/route', {'prompt': prompt, 'previous': previous}))['agent'] ?? '').toString();

  // ── home + live work ─────────────────────────────────────────────────
  /// Everything the Home screen and the drawer show. Throws ApiException(status: 404) on a server
  /// that predates it; the store falls back to /api/recent then.
  Future<HomeData> home() async => HomeData.fromJson(_m(await _get('/api/home', timeout: const Duration(seconds: 15))));
  /// The live state of one chat; polled every few seconds while it is open.
  Future<JobsState> jobs(String key, String id, {String computer = 'mac'}) async =>
      JobsState.fromJson(_m(await _get('/api/jobs', q: {'key': key, 'id': id, ..._cq(computer)}, timeout: const Duration(seconds: 10))));
  /// Moves a Mac chat to the cloud computer. Returns the id/key it has there (the same ones when
  /// the server keeps them), or throws with the server's reason.
  Future<({String id, String key})> moveToCloud(String key, String id) async {
    final j = _m(await _post('/api/move', {'key': key, 'id': id, 'to': 'cloud'}, timeout: const Duration(seconds: 120)));
    if (j['ok'] == false || j['error'] != null) throw ApiException((j['error'] ?? 'could not move the chat').toString());
    return (id: (j['id'] ?? id).toString(), key: (j['key'] ?? key).toString());
  }

  /// Where chats can run. Throws ApiException(status: 404) on a server without cloud support.
  Future<List<Computer>> computers() async => [for (final j in _l(await _get('/api/computers', timeout: const Duration(seconds: 15)))) Computer.fromJson(j)];

  // ── the desk (assistant) ─────────────────────────────────────────────
  Future<DaState> daState() async => DaState.fromJson(_m(await _get('/api/da/state')));
  /// Frames: hello · state · user · da · event · stderr · raw · ping.
  Stream<Frame> daStream({int since = 0, bool replay = true}) => sse('/api/da/stream', q: {'since': '$since', 'replay': replay ? '1' : '0'});
  /// Returns 'ok' | 'queued' | an error message.
  Future<String> daSend(String text) async {
    final j = _m(await _post('/api/da/send', {'text': text}));
    if (j['ok'] == true) return 'ok';
    if (j['queued'] == true) return 'queued';
    return (j['error'] ?? 'could not send').toString();
  }
  Future<bool> daInterrupt() async => _m(await _post('/api/da/interrupt', {}))['ok'] == true;
  Future<DaState> daReset() async => DaState.fromJson(_m(await _post('/api/da/reset', {}, timeout: const Duration(seconds: 40))));
  Future<DaState> daConfig({String? permissionMode, String? model}) async => DaState.fromJson(_m(await _post('/api/da/config', {'permissionMode': ?permissionMode, 'model': ?model}, timeout: const Duration(seconds: 40))));

  // ── voice ────────────────────────────────────────────────────────────
  Future<VoiceHealth> voiceHealth() async => VoiceHealth.fromJson(_m(await _get('/api/voice/health', timeout: const Duration(seconds: 15))));
  Future<void> voiceWarm() => _post('/api/voice/warm', {}, timeout: const Duration(seconds: 40)).catchError((_) => null);

  /// Raw audio bytes in, text out. The server answers 200 even on failure, so read `error`.
  Future<({String text, String error})> stt(Uint8List bytes, String mime) async {
    final r = await _client.post(_u('/api/stt'), headers: {'content-type': mime}, body: bytes).timeout(const Duration(seconds: 100));
    final j = _m(_decode(r));
    return (text: (j['text'] ?? '').toString(), error: (j['error'] ?? '').toString());
  }

  /// Polymorphic: audio bytes to play, or a JSON note that it already played on the Mac / that the
  /// device should speak.
  Future<TtsResult> tts(String text) async {
    final r = await _client.post(_u('/api/tts'), headers: {'content-type': 'application/json'}, body: jsonEncode({'text': text})).timeout(const Duration(seconds: 60));
    final ct = r.headers['content-type'] ?? '';
    if (r.statusCode >= 400) throw ApiException('tts failed (${r.statusCode})', status: r.statusCode);
    if (ct.startsWith('audio/')) return TtsResult(audio: r.bodyBytes, mime: ct);
    final j = _m(_decode(r));
    return TtsResult(playedOnServer: j['played'] == 'pulse', words: (j['words'] is num) ? (j['words'] as num).toInt() : 0);
  }

  // ── files / folders ──────────────────────────────────────────────────
  Future<List<String>> roots() async => List<String>.from((await _get('/api/roots')) as List? ?? const []);
  Future<List<String>> setRoots(List<String> roots) async => List<String>.from((await _post('/api/roots', {'roots': roots})) as List? ?? const []);
  Future<DirListing> dir(String path, {bool hidden = false, String computer = 'mac'}) async =>
      DirListing.fromJson(_m(await _get('/api/dir', q: {'path': path, if (hidden) 'hidden': '1', ..._cq(computer)})));
  Future<Map<String, dynamic>> file(String path, {String computer = 'mac'}) async => _m(await _get('/api/file', q: {'path': path, ..._cq(computer)}));
  Uri rawUrl(String path, {String computer = 'mac'}) => _u('/api/raw', {'path': path, ..._cq(computer)});

  // ── catalogs ─────────────────────────────────────────────────────────
  Future<List<AgentInfo>> agents() async => [for (final j in _l(await _get('/api/agents'))) AgentInfo.fromJson(j)];
  Future<List<SkillInfo>> skills() async => [for (final j in _l(await _get('/api/skills'))) SkillInfo.fromJson(j)];
  Future<List<HookInfo>> hooks() async => [for (final j in _l(await _get('/api/hooks'))) HookInfo.fromJson(j)];
  Future<List<Map<String, dynamic>>> instructions() async => _l(await _get('/api/instructions'));
  Future<Map<String, dynamic>> activity() async => _m(await _get('/api/activity'));
  Future<Map<String, dynamic>> lifeos() async => _m(await _get('/api/lifeos'));
  Future<void> notify(String title, String body) => _post('/api/notify', {'title': title, 'subtitle': '', 'body': body}).catchError((_) => null);

  void close() => _client.close();
}

/// `<bridge>…</bridge>` blocks are prepended to desk messages on disk; never show them.
String stripBridgeBlock(String s) => s.replaceAll(RegExp(r'<bridge>[\s\S]*?</bridge>\s*'), '');

/// The server asks the model to end with a ```choices block instead of AskUserQuestion. Returns the
/// option lines and the text without the block.
({String text, List<String> options}) splitChoices(String text) {
  final m = RegExp(r'```choices\s*\n([\s\S]*?)```\s*$').firstMatch(text.trimRight());
  if (m == null) return (text: text, options: const []);
  final opts = m.group(1)!.split('\n').map((l) => l.replaceFirst(RegExp(r'^\s*(?:[-*•]|\d+[.)])\s*'), '').trim()).where((l) => l.isNotEmpty).toList();
  return (text: text.substring(0, m.start).trimRight(), options: opts);
}
