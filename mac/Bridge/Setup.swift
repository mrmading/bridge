import AppKit

// ── First-run setup ───────────────────────────────────────────────────────
// Bridge needs two things on the machine: Bun, and the Claude Code CLI. This
// window checks for them, installs whichever is missing with the official
// one-liner, and offers LifeOS (PAI) as an optional extra. Nothing is installed
// without the person pressing the button.

func shellPath(_ cmd: String) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "command -v \(cmd)"]
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
    try? p.run(); p.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !out.isEmpty { return out }
    let home = NSHomeDirectory()
    for c in ["\(home)/.bun/bin/\(cmd)", "\(home)/.local/bin/\(cmd)", "/opt/homebrew/bin/\(cmd)", "/usr/local/bin/\(cmd)"]
    where FileManager.default.isExecutableFile(atPath: c) { return c }
    return nil
}

final class Step {
    let key: String, title: String, blurb: String, required: Bool
    var status = "Checking…"
    var ok = false
    let row = NSStackView()
    let dot = NSTextField(labelWithString: "•")
    let state = NSTextField(labelWithString: "Checking…")
    let button = NSButton(title: "Install", target: nil, action: nil)
    init(key: String, title: String, blurb: String, required: Bool) {
        self.key = key; self.title = title; self.blurb = blurb; self.required = required
    }
}

final class SetupWindowController: NSWindowController {
    var onDone: (() -> Void)?
    private var steps: [Step] = []
    private let log = NSTextView()
    private let cont = NSButton(title: "Start Bridge", target: nil, action: nil)
    private let spinner = NSProgressIndicator()
    private var running = false

    convenience init(onDone: @escaping () -> Void) {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 580),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Set up Bridge"
        w.center()
        self.init(window: w)
        self.onDone = onDone
        build()
        recheck()
    }

    // ── layout ────────────────────────────────────────────────────────────
    private func build() {
        guard let w = window else { return }
        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 16
        root.edgeInsets = NSEdgeInsets(top: 24, left: 26, bottom: 20, right: 26)
        root.translatesAutoresizingMaskIntoConstraints = false

        let h1 = NSTextField(labelWithString: "Welcome to Bridge")
        h1.font = .systemFont(ofSize: 22, weight: .semibold)
        let sub = NSTextField(wrappingLabelWithString:
            "Bridge is a window onto Claude Code. It needs two free tools on your Mac. "
            + "If they are missing, press Install and Bridge will fetch them from their official sources.")
        sub.font = .systemFont(ofSize: 13)
        sub.textColor = .secondaryLabelColor
        sub.preferredMaxLayoutWidth = 580
        root.addArrangedSubview(h1)
        root.addArrangedSubview(sub)

        steps = [
            Step(key: "bun", title: "Bun",
                 blurb: "The small, fast runtime Bridge itself runs on.", required: true),
            Step(key: "claude", title: "Claude Code",
                 blurb: "Anthropic's CLI. Bridge drives it; it does the actual work.", required: true),
            Step(key: "lifeos", title: "LifeOS (optional)",
                 blurb: "Daniel Miessler's personal AI setup. Bridge shows its agents and memory if you use it.", required: false),
        ]
        for s in steps { root.addArrangedSubview(makeRow(s)) }

        let sep = NSBox(); sep.boxType = .separator
        sep.translatesAutoresizingMaskIntoConstraints = false
        sep.widthAnchor.constraint(equalToConstant: 588).isActive = true
        root.addArrangedSubview(sep)

        log.isEditable = false
        log.isSelectable = true
        log.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        log.textColor = .secondaryLabelColor
        log.drawsBackground = false
        log.isVerticallyResizable = true
        log.isHorizontallyResizable = false
        log.autoresizingMask = [.width]
        log.textContainer?.widthTracksTextView = true
        log.textContainer?.containerSize = NSSize(width: 570, height: CGFloat.greatestFiniteMagnitude)
        log.minSize = NSSize(width: 0, height: 0)
        log.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        log.string = "Bridge will show what it runs here.\n"
        let scroll = NSScrollView()
        scroll.documentView = log
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 150).isActive = true
        scroll.widthAnchor.constraint(equalToConstant: 588).isActive = true
        root.addArrangedSubview(scroll)

        let foot = NSStackView()
        foot.orientation = .horizontal
        foot.spacing = 10
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isHidden = true
        let recheckBtn = NSButton(title: "Check again", target: self, action: #selector(recheck))
        recheckBtn.bezelStyle = .rounded
        cont.bezelStyle = .rounded
        cont.keyEquivalent = "\r"
        cont.target = self
        cont.action = #selector(finish)
        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.widthAnchor.constraint(equalToConstant: 330).isActive = true
        foot.addArrangedSubview(spinner)
        foot.addArrangedSubview(spacer)
        foot.addArrangedSubview(recheckBtn)
        foot.addArrangedSubview(cont)
        root.addArrangedSubview(foot)

        let content = NSView()
        content.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            root.topAnchor.constraint(equalTo: content.topAnchor),
            root.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        w.contentView = content
        content.layoutSubtreeIfNeeded()
        w.setContentSize(root.fittingSize)
        w.center()
    }

    private func makeRow(_ s: Step) -> NSView {
        s.row.orientation = .horizontal
        s.row.spacing = 12
        s.row.alignment = .centerY
        s.dot.font = .systemFont(ofSize: 20)
        s.dot.textColor = .tertiaryLabelColor
        let text = NSStackView()
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1
        let t = NSTextField(labelWithString: s.title)
        t.font = .systemFont(ofSize: 14, weight: .medium)
        let bl = NSTextField(labelWithString: s.blurb)
        bl.font = .systemFont(ofSize: 12)
        bl.textColor = .secondaryLabelColor
        text.addArrangedSubview(t)
        text.addArrangedSubview(bl)
        s.state.font = .systemFont(ofSize: 12)
        s.state.textColor = .secondaryLabelColor
        s.state.alignment = .right
        s.state.translatesAutoresizingMaskIntoConstraints = false
        s.state.widthAnchor.constraint(equalToConstant: 130).isActive = true
        s.button.bezelStyle = .rounded
        s.button.target = self
        s.button.action = #selector(install(_:))
        s.button.identifier = NSUserInterfaceItemIdentifier(s.key)
        s.button.isHidden = true
        let pad = NSView()
        pad.translatesAutoresizingMaskIntoConstraints = false
        pad.widthAnchor.constraint(greaterThanOrEqualToConstant: 20).isActive = true
        s.row.addArrangedSubview(s.dot)
        s.row.addArrangedSubview(text)
        s.row.addArrangedSubview(pad)
        s.row.addArrangedSubview(s.state)
        s.row.addArrangedSubview(s.button)
        s.row.translatesAutoresizingMaskIntoConstraints = false
        s.row.widthAnchor.constraint(equalToConstant: 588).isActive = true
        return s.row
    }

    // ── state ─────────────────────────────────────────────────────────────
    @objc func recheck() {
        for s in steps {
            switch s.key {
            case "bun":
                if let p = shellPath("bun") { s.ok = true; s.status = "Installed" ; note("bun: \(p)") }
                else { s.ok = false; s.status = "Not installed" }
            case "claude":
                if let p = shellPath("claude") { s.ok = true; s.status = "Installed"; note("claude: \(p)") }
                else { s.ok = false; s.status = "Not installed" }
            default:
                let marker = NSHomeDirectory() + "/.claude/skills/PAI"
                let marker2 = NSHomeDirectory() + "/.claude/LIFEOS"
                s.ok = FileManager.default.fileExists(atPath: marker) || FileManager.default.fileExists(atPath: marker2)
                s.status = s.ok ? "Detected" : "Not set up"
            }
            paint(s)
        }
        let ready = steps.filter { $0.required }.allSatisfy { $0.ok }
        cont.isEnabled = ready && !running
        cont.title = ready ? "Start Bridge" : "Install what is missing first"
    }

    private func paint(_ s: Step) {
        s.state.stringValue = s.status
        s.dot.stringValue = s.ok ? "●" : "○"
        s.dot.textColor = s.ok ? .systemGreen : (s.required ? .systemOrange : .tertiaryLabelColor)
        s.button.isHidden = s.ok || running
        s.button.title = s.key == "lifeos" ? "Set up" : "Install"
    }

    private func note(_ line: String) {
        log.string += line + "\n"
        log.scrollToEndOfDocument(nil)
    }

    // ── installing ────────────────────────────────────────────────────────
    @objc func install(_ sender: NSButton) {
        guard let key = sender.identifier?.rawValue, !running else { return }
        var cmd: String
        switch key {
        case "bun":
            cmd = "curl -fsSL https://bun.sh/install | bash"
        case "claude":
            cmd = "curl -fsSL https://claude.ai/install.sh | bash"
        default:
            let claudeDir = NSHomeDirectory() + "/.claude"
            if FileManager.default.fileExists(atPath: claudeDir) {
                let a = NSAlert()
                a.messageText = "You already have a Claude Code configuration"
                a.informativeText = """
                    LifeOS installs itself into ~/.claude, and there is already something there. \
                    Bridge will not overwrite it. Follow the project's own instructions instead, \
                    then press Check again.
                    """
                a.addButton(withTitle: "Open the LifeOS page")
                a.addButton(withTitle: "Cancel")
                if a.runModal() == .alertFirstButtonReturn {
                    NSWorkspace.shared.open(URL(string: "https://github.com/danielmiessler/LifeOS")!)
                }
                return
            }
            cmd = "git clone --depth 1 https://github.com/danielmiessler/LifeOS \(claudeDir)"
        }
        run(cmd, label: key)
    }

    private func run(_ cmd: String, label: String) {
        running = true
        spinner.isHidden = false
        spinner.startAnimation(nil)
        for s in steps { s.button.isHidden = true }
        cont.isEnabled = false
        note("\n$ \(cmd)")

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", cmd]
        p.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        let drain: (FileHandle) -> Void = { [weak self] h in
            let chunk = String(data: h.availableData, encoding: .utf8) ?? ""
            guard !chunk.isEmpty else { return }
            DispatchQueue.main.async { self?.note(chunk.trimmingCharacters(in: .newlines)) }
        }
        out.fileHandleForReading.readabilityHandler = drain
        err.fileHandleForReading.readabilityHandler = drain
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self else { return }
                self.running = false
                self.spinner.stopAnimation(nil)
                self.spinner.isHidden = true
                self.note(proc.terminationStatus == 0
                          ? "✓ \(label) finished"
                          : "✕ \(label) failed with code \(proc.terminationStatus)")
                self.recheck()
            }
        }
        do { try p.run() } catch {
            running = false
            note("✕ could not run: \(error.localizedDescription)")
            recheck()
        }
    }

    @objc func finish() {
        window?.close()
        onDone?()
    }
}
