/// One file (preview from /api/file: markdown, code, images; anything else opens raw) or one
/// folder (/api/dir) you can walk through and start a chat in.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';
import '../../widgets/transcript.dart';
import '../session/session_utils.dart';

class FileScreen extends StatefulWidget {
  const FileScreen({super.key, required this.path, this.isDir = false});
  final String path;
  final bool isDir;
  @override
  State<FileScreen> createState() => _FileScreenState();
}

class _FileScreenState extends State<FileScreen> {
  final _store = AppStore.instance;
  late String _path = widget.path;
  Map<String, dynamic>? _file;
  DirListing? _dir;
  bool _loading = true;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      if (widget.isDir) {
        final l = await _store.api.dir(_path);
        if (!mounted) return;
        setState(() {
          _dir = l;
          if (l.path.isNotEmpty) _path = l.path;
        });
      } else {
        final f = await _store.api.file(_path);
        if (!mounted) return;
        setState(() => _file = f);
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _openRaw() => launchUrl(_store.api.rawUrl(_path), mode: LaunchMode.externalApplication).catchError((_) => false);

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final name = baseName(_path);
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Row(children: [
          if (!widget.isDir) ...[FileBadge(extOf(name), size: 26), const SizedBox(width: 10)] else ...[Icon(Icons.folder_rounded, color: t.accent, size: 22), const SizedBox(width: 10)],
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16)),
              Text(prettyPath(_path), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 12, fontWeight: FontWeight.w500)),
            ]),
          ),
        ]),
        actions: [
          if (!widget.isDir) IconButton(tooltip: 'Open', onPressed: _openRaw, icon: Icon(Icons.open_in_new_rounded, color: t.muted)),
          IconButton(
            tooltip: 'Copy path',
            onPressed: () {
              Clipboard.setData(ClipboardData(text: _path));
              toast(context, 'Path copied');
            },
            icon: Icon(Icons.copy_rounded, color: t.muted, size: 20),
          ),
        ],
        bottom: _loading && (_dir != null || _file != null) ? PreferredSize(preferredSize: const Size.fromHeight(2), child: LinearProgressIndicator(minHeight: 2, color: t.accent, backgroundColor: t.border)) : null,
      ),
      body: widget.isDir ? _folder(context) : _preview(context),
      bottomNavigationBar: widget.isDir && _error.isEmpty
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                child: SizedBox(
                  height: 48,
                  child: FilledButton.icon(
                    onPressed: () => Nav.instance.newChat(cwd: _path),
                    icon: const Icon(Icons.add_rounded),
                    label: Text('New chat in $name', maxLines: 1, overflow: TextOverflow.ellipsis),
                    style: FilledButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)), textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                  ),
                ),
              ),
            )
          : null,
    );
  }

  Widget _preview(BuildContext context) {
    final t = context.t;
    if (_loading && _file == null) return Center(child: CircularProgressIndicator(color: t.accent, strokeWidth: 2));
    if (_error.isNotEmpty) return EmptyState(icon: Icons.block_rounded, title: 'Cannot open this file', body: _error);
    final f = _file ?? const {};
    final text = (f['text'] ?? '').toString();
    if (f['blocked'] == true) return EmptyState(icon: Icons.lock_outline_rounded, title: 'Protected file', body: text);
    if (f['binary'] == true) {
      final ext = (f['ext'] ?? '').toString();
      if (ext != '.pdf') {
        return InteractiveViewer(
          child: Center(child: Image.network(_store.api.rawUrl(_path).toString(), errorBuilder: (_, _, _) => const EmptyState(icon: Icons.broken_image_outlined, title: 'Could not load the image'))),
        );
      }
      return EmptyState(icon: Icons.picture_as_pdf_outlined, title: 'PDF', body: 'Open it in your browser to read it.', action: FilledButton(onPressed: _openRaw, child: const Text('Open PDF')));
    }
    final lang = (f['lang'] ?? 'text').toString();
    if (_path.toLowerCase().endsWith('.md') || lang == 'markdown') {
      return ListView(padding: const EdgeInsets.fromLTRB(18, 12, 18, 40), children: [
        MarkdownBody(data: text, selectable: true, styleSheet: bridgeMarkdown(context), onTapLink: (_, href, _) => openLink(href)),
      ]);
    }
    final ext = extOf(_path);
    if (ext == 'HTML' || ext == 'HTM') {
      return Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Row(children: [
            Expanded(child: Text('A web page. Open it to see it rendered.', style: TextStyle(color: t.muted, fontSize: 13))),
            TextButton.icon(onPressed: _openRaw, icon: const Icon(Icons.open_in_new_rounded, size: 16), label: const Text('Open')),
          ]),
        ),
        Expanded(child: _code(context, text)),
      ]);
    }
    return _code(context, text);
  }

  Widget _code(BuildContext context, String text) {
    final t = context.t;
    final lines = text.split('\n');
    final shown = lines.length > 3000 ? '${lines.take(3000).join('\n')}\n… ${lines.length - 3000} more lines' : text;
    return Container(
      color: t.code,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 40),
        child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: SelectableText(shown, style: mono(12.5, t.fg))),
      ),
    );
  }

  Widget _folder(BuildContext context) {
    final t = context.t;
    final l = _dir;
    if (_loading && l == null) return Center(child: CircularProgressIndicator(color: t.accent, strokeWidth: 2));
    if (_error.isNotEmpty) return EmptyState(icon: Icons.block_rounded, title: 'Cannot open this folder', body: _error);
    final entries = l?.entries ?? const <DirEntry>[];
    return ListView(padding: const EdgeInsets.only(bottom: 16), children: [
      if (l?.parent != null)
        _EntryRow(
          icon: Icons.arrow_upward_rounded,
          name: 'Up one level',
          sub: baseName(l!.parent!),
          onTap: () {
            _path = l.parent!;
            _load();
          },
        ),
      if (entries.isEmpty) const EmptyState(icon: Icons.folder_open_outlined, title: 'Empty folder'),
      for (final e in entries)
        _EntryRow(
          icon: e.dir ? Icons.folder_rounded : null,
          badge: e.dir ? null : extOf(e.name),
          name: e.name,
          sub: e.dir ? null : [_size(e.size), if (e.mtime > 0) relTime(e.mtime)].join(' · '),
          onTap: () {
            final full = _path.endsWith('/') ? '$_path${e.name}' : '$_path/${e.name}';
            if (e.dir) {
              _path = full;
              _load();
            } else {
              Nav.instance.push(FileScreen(path: full));
            }
          },
        ),
    ]);
  }
}

String _size(int b) => b >= 1 << 20 ? '${(b / (1 << 20)).toStringAsFixed(1)} MB' : (b >= 1024 ? '${(b / 1024).round()} KB' : '$b B');

class _EntryRow extends StatelessWidget {
  const _EntryRow({this.icon, this.badge, required this.name, this.sub, required this.onTap});
  final IconData? icon;
  final String? badge;
  final String name;
  final String? sub;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 54),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.border))),
        child: Row(children: [
          if (badge != null)
            FileBadge(badge!, size: 30)
          else
            Container(width: 30, height: 30, decoration: BoxDecoration(color: t.accentSoft, borderRadius: BorderRadius.circular(8)), child: Icon(icon, size: 17, color: t.accent)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w500)),
              if (sub != null && sub!.isNotEmpty) Text(sub!, style: TextStyle(color: t.faint, fontSize: 12)),
            ]),
          ),
          Icon(Icons.chevron_right_rounded, color: t.faint, size: 20),
        ]),
      ),
    );
  }
}
