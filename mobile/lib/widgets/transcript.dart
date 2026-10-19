/// Transcript rows: user bubbles, assistant markdown, collapsed thinking, one-line tool cards,
/// status lines and ```choices chips. Pure rendering; the session screen owns the data.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api.dart';
import '../core/models.dart';
import '../core/theme.dart';

const _monoFamily = 'Menlo';
const _monoFallback = ['SF Mono', 'Roboto Mono', 'monospace', 'Courier'];

TextStyle mono(double size, Color color, {FontWeight? weight, double height = 1.4}) =>
    TextStyle(fontFamily: _monoFamily, fontFamilyFallback: _monoFallback, fontSize: size, color: color, fontWeight: weight, height: height);

/// One row of the stream. [onChoice] receives a tapped ```choices option.
class MsgRow extends StatelessWidget {
  const MsgRow({super.key, required this.msg, this.onChoice, this.queued = false});
  final Msg msg;
  final ValueChanged<String>? onChoice;
  final bool queued;

  @override
  Widget build(BuildContext context) {
    final m = msg;
    final Widget row = switch (m.kind) {
      'user' => UserBubble(text: m.text, queued: queued),
      'assistant' || 'agent_text' => AssistantText(msg: m, onChoice: onChoice),
      'thinking' => ThinkingRow(msg: m),
      'tool' => ToolCard(msg: m),
      'choices' => ChoiceChips(options: m.options, onChoice: onChoice),
      _ => StatusLine(m.text),
    };
    final side = m.side || m.kind == 'agent_text';
    if (!side) return row;
    final t = context.t;
    return Container(
      margin: const EdgeInsets.only(left: 12),
      padding: const EdgeInsets.only(left: 8),
      decoration: BoxDecoration(border: Border(left: BorderSide(color: t.warn.withValues(alpha: .55), width: 2))),
      child: row,
    );
  }
}

class UserBubble extends StatelessWidget {
  const UserBubble({super.key, required this.text, this.queued = false});
  final String text;
  final bool queued;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.fromLTRB(48, 10, 14, 4),
      child: Align(
        alignment: Alignment.centerRight,
        child: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: queued ? t.sunken : t.active,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: queued ? t.borderStrong : t.border),
            ),
            child: SelectableText(stripBridgeBlock(text).trim(), style: TextStyle(color: queued ? t.muted : t.fg, fontSize: 16, height: 1.4)),
          ),
          if (queued) Padding(padding: const EdgeInsets.only(top: 4, right: 4), child: Text('queued', style: mono(11, t.faint))),
        ]),
      ),
    );
  }
}

MarkdownStyleSheet bridgeMarkdown(BuildContext context) {
  final t = context.t;
  final body = TextStyle(color: t.fg, fontSize: 16, height: 1.45);
  return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
    p: body,
    listBullet: body,
    a: TextStyle(color: t.accent, decoration: TextDecoration.underline, decorationColor: t.accent.withValues(alpha: .5)),
    strong: const TextStyle(fontWeight: FontWeight.w700),
    em: const TextStyle(fontStyle: FontStyle.italic),
    h1: TextStyle(color: t.fg, fontSize: 21, fontWeight: FontWeight.w700, height: 1.3),
    h2: TextStyle(color: t.fg, fontSize: 19, fontWeight: FontWeight.w700, height: 1.3),
    h3: TextStyle(color: t.fg, fontSize: 17, fontWeight: FontWeight.w700, height: 1.3),
    h4: TextStyle(color: t.fg, fontSize: 16, fontWeight: FontWeight.w700),
    h5: TextStyle(color: t.muted, fontSize: 15, fontWeight: FontWeight.w700),
    h6: TextStyle(color: t.muted, fontSize: 14, fontWeight: FontWeight.w700),
    code: mono(13, t.accent2).copyWith(backgroundColor: t.code),
    codeblockPadding: const EdgeInsets.all(12),
    codeblockDecoration: BoxDecoration(color: t.code, borderRadius: BorderRadius.circular(10), border: Border.all(color: t.border)),
    blockquote: TextStyle(color: t.muted, fontSize: 15, height: 1.45),
    blockquoteDecoration: BoxDecoration(border: Border(left: BorderSide(color: t.borderStrong, width: 3))),
    blockquotePadding: const EdgeInsets.only(left: 12, top: 2, bottom: 2),
    tableHead: TextStyle(color: t.fg, fontSize: 14, fontWeight: FontWeight.w700),
    tableBody: TextStyle(color: t.fg, fontSize: 14),
    tableBorder: TableBorder.all(color: t.border),
    tableCellsPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
    // Intrinsic widths make flutter_markdown wrap the table in a horizontal scroller.
    tableColumnWidth: const IntrinsicColumnWidth(),
    horizontalRuleDecoration: BoxDecoration(border: Border(top: BorderSide(color: t.border))),
    checkbox: TextStyle(color: t.muted),
  );
}

Future<void> openLink(String? href) async {
  if (href == null || href.isEmpty) return;
  final u = Uri.tryParse(href);
  if (u == null) return;
  try {
    await launchUrl(u, mode: LaunchMode.externalApplication);
  } catch (_) {}
}

class AssistantText extends StatelessWidget {
  const AssistantText({super.key, required this.msg, this.onChoice});
  final Msg msg;
  final ValueChanged<String>? onChoice;
  @override
  Widget build(BuildContext context) {
    // While streaming, a half-written ```choices block is just text; split once it is complete.
    final split = msg.live ? (text: msg.text, options: const <String>[]) : splitChoices(msg.text);
    final text = split.text.trim();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (text.isNotEmpty)
          MarkdownBody(
            data: text,
            selectable: true,
            styleSheet: bridgeMarkdown(context),
            onTapLink: (_, href, _) => openLink(href),
          ),
        if (split.options.isNotEmpty) ChoiceChips(options: split.options, onChoice: onChoice),
      ]),
    );
  }
}

class ChoiceChips extends StatelessWidget {
  const ChoiceChips({super.key, required this.options, this.onChoice});
  final List<String> options;
  final ValueChanged<String>? onChoice;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Wrap(spacing: 8, runSpacing: 8, children: [
        for (final o in options)
          ActionChip(
            label: Text(o, style: TextStyle(color: t.accent, fontSize: 14, fontWeight: FontWeight.w600)),
            backgroundColor: t.accentSoft,
            materialTapTargetSize: MaterialTapTargetSize.padded,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: BorderSide(color: t.accent.withValues(alpha: .35))),
            onPressed: onChoice == null ? null : () => onChoice!(o),
          ),
      ]),
    );
  }
}

class ThinkingRow extends StatefulWidget {
  const ThinkingRow({super.key, required this.msg});
  final Msg msg;
  @override
  State<ThinkingRow> createState() => _ThinkingRowState();
}

class _ThinkingRowState extends State<ThinkingRow> {
  bool _open = false;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final m = widget.msg;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => setState(() => _open = !_open),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(children: [
                Icon(Icons.psychology_alt_outlined, size: 17, color: t.think),
                const SizedBox(width: 8),
                Text(m.live ? 'Thinking…' : 'Thought', style: TextStyle(color: t.think, fontSize: 14, fontWeight: FontWeight.w600)),
                const SizedBox(width: 4),
                Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, size: 18, color: t.think),
              ]),
            ),
          ),
        ),
        if (_open)
          Container(
            margin: const EdgeInsets.fromLTRB(8, 0, 8, 6),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: t.thinkSoft, borderRadius: BorderRadius.circular(10)),
            child: SelectableText(m.text.trim(), style: TextStyle(color: t.think, fontSize: 14, height: 1.45)),
          ),
      ]),
    );
  }
}

IconData toolIcon(String name) => switch (name) {
      'Read' => Icons.description_outlined,
      'Edit' || 'MultiEdit' || 'NotebookEdit' => Icons.edit_outlined,
      'Write' => Icons.note_add_outlined,
      'Bash' || 'BashOutput' => Icons.terminal_rounded,
      'Grep' => Icons.manage_search_rounded,
      'Glob' => Icons.folder_open_outlined,
      'Agent' || 'Task' => Icons.smart_toy_outlined,
      'WebFetch' => Icons.public_rounded,
      'WebSearch' => Icons.travel_explore_rounded,
      'TodoWrite' => Icons.checklist_rounded,
      'Skill' => Icons.auto_awesome_outlined,
      _ => name.startsWith('mcp__') ? Icons.extension_outlined : Icons.build_outlined,
    };

String _base(String p) {
  final parts = p.split('/').where((x) => x.isNotEmpty).toList();
  return parts.isEmpty ? p : parts.last;
}

String _clip(String s, int n) {
  final one = s.replaceAll(RegExp(r'\s+'), ' ').trim();
  return one.length <= n ? one : '${one.substring(0, n)}…';
}

/// What the tool touched, in a few words.
String toolSummary(String name, Map<String, dynamic>? input) {
  final i = input ?? const {};
  String s(String k) => i[k] == null ? '' : i[k].toString();
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return _base(s('file_path'));
    case 'NotebookEdit':
      return _base(s('notebook_path'));
    case 'Bash':
      return _clip(s('command'), 60);
    case 'Grep':
      final p = s('path');
      return _clip(s('pattern'), 48) + (p.isNotEmpty ? ' in ${_base(p)}' : '');
    case 'Glob':
      return _clip(s('pattern'), 60);
    case 'Agent':
    case 'Task':
      return _clip(s('description').isNotEmpty ? s('description') : s('subagent_type'), 60);
    case 'WebFetch':
      final u = Uri.tryParse(s('url'));
      return u == null ? _clip(s('url'), 60) : _clip('${u.host}${u.path}', 60);
    case 'WebSearch':
      return _clip(s('query'), 60);
    case 'Skill':
      return s('skill');
  }
  for (final v in i.values) {
    if (v is String && v.trim().isNotEmpty) return _clip(v, 60);
  }
  return '';
}

String _toolLabel(String name) {
  if (!name.startsWith('mcp__')) return name;
  final parts = name.split('__');
  return parts.length >= 3 ? parts.sublist(2).join('__') : name;
}

class ToolCard extends StatefulWidget {
  const ToolCard({super.key, required this.msg});
  final Msg msg;
  @override
  State<ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<ToolCard> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final m = widget.msg;
    final r = m.result;
    final (badge, fg, bg) = r == null ? ('running', t.warn, t.warnSoft) : r.isError ? ('err', t.err, t.errSoft) : ('ok', t.ok, t.okSoft);
    final summary = toolSummary(m.name, m.input);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 3, 12, 3),
      child: Material(
        color: t.raised,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => setState(() => _open = !_open),
          child: Container(
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: t.border)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: Row(children: [
                    Icon(toolIcon(m.name), size: 17, color: t.muted),
                    const SizedBox(width: 9),
                    Text(_toolLabel(m.name), style: TextStyle(color: t.fg, fontSize: 14, fontWeight: FontWeight.w600)),
                    const SizedBox(width: 8),
                    Expanded(child: Text(summary, maxLines: 1, overflow: TextOverflow.ellipsis, style: mono(12.5, t.muted))),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(20)),
                      child: Text(badge, style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w700)),
                    ),
                  ]),
                ),
              ),
              if (_open) _details(context, m),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _details(BuildContext context, Msg m) {
    final t = context.t;
    String input;
    try {
      input = const JsonEncoder.withIndent('  ').convert(m.input ?? const {});
    } catch (_) {
      input = '${m.input}';
    }
    var result = m.result?.content ?? '';
    final lines = result.split('\n');
    if (lines.length > 300) result = '${lines.take(300).join('\n')}\n… ${lines.length - 300} more lines';
    Widget block(String label, String text, Color color) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(label, style: TextStyle(color: t.faint, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: .8))),
          Container(
            width: double.infinity,
            constraints: const BoxConstraints(maxHeight: 320),
            decoration: BoxDecoration(color: t.code, borderRadius: BorderRadius.circular(8), border: Border.all(color: t.border)),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(10),
              child: SelectableText(text, style: mono(12, color)),
            ),
          ),
        ]);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        block('INPUT', input, t.muted),
        if (m.result != null) ...[
          const SizedBox(height: 10),
          block(m.result!.isError ? 'ERROR' : 'RESULT', result.isEmpty ? '(empty)' : result, m.result!.isError ? t.err : t.fg),
        ],
      ]),
    );
  }
}

/// Hook / system / progress line: faint mono 12.
class StatusLine extends StatelessWidget {
  const StatusLine(this.text, {super.key, this.spinner = false});
  final String text;
  final bool spinner;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 6, 18, 6),
      child: Row(children: [
        if (spinner) ...[SizedBox(width: 11, height: 11, child: CircularProgressIndicator(strokeWidth: 1.6, color: t.faint)), const SizedBox(width: 8)],
        Expanded(child: Text(text, style: mono(12, t.faint))),
      ]),
    );
  }
}
