
let files = FileManager.default
let scripts = ShellModule.root.appendingPathComponent("Scripts")
let ext = scripts.appendingPathComponent("extension")
let manifest: [String: Any] = [
  "manifest_version": 3, "name": "Bay Scripts", "version": "1.0.1",
  "content_scripts": [["matches": ["https://example.com/*"], "js": ["js/a.js"], "run_at": "document_end", "world": "MAIN", "all_frames": true]],
]

func write(_ url: URL, _ text: String) throws {
  try Data(text.utf8).write(to: url)
}

func reset(_ replacement: [String: Any]? = nil) throws {
  try? files.removeItem(at: scripts)
  try files.createDirectory(at: ext.appendingPathComponent("js"), withIntermediateDirectories: true)
  try write(scripts.appendingPathComponent("generation"), "1\n")
  try write(ext.appendingPathComponent("generation"), "1\n")
  try write(ext.appendingPathComponent("js/a.js"), "console.log('hello');")
  try JSONSerialization.data(withJSONObject: replacement ?? manifest).write(to: ext.appendingPathComponent("manifest.json"))
}

precondition(UserScripts.shared.read()["state"] as? String == "empty")
try reset()
let ready = UserScripts.shared.read()
precondition(ready["state"] as? String == "ready")
precondition(ready["generation"] as? Int == 1)
precondition(ready["token"] as? String != nil)

var forbidden = manifest
forbidden["permissions"] = ["cookies"]
try reset(forbidden)
precondition(UserScripts.shared.read()["state"] as? String == "invalid")

try reset()
try files.removeItem(at: ext.appendingPathComponent("js/a.js"))
try write(ShellModule.root.appendingPathComponent("outside.js"), "private")
try files.createSymbolicLink(at: ext.appendingPathComponent("js/a.js"), withDestinationURL: ShellModule.root.appendingPathComponent("outside.js"))
precondition(UserScripts.shared.read()["state"] as? String == "invalid")

try reset()
try files.removeItem(at: ext.appendingPathComponent("js/a.js"))
try files.linkItem(at: ShellModule.root.appendingPathComponent("outside.js"), to: ext.appendingPathComponent("js/a.js"))
precondition(UserScripts.shared.read()["state"] as? String == "invalid")

try reset()
try write(scripts.appendingPathComponent("generation"), "2\n")
precondition(UserScripts.shared.read()["state"] as? String == "pending")
try files.removeItem(at: ext)
precondition(UserScripts.shared.read()["state"] as? String == "absent")

try files.createSymbolicLink(at: ext, withDestinationURL: ShellModule.root)
precondition(UserScripts.shared.read()["state"] as? String == "invalid")

try reset()
try UserScripts.shared.writeStatus("{\"generation\":1}")
precondition(UserScripts.shared.readStatus() == "{\"generation\":1}")
let changed = DispatchSemaphore(value: 0)
UserScripts.shared.emit = { changed.signal() }
UserScripts.shared.start()
UserScripts.work.sync {}
try UserScripts.shared.writeStatus("{\"generation\":1,\"profiles\":{}}")
precondition(changed.wait(timeout: .now() + 0.2) == .timedOut)
try Data("2\n".utf8).write(to: scripts.appendingPathComponent("generation"), options: .atomic)
precondition(changed.wait(timeout: .now() + 2) == .success)
UserScripts.shared.stop()
UserScripts.work.sync {}
print("userscript folder validation passed")
