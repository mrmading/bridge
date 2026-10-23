/// The sidebar, Claude-style: New chat, Search, the five places, then chats (working now with a
/// pulse and a live timer, waiting ones flagged, the rest by day) and the account footer.
library;

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/nav.dart';
import '../../core/store.dart';
import '../../core/theme.dart';
import '../../widgets/bridge.dart';
import '../search/search_screen.dart';
import '../session/session_utils.dart';
import '../settings/settings_screen.dart';
import '../talk/talk_screen.dart';

class AppDrawer extends StatelessWidget {
  const AppDrawer({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final store = AppStore.instance;
    final nav = Nav.instance;
    return Drawer(
      width: 304,
      backgroundColor: t.sunken,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(),
      child: ListenableBuilder(
        listenable: Listenable.merge([store, nav]),
        builder: (context, _) => SafeArea(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 8, 8),
              child: Row(children: [
                const BrandMark(),
                const SizedBox(width: 10),
                const Wordmark(),
                const Spacer(),
                IconButton(tooltip: 'Close', onPressed: () => Navigator.of(context).pop(), icon: Icon(Icons.close_rounded, color: t.muted, size: 20)),
              ]),
            ),
            Padding(padding: const EdgeInsets.fromLTRB(12, 2, 12, 8), child: _NewChatButton(onTap: () => nav.newChat())),
            _NavItem(icon: Icons.search_rounded, label: 'Search', onTap: () => nav.push(const SearchScreen())),
            _NavItem(icon: Icons.home_outlined, label: 'Home', on: nav.view == RootView.home, onTap: () => nav.go(RootView.home)),
            _NavItem(icon: Icons.inbox_outlined, label: 'Inbox', on: nav.view == RootView.inbox, badge: store.waitingCount, onTap: () => nav.go(RootView.inbox)),
            _NavItem(icon: Icons.folder_outlined, label: 'Projects', on: nav.view == RootView.projects, onTap: () => nav.go(RootView.projects)),
            _NavItem(icon: Icons.description_outlined, label: 'Files', on: nav.view == RootView.files, onTap: () => nav.go(RootView.files)),
            _NavItem(icon: Icons.groups_2_outlined, label: 'Agents & skills', on: nav.view == RootView.agents, onTap: () => nav.go(RootView.agents)),
            const SizedBox(height: 4),
            Expanded(child: _Chats(store: store, current: nav.view == RootView.chat ? nav.chat?.id : null)),
            _Footer(store: store),
          ]),
        ),
      ),
    );
  }
}

class _NewChatButton extends StatelessWidget {
  const _NewChatButton({required this.onTap});
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), boxShadow: [BoxShadow(color: t.accent.withValues(alpha: .28), blurRadius: 22, offset: const Offset(0, 6))]),
      child: Material(
        color: t.accent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: SizedBox(
            height: 46,
            child: Row(children: [
              const SizedBox(width: 14),
              Icon(Icons.add_rounded, color: t.accentFg, size: 20),
              const SizedBox(width: 9),
              Text('New chat', style: TextStyle(color: t.accentFg, fontSize: 15, fontWeight: FontWeight.w700)),
            ]),
          ),
        ),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({required this.icon, required this.label, required this.onTap, this.on = false, this.badge = 0});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool on;
  final int badge;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Material(
        color: on ? t.active : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: onTap,
          child: SizedBox(
            height: 44,
            child: Row(children: [
              const SizedBox(width: 12),
              Icon(icon, size: 20, color: on ? t.accent : t.muted),
              const SizedBox(width: 12),
              Expanded(child: Text(label, style: TextStyle(color: on ? t.fg : t.muted, fontSize: 15, fontWeight: FontWeight.w500))),
              if (badge > 0)
                Container(
                  constraints: const BoxConstraints(minWidth: 20),
                  height: 20,
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: t.warn, borderRadius: BorderRadius.circular(10)),
                  child: Text('$badge', style: const TextStyle(color: Color(0xFF111111), fontSize: 11.5, fontWeight: FontWeight.w800)),
                ),
              const SizedBox(width: 12),
            ]),
          ),
        ),
      ),
    );
  }
}

class _Chats extends StatelessWidget {
  const _Chats({required this.store, required this.current});
  final AppStore store;
  final String? current;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final running = store.home.running;
    final needs = store.home.needs;
    final busy = {...running.map((r) => r.id), ...needs.map((n) => n.id)};
    final groups = <String, List<SessionMeta>>{};
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    for (final s in store.recent) {
      if (busy.contains(s.id)) continue;
      final d = DateTime.fromMillisecondsSinceEpoch(s.mtime);
      final diff = today.difference(DateTime(d.year, d.month, d.day)).inDays;
      final g = diff <= 0 ? 'Today' : diff == 1 ? 'Yesterday' : diff < 7 ? 'This week' : 'Earlier';
      (groups[g] ??= []).add(s);
    }
    String cwdOf(String id) {
      for (final s in store.recent) {
        if (s.id == id) return s.cwd.isNotEmpty ? s.cwd : s.projectPath;
      }
      return '';
    }

    Widget header(String label, {Widget? lead}) => Padding(
          padding: const EdgeInsets.fromLTRB(20, 14, 16, 4),
          child: Row(children: [
            if (lead != null) ...[lead, const SizedBox(width: 2)],
            Text(label.toUpperCase(), style: TextStyle(color: t.faint, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: .6)),
          ]),
        );

    return ListView(padding: const EdgeInsets.only(bottom: 12), children: [
      if (running.isNotEmpty || needs.isNotEmpty) header('Working now', lead: PulseDot(color: t.accent, size: 6)),
      for (final n in needs)
        _ChatItem(
          title: n.title,
          cloud: n.computer == 'cloud',
          on: current == n.id,
          dot: PulseDot(color: t.warn, size: 7),
          trailing: Text('needs you', style: TextStyle(color: t.warn, fontSize: 11.5, fontWeight: FontWeight.w600)),
          onTap: () => openSession(key: n.key, id: n.id, cwd: cwdOf(n.id), title: n.title, focus: true, computer: n.computer),
        ),
      for (final r in running)
        _ChatItem(
          title: r.title,
          cloud: r.computer == 'cloud',
          model: store.providerShort(store.providerOf(r.id)),
          on: current == r.id,
          dot: PulseDot(color: t.accent, size: 7),
          trailing: r.started > 0 ? Elapsed(r.started, style: TextStyle(color: t.faint, fontSize: 11.5, fontFeatures: const [FontFeature.tabularFigures()])) : null,
          onTap: () => openSession(key: r.key, id: r.id, cwd: r.cwd, title: r.title, computer: r.computer),
        ),
      for (final g in const ['Today', 'Yesterday', 'This week', 'Earlier'])
        if (groups[g]?.isNotEmpty == true) ...[
          header(g),
          for (final s in groups[g]!.take(g == 'Earlier' ? 20 : 40))
            _ChatItem(
              title: s.title,
              cloud: s.computer == 'cloud',
              model: store.providerShort(store.providerOf(s.id)),
              on: current == s.id,
              onTap: () => openSession(key: s.key, id: s.id, cwd: s.cwd.isNotEmpty ? s.cwd : s.projectPath, title: s.title, computer: s.computer),
            ),
        ],
      if (store.recent.isEmpty && running.isEmpty && needs.isEmpty)
        Padding(padding: const EdgeInsets.fromLTRB(20, 16, 20, 0), child: Text('Your chats will show up here.', style: TextStyle(color: t.faint, fontSize: 13))),
    ]);
  }
}

class _ChatItem extends StatelessWidget {
  const _ChatItem({required this.title, required this.onTap, this.on = false, this.dot, this.trailing, this.cloud = false, this.model = ''});
  final bool cloud;
  /// An open model's short name ("Qwen 3.8"); '' for Claude.
  final String model;
  final String title;
  final VoidCallback onTap;
  final bool on;
  final Widget? dot;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Material(
        color: on ? t.active : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: onTap,
          child: SizedBox(
            height: 40,
            child: Row(children: [
              SizedBox(width: dot == null ? 12 : 4),
              if (dot != null) ...[dot!, const SizedBox(width: 2)],
              Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: on ? t.fg : t.muted, fontSize: 14))),
              if (cloud) ...[const SizedBox(width: 6), const CloudBadge(size: 13)],
              if (model.isNotEmpty) ...[const SizedBox(width: 6), Tag(model, kind: 'think')],
              if (trailing != null) ...[const SizedBox(width: 8), trailing!],
              const SizedBox(width: 12),
            ]),
          ),
        ),
      ),
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({required this.store});
  final AppStore store;
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final name = store.displayName.isEmpty ? 'You' : store.displayName;
    final a = store.auth;
    final sub = a.loggedIn ? (a.subscriptionType.isNotEmpty ? '${cap1(a.subscriptionType)} plan' : (a.email.isNotEmpty ? a.email : 'Signed in')) : 'Not signed in';
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      decoration: BoxDecoration(border: Border(top: BorderSide(color: t.border))),
      padding: const EdgeInsets.fromLTRB(14, 8, 6, 8),
      child: Row(children: [
        Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(shape: BoxShape.circle, gradient: LinearGradient(colors: [t.accent, t.think])),
          child: Text(name[0].toUpperCase(), style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700)),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.fg, fontSize: 14, fontWeight: FontWeight.w600)),
            Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.faint, fontSize: 12)),
          ]),
        ),
        IconButton(
          tooltip: dark ? 'Light theme' : 'Dark theme',
          onPressed: () => store.setTheme(dark ? ThemeMode.light : ThemeMode.dark),
          icon: Icon(dark ? Icons.light_mode_outlined : Icons.dark_mode_outlined, color: t.muted, size: 20),
        ),
        IconButton(tooltip: 'Settings', onPressed: () => Nav.instance.push(const SettingsScreen()), icon: Icon(Icons.settings_outlined, color: t.muted, size: 20)),
      ]),
    );
  }
}

String cap1(String s) => s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';

/// App bar for the root views: burger, title, and the Talk pill.
class RootAppBar extends StatelessWidget implements PreferredSizeWidget {
  const RootAppBar({super.key, this.title = '', this.actions = const []});
  final String title;
  final List<Widget> actions;
  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);
  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return AppBar(
      backgroundColor: Colors.transparent,
      leading: IconButton(tooltip: 'Menu', onPressed: Nav.instance.openDrawer, icon: const Icon(Icons.menu_rounded)),
      titleSpacing: 4,
      title: Text(title),
      actions: [
        ...actions,
        Padding(
          padding: const EdgeInsets.only(right: 10),
          child: Material(
            color: t.raised.withValues(alpha: .7),
            shape: StadiumBorder(side: BorderSide(color: t.border)),
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: () => openTalk(context),
              child: Container(
                height: 36,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(Icons.graphic_eq_rounded, size: 17, color: t.muted),
                  const SizedBox(width: 6),
                  Text('Talk', style: TextStyle(color: t.muted, fontSize: 13.5, fontWeight: FontWeight.w600)),
                ]),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
