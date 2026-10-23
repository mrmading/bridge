/// New chat: one question, the composer with its project picker, and recent projects as chips.
library;

import 'package:flutter/material.dart';

import '../../core/nav.dart';
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

  @override
  void initState() {
    super.initState();
    Nav.instance.focusComposer.addListener(_onFocusAsk);
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

  @override
  void dispose() {
    Nav.instance.focusComposer.removeListener(_onFocusAsk);
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
        appBar: const RootAppBar(title: 'New chat'),
        body: ListView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          padding: EdgeInsets.fromLTRB(16, MediaQuery.sizeOf(context).height * .08, 16, 32),
          children: [
            Text('What should we work on?', textAlign: TextAlign.center, style: TextStyle(color: t.fg, fontSize: 26, fontWeight: FontWeight.w600, letterSpacing: -.4)),
            const SizedBox(height: 10),
            Text('Pick a project and a teammate, or just start typing.', textAlign: TextAlign.center, style: TextStyle(color: t.muted, fontSize: 15)),
            const SizedBox(height: 22),
            Composer(controller: _input, focusNode: _focus, hint: 'Describe the task…', showProject: true, cwd: _cwd, onCwd: (c) => setState(() => _cwd = c), onSend: _send),
            const RunsOn(),
            const SizedBox(height: 16),
            Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
              for (final p in projects.take(6))
                ChoiceChip(
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
