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
                        ? 'Enter the 6-digit code we sent to ${_email.text.trim()}.'
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

  /// The 6-digit code is the main path (native apps and home-screen web apps cannot catch the link);
  /// the link is the fallback, and a pasted link works in the same field.
  List<Widget> _sentStep(BuildContext context) {
    final t = context.t;
    final code = _paste.text.replaceAll(RegExp(r'\s'), '');
    final ready = RegExp(r'^\d{6,10}$').hasMatch(code) || _paste.text.contains('http');
    return [
      TextField(
        key: const ValueKey('otp'),
        controller: _paste,
        autofocus: true,
        autocorrect: false,
        enableSuggestions: false,
        keyboardType: TextInputType.number,
        autofillHints: const [AutofillHints.oneTimeCode],
        textAlign: TextAlign.center,
        textInputAction: TextInputAction.done,
        onChanged: (v) {
          setState(() {});
          // Six digits typed or autofilled: sign in without another tap.
          if (RegExp(r'^\d{6}$').hasMatch(v.trim()) && !_busy) _verify();
        },
        onSubmitted: (_) => ready ? _verify() : null,
        style: TextStyle(color: t.fg, fontSize: 24, fontWeight: FontWeight.w600, letterSpacing: 8, fontFeatures: const [FontFeature.tabularFigures()]),
        decoration: InputDecoration(
          hintText: '000000',
          hintStyle: TextStyle(color: t.faint.withValues(alpha: .5), fontSize: 24, letterSpacing: 8),
          suffixIcon: IconButton(
            tooltip: 'Paste',
            icon: const Icon(Icons.content_paste_rounded),
            onPressed: () async {
              final d = await Clipboard.getData(Clipboard.kTextPlain);
              if (d?.text == null) return;
              setState(() => _paste.text = d!.text!.trim());
              if (!_busy) _verify();
            },
          ),
        ),
      ),
      const SizedBox(height: 12),
      _primary(context, label: 'Sign in', onTap: _busy || !ready ? null : _verify),
      const SizedBox(height: 12),
      Row(children: [
        Icon(Icons.link_rounded, size: 16, color: t.faint),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            kIsWeb ? 'Or tap the link in the email on this device.' : 'Or paste the link from the email here.',
            style: TextStyle(color: t.faint, fontSize: 13),
          ),
        ),
      ]),
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
