import 'package:bridge_mobile/core/chat_tidy.dart';
import 'package:bridge_mobile/core/models.dart';
import 'package:flutter_test/flutter_test.dart';

SessionMeta s(String id, String title, int mtime, {bool named = false, bool needs = false, String cwd = '/Users/me'}) =>
    SessionMeta(id: id, key: 'k', title: title, preview: '', mtime: mtime, turns: 2, named: named, needs: needs, cwd: cwd);

void main() {
  test('hides test pings and keeps the newest copy of a repeated title', () {
    final out = tidyChats([
      s('1', 'reply ok', 9),
      s('2', 'Reply with exactly the word: pong', 8),
      s('3', 'reply with the word ok', 7),
      s('4', 'review prs of alba for setpoint and merge', 6),
      s('5', 'Review PRs of alba for setpoint and merge.', 5),
      s('6', 'Lets clean our project directory', 4),
      s('7', 'hi', 3),
      s('8', 'Reply in Spanish to the investor email', 2),
      s('9', 'What model are you?', 1, cwd: '/private/var/folders/gm/T/qwen-eval/identity'),
      s('10', 'Summarize README.md', 1, cwd: '/private/tmp/claude-501/x/scratchpad'),
    ]);
    expect(out.map((e) => e.id), ['4', '6', '8']);
  });

  test('renamed and waiting chats always show', () {
    final out = tidyChats([s('1', 'ok', 3, named: true), s('2', 'ping', 2, needs: true), s('3', 'ok', 1)]);
    expect(out.map((e) => e.id), ['1', '2']);
  });
}
