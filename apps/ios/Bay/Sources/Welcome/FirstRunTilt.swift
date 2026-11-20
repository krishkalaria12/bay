import CoreMotion
import SwiftUI

/// How the iPhone leans while the first run is on screen, from device motion's gravity, so the pages' drawing moves a
/// little with the hand: far things one way, near things the other, the way a lens shifts. The way it's held when the
/// welcome comes up is the middle, and the middle follows a new way of holding it slowly. Off with Reduce Motion and
/// where there's no motion (the simulator). Device motion needs no permission. After Yab's FirstRunTilt
/// (Phone/Sources/Welcome/FirstRunTilt.swift, Apache-2.0).
@MainActor
final class FirstRunTilt: ObservableObject {
  static let shared = FirstRunTilt()

  /// -1 (leaning left, or the top away) to 1 (right, or the top near).
  @Published private(set) var x: CGFloat = 0
  @Published private(set) var y: CGFloat = 0

  private let manager = CMMotionManager()
  private var users = 0
  private var rest: CGPoint?

  func start() {
    users += 1
    guard users == 1, !UIAccessibility.isReduceMotionEnabled, manager.isDeviceMotionAvailable else { return }
    manager.deviceMotionUpdateInterval = 1 / 60
    manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
      guard let gravity = motion?.gravity else { return }
      MainActor.assumeIsolated { self?.lean(CGPoint(x: gravity.x, y: gravity.y)) }
    }
  }

  func stop() {
    users = max(0, users - 1)
    guard users == 0 else { return }
    manager.stopDeviceMotionUpdates()
    rest = nil
    x = 0
    y = 0
  }

  private func lean(_ gravity: CGPoint) {
    var middle = rest ?? gravity
    // A new way of holding it becomes the middle over a few seconds.
    middle.x += (gravity.x - middle.x) * 0.012
    middle.y += (gravity.y - middle.y) * 0.012
    rest = middle
    // A quarter of a turn's gravity (about 15°) is the whole way.
    let nx = max(-1, min(1, (gravity.x - middle.x) / 0.26))
    let ny = max(-1, min(1, (gravity.y - middle.y) / 0.26))
    // Smoothed, so the hand's tremor never shows.
    x += (nx - x) * 0.16
    y += (ny - y) * 0.16
  }
}

/// A layer of the first run's drawing at `depth`: positive comes toward the hand (moves with the lean), negative lies
/// behind (moves against it). Only this modifier reads the tilt, so a frame of motion redraws nothing else.
private struct Parallax: ViewModifier {
  let depth: CGFloat
  @ObservedObject private var tilt = FirstRunTilt.shared

  func body(content: Content) -> some View {
    content.offset(x: tilt.x * depth, y: -tilt.y * depth)
  }
}

extension View {
  func parallax(_ depth: CGFloat) -> some View { modifier(Parallax(depth: depth)) }
}
