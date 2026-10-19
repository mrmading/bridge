/// Small shared pieces: status dots and pills, section headers, empty states, relative times.
library;

import 'package:flutter/material.dart';

import '../core/theme.dart';

class StatusDot extends StatelessWidget {
  const StatusDot(this.color, {super.key, this.size = 8, this.glow = false});
  final Color color;
  final double size;
  final bool glow;
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle, boxShadow: glow ? [BoxShadow(color: color.withValues(alpha: .6), blurRadius: 8)] : null),
      );
}

/// `kind` ∈ running · waiting · idle · done · error · neutral
class StatusPill extends StatelessWidget {
  const StatusPill(this.label, {super.key, this.kind = 'neutral'});
  final String label, kind;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final (fg, bg) = switch (kind) {
      'running' => (t.ok, t.okSoft),
      'waiting' => (t.err, t.errSoft),
      'done' => (t.accent, t.accentSoft),
      'error' => (t.err, t.errSoft),
      'warn' => (t.warn, t.warnSoft),
      _ => (t.muted, t.active),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(20)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (kind == 'running' || kind == 'waiting') ...[StatusDot(fg, size: 6, glow: kind == 'running'), const SizedBox(width: 6)],
        Text(label, style: TextStyle(color: fg, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: .3)),
      ]),
    );
  }
}

class SectionHeader extends StatelessWidget {
  const SectionHeader(this.title, {super.key, this.trailing, this.count});
  final String title;
  final Widget? trailing;
  final int? count;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 8),
      child: Row(children: [
        Text(title.toUpperCase(), style: TextStyle(color: t.faint, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.1)),
        if (count != null) ...[
          const SizedBox(width: 8),
          Container(padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1), decoration: BoxDecoration(color: t.active, borderRadius: BorderRadius.circular(10)), child: Text('$count', style: TextStyle(color: t.muted, fontSize: 11, fontWeight: FontWeight.w700))),
        ],
        const Spacer(),
        if (trailing != null) trailing!,
      ]),
    );
  }
}

class Card2 extends StatelessWidget {
  const Card2({super.key, required this.child, this.onTap, this.padding = const EdgeInsets.all(14), this.margin = const EdgeInsets.fromLTRB(16, 0, 16, 10), this.accent = false});
  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsets padding, margin;
  final bool accent;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: margin,
      child: Material(
        color: t.raised,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(14),
          child: Container(
            padding: padding,
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), border: Border.all(color: accent ? t.accent.withValues(alpha: .5) : t.border)),
            child: child,
          ),
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.body, this.action});
  final IconData icon;
  final String title;
  final String? body;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 36, color: t.faint),
          const SizedBox(height: 12),
          Text(title, style: TextStyle(color: t.fg, fontSize: 17, fontWeight: FontWeight.w600), textAlign: TextAlign.center),
          if (body != null) ...[const SizedBox(height: 6), Text(body!, style: TextStyle(color: t.muted, fontSize: 14), textAlign: TextAlign.center)],
          if (action != null) ...[const SizedBox(height: 16), action!],
        ]),
      ),
    );
  }
}

String relTime(int ms, {int? now}) {
  if (ms <= 0) return '';
  final n = now ?? DateTime.now().millisecondsSinceEpoch;
  final d = Duration(milliseconds: n > ms ? n - ms : 0);
  if (d.inSeconds < 45) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes}m ago';
  if (d.inHours < 24) return '${d.inHours}h ago';
  if (d.inDays < 7) return '${d.inDays}d ago';
  final dt = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${dt.day}/${dt.month}';
}

String elapsed(int sinceMs, {int? now}) {
  final n = now ?? DateTime.now().millisecondsSinceEpoch;
  final d = Duration(milliseconds: n > sinceMs ? n - sinceMs : 0);
  if (d.inHours > 0) return '${d.inHours}h ${d.inMinutes % 60}m';
  if (d.inMinutes > 0) return '${d.inMinutes}m ${d.inSeconds % 60}s';
  return '${d.inSeconds}s';
}

/// Day bucket label for grouping lists: Today · Yesterday · Monday · 3 Oct
String dayLabel(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(d.year, d.month, d.day);
  final diff = today.difference(day).inDays;
  if (diff == 0) return 'Today';
  if (diff == 1) return 'Yesterday';
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (diff < 7) return names[d.weekday - 1];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${d.day} ${months[d.month - 1]}';
}

void toast(BuildContext context, String msg) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(msg), duration: const Duration(seconds: 3)));
}
