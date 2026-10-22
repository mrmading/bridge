/// One chat: history from /api/session, live updates from /api/follow (so opening a chat that is
/// already running re-attaches to it), turns sent through /api/chat, and the chat's background
/// work from /api/jobs every 3 s. Each turn reads as one work line plus prose and file cards; the
/// raw stream is behind Settings › Advanced. Anything sent while work runs is queued.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';
import '../../widgets/composer.dart';
import '../../widgets/transcript.dart';
import '../../widgets/turn.dart';
import '../files/file_screen.dart';
import '../talk/talk_screen.dart';
import 'chat_panel.dart';
import 'session_utils.dart';

class SessionScreen extends StatefulWidget {
  const SessionScreen({super.key, required this.chat, this.onMenu});
  final ChatRef chat;
  /// Opens the drawer (the chat is a root view behind it).
  final VoidCallback? onMenu;

  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen> {
  final _store = AppStore.instance;
  BridgeApi get _api => _store.api;

  late String _key = widget.chat.key;
  late String _id = widget.chat.id;
  late String _cwd = widget.chat.cwd;
  late String _title = widget.chat.title;
  late bool _isNew = widget.chat.isNew;
  /// mac · cloud. A chat that moves reopens as a new screen, so this never changes in place.
  late final String _computer = widget.chat.computer;

  final List<Msg> _msgs = [];
  final Map<String, Msg> _tools = {};
  final Set<String> _seen = {};
  bool _loading = true;
  String _loadError = '';
  int _offset = 0;
  Usage _usage = Usage();

  // follow
  StreamSubscription<Frame>? _followSub;
  Timer? _followRetry;
  int _followFailures = 0;
  bool _gone = false;
  bool _disposed = false;

  // jobs: running state + background work, for our own turns and ones started elsewhere
  Timer? _jobsTimer;
  JobsState _jobs = JobsState.idle;
  bool _jobsMissing = false;

  // turn
  StreamSubscription<Frame>? _chatSub;
  bool _running = false;
  bool _turnStarted = false;
  Msg? _turnMsg;
  String _abortKey = '';
  DateTime _turnStart = DateTime.now();
  bool _gotOutput = false;
  String _hook = '';
  String _footer = '';
  String _lastAgent = '';
  final List<String> _queue = [];
  final Map<String, Msg> _blocks = {};
  final Set<String> _streamedMsgIds = {};

  // composer
  late final TextEditingController _input = TextEditingController(text: widget.chat.sendPrefill ? '' : widget.chat.prefill);
  final _focus = FocusNode();

  // scroll
  final _scroll = ScrollController();
  bool _atBottom = true;
  bool _hasNew = false;
  Timer? _paint;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _store.addListener(_onStore);
    Nav.instance.focusComposer.addListener(_onFocusAsk);
    _start();
  }

  void _onStore() {
    if (mounted) setState(() {});
  }

  void _onFocusAsk() => _focus.requestFocus();

  Future<void> _start() async {
    if (_isNew) {
      setState(() => _loading = false);
    } else {
      await _resync();
      _startJobs();
    }
    if (!mounted) return;
    final c = widget.chat;
    if (c.sendPrefill && c.prefill.trim().isNotEmpty) {
      _send(c.prefill.trim());
    } else if (c.focus || c.prefill.isNotEmpty) {
      _focus.requestFocus();
      _input.selection = TextSelection.collapsed(offset: _input.text.length);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _store.removeListener(_onStore);
    Nav.instance.focusComposer.removeListener(_onFocusAsk);
    _followSub?.cancel();
    _followRetry?.cancel();
    _chatSub?.cancel();
    _jobsTimer?.cancel();
    _paint?.cancel();
    _input.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  // ── history + follow ────────────────────────────────────────────────

  /// Refetch the transcript and restart the follower from its clean offset (gotcha 9).
  Future<void> _resync() async {
    _stopFollow();
    try {
      final tr = await _api.session(_key, _id, computer: _computer);
      if (!mounted) return;
      setState(() {
        _msgs
          ..clear()
          ..addAll(tr.msgs);
        _tools.clear();
        _seen.clear();
        for (final m in tr.msgs) {
          if (m.id.isNotEmpty) _seen.add(m.id);
          if (m.isTool && m.id.isNotEmpty) _tools[m.id] = m;
        }
        if (_title.isEmpty && tr.title.isNotEmpty) _title = tr.title;
        if (tr.cwd.isNotEmpty) _cwd = tr.cwd;
        _offset = tr.offset;
        _usage = tr.usage;
        _loading = false;
        _loadError = '';
        _isNew = false;
      });
      _followFailures = 0;
      _jumpToBottomSoon(force: _atBottom);
      _startFollow();
    } catch (e) {
      if (!mounted) return;
      final notFound = e is ApiException && e.status == 404;
      setState(() {
        _loading = false;
        if (!notFound && _msgs.isEmpty) _loadError = e.toString();
      });
      if (!notFound) _scheduleFollowRetry();
    }
  }

  void _stopFollow() {
    _followRetry?.cancel();
    _followSub?.cancel();
    _followSub = null;
  }

  void _startFollow() {
    if (_disposed || _gone || _isNew) return;
    _followSub?.cancel();
    _followSub = _api.follow(_key, _id, _offset, computer: _computer).listen(
      _onFollowFrame,
      onError: (_) => _scheduleFollowRetry(),
      onDone: _scheduleFollowRetry,
      cancelOnError: true,
    );
  }

  void _scheduleFollowRetry() {
    _followSub = null;
    if (_disposed || _gone) return;
    _followFailures++;
    _followRetry?.cancel();
    _followRetry = Timer(const Duration(seconds: 2), () {
      if (_disposed) return;
      // A reconnect mid-line drops that line, so after repeated failures resync from scratch.
      if (_followFailures >= 2) {
        _resync();
      } else {
        _startFollow();
      }
    });
  }

  void _onFollowFrame(Frame f) {
    switch (f.t) {
      case 'events':
        final off = f.json['offset'];
        if (off is! num) {
          _resync();
          return;
        }
        _offset = off.toInt();
        _followFailures = 0;
        // While our own turn streams, the chat stream is the source of truth; resync after `end`.
        if (_running) return;
        var changed = false;
        for (final e in (f.json['events'] as List? ?? const [])) {
          if (e is! Map) continue;
          final m = Msg.fromEvent(Map<String, dynamic>.from(e));
          if (m.id.isNotEmpty && !_seen.add(m.id)) continue;
          if (m.isTool && m.id.isNotEmpty) _tools[m.id] = m;
          _msgs.add(m);
          changed = true;
        }
        for (final p in (f.json['patches'] as List? ?? const [])) {
          if (p is! Map) continue;
          final row = _tools[(p['id'] ?? '').toString()];
          if (row != null && p['result'] is Map) {
            row.result = ToolResult.fromJson(Map<String, dynamic>.from(p['result'] as Map));
            changed = true;
          }
        }
        final u = f.json['usage'];
        if (u is Map) _usage.add(Map<String, dynamic>.from(u));
        if (changed) _touch(newContent: true);
      case 'gone':
        _gone = true;
        _stopFollow();
      default:
        break;
    }
  }

  // ── jobs ────────────────────────────────────────────────────────────

  void _startJobs() {
    _jobsTimer?.cancel();
    if (_jobsMissing || (_isNew && _abortKey.isEmpty)) return;
    _pollJobs();
    _jobsTimer = Timer.periodic(const Duration(seconds: 3), (_) => _pollJobs());
  }

  Future<void> _pollJobs() async {
    if (_disposed || _jobsMissing || (_isNew && _abortKey.isEmpty)) return;
    final wasRemote = _remoteRunning;
    try {
      final j = await _api.jobs(_key, _abortKey.isNotEmpty ? _abortKey : _id, computer: _computer);
      if (!mounted) return;
      setState(() => _jobs = j);
    } on ApiException catch (e) {
      if (e.status == 404) {
        // An older server: fall back to the running flag the home poll gives us.
        _jobsMissing = true;
        _jobsTimer?.cancel();
      }
    } catch (_) {}
    if (!mounted) return;
    // Work started elsewhere just finished: anything typed meanwhile goes now.
    if (wasRemote && !_remoteRunning && !_running) _flushQueue();
  }

  /// A turn runs on the server that this screen is not streaming (started on another device, or
  /// before this screen opened). The follower shows its output; jobs tell us when it ends.
  bool get _remoteRunning {
    if (_running) return false;
    if (!_jobsMissing) return _jobs.running;
    return _store.isRunning(_id);
  }

  bool get _busy => _running || _remoteRunning;

  int get _runSince {
    if (_running) return _turnStart.millisecondsSinceEpoch;
    if (_jobs.started > 0) return _jobs.started;
    return _store.runFor(_id)?.started ?? 0;
  }

  List<Job> get _liveJobs => _jobs.jobs.isNotEmpty ? _jobs.jobs : (_store.runFor(_id)?.jobs ?? const []);

  // ── sending ─────────────────────────────────────────────────────────

  Future<void> _send(String text) async {
    if (_busy) {
      setState(() => _queue.add(text));
      _jumpToBottomSoon(force: true);
      return;
    }
    await _runTurn(text);
  }

  void _flushQueue() {
    if (_queue.isEmpty || _busy) return;
    final next = _queue.removeAt(0);
    _send(next);
  }

  Future<void> _runTurn(String text) async {
    if (!_store.auth.loggedIn) {
      toast(context, 'Sign in to Claude first (Settings)');
      if (_input.text.trim().isEmpty) _input.text = text;
      return;
    }
    _stopFollow();
    final userMsg = Msg(kind: 'user', text: text, ts: DateTime.now());
    _turnMsg = userMsg;
    setState(() {
      _running = true;
      _turnStarted = false;
      _gotOutput = false;
      _hook = '';
      _footer = '';
      _abortKey = '';
      _turnStart = DateTime.now();
      _blocks.clear();
      _msgs.add(userMsg);
    });
    _jumpToBottomSoon(force: true);

    final base = _store.turn;
    final opts = TurnOptions(model: base.model, permissionMode: base.permissionMode, effort: base.effort, agent: base.agent);
    if (opts.agent == 'auto') {
      try {
        opts.agent = await _api.route(text, previous: _lastAgent);
      } catch (_) {
        opts.agent = '';
      }
      _lastAgent = opts.agent;
    }
    if (!mounted) return;

    _chatSub = _api
        .chat(prompt: text, resume: _isNew ? null : _id, sessionId: _isNew ? _id : null, cwd: _cwd, options: opts, computer: _computer)
        .listen(_onChatFrame, onError: (Object e) {
      if (mounted) toast(context, e.toString());
      _finishTurn();
    }, onDone: _finishTurn);
  }

  Future<void> _stopTurn() async {
    final key = _abortKey.isNotEmpty ? _abortKey : (_remoteRunning ? _id : '');
    if (key.isEmpty) {
      toast(context, 'The turn has not started yet');
      return;
    }
    try {
      final ok = await _api.abort(key, computer: _computer);
      if (!ok && mounted) toast(context, 'Nothing is running');
      if (ok) unawaited(_pollJobs());
    } catch (e) {
      if (mounted) toast(context, e.toString());
    }
  }

  Future<void> _finishTurn() async {
    if (!_running || !mounted) return;
    _chatSub?.cancel();
    _chatSub = null;
    final started = _turnStarted;
    setState(() {
      _running = false;
      _hook = '';
      for (final m in _msgs) {
        m.live = false;
      }
      _msgs.removeWhere((m) => m.isAssistant && m.text.trim().isEmpty);
      // The turn never started (signed out, spawn error): give the text back.
      final um = _turnMsg;
      if (!started && um != null) {
        _msgs.remove(um);
        if (_input.text.trim().isEmpty) _input.text = um.text;
      }
      _turnMsg = null;
    });
    unawaited(_store.refreshRecent());
    unawaited(_store.pollHome());
    if (started) {
      _isNew = false;
      await _resync();
    } else if (!_isNew) {
      _startFollow();
    }
    if (!mounted) return;
    _flushQueue();
  }

  void _onChatFrame(Frame f) {
    switch (f.t) {
      case 'auth':
        toast(context, 'Sign in to Claude in Settings');
      case 'start':
        _turnStarted = true;
        _abortKey = (f.json['sessionId'] ?? '').toString();
        final c = (f.json['cwd'] ?? '').toString();
        if (c.isNotEmpty && c != _cwd) {
          // Outside the roots the server silently falls back to $HOME (gotcha 8).
          _cwd = c;
          if (_isNew) _key = projectKeyFor(c);
        }
        // The drawer and Home show it as working right away; background work shows up here.
        unawaited(_store.pollHome());
        if (_jobsTimer == null) _startJobs();
      case 'msg':
        final d = f.dMap;
        if (d != null) _onStreamJson(d);
      case 'error':
        toast(context, (f.d ?? 'Turn failed').toString());
      case 'end':
        _finishTurn();
      default:
        break;
    }
  }

  void _onStreamJson(Map<String, dynamic> d) {
    final type = (d['type'] ?? '').toString();
    final side = d['parent_tool_use_id'] != null;
    switch (type) {
      case 'system':
        final sub = (d['subtype'] ?? '').toString();
        if (sub == 'init') {
          final sid = (d['session_id'] ?? '').toString();
          if (sid.isNotEmpty && sid != _id) _id = sid; // resume can fork the id (gotcha 4)
        } else if (sub == 'hook_started') {
          _hook = 'Running ${(d['hook_name'] ?? 'hook').toString()}';
          _touch();
        } else if (sub == 'hook_response') {
          _hook = '';
          _touch();
        }
      case 'stream_event':
        _onStreamEvent(d, side);
      case 'assistant':
        _onAssistant(d, side);
      case 'user':
        _onToolResults(d);
      case 'result':
        final parts = <String>[];
        final model = _store.turn.model;
        if (model.isNotEmpty) parts.add(cap(model));
        final cost = d['total_cost_usd'];
        if (cost is num) parts.add('\$${cost.toStringAsFixed(cost < 1 ? 3 : 2)}');
        final ms = d['duration_ms'];
        if (ms is num) parts.add('${(ms / 1000).toStringAsFixed(1)}s');
        if (d['is_error'] == true) parts.add((d['subtype'] ?? 'error').toString());
        _footer = parts.join('  ·  ');
        _touch();
      default:
        break;
    }
  }

  void _onStreamEvent(Map<String, dynamic> d, bool side) {
    final ev = d['event'];
    if (ev is! Map) return;
    final parent = (d['parent_tool_use_id'] ?? '').toString();
    final et = (ev['type'] ?? '').toString();
    final slot = '$parent|${ev['index']}';
    switch (et) {
      case 'message_start':
        _blocks.removeWhere((k, _) => k.startsWith('$parent|'));
        final msg = ev['message'];
        if (msg is Map && msg['id'] != null) _streamedMsgIds.add(msg['id'].toString());
      case 'content_block_start':
        final cb = ev['content_block'];
        final bt = cb is Map ? (cb['type'] ?? '').toString() : '';
        if (bt == 'text' || bt == 'thinking') {
          final row = Msg(
            kind: bt == 'thinking' ? 'thinking' : (side ? 'agent_text' : 'assistant'),
            text: cb is Map ? (cb[bt] ?? '').toString() : '',
            side: side,
            live: true,
            ts: DateTime.now(),
          );
          _blocks[slot] = row;
          _msgs.add(row);
          _gotOutput = true;
          _touch(newContent: true);
        }
      case 'content_block_delta':
        final row = _blocks[slot];
        final delta = ev['delta'];
        if (row == null || delta is! Map) return;
        final dt = delta['type'];
        if (dt == 'text_delta') {
          row.text += (delta['text'] ?? '').toString();
        } else if (dt == 'thinking_delta') {
          row.text += (delta['thinking'] ?? '').toString();
        } else {
          return;
        }
        _touch(newContent: true);
      case 'content_block_stop':
        final row = _blocks.remove(slot);
        if (row == null) return;
        row.live = false;
        if (row.text.trim().isEmpty) _msgs.remove(row);
        _touch();
      default:
        break;
    }
  }

  void _onAssistant(Map<String, dynamic> d, bool side) {
    final msg = d['message'];
    if (msg is! Map) return;
    final streamed = _streamedMsgIds.contains((msg['id'] ?? '').toString());
    final content = msg['content'];
    if (content is! List) return;
    for (final b in content) {
      if (b is! Map) continue;
      final bt = (b['type'] ?? '').toString();
      if (bt == 'tool_use' || bt == 'server_tool_use') {
        final id = (b['id'] ?? '').toString();
        if (id.isEmpty || _tools.containsKey(id)) continue;
        final row = Msg(
          kind: 'tool',
          id: id,
          name: (b['name'] ?? '').toString(),
          input: b['input'] is Map ? Map<String, dynamic>.from(b['input'] as Map) : null,
          side: side,
          ts: DateTime.now(),
        );
        _tools[id] = row;
        _msgs.add(row);
        _gotOutput = true;
      } else if (!streamed && bt == 'text') {
        final text = (b['text'] ?? '').toString();
        if (text.trim().isEmpty) continue;
        _msgs.add(Msg(kind: side ? 'agent_text' : 'assistant', text: text, side: side, ts: DateTime.now()));
        _gotOutput = true;
      } else if (!streamed && bt == 'thinking') {
        final text = (b['thinking'] ?? '').toString();
        if (text.trim().isEmpty) continue;
        _msgs.add(Msg(kind: 'thinking', text: text, side: side, ts: DateTime.now()));
      }
    }
    _touch(newContent: true);
  }

  void _onToolResults(Map<String, dynamic> d) {
    final msg = d['message'];
    final content = msg is Map ? msg['content'] : null;
    if (content is! List) return;
    var changed = false;
    for (final b in content) {
      if (b is! Map || b['type'] != 'tool_result') continue;
      final row = _tools[(b['tool_use_id'] ?? '').toString()];
      if (row == null) continue;
      final c = b['content'];
      String text;
      if (c is String) {
        text = c;
      } else if (c is List) {
        text = c.map((p) => p is Map ? (p['type'] == 'text' ? (p['text'] ?? '').toString() : (p['type'] == 'image' ? '[image]' : p.toString())) : p.toString()).join('\n');
      } else {
        text = c == null ? '' : c.toString();
      }
      row.result = ToolResult(content: text, isError: b['is_error'] == true);
      changed = true;
    }
    if (changed) _touch();
  }

  // ── painting + scrolling ────────────────────────────────────────────

  /// Coalesces bursts of deltas into one rebuild every ~50 ms.
  void _touch({bool newContent = false}) {
    if (newContent && !_atBottom) _hasNew = true;
    if (_paint?.isActive == true) return;
    _paint = Timer(const Duration(milliseconds: 50), () {
      if (!mounted) return;
      setState(() {});
      if (_atBottom) _jumpToBottomSoon();
    });
  }

  void _onScroll() {
    if (!_scroll.hasClients) return;
    final p = _scroll.position;
    final at = p.pixels >= p.maxScrollExtent - 80;
    if (at != _atBottom || (at && _hasNew)) {
      setState(() {
        _atBottom = at;
        if (at) _hasNew = false;
      });
    }
  }

  /// List extents are estimated lazily, so jump a few frames in a row until the end is stable.
  void _jumpToBottomSoon({bool force = false, int tries = 3}) {
    if (force) {
      _atBottom = true;
      _hasNew = false;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final max = _scroll.position.maxScrollExtent;
      if (_scroll.position.pixels != max) _scroll.jumpTo(max);
      if (tries > 1) _jumpToBottomSoon(tries: tries - 1);
    });
  }

  void _scrollToBottomAnimated() {
    setState(() {
      _hasNew = false;
      _atBottom = true;
    });
    if (!_scroll.hasClients) return;
    _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 220), curve: Curves.easeOut).then((_) => _jumpToBottomSoon());
  }

  // ── menus + sheets ──────────────────────────────────────────────────

  Future<void> _rename() async {
    final c = TextEditingController(text: _title);
    final title = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Rename chat'),
        content: TextField(controller: c, autofocus: true, textCapitalization: TextCapitalization.sentences, decoration: const InputDecoration(hintText: 'Title'), onSubmitted: (v) => Navigator.pop(ctx, v)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('Save')),
        ],
      ),
    );
    c.dispose();
    if (title == null || !mounted) return;
    if (_isNew) {
      toast(context, 'Send a message first, then rename');
      return;
    }
    try {
      await _api.rename(_id, title.trim(), computer: _computer);
      if (!mounted) return;
      setState(() => _title = title.trim());
      unawaited(_store.refreshRecent());
    } catch (e) {
      if (mounted) toast(context, e.toString());
    }
  }

  void _openFile(String path) => Nav.instance.push(FileScreen(path: path, computer: _computer));

  void _openPanel() => showChatPanel(
        context,
        msgs: _msgs,
        id: _id,
        cwd: _cwd,
        usage: _usage,
        onOpenFile: _openFile,
      );

  // ── build ───────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final folder = folderLabel(_cwd);
    final firstAsk = _msgs.where((m) => m.isUser && !isHarnessNote(m)).map((m) => m.text.trim()).firstOrNull ?? '';
    final title = _title.isNotEmpty ? _title : (firstAsk.isNotEmpty ? firstAsk.replaceAll(RegExp(r'\s+'), ' ') : 'New chat');
    return Scaffold(
      resizeToAvoidBottomInset: true,
      appBar: AppBar(
        leading: widget.onMenu == null ? null : IconButton(tooltip: 'Menu', onPressed: widget.onMenu, icon: const Icon(Icons.menu_rounded)),
        titleSpacing: widget.onMenu == null ? 0 : 4,
        title: Row(children: [
          if (folder == 'Home')
            ...[Ava(name: 'Home', size: 24, color: t.active, letter: '⌂'), const SizedBox(width: 9)]
          else if (folder.isNotEmpty)
            ...[ProjectIcon(projectLabel(_cwd), size: 24), const SizedBox(width: 9)],
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16)),
              if (folder.isNotEmpty)
                Row(children: [
                  if (_busy) ...[PulseDot(color: t.accent, size: 6), const SizedBox(width: 2)],
                  Flexible(child: Text(_busy ? 'Working · $folder' : folder, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 12, fontWeight: FontWeight.w500))),
                  if (_computer == 'cloud') ...[const SizedBox(width: 5), const CloudBadge(size: 13)],
                ]),
            ]),
          ),
        ]),
        actions: [
          IconButton(tooltip: 'Talk', onPressed: () => openTalk(context), icon: Icon(Icons.graphic_eq_rounded, color: t.muted)),
          IconButton(tooltip: 'Files & progress', onPressed: _openPanel, icon: Icon(Icons.view_agenda_outlined, color: t.muted)),
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_horiz_rounded),
            onSelected: (v) {
              switch (v) {
                case 'rename':
                  _rename();
                case 'copy':
                  Clipboard.setData(ClipboardData(text: _id));
                  toast(context, 'Chat id copied');
                case 'stop':
                  _stopTurn();
                case 'folder':
                  Nav.instance.push(FileScreen(path: _cwd, isDir: true, computer: _computer));
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'rename', child: Text('Rename')),
              const PopupMenuItem(value: 'folder', child: Text('Browse project folder')),
              const PopupMenuItem(value: 'copy', child: Text('Copy chat id')),
              PopupMenuItem(value: 'stop', enabled: _busy, child: const Text('Stop all running work')),
            ],
          ),
        ],
      ),
      body: Column(children: [
        Expanded(child: Stack(children: [_stream(context), if (_hasNew) _newChip(context)])),
        _bottom(context),
      ]),
    );
  }

  /// Turns: a user message, then everything until the next one.
  List<({Msg? user, List<Msg> rest})> _turns() {
    final out = <({Msg? user, List<Msg> rest})>[];
    Msg? user;
    var rest = <Msg>[];
    for (final m in _msgs) {
      if (m.isUser && !m.side && !isHarnessNote(m)) {
        if (user != null || rest.isNotEmpty) out.add((user: user, rest: rest));
        user = m;
        rest = <Msg>[];
      } else {
        rest.add(m);
      }
    }
    if (user != null || rest.isNotEmpty) out.add((user: user, rest: rest));
    return out;
  }

  Widget _stream(BuildContext context) {
    final t = context.t;
    if (_loading) return Center(child: CircularProgressIndicator(color: t.accent, strokeWidth: 2));
    if (_loadError.isNotEmpty) {
      return EmptyState(
        icon: Icons.cloud_off_rounded,
        title: 'Could not load this chat',
        body: _loadError,
        action: FilledButton(onPressed: () {
          setState(() => _loading = true);
          _resync();
        }, child: const Text('Retry')),
      );
    }
    if (_msgs.isEmpty && _queue.isEmpty && !_busy) {
      return EmptyState(icon: Icons.chat_bubble_outline_rounded, title: _isNew ? 'What should we work on?' : 'Nothing here yet', body: _isNew ? 'in ${prettyPath(_cwd)}' : null);
    }
    final turns = _turns();
    final name = _store.turn.agent.isNotEmpty && _store.turn.agent != 'auto' ? _store.turn.agent : _store.assistantName;
    final rows = <Widget>[];
    for (var i = 0; i < turns.length; i++) {
      final tr = turns[i];
      final last = i == turns.length - 1;
      final live = last && _busy;
      if (tr.user != null) rows.add(UserBubble(key: ObjectKey(tr.user), text: tr.user!.text));
      if (tr.rest.isNotEmpty || live) {
        rows.add(AssistantTurn(
          key: ValueKey('turn-${tr.user?.hashCode ?? i}'),
          msgs: tr.rest,
          name: name,
          started: tr.user?.ts,
          live: live,
          liveSince: live ? _runSince : 0,
          showTech: _store.showTech,
          onChoice: last && !_busy ? (o) => _send(o) : null,
          onOpenFile: _openFile,
          footer: last && !_busy ? _footer : '',
        ));
      }
    }
    final jobs = _liveJobs;
    final extra = <Widget>[
      if (_busy && jobs.isNotEmpty) JobCard(title: _jobs.step.isNotEmpty ? _jobs.step : 'Working in the background', since: _runSince, jobs: jobs),
      if (_busy && jobs.isEmpty) Padding(padding: const EdgeInsets.only(left: 4), child: StatusLine(_progressLine(), spinner: true)),
      for (final q in _queue) UserBubble(text: q, queued: true),
      const SizedBox(height: 12),
    ];
    final all = [...rows, ...extra];
    return ListView.builder(
      controller: _scroll,
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.only(top: 8),
      itemCount: all.length,
      itemBuilder: (_, i) => all[i],
    );
  }

  String _progressLine() {
    final since = _runSince;
    final secs = since > 0 ? ((DateTime.now().millisecondsSinceEpoch - since) / 1000).floor() : 0;
    if (_remoteRunning) return '${_jobs.step.isNotEmpty ? _jobs.step : 'Working'}… ${secs}s';
    if (_hook.isNotEmpty) return '$_hook · ${secs}s';
    if (!_gotOutput) return 'Thinking… ${secs}s';
    final streaming = _msgs.isNotEmpty && _msgs.last.live;
    return streaming ? 'Writing… ${secs}s' : 'Working… ${secs}s';
  }

  Widget _newChip(BuildContext context) {
    final t = context.t;
    return Positioned(
      bottom: 12,
      left: 0,
      right: 0,
      child: Center(
        child: Material(
          color: t.accent,
          borderRadius: BorderRadius.circular(20),
          elevation: 3,
          child: InkWell(
            borderRadius: BorderRadius.circular(20),
            onTap: _scrollToBottomAnimated,
            child: Container(
              constraints: const BoxConstraints(minHeight: 44),
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.arrow_downward_rounded, size: 16, color: t.accentFg),
                const SizedBox(width: 6),
                Text('New', style: TextStyle(color: t.accentFg, fontWeight: FontWeight.w700, fontSize: 14)),
              ]),
            ),
          ),
        ),
      ),
    );
  }

  Widget _bottom(BuildContext context) {
    final t = context.t;
    final jobs = _busy ? _liveJobs : const <Job>[];
    return Container(
      color: t.bg,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 4, 10, 8),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (jobs.isNotEmpty) _JobsTray(jobs: jobs, since: _runSince),
            if (_computer == 'cloud' && _store.cloudOffline) CloudOfflineBanner(reason: _store.computerById('cloud')?.reason ?? '', inChat: true, margin: const EdgeInsets.only(bottom: 8)),
            if (_busy)
              Padding(
                padding: const EdgeInsets.fromLTRB(6, 2, 6, 6),
                child: Text('You can keep chatting. New messages go in when the current step ends.', style: TextStyle(color: t.faint, fontSize: 12)),
              ),
            Composer(
              controller: _input,
              focusNode: _focus,
              hint: 'Reply…',
              running: _busy,
              onStop: _stopTurn,
              onSend: _send,
            ),
          ]),
        ),
      ),
    );
  }
}

/// "2 running in the background" above the composer; tap to see each one.
class _JobsTray extends StatefulWidget {
  const _JobsTray({required this.jobs, required this.since});
  final List<Job> jobs;
  final int since;
  @override
  State<_JobsTray> createState() => _JobsTrayState();
}

class _JobsTrayState extends State<_JobsTray> {
  bool _open = false;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final n = widget.jobs.length;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(color: t.raised, borderRadius: BorderRadius.circular(14), border: Border.all(color: t.accent.withValues(alpha: .3))),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: () => setState(() => _open = !_open),
          child: Container(
            constraints: const BoxConstraints(minHeight: 44),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(children: [
              PulseDot(color: t.accent),
              const SizedBox(width: 6),
              Expanded(child: Text('$n running in the background', style: TextStyle(color: t.fg, fontSize: 13.5, fontWeight: FontWeight.w600))),
              if (widget.since > 0) Elapsed(widget.since),
              const SizedBox(width: 4),
              Icon(_open ? Icons.expand_more_rounded : Icons.expand_less_rounded, size: 18, color: t.faint),
            ]),
          ),
        ),
        if (_open)
          Container(
            decoration: BoxDecoration(border: Border(top: BorderSide(color: t.border))),
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 6),
            child: Column(children: [for (final j in widget.jobs) JobRow(j)]),
          ),
      ]),
    );
  }
}
