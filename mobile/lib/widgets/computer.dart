/// The Computer sheet: the cloud computer's screen, live, as the agent uses it. It is the server's own
/// viewer page (public/computer.html, noVNC) in a web view, so the phone and the web client share one
/// implementation: the Viewing / You're in control indicator and the Take control / Give back toggle live there.
library;

import 'package:flutter/material.dart';

import '../core/store.dart';
import '../core/theme.dart';
import 'computer_frame_io.dart' if (dart.library.js_interop) 'computer_frame_web.dart';

final RegExp _deskTool = RegExp(r'^mcp__(browser|computer)__');

/// A tool that puts something on the screen: the browser (Playwright MCP) or the screen tools.
bool isDesktopTool(String name) => _deskTool.hasMatch(name);

Future<void> showComputerScreen(BuildContext context) async {
  final url = await AppStore.instance.api.computerUrl();
  if (!context.mounted) return;
  await Navigator.of(context, rootNavigator: true).push(MaterialPageRoute<void>(
    fullscreenDialog: true,
    builder: (_) => ComputerSheet(url: url),
  ));
}

class ComputerSheet extends StatelessWidget {
  const ComputerSheet({super.key, required this.url});
  final Uri url;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Scaffold(
      backgroundColor: const Color(0xFF080A0F),
      appBar: AppBar(
        leading: IconButton(tooltip: 'Close', onPressed: () => Navigator.of(context).pop(), icon: const Icon(Icons.close_rounded)),
        titleSpacing: 0,
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Computer', style: TextStyle(fontSize: 16)),
          Text('Cloud computer · live screen', style: TextStyle(color: t.muted, fontSize: 12, fontWeight: FontWeight.w500)),
        ]),
      ),
      body: SafeArea(top: false, child: ComputerFrame(url: url)),
    );
  }
}
