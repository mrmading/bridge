/// The one composer used on Home, New chat and in every chat: a text box with everything else
/// tucked into chips that open bottom sheets (project, teammate, freedom, model + effort), a
/// dictation mic (on-device speech to text) and send / stop.
library;

import 'package:flutter/material.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../core/models.dart';
import '../core/store.dart';
import '../core/theme.dart';
import '../features/session/session_utils.dart';
import 'bridge.dart';
import 'common.dart';

/// Friendly names for permission modes. The server value is the key.
const modeOrder = ['plan', 'manual', 'acceptEdits', 'bypassPermissions'];

({String label, String help}) modeInfo(String m) => switch (m) {
      'plan' => (label: 'Plan first', help: 'Reads and proposes. Changes nothing until you say go'),
      'manual' => (label: 'Ask before changes', help: 'Checks with you before every edit or command'),
      'acceptEdits' => (label: 'Edit freely', help: 'Edits files on its own, asks before running commands'),
      'bypassPermissions' => (label: 'Autopilot', help: 'Never stops to ask. Use for trusted, contained work'),
      'auto' => (label: 'Auto', help: 'Claude decides when to ask'),
      'dontAsk' => (label: "Don't ask", help: 'Skips anything that would need permission'),
      _ => (label: m, help: ''),
    };

Color modeColor(BuildContext context, String m) {
  final t = context.t;
  return switch (m) {
    'plan' => t.think,
    'manual' => t.ok,
    'bypassPermissions' => t.err,
    _ => t.accent,
  };
}

String cap(String s) => s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';
String modelLabel(String m) => m.isEmpty ? 'Default model' : cap(m);
String effortLabel(String e) => e.isEmpty ? 'Default' : cap(e);
String agentLabel(String a) => a.isEmpty ? AppStore.instance.assistantName : (a == 'auto' ? 'Auto-pick' : a);

/// The project a cwd belongs to, for the chip label. '' is "Any project".
String projectLabel(String cwd) {
  if (cwd.isEmpty || cwd == defaultCwd()) return 'Any project';
  for (final p in AppStore.instance.projects) {
    if (p.path == cwd && p.name.isNotEmpty) return p.name;
  }
  return baseName(cwd);
}

class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.controller,
    required this.onSend,
    this.focusNode,
    this.hint = 'Ask anything…',
    this.running = false,
    this.onStop,
    this.showProject = false,
    this.cwd = '',
    this.onCwd,
  });

  final TextEditingController controller;
  final FocusNode? focusNode;
  final String hint;
  final ValueChanged<String> onSend;
  /// A turn is running: send queues, and a stop button appears.
  final bool running;
  final VoidCallback? onStop;
  /// Show the project picker (Home and New chat). Chats are already in a project.
  final bool showProject;
  final String cwd;
  final ValueChanged<String>? onCwd;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _store = AppStore.instance;
  final SpeechToText _stt = SpeechToText();
  bool _sttReady = false;
  bool _listening = false;
  String _sttBase = '';

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onText);
  }

  @override
  void didUpdateWidget(Composer old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(_onText);
      widget.controller.addListener(_onText);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onText);
    if (_listening) _stt.stop();
    super.dispose();
  }

  void _onText() {
    if (mounted) setState(() {});
  }

  void _submit() {
    final text = widget.controller.text.trim();
    if (text.isEmpty) return;
    if (_listening) _stopListening();
    widget.controller.clear();
    widget.onSend(text);
  }

  // ── dictation ──

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
            if (e.permanent && e.errorMsg != 'error_no_match' && e.errorMsg != 'error_speech_timeout') toast(context, 'Voice input stopped: ${e.errorMsg}');
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
    _sttBase = widget.controller.text.trimRight();
    setState(() => _listening = true);
    try {
      await _stt.listen(onResult: _onSpeech, listenOptions: SpeechListenOptions(partialResults: true, listenMode: ListenMode.dictation, cancelOnError: true));
    } catch (_) {
      if (!mounted) return;
      setState(() => _listening = false);
      toast(context, 'Could not start voice input');
    }
  }

  void _onSpeech(SpeechRecognitionResult r) {
    final words = r.recognizedWords;
    final text = _sttBase.isEmpty ? words : '$_sttBase $words';
    widget.controller.value = TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
    if (r.finalResult && mounted) setState(() => _listening = false);
  }

  void _stopListening() {
    _stt.stop();
    setState(() => _listening = false);
  }

  // ── ui ──

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final hasText = widget.controller.text.trim().isNotEmpty;
    return ListenableBuilder(
      listenable: _store,
      builder: (context, _) {
        final turn = _store.turn;
        final mode = modeInfo(turn.permissionMode);
        return Container(
          decoration: BoxDecoration(
            color: t.raised,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: t.borderStrong),
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: Theme.of(context).brightness == Brightness.dark ? .35 : .06), blurRadius: 24, offset: const Offset(0, 8))],
          ),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: widget.controller,
              focusNode: widget.focusNode,
              minLines: 1,
              maxLines: 6,
              keyboardType: TextInputType.multiline,
              textCapitalization: TextCapitalization.sentences,
              style: TextStyle(color: t.fg, fontSize: 16, height: 1.35),
              decoration: InputDecoration(
                hintText: _listening ? 'Listening…' : (widget.running ? 'Add to the running work…' : widget.hint),
                filled: false,
                isDense: true,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(6, 2, 6, 6),
              child: Row(children: [
                // Left: project · teammate · freedom, sharing what the fixed right side leaves.
                Expanded(
                  child: Row(children: [
                    if (widget.showProject)
                      // The only chip that gives way when the bar is tight: its name ellipsizes.
                      Flexible(
                        flex: 6,
                        child: _Chip(
                          key: const ValueKey('chip-project'),
                          onTap: _pickProject,
                          tip: 'Project',
                          child: Row(mainAxisSize: MainAxisSize.min, children: [
                            Icon(Icons.folder_outlined, size: 16, color: t.muted),
                            // "Any project" is the default: the icon says enough (as in the prototype's phone
                            // layout) and leaves room for the freedom label. A picked project shows its name.
                            if (projectLabel(widget.cwd) != 'Any project') ...[
                            const SizedBox(width: 5),
                            Flexible(
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(maxWidth: 110),
                                child: Text(projectLabel(widget.cwd), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 13, fontWeight: FontWeight.w500)),
                              ),
                            ),
                            ],
                          ]),
                        ),
                      ),
                    _Chip(
                      key: const ValueKey('chip-agent'),
                      onTap: () => showAgentSheet(context),
                      tip: 'Teammate: ${agentLabel(turn.agent)}',
                      child: Ava(name: agentLabel(turn.agent), size: 20, gradient: turn.agent.isEmpty),
                    ),
                    // Flex shares: the freedom label wins over the project name and the spacer.
                    Flexible(
                      flex: 20,
                      child: _Chip(
                      key: const ValueKey('chip-mode'),
                      onTap: () => showModeSheet(context),
                      tip: mode.help,
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        Container(width: 8, height: 8, decoration: BoxDecoration(color: modeColor(context, turn.permissionMode), shape: BoxShape.circle)),
                        const SizedBox(width: 6),
                        // Next to the project chip the bar is tight: the longest label gets its short form.
                        Flexible(child: Text(widget.showProject && turn.permissionMode == 'manual' ? 'Ask first' : mode.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 13, fontWeight: FontWeight.w500))),
                      ]),
                    )
                    ),
                  ]),
                ),
                _Chip(
                  key: const ValueKey('chip-model'),
                  onTap: () => showModelSheet(context),
                  tip: 'Model and effort',
                  child: Text(turn.isQwen ? 'Qwen' : (turn.model.isEmpty ? (turn.effort.isEmpty ? 'Model' : effortLabel(turn.effort)) : '${cap(turn.model)}${turn.effort.isEmpty ? '' : ' · ${effortLabel(turn.effort)}'}'),
                      style: TextStyle(color: t.muted, fontSize: 13, fontWeight: FontWeight.w500)),
                ),
                const SizedBox(width: 2),
                _RoundBtn(
                  icon: _listening ? Icons.stop_rounded : Icons.mic_none_rounded,
                  tip: _listening ? 'Stop dictation' : 'Dictate',
                  fg: _listening ? t.err : t.muted,
                  bg: _listening ? t.errSoft : null,
                  border: !_listening,
                  onTap: _toggleMic,
                ),
                const SizedBox(width: 6),
                if (widget.running && !hasText)
                  _RoundBtn(icon: Icons.stop_rounded, tip: 'Stop', fg: t.err, bg: t.errSoft, onTap: widget.onStop ?? () {})
                else
                  _RoundBtn(icon: Icons.arrow_upward_rounded, tip: widget.running ? 'Add to the running work' : 'Send', fg: hasText ? t.accentFg : t.faint, bg: hasText ? t.accent : t.active, glow: hasText, onTap: hasText ? _submit : () {}),
              ]),
            ),
          ]),
        );
      },
    );
  }

  Future<void> _pickProject() async {
    final picked = await showProjectSheet(context, widget.cwd);
    if (picked != null) widget.onCwd?.call(picked);
  }
}

class _Chip extends StatelessWidget {
  const _Chip({super.key, required this.child, required this.onTap, required this.tip});
  final Widget child;
  final VoidCallback onTap;
  final String tip;
  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tip,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          constraints: const BoxConstraints(minHeight: 40, minWidth: 36),
          padding: const EdgeInsets.symmetric(horizontal: 7),
          // Shrink-wrap: `alignment` would make a Flexible chip grab its whole share of the bar.
          child: Center(widthFactor: 1, child: child),
        ),
      ),
    );
  }
}

class _RoundBtn extends StatelessWidget {
  const _RoundBtn({required this.icon, required this.tip, required this.onTap, required this.fg, this.bg, this.border = false, this.glow = false});
  final IconData icon;
  final String tip;
  final VoidCallback onTap;
  final Color fg;
  final Color? bg;
  final bool border, glow;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Tooltip(
      message: tip,
      child: Material(
        color: bg ?? Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11), side: border ? BorderSide(color: t.border) : BorderSide.none),
        child: InkWell(
          borderRadius: BorderRadius.circular(11),
          onTap: onTap,
          child: Container(
            width: 38,
            height: 38,
            decoration: glow ? BoxDecoration(borderRadius: BorderRadius.circular(11), boxShadow: [BoxShadow(color: t.accent.withValues(alpha: .35), blurRadius: 14, offset: const Offset(0, 4))]) : null,
            child: Icon(icon, size: 20, color: fg),
          ),
        ),
      ),
    );
  }
}

// ── sheets ────────────────────────────────────────────────────────────────

Future<T?> _sheet<T>(BuildContext context, Widget Function(BuildContext) builder) => showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (ctx) => ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * .85),
        child: ListenableBuilder(listenable: AppStore.instance, builder: (c, _) => builder(c)),
      ),
    );

void _setTurn({String? model, String? mode, String? effort, String? agent, String? provider}) {
  final s = AppStore.instance;
  s.setTurn(s.turn.copy(model: model, permissionMode: mode, effort: effort, agent: agent, provider: provider));
}

Future<void> showModeSheet(BuildContext context) => _sheet(context, (c) {
      final store = AppStore.instance;
      final allowed = store.boot?.permissionModes ?? modeOrder;
      final modes = [for (final m in modeOrder) if (allowed.contains(m)) m];
      return ListView(shrinkWrap: true, padding: const EdgeInsets.only(bottom: 16), children: [
        const SheetTitle('How much freedom?', sub: 'Applies to the next message you send.'),
        for (final m in modes)
          PickRow(
            title: modeInfo(m).label,
            sub: modeInfo(m).help,
            leading: Container(width: 10, height: 10, decoration: BoxDecoration(color: modeColor(c, m), shape: BoxShape.circle)),
            selected: store.turn.permissionMode == m,
            onTap: () {
              _setTurn(mode: m);
              Navigator.pop(c);
            },
          ),
      ]);
    });

Future<void> showModelSheet(BuildContext context) => _sheet(context, (c) {
      final store = AppStore.instance;
      final t = c.t;
      final models = ['', ...?store.boot?.models.where((m) => m.isNotEmpty)];
      final efforts = store.boot?.efforts ?? const ['', 'low', 'medium', 'high'];
      String help(String m) => switch (m) {
            'opus' => 'Best for hard, long work',
            'sonnet' => 'Fast and capable, cheaper',
            'haiku' => 'Quick answers',
            '' => 'Whatever Claude Code is set to',
            _ => '',
          };
      final providers = store.boot?.providers ?? const <Provider>[];
      final qwen = providers.where((p) => p.id == 'qwen').firstOrNull;
      final onQwen = store.turn.isQwen && qwen != null;
      return ListView(shrinkWrap: true, padding: const EdgeInsets.only(bottom: 20), children: [
        const SheetTitle('Model'),
        if (qwen != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: SegmentedButton<String>(
              key: const ValueKey('provider-switch'),
              segments: [
                const ButtonSegment(value: '', label: Text('Claude')),
                ButtonSegment(value: 'qwen', enabled: qwen.available, label: Text(qwen.available ? 'Qwen' : 'Qwen · offline')),
              ],
              selected: {onQwen ? 'qwen' : ''},
              showSelectedIcon: false,
              onSelectionChanged: (s) => _setTurn(provider: s.first),
            ),
          ),
        if (onQwen)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
            child: Text('${qwen.name}: an open model on your own GPU. Claude models and effort apply when you switch back.', style: TextStyle(color: t.muted, fontSize: 13.5, height: 1.4)),
          )
        else ...[
        for (final m in models) PickRow(title: modelLabel(m), sub: help(m), selected: store.turn.model == m, onTap: () => _setTurn(model: m)),
        Padding(padding: const EdgeInsets.fromLTRB(20, 16, 20, 8), child: Text('THINKING EFFORT', style: TextStyle(color: t.faint, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.1))),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: SegmentedButton<String>(
            segments: [for (final e in efforts) ButtonSegment(value: e, label: Text(effortLabel(e), maxLines: 1, overflow: TextOverflow.ellipsis))],
            selected: {efforts.contains(store.turn.effort) ? store.turn.effort : efforts.first},
            showSelectedIcon: false,
            onSelectionChanged: (s) => _setTurn(effort: s.first),
          ),
        ),
        ],
      ]);
    });

Future<void> showAgentSheet(BuildContext context) => _sheet(context, (c) {
      final store = AppStore.instance;
      final current = store.turn.agent;
      return ListView(shrinkWrap: true, padding: const EdgeInsets.only(bottom: 16), children: [
        const SheetTitle('Who should do this?'),
        PickRow(title: store.assistantName, sub: 'Your assistant, no specialist', leading: Ava(name: store.assistantName, size: 30, gradient: true), selected: current.isEmpty, onTap: () {
          _setTurn(agent: '');
          Navigator.pop(c);
        }),
        PickRow(title: 'Auto-pick', sub: 'Bridge picks the best teammate for each message', leading: Ava(name: 'Auto', size: 30, letter: '✦'), selected: current == 'auto', onTap: () {
          _setTurn(agent: 'auto');
          Navigator.pop(c);
        }),
        for (final a in store.agents)
          PickRow(
            title: a.name,
            sub: a.description,
            leading: Ava(name: a.name, size: 30, color: parseHex(a.color)),
            selected: current == a.name,
            onTap: () {
              _setTurn(agent: a.name);
              Navigator.pop(c);
            },
          ),
      ]);
    });

/// Returns the picked folder ('' = Any project), or null when dismissed.
Future<String?> showProjectSheet(BuildContext context, String current) => _sheet<String>(context, (c) {
      final store = AppStore.instance;
      final t = c.t;
      final seen = <String>{};
      final rows = <({String path, String name})>[];
      final projects = [...store.projects]..sort((a, b) => b.lastActivity.compareTo(a.lastActivity));
      for (final p in projects) {
        if (p.path.isNotEmpty && p.exists && isProjectPath(p.path) && seen.add(p.path)) rows.add((path: p.path, name: p.name.isNotEmpty ? p.name : baseName(p.path)));
      }
      for (final r in store.roots) {
        if (r.isNotEmpty && seen.add(r)) rows.add((path: r, name: baseName(r)));
      }
      return ListView(shrinkWrap: true, padding: const EdgeInsets.only(bottom: 16), children: [
        const SheetTitle('Work in'),
        PickRow(
          title: 'Any project',
          sub: 'Starts in your home folder',
          leading: Icon(Icons.all_inclusive_rounded, color: t.muted),
          selected: current.isEmpty || current == defaultCwd(),
          onTap: () => Navigator.pop(c, ''),
        ),
        for (final r in rows.take(30))
          PickRow(title: r.name, sub: prettyPath(r.path), leading: ProjectIcon(r.name, size: 26), selected: current == r.path, onTap: () => Navigator.pop(c, r.path)),
        if (store.hasCloud) ...[
          Padding(padding: const EdgeInsets.fromLTRB(20, 16, 20, 2), child: Text('RUNS ON', style: TextStyle(color: t.faint, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.1))),
          for (final c in store.computers) ComputerRow(c),
        ],
      ]);
    });

IconData computerIcon(String id) => id == 'cloud' ? Icons.cloud_outlined : Icons.laptop_mac_rounded;

/// One computer in a picker: name, status, the reason when offline (greyed, not selectable).
class ComputerRow extends StatelessWidget {
  const ComputerRow(this.c, {super.key, this.onPicked});
  final Computer c;
  final VoidCallback? onPicked;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final store = AppStore.instance;
    final sub = c.online
        ? (c.isCloud ? 'Keeps working when your Mac sleeps or the app is closed' : 'Fast, uses your local tools and simulators')
        : 'Offline${c.reason.isNotEmpty ? ' · ${c.reason}' : ''}';
    return Opacity(
      opacity: c.online ? 1 : .5,
      child: PickRow(
        title: store.computerLabel(c.id),
        sub: sub,
        leading: Icon(computerIcon(c.id), color: c.online ? t.accent : t.faint),
        selected: store.computer == c.id,
        onTap: () {
          if (!c.online) {
            toast(context, '${store.computerLabel(c.id)} is offline${c.reason.isNotEmpty ? ': ${c.reason}' : ''}');
            return;
          }
          store.setComputer(c.id);
          onPicked?.call();
        },
      ),
    );
  }
}

/// Mac or cloud computer for new chats. Offline ones are listed, greyed, with the reason.
Future<void> showComputerSheet(BuildContext context) => _sheet(context, (c) {
      final store = AppStore.instance;
      return ListView(shrinkWrap: true, padding: const EdgeInsets.only(bottom: 16), children: [
        const SheetTitle('Run new chats on', sub: 'Every chat stays on the computer it started on.'),
        for (final x in store.computers) ComputerRow(x, onPicked: () => Navigator.pop(c)),
      ]);
    });

/// Under the Home / New chat composer. With a cloud computer configured (the Mac as hub) it is the
/// Mac / Cloud picker; otherwise (the sprite is the backend) a plain "Runs on" and the host.
class RunsOn extends StatelessWidget {
  const RunsOn({super.key});
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final store = AppStore.instance;
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final id = store.computer;
        final offline = store.computerById(id)?.online == false;
        final color = offline ? t.warn : t.faint;
        return Center(
        child: InkWell(
          key: const ValueKey('runs-on'),
          borderRadius: BorderRadius.circular(16),
          onTap: store.hasCloud ? () => showComputerSheet(context) : null,
          child: Container(
            constraints: const BoxConstraints(minHeight: 40),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(store.hasCloud ? computerIcon(id) : (store.isLocalHost ? Icons.laptop_mac_rounded : Icons.cloud_outlined), size: 15, color: color),
              const SizedBox(width: 6),
              Flexible(child: Text(store.hasCloud ? 'Runs on ${store.computerLabel(id)}${offline ? ' · offline' : ''}' : 'Runs on ${store.serverHost}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: color, fontSize: 12.5, fontWeight: FontWeight.w500))),
              if (store.hasCloud) ...[const SizedBox(width: 2), Icon(Icons.expand_more_rounded, size: 16, color: color)],
            ]),
          ),
        ),
      );
      },
    );
  }
}
