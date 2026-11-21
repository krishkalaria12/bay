import AppKit

protocol Enumerable {}
protocol Record {}
@propertyWrapper struct Field<Value> {
  var wrappedValue: Value
  init(wrappedValue: Value) { self.wrappedValue = wrappedValue }
  init() where Value: ExpressibleByNilLiteral { wrappedValue = nil }
}
struct Either<A, B> {
  let value: Any
  init(_ value: A) { self.value = value }
  init(_ value: B) { self.value = value }
  func get<T>() -> T? { value as? T }
}
// IMAGE_IMPLEMENTATION
func check(_ condition: @autoclosure () -> Bool, _ description: String) {
  precondition(condition(), description)
}
let sourceImage = NSImage(size: CGSize(width: 40, height: 20))
let representation = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: 80, pixelsHigh: 40,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
representation.size = sourceImage.size
for y in 0..<40 {
  for x in 0..<80 {
    let pixel = representation.bitmapData!.advanced(by: y * representation.bytesPerRow + x * 4)
    pixel[0] = (x < 40 && y < 20) || (x >= 40 && y >= 20) ? 255 : 0
    pixel[1] = y >= 20 ? 255 : 0
    pixel[2] = x >= 40 && y < 20 ? 255 : 0
    pixel[3] = 255
  }
}
sourceImage.addRepresentation(representation)
check(sourceImage.scale == 2, "Retina scale is inferred from the bitmap representation")
let target = CGSize(width: 16, height: 16)
check(
  idealSize(
    contentPixelSize: CGSize(width: 80, height: 40), containerSize: target, scale: 2,
    contentFit: .cover) == CGSize(width: 32, height: 16), "cover preserves ratio and fills")
check(
  idealSize(
    contentPixelSize: CGSize(width: 80, height: 40), containerSize: target, scale: 2,
    contentFit: .contain) == CGSize(width: 16, height: 8), "contain fits the entire image")
check(
  idealSize(
    contentPixelSize: CGSize(width: 80, height: 40), containerSize: target, scale: 2,
    contentFit: .fill) == target, "fill stretches to bounds")
check(
  idealSize(
    contentPixelSize: CGSize(width: 80, height: 40), containerSize: target, scale: 2,
    contentFit: .none) == CGSize(width: 40, height: 20), "none respects pixel scale")
check(
  shouldDownscale(image: sourceImage, toSize: CGSize(width: 10, height: 5), scale: 2),
  "large image is downscaled")
let resized = resize(image: sourceImage, toSize: CGSize(width: 10, height: 5), scale: 2)
check(resized.size == CGSize(width: 10, height: 5), "resized point size")
check(resized.cgImage!.width == 20 && resized.cgImage!.height == 10, "resized Retina pixel size")
check(resized.scale == 2, "resized bitmap retains Retina scale")
let bitmap = NSBitmapImageRep(cgImage: resized.cgImage!)
let left = bitmap.colorAt(x: 2, y: 2)!.usingColorSpace(.deviceRGB)!
let right = bitmap.colorAt(x: 17, y: 2)!.usingColorSpace(.deviceRGB)!
check(left.redComponent > 0.9 && left.blueComponent < 0.1, "left pixels remain red")
check(right.blueComponent > 0.9 && right.redComponent < 0.1, "right pixels remain blue")
let bottomLeft = bitmap.colorAt(x: 2, y: 7)!.usingColorSpace(.deviceRGB)!
let bottomRight = bitmap.colorAt(x: 17, y: 7)!.usingColorSpace(.deviceRGB)!
check(
  bottomLeft.greenComponent > 0.9 && bottomLeft.redComponent < 0.1,
  "bottom-left pixels remain green")
check(
  bottomRight.redComponent > 0.9 && bottomRight.greenComponent > 0.9
    && bottomRight.blueComponent < 0.1, "bottom-right pixels remain yellow")
for y in [0, 9] {
  for x in [0, 19] {
    check(
      bitmap.colorAt(x: x, y: y)!.alphaComponent > 0.99, "Retina output has no transparent quadrant"
    )
  }
}
let template = sourceImage.copy() as! NSImage
template.isTemplate = true
check(
  !sourceImage.isTemplate && template.isTemplate,
  "tint template copy leaves cached source unchanged")
let box = CGSize(width: 100, height: 100)
let contained = idealSize(
  contentPixelSize: CGSize(width: 200, height: 100), containerSize: box, contentFit: .contain)
let covered = idealSize(
  contentPixelSize: CGSize(width: 200, height: 100), containerSize: box, contentFit: .cover)
check(
  ContentPosition.center.frame(contentSize: contained, containerSize: box)
    == CGRect(x: 0, y: 25, width: 100, height: 50), "contain is centered vertically")
check(
  ContentPosition.center.frame(contentSize: covered, containerSize: box)
    == CGRect(x: -50, y: 0, width: 200, height: 100), "cover is centered horizontally")
var topLeft = ContentPosition()
topLeft.top = Either<Double, String>(0.0)
topLeft.left = Either<Double, String>(0.0)
check(
  topLeft.frame(contentSize: contained, containerSize: box).origin == .zero,
  "explicit top-left placement")
var bottomRightPosition = ContentPosition()
bottomRightPosition.bottom = Either<Double, String>("0%")
bottomRightPosition.right = Either<Double, String>("0%")
check(
  bottomRightPosition.frame(contentSize: CGSize(width: 50, height: 50), containerSize: box).origin
    == CGPoint(x: 50, y: 50), "percentage bottom-right placement")
let blur = blurhash(fromImage: sourceImage, numberOfComponents: (4, 3))!
let blurImage = imageFromBlurhashForTest(blur)
let blurPixels = NSBitmapImageRep(cgImage: blurImage)
check(blurPixels.colorAt(x: 5, y: 5)!.redComponent > 0.4, "blurhash retains top-left red quadrant")
check(
  blurPixels.colorAt(x: 35, y: 5)!.blueComponent > 0.4, "blurhash retains top-right blue quadrant")
let thumb = thumbHash(fromImage: sourceImage)
let thumbImage = imageFromThumbhashForTest(thumb)
check(thumbImage.size.width > thumbImage.size.height, "thumbhash retains landscape aspect ratio")
check(thumbImage.cgImage != nil, "thumbhash decodes into an AppKit image")
print("26 macOS image checks passed")

func imageFromBlurhashForTest(_ hash: String) -> CGImage {
  image(fromBlurhash: hash, size: CGSize(width: 40, height: 20))!
}

func imageFromThumbhashForTest(_ hash: Data) -> NSImage {
  image(fromThumbhash: hash)
}
