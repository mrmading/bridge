/// Settings → Tokens & keys: the API keys and tokens Bridge keeps for your chats (server
/// /api/secrets). Values never come back from the server; the list shows a masked hint.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/models.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/common.dart';
import '../../widgets/composer.dart' show projectLabel;
import '../../widgets/secret_card.dart';
import '../../widgets/transcript.dart' show mono;
import '../session/session_utils.dart';

final secretNamePattern = RegExp(r'^[A-Z][A-Z0-9_]{1,63}$');

class TokensScreen extends StatefulWidget {
  const TokensScreen({super.key});
  @override
  State<TokensScreen> createState() => _TokensScreenState();
}

class _TokensScreenState extends State<TokensScreen> {
  final store = AppStore.instance;
  List<SecretInfo>? _items;
  String _error = '';

  String get _home => defaultCwd();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final l = await store.api.secrets(cwd: _home);
      if (mounted) {
        setState(() {
          _items = l;
          _error = '';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _remove(SecretInfo s) async {
    final t = context.t;
    final where = s.isProject ? 'from ${s.project.isEmpty ? 'this project' : prettyPath(s.project)}' : 'from every chat';
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: t.raised,
        title: Text('Delete ${s.name}?', style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700)),
        content: Text('Chats lose access to it $where. You can add it again later.', style: TextStyle(color: t.muted, fontSize: 15)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text('Delete', style: TextStyle(color: t.err))),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    try {
      await store.api.removeSecret(name: s.name, scope: s.scope, cwd: s.isProject && s.project.isNotEmpty ? s.project : _home);
      if (mounted) toast(context, 'Deleted ${s.name}');
      await _load();
    } catch (e) {
      if (mounted) toast(context, 'Could not delete: $e');
    }
  }

  Future<void> _add() async {
    final saved = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: context.t.raised,
      builder: (ctx) => AddTokenSheet(home: _home, folders: [for (final p in store.projects) if (p.exists && p.path.isNotEmpty) p.path]),
    );
    if (saved == null || !mounted) return;
    toast(context, 'Saved $saved');
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final items = _items;
    final global = [for (final s in items ?? const <SecretInfo>[]) if (!s.isProject) s];
    final byProject = <String, List<SecretInfo>>{};
    for (final s in items ?? const <SecretInfo>[]) {
      if (s.isProject) byProject.putIfAbsent(s.project, () => []).add(s);
    }
    return Scaffold(
      appBar: AppBar(titleSpacing: 0, title: const Text('Tokens & keys')),
      floatingActionButton: FloatingActionButton.extended(onPressed: _add, icon: const Icon(Icons.add_rounded), label: const Text('Add token')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.only(bottom: 96),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Text(
                'API keys and tokens your chats can use. They stay on the server: Bridge shows only the first and last few characters.',
                style: TextStyle(color: t.muted, fontSize: 13.5, height: 1.4),
              ),
            ),
            if (items == null && _error.isEmpty) const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())),
            if (_error.isNotEmpty)
              EmptyState(icon: Icons.error_outline_rounded, title: 'Could not load tokens', body: _error, action: FilledButton(onPressed: _load, child: const Text('Retry'))),
            if (items != null && items.isEmpty && _error.isEmpty)
              const EmptyState(icon: Icons.key_rounded, title: 'No tokens yet', body: 'When a chat needs an API key it asks for it, or add one here.'),
            if (global.isNotEmpty) ...[
              SectionHeader('Everywhere', count: global.length),
              _group(context, global),
            ],
            for (final e in byProject.entries) ...[
              SectionHeader(e.key.isEmpty ? 'This project' : projectLabel(e.key), count: e.value.length),
              _group(context, e.value),
            ],
          ],
        ),
      ),
    );
  }

  Widget _group(BuildContext context, List<SecretInfo> list) {
    final t = context.t;
    return Card2(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(children: [
        for (var i = 0; i < list.length; i++) ...[
          if (i > 0) Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
          ListTile(
            minTileHeight: 56,
            leading: Icon(Icons.lock_outline_rounded, color: t.muted, size: 20),
            title: Text(list[i].name, maxLines: 1, overflow: TextOverflow.ellipsis, style: mono(14, t.fg, weight: FontWeight.w600)),
            subtitle: Text(
              [if (list[i].hint.isNotEmpty) list[i].hint, if (list[i].updatedAt > 0) 'updated ${relTime(list[i].updatedAt)}'].join(' · '),
              style: TextStyle(color: t.muted, fontSize: 12.5),
            ),
            trailing: IconButton(tooltip: 'Delete', icon: Icon(Icons.delete_outline_rounded, color: t.faint), onPressed: () => _remove(list[i])),
          ),
        ],
      ]),
    );
  }
}

/// Name (uppercase-forced, validated), scope, obscured value → POST /api/secrets. Pops the name on success.
class AddTokenSheet extends StatefulWidget {
  const AddTokenSheet({super.key, required this.home, this.folders = const []});
  final String home;
  /// Project folders a `This project` token can belong to; the first choice is [home].
  final List<String> folders;
  @override
  State<AddTokenSheet> createState() => _AddTokenSheetState();
}

class _AddTokenSheetState extends State<AddTokenSheet> {
  final _name = TextEditingController();
  final _value = TextEditingController();
  String _scope = 'global';
  late String _folder = widget.home;
  bool _show = false;
  bool _saving = false;
  String _error = '';

  @override
  void dispose() {
    _value.clear();
    _value.dispose();
    _name.dispose();
    super.dispose();
  }

  bool get _nameOk => secretNamePattern.hasMatch(_name.text);

  Future<void> _save() async {
    if (!_nameOk) {
      setState(() => _error = 'Use capital letters, digits and _ (like GITHUB_TOKEN)');
      return;
    }
    if (_value.text.trim().isEmpty) {
      setState(() => _error = 'Paste the value');
      return;
    }
    setState(() {
      _saving = true;
      _error = '';
    });
    try {
      final name = _name.text;
      await AppStore.instance.api.saveSecret(name: name, value: _value.text.trim(), scope: _scope, cwd: _scope == 'project' ? _folder : widget.home);
      _value.clear();
      if (mounted) Navigator.pop(context, name);
    } catch (e) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final folders = {widget.home, ...widget.folders}.where((f) => f.isNotEmpty).toList();
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
            Text('Add token', style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            TextField(
              controller: _name,
              autofocus: true,
              autocorrect: false,
              enableSuggestions: false,
              textCapitalization: TextCapitalization.characters,
              inputFormatters: [_UpperName()],
              onChanged: (_) => setState(() => _error = ''),
              style: mono(14, t.fg),
              decoration: InputDecoration(
                labelText: 'Name',
                hintText: 'CLOUDFLARE_API_TOKEN',
                errorText: _name.text.isNotEmpty && !_nameOk ? 'Start with a letter; 2 to 64 of A–Z, 0–9, _' : null,
              ),
            ),
            const SizedBox(height: 14),
            SecretScopeToggle(value: _scope, onChanged: _saving ? null : (s) => setState(() => _scope = s)),
            if (_scope == 'project' && folders.length > 1) ...[
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: folders.contains(_folder) ? _folder : folders.first,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Project'),
                items: [for (final f in folders) DropdownMenuItem(value: f, child: Text(f == widget.home ? 'Home' : prettyPath(f), overflow: TextOverflow.ellipsis))],
                onChanged: _saving ? null : (f) => setState(() => _folder = f ?? widget.home),
              ),
            ],
            const SizedBox(height: 14),
            SecretField(controller: _value, show: _show, enabled: !_saving, onToggleShow: () => setState(() => _show = !_show), onSubmitted: (_) => _save(), hintText: 'Paste the value'),
            if (_error.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error, style: TextStyle(color: t.err, fontSize: 13))),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _saving ? null : _save,
              child: _saving ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Save'),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Uppercases and keeps only A–Z, 0–9 and _ (spaces and dashes become _).
class _UpperName extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final s = newValue.text.toUpperCase().replaceAll(RegExp(r'[\s-]'), '_').replaceAll(RegExp(r'[^A-Z0-9_]'), '');
    final s2 = s.length > 64 ? s.substring(0, 64) : s;
    return TextEditingValue(text: s2, selection: TextSelection.collapsed(offset: s2.length));
  }
}
