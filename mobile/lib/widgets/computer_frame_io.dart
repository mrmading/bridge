import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// The live screen page in a native web view. It stays on the Bridge server; any other link opens in the browser.
class ComputerFrame extends StatefulWidget {
  const ComputerFrame({super.key, required this.url});
  final Uri url;
  @override
  State<ComputerFrame> createState() => _ComputerFrameState();
}

class _ComputerFrameState extends State<ComputerFrame> {
  late final WebViewController _c;
  int _progress = 0;

  @override
  void initState() {
    super.initState();
    _c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (p) {
          if (mounted) setState(() => _progress = p);
        },
        onNavigationRequest: (r) {
          final u = Uri.tryParse(r.url);
          if (u == null || u.host == widget.url.host || u.scheme == 'about') return NavigationDecision.navigate;
          launchUrl(u, mode: LaunchMode.externalApplication).catchError((_) => false);
          return NavigationDecision.prevent;
        },
      ));
    // WKWebView on macOS has no transparency setting and throws "opaque is not implemented"
    if (defaultTargetPlatform != TargetPlatform.macOS) _c.setBackgroundColor(const Color(0xFF080A0F));
    _c.loadRequest(widget.url);
  }

  @override
  Widget build(BuildContext context) => Stack(children: [
        WebViewWidget(controller: _c),
        if (_progress < 100) const Positioned(top: 0, left: 0, right: 0, child: LinearProgressIndicator(minHeight: 2)),
      ]);
}
