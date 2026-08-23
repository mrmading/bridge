# Contributing

Bridge is deliberately small: one Bun file for the server, one HTML/CSS/JS trio for the client,
one Swift file for the macOS shell. No framework, no bundler, no `node_modules`. Please keep it
that way — a change that adds a build step needs a very good reason.

## Running it

```bash
bun server.ts          # or ./bridge, which also opens the browser
```

Everything under `public/` is served with `cache-control: no-store`, so a refresh is enough; there
is nothing to rebuild.

## Building the app

```bash
./mac/build.sh         # → dist/Bridge.app
```

Needs the Xcode Command Line Tools (`xcode-select --install`). No Xcode project involved.

## Ground rules

- **Never widen the file sandbox.** Reads and writes are confined to the folders in
  `.cache/roots.json`, and the credential patterns in `SENSITIVE` are refused inside them too.
- **Don't reimplement Claude Code.** Bridge drives the real CLI. If a feature needs a fork of the
  agent loop, it does not belong here.
- **Keep the client dependency-free.** `public/app.js` is vanilla ES2020 and must stay readable.
- Check both themes and both a wide and a narrow window before opening a PR.

## Reporting bugs

Include your `claude --version`, your `bun --version`, macOS version, and whatever
`bun server.ts` printed.
