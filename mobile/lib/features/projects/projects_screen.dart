/// Projects: every folder your chats work in (/api/projects merged with the Bridge roots), and a
/// project page with its instructions (CLAUDE.md), automations (hooks), chats and files.
library;

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';
import '../files/file_screen.dart';
import '../home/home_screen.dart';
import '../session/session_utils.dart';
import '../shell/drawer.dart';

class ProjectsScreen extends StatefulWidget {
  const ProjectsScreen({super.key});
  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  final _store = AppStore.instance;
  String _q = '';

  List<Project> _merged() {
    final out = [..._store.projects.where((p) => p.exists && isProjectPath(p.path))]..sort((a, b) => b.lastActivity.compareTo(a.lastActivity));
    final paths = out.map((p) => p.path).toSet();
    for (final r in _store.roots) {
      if (r.isEmpty || paths.contains(r) || !isProjectPath(r)) continue;
      out.add(Project(key: projectKeyFor(r), path: r, name: baseName(r), sessions: 0, lastActivity: 0, exists: true));
    }
    final q = _q.toLowerCase();
    return q.isEmpty ? out : out.where((p) => '${p.name} ${p.path}'.toLowerCase().contains(q)).toList();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ListenableBuilder(
      listenable: _store,
      builder: (context, _) {
        final items = _merged();
        return Scaffold(
          appBar: const RootAppBar(title: 'Projects'),
          body: RefreshIndicator(
            color: t.accent,
            onRefresh: _store.refreshAll,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              padding: const EdgeInsets.only(bottom: 32),
              children: [
                Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 12), child: Text('A project is a folder your team works in. Its instructions, chats and files live together.', style: TextStyle(color: t.muted, fontSize: 14))),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                  child: TextField(onChanged: (v) => setState(() => _q = v.trim()), decoration: const InputDecoration(hintText: 'Find a project…', prefixIcon: Icon(Icons.search_rounded))),
                ),
                if (items.isEmpty) const EmptyState(icon: Icons.folder_off_outlined, title: 'No projects yet', body: 'Start a chat in a folder and it shows up here.'),
                for (final p in items) _ProjectRow(p),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow(this.p);
  final Project p;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final store = AppStore.instance;
    final live = store.home.running.where((r) => r.key == p.key).length;
    final waiting = store.home.needs.where((n) => n.key == p.key).length;
    final name = p.name.isNotEmpty ? p.name : baseName(p.path);
    return Card2(
      onTap: () => Nav.instance.push(ProjectScreen(project: p)),
      child: Row(children: [
        ProjectIcon(name),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 2),
            Text([p.sessions == 0 ? 'No chats yet' : '${p.sessions} ${p.sessions == 1 ? 'chat' : 'chats'}', if (p.lastActivity > 0) relTime(p.lastActivity)].join(' · '), style: TextStyle(color: t.muted, fontSize: 13)),
          ]),
        ),
        if (waiting > 0) ...[Tag('$waiting needs you', kind: 'warn'), const SizedBox(width: 6)],
        if (live > 0) PulseDot(color: t.accent),
        Icon(Icons.chevron_right_rounded, color: t.faint),
      ]),
    );
  }
}

/// One project: instructions, automations, chats, files, and "New chat here".
class ProjectScreen extends StatefulWidget {
  const ProjectScreen({super.key, required this.project});
  final Project project;
  @override
  State<ProjectScreen> createState() => _ProjectScreenState();
}

class _ProjectScreenState extends State<ProjectScreen> {
  final _store = AppStore.instance;
  List<SessionMeta> _sessions = const [];
  bool _loading = true;
  String _error = '';
  String? _instructions; // null = loading, '' = none
  List<HookInfo> _hooks = const [];

  Project get p => widget.project;
  String get _name => p.name.isNotEmpty ? p.name : baseName(p.path);
  String get _claudeMd => '${p.path}/CLAUDE.md';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = _store.api;
    await Future.wait([
      api.sessions(p.key).then((s) => _sessions = s).catchError((Object e) {
        _error = e.toString();
        return _sessions;
      }),
      api.file(_claudeMd).then((f) => _instructions = (f['text'] ?? '').toString()).catchError((_) => _instructions = ''),
      api.hooks().then((h) => _hooks = h).catchError((_) => _hooks),
    ]);
    if (mounted) setState(() => _loading = false);
  }

  void _showHooks() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (c) {
        final t = c.t;
        return ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(c).height * .8),
          child: ListView(shrinkWrap: true, padding: const EdgeInsets.only(bottom: 20), children: [
            const SheetTitle('Automations', sub: 'Hooks that run on events, for every chat on this computer.'),
            if (_hooks.isEmpty) const EmptyState(icon: Icons.bolt_outlined, title: 'No hooks'),
            for (final h in _hooks)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [Tag(h.event, kind: 'think'), const SizedBox(width: 6), if (h.matcher != '*') Tag(h.matcher)]),
                  const SizedBox(height: 4),
                  Text(h.command, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 12.5, fontFamily: 'Menlo', fontFamilyFallback: const ['monospace'])),
                ]),
              ),
          ]),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final made = _store.home.made.where((m) => m.key == p.key || m.path.startsWith('${p.path}/')).toList();
    return Scaffold(
      appBar: AppBar(titleSpacing: 0, title: Text(_name)),
      body: RefreshIndicator(
        color: t.accent,
        onRefresh: _load,
        child: ListView(physics: const AlwaysScrollableScrollPhysics(), padding: const EdgeInsets.only(bottom: 32), children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Row(children: [
              ProjectIcon(_name, size: 48),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(_name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 22, fontWeight: FontWeight.w600)),
                  Text(prettyPath(p.path), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 12.5, fontFamily: 'Menlo', fontFamilyFallback: const ['monospace'])),
                ]),
              ),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: SizedBox(
              height: 46,
              child: FilledButton.icon(
                onPressed: () => Nav.instance.newChat(cwd: p.path),
                icon: const Icon(Icons.add_rounded),
                label: const Text('New chat here'),
                style: FilledButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)), textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
              ),
            ),
          ),
          _infoCard(
            context,
            icon: Icons.menu_book_outlined,
            title: 'Instructions',
            tag: 'CLAUDE.md',
            body: _instructions == null ? 'Loading…' : (_instructions!.isEmpty ? 'No instructions yet. Every chat here would follow what you write in CLAUDE.md.' : _firstLines(_instructions!)),
            onTap: _instructions?.isNotEmpty == true ? () => Nav.instance.push(FileScreen(path: _claudeMd)) : null,
          ),
          _infoCard(
            context,
            icon: Icons.bolt_outlined,
            title: 'Automations',
            tag: '${_hooks.length} ${_hooks.length == 1 ? 'hook' : 'hooks'}',
            body: _hooks.isEmpty ? 'Nothing runs automatically.' : 'Runs on ${{for (final h in _hooks) h.event}.take(4).join(', ')}.',
            onTap: _showHooks,
          ),
          SecHeader(icon: Icons.chat_bubble_outline_rounded, title: 'Chats', count: _sessions.length),
          if (_loading) Center(child: Padding(padding: const EdgeInsets.all(20), child: CircularProgressIndicator(color: t.accent, strokeWidth: 2))),
          if (!_loading && _sessions.isEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text(_error.isNotEmpty ? _error : 'No chats here yet.', style: TextStyle(color: t.muted, fontSize: 14))),
          if (_sessions.isNotEmpty)
            Container(
              margin: const EdgeInsets.symmetric(horizontal: 16),
              decoration: BoxDecoration(color: t.raised, borderRadius: BorderRadius.circular(14), border: Border.all(color: t.border)),
              clipBehavior: Clip.antiAlias,
              child: Column(children: [for (var i = 0; i < _sessions.length && i < 40; i++) _chatRow(context, _sessions[i], last: i == _sessions.length - 1 || i == 39)]),
            ),
          SecHeader(icon: Icons.description_outlined, title: 'Files', more: 'Browse folder', onMore: () => Nav.instance.push(FileScreen(path: p.path, isDir: true))),
          if (made.isEmpty)
            Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text('Files your chats make here show up first. Browse the folder for everything else.', style: TextStyle(color: t.muted, fontSize: 14)))
          else
            SizedBox(
              height: 196,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: made.length,
                separatorBuilder: (_, _) => const SizedBox(width: 10),
                itemBuilder: (_, i) => SizedBox(width: 168, child: MadeTile(made[i])),
              ),
            ),
        ]),
      ),
    );
  }

  static String _firstLines(String md) {
    final lines = md.split('\n').map((l) => l.replaceAll(RegExp(r'^[#>\-*\s]+'), '').trim()).where((l) => l.isNotEmpty && !l.startsWith('@') && !l.startsWith('---')).take(3);
    return lines.join(' · ');
  }

  Widget _infoCard(BuildContext context, {required IconData icon, required String title, required String tag, required String body, VoidCallback? onTap}) {
    final t = context.t;
    return Card2(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      onTap: onTap,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(icon, size: 17, color: t.muted),
          const SizedBox(width: 8),
          Expanded(child: Text(title, style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600))),
          Tag(tag),
        ]),
        const SizedBox(height: 6),
        Text(body, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 13.5, height: 1.4)),
      ]),
    );
  }

  Widget _chatRow(BuildContext context, SessionMeta s, {required bool last}) {
    final t = context.t;
    final running = _store.isRunning(s.id) || s.running;
    final needs = _store.needsYou(s.id) || s.needs;
    return InkWell(
      onTap: () => openSession(key: s.key.isNotEmpty ? s.key : p.key, id: s.id, cwd: s.cwd.isNotEmpty ? s.cwd : p.path, title: s.title, focus: needs),
      child: Container(
        constraints: const BoxConstraints(minHeight: 52),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: t.border))),
        child: Row(children: [
          running || needs ? PulseDot(color: needs ? t.warn : t.accent) : Padding(padding: const EdgeInsets.all(4), child: StatusDot(t.ok, size: 7)),
          const SizedBox(width: 8),
          Expanded(child: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14.5, fontWeight: FontWeight.w500))),
          const SizedBox(width: 8),
          Text(relTime(s.mtime), style: TextStyle(color: t.faint, fontSize: 12)),
        ]),
      ),
    );
  }
}
