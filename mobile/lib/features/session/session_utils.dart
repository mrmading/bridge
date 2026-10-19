/// Small helpers shared by the Sessions, Session and Projects features: uuid, project keys,
/// folder names, and one way to push a session screen.
library;

import 'dart:math';

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/store.dart';
import 'session_screen.dart';

final _rng = Random.secure();

/// RFC 4122 v4 uuid, lower-case, no package.
String uuidV4() {
  final b = List<int>.generate(16, (_) => _rng.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// Same encoding as the server (contract §2): every non-alphanumeric char becomes `-`.
/// Lossy: never decode a key back into a path.
String projectKeyFor(String cwd) => cwd.replaceAll(RegExp(r'[^A-Za-z0-9]'), '-');

String baseName(String path) {
  final parts = path.split('/').where((x) => x.isNotEmpty).toList();
  return parts.isEmpty ? (path.isEmpty ? '' : '/') : parts.last;
}

/// Shows `~/…` instead of the home prefix when we know it.
String prettyPath(String path) {
  final home = AppStore.instance.boot?.home ?? '';
  if (home.isNotEmpty && path.startsWith(home)) return '~${path.substring(home.length)}';
  return path;
}

LiveSession? liveFor(String id) {
  for (final s in AppStore.instance.live.sessions) {
    if (s.id == id) return s;
  }
  return null;
}

/// Opens an existing session (history on disk, possibly running in a terminal).
Future<void> openSession(BuildContext context, {required String key, required String id, required String cwd, String title = '', String prefill = '', bool focus = false}) {
  return Navigator.of(context).push(MaterialPageRoute(
    builder: (_) => SessionScreen(key_: key, id: id, cwd: cwd, title: title, prefill: prefill, focusComposer: focus, live: liveFor(id)),
  ));
}

/// Starts a brand-new session in [cwd]. When [message] is set it is sent right away.
Future<void> startNewSession(BuildContext context, {required String cwd, String message = ''}) {
  final id = uuidV4();
  return Navigator.of(context).push(MaterialPageRoute(
    builder: (_) => SessionScreen(key_: projectKeyFor(cwd), id: id, cwd: cwd, isNew: true, prefill: message, sendPrefill: message.trim().isNotEmpty, focusComposer: message.trim().isEmpty),
  ));
}
