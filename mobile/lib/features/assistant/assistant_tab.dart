/// The home tab: talk to the desk (the server's long-lived assistant session).
/// Voice mode shows the orb, two caption lines and a hold-to-talk mic. Text mode shows the chat.
/// Contract: docs/api-contract.md §6 (desk) and §7 (voice).
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/common.dart';
import '../../widgets/orb.dart';

/// One row of the desk conversation. kind ∈ user · assistant · tool.
class _Item {
  _Item(this.kind, this.text, {this.live = false});
  final String kind;
  String text;
  bool live;
}

class AssistantTab extends StatefulWidget {
  const AssistantTab({super.key});

  /// Set to a tab index to ask the Shell to switch tabs (3 = Settings). The Shell resets it to -1.
  static final ValueNotifier<int> requestedTab = ValueNotifier(-1);

  @override
  State<AssistantTab> createState() => _AssistantTabState();
}

class _AssistantTabState extends State<AssistantTab> {
  final store = AppStore.instance;

  // ── desk stream ──
  StreamSubscription<Frame>? _sub;
  Timer? _retry;
  String _apiBase = '';
  int _seq = 0;
  bool _connected = false;
  bool _historyLoaded = false;
  DaState _da = DaState.empty;

  // ── conversation ──
  final List<_Item> _items = [];
  _Item? _liveText; // assistant row being streamed into
  bool _sawStream = false; // this message had text deltas, so ignore its full-text copy
  _Item? _turnReply; // last assistant row of the current turn, spoken when the turn ends
  bool _pending = false; // sent, waiting for the desk to pick it up
  bool _toolsThisTurn = false;
  String? _echoSkip; // optimistic text we already showed; skip its echo once
  String _youCaption = '';
  String _daCaption = '';
  final List<LiveEvent> _events = [];

  // ── voice ──
  final SpeechToText _stt = SpeechToText();
  bool _sttReady = false;
  bool _listening = false;
  bool _holding = false;
  bool _intoField = false;
  bool _finishing = false;
  String _partial = '';
  double _micLevel = 0;
  final FlutterTts _ftts = FlutterTts();
  AudioPlayer? _player;
  StreamSubscription<void>? _playerDone;
  StreamSubscription<PlayerState>? _playerState;
  bool _speaking = false;
  Timer? _speakTimer;
  Timer? _levelTimer;
  double _speakLevel = 0;

  // ── ui ──
  bool _textMode = false;
  final TextEditingController _input = TextEditingController();
  final FocusNode _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    store.addListener(_onStore);
    _ftts.awaitSpeakCompletion(true).catchError((_) => null);
    _onStore();
  }

  @override
  void dispose() {
    store.removeListener(_onStore);
    _retry?.cancel();
    _sub?.cancel();
    _speakTimer?.cancel();
    _levelTimer?.cancel();
    _playerDone?.cancel();
    _playerState?.cancel();
    _player?.dispose();
    _ftts.stop().catchError((_) => null);
    _stt.cancel().catchError((_) => null);
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  // ═══ stream ═══════════════════════════════════════════════════════════

  /// (Re)opens the desk stream whenever the store points at a new, ready server.
  void _onStore() {
    final ready = store.hasServer && store.conn == ConnState.ready;
    final base = ready ? store.api.base : '';
    if (base == _apiBase) {
      if (mounted) setState(() {});
      return;
    }
    _apiBase = base;
    _retry?.cancel();
    _sub?.cancel();
    _sub = null;
    _items.clear();
    _events.clear();
    _liveText = null;
    _turnReply = null;
    _historyLoaded = false;
    _connected = false;
    _seq = 0;
    _youCaption = '';
    _daCaption = '';
    if (base.isNotEmpty) _open(resume: false);
    if (mounted) setState(() {});
  }

  void _open({required bool resume}) {
    if (_apiBase.isEmpty) return;
    final stream = resume ? store.api.daStream(since: _seq, replay: true) : store.api.daStream(since: 0, replay: false);
    _sub = stream.listen(_onFrame, onError: (_) => _lost(), onDone: _lost, cancelOnError: true);
  }

  void _lost() {
    _sub = null;
    if (!mounted || _apiBase.isEmpty) return;
    setState(() => _connected = false);
    _retry?.cancel();
    _retry = Timer(const Duration(seconds: 2), () {
      if (mounted && _sub == null && _apiBase.isNotEmpty) _open(resume: _historyLoaded);
    });
  }

  void _onFrame(Frame f) {
    final seq = f.json['seq'];
    switch (f.t) {
      case 'hello':
        _da = DaState.fromJson(f.dMap);
        _connected = true;
        final helloSeq = seq is num ? seq.toInt() : 0;
        if (!_historyLoaded) {
          _seq = helloSeq;
          _loadHistory();
        } else if (helloSeq - _seq > 600) {
          // The replay ring overflowed while we were away: the transcript is the truth.
          _seq = helloSeq;
          _items.clear();
          _loadHistory();
        }
      case 'state':
        final next = DaState.fromJson(f.dMap);
        if (_da.sessionId.isNotEmpty && next.sessionId.isNotEmpty && next.sessionId != _da.sessionId) {
          // Reset or config change: a brand-new conversation.
          _items.clear();
          _liveText = null;
          _turnReply = null;
          _youCaption = '';
          _daCaption = '';
        }
        _da = next;
        if (_da.busy) _pending = false;
      case 'user':
        // A new turn started (here or on another client): whatever was being said is stale.
        if (_speaking) unawaited(_stopSpeaking());
        final text = stripBridgeBlock((f.dMap?['text'] ?? '').toString()).trim();
        if (text.isNotEmpty) {
          if (_echoSkip != null && _echoSkip == text) {
            _echoSkip = null;
          } else {
            _items.add(_Item('user', text));
            _youCaption = text;
          }
        }
        _toolsThisTurn = false;
        _turnReply = null;
      case 'da':
        final d = f.dMap;
        if (d != null) _onDa(d, f.json['ts']);
      case 'event':
        final m = f.dMap;
        if (m != null) {
          _events.insert(0, LiveEvent.fromJson(m));
          if (_events.length > 100) _events.removeLast();
        }
    }
    if (seq is num && seq.toInt() > _seq) _seq = seq.toInt();
    if (mounted) setState(() {});
  }

  void _onDa(Map<String, dynamic> d, dynamic ts) {
    if (d['parent_tool_use_id'] != null) return; // subagent chatter stays out of the desk view
    switch (d['type']) {
      case 'stream_event':
        final ev = d['event'] is Map ? Map<String, dynamic>.from(d['event'] as Map) : const <String, dynamic>{};
        switch (ev['type']) {
          case 'message_start':
            _closeLive();
            _sawStream = false;
          case 'content_block_delta':
            final delta = ev['delta'] is Map ? ev['delta'] as Map : const {};
            if (delta['type'] == 'text_delta') {
              _sawStream = true;
              _appendText((delta['text'] ?? '').toString());
            }
        }
      case 'assistant':
        final msg = d['message'] is Map ? d['message'] as Map : const {};
        final content = msg['content'] is List ? msg['content'] as List : const [];
        for (final b in content) {
          if (b is! Map) continue;
          if (b['type'] == 'tool_use') {
            _closeLive();
            _toolsThisTurn = true;
            _items.add(_Item('tool', _toolLine((b['name'] ?? '').toString(), b['input'] is Map ? Map<String, dynamic>.from(b['input'] as Map) : const {})));
          } else if (b['type'] == 'text' && !_sawStream) {
            _appendText((b['text'] ?? '').toString());
          }
        }
        _closeLive();
      case 'result':
        _closeLive();
        _pending = false;
        final reply = _turnReply;
        _turnReply = null;
        // Only speak turns that just finished, not ones replayed after a reconnect.
        final fresh = ts is! num || DateTime.now().millisecondsSinceEpoch - ts.toInt() < 60000;
        if (reply != null && reply.text.trim().isNotEmpty && fresh && store.speakReplies) {
          unawaited(_speak(reply.text));
        }
    }
  }

  void _appendText(String s) {
    if (s.isEmpty) return;
    var row = _liveText;
    if (row == null) {
      row = _Item('assistant', '', live: true);
      _items.add(row);
      _liveText = row;
    }
    row.text += s;
    _turnReply = row;
    _daCaption = row.text;
  }

  void _closeLive() {
    _liveText?.live = false;
    _liveText = null;
  }

  Future<void> _loadHistory() async {
    _historyLoaded = true;
    final home = store.boot?.home ?? '';
    final id = _da.historyId;
    if (home.isEmpty || id.isEmpty) return;
    try {
      final tr = await store.api.session(home.replaceAll(RegExp(r'[^A-Za-z0-9]'), '-'), id);
      final hist = <_Item>[];
      for (final m in tr.msgs) {
        if (m.side) continue;
        if (m.kind == 'user') {
          final text = stripBridgeBlock(m.text).trim();
          if (text.isNotEmpty) hist.add(_Item('user', text));
        } else if (m.kind == 'assistant') {
          if (m.text.trim().isNotEmpty) hist.add(_Item('assistant', m.text));
        } else if (m.kind == 'tool') {
          hist.add(_Item('tool', _toolLine(m.name, m.input ?? const {})));
        }
      }
      if (!mounted) return;
      setState(() {
        _items.insertAll(0, hist);
        if (_youCaption.isEmpty) _youCaption = hist.lastWhere((i) => i.kind == 'user', orElse: () => _Item('user', '')).text;
        if (_daCaption.isEmpty) _daCaption = hist.lastWhere((i) => i.kind == 'assistant', orElse: () => _Item('assistant', '')).text;
      });
    } catch (_) {
      // History is a nicety; the live stream still works without it.
    }
  }

  static String _toolLine(String name, Map<String, dynamic> input) {
    String arg = '';
    for (final k in ['file_path', 'path', 'notebook_path', 'pattern', 'command', 'url', 'query', 'description', 'prompt', 'skill', 'subagent_type']) {
      final v = input[k];
      if (v is String && v.trim().isNotEmpty) {
        arg = v.trim();
        break;
      }
    }
    if (arg.startsWith('/')) arg = arg.split('/').where((p) => p.isNotEmpty).lastOrNull ?? arg;
    arg = arg.replaceAll(RegExp(r'\s+'), ' ');
    if (arg.length > 48) arg = '${arg.substring(0, 47)}…';
    return arg.isEmpty ? name : '$name $arg';
  }

  // ═══ sending ══════════════════════════════════════════════════════════

  Future<void> _send(String raw) async {
    final text = raw.trim();
    if (text.isEmpty || _apiBase.isEmpty) return;
    if (!store.auth.loggedIn) {
      toast(context, 'Sign in to Claude first (Settings)');
      return;
    }
    await _stopSpeaking();
    setState(() {
      _items.add(_Item('user', text));
      _echoSkip = text;
      _youCaption = text;
      _daCaption = '';
      _pending = true;
    });
    try {
      final r = await store.api.daSend(text);
      if (!mounted) return;
      if (r == 'queued') {
        toast(context, 'Queued: it goes in after the current reply');
      } else if (r != 'ok') {
        setState(() {
          _pending = false;
          _echoSkip = null;
        });
        toast(context, r);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _pending = false;
        _echoSkip = null;
      });
      toast(context, 'Could not send: $e');
    }
  }

  Future<void> _interrupt() async {
    await _stopSpeaking();
    if (_da.busy || _pending) {
      try {
        await store.api.daInterrupt();
      } catch (_) {}
      setState(() => _pending = false);
    }
  }

  // ═══ listening ════════════════════════════════════════════════════════

  Future<bool> _ensureStt() async {
    if (_sttReady) return true;
    try {
      _sttReady = await _stt.initialize(onStatus: _onSttStatus, onError: (e) {
        if (e.permanent && mounted) {
          _finishListening(send: false);
          if (e.errorMsg != 'error_no_match' && e.errorMsg != 'error_speech_timeout') toast(context, 'Speech: ${e.errorMsg}');
        }
      });
    } catch (_) {
      _sttReady = false;
    }
    if (!_sttReady && mounted) toast(context, kIsWeb ? 'No speech recognition in this browser' : 'Speech recognition is not available (check microphone permission)');
    return _sttReady;
  }

  void _onSttStatus(String s) {
    // The recognizer stops on its own after a pause. In tap mode that is the end of the utterance.
    if ((s == 'done' || s == 'notListening') && _listening && !_holding) _finishListening(send: !_intoField);
  }

  Future<void> _startListening({bool intoField = false}) async {
    if (_listening) return;
    if (!await _ensureStt()) return;
    await _stopSpeaking();
    if (!mounted) return;
    setState(() {
      _listening = true;
      _finishing = false;
      _intoField = intoField;
      _partial = '';
      _micLevel = 0;
    });
    final prefix = intoField && _input.text.trim().isNotEmpty ? '${_input.text.trimRight()} ' : '';
    try {
      await _stt.listen(
        onResult: (r) {
          if (!mounted) return;
          setState(() {
            _partial = r.recognizedWords;
            if (_intoField) {
              _input.text = '$prefix$_partial';
              _input.selection = TextSelection.collapsed(offset: _input.text.length);
            }
          });
        },
        onSoundLevelChange: (l) {
          // iOS reports dBFS (about -50..0); Android and web report about -2..10.
          final n = l < 0 ? (l + 50) / 50 : l / 10;
          _micLevel = _micLevel * .5 + n.clamp(0.0, 1.0) * .5;
        },
        listenOptions: SpeechListenOptions(partialResults: true, listenMode: ListenMode.dictation, cancelOnError: true, pauseFor: const Duration(seconds: 3), listenFor: const Duration(minutes: 2)),
      );
    } catch (e) {
      if (mounted) {
        setState(() => _listening = false);
        toast(context, 'Could not start the microphone: $e');
      }
    }
  }

  /// Stops listening; in voice mode the final transcript is sent.
  Future<void> _finishListening({required bool send}) async {
    if (!_listening || _finishing) return;
    _finishing = true;
    _holding = false;
    try {
      await _stt.stop();
    } catch (_) {}
    // The final result can land just after stop().
    await Future<void>.delayed(const Duration(milliseconds: 350));
    if (!mounted) return;
    final text = _partial.trim();
    setState(() {
      _listening = false;
      _finishing = false;
      _micLevel = 0;
    });
    if (send && !_intoField && text.isNotEmpty) await _send(text);
  }

  void _micTap() {
    if (_listening) {
      _finishListening(send: true);
    } else {
      _startListening();
    }
  }

  // ═══ speaking ═════════════════════════════════════════════════════════

  /// Reply text minus the parts nobody wants read aloud.
  static String _speakable(String md) {
    var s = splitChoices(md).text;
    s = s.replaceAll(RegExp(r'```[\s\S]*?```'), ' ');
    s = s.replaceAll(RegExp(r'`([^`]*)`'), r'$1');
    s = s.replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m.group(1)!);
    s = s.replaceAll(RegExp(r'^\s{0,3}#{1,6}\s*', multiLine: true), '');
    s = s.replaceAll(RegExp(r'^\s*[-*+]\s+', multiLine: true), '');
    s = s.replaceAll(RegExp(r'[*_~|>]+'), '');
    return s.replaceAll(RegExp(r'\s+'), ' ').trim();
  }

  /// Bumped on every new utterance and every stop, so late callbacks from an old one are ignored.
  int _speechGen = 0;

  Future<void> _speak(String text) async {
    final say = _speakable(text);
    if (say.isEmpty) return;
    await _stopSpeaking();
    if (!mounted) return;
    final gen = ++_speechGen;
    setState(() => _speaking = true);
    _startSpeakLevel();
    // Guard while the audio is fetched (Kokoro can take a few seconds to synthesize).
    _armGuard(gen, const Duration(seconds: 25));
    try {
      final r = await store.api.tts(say);
      if (gen != _speechGen || !_speaking) return; // interrupted while fetching
      final words = r.words > 0 ? r.words : say.split(' ').where((w) => w.isNotEmpty).length;
      // Whatever path plays it, the orb returns to idle by this point at the latest. Completion
      // events are unreliable on web (home-screen web apps especially).
      final guard = Duration(milliseconds: math.max(2000, (words / 2.7 * 1000).round() + 1500));
      _armGuard(gen, guard);
      if (r.audio != null) {
        final p = _player ??= AudioPlayer();
        await _playerDone?.cancel();
        await _playerState?.cancel();
        _playerDone = p.onPlayerComplete.listen((_) => _speechEnded(gen));
        _playerState = p.onPlayerStateChanged.listen((st) {
          if (st == PlayerState.completed || st == PlayerState.stopped) _speechEnded(gen);
        });
        // Not awaited: on web play() can hang when autoplay is blocked; the guard covers it.
        p.play(BytesSource(r.audio!, mimeType: r.mime.split(';').first)).catchError((_) => _speechEnded(gen));
        return;
      }
      if (r.playedOnServer) return; // audio plays on the Mac; the guard timer ends the phase
      await _speakOnDevice(say, gen);
    } catch (_) {
      _speechEnded(gen);
    }
  }

  void _armGuard(int gen, Duration d) {
    _speakTimer?.cancel();
    _speakTimer = Timer(d, () => _speechEnded(gen));
  }

  Future<void> _speakOnDevice(String say, int gen) async {
    try {
      await _ftts.speak(say);
    } catch (_) {}
    _speechEnded(gen);
  }

  void _speechEnded(int gen) {
    if (gen != _speechGen || !_speaking) return;
    _speechGen++;
    _speaking = false;
    _speakLevel = 0;
    _speakTimer?.cancel();
    _levelTimer?.cancel();
    if (!mounted) return;
    setState(() {});
    if (store.handsFree && !_textMode && store.auth.loggedIn) _startListening();
  }

  Future<void> _stopSpeaking() async {
    _speechGen++;
    _speakTimer?.cancel();
    _levelTimer?.cancel();
    if (!_speaking) return;
    _speaking = false;
    _speakLevel = 0;
    if (mounted) setState(() {});
    try {
      await _player?.stop();
    } catch (_) {}
    try {
      await _ftts.stop();
    } catch (_) {}
  }

  /// No amplitude comes back from any of the three speech paths, so fake a speech-like envelope.
  void _startSpeakLevel() {
    _levelTimer?.cancel();
    final rnd = math.Random();
    _levelTimer = Timer.periodic(const Duration(milliseconds: 90), (_) {
      _speakLevel = _speakLevel * .45 + rnd.nextDouble() * .55;
    });
  }

  // ═══ derived ══════════════════════════════════════════════════════════

  String get _phase {
    if (_apiBase.isEmpty || !_connected) return 'offline';
    if (_listening) return 'listening';
    if (_speaking) return 'speaking';
    if (_da.busy || _pending) return _toolsThisTurn ? 'working' : 'thinking';
    return 'idle';
  }

  String get _stateLine {
    if (store.conn == ConnState.connecting) return 'connecting…';
    if (_apiBase.isEmpty || !_connected) return 'offline';
    if (!store.auth.loggedIn) return 'not signed in';
    return switch (_phase) {
      'listening' => 'listening',
      'speaking' => 'speaking',
      'thinking' => _da.queued > 0 ? 'thinking · ${_da.queued} queued' : 'thinking',
      'working' => 'working',
      _ => 'ready',
    };
  }

  List<LiveEvent> get _allEvents {
    final seen = <String>{};
    final all = <LiveEvent>[];
    for (final e in [..._events, ...store.live.events]) {
      if (seen.add('${e.kind}|${e.id}|${e.at}')) all.add(e);
    }
    all.sort((a, b) => b.at.compareTo(a.at));
    return all;
  }

  // ═══ ui ═══════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ColoredBox(
      color: t.bg,
      child: SafeArea(
        child: Column(children: [
          _header(context),
          ..._banners(context),
          Expanded(child: AnimatedSwitcher(duration: const Duration(milliseconds: 180), child: _textMode ? _chat(context) : _voice(context))),
          if (_textMode) _composer(context) else _voiceControls(context),
        ]),
      ),
    );
  }

  Widget _header(BuildContext context) {
    final t = context.t;
    final phase = _phase;
    final dotColor = switch (phase) {
      'offline' => t.faint,
      'listening' => t.accent2,
      'thinking' || 'working' => t.think,
      'speaking' => t.accent,
      _ => store.auth.loggedIn ? t.ok : t.warn,
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 12, 4),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(store.assistantName, style: TextStyle(color: t.fg, fontSize: 22, fontWeight: FontWeight.w700)),
            const SizedBox(height: 2),
            Row(children: [
              StatusDot(dotColor, size: 7, glow: phase != 'offline' && phase != 'idle'),
              const SizedBox(width: 7),
              Text(_stateLine, style: TextStyle(color: t.muted, fontSize: 13)),
            ]),
          ]),
        ),
        if (_textMode)
          // Same sheet as the voice-mode button; 48x48 hit area.
          SizedBox.square(
            dimension: 48,
            child: IconButton(
              tooltip: 'Updates',
              onPressed: () => _openUpdates(context),
              style: IconButton.styleFrom(minimumSize: const Size(48, 48), tapTargetSize: MaterialTapTargetSize.padded),
              icon: Badge(isLabelVisible: _allEvents.isNotEmpty, smallSize: 7, backgroundColor: t.accent, child: Icon(Icons.notifications_none_rounded, color: t.muted)),
            ),
          ),
      ]),
    );
  }

  List<Widget> _banners(BuildContext context) {
    final t = context.t;
    final out = <Widget>[];
    if (store.conn == ConnState.ready && !store.auth.loggedIn) {
      out.add(Card2(
        margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        accent: true,
        onTap: () => AssistantTab.requestedTab.value = 3,
        child: Row(children: [
          Icon(Icons.lock_outline_rounded, color: t.accent, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Sign in to talk', style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600)),
              Text('Claude Code on this server is not signed in.', style: TextStyle(color: t.muted, fontSize: 13)),
            ]),
          ),
          Icon(Icons.chevron_right_rounded, color: t.faint),
        ]),
      ));
    }
    if (!_da.alive && _da.error.isNotEmpty) {
      out.add(Container(
        width: double.infinity,
        margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: t.errSoft, borderRadius: BorderRadius.circular(14)),
        child: Text(_da.error, style: TextStyle(color: t.err, fontSize: 13), maxLines: 4, overflow: TextOverflow.ellipsis),
      ));
    }
    return out;
  }

  // ── voice mode ──

  Widget _voice(BuildContext context) {
    final t = context.t;
    final phase = _phase;
    final level = phase == 'listening' ? _micLevel : (phase == 'speaking' ? _speakLevel : 0.0);
    final youText = _listening ? (_partial.isEmpty ? 'Listening…' : _partial) : _youCaption;
    final daText = _speakable(_daCaption);
    return LayoutBuilder(
      key: const ValueKey('voice'),
      builder: (context, box) {
        final orbSize = math.min(220.0, math.max(140.0, box.maxHeight - 170));
        return Column(children: [
          const Spacer(),
          Semantics(
            button: true,
            label: phase == 'thinking' || phase == 'working' || phase == 'speaking' ? 'Interrupt' : 'Talk',
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () {
                if (phase == 'thinking' || phase == 'working' || phase == 'speaking') {
                  _interrupt();
                } else if (phase != 'offline') {
                  _micTap();
                }
              },
              child: Orb(phase: phase, level: level, color: store.accent, size: orbSize),
            ),
          ),
          const SizedBox(height: 18),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 28),
            child: Column(children: [
              _fade(
                youText,
                Text(youText, key: ValueKey('you:$youText'), textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: _listening ? t.accent2 : t.muted, fontSize: 15)),
              ),
              const SizedBox(height: 10),
              _fade(
                daText,
                GestureDetector(
                  key: ValueKey('da:${_daCaption.hashCode}'),
                  onTap: _daCaption.isEmpty ? null : () => _openReply(context, _daCaption),
                  child: Column(children: [
                    Text(daText, textAlign: TextAlign.center, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 17, height: 1.4)),
                    if (daText.length > 130 || _daCaption.contains('\n'))
                      Padding(padding: const EdgeInsets.only(top: 4), child: Text('tap to read more', style: TextStyle(color: t.faint, fontSize: 12))),
                  ]),
                ),
              ),
            ]),
          ),
          const Spacer(),
        ]);
      },
    );
  }

  Widget _fade(String text, Widget child) => AnimatedSwitcher(
        duration: const Duration(milliseconds: 280),
        transitionBuilder: (c, a) => FadeTransition(opacity: a, child: c),
        child: text.isEmpty ? const SizedBox(height: 20, width: double.infinity) : child,
      );

  Widget _voiceControls(BuildContext context) {
    final t = context.t;
    final offline = _phase == 'offline';
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 4, 28, 18),
      child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        _roundButton(context, Icons.keyboard_alt_outlined, 'Type instead', () => setState(() => _textMode = true)),
        GestureDetector(
          onTap: offline ? null : _micTap,
          onLongPressStart: offline
              ? null
              : (_) {
                  _holding = true;
                  _startListening();
                },
          onLongPressEnd: offline ? null : (_) => _finishListening(send: true),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            width: 72,
            height: 72,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: _listening ? t.accent : (offline ? t.active : t.raised),
              border: Border.all(color: _listening ? t.accent : t.borderStrong, width: 1.2),
              boxShadow: _listening ? [BoxShadow(color: t.accent.withValues(alpha: .45), blurRadius: 24)] : null,
            ),
            child: Icon(_listening ? Icons.graphic_eq_rounded : Icons.mic_rounded, size: 30, color: _listening ? t.accentFg : (offline ? t.faint : t.fg)),
          ),
        ),
        _roundButton(context, Icons.notifications_none_rounded, 'Updates', () => _openUpdates(context), badge: _allEvents.isNotEmpty),
      ]),
    );
  }

  Widget _roundButton(BuildContext context, IconData icon, String tip, VoidCallback onTap, {bool badge = false}) {
    final t = context.t;
    return Tooltip(
      message: tip,
      child: Material(
        color: t.raised,
        shape: CircleBorder(side: BorderSide(color: t.border)),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox.square(
            dimension: 52,
            child: Badge(isLabelVisible: badge, smallSize: 7, backgroundColor: t.accent, child: Icon(icon, color: t.muted, size: 22)),
          ),
        ),
      ),
    );
  }

  // ── text mode ──

  Widget _chat(BuildContext context) {
    final t = context.t;
    if (_items.isEmpty) {
      return EmptyState(key: const ValueKey('chat-empty'), icon: Icons.chat_bubble_outline_rounded, title: 'Ask ${store.assistantName} anything', body: _connected ? 'Replies stream here as they are written.' : 'Connecting to the desk…');
    }
    final rows = _items.reversed.toList();
    return ListView.builder(
      key: const ValueKey('chat'),
      reverse: true,
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
      itemCount: rows.length + (_phase == 'thinking' || _phase == 'working' ? 1 : 0),
      itemBuilder: (context, i) {
        if (rows.length < i + 1) {
          return Padding(padding: const EdgeInsets.fromLTRB(4, 6, 4, 6), child: Text('${store.assistantName} is ${_phase == 'working' ? 'working' : 'thinking'}…', style: TextStyle(color: t.think, fontSize: 13)));
        }
        final it = rows[i];
        // reverse: true puts index 0 at the bottom; the thinking line sits below the newest row.
        return switch (it.kind) {
          'user' => _userBubble(context, it.text),
          'tool' => Padding(
              padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 4),
              child: Row(children: [
                Icon(Icons.settings_outlined, size: 13, color: t.faint),
                const SizedBox(width: 6),
                Expanded(child: Text(it.text, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 12.5, fontFamily: 'monospace'))),
              ]),
            ),
          _ => Padding(padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4), child: _markdown(context, it.text)),
        };
      },
    );
  }

  Widget _userBubble(BuildContext context, String text) {
    final t = context.t;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(top: 8, bottom: 4, left: 48),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(color: t.accentSoft, borderRadius: BorderRadius.circular(14)),
        child: SelectableText(text, style: TextStyle(color: t.fg, fontSize: 16, height: 1.35)),
      ),
    );
  }

  Widget _markdown(BuildContext context, String text) {
    final t = context.t;
    final base = TextStyle(color: t.fg, fontSize: 16, height: 1.45);
    return MarkdownBody(
      data: text,
      selectable: true,
      onTapLink: (_, href, _) {
        if (href != null) launchUrl(Uri.parse(href), mode: LaunchMode.externalApplication);
      },
      styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
        p: base,
        listBullet: base,
        h1: base.copyWith(fontSize: 20, fontWeight: FontWeight.w700),
        h2: base.copyWith(fontSize: 18, fontWeight: FontWeight.w700),
        h3: base.copyWith(fontSize: 17, fontWeight: FontWeight.w600),
        a: TextStyle(color: t.accent),
        code: TextStyle(color: t.fg, backgroundColor: t.code, fontFamily: 'monospace', fontSize: 14),
        codeblockDecoration: BoxDecoration(color: t.code, borderRadius: BorderRadius.circular(10), border: Border.all(color: t.border)),
        blockquoteDecoration: BoxDecoration(border: Border(left: BorderSide(color: t.borderStrong, width: 3))),
        horizontalRuleDecoration: BoxDecoration(border: Border(top: BorderSide(color: t.border))),
      ),
    );
  }

  Widget _composer(BuildContext context) {
    final t = context.t;
    final busy = _da.busy || _pending;
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 10),
      decoration: BoxDecoration(color: t.bg, border: Border(top: BorderSide(color: t.border))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        IconButton(
          tooltip: 'Voice mode',
          onPressed: () {
            _focus.unfocus();
            if (_listening) _finishListening(send: false);
            setState(() => _textMode = false);
          },
          icon: Icon(Icons.blur_on_rounded, color: t.muted),
          constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
        ),
        Expanded(
          child: TextField(
            controller: _input,
            focusNode: _focus,
            minLines: 1,
            maxLines: 5,
            textInputAction: TextInputAction.send,
            onSubmitted: (_) => _submitField(),
            style: TextStyle(color: t.fg, fontSize: 16),
            decoration: InputDecoration(
              hintText: 'Message ${store.assistantName}',
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: t.borderStrong)),
              enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: t.borderStrong)),
              focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: t.accent, width: 1.4)),
            ),
          ),
        ),
        IconButton(
          tooltip: _listening ? 'Stop dictation' : 'Dictate',
          onPressed: () => _listening ? _finishListening(send: false) : _startListening(intoField: true),
          icon: Icon(_listening ? Icons.stop_circle_outlined : Icons.mic_none_rounded, color: _listening ? t.accent : t.muted),
          constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
        ),
        ListenableBuilder(
          listenable: _input,
          builder: (context, _) {
            final hasText = _input.text.trim().isNotEmpty;
            if (busy && !hasText) {
              return IconButton.filled(
                tooltip: 'Stop',
                onPressed: _interrupt,
                style: IconButton.styleFrom(backgroundColor: t.errSoft, foregroundColor: t.err, minimumSize: const Size(44, 44)),
                icon: const Icon(Icons.stop_rounded),
              );
            }
            return IconButton.filled(
              tooltip: 'Send',
              onPressed: hasText ? _submitField : null,
              style: IconButton.styleFrom(backgroundColor: t.accent, foregroundColor: t.accentFg, disabledBackgroundColor: t.active, minimumSize: const Size(44, 44)),
              icon: const Icon(Icons.arrow_upward_rounded),
            );
          },
        ),
      ]),
    );
  }

  void _submitField() {
    final text = _input.text;
    if (text.trim().isEmpty) return;
    if (_listening) _finishListening(send: false);
    _input.clear();
    _send(text);
  }

  // ── sheets ──

  void _openReply(BuildContext context, String text) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: .6,
        maxChildSize: .95,
        builder: (context, scroll) => ListView(
          controller: scroll,
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 32),
          children: [_markdown(context, text)],
        ),
      ),
    );
  }

  void _openUpdates(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => ListenableBuilder(
        listenable: store,
        builder: (context, _) {
          final t = context.t;
          final evs = _allEvents;
          return DraggableScrollableSheet(
            expand: false,
            initialChildSize: .6,
            maxChildSize: .95,
            builder: (context, scroll) => evs.isEmpty
                ? ListView(controller: scroll, children: const [EmptyState(icon: Icons.notifications_none_rounded, title: 'Nothing yet', body: 'What your sessions do lands here.')])
                : ListView.separated(
                    controller: scroll,
                    padding: const EdgeInsets.fromLTRB(0, 0, 0, 24),
                    itemCount: evs.length + 1,
                    separatorBuilder: (_, i) => i == 0 ? const SizedBox.shrink() : Divider(height: 1, indent: 44, color: t.border),
                    itemBuilder: (context, i) {
                      if (i == 0) return const SectionHeader('Updates');
                      final e = evs[i - 1];
                      final color = switch (e.kind) {
                        'waiting' => t.err,
                        'done' => t.ok,
                        'started' => t.accent,
                        _ => t.faint,
                      };
                      final title = e.title.isNotEmpty ? e.title : (e.name.isNotEmpty ? e.name : e.folder);
                      return Padding(
                        padding: const EdgeInsets.fromLTRB(18, 12, 18, 12),
                        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Padding(padding: const EdgeInsets.only(top: 6), child: StatusDot(color, size: 8)),
                          const SizedBox(width: 18),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Row(children: [
                                Expanded(child: Text(title.isEmpty ? 'Session' : title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600))),
                                const SizedBox(width: 8),
                                Text(relTime(e.at), style: TextStyle(color: t.faint, fontSize: 12)),
                              ]),
                              const SizedBox(height: 2),
                              Text([e.kind, if (e.folder.isNotEmpty) e.folder].join(' · '), style: TextStyle(color: t.muted, fontSize: 12.5)),
                              if (e.text.isNotEmpty) ...[
                                const SizedBox(height: 4),
                                Text(e.text, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 14)),
                              ],
                            ]),
                          ),
                        ]),
                      );
                    },
                  ),
          );
        },
      ),
    );
  }
}
