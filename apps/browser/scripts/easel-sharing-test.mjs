// Exercise the actual native snapshot renderer without Chromium or a running Bay instance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "bay-easel-sharing-"));
const easel = readFileSync(join(root, "packages/shell/ios/Easel.swift"), "utf8");
const shell = readFileSync(join(root, "packages/shell/ios/ShellModule.swift"), "utf8");
const files = easel.slice(easel.indexOf("enum EaselFiles {"), easel.indexOf("final class EaselCanvasView:"));
const colors = shell.slice(shell.indexOf("extension NSColor {"), shell.indexOf("let installTextFieldSelectAll:"));
assert.ok(files.includes("enum EaselDrawing"));
assert.ok(colors.includes("convenience init?(hex:"));
const support = `
import AppKit
import ImageIO
import UniformTypeIdentifiers
enum ShellModule {
  static func documentURL(_ name: String) throws -> URL {
    URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(name)
  }
}
enum CaptureFiles {
  static func unique(in dir: URL, name: String, ext: String) -> URL { dir.appendingPathComponent(name).appendingPathExtension(ext) }
}
${colors}
${files}
`;
writeFileSync(join(scratch, "Support.swift"), support);
writeFileSync(
  join(scratch, "Main.swift"),
  `
import AppKit
@main struct Check {
  static func main() throws {
    for value in ["false", "0", "TRUE", "1", ""] {
      setenv("BAY_EASEL_WEB_SHARING", value, 1)
      precondition(!EaselSharing.enabled)
    }
    setenv("BAY_EASEL_WEB_SHARING", "true", 1)
    precondition(EaselSharing.enabled)
    unsetenv("BAY_EASEL_WEB_SHARING")
    precondition(!EaselSharing.enabled)
    let missingRecords = try EaselSharing.readRecords()
    precondition(missingRecords == nil, "Only a missing registry returns nil")
    let recordsPath = CommandLine.arguments[1] + "/easel-shares.json"
    try Data([0xff, 0xfe]).write(to: URL(fileURLWithPath: recordsPath))
    do {
      _ = try EaselSharing.readRecords()
      preconditionFailure("Invalid UTF-8 must not look like a missing registry")
    } catch { precondition(error.localizedDescription.contains("UTF-8")) }
    try #"{"version":1}"#.write(toFile: recordsPath, atomically: true, encoding: .utf8)
    let validRecords = try EaselSharing.readRecords()
    precondition(validRecords == #"{"version":1}"#)
    let identities = try (0..<100).map { _ in try EaselSharing.identity() }
    precondition(Set(identities.map { $0["id"]! }).count == 100)
    precondition(Set(identities.map { $0["key"]! }).count == 100)
    precondition(identities.allSatisfy { $0["id"]!.count == 32 && $0["key"]!.count == 64 && !$0["key"]!.contains($0["id"]!) })
    let imagePath = CommandLine.arguments[1] + "/private-capture.png"
    let context = CGContext(data: nil, width: 80, height: 60, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(NSColor.systemBlue.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: 80, height: 60))
    precondition(EaselFiles.writePNG(context.makeImage()!, to: URL(fileURLWithPath: imagePath)))
    var doc: [String: Any] = [
      "id": "private-easel-id", "spaceId": "private-space", "nativeEditId": "private-edit", "title": "Project references <script>", "background": "#EAF1F7",
      "items": [
        ["id": "image", "kind": "image", "x": -100, "y": 0, "width": 160, "height": 120, "path": imagePath, "live": true,
          "source": ["url": "https://example.com/reference?q=one&two=three", "title": "Original source", "profileId": "private-profile", "clip": [1, 2, 3, 4]]],
        ["id": "text", "kind": "text", "x": 100, "y": 10, "width": 300, "height": 40, "text": "A saved idea", "color": "#242424"],
        ["id": "link", "kind": "link", "x": 100, "y": 80, "width": 200, "height": 60, "text": "Example", "url": "https://example.com/"],
        ["id": "rect", "kind": "rect", "x": 100, "y": 160, "width": 200, "height": 70, "color": "#E5484D"],
        ["id": "ellipse", "kind": "ellipse", "x": 340, "y": 160, "width": 70, "height": 70, "color": "#42A372"],
        ["id": "pen", "kind": "pen", "x": 0, "y": 260, "width": 200, "height": 40, "points": [[0, 0], [100, 40], [200, 0]]],
        ["id": "arrow", "kind": "arrow", "x": 240, "y": 260, "width": 160, "height": 40, "points": [[0, 40], [160, 0]]]
      ]
    ]
    let json = try EaselSharing.snapshot(EaselFiles.json(doc))
    let published = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    precondition(Set(published.keys) == Set(["version", "title", "background", "image", "links"]))
    for privateValue in [imagePath, "private-easel-id", "private-space", "private-edit", "private-profile", "clip", "live"] {
      precondition(!json.contains(privateValue), "Leaked " + privateValue)
    }
    let image = published["image"] as! [String: Any]
    let png = Data(base64Encoded: String((image["data"] as! String).dropFirst("data:image/png;base64,".count)))!
    precondition(Array(png.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10])
    precondition((image["width"] as! Int) > 500 && (image["height"] as! Int) > 300)
    precondition((published["links"] as! [[String: String]]).count == 2)
    try json.write(toFile: CommandLine.arguments[1] + "/snapshot.json", atomically: true, encoding: .utf8)
    doc["items"] = [["id": "missing", "kind": "image", "path": "/missing.png"]]
    do {
      _ = try EaselSharing.snapshot(EaselFiles.json(doc))
      preconditionFailure("Missing images must fail rather than publish placeholders")
    } catch { precondition(error.localizedDescription.contains("image is unavailable")) }
    doc["items"] = []
    let empty = try EaselSharing.snapshot(EaselFiles.json(doc))
    let emptyObject = try JSONSerialization.jsonObject(with: Data(empty.utf8)) as! [String: Any]
    precondition(emptyObject["image"] is NSNull)
    print("Native snapshot checks passed: all canvas kinds, PNG dimensions, metadata privacy, missing images, empty Easels and secure identities")
  }
}
`,
);
execFileSync(
  "swiftc",
  [join(scratch, "Support.swift"), join(root, "packages/shell/ios/EaselSharing.swift"), join(scratch, "Main.swift"), "-o", join(scratch, "check")],
  { stdio: "inherit" },
);
execFileSync(join(scratch, "check"), [scratch], { stdio: "inherit" });
console.log(`Snapshot fixture: ${join(scratch, "snapshot.json")}`);
