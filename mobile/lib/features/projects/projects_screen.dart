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
                Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 12), child: Text('A project is a folder your team works in. Its instructions, threads and files live together.', style: TextStyle(color: t.muted, fontSize: 14))),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                  child: TextField(onChanged: (v) => setState(() => _q = v.trim()), decoration: const InputDecoration(hintText: 'Find a project…', prefixIcon: Icon(Icons.search_rounded))),
                ),
                if (items.isEmpty) const EmptyState(icon: Icons.folder_off_outlined, title: 'No projects yet', body: 'Start a thread in a folder and it shows up here.'),
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
            Text([p.sessions == 0 ? 'No threads yet' : '${p.sessions} ${p.sessions == 1 ? 'thread' : 'threads'}', if (p.lastActivity > 0) relTime(p.lastActivity)].join(' · '), style: TextStyle(color: t.muted, fontSize: 13)),
          ]),
        ),
        if (waiting > 0) ...[Tag('$waiting needs you', kind: 'warn'), const SizedBox(width: 6)],
        if (live > 0) PulseDot(color: t.accent),
        Icon(Icons.chevron_right_rounded, color: t.faint),
      ]),
    );
  }
}

/// One project: Paquito (a new chat here), instructions, automations, then two tabs: Chats and Files.
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
  DirListing? _dir;
  String _dirError = '';

  Project get p => widget.project;
  String get _name => p.name.isNotEmpty ? p.name : baseName(p.path);
  String get _claudeMd => '${p.path}/CLAUDE.md';

  @override
  void initState() {
    super.initState();
    _load();
    _loadDir();
  }

  Future<void> _loadDir() async {
    try {
      final d = await _store.api.dir(p.path);
      if (!mounted) return;
      setState(() {
        _dir = d;
        _dirError = '';
      });
    } catch (e) {
      if (mounted) setState(() => _dirError = e.toString());
    }
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
            const SheetTitle('Automations', sub: 'Hooks that run on events, for every thread on this computer.'),
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
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(titleSpacing: 0, title: Text(_name)),
        body: NestedScrollView(
          headerSliverBuilder: (context, _) => [
            SliverToBoxAdapter(child: _header(context)),
            SliverPersistentHeader(
              pinned: true,
              delegate: _TabsHeader(
                color: t.bg,
                tabs: TabBar(
                  labelColor: t.fg,
                  unselectedLabelColor: t.muted,
                  indicatorColor: t.accent,
                  indicatorSize: TabBarIndicatorSize.label,
                  dividerColor: t.border,
                  labelStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                  tabs: [Tab(text: _sessions.isEmpty ? 'Threads' : 'Threads · ${_sessions.length}'), const Tab(text: 'Files')],
                ),
              ),
            ),
          ],
          body: TabBarView(children: [_chatsTab(context), _filesTab(context)]),
        ),
      ),
    );
  }

  /// Name, where it lives, the Paquito button, then instructions + automations.
  Widget _header(BuildContext context) {
    final t = context.t;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        child: Row(children: [
          ProjectIcon(_name, size: 48),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 22, fontWeight: FontWeight.w600)),
              Row(children: [
                Icon(_onCloud ? Icons.cloud_outlined : Icons.laptop_mac_rounded, size: 13, color: t.muted),
                const SizedBox(width: 4),
                Flexible(child: Text('${_onCloud ? 'Cloud computer' : _store.computerName} · ${prettyPath(p.path)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 12.5))),
              ]),
            ]),
          ),
        ]),
      ),
      Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 4), child: PaquitoButton(onTap: () => Nav.instance.newChat(cwd: p.path), label: 'Chief of Staff · works in $_name')),
      _infoCard(
        context,
        icon: Icons.menu_book_outlined,
        title: 'Instructions',
        tag: 'CLAUDE.md',
        body: _instructions == null ? 'Loading…' : (_instructions!.isEmpty ? 'No instructions yet. Every thread here would follow what you write in CLAUDE.md.' : _firstLines(_instructions!)),
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
      const SizedBox(height: 12),
    ]);
  }

  /// The app talks to one Bridge; on the sprite that machine is the cloud computer.
  bool get _onCloud => _store.isCloud || _store.boot?.hostKind == 'cloud';

  Widget _chatsTab(BuildContext context) {
    final t = context.t;
    return RefreshIndicator(
      color: t.accent,
      onRefresh: _load,
      child: ListView(physics: const AlwaysScrollableScrollPhysics(), padding: const EdgeInsets.fromLTRB(0, 12, 0, 32), children: [
        if (_loading) Center(child: Padding(padding: const EdgeInsets.all(20), child: CircularProgressIndicator(color: t.accent, strokeWidth: 2))),
        if (!_loading && _sessions.isEmpty) EmptyState(icon: Icons.chat_bubble_outline_rounded, title: _error.isNotEmpty ? 'Could not load threads' : 'No threads here yet', body: _error.isNotEmpty ? _error : 'Ask Paquito to start one in this project.'),
        if (_sessions.isNotEmpty)
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(color: t.raised, borderRadius: BorderRadius.circular(14), border: Border.all(color: t.border)),
            clipBehavior: Clip.antiAlias,
            child: Column(children: [for (var i = 0; i < _sessions.length && i < 80; i++) _chatRow(context, _sessions[i], last: i == _sessions.length - 1 || i == 79)]),
          ),
      ]),
    );
  }

  /// What chats made here first, then the project folder itself, on the machine the project lives on.
  Widget _filesTab(BuildContext context) {
    final t = context.t;
    final made = _store.home.made.where((m) => m.key == p.key || m.path.startsWith('${p.path}/')).toList();
    final dir = _dir;
    final entries = dir?.entries ?? const <DirEntry>[];
    return RefreshIndicator(
      color: t.accent,
      onRefresh: _loadDir,
      child: ListView(physics: const AlwaysScrollableScrollPhysics(), padding: const EdgeInsets.only(top: 8, bottom: 32), children: [
        if (made.isNotEmpty) ...[
          SecHeader(icon: Icons.auto_awesome_outlined, title: 'Made by your threads', count: made.length),
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
        ],
        SecHeader(icon: _onCloud ? Icons.cloud_outlined : Icons.folder_outlined, title: _onCloud ? 'On the cloud computer' : 'In the folder', count: dir == null ? null : entries.length),
        if (dir == null && _dirError.isEmpty) Center(child: Padding(padding: const EdgeInsets.all(20), child: CircularProgressIndicator(color: t.accent, strokeWidth: 2))),
        if (_dirError.isNotEmpty) EmptyState(icon: Icons.folder_off_outlined, title: 'Folder not on this computer', body: _dirError),
        if (dir != null && entries.isEmpty) const EmptyState(icon: Icons.folder_open_outlined, title: 'Empty folder'),
        for (final e in entries)
          EntryRow(
            icon: e.dir ? Icons.folder_rounded : null,
            badge: e.dir ? null : extOf(e.name),
            name: e.name,
            sub: e.dir ? null : [fileSize(e.size), if (e.mtime > 0) relTime(e.mtime)].join(' · '),
            onTap: () => Nav.instance.push(FileScreen(path: '${p.path}/${e.name}', isDir: e.dir)),
          ),
      ]),
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
    return InkWell(mouseCursor: hand, 
      onTap: () => openSession(key: s.key.isNotEmpty ? s.key : p.key, id: s.id, cwd: s.cwd.isNotEmpty ? s.cwd : p.path, title: s.title, focus: needs, computer: s.computer),
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

/// The Chats | Files bar, pinned under the project header while either list scrolls.
class _TabsHeader extends SliverPersistentHeaderDelegate {
  _TabsHeader({required this.tabs, required this.color});
  final TabBar tabs;
  final Color color;
  @override
  double get minExtent => tabs.preferredSize.height;
  @override
  double get maxExtent => tabs.preferredSize.height;
  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) => ColoredBox(color: color, child: tabs);
  @override
  bool shouldRebuild(_TabsHeader old) => old.tabs != tabs || old.color != color;
}
