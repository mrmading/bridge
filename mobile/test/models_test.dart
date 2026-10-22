import 'package:bridge_mobile/core/clock.dart';
import 'package:bridge_mobile/core/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('HomeData parses the /api/home contract', () {
    final h = HomeData.fromJson({
      'user': 'nestor',
      'assistant': 'Paquito',
      'running': [
        {
          'id': 'r1', 'key': '-k', 'title': 'Polaris tests', 'projectName': 'polaris', 'cwd': '/p', 'started': 1000, 'elapsed': 5, 'prompt': 'run', 'model': 'opus', 'step': 'Running 696 tests',
          'jobs': [
            {'kind': 'subagent', 'title': 'Inbox UI', 'since': 2000, 'agent': 'Engineer'},
            {'kind': 'background', 'title': 'bun test', 'since': 3000},
          ],
        },
      ],
      'needs': [
        {'id': 'n1', 'key': '-k', 'title': 'Deploy?', 'projectName': 'openrally', 'ask': 'Deploy now or wait?', 'since': 9},
      ],
      'made': [
        {'path': '/p/GO-LIVE.md', 'name': 'GO-LIVE.md', 'ext': 'md', 'sessionId': 's', 'key': '-k', 'sessionTitle': 'Runbook', 'mtime': 7},
      ],
      'projects': [
        {'key': '-k', 'name': 'polaris', 'path': '/p', 'count': 41, 'mtime': 5},
      ],
    });
    expect(h.user, 'nestor');
    expect(h.running.single.step, 'Running 696 tests');
    expect(h.running.single.started, 1000);
    expect(h.running.single.jobs.map((j) => j.kind), ['subagent', 'background']);
    expect(h.running.single.jobs.first.agent, 'Engineer');
    expect(h.needs.single.ask, 'Deploy now or wait?');
    expect(h.made.single.ext, 'MD');
    expect(h.projects.single.count, 41);
    expect(h.derived, isFalse);
  });

  test('parsing is lenient: junk and missing fields never throw', () {
    final h = HomeData.fromJson({'running': 'nope', 'needs': [1, null, {}], 'made': [{'path': '/a/b/report.pdf'}]});
    expect(h.running, isEmpty);
    expect(h.needs.single.title, 'Untitled chat');
    expect(h.made.single.name, 'report.pdf');
    expect(h.made.single.ext, 'PDF');
    final r = Run.fromJson({'elapsed': 60000});
    expect(r.started, greaterThan(0));
    expect(JobsState.fromJson({}).running, isFalse);
  });

  test('an older server: home is derived from /api/recent flags', () {
    final recent = [
      SessionMeta.fromJson({'id': 'a', 'key': 'k', 'title': 'A', 'mtime': 1, 'running': true}),
      SessionMeta.fromJson({'id': 'b', 'key': 'k', 'title': 'B', 'mtime': 2, 'needs': true}),
      SessionMeta.fromJson({'id': 'c', 'key': 'k', 'title': 'C', 'mtime': 3}),
    ];
    final h = HomeData.derive(recent, [Project(key: 'k', path: '/x', name: 'x', sessions: 3, lastActivity: 3, exists: true)]);
    expect(h.derived, isTrue);
    expect(h.running.map((r) => r.id), ['a']);
    expect(h.needs.map((n) => n.id), ['b']);
    expect(h.projects.single.count, 3);
  });

  test('elapsed and duration formatting', () {
    expect(fmtElapsed(0), '');
    expect(fmtElapsed(1000, now: 43000), '42s');
    expect(fmtElapsed(0 + 1, now: 372001), '6m 12s');
    expect(fmtElapsed(1, now: 3600001 + 4 * 60000), '1h 04m');
    expect(fmtDuration(const Duration(minutes: 6, seconds: 12)), '6m 12s');
    expect(fmtDuration(const Duration(minutes: 3)), '3m');
    expect(fmtDuration(Duration.zero), '1s');
  });
}
