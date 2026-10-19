/// Plain data types for the Bridge API (see docs/api-contract.md). Every `fromJson` is lenient:
/// missing fields become empty strings, zeros or nulls, never exceptions.
library;

String _s(dynamic v) => v == null ? '' : v.toString();
int _i(dynamic v) => v is num ? v.toInt() : int.tryParse(_s(v)) ?? 0;
bool _b(dynamic v) => v == true;

class AuthStatus {
  AuthStatus({required this.loggedIn, this.email = '', this.orgName = '', this.subscriptionType = '', this.authMethod = '', this.keyAuth = false, this.cli = true, this.error = ''});
  final bool loggedIn, keyAuth, cli;
  final String email, orgName, subscriptionType, authMethod, error;
  factory AuthStatus.fromJson(Map<String, dynamic>? j) => AuthStatus(
        loggedIn: _b(j?['loggedIn']),
        email: _s(j?['email']),
        orgName: _s(j?['orgName']),
        subscriptionType: _s(j?['subscriptionType']),
        authMethod: _s(j?['authMethod']),
        keyAuth: _b(j?['keyAuth']),
        cli: j?['cli'] != false,
        error: _s(j?['error']),
      );
  static final signedOut = AuthStatus(loggedIn: false);
}

class Bootstrap {
  Bootstrap({required this.user, required this.assistant, required this.color, required this.home, required this.version, required this.models, required this.permissionModes, required this.efforts, required this.auth});
  final String user, assistant, color, home, version;
  final List<String> models, permissionModes, efforts;
  final AuthStatus auth;
  factory Bootstrap.fromJson(Map<String, dynamic> j) => Bootstrap(
        user: _s(j['user']),
        assistant: _s(j['assistant']).isEmpty ? 'Claude' : _s(j['assistant']),
        color: _s(j['color']),
        home: _s(j['home']),
        version: _s(j['version']),
        models: List<String>.from(j['models'] ?? const ['opus', 'sonnet', 'haiku']),
        permissionModes: List<String>.from(j['permissionModes'] ?? const ['acceptEdits', 'plan', 'bypassPermissions']),
        efforts: List<String>.from(j['efforts'] ?? const ['', 'low', 'medium', 'high']),
        auth: AuthStatus.fromJson(j['auth'] as Map<String, dynamic>?),
      );
}

class Project {
  Project({required this.key, required this.path, required this.name, required this.sessions, required this.lastActivity, required this.exists});
  final String key, path, name;
  final int sessions, lastActivity;
  final bool exists;
  factory Project.fromJson(Map<String, dynamic> j) => Project(key: _s(j['key']), path: _s(j['path']), name: _s(j['name']), sessions: _i(j['sessions']), lastActivity: _i(j['lastActivity']), exists: j['exists'] != false);
}

class SessionMeta {
  SessionMeta({required this.id, required this.key, required this.title, required this.preview, required this.mtime, required this.turns, this.model = '', this.cwd = '', this.branch = '', this.named = false, this.projectKey = '', this.projectName = '', this.projectPath = ''});
  final String id, key, title, preview, model, cwd, branch, projectKey, projectName, projectPath;
  final int mtime, turns;
  final bool named;
  factory SessionMeta.fromJson(Map<String, dynamic> j) => SessionMeta(
        id: _s(j['id']),
        key: _s(j['key']),
        title: _s(j['title']).isEmpty ? 'Untitled session' : _s(j['title']),
        preview: _s(j['preview']),
        mtime: _i(j['mtime']),
        turns: _i(j['turns']),
        model: _s(j['model']),
        cwd: _s(j['cwd']),
        branch: _s(j['branch']),
        named: _b(j['named']),
        // /api/recent and /api/find send the key in `project`; /api/search sends a display name. Trust `key`.
        projectKey: _s(j['key']).isNotEmpty ? _s(j['key']) : _s(j['project']),
        projectName: _s(j['projectName']),
        projectPath: _s(j['projectPath']).isNotEmpty ? _s(j['projectPath']) : _s(j['cwd']),
      );
  String get folder {
    final p = projectPath.isNotEmpty ? projectPath : cwd;
    if (p.isEmpty) return projectName;
    final parts = p.split('/').where((x) => x.isNotEmpty).toList();
    return parts.isEmpty ? p : parts.last;
  }
}

class ToolResult {
  ToolResult({required this.content, required this.isError, this.structured});
  final String content;
  final bool isError;
  final dynamic structured;
  factory ToolResult.fromJson(Map<String, dynamic> j) => ToolResult(content: _s(j['content']), isError: _b(j['isError']) || _b(j['is_error']), structured: j['structured']);
}

/// One row of a transcript. `kind` ∈ user · assistant · agent_text · thinking · tool · status · choices.
class Msg {
  Msg({required this.kind, this.text = '', this.name = '', this.input, this.id = '', this.side = false, this.result, this.ts, this.model = '', this.live = false, this.options = const []});
  final String kind;
  String text;
  final String name;
  final Map<String, dynamic>? input;
  final String id;
  final bool side;
  ToolResult? result;
  final DateTime? ts;
  final String model;
  /// true while the server is still streaming into this row
  bool live;
  final List<String> options;

  static DateTime? parseTs(dynamic v) {
    if (v == null) return null;
    if (v is num) return DateTime.fromMillisecondsSinceEpoch(v.toInt());
    return DateTime.tryParse(v.toString());
  }

  factory Msg.fromEvent(Map<String, dynamic> e) {
    final kind = _s(e['kind']);
    return Msg(
      kind: kind,
      text: _s(e['text']),
      name: _s(e['name']),
      input: e['input'] is Map ? Map<String, dynamic>.from(e['input'] as Map) : null,
      id: _s(e['id']).isNotEmpty ? _s(e['id']) : _s(e['uuid']),
      side: _b(e['side']),
      result: e['result'] is Map ? ToolResult.fromJson(Map<String, dynamic>.from(e['result'] as Map)) : null,
      ts: parseTs(e['ts']),
      model: _s(e['model']),
    );
  }

  bool get isUser => kind == 'user';
  bool get isTool => kind == 'tool';
  bool get isThinking => kind == 'thinking';
  bool get isAssistant => kind == 'assistant' || kind == 'agent_text';
}

class Usage {
  int input = 0, output = 0, cacheRead = 0, cacheWrite = 0, thinking = 0;
  void add(Map<String, dynamic>? j) {
    if (j == null) return;
    input += _i(j['input']);
    output += _i(j['output']);
    cacheRead += _i(j['cacheRead']);
    cacheWrite += _i(j['cacheWrite']);
    thinking += _i(j['thinking']);
  }
}

class Transcript {
  Transcript({required this.msgs, required this.title, required this.cwd, required this.branch, required this.model, required this.offset, required this.usage});
  final List<Msg> msgs;
  final String title, cwd, branch, model;
  final int offset;
  final Usage usage;
  factory Transcript.fromJson(Map<String, dynamic> j) {
    final meta = Map<String, dynamic>.from(j['meta'] as Map? ?? {});
    final u = Usage()..add(meta['usage'] is Map ? Map<String, dynamic>.from(meta['usage'] as Map) : null);
    return Transcript(
      msgs: [for (final e in (j['events'] as List? ?? const [])) Msg.fromEvent(Map<String, dynamic>.from(e as Map))],
      title: _s(meta['title']),
      cwd: _s(meta['cwd']),
      branch: _s(meta['branch']),
      model: _s(meta['model']),
      offset: _i(j['offset']),
      usage: u,
    );
  }
}

class Waiting {
  Waiting({required this.kind, required this.text, required this.options});
  final String kind, text;
  final List<String> options;
  factory Waiting.fromJson(Map<String, dynamic> j) => Waiting(kind: _s(j['kind']), text: _s(j['text']), options: List<String>.from(j['options'] ?? const []));
}

class LiveSession {
  LiveSession({required this.pid, required this.id, required this.key, required this.cwd, required this.name, required this.status, required this.title, required this.folder, required this.last, required this.lastTs, required this.lastUser, required this.startedAt, required this.updatedAt, required this.turns, this.waiting});
  final int pid, lastTs, startedAt, updatedAt, turns;
  final String id, key, cwd, name, status, title, folder, last, lastUser;
  final Waiting? waiting;
  bool get busy => status == 'busy';
  factory LiveSession.fromJson(Map<String, dynamic> j) => LiveSession(
        pid: _i(j['pid']),
        id: _s(j['id']),
        key: _s(j['key']),
        cwd: _s(j['cwd']),
        name: _s(j['name']),
        status: _s(j['status']),
        title: _s(j['title']),
        folder: _s(j['folder']),
        last: _s(j['last']),
        lastTs: _i(j['lastTs']),
        lastUser: _s(j['lastUser']),
        startedAt: _i(j['startedAt']),
        updatedAt: _i(j['updatedAt']),
        turns: _i(j['turns']),
        waiting: j['waiting'] is Map ? Waiting.fromJson(Map<String, dynamic>.from(j['waiting'] as Map)) : null,
      );
}

class LiveEvent {
  LiveEvent({required this.kind, required this.at, required this.id, required this.key, required this.name, required this.folder, required this.cwd, required this.title, required this.text, required this.options});
  final String kind, id, key, name, folder, cwd, title, text;
  final int at;
  final List<String> options;
  factory LiveEvent.fromJson(Map<String, dynamic> j) => LiveEvent(kind: _s(j['kind']), at: _i(j['at']), id: _s(j['id']), key: _s(j['key']), name: _s(j['name']), folder: _s(j['folder']), cwd: _s(j['cwd']), title: _s(j['title']), text: _s(j['text']), options: List<String>.from(j['options'] ?? const []));
}

class LiveSnapshot {
  LiveSnapshot({required this.now, required this.sessions, required this.events});
  final int now;
  final List<LiveSession> sessions;
  final List<LiveEvent> events;
  factory LiveSnapshot.fromJson(Map<String, dynamic> j) => LiveSnapshot(
        now: _i(j['now']),
        sessions: [for (final s in (j['sessions'] as List? ?? const [])) LiveSession.fromJson(Map<String, dynamic>.from(s as Map))],
        events: [for (final e in (j['events'] as List? ?? const [])) LiveEvent.fromJson(Map<String, dynamic>.from(e as Map))],
      );
}

class DaState {
  DaState({required this.alive, required this.busy, required this.sessionId, required this.historyId, required this.turns, required this.queued, required this.error, required this.name, required this.model, required this.permissionMode});
  final bool alive, busy;
  final String sessionId, historyId, error, name, model, permissionMode;
  final int turns, queued;
  factory DaState.fromJson(Map<String, dynamic>? j) => DaState(
        alive: _b(j?['alive']),
        busy: _b(j?['busy']),
        sessionId: _s(j?['sessionId']),
        historyId: _s(j?['historyId']),
        turns: _i(j?['turns']),
        queued: _i(j?['queued']),
        error: _s(j?['error']),
        name: _s(j?['name']),
        model: _s(j?['model']),
        permissionMode: _s(j?['permissionMode']),
      );
  static final empty = DaState.fromJson(null);
}

class VoiceHealth {
  VoiceHealth({required this.tts, required this.stt, required this.pulse, required this.name});
  final String tts, stt, name;
  final bool pulse;
  factory VoiceHealth.fromJson(Map<String, dynamic>? j) => VoiceHealth(tts: _s(j?['tts']).isEmpty ? 'browser' : _s(j?['tts']), stt: _s(j?['stt']).isEmpty ? 'none' : _s(j?['stt']), pulse: _b(j?['pulse']), name: _s(j?['name']));
  static final unknown = VoiceHealth(tts: 'browser', stt: 'none', pulse: false, name: '');
  bool get serverSpeaks => tts == 'elevenlabs' || tts == 'kokoro';
}

class DirEntry {
  DirEntry({required this.name, required this.dir, required this.size, required this.mtime});
  final String name;
  final bool dir;
  final int size, mtime;
  factory DirEntry.fromJson(Map<String, dynamic> j) => DirEntry(name: _s(j['name']), dir: _b(j['dir']), size: _i(j['size']), mtime: _i(j['mtime']));
}

class DirListing {
  DirListing({required this.path, required this.parent, required this.entries, required this.roots});
  final String path;
  final String? parent;
  final List<DirEntry> entries;
  final List<String> roots;
  factory DirListing.fromJson(Map<String, dynamic> j) => DirListing(
        path: _s(j['path']),
        parent: j['parent'] == null ? null : _s(j['parent']),
        entries: [for (final e in (j['entries'] as List? ?? const [])) DirEntry.fromJson(Map<String, dynamic>.from(e as Map))],
        roots: List<String>.from(j['roots'] ?? const []),
      );
}

class AgentInfo {
  AgentInfo({required this.name, required this.description, required this.category});
  final String name, description, category;
  factory AgentInfo.fromJson(Map<String, dynamic> j) => AgentInfo(name: _s(j['name']), description: _s(j['description']), category: _s(j['category']));
}

/// Settings chosen for a turn; persisted per app, applied per session.
class TurnOptions {
  TurnOptions({this.model = '', this.permissionMode = 'acceptEdits', this.effort = '', this.agent = ''});
  String model, permissionMode, effort, agent;
  Map<String, dynamic> toJson() => {'model': model, 'permissionMode': permissionMode, 'effort': effort, 'agent': agent};
  factory TurnOptions.fromJson(Map<String, dynamic>? j) => TurnOptions(model: _s(j?['model']), permissionMode: _s(j?['permissionMode']).isEmpty ? 'acceptEdits' : _s(j?['permissionMode']), effort: _s(j?['effort']), agent: _s(j?['agent']));
}
