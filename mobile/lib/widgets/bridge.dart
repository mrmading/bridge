/// Bridge's visual vocabulary for the friendly UI: the glowing "B", avatars, pulsing dots, live
/// elapsed timers, tags, file-type badges, project icons, the accent bloom and job rows.
library;

import 'package:flutter/material.dart';

import '../core/clock.dart';
import '../core/models.dart';
import '../core/theme.dart';

const _brandFont = 'Orbitron';

/// The black tile with the glowing Orbitron "B".
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 30});
  final double size;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: Colors.black,
        borderRadius: BorderRadius.circular(size * .3),
        border: Border.all(color: t.accent.withValues(alpha: .45)),
        boxShadow: [BoxShadow(color: t.accent.withValues(alpha: .26), blurRadius: 18)],
      ),
      child: Text('B',
          style: TextStyle(
            fontFamily: _brandFont,
            fontWeight: FontWeight.w900,
            fontSize: size * .47,
            color: const Color(0xFFCFE9FF),
            shadows: [Shadow(color: t.accent.withValues(alpha: .85), blurRadius: 10), Shadow(color: t.accent.withValues(alpha: .45), blurRadius: 22)],
          )),
    );
  }
}

class Wordmark extends StatelessWidget {
  const Wordmark({super.key});
  @override
  Widget build(BuildContext context) => Text('BRIDGE', style: TextStyle(fontFamily: _brandFont, fontWeight: FontWeight.w700, fontSize: 14, letterSpacing: 1.1, color: context.t.fg));
}

const _palette = [
  Color(0xFF7A4FD0),
  Color(0xFF1668C9),
  Color(0xFF137A4B),
  Color(0xFFC0392B),
  Color(0xFF9A5B00),
  Color(0xFF3F9AE0),
  Color(0xFFD6336C),
  Color(0xFF0B7285),
  Color(0xFFE8590C),
  Color(0xFF5F3DC4),
];

/// Stable colour for a name (projects, agents).
Color colorFor(String name) {
  var h = 0;
  for (final c in name.codeUnits) {
    h = (h * 31 + c) & 0x7fffffff;
  }
  return _palette[h % _palette.length];
}

Color? parseHex(String s) {
  final m = RegExp(r'^#?([0-9a-fA-F]{6})$').firstMatch(s.trim());
  return m == null ? null : Color(int.parse('FF${m.group(1)}', radix: 16));
}

String initials(String name) {
  final words = name.replaceAll(RegExp(r'[-_]'), ' ').split(' ').where((w) => w.isNotEmpty).toList();
  if (words.isEmpty) return '?';
  if (words.length == 1) return words[0].length >= 2 ? '${words[0][0].toUpperCase()}${words[0][1].toLowerCase()}' : words[0].toUpperCase();
  return '${words[0][0]}${words[1][0]}'.toUpperCase();
}

/// Rounded-square avatar with initials: agents, projects, the assistant.
class Ava extends StatelessWidget {
  const Ava({super.key, required this.name, this.size = 22, this.color, this.gradient = false, this.letter});
  final String name;
  final double size;
  final Color? color;
  /// The assistant's blue-to-violet gradient.
  final bool gradient;
  /// Show a single letter instead of initials (projects).
  final String? letter;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * .3),
        color: gradient ? null : (color ?? colorFor(name)),
        gradient: gradient ? LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [t.accent, t.think]) : null,
      ),
      child: Text(letter ?? initials(name), style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: size * .4, height: 1)),
    );
  }
}

/// Project icon: its first letter on its colour.
class ProjectIcon extends StatelessWidget {
  const ProjectIcon(this.name, {super.key, this.size = 38});
  final String name;
  final double size;
  @override
  Widget build(BuildContext context) => Ava(name: name, size: size, letter: name.isEmpty ? '?' : name[0].toUpperCase());
}

/// A dot that pulses outward: accent for running, warn for waiting.
class PulseDot extends StatefulWidget {
  const PulseDot({super.key, required this.color, this.size = 7});
  final Color color;
  final double size;
  @override
  State<PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<PulseDot> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))..repeat();
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: widget.size + 8,
      child: AnimatedBuilder(
        animation: _c,
        builder: (_, _) {
          final v = (_c.value / .7).clamp(0.0, 1.0);
          return Center(
            child: Container(
              width: widget.size,
              height: widget.size,
              decoration: BoxDecoration(
                color: widget.color,
                shape: BoxShape.circle,
                boxShadow: [BoxShadow(color: widget.color.withValues(alpha: .55 * (1 - v)), spreadRadius: 4 * v)],
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Live "6m 12s" that ticks every second off the shared [Clock].
class Elapsed extends StatelessWidget {
  const Elapsed(this.since, {super.key, this.style});
  final int since;
  final TextStyle? style;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ListenableBuilder(
      listenable: Clock.instance,
      builder: (_, _) => Text(fmtElapsed(since), style: style ?? TextStyle(color: t.muted, fontSize: 12, fontFeatures: const [FontFeature.tabularFigures()])),
    );
  }
}

/// Small rounded label. kind ∈ neutral · ok · warn · acc · think · err
class Tag extends StatelessWidget {
  const Tag(this.label, {super.key, this.kind = 'neutral'});
  final String label, kind;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final (fg, bg) = switch (kind) {
      'ok' => (t.ok, t.okSoft),
      'warn' => (t.warn, t.warnSoft),
      'acc' => (t.accent, t.accentSoft),
      'think' => (t.think, t.thinkSoft),
      'err' => (t.err, t.errSoft),
      _ => (t.muted, t.active),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(20)),
      child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w700)),
    );
  }
}

Color extColor(String ext) => switch (ext.toUpperCase()) {
      'MD' || 'TXT' => const Color(0xFF495057),
      'HTML' || 'HTM' => const Color(0xFFE8590C),
      'PDF' => const Color(0xFFC02828),
      'MP4' || 'MOV' || 'WEBM' || 'MP3' || 'WAV' => const Color(0xFFD6336C),
      'XLS' || 'XLSX' || 'CSV' => const Color(0xFF137A4B),
      'PNG' || 'JPG' || 'JPEG' || 'GIF' || 'WEBP' || 'SVG' => const Color(0xFF3F9AE0),
      'TS' || 'TSX' || 'JS' || 'DART' || 'PY' || 'RS' || 'GO' || 'SWIFT' => const Color(0xFF1668C9),
      'JSON' || 'YAML' || 'YML' || 'TOML' => const Color(0xFF9A5B00),
      _ => const Color(0xFF5B6270),
    };

String extOf(String name) {
  final i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.substring(i + 1).toUpperCase() : '';
}

/// Coloured square with the file extension.
class FileBadge extends StatelessWidget {
  const FileBadge(this.ext, {super.key, this.size = 36});
  final String ext;
  final double size;
  @override
  Widget build(BuildContext context) {
    final e = ext.isEmpty ? 'FILE' : (ext.length > 4 ? ext.substring(0, 4) : ext);
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: extColor(ext), borderRadius: BorderRadius.circular(size * .25)),
      child: Text(e, style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: size * .26, fontFamily: 'Menlo', fontFamilyFallback: const ['monospace'])),
    );
  }
}

/// The Bridge light: a soft accent bloom from the top of the screen.
class Bloom extends StatelessWidget {
  const Bloom({super.key, this.height = 380});
  final double height;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return IgnorePointer(
      child: SizedBox(
        height: height,
        width: double.infinity,
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(
              center: const Alignment(.15, -1.25),
              radius: 1.1,
              colors: [t.accent.withValues(alpha: dark ? .22 : .14), t.accent2.withValues(alpha: dark ? .07 : .05), t.accent.withValues(alpha: 0)],
              stops: const [0, .45, 1],
            ),
          ),
        ),
      ),
    );
  }
}

/// A small accent spinner (14 px), like the prototype's job spinner.
class Spin extends StatelessWidget {
  const Spin({super.key, this.size = 14});
  final double size;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return SizedBox.square(dimension: size, child: CircularProgressIndicator(strokeWidth: 2, color: t.accent, backgroundColor: t.accent.withValues(alpha: .2)));
  }
}

String jobKindLabel(String kind) => switch (kind) {
      'subagent' => 'Helper',
      'background' => 'Background',
      'workflow' => 'Workflow',
      'tool' => 'Tool',
      _ => kind,
    };

IconData jobIcon(String kind) => switch (kind) {
      'subagent' => Icons.smart_toy_outlined,
      'background' => Icons.terminal_rounded,
      'workflow' => Icons.account_tree_outlined,
      _ => Icons.build_outlined,
    };

/// One compact chip per job: icon/avatar + title + live elapsed.
class JobChip extends StatelessWidget {
  const JobChip(this.job, {super.key});
  final Job job;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Container(
      padding: const EdgeInsets.fromLTRB(4, 3, 9, 3),
      decoration: BoxDecoration(color: t.sunken, borderRadius: BorderRadius.circular(14), border: Border.all(color: t.border)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        job.agent.isNotEmpty ? Ava(name: job.agent, size: 18) : Container(width: 18, height: 18, decoration: BoxDecoration(color: t.active, borderRadius: BorderRadius.circular(6)), child: Icon(jobIcon(job.kind), size: 12, color: t.muted)),
        const SizedBox(width: 6),
        ConstrainedBox(constraints: const BoxConstraints(maxWidth: 170), child: Text(job.title.isEmpty ? jobKindLabel(job.kind) : job.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 12))),
        if (job.since > 0) ...[const SizedBox(width: 6), Elapsed(job.since, style: TextStyle(color: t.faint, fontSize: 11, fontFeatures: const [FontFeature.tabularFigures()]))],
      ]),
    );
  }
}

/// One full row for a job inside a job card or the background tray.
class JobRow extends StatelessWidget {
  const JobRow(this.job, {super.key});
  final Job job;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(children: [
        const Spin(),
        const SizedBox(width: 10),
        if (job.agent.isNotEmpty) ...[Ava(name: job.agent, size: 18), const SizedBox(width: 6)],
        Expanded(child: Text(job.title.isEmpty ? jobKindLabel(job.kind) : job.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14, fontWeight: FontWeight.w600))),
        const SizedBox(width: 8),
        Tag(jobKindLabel(job.kind)),
        const SizedBox(width: 8),
        Elapsed(job.since),
      ]),
    );
  }
}

/// A thin indeterminate accent bar, for work with no known percentage.
class IndeterminateBar extends StatelessWidget {
  const IndeterminateBar({super.key});
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ClipRRect(
      borderRadius: BorderRadius.circular(3),
      child: LinearProgressIndicator(minHeight: 4, color: t.accent, backgroundColor: t.active),
    );
  }
}

/// The section header used on Home and Inbox: icon · title · count tag · trailing link.
class SecHeader extends StatelessWidget {
  const SecHeader({super.key, required this.icon, required this.title, this.count, this.countKind = 'neutral', this.more, this.onMore});
  final IconData icon;
  final String title;
  final int? count;
  final String countKind;
  final String? more;
  final VoidCallback? onMore;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 26, 8, 8),
      child: Row(children: [
        Icon(icon, size: 16, color: t.muted),
        const SizedBox(width: 8),
        Flexible(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 14, fontWeight: FontWeight.w600))),
        if (count != null) ...[const SizedBox(width: 8), Tag('$count', kind: countKind)],
        const Spacer(),
        if (more != null)
          TextButton(
            onPressed: onMore,
            style: TextButton.styleFrom(foregroundColor: t.accent, minimumSize: const Size(44, 36), padding: const EdgeInsets.symmetric(horizontal: 8)),
            child: Text(more!, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
          ),
      ]),
    );
  }
}

/// Title + optional subtitle at the top of a bottom sheet.
class SheetTitle extends StatelessWidget {
  const SheetTitle(this.title, {super.key, this.sub});
  final String title;
  final String? sub;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: TextStyle(color: t.fg, fontSize: 17, fontWeight: FontWeight.w700)),
        if (sub != null) ...[const SizedBox(height: 2), Text(sub!, style: TextStyle(color: t.muted, fontSize: 13))],
      ]),
    );
  }
}

/// A selectable row in a bottom sheet: leading · title/subtitle · check.
class PickRow extends StatelessWidget {
  const PickRow({super.key, required this.title, this.sub, this.leading, this.selected = false, required this.onTap});
  final String title;
  final String? sub;
  final Widget? leading;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 52),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 9),
        child: Row(children: [
          if (leading != null) ...[leading!, const SizedBox(width: 12)],
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(title, style: TextStyle(color: t.fg, fontSize: 15.5, fontWeight: FontWeight.w600)),
              if (sub != null && sub!.isNotEmpty) Text(sub!, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 13)),
            ]),
          ),
          if (selected) Icon(Icons.check_rounded, color: t.accent, size: 20),
        ]),
      ),
    );
  }
}
