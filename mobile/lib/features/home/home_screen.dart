/// Home, the Paquito hub (Vellum-style): the orb, a greeting and a one-line catch-up, what needs
/// you, what is working now (live, two to a row when there is room), the hub tiles (projects, files, agents & skills, connectors), what
/// was recently made for you, and projects to jump back into.
library;

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';
import '../../widgets/orb.dart';
import '../connectors/connectors_screen.dart';
import '../files/file_screen.dart';
import '../projects/projects_screen.dart';
import '../session/session_utils.dart';
import '../settings/settings_screen.dart';
import '../shell/drawer.dart';
import '../talk/talk_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _store = AppStore.instance;

  String _greeting() {
    final h = DateTime.now().hour;
    final part = h < 12 ? 'Good morning' : (h < 18 ? 'Good afternoon' : 'Good evening');
    final u = _store.displayName;
    return u.isEmpty ? part : '$part, $u';
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ListenableBuilder(
      listenable: _store,
      builder: (context, _) {
        final h = _store.home;
        // The backdrop sits behind a transparent scaffold so it lights the app bar too, while the
        // list scrolls under the bar instead of through it.
        return Stack(children: [
          const Positioned.fill(child: HubBackdrop()),
          Scaffold(
            backgroundColor: Colors.transparent,
            appBar: const RootAppBar(),
            body: RefreshIndicator(
              color: t.accent,
              onRefresh: _store.refreshAll,
              child: ListView(
                padding: const EdgeInsets.only(top: 4, bottom: 40),
                children: [
                  if (_store.cloudOffline) CloudOfflineBanner(reason: _store.computerById('cloud')?.reason ?? '', margin: const EdgeInsets.fromLTRB(16, 0, 16, 12)),
                  _hero(context),
                  if (_store.conn == ConnState.ready && !_store.auth.loggedIn) _signIn(context),
                  // Wide windows have room for the hub row in view, as Vellum does; phones put the urgent cards first.
                  if (Nav.instance.docked) const HubTiles(),
                  if (h.needs.isNotEmpty) ...[
                    SecHeader(icon: Icons.back_hand_outlined, title: 'Needs you', count: h.needs.length, countKind: 'warn', more: 'Open inbox', onMore: () => Nav.instance.go(RootView.inbox)),
                    for (final n in h.needs) NeedCard(n),
                  ],
                  if (h.running.isNotEmpty) ...[
                    SecHeader(icon: Icons.bolt_rounded, title: 'Working now', count: h.running.length, countKind: 'acc'),
                    _running(h.running),
                  ],
                  if (!Nav.instance.docked) const HubTiles(),
                  if (h.made.isNotEmpty) ...[
                    SecHeader(icon: Icons.description_outlined, title: 'Recently made for you', more: 'All files', onMore: () => Nav.instance.go(RootView.files)),
                    SizedBox(
                      height: 196,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        itemCount: h.made.length.clamp(0, 12),
                        separatorBuilder: (_, _) => const SizedBox(width: 10),
                        itemBuilder: (_, i) => SizedBox(width: 168, child: MadeTile(h.made[i])),
                      ),
                    ),
                  ],
                  if (h.projects.isNotEmpty) ...[
                    SecHeader(icon: Icons.folder_outlined, title: 'Jump back in', more: 'All projects', onMore: () => Nav.instance.go(RootView.projects)),
                    _projects(context, h.projects),
                  ],
                ],
              ),
            ),
          ),
        ]);
      },
    );
  }

  Widget _hero(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
      child: Column(children: [
        Semantics(
          button: true,
          label: 'Talk to ${_store.assistantName}',
          child: MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(onTap: () => openTalk(context), child: Orb(phase: _store.conn == ConnState.ready ? 'idle' : 'offline', color: _store.accent, size: 128,
                ))),
        ),
        const SizedBox(height: 2),
        GradientText(_greeting(), textAlign: TextAlign.center, style: TextStyle(color: t.fg, fontSize: 30, fontWeight: FontWeight.w600, letterSpacing: -.4, height: 1.2)),
        const SizedBox(height: 10),
        _catchUp(context),
        const SizedBox(height: 8),
      ]),
    );
  }

  Widget _catchUp(BuildContext context) {
    final t = context.t;
    final h = _store.home;
    final now = DateTime.now();
    final busy = {...h.running.map((r) => r.id), ...h.needs.map((n) => n.id)};
    final finished = _store.recent.where((s) {
      final d = DateTime.fromMillisecondsSinceEpoch(s.mtime);
      return !busy.contains(s.id) && d.year == now.year && d.month == now.month && d.day == now.day;
    }).length;
    final bold = TextStyle(color: t.fg, fontWeight: FontWeight.w600);
    final parts = <InlineSpan>[];
    void add(String b) {
      if (parts.isNotEmpty) parts.add(const TextSpan(text: ', '));
      parts.add(TextSpan(text: b, style: bold));
    }

    if (h.needs.isNotEmpty) add('${h.needs.length} ${h.needs.length == 1 ? 'thing needs' : 'things need'} you');
    if (h.running.isNotEmpty) add('${h.running.length} ${h.running.length == 1 ? 'thread is' : 'threads are'} working');
    if (finished > 0) add('$finished ${finished == 1 ? 'thread' : 'threads'} finished today');
    if (parts.length > 1) parts.insert(parts.length - 1, const TextSpan(text: 'and '));
    final text = parts.isEmpty
        ? const TextSpan(text: 'All quiet. Pick up where you left off, or start a new thread with +.')
        : TextSpan(children: [...parts, const TextSpan(text: '.')]);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Text.rich(text, textAlign: TextAlign.center, style: TextStyle(color: t.muted, fontSize: 15, height: 1.45)),
    );
  }

  Widget _signIn(BuildContext context) {
    final t = context.t;
    return Card2(
      margin: const EdgeInsets.fromLTRB(16, 18, 16, 0),
      accent: true,
      onTap: () => Nav.instance.push(const SettingsScreen()),
      child: Row(children: [
        Icon(Icons.lock_outline_rounded, color: t.accent, size: 20),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Sign in to Claude', style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600)),
            Text('Claude Code on ${_store.computerName} is not signed in.', style: TextStyle(color: t.muted, fontSize: 13)),
          ]),
        ),
        Icon(Icons.chevron_right_rounded, color: t.faint),
      ]),
    );
  }

  /// Compact running cards, two or three to a row once the pane is wide enough.
  Widget _running(List<Run> runs) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
        child: LayoutBuilder(builder: (context, box) {
          final cols = box.maxWidth >= 1100 ? 3 : (box.maxWidth >= 520 ? 2 : 1);
          final w = (box.maxWidth - 10 * (cols - 1)) / cols;
          return Wrap(spacing: 10, runSpacing: 10, children: [for (final r in runs) SizedBox(width: w, child: RunCard(r))]);
        }),
      );

  Widget _projects(BuildContext context, List<HomeProject> list) {
    final sorted = [...list.where((p) => isProjectPath(p.path))]..sort((a, b) => b.mtime.compareTo(a.mtime));
    final top = sorted.take(4).toList();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: LayoutBuilder(builder: (context, box) {
        final w = (box.maxWidth - 10) / 2;
        return Wrap(spacing: 10, runSpacing: 10, children: [for (final p in top) SizedBox(width: w, child: _ProjectTile(p))]);
      }),
    );
  }
}

/// A chat waiting on the user, with its question and an Answer button.
class NeedCard extends StatelessWidget {
  const NeedCard(this.n, {super.key});
  final Need n;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    void open() => openSession(key: n.key, id: n.id, cwd: _cwdFor(n.id), title: n.title, focus: true, computer: n.computer);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      child: Material(
        color: t.raised,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(mouseCursor: hand, 
          borderRadius: BorderRadius.circular(14),
          onTap: open,
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: Color.alphaBlend(t.warn.withValues(alpha: .45), t.border)),
              gradient: LinearGradient(begin: Alignment.topLeft, end: const Alignment(.4, 1), colors: [t.warn.withValues(alpha: .08), t.warn.withValues(alpha: 0)]),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                PulseDot(color: t.warn),
                const SizedBox(width: 4),
                Expanded(child: Text(n.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600))),
                if (n.computer == 'cloud') ...[const CloudBadge(), const SizedBox(width: 6)],
                if (n.since > 0) Text(relTime(n.since), style: TextStyle(color: t.faint, fontSize: 12)),
              ]),
              if (n.ask.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(n.ask, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14, height: 1.4, fontWeight: FontWeight.w500)),
              ],
              const SizedBox(height: 12),
              Row(children: [
                FilledButton(
                  onPressed: open,
                  style: FilledButton.styleFrom(minimumSize: const Size(88, 40), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
                  child: const Text('Answer', style: TextStyle(fontWeight: FontWeight.w700)),
                ),
                const SizedBox(width: 10),
                if (n.projectName.isNotEmpty) Flexible(child: Tag(n.projectName)),
              ]),
            ]),
          ),
        ),
      ),
    );
  }
}

String _cwdFor(String id) {
  for (final s in AppStore.instance.recent) {
    if (s.id == id) return s.cwd.isNotEmpty ? s.cwd : s.projectPath;
  }
  return '';
}

/// A running chat, compact: title, live elapsed, what it is doing and where, its first jobs, a sweeping bar.
class RunCard extends StatelessWidget {
  const RunCard(this.r, {super.key});
  final Run r;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Material(
        color: t.raised.withValues(alpha: .72),
        borderRadius: BorderRadius.circular(14),
        clipBehavior: Clip.antiAlias,
        child: InkWell(mouseCursor: hand, 
          onTap: () => openSession(key: r.key, id: r.id, cwd: r.cwd, title: r.title, computer: r.computer),
          child: Container(
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), border: Border.all(color: t.border)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    PulseDot(color: t.accent),
                    const SizedBox(width: 4),
                    Expanded(child: Text(r.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14, fontWeight: FontWeight.w600))),
                    if (r.computer == 'cloud') ...[const SizedBox(width: 6), const CloudBadge()],
                    const SizedBox(width: 8),
                    if (r.started > 0) Elapsed(r.started, style: TextStyle(color: t.muted, fontSize: 12.5, fontFamily: 'Menlo', fontFamilyFallback: const ['monospace'])),
                  ]),
                  const SizedBox(height: 6),
                  Row(children: [
                    _Typing(color: t.accent),
                    const SizedBox(width: 8),
                    Expanded(
                      child: AnimatedSwitcher(
                        duration: const Duration(milliseconds: 300),
                        layoutBuilder: (cur, prev) => Stack(alignment: Alignment.centerLeft, children: [...prev, ?cur]),
                        transitionBuilder: (c, a) => FadeTransition(opacity: a, child: SlideTransition(position: Tween(begin: const Offset(0, .4), end: Offset.zero).animate(a), child: c)),
                        child: Text(r.step.isNotEmpty ? r.step : 'Working…', key: ValueKey(r.step), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 12.5)),
                      ),
                    ),
                    if (r.projectName.isNotEmpty) ...[const SizedBox(width: 8), Text(r.projectName, style: TextStyle(color: t.faint, fontSize: 12))],
                  ]),
                  if (r.jobs.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(spacing: 6, runSpacing: 6, children: [for (final j in r.jobs.take(2)) JobChip(j)]),
                  ],
                ]),
              ),
              SizedBox(height: 2, child: LinearProgressIndicator(minHeight: 2, color: t.accent, backgroundColor: Colors.transparent)),
            ]),
          ),
        ),
    );
  }
}

/// Three dots blinking in turn: something is being written.
class _Typing extends StatefulWidget {
  const _Typing({required this.color});
  final Color color;
  @override
  State<_Typing> createState() => _TypingState();
}

class _TypingState extends State<_Typing> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat();
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _c,
        builder: (_, _) => Row(mainAxisSize: MainAxisSize.min, children: [
          for (var i = 0; i < 3; i++)
            Container(
              width: 5,
              height: 5,
              margin: const EdgeInsets.only(right: 3),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: widget.color.withValues(alpha: .25 + .75 * (1 - ((_c.value - i * .13) % 1 - .4).abs().clamp(0.0, .4) / .4)),
              ),
            ),
        ]),
      );
}

/// A file a chat made: a coloured thumb with its type, the name, who made it and when.
class MadeTile extends StatelessWidget {
  const MadeTile(this.m, {super.key});
  final Made m;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final c = extColor(m.ext);
    return Material(
      color: t.raised,
      borderRadius: BorderRadius.circular(14),
      clipBehavior: Clip.antiAlias,
      child: InkWell(mouseCursor: hand, 
        onTap: () => Nav.instance.push(FileScreen(path: m.path, computer: m.computer)),
        child: Container(
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), border: Border.all(color: t.border)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Container(
              height: 104,
              decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: t.border)),
                gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color.alphaBlend(c.withValues(alpha: .22), t.sunken), t.sunken]),
              ),
              child: Stack(children: [
                Positioned(
                  left: 10,
                  top: 10,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                    decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(6)),
                    child: Text(m.ext.isEmpty ? 'FILE' : m.ext, style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w800, fontFamily: 'Menlo', fontFamilyFallback: ['monospace'])),
                  ),
                ),
                Positioned(
                  left: 34,
                  right: 22,
                  top: 36,
                  bottom: -14,
                  child: Transform.rotate(
                    angle: -.035,
                    child: Container(
                      padding: const EdgeInsets.all(9),
                      decoration: BoxDecoration(color: t.raised, borderRadius: BorderRadius.circular(8), border: Border.all(color: t.border)),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Container(height: 7, width: 54, decoration: BoxDecoration(color: Color.alphaBlend(t.accent.withValues(alpha: .4), t.active), borderRadius: BorderRadius.circular(3))),
                        for (final w in [1.0, .8, 1.0, .55]) ...[
                          const SizedBox(height: 5),
                          FractionallySizedBox(widthFactor: w, child: Container(height: 4, decoration: BoxDecoration(color: t.active, borderRadius: BorderRadius.circular(3)))),
                        ],
                      ]),
                    ),
                  ),
                ),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(11, 9, 11, 10),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(m.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 13.5, fontWeight: FontWeight.w600)),
                const SizedBox(height: 3),
                Text([if (m.sessionTitle.isNotEmpty) m.sessionTitle, if (m.mtime > 0) relTime(m.mtime)].join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 11.5)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _ProjectTile extends StatelessWidget {
  const _ProjectTile(this.p);
  final HomeProject p;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final store = AppStore.instance;
    final live = store.home.running.any((r) => r.key == p.key);
    final name = p.name.isNotEmpty ? p.name : baseName(p.path);
    return Material(
      color: t.raised,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(mouseCursor: hand, 
        borderRadius: BorderRadius.circular(14),
        onTap: () => Nav.instance.push(ProjectScreen(project: Project(key: p.key, path: p.path, name: name, sessions: p.count, lastActivity: p.mtime, exists: true))),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), border: Border.all(color: t.border)),
          child: Row(children: [
            ProjectIcon(name, size: 34),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14, fontWeight: FontWeight.w600)),
                Text('${p.count} ${p.count == 1 ? 'thread' : 'threads'}', style: TextStyle(color: t.faint, fontSize: 12)),
              ]),
            ),
            if (live) PulseDot(color: t.accent, size: 6),
          ]),
        ),
      ),
    );
  }
}

/// The hub's doorways, one row on wide windows and a 2-column grid on phones: the places that used to
/// sit in the sidebar.
class HubTiles extends StatelessWidget {
  const HubTiles({super.key});
  @override
  Widget build(BuildContext context) {
    final store = AppStore.instance;
    final nav = Nav.instance;
    final projects = store.projects.where((p) => isProjectPath(p.path)).length;
    final made = store.home.made.length;
    final agents = store.agents.length;
    final tiles = [
      _HubTile(icon: Icons.folder_outlined, title: 'Projects', sub: projects == 0 ? 'Your work folders' : '$projects ${projects == 1 ? 'project' : 'projects'}', onTap: () => nav.go(RootView.projects)),
      _HubTile(icon: Icons.description_outlined, title: 'Files', sub: made == 0 ? 'Made for you' : '$made made recently', onTap: () => nav.go(RootView.files)),
      _HubTile(icon: Icons.groups_2_outlined, title: 'Agents & skills', sub: agents == 0 ? 'Your team' : '$agents ${agents == 1 ? 'agent' : 'agents'}', onTap: () => nav.go(RootView.agents)),
      _HubTile(icon: Icons.extension_outlined, title: 'Connectors', sub: 'Apps & accounts', onTap: () => nav.push(const ConnectorsScreen())),
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 22, 16, 4),
      child: LayoutBuilder(builder: (context, box) {
        final cols = box.maxWidth >= 640 ? 4 : 2;
        final w = (box.maxWidth - 10 * (cols - 1)) / cols;
        return Wrap(spacing: 10, runSpacing: 10, children: [for (final tile in tiles) SizedBox(width: w, child: tile)]);
      }),
    );
  }
}

class _HubTile extends StatelessWidget {
  const _HubTile({required this.icon, required this.title, required this.sub, required this.onTap});
  final IconData icon;
  final String title, sub;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Material(
      color: t.raised.withValues(alpha: .72),
      borderRadius: BorderRadius.circular(14),
      child: InkWell(mouseCursor: hand,
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          height: 64,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: t.border),
            gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [t.accent.withValues(alpha: .08), t.accent.withValues(alpha: 0)]),
          ),
          foregroundDecoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border(top: BorderSide(color: t.accent.withValues(alpha: .45))),
          ),
          child: Row(children: [
            Icon(icon, size: 20, color: t.accent2),
            const SizedBox(width: 12),
            Expanded(
              child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14.5, fontWeight: FontWeight.w600)),
                Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 12)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}
