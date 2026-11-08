import 'package:flutter/foundation.dart';import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// A rendered page: [html] loaded as a string with no base URL (so it never sees Bridge's origin
/// or token), or a [url] the web view draws natively (a PDF). Links that leave the page open in
/// the browser.
class ArtifactFrame extends StatefulWidget {
  const ArtifactFrame({super.key, this.url, this.html}) : assert((url == null) != (html == null));
  final Uri? url;
  final String? html;
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
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (p) {
          if (mounted) setState(() => _progress = p);
        },
        onNavigationRequest: (r) {
          final u = Uri.tryParse(r.url);
          final own = u == null || u.scheme == 'about' || u.scheme == 'data' || (widget.url != null && u.host == widget.url!.host);
          if (own || !r.isMainFrame) return NavigationDecision.navigate;
          launchUrl(u, mode: LaunchMode.externalApplication).catchError((_) => false);
          return NavigationDecision.prevent;
        },
      )
      );
    // WKWebView on macOS has no transparency setting and throws "opaque is not implemented"
    if (defaultTargetPlatform != TargetPlatform.macOS) _c.setBackgroundColor(Colors.white);
    _load();
  }

  void _load() {
    if (widget.html != null) {
      _c.loadHtmlString(widget.html!);
    } else {
      _c.loadRequest(widget.url!);
    }
  }

  @override
  void didUpdateWidget(ArtifactFrame old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url || old.html != widget.html) _load();
  }

  @override
  Widget build(BuildContext context) => Stack(children: [
        WebViewWidget(controller: _c),
        if (_progress < 100) const Positioned(top: 0, left: 0, right: 0, child: LinearProgressIndicator(minHeight: 2)),
      ]);
}
