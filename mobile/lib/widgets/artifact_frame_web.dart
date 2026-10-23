import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

/// A rendered page in an iframe. Sandboxed without allow-same-origin, so a page the agent wrote
/// cannot read Bridge's sign-in from this origin.
class ArtifactFrame extends StatelessWidget {
  const ArtifactFrame({super.key, required this.url, this.sandbox = true});
  final Uri url;
  /// Off for PDFs: browsers refuse to draw a PDF in a sandboxed frame.
  final bool sandbox;

  @override
  Widget build(BuildContext context) => HtmlElementView.fromTagName(
        key: ValueKey(url),
        tagName: 'iframe',
        onElementCreated: (e) {
          final f = e as web.HTMLIFrameElement;
          if (sandbox) f.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals');
          f.style
            ..border = 'none'
            ..width = '100%'
            ..height = '100%'
            ..background = '#fff';
          f.src = url.toString();
        },
      );
}
