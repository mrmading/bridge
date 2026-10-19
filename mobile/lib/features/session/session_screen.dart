/// One session: history from /api/session, live updates from /api/follow, and turns sent through
/// /api/chat (contract §3-§5). The composer sits on the keyboard; send turns into stop while a
/// turn runs, and anything typed meanwhile is queued.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/common.dart';
import '../../widgets/transcript.dart';
import 'session_utils.dart';

const _modeLabels = {
  'acceptEdits': 'Edit freely',
  'plan': 'Plan first',
  'bypassPermissions': 'Full auto',
  'auto': 'Auto',
  'manual': 'Ask me',
  'dontAsk': "Don't ask",
};

class SessionScreen extends StatefulWidget {
  const SessionScreen({
    super.key,
    required this.key_,
    required this.id,
    required this.cwd,
    this.title = '',
    this.prefill = '',
    this.isNew = false,
    this.live,
    this.sendPrefill = false,
    this.focusComposer = false,
  });

  /// Project key (`key` collides with Widget.key).
  final String key_;
  final String id, cwd, title, prefill;
  final bool isNew;
  final LiveSession? live;
  /// Send [prefill] as the first message as soon as the screen opens.
  final bool sendPrefill;
  final bool focusComposer;

  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen> {
  final _store = AppStore.instance;
  BridgeApi get _api => _store.api;

  late String _key = widget.key_;
  late String _id = widget.id;
  late String _cwd = widget.cwd;
  late String _title = widget.title;
  late bool _isNew = widget.isNew;
  late LiveSession? _terminal = widget.live;

  final List<Msg> _msgs = [];
  final Map<String, Msg> _tools = {};
  final Set<String> _seen = {};
  bool _loading = true;
  String _loadError = '';
  int _offset = 0;

  // follow
  StreamSubscription<Frame>? _followSub;
  Timer? _followRetry;
  int _followFailures = 0;
  bool _gone = false;
  bool _disposed = false;

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
  Timer? _ticker;

  // composer
  late final TextEditingController _input = TextEditingController(text: widget.sendPrefill ? '' : widget.prefill);
  final _focus = FocusNode();
  final SpeechToText _stt = SpeechToText();
  bool _sttReady = false;
  bool _listening = false;
  String _sttBase = '';

  // scroll
  final _scroll = ScrollController();
  bool _atBottom = true;
  bool _hasNew = false;
  Timer? _paint;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _input.addListener(() => setState(() {}));
    _start();
  }

  Future<void> _start() async {
    if (_isNew) {
      setState(() => _loading = false);
    } else {
      await _resync();
    }
    if (!mounted) return;
    if (widget.sendPrefill && widget.prefill.trim().isNotEmpty) {
      _send(widget.prefill.trim());
    } else if (widget.focusComposer || widget.prefill.isNotEmpty) {
      _focus.requestFocus();
      _input.selection = TextSelection.collapsed(offset: _input.text.length);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _followSub?.cancel();
    _followRetry?.cancel();
    _chatSub?.cancel();
    _ticker?.cancel();
    _paint?.cancel();
    if (_listening) _stt.stop();
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
      final tr = await _api.session(_key, _id);
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
    _followSub = _api.follow(_key, _id, _offset).listen(
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
        if (changed) _touch(newContent: true);
      case 'gone':
        _gone = true;
        _stopFollow();
      default:
        break;
    }
  }

  // ── sending ─────────────────────────────────────────────────────────

  void _submit() {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    if (_listening) _stopListening();
    _input.clear();
    _send(text);
  }

  Future<void> _send(String text) async {
    if (_running) {
      setState(() => _queue.add(text));
      _jumpToBottomSoon(force: true);
      return;
    }
    if (_terminal != null) {
      final term = _terminal!;
      setState(() {
        _running = true;
        _hook = 'Taking over the terminal session…';
      });
      ({bool ok, String error}) r;
      try {
        r = await _api.takeover(term.pid, term.id);
      } catch (e) {
        r = (ok: false, error: e.toString());
      }
      if (!mounted) return;
      if (!r.ok) {
        setState(() {
          _running = false;
          _hook = '';
          _input.text = text;
        });
        toast(context, r.error.isEmpty ? 'Could not take over the terminal' : r.error);
        return;
      }
      setState(() => _terminal = null);
    }
    await _runTurn(text);
  }

  Future<void> _runTurn(String text) async {
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
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
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
        .chat(prompt: text, resume: _isNew ? null : _id, sessionId: _isNew ? _id : null, cwd: _cwd, options: opts)
        .listen(_onChatFrame, onError: (Object e) {
      if (mounted) toast(context, e.toString());
      _finishTurn();
    }, onDone: _finishTurn);
  }

  Future<void> _stopTurn() async {
    if (_listening) _stopListening();
    if (_abortKey.isEmpty) {
      toast(context, 'The turn has not started yet');
      return;
    }
    try {
      final ok = await _api.abort(_abortKey);
      if (!ok && mounted) toast(context, 'Nothing is running');
    } catch (e) {
      if (mounted) toast(context, e.toString());
    }
  }

  Future<void> _finishTurn() async {
    if (!_running || !mounted) return;
    _chatSub?.cancel();
    _chatSub = null;
    _ticker?.cancel();
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
    if (started) {
      _isNew = false;
      await _resync();
    } else if (!_isNew) {
      _startFollow();
    }
    if (!mounted) return;
    if (_queue.isNotEmpty) {
      final next = _queue.removeAt(0);
      _send(next);
    }
  }

  void _onChatFrame(Frame f) {
    switch (f.t) {
      case 'auth':
        toast(context, 'Sign in on the Settings tab');
      case 'start':
        _turnStarted = true;
        _abortKey = (f.json['sessionId'] ?? '').toString();
        final c = (f.json['cwd'] ?? '').toString();
        if (c.isNotEmpty && c != _cwd) {
          // Outside the roots the server silently falls back to $HOME (gotcha 8).
          _cwd = c;
          if (_isNew) _key = projectKeyFor(c);
        }
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
        final cost = d['total_cost_usd'];
        if (cost is num) parts.add('\$${cost.toStringAsFixed(cost < 1 ? 4 : 2)}');
        final ms = d['duration_ms'];
        if (ms is num) parts.add('${(ms / 1000).toStringAsFixed(1)}s');
        final n = d['num_turns'];
        if (n is num) parts.add('${n.toInt()} ${n == 1 ? 'step' : 'steps'}');
        if (d['is_error'] == true) parts.add((d['subtype'] ?? 'error').toString());
        _footer = parts.join(' · ');
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

  // ── voice ───────────────────────────────────────────────────────────

  Future<void> _toggleMic() async {
    if (_listening) {
      _stopListening();
      return;
    }
    if (!_sttReady) {
      try {
        _sttReady = await _stt.initialize(
          onStatus: (s) {
            if ((s == 'done' || s == 'notListening') && mounted && _listening) setState(() => _listening = false);
          },
          onError: (e) {
            if (!mounted) return;
            setState(() => _listening = false);
            if (e.permanent) toast(context, 'Voice input stopped: ${e.errorMsg}');
          },
        );
      } catch (_) {
        _sttReady = false;
      }
      if (!mounted) return;
      if (!_sttReady) {
        toast(context, 'Voice input is not available on this device');
        return;
      }
    }
    _sttBase = _input.text.trimRight();
    setState(() => _listening = true);
    try {
      await _stt.listen(
        onResult: _onSpeech,
        listenOptions: SpeechListenOptions(partialResults: true, listenMode: ListenMode.dictation, cancelOnError: true),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _listening = false);
      toast(context, 'Could not start voice input');
    }
  }

  void _onSpeech(SpeechRecognitionResult r) {
    final words = r.recognizedWords;
    final text = _sttBase.isEmpty ? words : '$_sttBase $words';
    _input.value = TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
    if (r.finalResult && mounted) setState(() => _listening = false);
  }

  void _stopListening() {
    _stt.stop();
    setState(() => _listening = false);
  }

  // ── menus + sheets ──────────────────────────────────────────────────

  Future<void> _rename() async {
    final c = TextEditingController(text: _title);
    final title = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Rename session'),
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
      await _api.rename(_id, title.trim());
      if (!mounted) return;
      setState(() => _title = title.trim());
      unawaited(_store.refreshRecent());
    } catch (e) {
      if (mounted) toast(context, e.toString());
    }
  }

  void _openTune() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => const _TuneSheet(),
    );
  }

  // ── build ───────────────────────────────────────────────────────────

  String _statusKind() {
    final live = liveFor(_id);
    if (_running || live?.busy == true) return 'running';
    if (live?.waiting != null) return 'waiting';
    return 'idle';
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final folder = baseName(_cwd);
    return Scaffold(
      resizeToAvoidBottomInset: true,
      appBar: AppBar(
        titleSpacing: 0,
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_title.isNotEmpty ? _title : (folder.isNotEmpty ? folder : 'New session'), maxLines: 1, overflow: TextOverflow.ellipsis),
          if (folder.isNotEmpty) Text(folder, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 12.5, fontWeight: FontWeight.w500)),
        ]),
        actions: [
          ListenableBuilder(
            listenable: _store,
            builder: (_, _) {
              final k = _statusKind();
              return Center(child: StatusPill(k, kind: k));
            },
          ),
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_horiz_rounded),
            onSelected: (v) {
              switch (v) {
                case 'rename':
                  _rename();
                case 'copy':
                  Clipboard.setData(ClipboardData(text: _id));
                  toast(context, 'Session id copied');
                case 'stop':
                  _stopTurn();
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'rename', child: Text('Rename')),
              const PopupMenuItem(value: 'copy', child: Text('Copy session id')),
              PopupMenuItem(value: 'stop', enabled: _running, child: const Text('Stop turn')),
            ],
          ),
        ],
      ),
      body: Column(children: [
        if (_terminal != null) _terminalBanner(context),
        Expanded(child: Stack(children: [_stream(context), if (_hasNew) _newChip(context)])),
        _composer(context),
      ]),
    );
  }

  Widget _terminalBanner(BuildContext context) {
    final t = context.t;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(color: t.warnSoft, border: Border(bottom: BorderSide(color: t.border))),
      child: Row(children: [
        Icon(Icons.terminal_rounded, size: 16, color: t.warn),
        const SizedBox(width: 8),
        Expanded(child: Text('Running in a terminal on the server. Sending takes it over.', style: TextStyle(color: t.warn, fontSize: 13, fontWeight: FontWeight.w600))),
      ]),
    );
  }

  Widget _stream(BuildContext context) {
    final t = context.t;
    if (_loading) return Center(child: CircularProgressIndicator(color: t.accent, strokeWidth: 2));
    if (_loadError.isNotEmpty) {
      return EmptyState(
        icon: Icons.cloud_off_rounded,
        title: 'Could not load this session',
        body: _loadError,
        action: FilledButton(onPressed: () {
          setState(() => _loading = true);
          _resync();
        }, child: const Text('Retry')),
      );
    }
    if (_msgs.isEmpty && _queue.isEmpty && !_running) {
      return EmptyState(icon: Icons.chat_bubble_outline_rounded, title: _isNew ? 'New session' : 'Nothing here yet', body: _isNew ? 'in ${prettyPath(_cwd)}' : null);
    }
    final lastAssistant = _msgs.lastIndexWhere((m) => m.isAssistant);
    final extra = <Widget>[
      for (final q in _queue) UserBubble(text: q, queued: true),
      if (_running) StatusLine(_progressLine(), spinner: true),
      if (!_running && _footer.isNotEmpty) StatusLine(_footer),
      const SizedBox(height: 12),
    ];
    return ListView.builder(
      controller: _scroll,
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.only(top: 8),
      itemCount: _msgs.length + extra.length,
      itemBuilder: (_, i) {
        if (i >= _msgs.length) return extra[i - _msgs.length];
        final m = _msgs[i];
        return MsgRow(
          key: ObjectKey(m),
          msg: m,
          // Only the latest assistant message offers live choices.
          onChoice: i == lastAssistant ? (o) => _send(o) : null,
        );
      },
    );
  }

  String _progressLine() {
    final secs = DateTime.now().difference(_turnStart).inSeconds;
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

  Widget _composer(BuildContext context) {
    final t = context.t;
    final hasText = _input.text.trim().isNotEmpty;
    Widget btn({required IconData icon, required VoidCallback onTap, required String tip, Color? fg, Color? bg}) => SizedBox(
          width: 44,
          height: 44,
          child: IconButton(
            tooltip: tip,
            onPressed: onTap,
            style: IconButton.styleFrom(backgroundColor: bg, foregroundColor: fg ?? t.muted, shape: const CircleBorder()),
            icon: Icon(icon, size: 22),
          ),
        );
    return Container(
      decoration: BoxDecoration(color: t.bg, border: Border(top: BorderSide(color: t.border))),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            if (!_running) btn(icon: Icons.tune_rounded, onTap: _openTune, tip: 'Model, mode, effort, agent'),
            const SizedBox(width: 4),
            Expanded(
              child: TextField(
                controller: _input,
                focusNode: _focus,
                minLines: 1,
                maxLines: 6,
                keyboardType: TextInputType.multiline,
                textCapitalization: TextCapitalization.sentences,
                style: TextStyle(color: t.fg, fontSize: 16, height: 1.35),
                decoration: InputDecoration(
                  hintText: _listening ? 'Listening…' : (_running ? 'Queue a message…' : 'Message'),
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: t.borderStrong)),
                  enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: t.borderStrong)),
                  focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: t.accent, width: 1.4)),
                ),
              ),
            ),
            const SizedBox(width: 4),
            btn(
              icon: _listening ? Icons.stop_circle_outlined : Icons.mic_none_rounded,
              onTap: _toggleMic,
              tip: _listening ? 'Stop listening' : 'Dictate',
              fg: _listening ? t.err : t.muted,
              bg: _listening ? t.errSoft : null,
            ),
            if (_running) ...[
              const SizedBox(width: 4),
              btn(icon: Icons.stop_rounded, onTap: _stopTurn, tip: 'Stop turn', fg: t.err, bg: t.errSoft),
            ],
            if (!_running || hasText) ...[
              const SizedBox(width: 4),
              btn(
                icon: Icons.arrow_upward_rounded,
                onTap: hasText ? _submit : () {},
                tip: _running ? 'Queue' : 'Send',
                fg: hasText ? t.accentFg : t.faint,
                bg: hasText ? t.accent : t.active,
              ),
            ],
          ]),
        ),
      ),
    );
  }
}

/// Model · permission mode · effort · agent, persisted with store.setTurn.
class _TuneSheet extends StatelessWidget {
  const _TuneSheet();

  @override
  Widget build(BuildContext context) {
    final store = AppStore.instance;
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final t = context.t;
        final boot = store.boot;
        final turn = store.turn;
        final models = ['', ...?boot?.models.where((m) => m.isNotEmpty)];
        final modes = boot?.permissionModes ?? const ['acceptEdits', 'plan', 'bypassPermissions'];
        final efforts = boot?.efforts ?? const ['', 'low', 'medium', 'high'];
        final agents = ['', 'auto', ...store.agents.map((a) => a.name)];
        void set({String? model, String? mode, String? effort, String? agent}) => store.setTurn(TurnOptions(
              model: model ?? turn.model,
              permissionMode: mode ?? turn.permissionMode,
              effort: effort ?? turn.effort,
              agent: agent ?? turn.agent,
            ));
        Widget group(String title, List<String> values, String current, String Function(String) label, void Function(String) onPick) => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(padding: const EdgeInsets.fromLTRB(4, 14, 4, 8), child: Text(title.toUpperCase(), style: TextStyle(color: t.faint, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.1))),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final v in values)
                    ChoiceChip(
                      label: Text(label(v)),
                      selected: v == current,
                      showCheckmark: false,
                      materialTapTargetSize: MaterialTapTargetSize.padded,
                      labelStyle: TextStyle(color: v == current ? t.accentFg : t.fg, fontSize: 14, fontWeight: FontWeight.w600),
                      selectedColor: t.accent,
                      backgroundColor: t.active,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                      side: BorderSide.none,
                      onSelected: (_) => onPick(v),
                    ),
                ]),
              ],
            );
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: .62,
          minChildSize: .3,
          maxChildSize: .92,
          builder: (_, sc) => ListView(
            controller: sc,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
            children: [
              Text('Turn settings', style: TextStyle(color: t.fg, fontSize: 17, fontWeight: FontWeight.w700)),
              const SizedBox(height: 2),
              Text('Applies to the next message you send.', style: TextStyle(color: t.muted, fontSize: 13)),
              group('Model', models, turn.model, (v) => v.isEmpty ? 'Default' : v, (v) => set(model: v)),
              group('Mode', modes, turn.permissionMode, (v) => _modeLabels[v] ?? v, (v) => set(mode: v)),
              group('Effort', efforts, turn.effort, (v) => v.isEmpty ? 'Default' : v, (v) => set(effort: v)),
              group('Agent', agents, turn.agent, (v) => v.isEmpty ? 'None' : (v == 'auto' ? 'Auto' : v), (v) => set(agent: v)),
            ],
          ),
        );
      },
    );
  }
}
