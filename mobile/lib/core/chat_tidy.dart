/// Tidies the sidebar's chat list without touching any session: hides throwaway test chats
/// ("reply ok", "Reply with exactly the word: pong", one-turn "hi"), runs in temp folders (agent evals
/// and scratchpads) and repeated titles (the newest copy stays). Search still finds every chat; running, waiting and renamed chats always show.
library;

import 'models.dart';

final _trivial = RegExp(r'^(reply|respond|answer|say)( only)?( with)?( exactly)?( the)?( single)?( word)?:?\s*["\x27]?\w+["\x27]?[.!]?$|^(hi|hey|hello|test(ing)?|ping|pong|ok(ay)?|yo|untitled session)[.!?]*$', caseSensitive: false);

String _norm(String title) => title.toLowerCase().replaceAll(RegExp(r'\s+'), ' ').replaceAll(RegExp(r'[\s.!?…]+$'), '').trim();

final _scratch = RegExp(r'^(/private)?/(tmp|var/folders)/');

/// True for a chat nobody needs in the list: a one-word ping or test prompt, or a run in a temp folder.
bool isTrivialChat(SessionMeta s) {
  if (s.named || s.running || s.needs) return false;
  final dir = s.cwd.isNotEmpty ? s.cwd : s.projectPath;
  return _trivial.hasMatch(s.title.trim()) || _scratch.hasMatch(dir);
}

/// [recent] without trivial chats and with one chat per title, newest first.
List<SessionMeta> tidyChats(List<SessionMeta> recent) {
  final sorted = [...recent]..sort((a, b) => b.mtime.compareTo(a.mtime));
  final seen = <String>{};
  return [
    for (final s in sorted)
      if (!isTrivialChat(s) && (s.named || s.running || s.needs || seen.add(_norm(s.title)))) s,
  ];
}
