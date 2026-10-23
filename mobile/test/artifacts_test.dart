import 'package:bridge_mobile/core/artifacts.dart';
import 'package:bridge_mobile/core/models.dart';
import 'package:bridge_mobile/core/theme.dart';
import 'package:bridge_mobile/widgets/artifact.dart';
import 'package:bridge_mobile/widgets/turn.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Msg tool(String name, Map<String, dynamic> input) => Msg(kind: 'tool', name: name, input: input);
Msg say(String text) => Msg(kind: 'assistant', text: text);

void main() {
  test('kinds by extension', () {
    expect(artifactKindOf('/a/b/page.HTML'), ArtifactKind.html);
    expect(artifactKindOf('/a/notes.md'), ArtifactKind.markdown);
    expect(artifactKindOf('/a/logo.svg'), ArtifactKind.svg);
    expect(artifactKindOf('/a/shot.jpeg'), ArtifactKind.image);
    expect(artifactKindOf('/a/deck.pdf'), ArtifactKind.pdf);
    expect(artifactKindOf('/a/main.dart'), isNull);
  });

  test('a turn yields artifacts from writes, edits, the Artifact tool and paths in the answer', () {
    final msgs = [
      tool('Read', {'file_path': '/p/readme.md'}),
      tool('Write', {'file_path': '/p/report.html'}),
      tool('Edit', {'file_path': '/p/report.html'}),
      tool('Edit', {'file_path': '/p/lib/x.dart'}),
      tool('Artifact', {'file_path': '/p/chart.svg'}),
      say('Done. Open `/p/out/summary.pdf` or [the notes](/p/notes.md). See https://x.com/a.html too.'),
    ];
    final a = turnArtifacts(msgs);
    expect(a.map((x) => x.path).toList(), ['/p/report.html', '/p/chart.svg', '/p/out/summary.pdf', '/p/notes.md']);
    expect(a.first.isNew, true);
    expect(a.first.kind, ArtifactKind.html);
  });

  test('Read alone and URLs are not artifacts', () {
    expect(turnArtifacts([tool('Read', {'file_path': '/p/a.html'}), say('see https://site.dev/x.html')]), isEmpty);
  });

  test('revisions count every write or edit, so an open preview knows to reload', () {
    Msg done(String name, String path, {bool err = false}) => Msg(kind: 'tool', name: name, input: {'file_path': path}, result: ToolResult(content: '', isError: err));
    final r = artifactRevisions([
      done('Write', '/p/a.html'),
      done('Edit', '/p/a.html'),
      done('MultiEdit', '/p/a.html'),
      done('Edit', '/p/a.html', err: true),
      tool('Edit', {'file_path': '/p/a.html'}), // still running: the file has not changed yet
      done('Write', '/p/b.md'),
    ]);
    expect(r['/p/a.html'], 3);
    expect(r['/p/b.md'], 1);
  });

  test('same rules as the web: failed writes, ~/ paths, Artifact file_paths', () {
    final failed = Msg(kind: 'tool', name: 'Write', input: {'file_path': '/p/bad.html'}, result: ToolResult(content: 'denied', isError: true));
    final a = turnArtifacts([
      failed,
      tool('Artifact', {'file_paths': ['/p/a.png', '/p/b.svg']}),
      say('Saved to ~/Downloads/report.pdf and **/tmp/x/page.html**.'),
    ]);
    expect(a.map((x) => x.path).toList(), ['/p/a.png', '/p/b.svg', '~/Downloads/report.pdf', '/tmp/x/page.html']);
  });

  test('side tools do not count as the turn using tools', () {
    expect(turnHasTools([Msg(kind: 'tool', name: 'Bash', side: true), say('hi')]), false);
  });

  test('a turn has tools only once a tool_use arrives', () {
    expect(turnHasTools([Msg(kind: 'thinking', text: 'hm'), say('hi')]), false);
    expect(turnHasTools([say('hi'), tool('Bash', {'command': 'ls'})]), true);
  });

  Widget host(Widget w) => MaterialApp(theme: buildTheme(Brightness.dark), home: Scaffold(body: SingleChildScrollView(child: w)));

  testWidgets('a text-only turn is plain chat: typing dots while live, no work line', (tester) async {
    await tester.pumpWidget(host(AssistantTurn(msgs: [Msg(kind: 'thinking', text: 'hmm'), say('Hello there')], name: 'Paquito', live: true)));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(WorkBlock), findsNothing);
    expect(find.byKey(const ValueKey('typing')), findsOneWidget);
    expect(find.textContaining('Hello there'), findsOneWidget);
    await tester.pumpWidget(host(AssistantTurn(msgs: [say('Hello there')], name: 'Paquito')));
    expect(find.byKey(const ValueKey('typing')), findsNothing);
    expect(find.byType(WorkBlock), findsNothing);
  });

  testWidgets('the work line appears with the first tool, and artifacts get a card', (tester) async {
    String? opened;
    await tester.pumpWidget(host(AssistantTurn(
      msgs: [say('On it'), tool('Write', {'file_path': '/p/site/index.html'})],
      name: 'Paquito',
      live: true,
      onOpenArtifact: (p) => opened = p,
    )));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(WorkBlock), findsOneWidget);
    expect(find.byKey(const ValueKey('typing')), findsNothing);
    expect(find.byType(ArtifactCard), findsOneWidget);
    expect(find.text('Web page · HTML · New'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('artifact:/p/site/index.html')));
    expect(opened, '/p/site/index.html');
  });
}
