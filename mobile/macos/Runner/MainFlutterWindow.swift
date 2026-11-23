import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    flutterViewController.backgroundColor = NSColor(calibratedRed: 0.03, green: 0.04, blue: 0.06, alpha: 1)
    // hover (hand cursor, hover highlights) must not depend on the window being key
    flutterViewController.mouseTrackingMode = .always
    self.contentViewController = flutterViewController
    // Same chrome as the old native Bridge.app: no title, title bar blends into the dark app.
    self.title = "Bridge"
    self.titlebarAppearsTransparent = true
    self.titleVisibility = .hidden
    self.backgroundColor = NSColor(calibratedRed: 0.03, green: 0.04, blue: 0.06, alpha: 1)
    self.minSize = NSSize(width: 720, height: 560)
    // Open filling the screen (menu bar and Dock stay visible), like a proper desktop app.
    // macOS state restoration would put back an old size after this runs, so turn it off.
    self.isRestorable = false
    self.setFrameAutosaveName("")
    DispatchQueue.main.async { [weak self] in
      guard let self = self, let screen = self.screen ?? NSScreen.main else { return }
      self.setFrame(screen.visibleFrame, display: true)
    }

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
