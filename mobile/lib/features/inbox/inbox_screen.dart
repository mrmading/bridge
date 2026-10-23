/// Inbox: everything your chats did, newest first, questions on top. Filters: All · Needs you ·
/// Working · Done.
library;

import 'package:flutter/material.dart';

import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';
import '../session/session_utils.dart';
import '../shell/drawer.dart';

class InboxScreen extends StatefulWidget {
  const InboxScreen({super.key});
  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

typedef _Item = ({String kind, String id, String key, String cwd, String title, String sub, int at, String computer});

class _InboxScreenState extends State<InboxScreen> {
  final _store = AppStore.instance;
  String _filter = 'all';

  List<_Item> _items() {
    final h = _store.home;
    final busy = {...h.running.map((r) => r.id), ...h.needs.map((n) => n.id)};
    String cwdOf(String id) => _store.recent.where((s) => s.id == id).map((s) => s.cwd.isNotEmpty ? s.cwd : s.projectPath).firstOrNull ?? '';
    return [
      for (final n in h.needs) (kind: 'need', id: n.id, key: n.key, cwd: cwdOf(n.id), title: n.title, sub: [if (n.ask.isNotEmpty) n.ask, if (n.projectName.isNotEmpty) n.projectName].join(' · '), at: n.since, computer: n.computer),
      for (final r in h.running) (kind: 'run', id: r.id, key: r.key, cwd: r.cwd, title: r.title, sub: [if (r.step.isNotEmpty) r.step, if (r.projectName.isNotEmpty) r.projectName].join(' · '), at: r.started, computer: r.computer),
      for (final s in _store.recent.where((s) => !busy.contains(s.id)).take(40))
        (kind: 'done', id: s.id, key: s.key, cwd: s.cwd.isNotEmpty ? s.cwd : s.projectPath, title: s.title, sub: [projectNameOf(s), if (s.preview.isNotEmpty && s.preview != s.title) s.preview].join(' · '), at: s.mtime, computer: s.computer),
    ].where((x) => _filter == 'all' || x.kind == _filter).toList();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ListenableBuilder(
      listenable: _store,
      builder: (context, _) {
        final items = _items();
        return Scaffold(
          appBar: const RootAppBar(title: 'Inbox'),
          body: RefreshIndicator(
            color: t.accent,
            onRefresh: _store.refreshAll,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.only(bottom: 32),
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
                  child: Text('Everything your team did, newest first. Questions float to the top.', style: TextStyle(color: t.muted, fontSize: 14)),
                ),
                SizedBox(
                  height: 56,
                  child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(16, 12, 16, 4), children: [
                    for (final (k, l) in const [('all', 'All'), ('need', 'Needs you'), ('run', 'Working'), ('done', 'Done')])
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          label: Text(l),
                          selected: _filter == k,
                          showCheckmark: false,
                          labelStyle: TextStyle(color: _filter == k ? t.accent : t.muted, fontSize: 13.5, fontWeight: FontWeight.w600),
                          selectedColor: t.accentSoft,
                          backgroundColor: t.raised,
                          side: BorderSide(color: _filter == k ? t.accent.withValues(alpha: .4) : t.border),
                          shape: const StadiumBorder(),
                          onSelected: (_) => setState(() => _filter = k),
                        ),
                      ),
                  ]),
                ),
                if (items.isEmpty)
                  const Padding(padding: EdgeInsets.only(top: 60), child: EmptyState(icon: Icons.inbox_outlined, title: 'Nothing here', body: 'When a chat finishes or needs you, it lands here.'))
                else
                  Container(
                    margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                    decoration: BoxDecoration(color: t.raised, borderRadius: BorderRadius.circular(14), border: Border.all(color: t.border)),
                    clipBehavior: Clip.antiAlias,
                    child: Column(children: [
                      for (var i = 0; i < items.length; i++) _Row(items[i], last: i == items.length - 1),
                    ]),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.x, {required this.last});
  final _Item x;
  final bool last;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final (bg, fg, icon, verb) = switch (x.kind) {
      'need' => (t.warnSoft, t.warn, Icons.back_hand_outlined, 'Needs an answer'),
      'run' => (t.accentSoft, t.accent, Icons.bolt_rounded, 'Working'),
      _ => (t.okSoft, t.ok, Icons.check_rounded, 'Finished'),
    };
    void open() => openSession(key: x.key, id: x.id, cwd: x.cwd, title: x.title, focus: x.kind == 'need', computer: x.computer);
    return InkWell(
      onTap: open,
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
        decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: t.border))),
        child: Row(children: [
          Container(width: 34, height: 34, decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(10)), child: Icon(icon, size: 18, color: fg)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(x.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14.5, fontWeight: FontWeight.w600))),
                if (x.computer == 'cloud') ...[const SizedBox(width: 6), const CloudBadge(size: 13)],
              ]),
              const SizedBox(height: 2),
              Text(x.sub.isEmpty ? verb : '$verb · ${x.sub}', maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 13)),
            ]),
          ),
          const SizedBox(width: 10),
          if (x.kind == 'need')
            FilledButton(onPressed: open, style: FilledButton.styleFrom(minimumSize: const Size(72, 36), padding: const EdgeInsets.symmetric(horizontal: 12), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9))), child: const Text('Answer'))
          else if (x.kind == 'run' && x.at > 0)
            Elapsed(x.at)
          else
            Text(relTime(x.at), style: TextStyle(color: t.faint, fontSize: 12)),
        ]),
      ),
    );
  }
}
