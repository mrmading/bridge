/// The assistant's orb: a lit sphere with a soft halo that shows what the assistant is doing.
/// idle breathes · listening pulses with the mic level (cyan) · thinking/working shimmers (purple)
/// · speaking swells · offline dims. One AnimationController drives it at the display rate.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

class Orb extends StatefulWidget {
  const Orb({super.key, this.phase = 'idle', this.level = 0, required this.color, this.size = 220});

  /// 'idle' | 'listening' | 'thinking' | 'working' | 'speaking' | 'offline'
  final String phase;

  /// Mic or audio level, 0..1.
  final double level;
  final Color color;
  final double size;

  @override
  State<Orb> createState() => _OrbState();
}

class _OrbState extends State<Orb> with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  final Stopwatch _clock = Stopwatch()..start();
  int _lastUs = 0;

  // Smoothed values, eased toward their targets every frame so phase changes never jump.
  double _level = 0;
  double _shimmer = 0; // 0..1 how much of the thinking shimmer is showing
  double _swell = 0; // 0..1 speaking
  double _listen = 0; // 0..1 listening
  double _dim = 0; // 0..1 offline
  Color _tint = Colors.transparent;
  bool _tintInit = false;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(vsync: this, duration: const Duration(seconds: 1))
      ..addListener(_tick)
      ..repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  static const _cyan = Color(0xFF5EE6FF);
  static const _purple = Color(0xFFB79CF5);
  static const _grey = Color(0xFF5B6270);

  Color get _targetTint => switch (widget.phase) {
        'listening' => Color.lerp(widget.color, _cyan, .65)!,
        'thinking' || 'working' => Color.lerp(widget.color, _purple, .7)!,
        'offline' => Color.lerp(widget.color, _grey, .8)!,
        _ => widget.color,
      };

  void _tick() {
    final us = _clock.elapsedMicroseconds;
    final dt = ((us - _lastUs) / 1e6).clamp(0.0, 0.1);
    _lastUs = us;
    final k = 1 - math.exp(-dt * 7); // ~140 ms time constant
    final kl = 1 - math.exp(-dt * 16); // level follows faster
    final p = widget.phase;
    _level += ((p == 'listening' || p == 'speaking' ? widget.level.clamp(0.0, 1.0) : 0.0) - _level) * kl;
    _shimmer += ((p == 'thinking' || p == 'working' ? 1.0 : 0.0) - _shimmer) * k;
    _swell += ((p == 'speaking' ? 1.0 : 0.0) - _swell) * k;
    _listen += ((p == 'listening' ? 1.0 : 0.0) - _listen) * k;
    _dim += ((p == 'offline' ? 1.0 : 0.0) - _dim) * k;
    if (!_tintInit) {
      _tint = _targetTint;
      _tintInit = true;
    } else {
      _tint = Color.lerp(_tint, _targetTint, k)!;
    }
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return RepaintBoundary(
      child: SizedBox.square(
        dimension: widget.size,
        child: CustomPaint(
          painter: _OrbPainter(
            time: _clock.elapsedMicroseconds / 1e6,
            level: _level,
            shimmer: _shimmer,
            swell: _swell,
            listen: _listen,
            dim: _dim,
            tint: _tintInit ? _tint : _targetTint,
            dark: dark,
          ),
        ),
      ),
    );
  }
}

class _OrbPainter extends CustomPainter {
  _OrbPainter({required this.time, required this.level, required this.shimmer, required this.swell, required this.listen, required this.dim, required this.tint, required this.dark});
  final double time, level, shimmer, swell, listen, dim;
  final Color tint;
  final bool dark;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final base = size.shortestSide * .30;

    // Scale: slow 4 s breath at rest, mic-level pulse, a talking swell, a small shrink offline.
    final breath = math.sin(time * 2 * math.pi / 4);
    final talk = (math.sin(time * 9.0) * .5 + .5) * (math.sin(time * 3.1) * .5 + .5);
    final scale = 1 + .03 * breath * (1 - listen) + .16 * level * listen + swell * (.05 + .07 * talk + .06 * level) + .015 * shimmer * math.sin(time * math.pi) - .06 * dim;
    final r = base * scale;

    final glowAlpha = (.30 + .25 * listen * level + .20 * swell + .08 * breath * (1 - dim)) * (1 - .7 * dim);

    // Halo.
    final haloR = r * (1.75 + .25 * listen * level + .15 * swell);
    canvas.drawCircle(
      c,
      haloR,
      Paint()
        ..shader = RadialGradient(colors: [
          tint.withValues(alpha: glowAlpha.clamp(0.0, 1.0)),
          tint.withValues(alpha: (glowAlpha * .35).clamp(0.0, 1.0)),
          tint.withValues(alpha: 0),
        ], stops: const [.45, .7, 1]).createShader(Rect.fromCircle(center: c, radius: haloR)),
    );

    // Listening ripples: rings drifting outward, brighter with level.
    if (listen > .01) {
      for (var i = 0; i < 3; i++) {
        final f = ((time * .6) + i / 3) % 1.0;
        final rr = r * (1.05 + .7 * f);
        canvas.drawCircle(
          c,
          rr,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.6
            ..color = tint.withValues(alpha: (listen * (1 - f) * (.25 + .5 * level)).clamp(0.0, 1.0)),
        );
      }
    }

    // Sphere body: lit from the top left.
    final sphere = Rect.fromCircle(center: c, radius: r);
    final hi = Color.lerp(tint, Colors.white, .55)!;
    final lo = Color.lerp(tint, Colors.black, dark ? .72 : .5)!;
    canvas.drawCircle(
      c,
      r,
      Paint()
        ..shader = RadialGradient(
          center: const Alignment(-.35, -.42),
          radius: 1.05,
          colors: [hi, tint, lo],
          stops: const [0, .45, 1],
        ).createShader(sphere),
    );

    // Thinking shimmer: soft bands sweeping round the sphere.
    if (shimmer > .01) {
      canvas.save();
      canvas.clipPath(Path()..addOval(sphere));
      final a = (.22 * shimmer).clamp(0.0, 1.0);
      canvas.drawCircle(
        c,
        r,
        Paint()
          ..blendMode = BlendMode.plus
          ..shader = SweepGradient(
            transform: GradientRotation(time * 1.4),
            colors: [
              Colors.white.withValues(alpha: 0),
              Colors.white.withValues(alpha: a),
              Colors.white.withValues(alpha: 0),
              const Color(0xFFB79CF5).withValues(alpha: a * .8),
              Colors.white.withValues(alpha: 0),
            ],
            stops: const [0, .18, .4, .65, 1],
          ).createShader(sphere),
      );
      canvas.restore();
    }

    // Rim light and specular highlight.
    canvas.drawCircle(
      c,
      r,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2
        ..shader = LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [
          Colors.white.withValues(alpha: .35 * (1 - .6 * dim)),
          Colors.white.withValues(alpha: 0),
        ]).createShader(sphere),
    );
    final spec = Rect.fromCenter(center: c + Offset(-r * .36, -r * .42), width: r * .62, height: r * .38);
    canvas.drawOval(
      spec,
      Paint()
        ..shader = RadialGradient(colors: [
          Colors.white.withValues(alpha: .45 * (1 - .6 * dim)),
          Colors.white.withValues(alpha: 0),
        ]).createShader(spec),
    );
  }

  @override
  bool shouldRepaint(_OrbPainter o) => true;
}
