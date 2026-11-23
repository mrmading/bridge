import 'dart:js_interop';

@JS('history.replaceState')
external void _replaceState(JSAny? data, String unused, String url);

/// Drops the sign-in tokens from the address bar once they are stored.
void replaceUrl(String url) {
  try {
    _replaceState(null, '', url);
  } catch (_) {}
}
