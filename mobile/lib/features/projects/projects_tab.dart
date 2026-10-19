/// Projects: folders with history (/api/projects) merged with the Bridge roots, a per-project
/// session list, and a small folder browser (/api/dir) to start a session anywhere.
library;

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/common.dart';
import '../session/session_utils.dart';

class ProjectsTab extends StatefulWidget {
  const ProjectsTab({super.key});
  @override
  State<ProjectsTab> createState() => _ProjectsTabState();
}

class _ProjectsTabState extends State<ProjectsTab> {
  final _store = AppStore.instance;
  List<Project> _projects = const [];
  bool _loading = true;
  String _error = '';

  bool _loadedOnce = false;

  @override
  void initState() {
    super.initState();
    _store.addListener(_onStore);
    _load();
  }

  @override
  void dispose() {
    _store.removeListener(_onStore);
    super.dispose();
  }

  /// The tab can be built before the server connects; load once it is ready.
  void _onStore() {
    if (!_loadedOnce && _store.conn == ConnState.ready) _load();
  }

  Future<void> _load() async {
    if (!_store.hasServer || _store.conn != ConnState.ready) {
      if (mounted) setState(() => _loading = false);
      return;
    }
    _loadedOnce = true;
    try {
      final p = await _store.api.projects();
      if (!mounted) return;
      setState(() {
        _projects = p;
        _error = '';
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _refresh() async {
    await Future.wait([_load(), _store.refreshAll()]);
  }

  List<Project> _merged() {
    final out = [..._projects];
    final paths = _projects.map((p) => p.path).toSet();
    for (final r in _store.roots) {
      if (r.isEmpty || paths.contains(r)) continue;
      out.add(Project(key: projectKeyFor(r), path: r, name: baseName(r), sessions: 0, lastActivity: 0, exists: true));
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ListenableBuilder(
      listenable: _store,
      builder: (context, _) {
        final items = _merged();
        final roots = _store.roots.toSet();
        Widget body;
        if (_loading && items.isEmpty) {
          body = ListView(children: [const SizedBox(height: 160), Center(child: CircularProgressIndicator(color: t.accent, strokeWidth: 2))]);
        } else if (items.isEmpty) {
          body = ListView(physics: const AlwaysScrollableScrollPhysics(), children: [
            const SizedBox(height: 80),
            EmptyState(icon: Icons.folder_off_outlined, title: _error.isNotEmpty ? 'Could not load projects' : 'No projects yet', body: _error.isNotEmpty ? _error : 'Add folders to Bridge on your computer, then pull to refresh.'),
          ]);
        } else {
          body = ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              SectionHeader('Projects', count: items.length),
              for (final p in items) _ProjectCard(p, isRoot: roots.contains(p.path)),
            ],
          );
        }
        return Scaffold(
          body: SafeArea(
            bottom: false,
            child: RefreshIndicator(color: t.accent, onRefresh: _refresh, child: body),
          ),
        );
      },
    );
  }
}

class _ProjectCard extends StatelessWidget {
  const _ProjectCard(this.p, {required this.isRoot});
  final Project p;
  final bool isRoot;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final meta = [
      p.sessions == 0 ? 'No sessions' : '${p.sessions} ${p.sessions == 1 ? 'session' : 'sessions'}',
      if (p.lastActivity > 0) relTime(p.lastActivity),
    ].join(' · ');
    return Card2(
      onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ProjectScreen(project: p))),
      child: Row(children: [
        Icon(isRoot ? Icons.home_work_outlined : Icons.folder_outlined, color: p.exists ? t.accent : t.faint, size: 22),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(p.name.isNotEmpty ? p.name : baseName(p.path), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 2),
            Text(prettyPath(p.path), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 12.5)),
            const SizedBox(height: 4),
            Text(meta, style: TextStyle(color: t.muted, fontSize: 13)),
          ]),
        ),
        Icon(Icons.chevron_right_rounded, color: t.faint),
      ]),
    );
  }
}

/// One project: its sessions, plus "Browse folder" and "New session here" in thumb reach.
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

  Project get p => widget.project;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final s = await _store.api.sessions(p.key);
      if (!mounted) return;
      setState(() {
        _sessions = s;
        _error = '';
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    Widget list;
    if (_loading) {
      list = ListView(children: [const SizedBox(height: 160), Center(child: CircularProgressIndicator(color: t.accent, strokeWidth: 2))]);
    } else if (_sessions.isEmpty) {
      list = ListView(physics: const AlwaysScrollableScrollPhysics(), children: [
        const SizedBox(height: 80),
        EmptyState(icon: Icons.chat_bubble_outline_rounded, title: _error.isNotEmpty ? 'Could not load sessions' : 'No sessions here yet', body: _error.isNotEmpty ? _error : 'Start one below.'),
      ]);
    } else {
      list = ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 16),
        children: [
          SectionHeader('Sessions', count: _sessions.length),
          for (final s in _sessions) _SessionCard(s, fallbackCwd: p.path),
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(p.name.isNotEmpty ? p.name : baseName(p.path), maxLines: 1, overflow: TextOverflow.ellipsis),
          Text(prettyPath(p.path), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 12.5, fontWeight: FontWeight.w500)),
        ]),
      ),
      body: RefreshIndicator(color: t.accent, onRefresh: _load, child: list),
      bottomNavigationBar: _BottomActions(
        actions: [
          (icon: Icons.folder_open_outlined, label: 'Browse folder', primary: false, onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => DirBrowserScreen(path: p.path)))),
          (icon: Icons.add_rounded, label: 'New session here', primary: true, onTap: () => startNewSession(context, cwd: p.path)),
        ],
      ),
    );
  }
}

class _SessionCard extends StatelessWidget {
  const _SessionCard(this.s, {required this.fallbackCwd});
  final SessionMeta s;
  final String fallbackCwd;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final cwd = s.cwd.isNotEmpty ? s.cwd : fallbackCwd;
    final meta = [relTime(s.mtime), if (s.turns > 0) '${s.turns} ${s.turns == 1 ? 'turn' : 'turns'}', if (s.branch.isNotEmpty) s.branch].join(' · ');
    final live = liveFor(s.id);
    return Card2(
      onTap: () => openSession(context, key: s.key.isNotEmpty ? s.key : projectKeyFor(cwd), id: s.id, cwd: cwd, title: s.title),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 16, fontWeight: FontWeight.w600))),
          if (live != null) ...[
            const SizedBox(width: 8),
            live.waiting != null ? const StatusPill('waiting', kind: 'waiting') : StatusPill(live.busy ? 'running' : 'idle', kind: live.busy ? 'running' : 'neutral'),
          ],
        ]),
        if (s.preview.isNotEmpty && s.preview != s.title) ...[
          const SizedBox(height: 4),
          Text(s.preview, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 14, height: 1.4)),
        ],
        const SizedBox(height: 6),
        Text(meta, style: TextStyle(color: t.faint, fontSize: 12.5)),
      ]),
    );
  }
}

typedef _Action = ({IconData icon, String label, bool primary, VoidCallback onTap});

class _BottomActions extends StatelessWidget {
  const _BottomActions({required this.actions});
  final List<_Action> actions;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Container(
      decoration: BoxDecoration(color: t.bg, border: Border(top: BorderSide(color: t.border))),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
          child: Row(children: [
            for (var i = 0; i < actions.length; i++) ...[
              if (i > 0) const SizedBox(width: 10),
              Expanded(
                child: SizedBox(
                  height: 48,
                  child: actions[i].primary
                      ? FilledButton.icon(
                          onPressed: actions[i].onTap,
                          icon: Icon(actions[i].icon, size: 20),
                          label: Text(actions[i].label, maxLines: 1, overflow: TextOverflow.ellipsis),
                          style: FilledButton.styleFrom(backgroundColor: t.accent, foregroundColor: t.accentFg, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)), textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                        )
                      : OutlinedButton.icon(
                          onPressed: actions[i].onTap,
                          icon: Icon(actions[i].icon, size: 20),
                          label: Text(actions[i].label, maxLines: 1, overflow: TextOverflow.ellipsis),
                          style: OutlinedButton.styleFrom(foregroundColor: t.fg, side: BorderSide(color: t.borderStrong), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)), textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                        ),
                ),
              ),
            ],
          ]),
        ),
      ),
    );
  }
}

/// A plain directory browser over /api/dir. Every folder can start a session.
class DirBrowserScreen extends StatefulWidget {
  const DirBrowserScreen({super.key, required this.path});
  final String path;
  @override
  State<DirBrowserScreen> createState() => _DirBrowserScreenState();
}

class _DirBrowserScreenState extends State<DirBrowserScreen> {
  final _store = AppStore.instance;
  late String _path = widget.path;
  DirListing? _listing;
  bool _loading = true;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _load(_path);
  }

  Future<void> _load(String path) async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final l = await _store.api.dir(path);
      if (!mounted) return;
      setState(() {
        _listing = l;
        _path = l.path.isNotEmpty ? l.path : path;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final l = _listing;
    final dirs = l?.entries.where((e) => e.dir).toList() ?? const <DirEntry>[];
    final files = l?.entries.where((e) => !e.dir).length ?? 0;
    final parent = l?.parent;

    Widget body;
    if (_loading && l == null) {
      body = Center(child: CircularProgressIndicator(color: t.accent, strokeWidth: 2));
    } else if (_error.isNotEmpty) {
      body = EmptyState(icon: Icons.block_rounded, title: 'Cannot open this folder', body: _error, action: parent != null ? OutlinedButton(onPressed: () => _load(parent), child: const Text('Go up')) : null);
    } else {
      body = ListView(
        padding: const EdgeInsets.only(bottom: 16),
        children: [
          if (parent != null)
            _DirRow(name: '..', subtitle: 'Up one level', icon: Icons.arrow_upward_rounded, onOpen: () => _load(parent)),
          SectionHeader('Folders', count: dirs.length, trailing: files > 0 ? Text('$files ${files == 1 ? 'file' : 'files'}', style: TextStyle(color: t.faint, fontSize: 12)) : null),
          if (dirs.isEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8), child: Text('No subfolders.', style: TextStyle(color: t.muted, fontSize: 14))),
          for (final d in dirs)
            _DirRow(
              name: d.name,
              icon: Icons.folder_outlined,
              onOpen: () => _load(_join(_path, d.name)),
              onStart: () => startNewSession(context, cwd: _join(_path, d.name)),
            ),
        ],
      );
    }

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(baseName(_path), maxLines: 1, overflow: TextOverflow.ellipsis),
          Text(prettyPath(_path), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 12.5, fontWeight: FontWeight.w500)),
        ]),
        bottom: _loading && l != null ? PreferredSize(preferredSize: const Size.fromHeight(2), child: LinearProgressIndicator(minHeight: 2, color: t.accent, backgroundColor: t.border)) : null,
      ),
      body: body,
      bottomNavigationBar: _error.isNotEmpty
          ? null
          : _BottomActions(actions: [
              (icon: Icons.add_rounded, label: 'Start session in ${baseName(_path)}', primary: true, onTap: () => startNewSession(context, cwd: _path)),
            ]),
    );
  }
}

String _join(String dir, String name) => dir.endsWith('/') ? '$dir$name' : '$dir/$name';

class _DirRow extends StatelessWidget {
  const _DirRow({required this.name, required this.icon, required this.onOpen, this.onStart, this.subtitle});
  final String name;
  final String? subtitle;
  final IconData icon;
  final VoidCallback onOpen;
  final VoidCallback? onStart;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return InkWell(
      onTap: onOpen,
      child: Container(
        constraints: const BoxConstraints(minHeight: 52),
        padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.border))),
        child: Row(children: [
          Icon(icon, size: 20, color: t.muted),
          const SizedBox(width: 12),
          Expanded(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 15.5, fontWeight: FontWeight.w500)),
              if (subtitle != null) Text(subtitle!, style: TextStyle(color: t.faint, fontSize: 12)),
            ]),
          ),
          if (onStart != null)
            TextButton.icon(
              onPressed: onStart,
              style: TextButton.styleFrom(foregroundColor: t.accent, minimumSize: const Size(44, 44)),
              icon: const Icon(Icons.play_arrow_rounded, size: 18),
              label: const Text('Start here', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
            ),
        ]),
      ),
    );
  }
}
