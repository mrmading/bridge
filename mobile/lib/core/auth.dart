/// Sign-in to Bridge with a Supabase magic link, over plain REST (no SDK): send the link, take
/// the session from the redirect (web) or from a pasted link / code (native), refresh it, sign out.
/// The Bridge server says whether sign-in is required and which project to use (/api/authconfig).
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

String _s(dynamic v) => v == null ? '' : v.toString();

class AuthConfig {
  AuthConfig({required this.required, required this.supabaseUrl, required this.supabaseKey});
  final bool required;
  final String supabaseUrl, supabaseKey;
  factory AuthConfig.fromJson(Map<String, dynamic> j) {
    var url = _s(j['supabaseUrl']).trim();
    while (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }
    return AuthConfig(required: j['required'] == true && url.isNotEmpty, supabaseUrl: url, supabaseKey: _s(j['supabaseKey']));
  }
  static final open = AuthConfig(required: false, supabaseUrl: '', supabaseKey: '');
}

class AuthSession {
  AuthSession({required this.accessToken, required this.refreshToken, required this.expiresAt, this.email = ''});
  final String accessToken, refreshToken, email;
  /// epoch seconds
  final int expiresAt;

  bool get expiringSoon => expiresAt - DateTime.now().millisecondsSinceEpoch ~/ 1000 < 60;

  Map<String, dynamic> toJson() => {'access_token': accessToken, 'refresh_token': refreshToken, 'expires_at': expiresAt, 'email': email};

  /// Accepts Supabase's token response, our own toJson, or the redirect fragment's parameters.
  static AuthSession? fromJson(Map<String, dynamic> j) {
    final at = _s(j['access_token']);
    if (at.isEmpty) return null;
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    var exp = int.tryParse(_s(j['expires_at'])) ?? 0;
    if (exp == 0) exp = now + (int.tryParse(_s(j['expires_in'])) ?? 3600);
    var email = _s(j['email']);
    if (email.isEmpty && j['user'] is Map) email = _s((j['user'] as Map)['email']);
    if (email.isEmpty) email = _s(jwtClaims(at)['email']);
    return AuthSession(accessToken: at, refreshToken: _s(j['refresh_token']), expiresAt: exp, email: email);
  }
}

/// The payload of a JWT, or {} when it is not one.
Map<String, dynamic> jwtClaims(String jwt) {
  final parts = jwt.split('.');
  if (parts.length != 3) return const {};
  try {
    final j = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
    return j is Map ? Map<String, dynamic>.from(j) : const {};
  } catch (_) {
    return const {};
  }
}

/// What a magic-link redirect left in the URL: a session, an error, or nothing.
({AuthSession? session, String error}) parseRedirect(Uri uri) {
  final params = <String, String>{};
  for (final part in [uri.fragment, uri.query]) {
    if (part.isEmpty || !part.contains('=')) continue;
    try {
      params.addAll(Uri.splitQueryString(part));
    } catch (_) {}
  }
  final err = params['error_description'] ?? params['error'] ?? '';
  if (err.isNotEmpty) return (session: null, error: err.replaceAll('+', ' '));
  return (session: AuthSession.fromJson(params), error: '');
}

/// The token hash inside a pasted magic link (`…/auth/v1/verify?token=…&type=magiclink`), or ''.
String tokenHashFromLink(String text) {
  final m = RegExp(r'https?://\S+').firstMatch(text.trim());
  if (m == null) return '';
  final u = Uri.tryParse(m.group(0)!);
  return u?.queryParameters['token'] ?? u?.queryParameters['token_hash'] ?? '';
}

class AuthException implements Exception {
  AuthException(this.message);
  final String message;
  @override
  String toString() => message;
}

class SupaAuth {
  SupaAuth(this.cfg, {http.Client? client}) : _client = client ?? http.Client();
  final AuthConfig cfg;
  final http.Client _client;

  Map<String, String> get _h => {'apikey': cfg.supabaseKey, 'content-type': 'application/json'};

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body, {Map<String, String>? q, String? bearer}) async {
    final u = Uri.parse('${cfg.supabaseUrl}/auth/v1$path').replace(queryParameters: q);
    final r = await _client.post(u, headers: {..._h, if (bearer != null) 'authorization': 'Bearer $bearer'}, body: jsonEncode(body)).timeout(const Duration(seconds: 30));
    dynamic j;
    try {
      j = r.body.isEmpty ? const {} : jsonDecode(utf8.decode(r.bodyBytes));
    } catch (_) {
      j = const {};
    }
    final m = j is Map ? Map<String, dynamic>.from(j) : <String, dynamic>{};
    if (r.statusCode >= 400) {
      final msg = _s(m['msg']).isNotEmpty ? _s(m['msg']) : (_s(m['error_description']).isNotEmpty ? _s(m['error_description']) : _s(m['message']));
      throw AuthException(msg.isEmpty ? 'Sign-in failed (${r.statusCode})' : msg);
    }
    return m;
  }

  /// Emails a sign-in link that comes back to [redirectTo].
  Future<void> sendLink(String email, {required String redirectTo}) async {
    await _post('/otp', {'email': email.trim(), 'create_user': true}, q: {'redirect_to': redirectTo});
  }

  /// Exchanges a pasted link's token hash, or the 6-digit code from the email, for a session.
  Future<AuthSession> verify({String tokenHash = '', String email = '', String code = ''}) async {
    final body = tokenHash.isNotEmpty ? {'type': 'magiclink', 'token_hash': tokenHash} : {'type': 'email', 'email': email.trim(), 'token': code.trim()};
    final s = AuthSession.fromJson(await _post('/verify', body));
    if (s == null) throw AuthException('That link or code did not sign you in');
    return s;
  }

  Future<AuthSession> refresh(String refreshToken) async {
    final s = AuthSession.fromJson(await _post('/token', {'refresh_token': refreshToken}, q: {'grant_type': 'refresh_token'}));
    if (s == null) throw AuthException('Session expired');
    return s;
  }

  Future<void> signOut(String accessToken) async {
    try {
      await _post('/logout', const {}, bearer: accessToken);
    } catch (_) {}
  }
}
