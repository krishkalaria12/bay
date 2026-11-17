import BayCore
import Foundation
import Security

/// The core's HTTP requests, through URLSession: the phone's own certificates, proxies and VPN.
final class URLSessionHttp: HttpClient, @unchecked Sendable {
  private let session: URLSession

  init() {
    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = 20
    configuration.waitsForConnectivity = false
    session = URLSession(configuration: configuration)
  }

  func send(request: HttpRequest) async throws -> HttpResponse {
    guard let url = URL(string: request.url) else { throw HttpError.Offline(reason: "bad address") }
    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = request.method
    if let timeout = request.timeoutMs {
      urlRequest.timeoutInterval = max(Double(timeout) / 1000, 0.1)
    }
    for (name, value) in request.headers {
      urlRequest.setValue(value, forHTTPHeaderField: name)
    }
    urlRequest.httpBody = request.body
    do {
      let (data, response) = try await session.data(
        for: urlRequest, delegate: request.followRedirects ? nil : StopRedirects.shared)
      let http = response as? HTTPURLResponse
      var headers: [String: String] = [:]
      for (name, value) in http?.allHeaderFields ?? [:] {
        if let name = name as? String { headers[name.lowercased()] = "\(value)" }
      }
      return HttpResponse(
        status: UInt16(clamping: http?.statusCode ?? 0), url: response.url?.absoluteString ?? "",
        headers: headers, body: data)
    } catch {
      throw HttpError.Offline(reason: error.localizedDescription)
    }
  }
}

/// Answers a request with its first redirect instead of following it, for a walk that goes hop by hop.
private final class StopRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  static let shared = StopRedirects()

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest
  ) async -> URLRequest? {
    nil
  }
}

/// The chain's key in the keychain, stored as expo-secure-store stores it (service `app:no-auth`, the key as account),
/// so the key the Expo app kept is read after the native app installs over it.
final class KeychainSecrets: SecretStore, @unchecked Sendable {
  private let service = "app:no-auth"
  /// Where expo-secure-store kept items before it split them by authentication.
  private let olderService = "app"

  private func query(_ key: String, service: String) -> [String: Any] {
    let account = Data(key.utf8)
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrGeneric as String: account,
      kSecAttrAccount as String: account,
    ]
  }

  func read(key: String) -> String? {
    for service in [service, olderService] {
      var search = query(key, service: service)
      search[kSecReturnData as String] = true
      search[kSecMatchLimit as String] = kSecMatchLimitOne
      var result: AnyObject?
      if SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess, let data = result as? Data {
        return String(data: data, encoding: .utf8)
      }
    }
    return nil
  }

  func write(key: String, value: String) {
    delete(key: key)
    var item = query(key, service: service)
    item[kSecValueData as String] = Data(value.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(item as CFDictionary, nil)
  }

  func delete(key: String) {
    for service in [service, olderService] {
      SecItemDelete(query(key, service: service) as CFDictionary)
    }
  }
}
