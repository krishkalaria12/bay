import Compression
import Foundation

enum BayZipError: LocalizedError {
  case unreadable(String)

  var errorDescription: String? {
    switch self {
    case .unreadable(let reason): return reason
    }
  }
}

/// A zip archive read in place (desktop's `packages/import/ios/Core/ZipArchive.swift`, with ZIP64 for the large
/// archives Takeout makes). Stored and deflated entries only; encrypted ones are left out.
struct BayZip {
  struct Entry {
    var path: String
    var method: UInt16
    var compressedSize: Int
    var size: Int
    var localHeaderOffset: Int
  }

  let data: Data
  let entries: [Entry]

  /// Whether a file starts like a zip archive.
  static func isZip(_ url: URL) -> Bool {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
    defer { try? handle.close() }
    let head = (try? handle.read(upToCount: 4)) ?? Data()
    return head == Data([0x50, 0x4B, 0x03, 0x04])
  }

  init(_ url: URL) throws {
    data = try Data(contentsOf: url, options: .alwaysMapped)
    let eocdSize = 22
    guard data.count >= eocdSize else { throw BayZipError.unreadable("Not a zip file") }

    // The end of central directory record: the last one, after at most 64 KB of comment.
    var eocd: Int?
    var i = data.count - eocdSize
    let floor = max(0, data.count - eocdSize - 0xFFFF)
    while i >= floor {
      if data[i] == 0x50, data[i + 1] == 0x4B, data[i + 2] == 0x05, data[i + 3] == 0x06 { eocd = i; break }
      i -= 1
    }
    guard let eocd else { throw BayZipError.unreadable("Not a zip file") }

    var count = Int(Self.u16(data, eocd + 10))
    var directory = Int(Self.u32(data, eocd + 16))

    // ZIP64: the record's fields are saturated and the real ones sit in the ZIP64 record its locator points at.
    if count == 0xFFFF || directory == 0xFFFF_FFFF {
      let locator = eocd - 20
      guard locator >= 0, Self.u32(data, locator) == 0x0706_4B50 else { throw BayZipError.unreadable("Damaged zip file") }
      let record = Int(clamping: Self.u64(data, locator + 8))
      guard record >= 0, record + 56 <= data.count, Self.u32(data, record) == 0x0606_4B50 else {
        throw BayZipError.unreadable("Damaged zip file")
      }
      count = Int(clamping: Self.u64(data, record + 32))
      directory = Int(clamping: Self.u64(data, record + 48))
    }

    var list: [Entry] = []
    var offset = directory
    for _ in 0..<count {
      guard offset + 46 <= data.count, Self.u32(data, offset) == 0x0201_4B50 else { throw BayZipError.unreadable("Damaged zip directory") }
      let flags = Self.u16(data, offset + 8)
      let method = Self.u16(data, offset + 10)
      var compressedSize = Int(Self.u32(data, offset + 20))
      var size = Int(Self.u32(data, offset + 24))
      let nameLength = Int(Self.u16(data, offset + 28))
      let extraLength = Int(Self.u16(data, offset + 30))
      let commentLength = Int(Self.u16(data, offset + 32))
      var local = Int(Self.u32(data, offset + 42))
      let nameStart = offset + 46
      guard nameStart + nameLength + extraLength <= data.count else { throw BayZipError.unreadable("Damaged zip directory") }
      let name = String(data: data.subdata(in: nameStart..<nameStart + nameLength), encoding: flags & 0x800 != 0 ? .utf8 : .isoLatin1) ?? ""

      // ZIP64 extra field (0x0001): the saturated sizes and offset, in that order, each only when saturated.
      var extra = nameStart + nameLength
      let extraEnd = extra + extraLength
      while extra + 4 <= extraEnd {
        let id = Self.u16(data, extra)
        let length = Int(Self.u16(data, extra + 2))
        if id == 0x0001 {
          var field = extra + 4
          if size == 0xFFFF_FFFF, field + 8 <= extraEnd { size = Int(clamping: Self.u64(data, field)); field += 8 }
          if compressedSize == 0xFFFF_FFFF, field + 8 <= extraEnd { compressedSize = Int(clamping: Self.u64(data, field)); field += 8 }
          if local == 0xFFFF_FFFF, field + 8 <= extraEnd { local = Int(clamping: Self.u64(data, field)) }
        }
        extra += 4 + length
      }

      if flags & 0x1 == 0 {
        list.append(Entry(path: name, method: method, compressedSize: compressedSize, size: size, localHeaderOffset: local))
      }
      offset += 46 + nameLength + extraLength + commentLength
    }
    entries = list
  }

  /// An entry's contents.
  func extract(_ entry: Entry) throws -> Data {
    let header = entry.localHeaderOffset
    guard header >= 0, header + 30 <= data.count, Self.u32(data, header) == 0x0403_4B50 else {
      throw BayZipError.unreadable("Damaged zip entry")
    }
    let start = header + 30 + Int(Self.u16(data, header + 26)) + Int(Self.u16(data, header + 28))
    guard entry.compressedSize >= 0, start + entry.compressedSize <= data.count else { throw BayZipError.unreadable("Damaged zip entry") }
    let body = data.subdata(in: start..<start + entry.compressedSize)

    switch entry.method {
    case 0:
      return body
    case 8:
      guard entry.size > 0 else { return Data() }
      var out = Data(count: entry.size)
      // Apple's COMPRESSION_ZLIB is raw DEFLATE, what zip entries hold.
      let written = out.withUnsafeMutableBytes { destination in
        body.withUnsafeBytes { source in
          compression_decode_buffer(
            destination.bindMemory(to: UInt8.self).baseAddress!, entry.size,
            source.bindMemory(to: UInt8.self).baseAddress!, body.count, nil, COMPRESSION_ZLIB)
        }
      }
      guard written == entry.size else { throw BayZipError.unreadable("Couldn't unpack \(entry.path)") }
      return out
    default:
      throw BayZipError.unreadable("\(entry.path) is compressed in a way Bay can't unpack")
    }
  }

  private static func u16(_ data: Data, _ at: Int) -> UInt16 {
    guard at >= 0, at + 2 <= data.count else { return 0 }
    return UInt16(data[at]) | UInt16(data[at + 1]) << 8
  }

  private static func u32(_ data: Data, _ at: Int) -> UInt32 {
    guard at >= 0, at + 4 <= data.count else { return 0 }
    return (0..<4).reduce(UInt32(0)) { $0 | UInt32(data[at + $1]) << (8 * UInt32($1)) }
  }

  private static func u64(_ data: Data, _ at: Int) -> UInt64 {
    guard at >= 0, at + 8 <= data.count else { return 0 }
    return (0..<8).reduce(UInt64(0)) { $0 | UInt64(data[at + $1]) << (8 * UInt64($1)) }
  }
}
