import 'dart:js_interop';

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

/// A rendered page in an iframe. [html] goes in as srcdoc, sandboxed without allow-same-origin, so
/// a page the agent wrote cannot read Bridge's sign-in. A [url] (a PDF) is not sandboxed: browsers
/// refuse to draw a PDF in a sandboxed frame.
class ArtifactFrame extends StatelessWidget {
  const ArtifactFrame({super.key, this.url, this.html}) : assert((url == null) != (html == null));
  final Uri? url;
  final String? html;

  @override
  Widget build(BuildContext context) => HtmlElementView.fromTagName(
        key: ValueKey(html ?? url),
        tagName: 'iframe',
        onElementCreated: (e) {
          final f = e as web.HTMLIFrameElement;
          f.style
            ..border = 'none'
            ..width = '100%'
            ..height = '100%'
            ..background = '#fff';
          if (html != null) {
            f.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals');
            f.srcdoc = html!.toJS;
          } else {
            f.src = url.toString();
          }
        },
      );
}
