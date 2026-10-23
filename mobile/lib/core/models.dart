/// Plain data types for the Bridge API (see docs/api-contract.md). Every `fromJson` is lenient:
/// missing fields become empty strings, zeros or nulls, never exceptions.
library;

String _s(dynamic v) => v == null ? '' : v.toString();
/// Which computer a chat lives on. Anything but "cloud" (including a missing field) is the Mac.
String _computer(dynamic v) => _s(v) == 'cloud' ? 'cloud' : 'mac';
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

/// A model provider the server can run chats on. group: claude · open (models such as Qwen on
/// RunPod). `short` is the tag on chats ("Qwen 3.8"); `note` the line under it in the sheet.
class Provider {
  Provider({required this.id, required this.name, this.short = '', this.group = '', this.available = true, this.note = '', this.reason = ''});
  final String id, name, short, group, note, reason;
  final bool available;
  bool get isOpen => group == 'open';
  factory Provider.fromJson(Map<String, dynamic> j) {
    final id = _s(j['id']);
    final name = _s(j['name']).isEmpty ? id : _s(j['name']);
    return Provider(
      id: id,
      name: name,
      short: _s(j['short']).isEmpty ? name : _s(j['short']),
      // No group: anything that is not Claude is an open model.
      group: _s(j['group']).isNotEmpty ? _s(j['group']) : (id == 'claude' ? 'claude' : 'open'),
      available: j['available'] != false,
      note: _s(j['note']),
      reason: _s(j['reason']).isNotEmpty ? _s(j['reason']) : _s(j['error']),
    );
  }
}

class Bootstrap {
  Bootstrap({required this.user, required this.assistant, required this.color, required this.home, required this.version, required this.models, required this.permissionModes, required this.efforts, required this.auth, this.providers = const []});
  /// Empty on a server with Claude only.
  final List<Provider> providers;
  /// The machine the server runs on, for "Runs on …": {name, kind: mac | cloud}. Empty on older servers.
  String hostName = '';
  String hostKind = '';
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
        providers: [for (final p in (j['providers'] is List ? j['providers'] as List : const [])) if (p is Map && _s(p['id']).isNotEmpty) Provider.fromJson(Map<String, dynamic>.from(p))],
      )
        ..hostName = j['host'] is Map ? _s((j['host'] as Map)['name']) : ''
        ..hostKind = j['host'] is Map ? _s((j['host'] as Map)['kind']) : '';
}

class Project {
  Project({required this.key, required this.path, required this.name, required this.sessions, required this.lastActivity, required this.exists});
  final String key, path, name;
  final int sessions, lastActivity;
  final bool exists;
  factory Project.fromJson(Map<String, dynamic> j) => Project(key: _s(j['key']), path: _s(j['path']), name: _s(j['name']), sessions: _i(j['sessions']), lastActivity: _i(j['lastActivity']), exists: j['exists'] != false);
}

class SessionMeta {
  SessionMeta({required this.id, required this.key, required this.title, required this.preview, required this.mtime, required this.turns, this.model = '', this.cwd = '', this.branch = '', this.named = false, this.projectKey = '', this.projectName = '', this.projectPath = '', this.running = false, this.needs = false, this.computer = 'mac', this.provider = ''});
  final String id, key, title, preview, model, cwd, branch, projectKey, projectName, projectPath;
  /// '' / claude · qwen
  final String provider;
  /// mac · cloud
  final String computer;
  final int mtime, turns;
  final bool named;
  /// A turn is running on the server right now / the chat is waiting on an answer.
  final bool running, needs;
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
        running: _b(j['running']),
        needs: _b(j['needs']),
        computer: _computer(j['computer']),
        provider: _s(j['provider']),
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
  AgentInfo({required this.name, required this.description, required this.category, this.model = '', this.color = '', this.source = ''});
  final String name, description, category, model, color, source;
  factory AgentInfo.fromJson(Map<String, dynamic> j) => AgentInfo(name: _s(j['name']), description: _s(j['description']), category: _s(j['category']), model: _s(j['model']), color: _s(j['color']), source: _s(j['source']));
}

class SkillInfo {
  SkillInfo({required this.name, required this.description, required this.source, required this.path});
  final String name, description, source, path;
  factory SkillInfo.fromJson(Map<String, dynamic> j) => SkillInfo(name: _s(j['name']), description: _s(j['description']), source: _s(j['source']), path: _s(j['path']));
}

class HookInfo {
  HookInfo({required this.event, required this.matcher, required this.command});
  final String event, matcher, command;
  factory HookInfo.fromJson(Map<String, dynamic> j) => HookInfo(event: _s(j['event']), matcher: _s(j['matcher']), command: _s(j['command']));
}

// ── /api/home and /api/jobs ──────────────────────────────────────────────

/// Background work inside a running chat. kind ∈ subagent · background · workflow · tool.
class Job {
  Job({required this.kind, required this.title, required this.since, this.agent = ''});
  final String kind, title, agent;
  /// epoch ms
  final int since;
  factory Job.fromJson(Map<String, dynamic> j) => Job(kind: _s(j['kind']), title: _s(j['title']), since: _i(j['since']), agent: _s(j['agent']));
}

List<Job> _jobs(dynamic v) => [for (final e in (v is List ? v : const [])) if (e is Map) Job.fromJson(Map<String, dynamic>.from(e))];

/// A chat with a turn running right now.
class Run {
  Run({required this.id, required this.key, required this.title, required this.projectName, required this.cwd, required this.started, required this.prompt, required this.model, required this.step, required this.jobs, this.computer = 'mac'});
  final String id, key, title, projectName, cwd, prompt, model, step, computer;
  /// epoch ms
  final int started;
  final List<Job> jobs;
  factory Run.fromJson(Map<String, dynamic> j) => Run(
        id: _s(j['id']),
        key: _s(j['key']),
        title: _s(j['title']).isNotEmpty ? _s(j['title']) : (_s(j['prompt']).isNotEmpty ? _s(j['prompt']) : 'Untitled chat'),
        projectName: _s(j['projectName']),
        cwd: _s(j['cwd']),
        // Prefer `started`; fall back to now - elapsed when only a duration is sent.
        started: _i(j['started']) > 0 ? _i(j['started']) : (_i(j['elapsed']) > 0 ? DateTime.now().millisecondsSinceEpoch - _i(j['elapsed']) : 0),
        prompt: _s(j['prompt']),
        model: _s(j['model']),
        step: _s(j['step']),
        jobs: _jobs(j['jobs']),
        computer: _computer(j['computer']),
      );
}

/// A chat waiting on the user.
class Need {
  Need({required this.id, required this.key, required this.title, required this.projectName, required this.ask, required this.since, this.computer = 'mac'});
  final String id, key, title, projectName, ask, computer;
  final int since;
  factory Need.fromJson(Map<String, dynamic> j) =>
      Need(id: _s(j['id']), key: _s(j['key']), title: _s(j['title']).isEmpty ? 'Untitled chat' : _s(j['title']), projectName: _s(j['projectName']), ask: _s(j['ask']), since: _i(j['since']), computer: _computer(j['computer']));
}

/// A file a chat wrote.
class Made {
  Made({required this.path, required this.name, required this.ext, required this.sessionId, required this.key, required this.sessionTitle, required this.mtime, this.computer = 'mac'});
  final String path, name, ext, sessionId, key, sessionTitle, computer;
  final int mtime;
  factory Made.fromJson(Map<String, dynamic> j) {
    final path = _s(j['path']);
    final name = _s(j['name']).isNotEmpty ? _s(j['name']) : path.split('/').last;
    final dot = name.lastIndexOf('.');
    return Made(
      path: path,
      name: name,
      ext: (_s(j['ext']).isNotEmpty ? _s(j['ext']) : (dot > 0 ? name.substring(dot + 1) : '')).replaceFirst('.', '').toUpperCase(),
      sessionId: _s(j['sessionId']),
      key: _s(j['key']),
      sessionTitle: _s(j['sessionTitle']),
      mtime: _i(j['mtime']),
      computer: _computer(j['computer']),
    );
  }
}

class HomeProject {
  HomeProject({required this.key, required this.name, required this.path, required this.count, required this.mtime});
  final String key, name, path;
  final int count, mtime;
  factory HomeProject.fromJson(Map<String, dynamic> j) => HomeProject(key: _s(j['key']), name: _s(j['name']), path: _s(j['path']), count: _i(j['count']), mtime: _i(j['mtime']));
}

class HomeData {
  HomeData({this.user = '', this.assistant = '', this.running = const [], this.needs = const [], this.made = const [], this.projects = const [], this.derived = false, this.cloudOffline = false});
  final String user, assistant;
  final List<Run> running;
  final List<Need> needs;
  final List<Made> made;
  final List<HomeProject> projects;
  /// true when built from /api/recent because the server has no /api/home yet
  final bool derived;
  /// The cloud computer is set up but not answering.
  final bool cloudOffline;
  factory HomeData.fromJson(Map<String, dynamic> j) {
    List<T> list<T>(String k, T Function(Map<String, dynamic>) f) => [for (final e in (j[k] is List ? j[k] as List : const [])) if (e is Map) f(Map<String, dynamic>.from(e))];
    return HomeData(
      user: _s(j['user']),
      assistant: _s(j['assistant']),
      running: list('running', Run.fromJson),
      needs: list('needs', Need.fromJson),
      made: list('made', Made.fromJson),
      projects: list('projects', HomeProject.fromJson),
      cloudOffline: _b(j['cloudOffline']),
    );
  }

  /// What an older server can still tell us: running/needs flags on recent chats, projects.
  factory HomeData.derive(List<SessionMeta> recent, List<Project> projects) => HomeData(
        derived: true,
        running: [
          for (final s in recent.where((s) => s.running))
            Run(id: s.id, key: s.key, title: s.title, projectName: s.projectName, cwd: s.cwd, started: s.mtime, prompt: s.preview, model: s.model, step: '', jobs: const [], computer: s.computer),
        ],
        needs: [
          for (final s in recent.where((s) => s.needs)) Need(id: s.id, key: s.key, title: s.title, projectName: s.projectName, ask: s.preview, since: s.mtime, computer: s.computer),
        ],
        projects: [
          for (final p in projects) HomeProject(key: p.key, name: p.name, path: p.path, count: p.sessions, mtime: p.lastActivity),
        ],
      );
  static final empty = HomeData();
}

/// GET /api/jobs: the live state of one chat.
class JobsState {
  JobsState({required this.running, required this.started, required this.step, required this.jobs});
  final bool running;
  final int started;
  final String step;
  final List<Job> jobs;
  factory JobsState.fromJson(Map<String, dynamic> j) => JobsState(
        running: _b(j['running']),
        started: _i(j['started']) > 0 ? _i(j['started']) : (_i(j['elapsed']) > 0 ? DateTime.now().millisecondsSinceEpoch - _i(j['elapsed']) : 0),
        step: _s(j['step']),
        jobs: _jobs(j['jobs']),
      );
  static final idle = JobsState(running: false, started: 0, step: '', jobs: const []);
}

/// Settings chosen for a turn; persisted per app, applied per session.
class TurnOptions {
  TurnOptions({this.model = '', this.permissionMode = 'acceptEdits', this.effort = '', this.agent = '', this.provider = ''});
  /// provider: '' (Claude) or a /api/bootstrap provider id such as qwen.
  String model, permissionMode, effort, agent, provider;
  /// Running on an open model (any provider but Claude).
  bool get isOpen => provider.isNotEmpty;
  Map<String, dynamic> toJson() => {'model': model, 'permissionMode': permissionMode, 'effort': effort, 'agent': agent, 'provider': provider};
  factory TurnOptions.fromJson(Map<String, dynamic>? j) => TurnOptions(
        model: _s(j?['model']),
        permissionMode: _s(j?['permissionMode']).isEmpty ? 'acceptEdits' : _s(j?['permissionMode']),
        effort: _s(j?['effort']),
        agent: _s(j?['agent']),
        provider: _s(j?['provider']) == 'claude' ? '' : _s(j?['provider']),
      );
  TurnOptions copy({String? model, String? permissionMode, String? effort, String? agent, String? provider}) => TurnOptions(
        model: model ?? this.model,
        permissionMode: permissionMode ?? this.permissionMode,
        effort: effort ?? this.effort,
        agent: agent ?? this.agent,
        provider: provider ?? this.provider,
      );
}

/// GET /api/computers: where chats can run. id ∈ mac · cloud.
class Computer {
  Computer({required this.id, required this.name, required this.kind, required this.online, this.url = '', this.reason = '', this.configured = true});
  final String id, name, kind, url;
  final bool online;
  /// The server always lists the cloud computer; `configured: false` means it is not set up yet.
  final bool configured;
  /// Why it is offline, when the server says.
  final String reason;
  bool get isCloud => id == 'cloud';
  factory Computer.fromJson(Map<String, dynamic> j) {
    final id = _computer(j['id']);
    return Computer(
      id: id,
      name: _s(j['name']).isNotEmpty ? _s(j['name']) : (id == 'cloud' ? 'Cloud computer' : 'Your Mac'),
      kind: _s(j['kind']).isNotEmpty ? _s(j['kind']) : (id == 'cloud' ? 'remote' : 'local'),
      // A computer the server lists without a status is assumed reachable; only `false` is offline.
      online: j['online'] != false,
      url: _s(j['url']),
      reason: _s(j['reason']).isNotEmpty ? _s(j['reason']) : _s(j['error']),
      configured: j['configured'] != false,
    );
  }
}
