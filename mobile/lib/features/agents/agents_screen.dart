/// Agents & skills: your team (/api/agents) with "Give a task", and the skills they can use
/// (/api/skills) with "Use", which starts a chat with the skill's slash command.
library;

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../../widgets/common.dart';
import '../shell/drawer.dart';

class AgentsScreen extends StatefulWidget {
  const AgentsScreen({super.key});
  @override
  State<AgentsScreen> createState() => _AgentsScreenState();
}

class _AgentsScreenState extends State<AgentsScreen> {
  final _store = AppStore.instance;
  List<SkillInfo> _skills = const [];
  bool _skillsLoaded = false;
  String _q = '';
  bool _allSkills = false;

  @override
  void initState() {
    super.initState();
    _loadSkills();
  }

  Future<void> _loadSkills() async {
    if (!_store.hasServer) return;
    try {
      final s = await _store.api.skills();
      if (mounted) setState(() => _skills = s);
    } catch (_) {}
    if (mounted) setState(() => _skillsLoaded = true);
  }

  void _giveTask(AgentInfo a) {
    final turn = _store.turn;
    _store.setTurn(TurnOptions(model: turn.model, permissionMode: turn.permissionMode, effort: turn.effort, agent: a.name));
    Nav.instance.newChat();
  }

  bool _match(String a, String b) => _q.isEmpty || '$a $b'.toLowerCase().contains(_q.toLowerCase());

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ListenableBuilder(
      listenable: _store,
      builder: (context, _) {
        final agents = _store.agents.where((a) => _match(a.name, a.description)).toList();
        final skills = _skills.where((s) => _match(s.name, s.description)).toList();
        final shownSkills = _allSkills || _q.isNotEmpty ? skills : skills.take(12).toList();
        return Scaffold(
          appBar: const RootAppBar(title: 'Agents & skills'),
          body: RefreshIndicator(
            color: t.accent,
            onRefresh: () async {
              await Future.wait([_store.refreshAll(), _loadSkills()]);
            },
            child: ListView(physics: const AlwaysScrollableScrollPhysics(), keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag, padding: const EdgeInsets.only(bottom: 32), children: [
              Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 12), child: Text('Your team. Give anyone a task, or let ${_store.assistantName} pick who is best.', style: TextStyle(color: t.muted, fontSize: 14))),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: TextField(onChanged: (v) => setState(() => _q = v.trim()), decoration: const InputDecoration(hintText: 'Find an agent or skill…', prefixIcon: Icon(Icons.search_rounded))),
              ),
              SecHeader(icon: Icons.groups_2_outlined, title: 'Your team', count: agents.length),
              if (agents.isEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text('No agents found.', style: TextStyle(color: t.muted))),
              for (final a in agents) _AgentCard(a, selected: _store.turn.agent == a.name, onTask: () => _giveTask(a)),
              SecHeader(icon: Icons.auto_awesome_outlined, title: 'Skills', count: _skills.length, more: !_allSkills && _q.isEmpty && skills.length > 12 ? 'Show all' : null, onMore: () => setState(() => _allSkills = true)),
              if (!_skillsLoaded) Center(child: Padding(padding: const EdgeInsets.all(16), child: CircularProgressIndicator(color: t.accent, strokeWidth: 2))),
              if (_skillsLoaded && skills.isEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text('No skills found.', style: TextStyle(color: t.muted))),
              if (shownSkills.isNotEmpty)
                Container(
                  margin: const EdgeInsets.symmetric(horizontal: 16),
                  decoration: BoxDecoration(color: t.raised, borderRadius: BorderRadius.circular(14), border: Border.all(color: t.border)),
                  clipBehavior: Clip.antiAlias,
                  child: Column(children: [for (var i = 0; i < shownSkills.length; i++) _SkillRow(shownSkills[i], last: i == shownSkills.length - 1)]),
                ),
            ]),
          ),
        );
      },
    );
  }
}

class _AgentCard extends StatelessWidget {
  const _AgentCard(this.a, {required this.selected, required this.onTask});
  final AgentInfo a;
  final bool selected;
  final VoidCallback onTask;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Card2(
      accent: selected,
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Ava(name: a.name, size: 42, color: parseHex(a.color)),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(a.name, style: TextStyle(color: t.fg, fontSize: 15.5, fontWeight: FontWeight.w600)),
            const SizedBox(height: 2),
            Text(a.description, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 13, height: 1.35)),
            const SizedBox(height: 8),
            Row(children: [
              if (a.model.isNotEmpty) ...[Tag(a.model, kind: 'think'), const SizedBox(width: 6)],
              if (a.category.isNotEmpty) Flexible(child: Tag(a.category)),
              const Spacer(),
              OutlinedButton(
                onPressed: onTask,
                style: OutlinedButton.styleFrom(minimumSize: const Size(44, 36), padding: const EdgeInsets.symmetric(horizontal: 12), foregroundColor: t.fg, side: BorderSide(color: t.borderStrong), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9))),
                child: const Text('Give a task', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              ),
            ]),
          ]),
        ),
      ]),
    );
  }
}

class _SkillRow extends StatelessWidget {
  const _SkillRow(this.s, {required this.last});
  final SkillInfo s;
  final bool last;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: t.border))),
      child: Row(children: [
        Container(width: 32, height: 32, decoration: BoxDecoration(color: t.thinkSoft, borderRadius: BorderRadius.circular(9)), child: Icon(Icons.auto_awesome_outlined, size: 16, color: t.think)),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(s.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14.5, fontWeight: FontWeight.w600)),
            Text(s.description, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.muted, fontSize: 12.5)),
          ]),
        ),
        TextButton(
          onPressed: () => Nav.instance.newChat(text: '/${s.name} '),
          style: TextButton.styleFrom(foregroundColor: t.accent, minimumSize: const Size(44, 40)),
          child: const Text('Use'),
        ),
      ]),
    );
  }
}
