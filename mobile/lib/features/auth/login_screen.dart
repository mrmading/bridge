/// Sign in to Bridge: email → magic link. On the web the link comes back to this page and signs
/// in by itself; in the native app you paste the link (or the code) from the email.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/orb.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _store = AppStore.instance;
  final _email = TextEditingController();
  final _paste = TextEditingController();
  bool _busy = false;
  bool _sent = false;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _error = _store.authError;
    _email.text = _store.session?.email ?? _store.lastEmail;
  }

  @override
  void dispose() {
    _email.dispose();
    _paste.dispose();
    super.dispose();
  }

  bool get _emailOk => RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(_email.text.trim());

  Future<void> _send() async {
    if (!_emailOk) {
      setState(() => _error = 'Enter your email address');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await _store.sendSignInLink(_email.text);
      if (mounted) setState(() => _sent = true);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await _store.signInWithPasted(_paste.text, email: _email.text);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Scaffold(
      backgroundColor: t.bg,
      body: Stack(children: [
        const Bloom(height: 520),
        SafeArea(
          child: Center(
            child: SingleChildScrollView(
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Stack(alignment: Alignment.center, children: [
                    Orb(phase: _busy ? 'thinking' : 'idle', color: _store.accent, size: 170),
                    const BrandMark(size: 44),
                  ]),
                  const SizedBox(height: 8),
                  Text(_sent ? 'Check your email' : 'Sign in to Bridge', style: TextStyle(color: t.fg, fontSize: 26, fontWeight: FontWeight.w600, letterSpacing: -.4)),
                  const SizedBox(height: 8),
                  Text(
                    _sent
                        ? 'We sent a sign-in link to ${_email.text.trim()}. ${kIsWeb ? 'Open it on this device and you are in.' : 'Open it, or paste the link or code here.'}'
                        : 'Your chats, your team, from anywhere. We email you a link; no password.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: t.muted, fontSize: 15, height: 1.45),
                  ),
                  const SizedBox(height: 24),
                  if (!_sent) ..._emailStep(context) else ..._sentStep(context),
                  if (_error.isNotEmpty) ...[
                    const SizedBox(height: 14),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: t.errSoft, borderRadius: BorderRadius.circular(12)),
                      child: Text(_error, style: TextStyle(color: t.err, fontSize: 13.5)),
                    ),
                  ],
                  const SizedBox(height: 28),
                  Text(_store.serverHost, style: TextStyle(color: t.faint, fontSize: 12)),
                ]),
              ),
            ),
          ),
        ),
      ]),
    );
  }

  List<Widget> _emailStep(BuildContext context) => [
        TextField(
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          autofillHints: const [AutofillHints.email],
          autocorrect: false,
          textInputAction: TextInputAction.send,
          onChanged: (_) => setState(() {}),
          onSubmitted: (_) => _send(),
          style: TextStyle(color: context.t.fg, fontSize: 16),
          decoration: const InputDecoration(hintText: 'you@company.com', prefixIcon: Icon(Icons.mail_outline_rounded)),
        ),
        const SizedBox(height: 12),
        _primary(context, label: 'Email me a sign-in link', onTap: _busy ? null : _send),
      ];

  List<Widget> _sentStep(BuildContext context) {
    final t = context.t;
    return [
      if (!kIsWeb) ...[
        TextField(
          controller: _paste,
          autocorrect: false,
          enableSuggestions: false,
          minLines: 1,
          maxLines: 3,
          onChanged: (_) => setState(() {}),
          style: TextStyle(color: t.fg, fontSize: 15),
          decoration: InputDecoration(
            hintText: 'Paste the link or code from the email',
            prefixIcon: const Icon(Icons.link_rounded),
            suffixIcon: IconButton(
              tooltip: 'Paste',
              icon: const Icon(Icons.content_paste_rounded),
              onPressed: () async {
                final d = await Clipboard.getData(Clipboard.kTextPlain);
                if (d?.text != null) setState(() => _paste.text = d!.text!);
              },
            ),
          ),
        ),
        const SizedBox(height: 12),
        _primary(context, label: 'Sign in', onTap: _busy || _paste.text.trim().isEmpty ? null : _verify),
        const SizedBox(height: 8),
      ] else
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: t.raised, borderRadius: BorderRadius.circular(14), border: Border.all(color: t.border)),
          child: Row(children: [
            Icon(Icons.mark_email_read_outlined, color: t.accent),
            const SizedBox(width: 12),
            Expanded(child: Text('The link signs you in right here. You can close this tab.', style: TextStyle(color: t.muted, fontSize: 13.5))),
          ]),
        ),
      const SizedBox(height: 4),
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        TextButton(onPressed: _busy ? null : _send, child: const Text('Send it again')),
        Text('·', style: TextStyle(color: t.faint)),
        TextButton(onPressed: _busy ? null : () => setState(() => _sent = false), child: const Text('Use a different email')),
      ]),
    ];
  }

  Widget _primary(BuildContext context, {required String label, VoidCallback? onTap}) {
    final t = context.t;
    return SizedBox(
      width: double.infinity,
      height: 50,
      child: FilledButton(
        onPressed: onTap,
        style: FilledButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)), textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
        child: _busy ? SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2, color: t.accentFg)) : Text(label),
      ),
    );
  }
}
