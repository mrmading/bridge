/// One shared once-a-second tick for every live elapsed timer on screen. The timer only runs while
/// something listens, so an idle app does not wake up every second.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

class Clock extends ChangeNotifier {
  Clock._();
  static final Clock instance = Clock._();

  Timer? _timer;
  int _listeners = 0;

  @override
  void addListener(VoidCallback listener) {
    super.addListener(listener);
    if (_listeners++ == 0) _timer = Timer.periodic(const Duration(seconds: 1), (_) => notifyListeners());
  }

  @override
  void removeListener(VoidCallback listener) {
    super.removeListener(listener);
    if (--_listeners <= 0) {
      _listeners = 0;
      _timer?.cancel();
      _timer = null;
    }
  }
}

/// 6m 12s · 1h 04m · 42s
String fmtElapsed(int sinceMs, {int? now}) {
  if (sinceMs <= 0) return '';
  final n = now ?? DateTime.now().millisecondsSinceEpoch;
  // No big shifts or clamps here: `1 << 31` is negative on dart2js.
  final s = math.max(0, ((n - sinceMs) / 1000).floor());
  final h = s ~/ 3600, m = (s % 3600) ~/ 60, x = s % 60;
  if (h > 0) return '${h}h ${m.toString().padLeft(2, '0')}m';
  if (m > 0) return '${m}m ${x.toString().padLeft(2, '0')}s';
  return '${x}s';
}

/// A duration in words for the work summary: 6m 12s · 40s · 1h 5m.
String fmtDuration(Duration d) {
  final s = d.inSeconds;
  if (s < 60) return '${s < 1 ? 1 : s}s';
  final h = s ~/ 3600, m = (s % 3600) ~/ 60, x = s % 60;
  if (h > 0) return '${h}h ${m}m';
  return x == 0 ? '${m}m' : '${m}m ${x}s';
}
