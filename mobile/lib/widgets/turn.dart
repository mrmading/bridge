/// How one assistant turn reads in a chat: a single "Worked for 6m · read 14 files · ran 3
/// commands" line (expandable into plain-English steps), the prose, and cards for files it wrote.
/// Raw tool cards only appear when Settings › Advanced › Show technical details is on.
library;

import 'package:flutter/material.dart';

import '../core/clock.dart';
import '../core/models.dart';
import '../core/theme.dart';
import 'bridge.dart';
import 'transcript.dart';

String _base(String p) {
  final parts = p.split('/').where((x) => x.isNotEmpty).toList();
  return parts.isEmpty ? p : parts.last;
}

String _clip(String s, int n) {
  final one = s.replaceAll(RegExp(r'\s+'), ' ').trim();
  return one.length <= n ? one : '${one.substring(0, n)}…';
}

String _input(Msg m, String k) => m.input?[k] == null ? '' : m.input![k].toString();

/// One plain-English sentence for a tool call.
String stepSentence(Msg m) {
  final n = m.name;
  switch (n) {
    case 'Read':
      return 'Read ${_base(_input(m, 'file_path'))}';
    case 'Edit':
    case 'MultiEdit':
      return 'Edited ${_base(_input(m, 'file_path'))}';
    case 'Write':
      return 'Wrote ${_base(_input(m, 'file_path'))}';
    case 'NotebookEdit':
      return 'Edited ${_base(_input(m, 'notebook_path'))}';
    case 'Bash':
      final d = _input(m, 'description');
      return d.isNotEmpty ? cap1(d) : 'Ran ${_clip(_input(m, 'command'), 48)}';
    case 'BashOutput':
      return 'Checked on a running command';
    case 'Grep':
      return 'Searched the code for “${_clip(_input(m, 'pattern'), 36)}”';
    case 'Glob':
      return 'Looked for files matching ${_clip(_input(m, 'pattern'), 40)}';
    case 'Agent':
    case 'Task':
      final d = _input(m, 'description');
      final who = _input(m, 'subagent_type');
      return 'Asked ${who.isNotEmpty ? who : 'a helper'}${d.isNotEmpty ? ': ${_clip(d, 48)}' : ''}';
    case 'WebFetch':
      final u = Uri.tryParse(_input(m, 'url'));
      return 'Read ${u == null || u.host.isEmpty ? _clip(_input(m, 'url'), 48) : _clip('${u.host}${u.path}', 48)}';
    case 'WebSearch':
      return 'Searched the web for “${_clip(_input(m, 'query'), 40)}”';
    case 'TodoWrite':
      return 'Updated the plan';
    case 'Skill':
      return 'Used the ${_input(m, 'skill')} skill';
    case 'ToolSearch':
      return 'Looked up a tool';
  }
  if (n.startsWith('mcp__')) {
    final parts = n.split('__');
    final server = parts.length > 1 ? parts[1].replaceAll('claude_ai_', '').replaceAll('_', ' ') : '';
    final tool = parts.length > 2 ? parts.sublist(2).join(' ').replaceAll('_', ' ') : n;
    return 'Used $server: $tool';
  }
  return 'Used $n';
}

/// User-role rows the harness writes (background task done, slash-command output): part of the
/// assistant's turn, not something the person said.
bool isHarnessNote(Msg m) {
  if (!m.isUser) return false;
  final s = m.text.trimLeft();
  return s.startsWith('<task-notification>') || s.startsWith('<local-command-') || s.startsWith('<command-name>') || s.startsWith('<system-reminder>');
}

/// One plain line for a harness note: the task summary when there is one.
String harnessNoteText(Msg m) {
  String tag(String t) => RegExp('<$t>([\\s\\S]*?)</$t>').firstMatch(m.text)?.group(1)?.trim() ?? '';
  final summary = tag('summary');
  if (summary.isNotEmpty) return summary;
  final cmd = tag('command-name');
  if (cmd.isNotEmpty) return 'Ran $cmd';
  return 'Background work finished';
}

String cap1(String s) => s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';

IconData stepIcon(String name) => switch (name) {
      'Read' || 'WebFetch' => Icons.visibility_outlined,
      'Edit' || 'MultiEdit' || 'NotebookEdit' => Icons.edit_outlined,
      'Write' => Icons.note_add_outlined,
      'Bash' || 'BashOutput' => Icons.terminal_rounded,
      'Grep' || 'Glob' || 'ToolSearch' => Icons.search_rounded,
      'WebSearch' => Icons.public_rounded,
      'Agent' || 'Task' => Icons.smart_toy_outlined,
      'TodoWrite' => Icons.checklist_rounded,
      'Skill' => Icons.auto_awesome_outlined,
      _ => Icons.extension_outlined,
    };

String _n(int n, String one, String many) => '$n ${n == 1 ? one : many}';

/// "read 14 files · ran 3 commands · edited 2 files": the biggest three kinds of work.
String workCounts(List<Msg> tools) {
  final read = <String>{}, edited = <String>{}, wrote = <String>{};
  var cmds = 0, searches = 0, helpers = 0, web = 0, other = 0;
  for (final m in tools) {
    switch (m.name) {
      case 'Read':
        read.add(_input(m, 'file_path'));
      case 'Edit' || 'MultiEdit' || 'NotebookEdit':
        edited.add(_input(m, 'file_path') + _input(m, 'notebook_path'));
      case 'Write':
        wrote.add(_input(m, 'file_path'));
      case 'Bash':
        cmds++;
      case 'Grep' || 'Glob':
        searches++;
      case 'Agent' || 'Task':
        helpers++;
      case 'WebFetch' || 'WebSearch':
        web++;
      case 'TodoWrite' || 'BashOutput' || 'ToolSearch':
        break;
      default:
        other++;
    }
  }
  final parts = <(int, String)>[
    if (read.isNotEmpty) (read.length, 'read ${_n(read.length, 'file', 'files')}'),
    if (edited.isNotEmpty) (edited.length, 'edited ${_n(edited.length, 'file', 'files')}'),
    if (wrote.isNotEmpty) (wrote.length, 'wrote ${_n(wrote.length, 'file', 'files')}'),
    if (cmds > 0) (cmds, 'ran ${_n(cmds, 'command', 'commands')}'),
    if (searches > 0) (searches, 'searched ${searches == 1 ? 'once' : '$searches times'}'),
    if (helpers > 0) (helpers, _n(helpers, 'helper', 'helpers')),
    if (web > 0) (web, _n(web, 'web lookup', 'web lookups')),
    if (other > 0) (other, 'used ${_n(other, 'tool', 'tools')}'),
  ];
  final order = [...parts]..sort((a, b) => b.$1.compareTo(a.$1));
  final keep = order.take(3).toSet();
  return [for (final p in parts) if (keep.contains(p)) p.$2].join(' · ');
}

/// The collapsed line: "Worked for 6m 12s · read 14 files · ran 3 commands".
String workLabel(List<Msg> tools, {Duration? took, bool live = false}) {
  final counts = workCounts(tools);
  if (live) return tools.isEmpty ? 'Working' : 'Working · ${_n(tools.length, 'step', 'steps')} so far';
  final head = took == null || took.inSeconds < 1 ? 'Worked' : 'Worked for ${fmtDuration(took)}';
  return counts.isEmpty ? head : '$head · $counts';
}

/// Files a turn created or changed, newest last. Value: true = new file.
Map<String, bool> touchedFiles(Iterable<Msg> tools) {
  final out = <String, bool>{};
  for (final m in tools) {
    final p = m.name == 'NotebookEdit' ? _input(m, 'notebook_path') : _input(m, 'file_path');
    if (p.isEmpty) continue;
    if (m.name == 'Write') {
      out.putIfAbsent(p, () => true);
    } else if (m.name == 'Edit' || m.name == 'MultiEdit' || m.name == 'NotebookEdit') {
      out.putIfAbsent(p, () => false);
    }
  }
  return out;
}

/// One assistant turn. [msgs] are every row after a user message up to the next one.
class AssistantTurn extends StatelessWidget {
  const AssistantTurn({super.key, required this.msgs, required this.name, this.started, this.live = false, this.liveSince = 0, this.showTech = false, this.onChoice, this.onOpenFile, this.footer = ''});
  final List<Msg> msgs;
  /// Who answered: the agent or assistant name.
  final String name;
  final DateTime? started;
  final bool live;
  final int liveSince;
  final bool showTech;
  final ValueChanged<String>? onChoice;
  final ValueChanged<String>? onOpenFile;
  final String footer;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    if (showTech) {
      final last = msgs.lastIndexWhere((m) => m.isAssistant);
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (var i = 0; i < msgs.length; i++) MsgRow(key: ObjectKey(msgs[i]), msg: msgs[i], onChoice: i == last ? onChoice : null),
        if (footer.isNotEmpty) StatusLine(footer),
      ]);
    }
    final main = msgs.where((m) => !m.side).toList();
    final tools = msgs.where((m) => m.isTool && !m.side).toList();
    final texts = main.where((m) => m.isAssistant || m.kind == 'choices' || isHarnessNote(m)).toList();
    DateTime? end;
    for (final m in msgs) {
      if (m.ts != null && (end == null || m.ts!.isAfter(end))) end = m.ts;
    }
    final took = started != null && end != null ? end.difference(started!) : null;
    final files = touchedFiles(tools);
    final lastText = texts.lastIndexWhere((m) => m.isAssistant);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Ava(name: name, size: 22, gradient: true),
          const SizedBox(width: 8),
          Text(name, style: TextStyle(color: t.muted, fontSize: 13, fontWeight: FontWeight.w600)),
        ]),
        const SizedBox(height: 6),
        if (tools.isNotEmpty || live) WorkBlock(tools: tools, thinking: msgs.where((m) => m.isThinking).toList(), took: took, live: live, liveSince: liveSince),
        for (var i = 0; i < texts.length; i++)
          isHarnessNote(texts[i])
              ? Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(children: [
                    Icon(Icons.task_alt_rounded, size: 15, color: t.ok),
                    const SizedBox(width: 8),
                    Expanded(child: Text(harnessNoteText(texts[i]), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 13))),
                  ]),
                )
              : texts[i].kind == 'choices'
              ? ChoiceChips(options: texts[i].options, onChoice: onChoice)
              : AssistantText(key: ObjectKey(texts[i]), msg: texts[i], onChoice: i == lastText ? onChoice : null, padding: const EdgeInsets.only(top: 4, bottom: 4)),
        for (final f in files.entries.take(4)) FileCard(path: f.key, isNew: f.value, onTap: onOpenFile == null ? null : () => onOpenFile!(f.key)),
        if (files.length > 4) Padding(padding: const EdgeInsets.only(top: 2), child: Text('+${files.length - 4} more in Files & progress', style: TextStyle(color: t.faint, fontSize: 12))),
        if (footer.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(footer, style: TextStyle(color: t.faint, fontSize: 11.5))),
      ]),
    );
  }
}

/// The collapsible work line. Live: spinner + ticking time; done: green check.
class WorkBlock extends StatefulWidget {
  const WorkBlock({super.key, required this.tools, this.thinking = const [], this.took, this.live = false, this.liveSince = 0});
  final List<Msg> tools, thinking;
  final Duration? took;
  final bool live;
  final int liveSince;
  @override
  State<WorkBlock> createState() => _WorkBlockState();
}

class _WorkBlockState extends State<WorkBlock> {
  bool _open = false;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final label = workLabel(widget.tools, took: widget.took, live: widget.live);
    final errors = widget.tools.where((m) => m.result?.isError == true).length;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(color: t.raised.withValues(alpha: .7), borderRadius: BorderRadius.circular(12), border: Border.all(color: t.border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: widget.tools.isEmpty ? null : () => setState(() => _open = !_open),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 42),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(children: [
                widget.live ? const Spin() : Icon(Icons.check_rounded, size: 16, color: t.ok),
                const SizedBox(width: 9),
                Expanded(child: Text(label, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 13.5))),
                if (errors > 0) ...[const SizedBox(width: 6), Tag('$errors failed', kind: 'err')],
                if (widget.live && widget.liveSince > 0) ...[const SizedBox(width: 8), Elapsed(widget.liveSince)],
                if (widget.tools.isNotEmpty) ...[const SizedBox(width: 4), Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, size: 18, color: t.faint)],
              ]),
            ),
          ),
        ),
        if (_open)
          Container(
            decoration: BoxDecoration(border: Border(top: BorderSide(color: t.border))),
            padding: const EdgeInsets.fromLTRB(6, 6, 6, 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [for (final m in widget.tools) _Step(m)]),
          ),
      ]),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step(this.m);
  final Msg m;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final r = m.result;
    final color = r == null ? t.accent : (r.isError ? t.err : t.ok);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
      child: Row(children: [
        Icon(r == null ? stepIcon(m.name) : (r.isError ? Icons.close_rounded : stepIcon(m.name)), size: 15, color: color),
        const SizedBox(width: 9),
        Expanded(child: Text(stepSentence(m), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: r?.isError == true ? t.err : t.muted, fontSize: 13))),
      ]),
    );
  }
}

/// A file the turn created or changed. Tap opens the preview.
class FileCard extends StatelessWidget {
  const FileCard({super.key, required this.path, this.isNew = true, this.onTap});
  final String path;
  final bool isNew;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final name = _base(path);
    final parts = path.split('/').where((x) => x.isNotEmpty).toList();
    final folder = parts.length > 1 ? parts[parts.length - 2] : '';
    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 2),
      child: Material(
        color: t.raised,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: t.border)),
            child: Row(children: [
              FileBadge(extOf(name)),
              const SizedBox(width: 11),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14, fontWeight: FontWeight.w600)),
                  Text('${isNew ? 'New file' : 'Edited'}${folder.isEmpty ? '' : ' · $folder'}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 12)),
                ]),
              ),
              Icon(Icons.open_in_new_rounded, size: 17, color: t.faint),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Background work inside a running chat: spinner, what it is doing, live time, helper chips and
/// the promise that leaving is fine.
class JobCard extends StatelessWidget {
  const JobCard({super.key, required this.title, required this.since, required this.jobs});
  final String title;
  final int since;
  final List<Job> jobs;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final helpers = jobs.where((j) => j.kind == 'subagent').toList();
    final others = jobs.where((j) => j.kind != 'subagent').toList();
    return Container(
      margin: const EdgeInsets.fromLTRB(14, 6, 14, 10),
      padding: const EdgeInsets.fromLTRB(13, 11, 13, 11),
      decoration: BoxDecoration(color: t.raised, borderRadius: BorderRadius.circular(12), border: Border.all(color: t.accent.withValues(alpha: .35))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Spin(),
          const SizedBox(width: 9),
          Expanded(child: Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14, fontWeight: FontWeight.w600))),
          const SizedBox(width: 8),
          if (since > 0) Elapsed(since),
        ]),
        const SizedBox(height: 8),
        const Padding(padding: EdgeInsets.only(left: 23), child: IndeterminateBar()),
        for (final j in others) Padding(padding: const EdgeInsets.only(left: 23), child: JobRow(j)),
        if (helpers.isNotEmpty) ...[
          const SizedBox(height: 8),
          Padding(padding: const EdgeInsets.only(left: 23), child: Wrap(spacing: 6, runSpacing: 6, children: [for (final h in helpers) JobChip(h)])),
        ],
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.only(left: 23),
          child: Row(children: [
            Icon(Icons.notifications_none_rounded, size: 14, color: t.faint),
            const SizedBox(width: 6),
            Expanded(child: Text("You can leave, I'll notify you when it's done", style: TextStyle(color: t.faint, fontSize: 12))),
          ]),
        ),
      ]),
    );
  }
}
