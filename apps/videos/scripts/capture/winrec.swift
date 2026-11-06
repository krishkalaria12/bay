// Records the screen under one window (by its id) with ScreenCaptureKit, at the display's scale and 60 fps, into an
// H.264 .mov, without the pointer. The window still has to be in front: a covered Chromium window stops painting.
//
//   swiftc -O scripts/capture/winrec.swift -o <bin>
//   <bin> WINDOW_ID SECONDS OUT.mov
import AppKit
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let args = CommandLine.arguments
guard args.count == 4, let windowID = CGWindowID(args[1]), let seconds = Double(args[2]) else {
  FileHandle.standardError.write("usage: winrec WINDOW_ID SECONDS OUT.mov\n".data(using: .utf8)!)
  exit(64)
}
// ScreenCaptureKit needs a connection to the window server first.
_ = NSApplication.shared
let outURL = URL(fileURLWithPath: args[3])
try? FileManager.default.removeItem(at: outURL)

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  let writer: AVAssetWriter
  let input: AVAssetWriterInput
  var started = false
  var frames = 0

  init(url: URL, width: Int, height: Int) throws {
    writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    input = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [
          AVVideoAverageBitRateKey: 60_000_000,
          AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
          AVVideoExpectedSourceFrameRateKey: 60,
          AVVideoMaxKeyFrameIntervalKey: 60,
        ],
      ])
    input.expectsMediaDataInRealTime = true
    writer.add(input)
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sample.isValid,
      let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = info.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete
    else { return }
    if !started {
      writer.startWriting()
      writer.startSession(atSourceTime: sample.presentationTimeStamp)
      started = true
    }
    if input.isReadyForMoreMediaData, input.append(sample) { frames += 1 }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    FileHandle.standardError.write("stream stopped: \(error)\n".data(using: .utf8)!)
  }
}

Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
      FileHandle.standardError.write("no window \(windowID)\n".data(using: .utf8)!)
      exit(1)
    }
    // The whole display cropped to the window: a filter naming the window makes macOS swap its traffic lights for a
    // "being shared" badge.
    guard let display = content.displays.first(where: { $0.frame.intersects(window.frame) }) else {
      FileHandle.standardError.write("window \(windowID) is on no display\n".data(using: .utf8)!)
      exit(1)
    }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let scale = CGFloat(filter.pointPixelScale)
    let width = Int(window.frame.width * scale) & ~1
    let height = Int(window.frame.height * scale) & ~1
    let config = SCStreamConfiguration()
    config.width = width
    config.height = height
    config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    config.showsCursor = false
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.queueDepth = 8
    config.sourceRect = CGRect(x: window.frame.minX - display.frame.minX, y: window.frame.minY - display.frame.minY, width: window.frame.width, height: window.frame.height)
    let recorder = try Recorder(url: outURL, width: width, height: height)
    let stream = SCStream(filter: filter, configuration: config, delegate: recorder)
    try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: DispatchQueue(label: "winrec"))
    try await stream.startCapture()
    print("recording \(windowID) at \(width)x\(height) for \(seconds)s")
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    try await stream.stopCapture()
    recorder.input.markAsFinished()
    await recorder.writer.finishWriting()
    print("wrote \(recorder.frames) frames to \(outURL.path)")
  } catch {
    FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
    exit(1)
  }
  exit(0)
}
dispatchMain()
