/// "Files & progress" for one chat, as a bottom sheet: the files it touched, its todo list (the
/// latest TodoWrite), and the details (teammate, model, mode, folder, computer, usage, id) with
/// the Show technical details switch.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/models.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';
import '../../widgets/composer.dart';
import '../../widgets/transcript.dart';
import '../../widgets/turn.dart';
import 'session_utils.dart';

Future<void> showChatPanel(BuildContext context, {required List<Msg> msgs, required String id, required String cwd, required Usage usage, required ValueChanged<String> onOpenFile}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: .7,
      minChildSize: .4,
      maxChildSize: .95,
      builder: (ctx, scroll) => _ChatPanel(msgs: msgs, id: id, cwd: cwd, usage: usage, onOpenFile: onOpenFile, scroll: scroll),
    ),
  );
}

class _ChatPanel extends StatelessWidget {
  const _ChatPanel({required this.msgs, required this.id, required this.cwd, required this.usage, required this.onOpenFile, required this.scroll});
  final List<Msg> msgs;
  final String id, cwd;
  final Usage usage;
  final ValueChanged<String> onOpenFile;
  final ScrollController scroll;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return DefaultTabController(
      length: 3,
      child: Column(children: [
        TabBar(
          labelColor: t.fg,
          unselectedLabelColor: t.muted,
          indicatorColor: t.accent,
          dividerColor: t.border,
          labelStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          tabs: const [Tab(text: 'Files'), Tab(text: 'Progress'), Tab(text: 'Details')],
        ),
        Expanded(
          child: TabBarView(children: [
            _files(context),
            _progress(context),
            _details(context),
          ]),
        ),
      ]),
    );
  }

  Widget _files(BuildContext context) {
    final t = context.t;
    final files = touchedFiles(msgs.where((m) => m.isTool)).entries.toList().reversed.toList();
    if (files.isEmpty) {
      return ListView(controller: scroll, children: const [EmptyState(icon: Icons.description_outlined, title: 'No files yet', body: 'Files appear here as the work produces them.')]);
    }
    return ListView(controller: scroll, padding: const EdgeInsets.fromLTRB(16, 12, 16, 24), children: [
      Text('TOUCHED IN THIS CHAT · ${files.length}', style: TextStyle(color: t.faint, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.1)),
      const SizedBox(height: 6),
      for (final f in files)
        InkWell(
          onTap: () {
            Navigator.pop(context);
            onOpenFile(f.key);
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(children: [
              FileBadge(extOf(baseName(f.key)), size: 30),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(baseName(f.key), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14, fontWeight: FontWeight.w600)),
                  Text(prettyPath(f.key), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 12)),
                ]),
              ),
              const SizedBox(width: 8),
              Tag(f.value ? 'new' : 'edited', kind: f.value ? 'ok' : 'acc'),
            ]),
          ),
        ),
    ]);
  }

  Widget _progress(BuildContext context) {
    final t = context.t;
    Msg? last;
    for (final m in msgs) {
      if (m.isTool && m.name == 'TodoWrite') last = m;
    }
    final todos = (last?.input?['todos'] as List?) ?? const [];
    if (todos.isEmpty) {
      return ListView(controller: scroll, children: const [EmptyState(icon: Icons.checklist_rounded, title: 'No plan yet', body: 'When the work has steps, the todo list shows here.')]);
    }
    return ListView(controller: scroll, padding: const EdgeInsets.fromLTRB(16, 12, 16, 24), children: [
      for (final raw in todos)
        if (raw is Map)
          Builder(builder: (_) {
            final status = (raw['status'] ?? '').toString();
            final done = status == 'completed';
            final doing = status == 'in_progress';
            final text = (doing && (raw['activeForm'] ?? '').toString().isNotEmpty ? raw['activeForm'] : raw['content'] ?? '').toString();
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 7),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Container(
                  width: 18,
                  height: 18,
                  margin: const EdgeInsets.only(top: 1),
                  decoration: BoxDecoration(
                    color: done ? t.ok : null,
                    borderRadius: BorderRadius.circular(5),
                    border: Border.all(color: done ? t.ok : (doing ? t.accent : t.borderStrong), width: 1.5),
                    boxShadow: doing ? [BoxShadow(color: t.accent.withValues(alpha: .25), spreadRadius: 3)] : null,
                  ),
                  child: done ? const Icon(Icons.check_rounded, size: 13, color: Colors.white) : null,
                ),
                const SizedBox(width: 11),
                Expanded(child: Text(text, style: TextStyle(color: done ? t.faint : t.fg, fontSize: 14.5, decoration: done ? TextDecoration.lineThrough : null))),
              ]),
            );
          }),
    ]);
  }

  Widget _details(BuildContext context) {
    final t = context.t;
    final store = AppStore.instance;
    final turn = store.turn;
    String n(int v) => v >= 1000 ? '${(v / 1000).toStringAsFixed(v >= 100000 ? 0 : 1)}k' : '$v';
    final tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    Widget kv(String k, String v, {bool copy = false}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 7),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 110, child: Text(k, style: TextStyle(color: t.faint, fontSize: 13))),
            Expanded(child: SelectableText(v, style: mono(12.5, t.fg))),
            if (copy)
              IconButton(
                tooltip: 'Copy',
                visualDensity: VisualDensity.compact,
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: v));
                  toast(context, 'Copied');
                },
                icon: Icon(Icons.copy_rounded, size: 16, color: t.muted),
              ),
          ]),
        );
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) => ListView(controller: scroll, padding: const EdgeInsets.fromLTRB(16, 12, 16, 24), children: [
        kv('Teammate', agentLabel(turn.agent)),
        kv('Model', '${modelLabel(turn.model)} · effort ${effortLabel(turn.effort)}'),
        kv('Freedom', modeInfo(turn.permissionMode).label),
        kv('Folder', prettyPath(cwd)),
        kv('Runs on', store.computerName),
        if (tokens > 0) kv('Tokens', '${n(tokens)} (${n(usage.output)} written)'),
        kv('Chat id', id, copy: true),
        const SizedBox(height: 12),
        Text('POWER TOOLS', style: TextStyle(color: t.faint, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.1)),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: store.showTech,
          onChanged: store.setShowTech,
          title: Text('Show technical details', style: TextStyle(color: t.fg, fontSize: 15.5)),
          subtitle: Text('Raw tool calls, thinking and hooks in every chat', style: TextStyle(color: t.muted, fontSize: 13)),
        ),
      ]),
    );
  }
}
