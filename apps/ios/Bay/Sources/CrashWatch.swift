import BayCore
import Foundation
import MetricKit

/// Keeps Bay's crashes in the core's `CrashLog` for Settings › Report a problem (B8): those iOS reports through
/// MetricKit on a launch after them, and Objective-C exceptions nothing caught, as they end the app.
final class CrashWatch: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
  private let log: CrashLog

  init(log: CrashLog) {
    self.log = log
    super.init()
    MXMetricManager.shared.add(self)
    UncaughtExceptions.install(log)
  }

  deinit {
    MXMetricManager.shared.remove(self)
  }

  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    for payload in payloads {
      for crash in payload.crashDiagnostics ?? [] {
        log.record(report: Self.report(crash, at: payload.timeStampEnd))
      }
    }
  }

  /// A crash as the log keeps it: what ended the app on the first line, then the build and system it ran on; the
  /// stack is MetricKit's call tree as JSON.
  private static func report(_ crash: MXCrashDiagnostic, at: Date) -> CrashReport {
    var what: [String] = []
    if let type = crash.exceptionType?.int32Value {
      var exception = machExceptions[type] ?? "exception \(type)"
      if let code = crash.exceptionCode { exception += " (code \(code))" }
      what.append(exception)
    }
    if let signal = crash.signal?.int32Value { what.append(signals[signal] ?? "signal \(signal)") }
    if #available(iOS 17.0, *), let reason = crash.exceptionReason {
      what.append("\(reason.className): \(reason.composedMessage)")
    }
    if let reason = crash.terminationReason, !reason.isEmpty { what.append(reason) }
    let meta = crash.metaData
    let message = [
      what.isEmpty ? "Crash" : what.joined(separator: " · "),
      "build \(meta.applicationBuildVersion) · \(meta.osVersion) · \(meta.deviceType)",
    ].joined(separator: "\n")
    let stack = String(data: crash.callStackTree.jsonRepresentation(), encoding: .utf8) ?? ""
    return CrashReport(at: millis(at), message: message, stack: stack)
  }

  private static let machExceptions: [Int32: String] = [
    EXC_BAD_ACCESS: "EXC_BAD_ACCESS", EXC_BAD_INSTRUCTION: "EXC_BAD_INSTRUCTION", EXC_ARITHMETIC: "EXC_ARITHMETIC",
    EXC_SOFTWARE: "EXC_SOFTWARE", EXC_BREAKPOINT: "EXC_BREAKPOINT", EXC_CRASH: "EXC_CRASH", EXC_RESOURCE: "EXC_RESOURCE",
    EXC_GUARD: "EXC_GUARD",
  ]

  private static let signals: [Int32: String] = [
    SIGABRT: "SIGABRT", SIGBUS: "SIGBUS", SIGFPE: "SIGFPE", SIGILL: "SIGILL", SIGKILL: "SIGKILL", SIGSEGV: "SIGSEGV",
    SIGSYS: "SIGSYS", SIGTRAP: "SIGTRAP",
  ]
}

/// Milliseconds since 1970, as the log's times are.
private func millis(_ date: Date) -> Int64 {
  Int64(date.timeIntervalSince1970 * 1000)
}

/// Records an Objective-C exception nothing caught, then hands it to the handler that was there before.
private enum UncaughtExceptions {
  /// Set once as Bay starts; the handler is a C function, so what it needs lives here.
  nonisolated(unsafe) static var log: CrashLog?
  nonisolated(unsafe) static var previous: NSUncaughtExceptionHandler?

  static func install(_ log: CrashLog) {
    guard self.log == nil else { return }
    self.log = log
    previous = NSGetUncaughtExceptionHandler()
    NSSetUncaughtExceptionHandler { exception in
      let message = [exception.name.rawValue, exception.reason].compactMap { $0 }.joined(separator: ": ")
      UncaughtExceptions.log?.record(
        report: CrashReport(at: millis(Date()), message: message, stack: exception.callStackSymbols.joined(separator: "\n")))
      UncaughtExceptions.previous?(exception)
    }
  }
}
