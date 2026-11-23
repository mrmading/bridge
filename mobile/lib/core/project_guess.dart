/// Which project a new chat's first message is probably about: a cheap local match of the text
/// against the known projects' names and folder names. Only ever a suggestion; the user decides.
library;

import 'models.dart';

/// Folder names too generic to mean one project on their own.
const _generic = {'app', 'apps', 'mobile', 'web', 'site', 'src', 'api', 'docs', 'home', 'desktop', 'cowork', 'code', 'server', 'backend', 'frontend', 'admin', 'test', 'tests', 'main', 'new', 'old', 'tmp', 'data', 'deploy', 'project', 'projects'};

/// "padel-backend", "padelBackend", "Padel Backend" → "padel backend"
String _norm(String s) => s
    .replaceAllMapped(RegExp(r'([a-z0-9])([A-Z])'), (m) => '${m[1]} ${m[2]}')
    .toLowerCase()
    .replaceAll(RegExp(r'[^a-z0-9]+'), ' ')
    .trim();

/// The names a project answers to: its display name and its folder name, normalised.
Set<String> _names(Project p) {
  final parts = p.path.split('/').where((x) => x.isNotEmpty).toList();
  return {_norm(p.name), if (parts.isNotEmpty) _norm(parts.last)}..removeWhere((n) => n.length < 3 || _generic.contains(n));
}

/// The best match, or null when nothing in [text] names a project. A whole-name hit wins; ties go
/// to the project used most recently. Spaces in a name may be typed as nothing ("thepadelsociety").
Project? guessProject(String text, List<Project> projects) {
  final t = ' ${_norm(text)} ';
  if (t.trim().length < 3) return null;
  final squashed = t.replaceAll(' ', '');
  Project? best;
  var bestScore = 0;
  for (final p in projects) {
    var score = 0;
    for (final n in _names(p)) {
      if (t.contains(' $n ')) {
        score = score < n.length + 100 ? n.length + 100 : score;
      } else if (n.contains(' ') && n.length >= 8 && squashed.contains(n.replaceAll(' ', ''))) {
        score = score < n.length + 50 ? n.length + 50 : score;
      }
    }
    if (score > bestScore || (score > 0 && score == bestScore && p.lastActivity > (best?.lastActivity ?? 0))) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

/// Same folder, or one inside the other (a chat in ~/setpoint working on ~/setpoint/apps/openrally).
bool _related(String a, String b) {
  final x = a.replaceAll(RegExp(r'/+$'), ''), y = b.replaceAll(RegExp(r'/+$'), '');
  return x == y || x.startsWith('$y/') || y.startsWith('$x/');
}

/// For a message typed into an existing chat in [cwd]: the different project it clearly points at, or
/// null. Quiet when the guess is this chat's own folder (or nested in it), and when the text also
/// names this chat's project: chained work across both stays in one chat.
Project? guessOtherProject(String text, List<Project> projects, String cwd) {
  final g = guessProject(text, projects);
  if (g == null || cwd.isEmpty || _related(g.path, cwd)) return null;
  final own = projects.where((p) => _related(p.path, cwd)).toList();
  if (own.isNotEmpty && guessProject(text, own) != null) return null;
  return g;
}
