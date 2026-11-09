/// Project actions: merge a project into an existing one, or delete it from Bridge.
/// Neither touches the folder on disk. Delete moves the project's threads to Bridge's trash;
/// merge moves every thread into the other project, where they keep working.
library;

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';
import '../session/session_utils.dart';

/// Every project Bridge shows: folders with threads, plus Bridge folders with none yet.
List<Project> bridgeProjects(AppStore store) {
  final out = [...store.projects.where((p) => p.exists && isProjectPath(p.path))]..sort((a, b) => b.lastActivity.compareTo(a.lastActivity));
  final paths = out.map((p) => p.path).toSet();
  for (final r in store.roots) {
    if (r.isEmpty || paths.contains(r) || !isProjectPath(r)) continue;
    out.add(Project(key: projectKeyFor(r), path: r, name: baseName(r), sessions: 0, lastActivity: 0, exists: true));
  }
  return out;
}

String _nameOf(Project p) => p.name.isNotEmpty ? p.name : baseName(p.path);

/// The ⋯ menu for a project. Returns true when the project is gone (merged or deleted), so a
/// project page can close itself.
Future<bool> showProjectActions(BuildContext context, Project p) async {
  final t = context.t;
  final pick = await showModalBottomSheet<String>(
    context: context,
    useSafeArea: true,
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 6),
            child: Row(
              children: [
                ProjectIcon(_nameOf(p)),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    _nameOf(p),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: t.fg, fontSize: 17, fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ),
          ),
          ListTile(
            minTileHeight: 56,
            leading: Icon(Icons.call_merge_rounded, color: t.fg),
            title: Text('Merge into another project', style: TextStyle(color: t.fg, fontSize: 16)),
            subtitle: Text('Its threads move there and keep working', style: TextStyle(color: t.muted, fontSize: 13)),
            onTap: () => Navigator.pop(ctx, 'merge'),
          ),
          ListTile(
            minTileHeight: 56,
            leading: Icon(Icons.delete_outline_rounded, color: t.err),
            title: Text('Delete project', style: TextStyle(color: t.err, fontSize: 16)),
            subtitle: Text('Removes it from Bridge. The folder on disk stays.', style: TextStyle(color: t.muted, fontSize: 13)),
            onTap: () => Navigator.pop(ctx, 'delete'),
          ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
  if (!context.mounted || pick == null) return false;
  return pick == 'merge' ? _merge(context, p) : _delete(context, p);
}

Future<bool> _delete(BuildContext context, Project p) async {
  final t = context.t;
  final n = p.sessions;
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text('Delete ${_nameOf(p)}?'),
      content: Text(
        '${n == 0 ? 'It has no threads.' : 'Its $n ${n == 1 ? 'thread moves' : 'threads move'} to Bridge\'s trash.'} '
        'The folder ${p.path} and its files stay on disk.',
        style: TextStyle(color: t.muted, fontSize: 14, height: 1.35),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: t.err, foregroundColor: Colors.white),
          onPressed: () => Navigator.pop(ctx, true),
          child: const Text('Delete'),
        ),
      ],
    ),
  );
  if (ok != true || !context.mounted) return false;
  return _run(context, '/api/projects/delete', {'key': p.key, 'path': p.path}, (j) => '${_nameOf(p)} deleted');
}

Future<bool> _merge(BuildContext context, Project p) async {
  final t = context.t;
  final store = AppStore.instance;
  final others = bridgeProjects(store).where((o) => o.key != p.key && o.path != p.path).toList();
  if (others.isEmpty) {
    toast(context, 'There is no other project to merge into yet.');
    return false;
  }
  final into = await showModalBottomSheet<Project>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (ctx) => _MergePicker(from: p, others: others),
  );
  if (into == null || !context.mounted) return false;
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text('Merge into ${_nameOf(into)}?'),
      content: Text(
        '${p.sessions == 0 ? 'Nothing to move; ${_nameOf(p)} just leaves the list.' : 'All ${p.sessions} ${p.sessions == 1 ? 'thread' : 'threads'} of ${_nameOf(p)} move to ${_nameOf(into)} and continue in ${into.path}.'} '
        'Files stay where they are.',
        style: TextStyle(color: t.muted, fontSize: 14, height: 1.35),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Merge')),
      ],
    ),
  );
  if (ok != true || !context.mounted) return false;
  return _run(context, '/api/projects/merge', {
    'from': p.key,
    'fromPath': p.path,
    'into': into.key,
    'intoPath': into.path,
  }, (j) => '${j['threads'] ?? 0} ${j['threads'] == 1 ? 'thread' : 'threads'} moved to ${_nameOf(into)}');
}

Future<bool> _run(BuildContext context, String path, Map<String, dynamic> body, String Function(Map) done) async {
  final store = AppStore.instance;
  try {
    final j = await store.api.postJson(path, body);
    await store.refreshAll();
    if (context.mounted) toast(context, done(j is Map ? j : const {}));
    return true;
  } catch (e) {
    if (context.mounted) toast(context, e is ApiException ? e.message : 'Could not reach Bridge: $e');
    return false;
  }
}

class _MergePicker extends StatefulWidget {
  const _MergePicker({required this.from, required this.others});
  final Project from;
  final List<Project> others;
  @override
  State<_MergePicker> createState() => _MergePickerState();
}

class _MergePickerState extends State<_MergePicker> {
  String _q = '';
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final q = _q.toLowerCase();
    final items = q.isEmpty ? widget.others : widget.others.where((p) => '${p.name} ${p.path}'.toLowerCase().contains(q)).toList();
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * .8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 4),
            child: Text(
              'Merge ${_nameOf(widget.from)} into…',
              style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: TextField(
              autofocus: false,
              onChanged: (v) => setState(() => _q = v.trim()),
              decoration: const InputDecoration(hintText: 'Find a project…', prefixIcon: Icon(Icons.search_rounded)),
            ),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.only(bottom: 16),
              children: [
                for (final p in items)
                  ListTile(
                    minTileHeight: 56,
                    leading: ProjectIcon(_nameOf(p)),
                    title: Text(
                      _nameOf(p),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: t.fg, fontSize: 16),
                    ),
                    subtitle: Text(
                      p.path,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: t.muted, fontSize: 12.5),
                    ),
                    trailing: Text(p.sessions == 0 ? '' : '${p.sessions}', style: TextStyle(color: t.faint, fontSize: 12.5)),
                    onTap: () => Navigator.pop(context, p),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
