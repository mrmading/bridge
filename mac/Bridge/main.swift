import AppKit
import WebKit

// ── Bridge.app ────────────────────────────────────────────────────────────
// A thin, honest native shell: it starts the Bun server that ships inside the
// bundle, waits for it to answer, and shows it in a WKWebView. No frameworks,
// no bundler, no embedded Chromium.

let PORT_START = 4270

func findBun() -> String? {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let candidates = [
        ProcessInfo.processInfo.environment["BRIDGE_BUN"],
        "\(home)/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun", "/usr/bin/bun",
    ].compactMap { $0 }
    for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return c }
    // last resort: ask a login shell, so nvm/asdf-style PATHs are honoured
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "command -v bun"]
    let pipe = Pipe(); p.standardOutput = pipe
    try? p.run(); p.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return out.isEmpty ? nil : out
}

func freePort(from start: Int) -> Int {
    for port in start..<(start + 40) {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        if sock < 0 { continue }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var yes: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        close(sock)
        if bound == 0 { return port }
    }
    return start
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var port = PORT_START

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        startServer()
    }

    // ── window ────────────────────────────────────────────────────────────
    func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1320, height: 880)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Bridge"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 940, height: 620)
        window.setFrameAutosaveName("BridgeMainWindow")
        window.backgroundColor = NSColor(calibratedRed: 0.03, green: 0.04, blue: 0.06, alpha: 1)

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // let the page know it is running inside the app
        let js = "document.documentElement.dataset.native = 'mac';"
        cfg.userContentController.addUserScript(
            WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        web = WKWebView(frame: frame, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // ── the Bun server that lives in Resources/app ────────────────────────
    func startServer() {
        guard let bun = findBun() else { return fail("Bun is not installed", """
            Bridge runs on Bun. Install it and open Bridge again:

                curl -fsSL https://bun.sh/install | bash
            """) }
        guard let res = Bundle.main.resourcePath else { return fail("Bundle is broken", "No Resources directory.") }
        let entry = "\(res)/app/server.ts"
        guard FileManager.default.fileExists(atPath: entry) else {
            return fail("Bridge is incomplete", "server.ts is missing from the app bundle.")
        }
        port = freePort(from: PORT_START)

        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Bridge")
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)

        var env = ProcessInfo.processInfo.environment
        env["BRIDGE_PORT"] = String(port)
        env["BRIDGE_DATA"] = support.path
        env["PATH"] = (env["PATH"] ?? "") + ":\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin"

        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = [entry]
        p.environment = env
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        do { try p.run() } catch { return fail("Could not start Bridge", error.localizedDescription) }
        server = p
        waitForServer(attempt: 0)
    }

    func waitForServer(attempt: Int) {
        let url = URL(string: "http://127.0.0.1:\(port)/api/bootstrap")!
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.2
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            DispatchQueue.main.async {
                if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                    self.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)/")!))
                } else if attempt < 40 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.waitForServer(attempt: attempt + 1) }
                } else {
                    self.fail("Bridge did not start", "The local server never answered on port \(self.port).")
                }
            }
        }.resume()
    }

    func fail(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = body
        a.alertStyle = .critical
        a.addButton(withTitle: "Quit")
        a.runModal()
        NSApp.terminate(nil)
    }

    // ── links open in the real browser, not in the shell ──────────────────
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = action.request.url, u.host != "127.0.0.1", u.host != "localhost",
           u.scheme == "http" || u.scheme == "https" {
            NSWorkspace.shared.open(u)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, createWebViewWith cfg: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) {
        server?.terminate()
        server?.waitUntilExit()
    }

    // ── menus (WKWebView needs the standard responders to exist) ──────────
    @objc func reload() { web.reload() }
    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu(title: "Bridge")
        app.addItem(withTitle: "About Bridge", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Bridge", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Bridge", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimise", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = win

        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
