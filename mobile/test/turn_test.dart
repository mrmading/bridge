import 'package:bridge_mobile/core/models.dart';
import 'package:bridge_mobile/core/theme.dart';
import 'package:bridge_mobile/widgets/transcript.dart';
import 'package:bridge_mobile/widgets/turn.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Msg tool(String name, Map<String, dynamic> input, {bool err = false, DateTime? ts}) =>
    Msg(kind: 'tool', id: '$name${input.hashCode}', name: name, input: input, ts: ts, result: ToolResult(content: '', isError: err));

void main() {
  final t0 = DateTime(2026, 10, 22, 9);
  final tools = [
    tool('Read', {'file_path': '/r/a.dart'}, ts: t0.add(const Duration(seconds: 2))),
    tool('Read', {'file_path': '/r/b.dart'}),
    tool('Read', {'file_path': '/r/a.dart'}),
    tool('Bash', {'command': 'bun test', 'description': 'run the tests'}),
    tool('Write', {'file_path': '/r/GO-LIVE.md'}),
    tool('Edit', {'file_path': '/r/a.dart'}),
    tool('TodoWrite', {'todos': []}),
  ];

  test('work summary counts distinct files and keeps the three biggest kinds', () {
    expect(workCounts(tools), 'read 2 files · edited 1 file · wrote 1 file');
    expect(workLabel(tools, took: const Duration(minutes: 6, seconds: 12)), startsWith('Worked for 6m 12s · read 2 files'));
    expect(workLabel(const [], live: true), 'Working');
    expect(workLabel(tools, live: true), 'Working · 7 steps so far');
  });

  test('steps read as plain English', () {
    expect(stepSentence(tools[0]), 'Read a.dart');
    expect(stepSentence(tools[3]), 'Run the tests');
    expect(stepSentence(tool('Bash', {'command': 'ls -la'})), 'Ran ls -la');
    expect(stepSentence(tool('Grep', {'pattern': 'TODO'})), 'Searched the code for “TODO”');
    expect(stepSentence(tool('mcp__claude_ai_Slack__slack_send_message', {})), 'Used Slack: slack send message');
  });

  test('touched files: Write is new, Edit is edited, first sighting wins', () {
    final f = touchedFiles(tools);
    expect(f, {'/r/GO-LIVE.md': true, '/r/a.dart': false});
  });

  Widget host(Widget child) => MaterialApp(theme: buildTheme(Brightness.dark), home: Scaffold(body: SingleChildScrollView(child: child)));

  testWidgets('a finished turn is one work line, the prose and a file card; tap expands the steps', (tester) async {
    final msgs = [
      ...tools,
      Msg(kind: 'assistant', text: 'The runbook is **ready**.', ts: t0.add(const Duration(minutes: 1, seconds: 5))),
    ];
    await tester.pumpWidget(host(AssistantTurn(msgs: msgs, name: 'Paquito', started: t0)));
    expect(find.textContaining('Worked for 1m 5s'), findsOneWidget);
    expect(find.text('Read a.dart'), findsNothing);
    expect(find.text('GO-LIVE.md'), findsOneWidget);
    expect(find.byType(ToolCard), findsNothing);
    await tester.tap(find.textContaining('Worked for'));
    await tester.pump();
    expect(find.text('Read a.dart'), findsWidgets);
    expect(find.text('Run the tests'), findsOneWidget);
  });

  testWidgets('technical details show the raw tool cards instead', (tester) async {
    await tester.pumpWidget(host(AssistantTurn(msgs: tools, name: 'Paquito', started: t0, showTech: true)));
    expect(find.byType(ToolCard), findsNWidgets(tools.length));
    expect(find.textContaining('Worked for'), findsNothing);
  });

  testWidgets('a job card shows helpers and the promise that leaving is fine', (tester) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    await tester.pumpWidget(host(JobCard(title: 'Running the full test suite', since: now - 65000, jobs: [
      Job(kind: 'subagent', title: 'Inbox UI', since: now - 30000, agent: 'Engineer'),
      Job(kind: 'background', title: 'bun test', since: now - 60000),
    ])));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Running the full test suite'), findsOneWidget);
    expect(find.text('Inbox UI'), findsOneWidget);
    expect(find.text('bun test'), findsOneWidget);
    expect(find.textContaining("You can leave"), findsOneWidget);
    expect(find.textContaining('1m 0'), findsNWidgets(2));
    // The shared clock ticks the timers.
    await tester.pump(const Duration(seconds: 2));
    expect(find.textContaining('1m 0'), findsNWidgets(2));
  });
}
