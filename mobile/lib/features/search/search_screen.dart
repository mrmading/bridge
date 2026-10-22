/// Search anything: chats (titles locally, then /api/search), projects, agents, files made for
/// you, and a few actions.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../files/file_screen.dart';
import '../projects/projects_screen.dart';
import '../session/session_utils.dart';
import '../settings/settings_screen.dart';
import '../talk/talk_screen.dart';

class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});
  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _store = AppStore.instance;
  String _q = '';
  List<SessionMeta> _remote = const [];
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  void _onQuery(String v) {
    setState(() => _q = v.trim());
    _debounce?.cancel();
    if (_q.length < 2) {
      setState(() => _remote = const []);
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      final q = _q;
      try {
        final r = await _store.api.search(q);
        if (mounted && q == _q) setState(() => _remote = r);
      } catch (_) {}
    });
  }

  bool _has(String s) => s.toLowerCase().contains(_q.toLowerCase());

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final seen = <String>{};
    final chats = <SessionMeta>[
      for (final s in [..._store.recent.where((s) => _q.isEmpty || _has('${s.title} ${s.projectName}')), ..._remote])
        if (seen.add(s.id)) s,
    ];
    final projects = _store.projects.where((p) => p.exists && _q.isNotEmpty && _has('${p.name} ${p.path}')).toList();
    final agents = _store.agents.where((a) => _q.isNotEmpty && _has('${a.name} ${a.description}')).toList();
    final files = _store.home.made.where((m) => _q.isNotEmpty && _has('${m.name} ${m.sessionTitle}')).toList();
    final actions = <(String, IconData, VoidCallback)>[
      ('New chat', Icons.add_rounded, () => Nav.instance.newChat()),
      ('Talk to ${_store.assistantName}', Icons.graphic_eq_rounded, () {
        Navigator.of(context).pop();
        openTalk(context);
      }),
      ('Settings', Icons.settings_outlined, () => Nav.instance.push(const SettingsScreen())),
    ].where((a) => _q.isEmpty || _has(a.$1)).toList();

    Widget header(String s) => Padding(padding: const EdgeInsets.fromLTRB(20, 16, 20, 6), child: Text(s.toUpperCase(), style: TextStyle(color: t.faint, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: .8)));
    Widget row(IconData icon, String title, String sub, VoidCallback onTap, {Widget? lead}) => InkWell(
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 52),
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
            child: Row(children: [
              lead ?? Icon(icon, size: 19, color: t.muted),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w500)),
                  if (sub.isNotEmpty) Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 12.5)),
                ]),
              ),
            ]),
          ),
        );

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: TextField(
          autofocus: true,
          onChanged: _onQuery,
          textInputAction: TextInputAction.search,
          style: TextStyle(color: t.fg, fontSize: 17),
          decoration: const InputDecoration(hintText: 'Search chats, projects, files, agents…', filled: false, border: InputBorder.none, enabledBorder: InputBorder.none, focusedBorder: InputBorder.none),
        ),
      ),
      body: ListView(keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag, padding: const EdgeInsets.only(bottom: 32), children: [
        if (chats.isNotEmpty) header(_q.isEmpty ? 'Recent chats' : 'Chats'),
        for (final s in chats.take(_q.isEmpty ? 8 : 30))
          row(Icons.chat_bubble_outline_rounded, s.title, [s.projectName.isNotEmpty ? s.projectName : s.folder, relTimeShort(s.mtime)].where((x) => x.isNotEmpty).join(' · '),
              () => openSession(key: s.key, id: s.id, cwd: s.cwd.isNotEmpty ? s.cwd : s.projectPath, title: s.title, computer: s.computer)),
        if (projects.isNotEmpty) header('Projects'),
        for (final p in projects.take(10)) row(Icons.folder_outlined, p.name, prettyPath(p.path), () => Nav.instance.push(ProjectScreen(project: p)), lead: ProjectIcon(p.name, size: 26)),
        if (agents.isNotEmpty) header('Agents'),
        for (final a in agents.take(10)) row(Icons.smart_toy_outlined, a.name, a.description, () {
          final turn = _store.turn;
          _store.setTurn(TurnOptions(model: turn.model, permissionMode: turn.permissionMode, effort: turn.effort, agent: a.name));
          Nav.instance.newChat();
        }, lead: Ava(name: a.name, size: 26, color: parseHex(a.color))),
        if (files.isNotEmpty) header('Files'),
        for (final f in files.take(10)) row(Icons.description_outlined, f.name, f.sessionTitle, () => Nav.instance.push(FileScreen(path: f.path, computer: f.computer)), lead: FileBadge(f.ext, size: 26)),
        if (actions.isNotEmpty) header('Actions'),
        for (final a in actions) row(a.$2, a.$1, '', a.$3),
      ]),
    );
  }
}

String relTimeShort(int ms) {
  if (ms <= 0) return '';
  final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
  if (d.inMinutes < 60) return '${d.inMinutes.clamp(1, 59)}m';
  if (d.inHours < 24) return '${d.inHours}h';
  return '${d.inDays}d';
}
