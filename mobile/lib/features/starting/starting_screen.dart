/// Launch: the app is reaching its server. The sprite sleeps when idle, so the first request can
/// take a while; say so instead of showing an empty Home.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/store.dart';
import '../../core/theme.dart';

class StartingScreen extends StatefulWidget {
  const StartingScreen({super.key});
  @override
  State<StartingScreen> createState() => _StartingScreenState();
}

class _StartingScreenState extends State<StartingScreen> {
  final store = AppStore.instance;
  late final Timer _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final secs = DateTime.now().difference(store.connectStarted).inSeconds;
    final title = store.isCloud ? 'Starting Paquito machine' : 'Connecting to ${store.serverHost}';
    final hint = !store.isCloud
        ? ''
        : secs < 5
            ? 'Waking it up'
            : secs < 45
                ? 'It sleeps when idle, so this can take up to a minute · ${secs}s'
                : 'Still booting, hang on · ${secs}s';
    return Scaffold(
      backgroundColor: t.bg,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              SizedBox(width: 36, height: 36, child: CircularProgressIndicator(strokeWidth: 3, color: store.accent)),
              const SizedBox(height: 28),
              Text(title, textAlign: TextAlign.center, style: TextStyle(color: t.fg, fontSize: 22, fontWeight: FontWeight.w700)),
              if (hint.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(hint, textAlign: TextAlign.center, style: TextStyle(color: t.muted, fontSize: 15)),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}
