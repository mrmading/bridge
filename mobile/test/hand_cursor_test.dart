import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:bridge_mobile/core/theme.dart';

void main() {
  testWidgets('clickables show the pointing hand on macOS', (t) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final cases = <String, Widget>{
      'inkwell': InkWell(mouseCursor: hand, onTap: () {}, child: const SizedBox(width: 100, height: 40)),
      'actionchip': ActionChip(mouseCursor: hand, label: const Text('x'), onPressed: () {}),
      'textbutton': TextButton(onPressed: () {}, child: const Text('x')),
      'iconbutton': IconButton(onPressed: () {}, icon: const Icon(Icons.add)),
      'filled': FilledButton(onPressed: () {}, child: const Text('x')),
      'listtile': Material(child: ListTile(title: const Text('x'), onTap: () {})),
    };
    for (final e in cases.entries) {
      await t.pumpWidget(MaterialApp(theme: buildTheme(Brightness.dark), home: Scaffold(body: Center(child: SizedBox(width: 200, child: e.value)))));
      final g = await t.createGesture(kind: PointerDeviceKind.mouse, pointer: 7);
      await g.addPointer(location: t.getCenter(find.byWidget(e.value)));
      await t.pump();
      expect([for (var d = 0; d < 20; d++) RendererBinding.instance.mouseTracker.debugDeviceActiveCursor(d)].whereType<MouseCursor>().first, SystemMouseCursors.click, reason: e.key);
      await g.removePointer();
      await t.pump();
    }
    debugDefaultTargetPlatformOverride = null;
  });
}
