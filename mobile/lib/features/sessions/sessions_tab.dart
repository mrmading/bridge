/// Sessions: Waiting on you · Running · Recent, a search field, and "+" for a new session.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/common.dart';
import '../session/session_utils.dart';

class SessionsTab extends StatefulWidget {
  const SessionsTab({super.key});
  @override
  State<SessionsTab> createState() => _SessionsTabState();
}

class _SessionsTabState extends State<SessionsTab> {
  final _store = AppStore.instance;
  final _search = TextEditingController();
  Timer? _debounce;
  Timer? _tick;
  String _q = '';
  List<SessionMeta> _remote = const [];
  bool _searching = false;

  @override
  void initState() {
    super.initState();
    // Live elapsed times on the Running cards.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _store.live.sessions.isNotEmpty) setState(() {});
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _tick?.cancel();
    _search.dispose();
    super.dispose();
  }

  void _onQuery(String v) {
    setState(() => _q = v.trim());
    _debounce?.cancel();
    if (_q.length < 3) {
      setState(() {
        _remote = const [];
        _searching = false;
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 350), () async {
      final q = _q;
      setState(() => _searching = true);
      try {
        final r = await _store.api.search(q);
        if (!mounted || q != _q) return;
        setState(() => _remote = r);
      } catch (_) {
        // Local filtering still works.
      } finally {
        if (mounted && q == _q) setState(() => _searching = false);
      }
    });
  }

  Future<void> _refresh() async {
    await Future.wait([_store.pollLive(), _store.refreshRecent()]);
  }

  bool _matchLive(LiveSession s) {
    if (_q.isEmpty) return true;
    final q = _q.toLowerCase();
    return '${s.title} ${s.folder} ${s.last} ${s.lastUser} ${s.waiting?.text ?? ''}'.toLowerCase().contains(q);
  }

  bool _matchMeta(SessionMeta s) {
    if (_q.isEmpty) return true;
    final q = _q.toLowerCase();
    return '${s.title} ${s.preview} ${s.folder} ${s.projectName}'.toLowerCase().contains(q);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ListenableBuilder(
      listenable: _store,
      builder: (context, _) {
        final live = _store.live.sessions.where(_matchLive).toList();
        final waiting = live.where((s) => s.waiting != null).toList();
        final running = live.where((s) => s.waiting == null).toList()..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
        final liveIds = _store.live.sessions.map((s) => s.id).toSet();

        final byId = <String, SessionMeta>{};
        for (final s in _store.recent.where(_matchMeta)) {
          byId[s.id] = s;
        }
        if (_q.length >= 3) {
          for (final s in _remote) {
            byId.putIfAbsent(s.id, () => s);
          }
        }
        final recent = byId.values.where((s) => !liveIds.contains(s.id)).toList()..sort((a, b) => b.mtime.compareTo(a.mtime));
        final limited = _q.isEmpty ? recent.take(40).toList() : recent;

        final children = <Widget>[];
        if (waiting.isNotEmpty) {
          children.add(SectionHeader('Waiting on you', count: waiting.length));
          children.addAll(waiting.map((s) => _WaitingCard(s)));
        }
        if (running.isNotEmpty) {
          children.add(SectionHeader('Running', count: running.length));
          children.addAll(running.map((s) => _RunningCard(s)));
        }
        String? day;
        for (final s in limited) {
          final d = dayLabel(s.mtime);
          if (d != day) {
            children.add(SectionHeader(day == null ? 'Recent · $d' : d));
            day = d;
          }
          children.add(_RecentCard(s));
        }

        return Scaffold(
          floatingActionButton: FloatingActionButton(
            tooltip: 'New session',
            backgroundColor: t.accent,
            foregroundColor: t.accentFg,
            onPressed: () => _showNewSession(context),
            child: const Icon(Icons.add_rounded, size: 28),
          ),
          body: SafeArea(
            bottom: false,
            child: Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: TextField(
                  controller: _search,
                  onChanged: _onQuery,
                  textInputAction: TextInputAction.search,
                  style: TextStyle(color: t.fg, fontSize: 16),
                  decoration: InputDecoration(
                    hintText: 'Search sessions',
                    prefixIcon: Icon(Icons.search_rounded, color: t.faint),
                    suffixIcon: _q.isEmpty
                        ? null
                        : IconButton(
                            tooltip: 'Clear',
                            icon: _searching ? SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 1.8, color: t.faint)) : Icon(Icons.close_rounded, color: t.faint),
                            onPressed: () {
                              _search.clear();
                              _onQuery('');
                            },
                          ),
                  ),
                ),
              ),
              Expanded(
                child: RefreshIndicator(
                  color: t.accent,
                  onRefresh: _refresh,
                  child: children.isEmpty
                      ? ListView(physics: const AlwaysScrollableScrollPhysics(), children: [
                          const SizedBox(height: 80),
                          EmptyState(
                            icon: Icons.forum_outlined,
                            title: _q.isEmpty ? 'No sessions yet' : 'No matches',
                            body: _q.isEmpty ? 'Tap + to start one in any of your folders.' : 'Nothing matches “$_q”.',
                          ),
                        ])
                      : ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                          padding: const EdgeInsets.only(bottom: 96),
                          children: children,
                        ),
                ),
              ),
            ]),
          ),
        );
      },
    );
  }

  void _showNewSession(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => const NewSessionSheet(),
    );
  }
}

String _cwdOf(LiveSession s) => s.cwd;

class _WaitingCard extends StatelessWidget {
  const _WaitingCard(this.s);
  final LiveSession s;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final w = s.waiting!;
    void open({String prefill = ''}) => openSession(context, key: s.key, id: s.id, cwd: _cwdOf(s), title: s.title, prefill: prefill, focus: true);
    return Card2(
      onTap: () => open(),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(s.title.isEmpty ? s.folder : s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 16, fontWeight: FontWeight.w600))),
          const SizedBox(width: 8),
          StatusPill(w.kind == 'plan' ? 'plan' : 'waiting', kind: 'waiting'),
        ]),
        const SizedBox(height: 2),
        Text(s.folder, style: TextStyle(color: t.muted, fontSize: 13)),
        if (w.text.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(w.text, maxLines: 4, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 15, height: 1.4)),
        ],
        if (w.options.isNotEmpty) ...[
          const SizedBox(height: 10),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final o in w.options)
              ActionChip(
                label: Text(o, style: TextStyle(color: t.accent, fontSize: 14, fontWeight: FontWeight.w600)),
                backgroundColor: t.accentSoft,
                materialTapTargetSize: MaterialTapTargetSize.padded,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: BorderSide(color: t.accent.withValues(alpha: .35))),
                onPressed: () => open(prefill: o),
              ),
          ]),
        ],
      ]),
    );
  }
}

class _RunningCard extends StatelessWidget {
  const _RunningCard(this.s);
  final LiveSession s;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final since = s.startedAt > 0 ? s.startedAt : s.updatedAt;
    return Card2(
      onTap: () => openSession(context, key: s.key, id: s.id, cwd: _cwdOf(s), title: s.title),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(s.title.isEmpty ? s.folder : s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 16, fontWeight: FontWeight.w600))),
          const SizedBox(width: 8),
          StatusPill(s.busy ? 'running' : 'idle', kind: s.busy ? 'running' : 'neutral'),
        ]),
        const SizedBox(height: 2),
        Text('${s.folder} · ${since > 0 ? elapsed(since) : ''}', style: TextStyle(color: t.muted, fontSize: 13)),
        if (s.last.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(s.last, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 14, height: 1.4)),
        ],
      ]),
    );
  }
}

class _RecentCard extends StatelessWidget {
  const _RecentCard(this.s);
  final SessionMeta s;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final cwd = s.projectPath.isNotEmpty ? s.projectPath : s.cwd;
    final meta = [s.folder, relTime(s.mtime), if (s.turns > 0) '${s.turns} ${s.turns == 1 ? 'turn' : 'turns'}'].where((x) => x.isNotEmpty).join(' · ');
    return Card2(
      onTap: () => openSession(context, key: s.key, id: s.id, cwd: cwd, title: s.title),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 16, fontWeight: FontWeight.w600)),
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

/// Folder picker (roots, then recent folders, then a typed path) + optional first message.
class NewSessionSheet extends StatefulWidget {
  const NewSessionSheet({super.key, this.initialFolder = ''});
  final String initialFolder;
  @override
  State<NewSessionSheet> createState() => _NewSessionSheetState();
}

class _NewSessionSheetState extends State<NewSessionSheet> {
  final _store = AppStore.instance;
  late final _path = TextEditingController(text: widget.initialFolder);
  final _msg = TextEditingController();
  late String _picked = widget.initialFolder;

  @override
  void initState() {
    super.initState();
    if (_picked.isEmpty) {
      final opts = _options();
      if (opts.isNotEmpty) _picked = opts.first;
    }
  }

  @override
  void dispose() {
    _path.dispose();
    _msg.dispose();
    super.dispose();
  }

  List<String> _options() {
    final seen = <String>{};
    final out = <String>[];
    for (final r in _store.roots) {
      if (r.isNotEmpty && seen.add(r)) out.add(r);
    }
    for (final s in _store.recent) {
      final p = s.projectPath.isNotEmpty ? s.projectPath : s.cwd;
      if (p.isNotEmpty && seen.add(p)) out.add(p);
      if (out.length >= 14) break;
    }
    return out;
  }

  String get _folder => _path.text.trim().isNotEmpty ? _path.text.trim() : _picked;

  void _go() {
    final cwd = _folder;
    if (cwd.isEmpty) {
      toast(context, 'Pick a folder first');
      return;
    }
    final msg = _msg.text.trim();
    final nav = Navigator.of(context);
    nav.pop();
    startNewSession(nav.context, cwd: cwd, message: msg);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final opts = _options();
    final typed = _path.text.trim().isNotEmpty;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * .85),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
          children: [
            Text('New session', style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 14),
            Text('FOLDER', style: TextStyle(color: t.faint, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.1)),
            const SizedBox(height: 6),
            for (final p in opts)
              _FolderOption(
                path: p,
                isRoot: _store.roots.contains(p),
                selected: !typed && p == _picked,
                onTap: () => setState(() {
                  _picked = p;
                  _path.clear();
                }),
              ),
            const SizedBox(height: 8),
            TextField(
              controller: _path,
              onChanged: (_) => setState(() {}),
              autocorrect: false,
              style: TextStyle(color: t.fg, fontSize: 15),
              decoration: const InputDecoration(hintText: 'Or type a path, e.g. /Users/me/code/app', prefixIcon: Icon(Icons.edit_location_alt_outlined)),
            ),
            const SizedBox(height: 16),
            Text('FIRST MESSAGE (OPTIONAL)', style: TextStyle(color: t.faint, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.1)),
            const SizedBox(height: 6),
            TextField(
              controller: _msg,
              minLines: 2,
              maxLines: 6,
              textCapitalization: TextCapitalization.sentences,
              style: TextStyle(color: t.fg, fontSize: 16),
              decoration: const InputDecoration(hintText: 'What should it do?'),
            ),
            const SizedBox(height: 16),
            SizedBox(
              height: 50,
              child: FilledButton(
                onPressed: _folder.isEmpty ? null : _go,
                style: FilledButton.styleFrom(backgroundColor: t.accent, foregroundColor: t.accentFg, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
                child: const Text('Start', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _FolderOption extends StatelessWidget {
  const _FolderOption({required this.path, required this.isRoot, required this.selected, required this.onTap});
  final String path;
  final bool isRoot, selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: selected ? t.accentSoft : t.active,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: selected ? t.accent : t.active)),
            child: Row(children: [
              Icon(isRoot ? Icons.home_work_outlined : Icons.folder_outlined, size: 18, color: selected ? t.accent : t.muted),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(baseName(path), style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600)),
                  Text(prettyPath(path), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 12)),
                ]),
              ),
              if (selected) Icon(Icons.check_rounded, size: 18, color: t.accent),
            ]),
          ),
        ),
      ),
    );
  }
}
