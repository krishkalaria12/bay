// Voice search (B16): listens once through the on-device recogniser and resolves with the transcript, or null
// when there is nothing to type (speech or microphone denied, recogniser unavailable). Recognition is on-device
// wherever iOS does it (iOS 17+); Safari's dictation asks the same two permissions from the moment it's needed.
import AVFAudio
import ExpoModulesCore
import Speech

final class BayVoice: NSObject {
  private static var busy = false
  private static var recognitionTask: SFSpeechRecognitionTask?
  private static var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private static var audioEngine: AVAudioEngine?
  private static var didFinish = false

  /// Speech permission first, then the microphone — a refusal of either leaves the search card as it was.
  static func listen(promise: Promise) {
    SFSpeechRecognizer.requestAuthorization { speechStatus in
      guard speechStatus == .authorized else {
        promise.resolve(nil)
        return
      }
      requestMicrophone { granted in
        guard granted else {
          promise.resolve(nil)
          return
        }
        start(promise: promise)
      }
    }
  }

  /// Whether the microphone may be recorded: iOS 17 asks through AVAudioApplication, before that through the session.
  private static func requestMicrophone(_ done: @escaping (Bool) -> Void) {
    if #available(iOS 17, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: done)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(done)
    }
  }

  private static func start(promise: Promise) {
    guard !busy else {
      promise.resolve(nil)
      return
    }

    busy = true
    didFinish = false

    guard
      let recognizer = SFSpeechRecognizer(locale: .current),
      recognizer.isAvailable
    else {
      busy = false
      promise.resolve(nil)
      return
    }

    let currentRequest = SFSpeechAudioBufferRecognitionRequest()
    let engine = AVAudioEngine()
    let session = AVAudioSession.sharedInstance()

    do {
      try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      busy = false
      promise.resolve(nil)
      return
    }

    recognitionRequest = currentRequest
    recognitionRequest?.shouldReportPartialResults = true

    // Where iOS supports it, recognition never leaves the device; nothing audible arrives from abroad.
    if #available(iOS 17, *), recognizer.supportsOnDeviceRecognition {
      recognitionRequest?.requiresOnDeviceRecognition = true
    }

    let inputNode = engine.inputNode
    let format = inputNode.outputFormat(forBus: 0)

    inputNode.removeTap(onBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      currentRequest.append(buffer)
    }

    let finish: (String?) -> Void = { text in
      guard !didFinish else { return }
      didFinish = true
      busy = false
      engine.stop()
      inputNode.removeTap(onBus: 0)
      recognitionTask?.cancel()
      recognitionTask = nil
      recognitionRequest = nil
      audioEngine = nil

      DispatchQueue.main.async { promise.resolve(text) }
    }

    do {
      try engine.start()
    } catch {
      busy = false
      promise.resolve(nil)
      return
    }

    audioEngine = engine
    recognitionTask = recognizer.recognitionTask(with: currentRequest) { result, error in
      if let result, result.isFinal {
        finish(result.bestTranscription.formattedString)
      } else if error != nil {
        finish(nil)
      }
    }
  }
}
