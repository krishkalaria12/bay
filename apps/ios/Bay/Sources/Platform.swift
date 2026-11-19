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

/// Secrets (the chain's key, saved sign-ins) in the keychain: one generic password per key, readable after the first
/// unlock so syncing in the background works.
final class KeychainSecrets: SecretStore, @unchecked Sendable {
  private let service = "bay"

  private func query(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }

  func read(key: String) -> String? {
    var search = query(key)
    search[kSecReturnData as String] = true
    search[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func write(key: String, value: String) {
    delete(key: key)
    var item = query(key)
    item[kSecValueData as String] = Data(value.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(item as CFDictionary, nil)
  }

  func delete(key: String) {
    SecItemDelete(query(key) as CFDictionary)
  }
}
