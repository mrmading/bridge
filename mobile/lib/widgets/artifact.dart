/// Artifacts in a chat: the inline card a turn shows for a page, doc, image or PDF it made, and
/// the full-screen sheet that renders it, with Code/Preview, share and copy. The sheet reloads
/// when the chat edits the file again.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/artifacts.dart';
import '../core/store.dart';
import '../core/theme.dart';
import 'artifact_frame_io.dart' if (dart.library.js_interop) 'artifact_frame_web.dart';
import 'bridge.dart';
import 'common.dart';
import 'transcript.dart';

String _name(String p) => p.split('/').where((x) => x.isNotEmpty).lastOrNull ?? p;

IconData artifactIcon(ArtifactKind k) => switch (k) {
      ArtifactKind.html => Icons.web_rounded,
      ArtifactKind.markdown => Icons.article_outlined,
      ArtifactKind.svg || ArtifactKind.image => Icons.image_outlined,
      ArtifactKind.pdf => Icons.picture_as_pdf_outlined,
    };

/// The card in the transcript. Tap opens the sheet.
class ArtifactCard extends StatelessWidget {
  const ArtifactCard({super.key, required this.artifact, this.onTap});
  final ArtifactRef artifact;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final a = artifact;
    final ext = extOf(_name(a.path));
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 2),
      child: Material(
        color: t.raised,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          key: ValueKey('artifact:${a.path}'),
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.fromLTRB(10, 10, 12, 10),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), border: Border.all(color: t.borderStrong)),
            child: Row(children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(color: t.accentSoft, borderRadius: BorderRadius.circular(10)),
                child: Icon(artifactIcon(a.kind), color: t.accent, size: 22),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(_name(a.path), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14.5, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text('${artifactKindLabel(a.kind)} · $ext${a.isNew ? ' · New' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 12.5)),
                ]),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                decoration: BoxDecoration(borderRadius: BorderRadius.circular(20), border: Border.all(color: t.border)),
                child: Text('Open', style: TextStyle(color: t.fg, fontSize: 13, fontWeight: FontWeight.w600)),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Opens the full-screen preview. [revisions] is the chat's write/edit count per path.
Future<void> showArtifactSheet(BuildContext context, {required String path, String computer = 'mac', ValueListenable<Map<String, int>>? revisions}) {
  final kind = artifactKindOf(path);
  if (kind == null) return Future.value();
  return Navigator.of(context, rootNavigator: true).push(MaterialPageRoute<void>(
    fullscreenDialog: true,
    builder: (_) => ArtifactSheet(path: path, kind: kind, computer: computer, revisions: revisions),
  ));
}

class ArtifactSheet extends StatefulWidget {
  const ArtifactSheet({super.key, required this.path, required this.kind, this.computer = 'mac', this.revisions});
  final String path;
  final ArtifactKind kind;
  final String computer;
  final ValueListenable<Map<String, int>>? revisions;
  @override
  State<ArtifactSheet> createState() => _ArtifactSheetState();
}

class _ArtifactSheetState extends State<ArtifactSheet> {
  final _store = AppStore.instance;
  bool _code = false;
  String? _text;
  String _error = '';
  bool _loading = false;
  int _rev = 0;
  int _nonce = 0;

  ArtifactKind get _kind => widget.kind;
  bool get _hasCode => artifactHasCode(_kind);
  bool get _needsText => _kind == ArtifactKind.markdown || (_code && _hasCode);

  @override
  void initState() {
    super.initState();
    _rev = widget.revisions?.value[widget.path] ?? 0;
    widget.revisions?.addListener(_onRevisions);
    if (_needsText) _loadText();
  }

  @override
  void dispose() {
    widget.revisions?.removeListener(_onRevisions);
    super.dispose();
  }

  void _onRevisions() {
    final r = widget.revisions?.value[widget.path] ?? 0;
    if (r == _rev || !mounted) return;
    setState(() => _rev = r);
    _reload();
  }

  void _reload() {
    setState(() {
      _nonce++;
      _text = null;
    });
    if (_needsText) _loadText();
  }

  Future<void> _loadText() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final text = await _fetchText();
      if (mounted) setState(() => _text = text);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<String> _fetchText() async {
    if (_kind == ArtifactKind.svg) return utf8.decode(await _store.api.rawBytes(widget.path, computer: widget.computer), allowMalformed: true);
    final f = await _store.api.file(widget.path, computer: widget.computer);
    if (f['blocked'] == true) throw (f['text'] ?? 'Protected file').toString();
    if (f['error'] != null) throw f['error'].toString();
    return (f['text'] ?? '').toString();
  }

  /// The raw URL, with a version so the web view and image cache fetch it again after an edit.
  Uri get _url {
    final u = _store.api.rawUrl(widget.path, computer: widget.computer);
    return u.replace(queryParameters: {...u.queryParameters, 'v': '$_rev.$_nonce'});
  }

  Future<void> _share(BuildContext btn) async {
    final box = btn.findRenderObject() as RenderBox?;
    final origin = box == null ? null : box.localToGlobal(Offset.zero) & box.size;
    try {
      final bytes = await _store.api.rawBytes(widget.path, computer: widget.computer);
      final name = _name(widget.path);
      await SharePlus.instance.share(ShareParams(files: [XFile.fromData(bytes, name: name, mimeType: _mime)], fileNameOverrides: [name], sharePositionOrigin: origin));
    } catch (e) {
      if (mounted) toast(context, 'Could not share: $e');
    }
  }

  String get _mime => switch (_kind) {
        ArtifactKind.html => 'text/html',
        ArtifactKind.markdown => 'text/markdown',
        ArtifactKind.svg => 'image/svg+xml',
        ArtifactKind.pdf => 'application/pdf',
        ArtifactKind.image => switch (extOf(widget.path)) { 'PNG' => 'image/png', 'GIF' => 'image/gif', 'WEBP' => 'image/webp', _ => 'image/jpeg' },
      };

  Future<void> _copy() async {
    if (!_hasCode && _kind != ArtifactKind.markdown) {
      await Clipboard.setData(ClipboardData(text: widget.path));
      if (mounted) toast(context, 'Path copied');
      return;
    }
    try {
      final text = _text ?? await _fetchText();
      await Clipboard.setData(ClipboardData(text: text));
      if (mounted) toast(context, 'Copied');
    } catch (e) {
      if (mounted) toast(context, 'Could not copy: $e');
    }
  }

  void _setCode(bool v) {
    if (v == _code) return;
    setState(() => _code = v);
    if (_needsText && _text == null) _loadText();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final name = _name(widget.path);
    return Scaffold(
      backgroundColor: t.bg,
      appBar: AppBar(
        leading: IconButton(key: const ValueKey('artifact-close'), tooltip: 'Close', onPressed: () => Navigator.of(context).maybePop(), icon: const Icon(Icons.close_rounded)),
        titleSpacing: 0,
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16)),
          Text(artifactKindLabel(_kind), maxLines: 1, style: TextStyle(color: t.muted, fontSize: 12, fontWeight: FontWeight.w500)),
        ]),
        actions: [
          IconButton(tooltip: _hasCode || _kind == ArtifactKind.markdown ? 'Copy' : 'Copy path', onPressed: _copy, icon: Icon(Icons.copy_rounded, size: 20, color: t.muted)),
          Builder(builder: (b) => IconButton(key: const ValueKey('artifact-share'), tooltip: 'Share', onPressed: () => _share(b), icon: Icon(Icons.ios_share_rounded, size: 21, color: t.muted))),
          PopupMenuButton<String>(
            tooltip: 'More',
            icon: Icon(Icons.more_horiz_rounded, color: t.muted),
            onSelected: (v) {
              if (v == 'reload') _reload();
              if (v == 'browser') launchUrl(_url, mode: LaunchMode.externalApplication).catchError((_) => false);
              if (v == 'path') {
                Clipboard.setData(ClipboardData(text: widget.path));
                toast(context, 'Path copied');
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'reload', child: Text('Reload')),
              PopupMenuItem(value: 'browser', child: Text('Open in browser')),
              PopupMenuItem(value: 'path', child: Text('Copy path')),
            ],
          ),
          const SizedBox(width: 4),
        ],
        bottom: _hasCode
            ? PreferredSize(
                preferredSize: const Size.fromHeight(48),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                  child: _Toggle(code: _code, onChanged: _setCode),
                ),
              )
            : null,
      ),
      body: _body(context),
    );
  }

  Widget _body(BuildContext context) {
    final t = context.t;
    if (_needsText) {
      if (_error.isNotEmpty) return EmptyState(icon: Icons.block_rounded, title: 'Cannot open this file', body: _error, action: FilledButton(onPressed: _loadText, child: const Text('Retry')));
      if (_text == null || (_loading && _text == null)) return Center(child: CircularProgressIndicator(color: t.accent, strokeWidth: 2));
      if (_code) return _CodeView(_text!);
      return ListView(
        key: const ValueKey('artifact-markdown'),
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 40),
        children: [MarkdownBody(data: _text!, selectable: true, styleSheet: bridgeMarkdown(context), onTapLink: (_, href, _) => openLink(href))],
      );
    }
    final url = _url;
    switch (_kind) {
      case ArtifactKind.html:
        return ArtifactFrame(key: const ValueKey('artifact-frame'), url: url);
      case ArtifactKind.pdf:
        if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
          return EmptyState(icon: Icons.picture_as_pdf_outlined, title: 'PDF', body: 'Open it in your browser to read it.', action: FilledButton(onPressed: () => launchUrl(url, mode: LaunchMode.externalApplication), child: const Text('Open PDF')));
        }
        return ArtifactFrame(key: const ValueKey('artifact-frame'), url: url, sandbox: false);
      case ArtifactKind.svg:
        return InteractiveViewer(
          maxScale: 8,
          child: Center(child: Padding(padding: const EdgeInsets.all(16), child: SvgPicture.network(url.toString(), placeholderBuilder: (_) => CircularProgressIndicator(color: t.accent, strokeWidth: 2)))),
        );
      case ArtifactKind.image:
        return InteractiveViewer(
          maxScale: 8,
          child: Center(child: Image.network(url.toString(), errorBuilder: (_, _, _) => const EmptyState(icon: Icons.broken_image_outlined, title: 'Could not load the image'))),
        );
      case ArtifactKind.markdown:
        return const SizedBox.shrink();
    }
  }
}

class _Toggle extends StatelessWidget {
  const _Toggle({required this.code, required this.onChanged});
  final bool code;
  final ValueChanged<bool> onChanged;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    Widget seg(String label, bool isCode) {
      final on = code == isCode;
      return Expanded(
        child: GestureDetector(
          key: ValueKey('artifact-${label.toLowerCase()}'),
          behavior: HitTestBehavior.opaque,
          onTap: () => onChanged(isCode),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            alignment: Alignment.center,
            decoration: BoxDecoration(color: on ? t.bg : Colors.transparent, borderRadius: BorderRadius.circular(9), border: on ? Border.all(color: t.border) : null),
            child: Text(label, style: TextStyle(color: on ? t.fg : t.muted, fontSize: 13.5, fontWeight: on ? FontWeight.w700 : FontWeight.w500)),
          ),
        ),
      );
    }

    return Container(
      height: 38,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: t.sunken, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [seg('Preview', false), seg('Code', true)]),
    );
  }
}

class _CodeView extends StatelessWidget {
  const _CodeView(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final lines = text.split('\n');
    final shown = lines.length > 3000 ? '${lines.take(3000).join('\n')}\n… ${lines.length - 3000} more lines' : text;
    return Container(
      key: const ValueKey('artifact-code'),
      color: t.code,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 40),
        child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: SelectableText(shown, style: mono(12.5, t.fg))),
      ),
    );
  }
}
