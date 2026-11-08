import 'package:bridge_mobile/core/models.dart';
import 'package:bridge_mobile/core/project_guess.dart';
import 'package:flutter_test/flutter_test.dart';

Project p(String path, {String name = '', int at = 0}) => Project(key: path, path: path, name: name, sessions: 1, lastActivity: at, exists: true);

void main() {
  final projects = [
    p('/Users/x/setpoint', name: 'setpoint', at: 5),
    p('/Users/x/setpoint/apps/openrally', name: 'openrally', at: 6),
    p('/Users/x/Desktop/Cowork/bridge', at: 2),
    p('/Users/x/Desktop/Cowork/thepadelsociety', name: 'thepadelsociety', at: 4),
  ];

  test('a message about another project suggests a new chat there', () {
    expect(guessOtherProject('now fix the thepadelsociety login', projects, '/Users/x/Desktop/Cowork/bridge')?.path, '/Users/x/Desktop/Cowork/thepadelsociety');
  });

  test('same project, nested folders and chained work stay in this chat', () {
    expect(guessOtherProject('bridge connectors again', projects, '/Users/x/Desktop/Cowork/bridge'), isNull);
    expect(guessOtherProject('openrally landing copy', projects, '/Users/x/setpoint'), isNull); // nested
    expect(guessOtherProject('setpoint pricing', projects, '/Users/x/setpoint/apps/openrally'), isNull); // parent
    expect(guessOtherProject('port this bridge fix to thepadelsociety', projects, '/Users/x/Desktop/Cowork/bridge'), isNull); // names both
    expect(guessOtherProject('keep going', projects, '/Users/x/Desktop/Cowork/bridge'), isNull);
    expect(guessOtherProject('thepadelsociety', projects, ''), isNull);
  });
}
