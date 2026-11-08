/// Launch: the app is reaching its machine. The cloud computer sleeps when idle, so the first request
/// can take up to a minute; say what is happening instead of showing an empty Home. If it never
/// answers, this screen offers a retry. There is no server to type: the app has one, built in.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/orb.dart';

class StartingScreen extends StatefulWidget {
  const StartingScreen({super.key});
  @override
  State<StartingScreen> createState() => _StartingScreenState();
}

/// What the wait is made of, by elapsed seconds: the sprite boots, then Bridge starts on it.
const _steps = [
  (0, 'Reaching your machine'),
  (4, 'Waking it up'),
  (15, 'Starting Bridge on it'),
  (35, 'Loading your threads and files'),
  (60, 'Taking longer than usual, still trying'),
];

class _StartingScreenState extends State<StartingScreen> {
  final store = AppStore.instance;
  late final Timer _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
    store.addListener(_changed);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _tick.cancel();
    store.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final failed = store.conn == ConnState.failed;
    final secs = DateTime.now().difference(store.connectStarted).inSeconds;
    final step = _steps.lastWhere((s) => secs >= s.$1).$2;
    final title = failed ? "Can't reach your machine" : store.isCloud ? 'Starting Paquito machine' : 'Connecting to ${store.serverHost}';
    final hint = failed
        ? 'Check your connection. The cloud computer may still be booting.'
        : store.isCloud
            ? 'Your cloud computer sleeps when idle, so waking it can take up to a minute.'
            : '';
    return Scaffold(
      backgroundColor: t.bg,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Opacity(opacity: failed ? .45 : 1, child: Orb(phase: failed ? 'offline' : 'thinking', color: store.accent, size: 150)),
              const SizedBox(height: 32),
              Text(title, textAlign: TextAlign.center, style: TextStyle(color: t.fg, fontSize: 22, fontWeight: FontWeight.w700)),
              if (hint.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(hint, textAlign: TextAlign.center, style: TextStyle(color: t.muted, fontSize: 15, height: 1.35)),
              ],
              const SizedBox(height: 22),
              if (failed)
                FilledButton(
                  onPressed: store.connectSaved,
                  style: FilledButton.styleFrom(minimumSize: const Size(160, 48)),
                  child: const Text('Try again'),
                )
              else
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 300),
                  child: Row(key: ValueKey(step), mainAxisSize: MainAxisSize.min, children: [
                    SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 2, color: store.accent)),
                    const SizedBox(width: 10),
                    Text(store.isCloud ? '$step · ${secs}s' : step, style: TextStyle(color: t.muted, fontSize: 14, fontFeatures: const [FontFeature.tabularFigures()])),
                  ]),
                ),
            ]),
          ),
        ),
      ),
    );
  }
}
