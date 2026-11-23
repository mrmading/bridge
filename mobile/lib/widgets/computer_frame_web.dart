import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

/// The live screen page in an iframe (the web build is served by the same Bridge, so it is same-origin).
class ComputerFrame extends StatelessWidget {
  const ComputerFrame({super.key, required this.url});
  final Uri url;

  @override
  Widget build(BuildContext context) => HtmlElementView.fromTagName(
        key: ValueKey(url),
        tagName: 'iframe',
        onElementCreated: (e) {
          final f = e as web.HTMLIFrameElement;
          f.style
            ..border = 'none'
            ..width = '100%'
            ..height = '100%'
            ..background = '#080a0f';
          f.src = url.toString();
        },
      );
}
