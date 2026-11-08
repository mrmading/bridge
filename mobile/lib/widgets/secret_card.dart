/// The secure token input: one card per line of a ```secret block. The value lives only in the
/// field's controller until Save; it is sent once to POST /api/secrets and cleared. It never goes
/// into the transcript, the composer, a toast or a log. The thread only hears
/// `🔒 Saved NAME (everywhere). Continue.`
library;

import 'package:flutter/material.dart';

import '../core/models.dart';
import '../core/theme.dart';
import 'transcript.dart' show mono;

/// Saves [value] for [req] under [scope] (`global` | `project`). Returns the masked hint
/// (`abcd…wxyz`); throws with a readable message.
typedef SaveSecret = Future<String> Function(SecretRequest req, String value, String scope);

/// The follow-up message once every token in a block is saved. One token reads exactly
/// `🔒 Saved NAME (everywhere). Continue.`; several are listed in one message so they make one turn.
String secretsSavedMessage(List<({String name, String scope})> saved) {
  if (saved.length == 1) return secretSavedMessage(saved.first.name, saved.first.scope);
  final parts = [for (final s in saved) '${s.name} (${s.scope == 'project' ? 'this project' : 'everywhere'})'];
  return '🔒 Saved ${parts.join(', ')}. Continue.';
}

/// All the tokens one assistant message asked for. [onSave] is null on older turns: the request
/// then shows as a quiet read-only line. [onDone] gets the follow-up message once all are saved.
class SecretPrompt extends StatefulWidget {
  const SecretPrompt({super.key, required this.requests, this.onSave, this.onDone});
  final List<SecretRequest> requests;
  final SaveSecret? onSave;
  final ValueChanged<String>? onDone;
  @override
  State<SecretPrompt> createState() => _SecretPromptState();
}

class _SecretPromptState extends State<SecretPrompt> {
  /// name → (scope, hint) for the tokens saved from this card.
  final Map<String, ({String scope, String hint})> _saved = {};
  bool _sent = false;

  void _onSaved(SecretRequest r, String scope, String hint) {
    setState(() => _saved[r.name] = (scope: scope, hint: hint));
    if (_sent || !widget.requests.every((q) => _saved.containsKey(q.name))) return;
    _sent = true;
    widget.onDone?.call(secretsSavedMessage([for (final q in widget.requests) (name: q.name, scope: _saved[q.name]!.scope)]));
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    if (widget.onSave == null && _saved.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 2),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final r in widget.requests)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(children: [
                Icon(Icons.lock_outline_rounded, size: 14, color: t.faint),
                const SizedBox(width: 7),
                Flexible(child: Text('Asked for ${r.name}', overflow: TextOverflow.ellipsis, style: mono(12.5, t.muted))),
              ]),
            ),
        ]),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final r in widget.requests)
        SecretCard(
          key: ValueKey('secret-${r.name}'),
          request: r,
          saved: _saved[r.name],
          onSave: widget.onSave,
          onSaved: (scope, hint) => _onSaved(r, scope, hint),
        ),
    ]);
  }
}

class SecretCard extends StatefulWidget {
  const SecretCard({super.key, required this.request, this.saved, this.onSave, this.onSaved});
  final SecretRequest request;
  final ({String scope, String hint})? saved;
  final SaveSecret? onSave;
  final void Function(String scope, String hint)? onSaved;
  @override
  State<SecretCard> createState() => _SecretCardState();
}

class _SecretCardState extends State<SecretCard> {
  final TextEditingController _value = TextEditingController();
  late String _scope = widget.request.scope;
  bool _show = false;
  bool _saving = false;
  String _error = '';

  @override
  void dispose() {
    _value.clear();
    _value.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final save = widget.onSave;
    if (save == null || _saving) return;
    if (_value.text.trim().isEmpty) {
      setState(() => _error = 'Paste the token first');
      return;
    }
    setState(() {
      _saving = true;
      _error = '';
    });
    try {
      final hint = await save(widget.request, _value.text.trim(), _scope);
      _value.clear();
      if (!mounted) return;
      setState(() {
        _saving = false;
        _show = false;
      });
      widget.onSaved?.call(_scope, hint);
    } catch (e) {
      if (!mounted) return;
      // The server's reason only; never echo the value.
      setState(() {
        _saving = false;
        _error = e.toString().isEmpty ? 'Could not save the token' : e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final r = widget.request;
    final saved = widget.saved;
    return Container(
      margin: const EdgeInsets.only(top: 10, bottom: 4),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: saved != null ? t.okSoft.withValues(alpha: .5) : t.accentSoft.withValues(alpha: .55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: (saved != null ? t.ok : t.accent).withValues(alpha: .45)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Icon(saved != null ? Icons.lock_rounded : Icons.lock_outline_rounded, size: 16, color: saved != null ? t.ok : t.accent),
          const SizedBox(width: 8),
          Expanded(child: SelectableText(r.name, maxLines: 1, style: mono(13.5, t.fg, weight: FontWeight.w700))),
        ]),
        if (r.hint.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(r.hint, style: TextStyle(color: t.muted, fontSize: 13.5, height: 1.35)),
        ],
        const SizedBox(height: 10),
        if (saved != null)
          Row(children: [
            Icon(Icons.check_circle_rounded, size: 16, color: t.ok),
            const SizedBox(width: 7),
            Flexible(
              child: Text(
                saved.hint.isEmpty ? 'Saved' : 'Saved · ${saved.hint}',
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: t.ok, fontSize: 13.5, fontWeight: FontWeight.w600),
              ),
            ),
            const SizedBox(width: 8),
            Text(saved.scope == 'project' ? 'This project' : 'Everywhere', style: TextStyle(color: t.muted, fontSize: 12.5)),
          ])
        else ...[
          SecretScopeToggle(value: _scope, onChanged: _saving || widget.onSave == null ? null : (s) => setState(() => _scope = s)),
          const SizedBox(height: 10),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: SecretField(
                controller: _value,
                show: _show,
                enabled: !_saving && widget.onSave != null,
                onToggleShow: () => setState(() => _show = !_show),
                onSubmitted: (_) => _save(),
                hintText: 'Paste ${r.name}',
              ),
            ),
            const SizedBox(width: 8),
            SizedBox(
              height: 48,
              child: FilledButton(
                onPressed: _saving || widget.onSave == null ? null : _save,
                child: _saving ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Save'),
              ),
            ),
          ]),
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8, left: 2),
              child: Text(_error, style: TextStyle(color: t.err, fontSize: 13)),
            ),
        ],
      ]),
    );
  }
}

/// Everywhere (global) / This project (project).
class SecretScopeToggle extends StatelessWidget {
  const SecretScopeToggle({super.key, required this.value, this.onChanged});
  final String value;
  final ValueChanged<String>? onChanged;
  @override
  Widget build(BuildContext context) {
    return SegmentedButton<String>(
      showSelectedIcon: false,
      style: const ButtonStyle(visualDensity: VisualDensity.compact, tapTargetSize: MaterialTapTargetSize.shrinkWrap),
      segments: const [
        ButtonSegment(value: 'global', label: Text('Everywhere'), icon: Icon(Icons.public_rounded, size: 16)),
        ButtonSegment(value: 'project', label: Text('This project'), icon: Icon(Icons.folder_outlined, size: 16)),
      ],
      selected: {value == 'project' ? 'project' : 'global'},
      onSelectionChanged: onChanged == null ? null : (s) => onChanged!(s.first),
    );
  }
}

/// An obscured, non-learning, non-autofilling field for a token, with a show/hide eye.
class SecretField extends StatelessWidget {
  const SecretField({super.key, required this.controller, required this.show, required this.onToggleShow, this.enabled = true, this.onSubmitted, this.hintText = 'Paste the token'});
  final TextEditingController controller;
  final bool show, enabled;
  final VoidCallback onToggleShow;
  final ValueChanged<String>? onSubmitted;
  final String hintText;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return TextField(
      controller: controller,
      enabled: enabled,
      obscureText: !show,
      autocorrect: false,
      enableSuggestions: false,
      enableIMEPersonalizedLearning: false,
      smartDashesType: SmartDashesType.disabled,
      smartQuotesType: SmartQuotesType.disabled,
      keyboardType: TextInputType.visiblePassword,
      // null (not empty) turns autofill off: nothing is offered and nothing is saved to a keychain.
      autofillHints: null,
      textInputAction: TextInputAction.done,
      onSubmitted: onSubmitted,
      maxLines: 1,
      style: mono(14, t.fg),
      decoration: InputDecoration(
        isDense: true,
        hintText: hintText,
        hintStyle: TextStyle(color: t.faint, fontSize: 14),
        filled: true,
        fillColor: t.raised,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: t.border)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: t.border)),
        suffixIcon: IconButton(
          tooltip: show ? 'Hide' : 'Show',
          icon: Icon(show ? Icons.visibility_off_outlined : Icons.visibility_outlined, size: 19, color: t.muted),
          onPressed: onToggleShow,
        ),
      ),
    );
  }
}
