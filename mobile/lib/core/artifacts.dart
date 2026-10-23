/// Artifacts: files a turn made that read better rendered than as code (a web page, a markdown
/// doc, an image, an SVG, a PDF). Found in Write/Edit calls, the Artifact tool, and absolute
/// paths the answer mentions.
library;

import 'models.dart';

enum ArtifactKind { html, markdown, svg, image, pdf }

ArtifactKind? artifactKindOf(String path) {
  final dot = path.lastIndexOf('.');
  if (dot < 0 || dot < path.lastIndexOf('/')) return null;
  return switch (path.substring(dot + 1).toLowerCase()) {
    'html' || 'htm' => ArtifactKind.html,
    'md' || 'markdown' => ArtifactKind.markdown,
    'svg' => ArtifactKind.svg,
    'png' || 'jpg' || 'jpeg' || 'gif' || 'webp' => ArtifactKind.image,
    'pdf' => ArtifactKind.pdf,
    _ => null,
  };
}

String artifactKindLabel(ArtifactKind k) => switch (k) {
      ArtifactKind.html => 'Web page',
      ArtifactKind.markdown => 'Document',
      ArtifactKind.svg => 'Vector image',
      ArtifactKind.image => 'Image',
      ArtifactKind.pdf => 'PDF',
    };

/// Kinds whose source reads as text, so the sheet offers Code next to Preview.
bool artifactHasCode(ArtifactKind k) => k == ArtifactKind.html || k == ArtifactKind.markdown || k == ArtifactKind.svg;

class ArtifactRef {
  const ArtifactRef(this.path, this.kind, {this.isNew = false});
  final String path;
  final ArtifactKind kind;
  final bool isNew;
}

const _writes = {'Write', 'Edit', 'MultiEdit'};

String _pathOf(Msg m) => (m.input?['file_path'] ?? m.input?['path'] ?? '').toString();

// An absolute path ending in a previewable extension, not part of a URL (no ':' or '/' before it).
final _pathInText = RegExp(r'(?<![\w:/.~-])(/[^\s`"' "'" r'()<>\[\]]+\.(?:html?|md|markdown|svg|png|jpe?g|gif|webp|pdf))(?![\w/])', caseSensitive: false);

/// A turn's artifacts in first-seen order, one per path.
List<ArtifactRef> turnArtifacts(List<Msg> msgs) {
  final out = <String, ArtifactRef>{};
  void add(String p, {bool isNew = false}) {
    if (p.isEmpty || out.containsKey(p)) return;
    final k = artifactKindOf(p);
    if (k != null) out[p] = ArtifactRef(p, k, isNew: isNew);
  }

  for (final m in msgs) {
    if (m.isTool && (_writes.contains(m.name) || m.name == 'Artifact')) add(_pathOf(m), isNew: m.name == 'Write');
  }
  for (final m in msgs) {
    if (m.isAssistant && !m.side) {
      for (final x in _pathInText.allMatches(m.text)) {
        add(x.group(1)!);
      }
    }
  }
  return out.values.toList();
}

/// How many times each file was written or edited in the whole chat; an open preview reloads when
/// its number moves. Only finished calls count: the file changes on disk when the result lands,
/// not when the call starts.
Map<String, int> artifactRevisions(List<Msg> msgs) {
  final out = <String, int>{};
  for (final m in msgs) {
    if (m.isTool && _writes.contains(m.name) && m.result != null && !m.result!.isError) {
      final p = _pathOf(m);
      if (p.isNotEmpty) out[p] = (out[p] ?? 0) + 1;
    }
  }
  return out;
}

/// Tool UI (steps, work line, progress) shows only once the turn has made a tool call.
bool turnHasTools(List<Msg> msgs) => msgs.any((m) => m.isTool);
