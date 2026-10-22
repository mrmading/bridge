/// Files: what your chats made (a gallery you can filter by kind), every folder Bridge can see,
/// and describe-to-find search (/api/find looks through chats for the file you mean).
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';
import '../home/home_screen.dart';
import '../session/session_utils.dart';
import '../shell/drawer.dart';
import 'file_screen.dart';

const _kinds = {
  'All': <String>[],
  'Documents': ['MD', 'TXT', 'PDF', 'DOC', 'DOCX'],
  'Pages': ['HTML', 'HTM'],
  'Media': ['MP4', 'MOV', 'WEBM', 'MP3', 'WAV', 'PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'SVG'],
  'Spreadsheets': ['XLS', 'XLSX', 'CSV'],
  'Code': ['TS', 'TSX', 'JS', 'DART', 'PY', 'RS', 'GO', 'SWIFT', 'JSON', 'YAML', 'YML', 'SH'],
};

class FilesScreen extends StatefulWidget {
  const FilesScreen({super.key});
  @override
  State<FilesScreen> createState() => _FilesScreenState();
}

class _FilesScreenState extends State<FilesScreen> {
  final _store = AppStore.instance;
  final _search = TextEditingController();
  String _tab = 'made';
  String _kind = 'All';
  String _q = '';
  List<SessionMeta> _found = const [];
  bool _finding = false;
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  void _onQuery(String v) {
    setState(() => _q = v.trim());
    _debounce?.cancel();
    if (_q.length < 3) {
      setState(() {
        _found = const [];
        _finding = false;
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 500), () async {
      final q = _q;
      setState(() => _finding = true);
      try {
        final r = await _store.api.find(q);
        if (mounted && q == _q) setState(() => _found = r);
      } catch (_) {
        // Local filtering still works.
      } finally {
        if (mounted && q == _q) setState(() => _finding = false);
      }
    });
  }

  List<Made> _made() {
    final exts = _kinds[_kind] ?? const [];
    final q = _q.toLowerCase();
    return _store.home.made.where((m) => (exts.isEmpty || exts.contains(m.ext)) && (q.isEmpty || '${m.name} ${m.sessionTitle} ${m.path}'.toLowerCase().contains(q))).toList();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ListenableBuilder(
      listenable: _store,
      builder: (context, _) {
        return Scaffold(
          appBar: const RootAppBar(title: 'Files'),
          body: ListView(keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag, padding: const EdgeInsets.only(bottom: 32), children: [
            Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 12), child: Text('What your team made, and every folder Bridge can see.', style: TextStyle(color: t.muted, fontSize: 14))),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: TextField(
                controller: _search,
                onChanged: _onQuery,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  hintText: 'Describe it: “the padel occupancy excel”…',
                  prefixIcon: const Icon(Icons.search_rounded),
                  suffixIcon: _finding ? Padding(padding: const EdgeInsets.all(14), child: SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2, color: t.muted))) : null,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: SegmentedButton<String>(
                segments: const [ButtonSegment(value: 'made', label: Text('Made for you')), ButtonSegment(value: 'browse', label: Text('Browse folders'))],
                selected: {_tab},
                showSelectedIcon: false,
                onSelectionChanged: (s) => setState(() => _tab = s.first),
              ),
            ),
            if (_tab == 'made') ..._madeView(context) else ..._browseView(context),
            if (_found.isNotEmpty) ...[
              SecHeader(icon: Icons.chat_bubble_outline_rounded, title: 'Chats that mention it', count: _found.length),
              for (final s in _found.take(20))
                Card2(
                  onTap: () => openSession(key: s.key, id: s.id, cwd: s.cwd.isNotEmpty ? s.cwd : s.projectPath, title: s.title),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 2),
                    Text([s.folder, relTime(s.mtime)].where((x) => x.isNotEmpty).join(' · '), style: TextStyle(color: t.muted, fontSize: 13)),
                  ]),
                ),
            ],
          ]),
        );
      },
    );
  }

  List<Widget> _madeView(BuildContext context) {
    final t = context.t;
    final made = _made();
    return [
      SizedBox(
        height: 48,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(16, 6, 16, 2), children: [
          for (final k in _kinds.keys)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                label: Text(k),
                selected: _kind == k,
                showCheckmark: false,
                labelStyle: TextStyle(color: _kind == k ? t.accent : t.muted, fontSize: 13, fontWeight: FontWeight.w600),
                selectedColor: t.accentSoft,
                backgroundColor: t.raised,
                side: BorderSide(color: _kind == k ? t.accent.withValues(alpha: .4) : t.border),
                shape: const StadiumBorder(),
                onSelected: (_) => setState(() => _kind = k),
              ),
            ),
        ]),
      ),
      if (made.isEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 32),
          child: EmptyState(icon: Icons.auto_awesome_outlined, title: _store.home.made.isEmpty ? 'Nothing made yet' : 'No matches', body: _store.home.made.isEmpty ? 'Files your chats write land here.' : null),
        )
      else
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: LayoutBuilder(builder: (context, box) {
            final w = (box.maxWidth - 10) / 2;
            return Wrap(spacing: 10, runSpacing: 10, children: [for (final m in made) SizedBox(width: w, child: MadeTile(m))]);
          }),
        ),
    ];
  }

  List<Widget> _browseView(BuildContext context) {
    final t = context.t;
    final roots = _store.roots;
    final q = _q.toLowerCase();
    final shown = roots.where((r) => q.isEmpty || r.toLowerCase().contains(q)).toList();
    return [
      Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 6), child: Text('FOLDERS BRIDGE CAN SEE', style: TextStyle(color: t.faint, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.1))),
      if (shown.isEmpty) const EmptyState(icon: Icons.folder_off_outlined, title: 'No folders', body: 'Add folders to Bridge on your computer.'),
      for (final r in shown)
        Card2(
          onTap: () => Nav.instance.push(FileScreen(path: r, isDir: true)),
          child: Row(children: [
            Container(width: 34, height: 34, decoration: BoxDecoration(color: t.accentSoft, borderRadius: BorderRadius.circular(9)), child: Icon(Icons.folder_rounded, size: 18, color: t.accent)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(baseName(r), style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600)),
                Text(prettyPath(r), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 12.5)),
              ]),
            ),
            Icon(Icons.chevron_right_rounded, color: t.faint),
          ]),
        ),
    ];
  }
}
