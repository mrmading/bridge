/// Settings: General (appearance, Claude account) · Voice · Defaults (teammate, freedom, model) ·
/// Computers (this Bridge server) · Advanced (technical details, the assistant's desk, folders,
/// global instructions) · About.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';
import '../../widgets/composer.dart';
import '../files/file_screen.dart';
import '../session/session_utils.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final store = AppStore.instance;
  late final TextEditingController _url = TextEditingController(text: store.serverUrl);
  final TextEditingController _code = TextEditingController();

  bool _testing = false;
  String _testMsg = '';
  bool _testOk = false;

  // sign-in flow
  bool _starting = false;
  String? _loginUrl;
  bool _submitting = false;
  String _authMsg = '';
  bool _restart = false;

  // desk
  DaState? _da;
  bool _deskBusy = false;
  String _deskBase = '';

  @override
  void initState() {
    super.initState();
    store.addListener(_onStore);
    _onStore();
    store.refreshComputers();
  }

  @override
  void dispose() {
    store.removeListener(_onStore);
    _url.dispose();
    _code.dispose();
    super.dispose();
  }

  void _onStore() {
    final base = store.hasServer && store.conn == ConnState.ready ? store.api.base : '';
    if (base != _deskBase) {
      _deskBase = base;
      _da = null;
      if (base.isNotEmpty) _loadDesk();
    }
    if (mounted) setState(() {});
  }

  Future<void> _loadDesk() async {
    try {
      final d = await store.api.daState();
      if (mounted) setState(() => _da = d);
    } catch (_) {}
  }

  // ── server ──

  Future<void> _testAndSave() async {
    final url = _url.text.trim();
    if (url.isEmpty) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _testing = true;
      _testMsg = '';
    });
    final ok = await store.connect(url);
    if (!mounted) return;
    setState(() {
      _testing = false;
      _testOk = ok;
      _testMsg = ok ? 'Connected to ${store.boot?.assistant ?? 'Bridge'} · Claude Code ${store.boot?.version ?? ''}'.trim() : store.connError;
    });
  }

  Future<void> _forget() async {
    final yes = await _confirm('Forget this server?', 'You will need to enter the address again to reconnect.', 'Forget');
    if (yes) await store.forgetServer();
  }

  // ── account ──

  Future<void> _startLogin() async {
    setState(() {
      _starting = true;
      _authMsg = '';
      _restart = false;
      _loginUrl = null;
      _code.clear();
    });
    try {
      final url = await store.api.authLogin();
      if (!mounted) return;
      setState(() => _loginUrl = url);
      await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication).catchError((_) => false);
    } catch (e) {
      if (mounted) setState(() => _authMsg = e.toString());
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  Future<void> _submitCode() async {
    final code = _code.text.replaceAll(RegExp(r'\s+'), '');
    if (code.isEmpty) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _submitting = true;
      _authMsg = '';
    });
    try {
      final r = await store.api.authCode(code);
      if (!mounted) return;
      if (r.ok) {
        setState(() {
          _loginUrl = null;
          _code.clear();
        });
        await store.refreshAuth();
        if (mounted) toast(context, 'Signed in');
      } else {
        setState(() {
          _authMsg = r.message.isEmpty ? 'Sign-in failed' : r.message;
          _restart = r.restart;
          if (r.restart) _loginUrl = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _authMsg = e.toString());
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _cancelLogin() async {
    try {
      await store.api.authCancel();
    } catch (_) {}
    if (mounted) {
      setState(() {
        _loginUrl = null;
        _authMsg = '';
        _code.clear();
      });
    }
  }

  Future<void> _logout() async {
    final yes = await _confirm('Sign out of Claude?', 'This signs out every Claude Code session on the server machine, not only this phone.', 'Sign out');
    if (!yes) return;
    try {
      await store.api.authLogout();
    } catch (e) {
      if (mounted) toast(context, 'Sign out failed: $e');
    }
    await store.refreshAuth();
  }

  // ── desk ──

  Future<void> _setDesk({String? permissionMode, String? model}) async {
    setState(() => _deskBusy = true);
    try {
      final d = await store.api.daConfig(permissionMode: permissionMode, model: model);
      if (mounted) {
        setState(() => _da = d);
        toast(context, 'Saved. A new conversation started.');
      }
    } catch (e) {
      if (mounted) toast(context, 'Could not change it: $e');
    } finally {
      if (mounted) setState(() => _deskBusy = false);
    }
  }

  Future<void> _resetDesk() async {
    final yes = await _confirm('Reset the conversation?', '${store.assistantName} starts fresh and forgets this conversation.', 'Reset');
    if (!yes) return;
    setState(() => _deskBusy = true);
    try {
      final d = await store.api.daReset();
      if (mounted) {
        setState(() => _da = d);
        toast(context, 'New conversation started');
      }
    } catch (e) {
      if (mounted) toast(context, 'Reset failed: $e');
    } finally {
      if (mounted) setState(() => _deskBusy = false);
    }
  }

  Future<bool> _confirm(String title, String body, String action) async {
    final t = context.t;
    final r = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: t.raised,
        title: Text(title, style: TextStyle(color: t.fg, fontSize: 18, fontWeight: FontWeight.w700)),
        content: Text(body, style: TextStyle(color: t.muted, fontSize: 15)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: Text(action, style: TextStyle(color: t.err))),
        ],
      ),
    );
    return r == true;
  }

  // ── ui ──

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(titleSpacing: 0, title: const Text('Settings')),
      body: ListView(
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          ..._appearance(context),
          ..._account(context),
          ..._voice(context),
          ..._defaults(context),
          ..._server(context),
          ..._advanced(context),
          ..._desk(context),
          ..._about(context),
        ],
      ),
    );
  }

  List<Widget> _server(BuildContext context) {
    final t = context.t;
    final ready = store.conn == ConnState.ready;
    return [
      const SectionHeader('Computers'),
      Card2(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(children: [
          for (final c in store.computers) ...[
            ListTile(
              leading: Icon(c.isCloud ? Icons.cloud_outlined : Icons.laptop_mac_rounded, color: c.online ? t.accent : t.faint),
              title: Text(store.computerLabel(c.id), style: TextStyle(color: t.fg, fontSize: 16)),
              subtitle: Text(
                [
                  if (!c.online && c.reason.isNotEmpty) c.reason else (c.isCloud ? 'Keeps working when your Mac sleeps or the app is closed' : 'Fast, uses your local tools and simulators'),
                  if (c.url.isNotEmpty) Uri.tryParse(c.url)?.host ?? c.url,
                  if (store.computer == c.id) 'New chats run here',
                ].join(' · '),
                style: TextStyle(color: t.muted, fontSize: 13),
              ),
              trailing: c.online && (c.isCloud || ready) ? const Tag('Online', kind: 'ok') : const Tag('Offline', kind: 'warn'),
            ),
            Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
          ],
          if (!store.hasCloud) ...[
            ListTile(
              leading: Icon(Icons.cloud_off_outlined, color: t.faint),
              title: Text('Cloud computer', style: TextStyle(color: t.fg, fontSize: 16)),
              subtitle: Text('Not set up on this Bridge', style: TextStyle(color: t.muted, fontSize: 13)),
            ),
            Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
          ],
          ListTile(
            leading: Icon(Icons.devices_rounded, color: t.muted),
            title: Text('Same chats everywhere', style: TextStyle(color: t.fg, fontSize: 16)),
            subtitle: Text('Desktop, phone and web are one Bridge. Every chat starts here; no terminal, no syncing.', style: TextStyle(color: t.muted, fontSize: 13)),
          ),
        ]),
      ),
      Card2(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          TextField(
            controller: _url,
            keyboardType: TextInputType.url,
            autocorrect: false,
            textInputAction: TextInputAction.go,
            onSubmitted: (_) => _testAndSave(),
            style: TextStyle(color: t.fg, fontSize: 16),
            decoration: const InputDecoration(hintText: 'http://your-mac.local:4270', labelText: 'Bridge address'),
          ),
          const SizedBox(height: 10),
          Row(children: [
            if (ready) ...[StatusPill('connected', kind: 'running'), const SizedBox(width: 8)] else if (store.conn == ConnState.connecting) ...[const StatusPill('connecting'), const SizedBox(width: 8)],
            const Spacer(),
            if (store.hasServer) TextButton(onPressed: _forget, style: TextButton.styleFrom(foregroundColor: t.err, minimumSize: const Size(44, 44)), child: const Text('Forget server')),
            const SizedBox(width: 4),
            FilledButton(
              onPressed: _testing ? null : _testAndSave,
              style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
              child: _testing ? SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2, color: t.accentFg)) : const Text('Test & save'),
            ),
          ]),
          if (_testMsg.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(_testMsg, style: TextStyle(color: _testOk ? t.ok : t.err, fontSize: 13)),
          ] else if (ready && store.boot != null) ...[
            const SizedBox(height: 8),
            Text('${store.boot!.assistant} · ${store.boot!.user}@${Uri.tryParse(store.api.base)?.host ?? ''}', style: TextStyle(color: t.muted, fontSize: 13)),
          ],
        ]),
      ),
    ];
  }

  List<Widget> _account(BuildContext context) {
    final t = context.t;
    final a = store.auth;
    final ready = store.conn == ConnState.ready;
    final details = [if (a.email.isNotEmpty) a.email, if (a.orgName.isNotEmpty) a.orgName, if (a.subscriptionType.isNotEmpty) a.subscriptionType].join(' · ');
    return [
      SectionHeader('Claude account', trailing: ready ? _smallButton(context, 'Refresh', store.refreshAuth) : null),
      Card2(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            StatusDot(a.loggedIn ? t.ok : t.faint, size: 9, glow: a.loggedIn),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(a.loggedIn ? 'Signed in' : 'Not signed in', style: TextStyle(color: t.fg, fontSize: 16, fontWeight: FontWeight.w600)),
                if (details.isNotEmpty) Text(details, style: TextStyle(color: t.muted, fontSize: 13)),
                if (a.keyAuth) Text('Using an API key from the server environment', style: TextStyle(color: t.muted, fontSize: 13)),
                if (!a.cli) Text('Claude Code is not installed on the server', style: TextStyle(color: t.err, fontSize: 13)),
                if (a.error.isNotEmpty) Text(a.error, style: TextStyle(color: t.warn, fontSize: 13)),
              ]),
            ),
            if (ready && a.loggedIn && !a.keyAuth) TextButton(onPressed: _logout, style: TextButton.styleFrom(foregroundColor: t.err, minimumSize: const Size(44, 44)), child: const Text('Sign out')),
          ]),
          if (ready && !a.loggedIn) ...[
            const SizedBox(height: 12),
            if (_loginUrl == null)
              FilledButton.icon(
                onPressed: _starting ? null : _startLogin,
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                icon: _starting ? SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2, color: t.accentFg)) : const Icon(Icons.login_rounded),
                label: Text(_restart ? 'Start again' : 'Sign in with Claude'),
              )
            else
              ..._codeStep(context),
          ],
          if (_authMsg.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(_authMsg, style: TextStyle(color: t.err, fontSize: 13)),
          ],
        ]),
      ),
    ];
  }

  List<Widget> _codeStep(BuildContext context) {
    final t = context.t;
    return [
      Text('1. Approve in the browser that just opened. If nothing opened, use this link:', style: TextStyle(color: t.muted, fontSize: 13)),
      const SizedBox(height: 6),
      Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: t.code, borderRadius: BorderRadius.circular(10), border: Border.all(color: t.border)),
        child: Row(children: [
          Expanded(child: SelectableText(_loginUrl!, maxLines: 3, style: TextStyle(color: t.accent, fontSize: 12.5, fontFamily: 'monospace'))),
          IconButton(
            tooltip: 'Copy link',
            onPressed: () {
              Clipboard.setData(ClipboardData(text: _loginUrl!));
              toast(context, 'Link copied');
            },
            icon: Icon(Icons.copy_rounded, size: 18, color: t.muted),
            constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
          ),
          IconButton(
            tooltip: 'Open link',
            onPressed: () => launchUrl(Uri.parse(_loginUrl!), mode: LaunchMode.externalApplication),
            icon: Icon(Icons.open_in_new_rounded, size: 18, color: t.muted),
            constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
          ),
        ]),
      ),
      const SizedBox(height: 12),
      Text('2. Paste the code the page shows you:', style: TextStyle(color: t.muted, fontSize: 13)),
      const SizedBox(height: 6),
      TextField(
        controller: _code,
        enabled: !_submitting,
        autocorrect: false,
        enableSuggestions: false,
        textInputAction: TextInputAction.done,
        onSubmitted: (_) => _submitCode(),
        style: TextStyle(color: t.fg, fontSize: 15, fontFamily: 'monospace'),
        decoration: const InputDecoration(hintText: 'Paste code'),
      ),
      const SizedBox(height: 10),
      Row(children: [
        TextButton(onPressed: _submitting ? null : _cancelLogin, style: TextButton.styleFrom(minimumSize: const Size(44, 44)), child: const Text('Cancel')),
        const Spacer(),
        FilledButton(
          onPressed: _submitting ? null : _submitCode,
          style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
          child: _submitting
              ? Row(mainAxisSize: MainAxisSize.min, children: [
                  SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2, color: t.accentFg)),
                  const SizedBox(width: 10),
                  const Text('Confirming…'),
                ])
              : const Text('Finish sign-in'),
        ),
      ]),
      if (_submitting) Padding(padding: const EdgeInsets.only(top: 6), child: Text('This can take up to two minutes.', style: TextStyle(color: t.faint, fontSize: 12))),
    ];
  }

  List<Widget> _voice(BuildContext context) {
    final t = context.t;
    final tts = switch (store.voice.tts) {
      'elevenlabs' => 'ElevenLabs, from the server',
      'kokoro' => 'Kokoro, from the server',
      'pulse' => 'Pulse, plays on the server Mac',
      _ => 'on this phone',
    };
    return [
      const SectionHeader('Voice'),
      Card2(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(children: [
          SwitchListTile(
            value: store.speakReplies,
            onChanged: store.setSpeak,
            title: Text('Speak replies', style: TextStyle(color: t.fg, fontSize: 16)),
            subtitle: Text('Read answers aloud when they finish', style: TextStyle(color: t.muted, fontSize: 13)),
          ),
          Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
          SwitchListTile(
            value: store.handsFree,
            onChanged: store.setHandsFree,
            title: Text('Hands-free', style: TextStyle(color: t.fg, fontSize: 16)),
            subtitle: Text('Start listening again after a spoken reply', style: TextStyle(color: t.muted, fontSize: 13)),
          ),
          Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
          _infoRow(context, 'Voice', tts),
          _infoRow(context, 'Listening', 'on this phone'),
        ]),
      ),
    ];
  }

  List<Widget> _appearance(BuildContext context) {
    return [
      const SectionHeader('General'),
      Card2(
        child: SizedBox(
          width: double.infinity,
          child: SegmentedButton<ThemeMode>(
            segments: const [
              ButtonSegment(value: ThemeMode.system, label: Text('System'), icon: Icon(Icons.brightness_auto_rounded)),
              ButtonSegment(value: ThemeMode.dark, label: Text('Dark'), icon: Icon(Icons.dark_mode_rounded)),
              ButtonSegment(value: ThemeMode.light, label: Text('Light'), icon: Icon(Icons.light_mode_rounded)),
            ],
            selected: {store.themeMode},
            showSelectedIcon: false,
            onSelectionChanged: (s) => store.setTheme(s.first),
          ),
        ),
      ),
    ];
  }

  List<Widget> _defaults(BuildContext context) {
    final t = context.t;
    final turn = store.turn;
    Widget row(String title, String value, VoidCallback onTap, {Widget? lead}) => ListTile(
          onTap: onTap,
          minTileHeight: 52,
          leading: lead,
          title: Text(title, style: TextStyle(color: t.fg, fontSize: 16)),
          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(value, style: TextStyle(color: t.muted, fontSize: 14)),
            Icon(Icons.chevron_right_rounded, color: t.faint),
          ]),
        );
    return [
      const SectionHeader('Defaults for new messages'),
      Card2(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(children: [
          row('Teammate', agentLabel(turn.agent), () => showAgentSheet(context)),
          Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
          row('Freedom', modeInfo(turn.permissionMode).label, () => showModeSheet(context)),
          Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
          row('Model', '${modelLabel(turn.model)} · ${effortLabel(turn.effort)}', () => showModelSheet(context)),
        ]),
      ),
    ];
  }

  List<Widget> _advanced(BuildContext context) {
    final t = context.t;
    final home = store.boot?.home ?? '';
    return [
      const SectionHeader('Advanced'),
      Card2(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(children: [
          SwitchListTile(
            value: store.showTech,
            onChanged: store.setShowTech,
            title: Text('Show technical details', style: TextStyle(color: t.fg, fontSize: 16)),
            subtitle: Text('Raw tool calls, thinking and hooks in every chat', style: TextStyle(color: t.muted, fontSize: 13)),
          ),
          if (home.isNotEmpty) ...[
            Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
            ListTile(
              minTileHeight: 52,
              onTap: () => Nav.instance.push(FileScreen(path: '$home/.claude/CLAUDE.md')),
              title: Text('Global instructions', style: TextStyle(color: t.fg, fontSize: 16)),
              subtitle: Text('~/.claude/CLAUDE.md', style: TextStyle(color: t.muted, fontSize: 13)),
              trailing: Icon(Icons.chevron_right_rounded, color: t.faint),
            ),
          ],
          Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Folders Bridge can see', style: TextStyle(color: t.fg, fontSize: 16)),
              const SizedBox(height: 4),
              if (store.roots.isEmpty) Text('None yet. Add them in Bridge on your computer.', style: TextStyle(color: t.muted, fontSize: 13)),
              for (final r in store.roots)
                InkWell(
                  onTap: () => Nav.instance.push(FileScreen(path: r, isDir: true)),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Row(children: [
                      Icon(Icons.folder_outlined, size: 17, color: t.muted),
                      const SizedBox(width: 8),
                      Expanded(child: Text(prettyPath(r), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 13.5))),
                    ]),
                  ),
                ),
            ]),
          ),
        ]),
      ),
    ];
  }

  List<Widget> _desk(BuildContext context) {
    final t = context.t;
    final ready = store.conn == ConnState.ready;
    final modes = store.boot?.permissionModes ?? const ['acceptEdits', 'plan', 'bypassPermissions'];
    final models = ['', ...?store.boot?.models];
    final mode = _da?.permissionMode ?? '';
    final model = _da?.model ?? '';
    return [
      SectionHeader('${store.assistantName} (Talk)', trailing: _deskBusy ? SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 2, color: t.muted)) : null),
      Card2(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(children: [
          _pickerRow<String>(
            context,
            title: 'Permission mode',
            value: modes.contains(mode) ? mode : null,
            items: {for (final m in modes) m: _modeLabel(m)},
            enabled: ready && !_deskBusy && _da != null,
            onChanged: (v) => _setDesk(permissionMode: v),
          ),
          Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
          _pickerRow<String>(
            context,
            title: 'Model',
            value: models.contains(model) ? model : null,
            items: {for (final m in models) m: m.isEmpty ? 'Default' : m},
            enabled: ready && !_deskBusy && _da != null,
            onChanged: (v) => _setDesk(model: v),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 2, 16, 8),
            child: Align(alignment: Alignment.centerLeft, child: Text('Changing either starts a new conversation.', style: TextStyle(color: t.warn, fontSize: 12.5))),
          ),
          Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
          ListTile(
            enabled: ready && !_deskBusy,
            onTap: _resetDesk,
            minTileHeight: 52,
            leading: Icon(Icons.restart_alt_rounded, color: t.err),
            title: Text('Reset conversation', style: TextStyle(color: t.err, fontSize: 16)),
          ),
        ]),
      ),
    ];
  }

  static String _modeLabel(String m) => switch (m) {
        'acceptEdits' => 'Accept edits',
        'auto' => 'Auto',
        'plan' => 'Plan',
        'bypassPermissions' => 'Bypass permissions',
        'manual' => 'Manual',
        'dontAsk' => 'Don\'t ask',
        _ => m,
      };

  List<Widget> _about(BuildContext context) {
    return [
      const SectionHeader('About'),
      Card2(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(children: [
          _infoRow(context, 'Claude Code on server', (store.boot?.version ?? '').isEmpty ? 'unknown' : store.boot!.version),
          _infoRow(context, 'App', 'Bridge Mobile 0.2'),
        ]),
      ),
    ];
  }

  Widget _infoRow(BuildContext context, String label, String value) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
      child: Row(children: [
        Text(label, style: TextStyle(color: t.fg, fontSize: 16)),
        const SizedBox(width: 12),
        Expanded(child: Text(value, textAlign: TextAlign.right, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 14))),
      ]),
    );
  }

  Widget _pickerRow<T>(BuildContext context, {required String title, required T? value, required Map<T, String> items, required bool enabled, required ValueChanged<T> onChanged}) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
      child: Row(children: [
        Expanded(child: Text(title, style: TextStyle(color: enabled ? t.fg : t.faint, fontSize: 16))),
        DropdownButton<T>(
          value: value,
          hint: Text('…', style: TextStyle(color: t.faint)),
          underline: const SizedBox.shrink(),
          dropdownColor: t.raised,
          borderRadius: BorderRadius.circular(12),
          style: TextStyle(color: t.muted, fontSize: 15),
          items: [for (final e in items.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
          onChanged: enabled
              ? (v) {
                  if (v != null && v != value) onChanged(v);
                }
              : null,
        ),
      ]),
    );
  }

  Widget _smallButton(BuildContext context, String label, Future<void> Function() onTap) {
    final t = context.t;
    return TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(foregroundColor: t.accent, minimumSize: const Size(44, 32), padding: const EdgeInsets.symmetric(horizontal: 8)),
      child: Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
    );
  }
}
