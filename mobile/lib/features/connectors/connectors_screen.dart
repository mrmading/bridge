/// Connectors: the MCP servers chats can use. Your connectors (status, tools, sign-in, test,
/// disconnect), the catalog, any MCP server by URL, and connectors Bridge builds for you.
/// Server side: connectors/routes.ts. Tokens go in and never come back: the API returns a hint.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';

typedef J = Map<String, dynamic>;
J _m(dynamic x) => x is Map ? Map<String, dynamic>.from(x) : <String, dynamic>{};
List<J> _l(dynamic x) => x is List ? [for (final e in x) _m(e)] : const [];

Color _hex(String s, Color fallback) {
  final h = s.replaceAll('#', '');
  if (h.length != 6) return fallback;
  final v = int.tryParse(h, radix: 16);
  return v == null ? fallback : Color(0xFF000000 | v);
}

/// status → (label, Tag kind)
(String, String) connStatus(J c) {
  final tools = _l(c['tools']).length;
  if (c['generating'] == true || c['status'] == 'generating') return ('Building…', 'think');
  return switch (c['status']) {
    'connected' => ('Connected · $tools tools', 'ok'),
    'needs-auth' => ('Needs sign-in', 'warn'),
    'error' => ('Error', 'err'),
    _ => ('Not tested', 'neutral'),
  };
}

class Glyph extends StatelessWidget {
  const Glyph(this.c, {super.key, this.size = 36});
  final J c;
  final double size;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final col = _hex((c['color'] ?? '').toString(), t.accent);
    final g = (c['glyph'] ?? c['name'] ?? '?').toString();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: col.withValues(alpha: .14), borderRadius: BorderRadius.circular(9), border: Border.all(color: col.withValues(alpha: .35))),
      child: Text(g.length > 2 ? g.substring(0, 2) : g, style: TextStyle(color: col, fontWeight: FontWeight.w800, fontSize: size * .36)),
    );
  }
}

class ConnectorsScreen extends StatefulWidget {
  const ConnectorsScreen({super.key});
  @override
  State<ConnectorsScreen> createState() => _ConnectorsScreenState();
}

class _ConnectorsScreenState extends State<ConnectorsScreen> {
  final store = AppStore.instance;
  List<J> _conns = [];
  List<J> _catalog = [];
  bool _loading = true;
  String _err = '';
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final j = _m(await store.api.getJson('/api/connectors'));
      if (!mounted) return;
      setState(() {
        _conns = _l(j['connectors']);
        _catalog = _l(j['catalog']);
        _loading = false;
        _err = '';
      });
      // something is being built or signed in: keep the list fresh
      final busy = _conns.any((c) => c['generating'] == true || c['status'] == 'generating');
      _poll?.cancel();
      if (busy) _poll = Timer(const Duration(seconds: 2), _load);
    } catch (e) {
      if (mounted) setState(() { _err = e.toString(); _loading = false; });
    }
  }

  Future<J?> _post(String path, J body) async {
    try {
      final r = _m(await store.api.postJson(path, body));
      await _load();
      return r;
    } catch (e) {
      if (mounted) toast(context, e.toString());
      return null;
    }
  }

  J? _entry(String? id) => id == null ? null : _catalog.cast<J?>().firstWhere((e) => e!['id'] == id, orElse: () => null);

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Scaffold(
      appBar: AppBar(titleSpacing: 0, title: const Text('Connectors')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.only(bottom: 40), children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                  child: Text('Give your chats tools: GitHub, Linear, Notion, any MCP server, or one Bridge builds for you.', style: TextStyle(color: t.muted, fontSize: 14)),
                ),
                if (_err.isNotEmpty) Padding(padding: const EdgeInsets.all(16), child: Text(_err, style: TextStyle(color: t.err))),
                SectionHeader('Your connectors', count: _conns.length),
                if (_conns.isEmpty)
                  Card2(child: Text('Nothing connected yet. Pick one below.', style: TextStyle(color: t.muted, fontSize: 14))),
                for (final c in _conns) _mine(c),
                const SectionHeader('Add your own'),
                Card2(
                  onTap: _addUrl,
                  child: Row(children: [
                    Icon(Icons.link_rounded, color: t.accent),
                    const SizedBox(width: 12),
                    Expanded(child: _two(t, 'Any MCP server (URL)', 'Paste the address of a remote MCP server')),
                  ]),
                ),
                Card2(
                  onTap: _build,
                  accent: true,
                  child: Row(children: [
                    Icon(Icons.auto_awesome_rounded, color: t.accent),
                    const SizedBox(width: 12),
                    Expanded(child: _two(t, 'Build a connector', 'From an API URL and token, or describe it in words. Claude writes it, Bridge tests it.')),
                  ]),
                ),
                const SectionHeader('Catalog'),
                for (final e in _catalog) _catalogCard(e),
              ]),
            ),
    );
  }

  Widget _two(Tokens t, String a, String b) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(a, style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600)),
        const SizedBox(height: 2),
        Text(b, style: TextStyle(color: t.muted, fontSize: 13)),
      ]);

  Widget _mine(J c) {
    final t = context.t;
    final (label, kind) = connStatus(c);
    return Card2(
      onTap: () => _detail(c['id'].toString()),
      child: Row(children: [
        Glyph(c),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text((c['name'] ?? '').toString(), style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Wrap(spacing: 6, runSpacing: 4, children: [Tag(label, kind: kind), if (c['kind'] == 'local') const Tag('Self-made', kind: 'acc')]),
          ]),
        ),
        Column(children: [
          Switch(value: c['enabled'] == true, onChanged: (v) => _post('/api/connectors/update', {'id': c['id'], 'enabled': v})),
          Text('New chats', style: TextStyle(color: t.faint, fontSize: 10.5)),
        ]),
      ]),
    );
  }

  Widget _catalogCard(J e) {
    final t = context.t;
    final auth = [for (final a in (e['auth'] as List? ?? const [])) a.toString()];
    final limited = e['availability'] == 'limited';
    return Card2(
      onTap: () => _connect(e),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Glyph(e, size: 32),
          const SizedBox(width: 12),
          Expanded(child: Text((e['name'] ?? '').toString(), style: TextStyle(color: t.fg, fontSize: 15, fontWeight: FontWeight.w600))),
          TextButton(onPressed: () => _connect(e), child: const Text('Connect')),
        ]),
        const SizedBox(height: 6),
        Text((e['blurb'] ?? '').toString(), style: TextStyle(color: t.muted, fontSize: 13)),
        const SizedBox(height: 8),
        Wrap(spacing: 6, runSpacing: 4, children: [
          for (final a in auth) Tag(const {'oauth': 'OAuth', 'token': 'Token', 'none': 'No sign-in', 'device': 'Device code'}[a] ?? a),
          if (limited) const Tag('Limited', kind: 'warn'),
          if (e['verified'] != true) const Tag('Unverified', kind: 'warn'),
        ]),
        if (limited && (e['note'] ?? '').toString().isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(e['note'].toString(), style: TextStyle(color: t.faint, fontSize: 12)),
        ],
      ]),
    );
  }

  // ── flows ──

  Future<void> _sheet(Widget Function(BuildContext, StateSetter) body) => showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        backgroundColor: context.t.raised,
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, set) => Padding(
            padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
            child: SafeArea(child: SingleChildScrollView(padding: const EdgeInsets.fromLTRB(18, 16, 18, 18), child: body(ctx, set))),
          ),
        ),
      );

  Widget _field(TextEditingController c, String label, {String hint = '', bool secret = false, int lines = 1}) => Padding(
        padding: const EdgeInsets.only(top: 10),
        child: TextField(
          controller: c,
          obscureText: secret,
          minLines: lines,
          maxLines: secret ? 1 : lines,
          autocorrect: false,
          enableSuggestions: !secret,
          decoration: InputDecoration(labelText: label, hintText: hint.isEmpty ? null : hint, border: const OutlineInputBorder()),
        ),
      );

  Widget _helpLink(String url) => Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          onPressed: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication).catchError((_) => false),
          icon: const Icon(Icons.open_in_new_rounded, size: 16),
          label: const Text('Where do I get this?'),
        ),
      );

  Future<void> _connect(J e) async {
    final auth = [for (final a in (e['auth'] as List? ?? const [])) a.toString()];
    final tok = _m(e['token']);
    final params = _l(e['params']);
    final token = TextEditingController();
    final pc = {for (final p in params) p['key'].toString(): TextEditingController()};
    var busy = false;
    await _sheet((ctx, set) {
      final t = ctx.t;
      J body(String a) => {
            'catalogId': e['id'],
            'auth': a,
            if (a == 'token') 'token': token.text.trim(),
            'params': {for (final p in pc.entries) if (p.value.text.trim().isNotEmpty) p.key: p.value.text.trim()},
          };
      Future<void> go(String a) async {
        if (a == 'token' && token.text.trim().isEmpty) return toast(ctx, 'Paste the token first');
        set(() => busy = true);
        final r = await _post('/api/connectors/add', body(a));
        if (!ctx.mounted) return;
        Navigator.pop(ctx);
        final c = _m(r?['connector']);
        if (c.isEmpty) return;
        if (a == 'oauth') {
          await _oauth(c['id'].toString());
        } else if (a == 'device') {
          await _device(c['id'].toString());
        } else if (mounted) {
          final (label, _) = connStatus(c);
          toast(context, '${c['name']}: $label');
        }
      }

      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [Glyph(e), const SizedBox(width: 12), Expanded(child: Text('Connect ${e['name']}', style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700)))]),
        const SizedBox(height: 8),
        Text((e['blurb'] ?? '').toString(), style: TextStyle(color: t.muted, fontSize: 14)),
        if ((e['note'] ?? '').toString().isNotEmpty) ...[const SizedBox(height: 6), Text(e['note'].toString(), style: TextStyle(color: t.faint, fontSize: 12.5))],
        for (final p in params) _field(pc[p['key'].toString()]!, '${p['label']} (optional)', hint: (p['placeholder'] ?? '').toString()),
        const SizedBox(height: 14),
        if (auth.contains('oauth')) FilledButton(onPressed: busy ? null : () => go('oauth'), child: Text('Sign in with ${e['name']}')),
        if (auth.contains('none')) FilledButton(onPressed: busy ? null : () => go('none'), child: const Text('Connect, no sign-in')),
        if (auth.contains('device')) ...[const SizedBox(height: 8), OutlinedButton(onPressed: busy ? null : () => go('device'), child: const Text('Sign in with a device code'))],
        if (auth.contains('token')) ...[
          const SizedBox(height: 14),
          Text(auth.length > 1 ? 'Or paste a token' : 'Paste a token', style: TextStyle(color: t.fg, fontWeight: FontWeight.w600)),
          _field(token, (tok['label'] ?? 'Token').toString(), hint: (tok['placeholder'] ?? '').toString(), secret: true),
          if ((tok['help'] ?? '').toString().isNotEmpty) _helpLink(tok['help'].toString()),
          OutlinedButton(onPressed: busy ? null : () => go('token'), child: const Text('Connect with token')),
        ],
        if (busy) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
      ]);
    });
  }

  /// The vendor sends the browser to `<server>/connectors-callback.html`, which finishes on its own
  /// when it is signed in to Bridge; otherwise the user pastes that address here.
  Future<void> _oauth(String id) async {
    final r = await _post('/api/connectors/oauth/start', {'id': id, 'redirectUri': '${store.api.base}/connectors-callback.html'});
    final url = (r?['authorizeUrl'] ?? '').toString();
    if (url.isEmpty) return;
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication).catchError((_) => false);
    if (!mounted) return;
    final pasted = TextEditingController();
    var busy = false;
    await _sheet((ctx, set) {
      final t = ctx.t;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Text('Finish signing in', style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Text('Approve Bridge in the page that just opened. If it does not come back here by itself, copy the address of the page you landed on and paste it below.', style: TextStyle(color: t.muted, fontSize: 14)),
        _field(pasted, 'Paste the address you landed on', hint: '…/connectors-callback.html?code=…'),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: busy
              ? null
              : () async {
                  set(() => busy = true);
                  final r = await _post('/api/connectors/oauth/finish', {'url': pasted.text.trim()});
                  if (!ctx.mounted) return;
                  set(() => busy = false);
                  if (r != null) {
                    Navigator.pop(ctx);
                    final (label, _) = connStatus(_m(r['connector']));
                    if (mounted) toast(context, label);
                  }
                },
          child: const Text('Finish'),
        ),
        TextButton(onPressed: () { Navigator.pop(ctx); _load(); }, child: const Text('It already says connected')),
        TextButton(onPressed: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication), child: const Text('Open the sign-in page again')),
      ]);
    });
    await _load();
  }

  Future<void> _device(String id) async {
    final r = await _post('/api/connectors/device/start', {'id': id});
    if (r == null || !mounted) return;
    final code = (r['user_code'] ?? '').toString(), uri = (r['verification_uri'] ?? '').toString();
    String state = 'waiting';
    Timer? tm;
    await _sheet((ctx, set) {
      tm ??= Timer.periodic(const Duration(seconds: 3), (_) async {
        try {
          final d = _m(_m(await store.api.getJson('/api/connectors/device', q: {'id': id}))['device']);
          if (ctx.mounted) set(() => state = (d['state'] ?? state).toString());
          if (state != 'waiting') tm?.cancel();
        } catch (_) {}
      });
      final t = ctx.t;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Text('Enter this code', style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700)),
        const SizedBox(height: 12),
        SelectableText(code, textAlign: TextAlign.center, style: TextStyle(color: t.accent, fontSize: 30, fontWeight: FontWeight.w800, letterSpacing: 4)),
        const SizedBox(height: 12),
        FilledButton(onPressed: () => launchUrl(Uri.parse(uri), mode: LaunchMode.externalApplication), child: Text('Open $uri')),
        const SizedBox(height: 8),
        Text(state == 'done' ? 'Signed in.' : state == 'error' ? 'That did not work. Try again.' : 'Waiting for you to approve…', textAlign: TextAlign.center, style: TextStyle(color: t.muted)),
      ]);
    });
    tm?.cancel();
    await _load();
  }

  Future<void> _addUrl() async {
    final name = TextEditingController(), url = TextEditingController(), token = TextEditingController();
    var auth = 'none';
    await _sheet((ctx, set) {
      final t = ctx.t;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Text('Any MCP server', style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700)),
        _field(name, 'Name', hint: 'My server'),
        _field(url, 'Server URL', hint: 'https://example.com/mcp'),
        const SizedBox(height: 10),
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'none', label: Text('No sign-in')), ButtonSegment(value: 'token', label: Text('Token')), ButtonSegment(value: 'oauth', label: Text('OAuth'))],
          selected: {auth},
          onSelectionChanged: (s) => set(() => auth = s.first),
        ),
        if (auth == 'token') _field(token, 'Bearer token', secret: true),
        const SizedBox(height: 14),
        FilledButton(
          onPressed: () async {
            final r = await _post('/api/connectors/add', {'name': name.text.trim(), 'url': url.text.trim(), 'auth': auth, if (auth == 'token') 'token': token.text.trim()});
            if (r == null || !ctx.mounted) return;
            Navigator.pop(ctx);
            if (auth == 'oauth') await _oauth(_m(r['connector'])['id'].toString());
          },
          child: const Text('Add'),
        ),
      ]);
    });
  }

  Future<void> _build() async {
    final name = TextEditingController(), base = TextEditingController(), spec = TextEditingController(), authName = TextEditingController(), token = TextEditingController(), words = TextEditingController();
    var mode = 'api', authKind = 'none';
    await _sheet((ctx, set) {
      final t = ctx.t;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Text('Build a connector', style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        Text('Claude writes a small MCP server for it, then Bridge starts it and lists its tools. You can read and change the code.', style: TextStyle(color: t.muted, fontSize: 13.5)),
        const SizedBox(height: 12),
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'api', label: Text('From an API')), ButtonSegment(value: 'words', label: Text('Describe it'))],
          selected: {mode},
          onSelectionChanged: (s) => set(() => mode = s.first),
        ),
        _field(name, 'Name', hint: 'Weather'),
        if (mode == 'words') _field(words, 'What should it do?', hint: 'Look up today\'s padel court bookings from …', lines: 4),
        _field(base, mode == 'api' ? 'API base URL' : 'API base URL (optional)', hint: 'https://api.example.com/v1'),
        if (mode == 'api') _field(spec, 'OpenAPI spec URL (optional)', hint: 'https://api.example.com/openapi.json'),
        const SizedBox(height: 10),
        DropdownButtonFormField<String>(
          initialValue: authKind,
          decoration: const InputDecoration(labelText: 'Auth', border: OutlineInputBorder()),
          items: const [
            DropdownMenuItem(value: 'none', child: Text('None')),
            DropdownMenuItem(value: 'bearer', child: Text('Bearer token')),
            DropdownMenuItem(value: 'header', child: Text('API key in a header')),
            DropdownMenuItem(value: 'query', child: Text('API key in the query')),
          ],
          onChanged: (v) => set(() => authKind = v ?? 'none'),
        ),
        if (authKind == 'header' || authKind == 'query') _field(authName, authKind == 'header' ? 'Header name' : 'Query parameter', hint: authKind == 'header' ? 'x-api-key' : 'api_key'),
        if (authKind != 'none') _field(token, 'Token / key', secret: true),
        const SizedBox(height: 14),
        FilledButton(
          onPressed: () async {
            final r = await _post('/api/connectors/add', {
              'name': name.text.trim(),
              'local': {
                'mode': mode,
                'baseUrl': base.text.trim(),
                'authKind': authKind,
                'authName': authName.text.trim(),
                if (mode == 'api') 'spec': spec.text.trim(),
                if (mode == 'words') 'description': words.text.trim(),
              },
              if (authKind != 'none') 'token': token.text.trim(),
            });
            if (r == null || !ctx.mounted) return;
            Navigator.pop(ctx);
            final id = _m(r['connector'])['id'];
            if (id != null) _detail(id.toString());
          },
          child: const Text('Build it'),
        ),
      ]);
    });
  }

  Future<void> _detail(String id) async {
    Timer? tm;
    String code = '';
    bool showCode = false;
    final token = TextEditingController();
    await _sheet((ctx, set) {
      final c = _conns.cast<J?>().firstWhere((x) => x!['id'] == id, orElse: () => null);
      if (c == null) return const SizedBox(height: 80);
      final t = ctx.t;
      final generating = c['generating'] == true || c['status'] == 'generating';
      if (generating) {
        tm ??= Timer.periodic(const Duration(seconds: 2), (_) async {
          await _load();
          final now = _conns.cast<J?>().firstWhere((x) => x!['id'] == id, orElse: () => null);
          if (ctx.mounted) set(() {});
          if (now == null || !(now['generating'] == true || now['status'] == 'generating')) { tm?.cancel(); tm = null; }
        });
      }
      final (label, kind) = connStatus(c);
      final entry = _entry(c['catalogId']?.toString());
      final help = _m(entry?['token'])['help']?.toString() ?? '';
      final secret = _m(c['secret']);
      final remote = c['kind'] == 'remote';
      final canOAuth = remote && (entry == null ? c['auth'] == 'oauth' : (entry['auth'] as List? ?? const []).contains('oauth'));
      final canToken = c['auth'] != 'none' || (entry != null && (entry['auth'] as List? ?? const []).contains('token'));
      Future<void> act(String path) async {
        await _post(path, {'id': id});
        if (ctx.mounted) set(() {});
      }

      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          Glyph(c),
          const SizedBox(width: 12),
          Expanded(child: Text((c['name'] ?? '').toString(), style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700))),
          Tag(label, kind: kind),
        ]),
        const SizedBox(height: 8),
        Text(remote ? (c['url'] ?? '').toString() : 'Self-made · ${_m(c['local'])['baseUrl'] ?? ''}', style: TextStyle(color: t.faint, fontSize: 12.5)),
        if (secret.isNotEmpty) Text('Signed in (${secret['kind']}) · ${secret['hint']}', style: TextStyle(color: t.muted, fontSize: 12.5)),
        if ((c['error'] ?? '').toString().isNotEmpty) ...[const SizedBox(height: 6), Text(c['error'].toString(), style: TextStyle(color: t.err, fontSize: 13))],
        if (generating || (_m(c['gen'])['log'] ?? '').toString().isNotEmpty && c['kind'] == 'local') ...[
          const SizedBox(height: 10),
          if (generating) const LinearProgressIndicator(),
          Container(
            margin: const EdgeInsets.only(top: 6),
            padding: const EdgeInsets.all(10),
            constraints: const BoxConstraints(maxHeight: 220),
            decoration: BoxDecoration(color: t.code, borderRadius: BorderRadius.circular(10), border: Border.all(color: t.border)),
            child: SingleChildScrollView(reverse: true, child: Text((_m(c['gen'])['log'] ?? '').toString(), style: TextStyle(color: t.muted, fontSize: 12, fontFamily: 'monospace'))),
          ),
        ],
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          FilledButton.tonal(onPressed: generating ? null : () => act('/api/connectors/test'), child: const Text('Test')),
          if (canOAuth) OutlinedButton(onPressed: () { Navigator.pop(ctx); _oauth(id); }, child: const Text('Sign in')),
          if (c['kind'] == 'local')
            OutlinedButton(
              onPressed: () async {
                if (!showCode) code = (_m(await store.api.getJson('/api/connectors/code', q: {'id': id}))['code'] ?? '').toString();
                if (ctx.mounted) set(() => showCode = !showCode);
              },
              child: Text(showCode ? 'Hide code' : 'Code'),
            ),
          if (secret.isNotEmpty) OutlinedButton(onPressed: () => act('/api/connectors/disconnect'), child: const Text('Disconnect')),
          TextButton(
            onPressed: () async {
              await _post('/api/connectors/remove', {'id': id});
              if (ctx.mounted) Navigator.pop(ctx);
            },
            child: Text('Remove', style: TextStyle(color: t.err)),
          ),
        ]),
        if (canToken) ...[
          const SizedBox(height: 10),
          _field(token, secret.isEmpty ? 'Paste a token' : 'Replace the token', secret: true),
          if (help.isNotEmpty) _helpLink(help),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton(
              onPressed: () async {
                if (token.text.trim().isEmpty) return;
                await _post('/api/connectors/token', {'id': id, 'token': token.text.trim()});
                token.clear();
                if (ctx.mounted) set(() {});
              },
              child: const Text('Save token'),
            ),
          ),
        ],
        if (showCode)
          Container(
            margin: const EdgeInsets.only(top: 10),
            padding: const EdgeInsets.all(10),
            constraints: const BoxConstraints(maxHeight: 360),
            decoration: BoxDecoration(color: t.code, borderRadius: BorderRadius.circular(10), border: Border.all(color: t.border)),
            child: SingleChildScrollView(child: SelectableText(code, style: TextStyle(color: t.fg, fontSize: 11.5, fontFamily: 'monospace'))),
          ),
        const SizedBox(height: 12),
        SectionHeader('Tools', count: _l(c['tools']).length),
        for (final tool in _l(c['tools']))
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text((tool['name'] ?? '').toString(), style: TextStyle(color: t.fg, fontSize: 13.5, fontWeight: FontWeight.w600, fontFamily: 'monospace')),
              if ((tool['description'] ?? '').toString().isNotEmpty) Text(tool['description'].toString().split('\n').first, style: TextStyle(color: t.muted, fontSize: 12.5)),
            ]),
          ),
        if (_l(c['tools']).isEmpty) Text('Press Test to list what it can do.', style: TextStyle(color: t.faint, fontSize: 13)),
      ]);
    });
    tm?.cancel();
  }
}

/// Which connectors this chat gets. A switch here overrides the folder and the default.
Future<void> showChatConnectors(BuildContext context, {required String sessionId, required String cwd, String computer = 'mac'}) async {
  final api = AppStore.instance.api;
  List<J> scopes = [], conns = [];
  String err = '';
  Future<void> load() async {
    try {
      final j = _m(await api.getJson('/api/connectors/scopes', q: {'session': sessionId, 'cwd': cwd, if (computer == 'cloud') 'computer': 'cloud'}));
      scopes = _l(j['scopes']);
      conns = _l(j['connectors']);
      err = '';
    } catch (e) {
      err = e.toString();
    }
  }

  await load();
  if (!context.mounted) return;
  await showModalBottomSheet(
    context: context,
    backgroundColor: context.t.raised,
    builder: (ctx) => StatefulBuilder(builder: (ctx, set) {
      final t = ctx.t;
      return SafeArea(
        child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(8, 14, 8, 14), children: [
          Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: Text('Connectors in this chat', style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700))),
          Padding(padding: const EdgeInsets.fromLTRB(12, 4, 12, 8), child: Text('Applies from the next message.', style: TextStyle(color: t.muted, fontSize: 13))),
          if (err.isNotEmpty) Padding(padding: const EdgeInsets.all(12), child: Text(err, style: TextStyle(color: t.err))),
          if (scopes.isEmpty && err.isEmpty) Padding(padding: const EdgeInsets.all(12), child: Text('No connectors yet. Add them in Settings › Connectors.', style: TextStyle(color: t.muted))),
          for (final s in scopes)
            Builder(builder: (_) {
              final c = conns.cast<J?>().firstWhere((x) => x!['id'] == s['id'], orElse: () => null) ?? {'name': s['id']};
              return SwitchListTile(
                secondary: Glyph(c, size: 30),
                title: Text((c['name'] ?? '').toString(), style: TextStyle(color: t.fg)),
                subtitle: Text(s['ready'] == true ? '${c['tools'] ?? 0} tools${s['chat'] != null ? ' · set for this chat' : ''}' : 'Not ready: sign in first', style: TextStyle(color: t.muted, fontSize: 12.5)),
                value: s['on'] == true,
                onChanged: (v) async {
                  try {
                    await api.postJson('/api/connectors/scope', {'id': s['id'], 'kind': 'chat', 'key': sessionId, 'on': v, if (computer == 'cloud') 'computer': 'cloud'});
                    await load();
                  } catch (e) {
                    err = e.toString();
                  }
                  if (ctx.mounted) set(() {});
                },
              );
            }),
        ]),
      );
    }),
  );
}
