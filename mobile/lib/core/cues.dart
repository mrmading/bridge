/// Pre-recorded voice cues, played from the app bundle so they start instantly: an acknowledgement the
/// moment a message is sent ("Sure, let me process this."), then an occasional "still thinking" line
/// while the reply is on its way. Random picks, never the same line twice in a row.
/// Recorded with Kokoro (af_heart, the server's own voice) into assets/voice/.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';

class VoiceCues {
  VoiceCues._();
  static final VoiceCues instance = VoiceCues._();

  static const _counts = {'ack': 10, 'think': 8};
  final _rnd = math.Random();
  final _last = <String, int>{};
  AudioPlayer? _player;
  Timer? _timer;
  int _thinks = 0;

  /// iOS: speaker playback that ignores the silent switch and coexists with the microphone, for every
  /// player in the app (cues and replies). Without it a phone on silent plays nothing.
  static Future<void> configureAudio() async {
    if (kIsWeb) return;
    try {
      await AudioPlayer.global.setAudioContext(AudioContextConfig(route: AudioContextConfigRoute.speaker, respectSilence: false).build());
    } catch (_) {}
  }

  String _pick(String kind) {
    final n = _counts[kind]!;
    var i = _rnd.nextInt(n);
    if (n > 1 && i == _last[kind]) i = (i + 1 + _rnd.nextInt(n - 1)) % n;
    _last[kind] = i;
    return 'voice/${kind}_${i.toString().padLeft(2, '0')}.m4a';
  }

  Future<void> _play(String kind) async {
    try {
      final p = _player ??= AudioPlayer()..setReleaseMode(ReleaseMode.stop);
      await p.stop();
      await p.play(AssetSource(_pick(kind)));
    } catch (_) {}
  }

  /// A message just went out: acknowledge it, then fill the wait with a thinking cue now and then.
  void sent({Duration first = const Duration(seconds: 9), Duration every = const Duration(seconds: 11), int max = 3}) {
    stop(quiet: false);
    unawaited(_play('ack'));
    _thinks = 0;
    void schedule(Duration d) {
      _timer = Timer(d, () {
        if (_thinks >= max) return;
        _thinks++;
        unawaited(_play('think'));
        schedule(every);
      });
    }

    schedule(first);
  }

  /// The reply is here (or the turn was stopped): no more cues. `quiet` also cuts one mid-sentence.
  void stop({bool quiet = true}) {
    _timer?.cancel();
    _timer = null;
    if (quiet) unawaited(_player?.stop().catchError((_) {}) ?? Future<void>.value());
  }

  void dispose() {
    stop();
    _player?.dispose();
    _player = null;
  }
}
