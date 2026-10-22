import 'dart:convert';

import 'package:bridge_mobile/core/auth.dart';
import 'package:bridge_mobile/core/models.dart';
import 'package:bridge_mobile/core/store.dart';
import 'package:bridge_mobile/core/theme.dart';
import 'package:bridge_mobile/features/auth/login_screen.dart';
import 'package:bridge_mobile/widgets/composer.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

String jwt(Map<String, dynamic> claims) => 'h.${base64Url.encode(utf8.encode(jsonEncode(claims))).replaceAll('=', '')}.s';

void main() {
  final cfg = AuthConfig.fromJson({'required': true, 'supabaseUrl': 'https://x.supabase.co/', 'supabaseKey': 'sb_publishable_k'});

  test('authconfig: required only with a project URL; trailing slash trimmed', () {
    expect(cfg.required, isTrue);
    expect(cfg.supabaseUrl, 'https://x.supabase.co');
    expect(AuthConfig.fromJson({'required': true}).required, isFalse);
    expect(AuthConfig.fromJson({}).required, isFalse);
  });

  test('the magic-link redirect yields a session with the email from the token', () {
    final at = jwt({'email': 'nestor@example.com', 'sub': 'u1'});
    final r = parseRedirect(Uri.parse('https://bridge.example/m/#access_token=$at&refresh_token=r1&expires_in=3600&token_type=bearer&type=magiclink'));
    expect(r.error, '');
    expect(r.session!.accessToken, at);
    expect(r.session!.refreshToken, 'r1');
    expect(r.session!.email, 'nestor@example.com');
    expect(r.session!.expiringSoon, isFalse);
    final bad = parseRedirect(Uri.parse('https://bridge.example/m/#error=access_denied&error_description=Email+link+is+invalid+or+has+expired'));
    expect(bad.session, isNull);
    expect(bad.error, 'Email link is invalid or has expired');
    expect(parseRedirect(Uri.parse('https://bridge.example/m/')).session, isNull);
  });

  test('a pasted email link gives its token hash; plain text does not', () {
    expect(tokenHashFromLink('Click: https://x.supabase.co/auth/v1/verify?token=abc123&type=magiclink&redirect_to=https://b/m/'), 'abc123');
    expect(tokenHashFromLink('123456'), '');
  });

  test('sendLink, verify and refresh speak Supabase REST', () async {
    final calls = <http.Request>[];
    final client = MockClient((req) async {
      calls.add(req);
      if (req.url.path.endsWith('/otp')) return http.Response('{}', 200);
      if (req.url.path.endsWith('/verify')) {
        final b = jsonDecode(req.body) as Map;
        if (b['token'] == '000000') return http.Response('{"msg":"Token has expired or is invalid"}', 403);
        return http.Response(jsonEncode({'access_token': jwt({'email': 'n@x.co'}), 'refresh_token': 'r', 'expires_in': 3600, 'user': {'email': 'n@x.co'}}), 200);
      }
      if (req.url.path.endsWith('/token')) return http.Response(jsonEncode({'access_token': 'a2', 'refresh_token': 'r2', 'expires_in': 3600}), 200);
      return http.Response('', 404);
    });
    final a = SupaAuth(cfg, client: client);
    await a.sendLink('n@x.co', redirectTo: 'https://bridge.example/m/');
    expect(calls.last.url.toString(), 'https://x.supabase.co/auth/v1/otp?redirect_to=https%3A%2F%2Fbridge.example%2Fm%2F');
    expect(calls.last.headers['apikey'], 'sb_publishable_k');
    expect(jsonDecode(calls.last.body)['email'], 'n@x.co');

    final s = await a.verify(tokenHash: 'abc');
    expect(jsonDecode(calls.last.body), {'type': 'magiclink', 'token_hash': 'abc'});
    expect(s.email, 'n@x.co');
    await expectLater(a.verify(email: 'n@x.co', code: '000000'), throwsA(isA<AuthException>().having((e) => e.message, 'message', 'Token has expired or is invalid')));

    final r = await a.refresh('r');
    expect(calls.last.url.queryParameters['grant_type'], 'refresh_token');
    expect(r.accessToken, 'a2');
  });

  test('providers parse from bootstrap; turns keep their provider', () {
    final b = Bootstrap.fromJson({'providers': [{'id': 'claude', 'name': 'Claude'}, {'id': 'qwen', 'name': 'Qwen (RunPod)', 'available': false}, {'name': 'no id'}]});
    expect(b.providers.map((p) => p.id), ['claude', 'qwen']);
    expect(b.providers.last.available, isFalse);
    expect(Bootstrap.fromJson({}).providers, isEmpty);
    final t = TurnOptions.fromJson({'provider': 'qwen', 'model': 'opus'});
    expect(t.isQwen, isTrue);
    expect(t.copy(effort: 'high').provider, 'qwen');
    expect(TurnOptions.fromJson({'provider': 'claude'}).provider, '');
  });

  Widget host(Widget w) => MaterialApp(theme: buildTheme(Brightness.dark), home: w);

  testWidgets('login: email step, then "Check your email"', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await AppStore.instance.init();
    await tester.binding.setSurfaceSize(const Size(402, 874));
    await tester.pumpWidget(host(const LoginScreen()));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Sign in to Bridge'), findsOneWidget);
    expect(find.text('Email me a sign-in link'), findsOneWidget);
    await tester.tap(find.text('Email me a sign-in link'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Enter your email address'), findsOneWidget);
    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('model sheet: Claude / Qwen switch, Qwen greyed when unavailable', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final s = AppStore.instance;
    await s.init();
    s.boot = Bootstrap.fromJson({'models': ['opus', 'sonnet'], 'providers': [{'id': 'claude', 'name': 'Claude'}, {'id': 'qwen', 'name': 'Qwen (RunPod)', 'available': true}]});
    await tester.binding.setSurfaceSize(const Size(402, 874));
    await tester.pumpWidget(host(Scaffold(body: Builder(builder: (c) => Center(child: TextButton(onPressed: () => showModelSheet(c), child: const Text('open')))))));
    await tester.tap(find.text('open'));
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    expect(find.byKey(const ValueKey('provider-switch')), findsOneWidget);
    expect(find.text('Opus'), findsOneWidget);
    await tester.tap(find.text('Qwen'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(s.turn.isQwen, isTrue);
    expect(find.text('Opus'), findsNothing, reason: 'Claude models hide while on Qwen');
    await tester.tap(find.text('Claude'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(s.turn.provider, '');
    await tester.binding.setSurfaceSize(null);
  });
}
