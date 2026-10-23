import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// A rendered page (HTML, or a PDF, which WKWebView draws natively). Links that leave the page
/// open in the browser.
class ArtifactFrame extends StatefulWidget {
  const ArtifactFrame({super.key, required this.url, this.sandbox = true});
  final Uri url;
  /// Web only: the iframe gets an opaque origin. Native web views are already their own process.
  final bool sandbox;
  @override
  State<ArtifactFrame> createState() => _ArtifactFrameState();
}

class _ArtifactFrameState extends State<ArtifactFrame> {
  late final WebViewController _c;
  int _progress = 0;

  @override
  void initState() {
    super.initState();
    _c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.white)
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (p) {
          if (mounted) setState(() => _progress = p);
        },
        onNavigationRequest: (r) {
          final u = Uri.tryParse(r.url);
          if (u == null || u.host == widget.url.host || u.scheme == 'about' || u.scheme == 'data') return NavigationDecision.navigate;
          launchUrl(u, mode: LaunchMode.externalApplication).catchError((_) => false);
          return NavigationDecision.prevent;
        },
      ))
      ..loadRequest(widget.url);
  }

  @override
  void didUpdateWidget(ArtifactFrame old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) _c.loadRequest(widget.url);
  }

  @override
  Widget build(BuildContext context) => Stack(children: [
        WebViewWidget(controller: _c),
        if (_progress < 100) const Positioned(top: 0, left: 0, right: 0, child: LinearProgressIndicator(minHeight: 2)),
      ]);
}
