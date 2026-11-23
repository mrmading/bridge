/// New chat: one question, the composer with its project picker, and recent projects as chips.
library;

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/project_guess.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/composer.dart';
import '../session/session_utils.dart';
import '../shell/drawer.dart';

class NewChatScreen extends StatefulWidget {
  const NewChatScreen({super.key});
  @override
  State<NewChatScreen> createState() => _NewChatScreenState();
}

class _NewChatScreenState extends State<NewChatScreen> {
  final _store = AppStore.instance;
  late final _input = TextEditingController(text: Nav.instance.newChatText);
  final _focus = FocusNode();
  late String _cwd = Nav.instance.newChatCwd;

  /// Suggestions the user waved away for this chat.
  final _dismissed = <String>{};

  @override
  void initState() {
    super.initState();
    Nav.instance.focusComposer.addListener(_onFocusAsk);
    _input.addListener(_onText);
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  void _onFocusAsk() {
    setState(() => _cwd = Nav.instance.newChatCwd);
    if (Nav.instance.newChatText.isNotEmpty) {
      _input.text = Nav.instance.newChatText;
      _input.selection = TextSelection.collapsed(offset: _input.text.length);
    }
    _focus.requestFocus();
  }

  // re-guess as they type; matching is a few string checks per project
  String _lastGuess = '';
  void _onText() {
    final g = _guess()?.path ?? '';
    if (g != _lastGuess) setState(() => _lastGuess = g);
  }

  /// Only while no project is chosen (or the home folder is).
  Project? _guess() {
    if (_cwd.isNotEmpty && _cwd != defaultCwd()) return null;
    final g = guessProject(_input.text, [
      ..._store.projects.where((p) => p.exists && isProjectPath(p.path)),
    ]);
    return g == null || _dismissed.contains(g.path) ? null : g;
  }

  @override
  void dispose() {
    Nav.instance.focusComposer.removeListener(_onFocusAsk);
    _input.removeListener(_onText);
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _send(String text) => Nav.instance.startChat(cwd: _cwd.isEmpty ? defaultCwd() : _cwd, message: text, computer: _store.computer);

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final projects = [..._store.projects.where((p) => p.exists && isProjectPath(p.path))]..sort((a, b) => b.lastActivity.compareTo(a.lastActivity));
    return Stack(children: [
      Positioned.fill(child: ColoredBox(color: t.bg)),
      const Bloom(),
      Scaffold(
        backgroundColor: Colors.transparent,
        appBar: const RootAppBar(title: 'Paquito'),
        body: ListView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          padding: EdgeInsets.fromLTRB(16, MediaQuery.sizeOf(context).height * .08, 16, 32),
          children: [
            Text('What should we work on?', textAlign: TextAlign.center, style: TextStyle(color: t.fg, fontSize: 26, fontWeight: FontWeight.w600, letterSpacing: -.4)),
            const SizedBox(height: 10),
            Text('Pick a project and a teammate, or just start typing.', textAlign: TextAlign.center, style: TextStyle(color: t.muted, fontSize: 15)),
            const SizedBox(height: 22),
            Composer(controller: _input, focusNode: _focus, hint: 'Describe the task…', showProject: true, cwd: _cwd, onCwd: (c) => setState(() => _cwd = c), onSend: _send),
              if (_guess() case final g?)
                _Suggestion(
                  name: g.name.isNotEmpty ? g.name : baseName(g.path),
                  onUse: () => setState(() => _cwd = g.path),
                  onDismiss: () => setState(() => _dismissed.add(g.path)),
                ),
            const RunsOn(),
            const SizedBox(height: 16),
            Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
              for (final p in projects.take(6))
                ChoiceChip(mouseCursor: hand, 
                  avatar: ProjectIcon(p.name.isNotEmpty ? p.name : baseName(p.path), size: 18),
                  label: Text(p.name.isNotEmpty ? p.name : baseName(p.path)),
                  selected: _cwd == p.path,
                  showCheckmark: false,
                  labelStyle: TextStyle(color: _cwd == p.path ? t.accent : t.muted, fontSize: 13),
                  selectedColor: t.accentSoft,
                  backgroundColor: t.raised.withValues(alpha: .6),
                  side: BorderSide(color: _cwd == p.path ? t.accent.withValues(alpha: .4) : t.border),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
                  onSelected: (_) => setState(() => _cwd = _cwd == p.path ? '' : p.path),
                ),
            ]),
          ],
        ),
      ),
    ]);
  }
}

/// "Looks like Setpoint · Use it" under the composer: a guess from the message, never applied on its own.
class _Suggestion extends StatelessWidget {
  const _Suggestion({
    required this.name,
    required this.onUse,
    required this.onDismiss,
  });
  final String name;
  final VoidCallback onUse, onDismiss;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Center(
        child: InputChip(mouseCursor: hand, 
          avatar: ProjectIcon(name, size: 18),
          label: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: 'Looks like ',
                  style: TextStyle(color: t.muted),
                ),
                TextSpan(
                  text: name,
                  style: TextStyle(color: t.fg, fontWeight: FontWeight.w600),
                ),
                TextSpan(
                  text: ' · Use it',
                  style: TextStyle(
                    color: t.accent,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            style: const TextStyle(fontSize: 13),
          ),
          onPressed: onUse,
          onDeleted: onDismiss,
          deleteButtonTooltipMessage: 'Not this project',
          backgroundColor: t.raised.withValues(alpha: .6),
          side: BorderSide(color: t.accent.withValues(alpha: .35)),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(18),
          ),
        ),
      ),
    );
  }
}
