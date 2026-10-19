/// First run: point the app at a Bridge server. main.dart swaps to the Shell once connected.
library;

import 'package:flutter/material.dart';

import '../../core/store.dart';
import '../../core/theme.dart';

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});
  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final store = AppStore.instance;
  late final TextEditingController _url = TextEditingController(text: store.serverUrl);

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    final url = _url.text.trim();
    if (url.isEmpty) return;
    FocusScope.of(context).unfocus();
    await store.connect(url);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Scaffold(
      backgroundColor: t.bg,
      body: SafeArea(
        child: ListenableBuilder(
          listenable: store,
          builder: (context, _) {
            final connecting = store.conn == ConnState.connecting;
            final failed = store.conn == ConnState.failed && store.connError.isNotEmpty;
            return LayoutBuilder(
              builder: (context, box) => SingleChildScrollView(
                keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: ConstrainedBox(
                  constraints: BoxConstraints(minHeight: box.maxHeight),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 420),
                      child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        const SizedBox(height: 32),
                        Center(child: _Logo(accent: store.accent)),
                        const SizedBox(height: 28),
                        Text('Bridge', textAlign: TextAlign.center, style: TextStyle(color: t.fg, fontSize: 32, fontWeight: FontWeight.w800, letterSpacing: -.5)),
                        const SizedBox(height: 6),
                        Text('Your Claude Code, on your phone', textAlign: TextAlign.center, style: TextStyle(color: t.muted, fontSize: 16)),
                        const SizedBox(height: 40),
                        TextField(
                          controller: _url,
                          enabled: !connecting,
                          keyboardType: TextInputType.url,
                          autocorrect: false,
                          enableSuggestions: false,
                          textInputAction: TextInputAction.go,
                          onSubmitted: (_) => _connect(),
                          style: TextStyle(color: t.fg, fontSize: 17),
                          decoration: const InputDecoration(labelText: 'Server address', hintText: 'http://your-mac.local:4270'),
                        ),
                        if (failed) ...[
                          const SizedBox(height: 10),
                          Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(color: t.errSoft, borderRadius: BorderRadius.circular(12)),
                            child: Text('Could not reach Bridge: ${store.connError}', style: TextStyle(color: t.err, fontSize: 14)),
                          ),
                        ],
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: connecting ? null : _connect,
                          style: FilledButton.styleFrom(
                            minimumSize: const Size.fromHeight(52),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                            textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                          ),
                          child: connecting
                              ? SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2.2, color: t.accentFg))
                              : const Text('Connect'),
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'Run Bridge on your Mac or a sprite, then enter its address. On the same Wi-Fi that is usually http://<mac-name>.local:4270.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: t.faint, fontSize: 13, height: 1.4),
                        ),
                        const SizedBox(height: 32),
                      ]),
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

/// A bold "B" in a rounded black square with an accent glow. Drawn, no asset.
class _Logo extends StatelessWidget {
  const _Logo({required this.accent});
  final Color accent;
  @override
  Widget build(BuildContext context) {
    return Container(
      width: 84,
      height: 84,
      decoration: BoxDecoration(
        color: Colors.black,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: accent.withValues(alpha: .35)),
        boxShadow: [
          BoxShadow(color: accent.withValues(alpha: .45), blurRadius: 36, spreadRadius: 2),
          BoxShadow(color: accent.withValues(alpha: .25), blurRadius: 80, spreadRadius: 10),
        ],
      ),
      alignment: Alignment.center,
      child: ShaderMask(
        shaderCallback: (r) => LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.white, Color.lerp(Colors.white, accent, .5)!]).createShader(r),
        child: const Text('B', style: TextStyle(color: Colors.white, fontSize: 46, fontWeight: FontWeight.w800, height: 1)),
      ),
    );
  }
}
