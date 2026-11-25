import Foundation

/// Little-endian fields read one after another from bytes (ZIP archives).
struct ByteReader {
  let data: Data
  var offset: Int

  init(_ data: Data) {
    self.data = data
    offset = data.startIndex
  }

  var remaining: Int { data.endIndex - offset }

  mutating func bytes(_ n: Int) -> Data? {
    guard n >= 0, remaining >= n else { return nil }
    defer { offset += n }
    return data[offset..<offset + n]
  }

  mutating func skip(_ n: Int) -> Bool { bytes(n) != nil }

  private mutating func integer<T: FixedWidthInteger>(_: T.Type) -> T? {
    guard let b = bytes(MemoryLayout<T>.size) else { return nil }
    var v: T = 0
    for (i, byte) in b.enumerated() { v |= T(truncatingIfNeeded: byte) << (8 * i) }
    return v
  }

  mutating func u8() -> UInt8? { integer(UInt8.self) }
  mutating func u16() -> UInt16? { integer(UInt16.self) }
  mutating func u32() -> UInt32? { integer(UInt32.self) }
  mutating func i32() -> Int32? { integer(Int32.self) }
  mutating func u64() -> UInt64? { integer(UInt64.self) }
  mutating func i64() -> Int64? { integer(Int64.self) }
}
