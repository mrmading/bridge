import 'package:bridge_mobile/core/models.dart';
import 'package:bridge_mobile/core/project_guess.dart';
import 'package:flutter_test/flutter_test.dart';

Project p(String path, {String name = '', int at = 0}) => Project(key: path, path: path, name: name, sessions: 1, lastActivity: at, exists: true);

void main() {
  final projects = [
    p('/Users/x/setpoint', name: 'setpoint', at: 5),
    p('/Users/x/Desktop/Cowork/thepadelsociety', name: 'thepadelsociety', at: 4),
    p('/Users/x/Desktop/Cowork/padel-backend', at: 3),
    p('/Users/x/Desktop/Cowork/bridge/mobile', name: 'mobile', at: 9),
    p('/Users/x/Desktop/Cowork/bridge', at: 2),
  ];

  test('names a project by its name or folder, case and punctuation aside', () {
    expect(guessProject('fix the Setpoint booking page', projects)?.path, '/Users/x/setpoint');
    expect(guessProject('bridge: connectors flow', projects)?.path, '/Users/x/Desktop/Cowork/bridge');
    expect(guessProject('migration on padel backend please', projects)?.path, '/Users/x/Desktop/Cowork/padel-backend');
    expect(guessProject('padelbackend logs', projects)?.path, '/Users/x/Desktop/Cowork/padel-backend');
  });

  test('stays quiet without a clear hit', () {
    expect(guessProject('write me a poem', projects), isNull);
    expect(guessProject('the mobile app crashes', projects), isNull); // generic folder names never match
    expect(guessProject('setpointless', projects), isNull); // whole words only
    expect(guessProject('', projects), isNull);
  });

  test('a longer name beats a shorter one; ties go to the most recent', () {
    final two = [p('/a/padel', at: 9), p('/b/padel-backend', at: 1)];
    expect(guessProject('padel backend deploy', two)?.path, '/b/padel-backend');
    final tie = [p('/a/old/bridge', at: 1), p('/b/new/bridge', at: 7)];
    expect(guessProject('bridge', tie)?.path, '/b/new/bridge');
  });
}
