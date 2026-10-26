import 'package:bridge_mobile/core/api.dart';
import 'package:bridge_mobile/widgets/computer.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('desktop tools are the browser and the screen tools', () {
    expect(isDesktopTool('mcp__browser__browser_navigate'), isTrue);
    expect(isDesktopTool('mcp__computer__screenshot'), isTrue);
    expect(isDesktopTool('Bash'), isFalse);
    expect(isDesktopTool('mcp__claude-in-chrome__navigate'), isFalse);
  });

  test('the screen page carries the token in the fragment, not the query', () async {
    final api = BridgeApi('https://bridge.example.dev/', token: () async => 'a.b/c');
    final u = await api.computerUrl();
    expect(u.toString(), 'https://bridge.example.dev/computer.html#t=a.b%2Fc');
    expect(u.query, isEmpty);
    final anon = await BridgeApi('http://localhost:8099').computerUrl();
    expect(anon.toString(), 'http://localhost:8099/computer.html');
  });
}
