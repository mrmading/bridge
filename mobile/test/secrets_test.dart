import 'package:bridge_mobile/core/api.dart';
import 'package:bridge_mobile/core/models.dart';
import 'package:bridge_mobile/core/theme.dart';
import 'package:bridge_mobile/widgets/transcript.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('splitSecrets', () {
    test('parses several lines, scopes and hints, and strips the block from the body', () {
      const text = 'I need two tokens to deploy.\n\n'
          '```secret\n'
          'CLOUDFLARE_API_TOKEN global Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers"\n'
          'STRIPE_KEY project Stripe dashboard → Developers → API keys\n'
          '```\n';
      final r = splitSecrets(text);
      expect(r.text, 'I need two tokens to deploy.');
      expect(r.secrets.length, 2);
      expect(r.secrets[0].name, 'CLOUDFLARE_API_TOKEN');
      expect(r.secrets[0].scope, 'global');
      expect(r.secrets[0].hint, 'Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers"');
      expect(r.secrets[1].name, 'STRIPE_KEY');
      expect(r.secrets[1].scope, 'project');
      expect(r.secrets[1].hint, 'Stripe dashboard → Developers → API keys');
    });

    test('missing scope defaults to global and keeps the rest as the hint', () {
      final r = splitSecrets('Paste it here.\n```secret\nOPENAI_API_KEY platform.openai.com → API keys\n```');
      expect(r.secrets.single.scope, 'global');
      expect(r.secrets.single.hint, 'platform.openai.com → API keys');
      final bare = splitSecrets('```secret\nGITHUB_TOKEN\n```');
      expect(bare.text, '');
      expect(bare.secrets.single.name, 'GITHUB_TOKEN');
      expect(bare.secrets.single.scope, 'global');
      expect(bare.secrets.single.hint, '');
      // A hint that starts like the scope word is not mistaken for it.
      final g = splitSecrets('```secret\nAPI_KEY global gl dashboard\nOTHER_KEY globalish hint\n```');
      expect(g.secrets[0].hint, 'gl dashboard');
      expect(g.secrets[1].scope, 'global');
      expect(g.secrets[1].hint, 'globalish hint');
      expect(splitSecrets('```secret\nAPI_KEY Project here\n```').secrets.single.scope, 'project');
    });

    test('bad names are ignored, duplicates collapse, at most three requests', () {
      const text = 'x\n```secret\n'
          'lowercase_name global nope\n'
          'A global too short\n'
          '1BAD global starts with a digit\n'
          'GOOD_ONE project ok\n'
          'GOOD_ONE global duplicate\n'
          'TWO\n'
          'THREE\n'
          'FOUR\n'
          '```';
      final r = splitSecrets(text);
      expect(r.secrets.map((s) => s.name).toList(), ['GOOD_ONE', 'TWO', 'THREE']);
      expect(r.secrets.first.scope, 'project');
      expect(r.text, 'x');
    });

    test('text without a block is untouched; a choices block after it survives', () {
      const plain = 'No secrets here.\n```js\nconst a = 1;\n```';
      expect(splitSecrets(plain).text, plain);
      expect(splitSecrets(plain).secrets, isEmpty);

      const both = 'Need a key.\n```secret\nAPI_KEY global\n```\n\n```choices\nSkip it\n```';
      final r = splitSecrets(both);
      expect(r.secrets.single.name, 'API_KEY');
      final c = splitChoices(r.text);
      expect(c.text, 'Need a key.');
      expect(c.options, ['Skip it']);
    });

    test('a block with only invalid lines is still stripped', () {
      final r = splitSecrets('Hi\n```secret\nnot valid\n```');
      expect(r.text, 'Hi');
      expect(r.secrets, isEmpty);
    });
  });

  test('SecretInfo parses the list shape and SecretRequest exposes the follow-up text', () {
    final s = SecretInfo.fromJson({'name': 'X_KEY', 'scope': 'project', 'hint': 'abcd…wxyz', 'updatedAt': 1700000000000, 'project': '/r/app'});
    expect(s.name, 'X_KEY');
    expect(s.isProject, isTrue);
    expect(s.hint, 'abcd…wxyz');
    expect(s.updatedAt, 1700000000000);
    expect(s.project, '/r/app');
    expect(SecretInfo.fromJson({'name': 'Y', 'scope': 'weird'}).scope, 'global');
    expect(secretSavedMessage('X_KEY', 'global'), '🔒 Saved X_KEY (everywhere). Continue.');
    expect(secretSavedMessage('X_KEY', 'project'), '🔒 Saved X_KEY (this project). Continue.');
  });

  group('secret card', () {
    Widget host(Widget child) => MaterialApp(theme: buildTheme(Brightness.dark), home: Scaffold(body: SingleChildScrollView(child: child)));
    final msg = Msg(kind: 'assistant', id: 'a1', text: 'Need a key.\n```secret\nCF_TOKEN project Cloudflare → API Tokens\n```');

    testWidgets('saves with the chosen scope, shows the hint, then sends the exact follow-up', (tester) async {
      final sent = <String>[];
      String? gotValue, gotScope;
      await tester.pumpWidget(host(AssistantText(
        msg: msg,
        onChoice: sent.add,
        onSaveSecret: (req, value, scope) async {
          gotValue = value;
          gotScope = scope;
          return 'abcd…wxyz';
        },
      )));
      expect(find.text('Need a key.'), findsOneWidget);
      expect(find.textContaining('```'), findsNothing);
      expect(find.text('CF_TOKEN'), findsOneWidget);
      expect(find.text('Cloudflare → API Tokens'), findsOneWidget);
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.obscureText, isTrue);
      expect(field.autocorrect, isFalse);
      expect(field.enableSuggestions, isFalse);
      expect(field.autofillHints, isNull);
      expect(field.keyboardType, TextInputType.visiblePassword);

      await tester.tap(find.text('Everywhere'));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'sk-super-secret-value');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(gotValue, 'sk-super-secret-value');
      expect(gotScope, 'global');
      expect(find.text('Saved · abcd…wxyz'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(find.textContaining('sk-super-secret-value'), findsNothing);
      expect(sent, ['🔒 Saved CF_TOKEN (everywhere). Continue.']);
    });

    testWidgets('shows a server error inline and sends nothing', (tester) async {
      final sent = <String>[];
      await tester.pumpWidget(host(AssistantText(msg: msg, onChoice: sent.add, onSaveSecret: (_, _, _) async => throw Exception('disk full'))));
      await tester.enterText(find.byType(TextField), 'v');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.textContaining('disk full'), findsOneWidget);
      expect(sent, isEmpty);
    });

    testWidgets('older turns show a read-only line, no field', (tester) async {
      await tester.pumpWidget(host(AssistantText(msg: msg)));
      expect(find.byType(TextField), findsNothing);
      expect(find.text('Asked for CF_TOKEN'), findsOneWidget);
    });
  });
}
