/// Small helpers shared by every feature: folder names, pretty paths, and one way to open or
/// start a chat (through [Nav], so it lands behind the drawer like every other chat).
library;

import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/store.dart';

export '../../core/nav.dart' show projectKeyFor, uuidV4;

String baseName(String path) {
  final parts = path.split('/').where((x) => x.isNotEmpty).toList();
  return parts.isEmpty ? (path.isEmpty ? '' : '/') : parts.last;
}

/// Shows `~/…` instead of the home prefix when we know it.
String prettyPath(String path) {
  final home = AppStore.instance.boot?.home ?? '';
  if (home.isNotEmpty && path.startsWith(home)) return '~${path.substring(home.length)}';
  return path;
}

/// Opens an existing chat (history on disk, possibly still running).
void openSession({required String key, required String id, required String cwd, String title = '', bool focus = false, String computer = 'mac'}) =>
    Nav.instance.openChat(ChatRef(key: key, id: id, cwd: cwd, title: title, focus: focus, computer: computer));

/// Starts a brand-new chat in [cwd]. When [message] is set it is sent right away.
void startNewSession({required String cwd, String message = ''}) => Nav.instance.startChat(cwd: cwd, message: message);

/// The folder a new chat runs in when the user picked "Any project": the server's home.
String defaultCwd() => AppStore.instance.boot?.home ?? '';

/// Folders that are not projects: the home folder itself, anything inside ~/.claude, and
/// throwaway worktrees (agent-1a2b…, repo-wt-feature).
bool isProjectPath(String path) {
  final home = defaultCwd();
  if (path.isEmpty || path == home) return false;
  if (home.isNotEmpty && path.startsWith('$home/.claude')) return false;
  final name = baseName(path);
  return !RegExp(r'^agent-[0-9a-f]{6,}$').hasMatch(name) && !name.contains('-wt-');
}

/// "Home" for the home folder, else the folder name.
String folderLabel(String cwd) => cwd.isNotEmpty && cwd == defaultCwd() ? 'Home' : baseName(cwd);

/// A chat's project as people say it: "Home" for the home folder.
String projectNameOf(SessionMeta s) {
  final p = s.projectPath.isNotEmpty ? s.projectPath : s.cwd;
  if (p.isNotEmpty && p == defaultCwd()) return 'Home';
  return s.projectName.isNotEmpty ? s.projectName : s.folder;
}
