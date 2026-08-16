// OmniOCR — macOS depth extraction helper.
//
// Reads the depth or disparity auxiliary image that iPhone cameras embed in
// HEIC/HEIF and JPEG captures (Portrait mode, LiDAR-assisted capture) and
// writes it to stdout as a flat float32 grid.
//
// Wire format:  'ODPT' | width:uint32 | height:uint32 | flags:uint32 | float32[w*h]
//               flags bit 0 set  → values are disparity (1/distance)
//               flags bit 0 clear → values are depth in metres
//
// Built at package time; the app degrades gracefully when it is absent.

import Foundation
import CoreImage
import ImageIO
import CoreVideo

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("omni-depth: " + message + "\n").data(using: .utf8)!)
    exit(2)
}

let args = CommandLine.arguments
guard args.count == 2 else { fail("usage: omni-depth <image-file>") }
let url = URL(fileURLWithPath: args[1])

guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
    fail("cannot open \(url.lastPathComponent)")
}

// Prefer a true depth map; fall back to disparity, then to the portrait matte.
let auxTypes = [
    kCGImageAuxiliaryDataTypeDepth,
    kCGImageAuxiliaryDataTypeDisparity,
    kCGImageAuxiliaryDataTypePortraitEffectsMatte,
]

var depthData: AVDepthDataLike? = nil

/// Minimal shim so we can carry either a real AVDepthData-derived buffer or a
/// matte without importing AVFoundation's heavier dependencies.
struct AVDepthDataLike {
    let pixelBuffer: CVPixelBuffer
    let isDisparity: Bool
}

for type in auxTypes {
    guard let info = CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, type) as? [AnyHashable: Any] else { continue }
    guard let data = info[kCGImageAuxiliaryDataInfoData] as? Data,
          let description = info[kCGImageAuxiliaryDataInfoDataDescription] as? [AnyHashable: Any],
          let width = description["Width"] as? Int,
          let height = description["Height"] as? Int,
          let bytesPerRow = description["BytesPerRow"] as? Int,
          let pixelFormat = description["PixelFormat"] as? Int
    else { continue }

    var pixelBuffer: CVPixelBuffer?
    let status = data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> CVReturn in
        guard let base = raw.baseAddress else { return kCVReturnError }
        return CVPixelBufferCreateWithBytes(
            kCFAllocatorDefault, width, height,
            OSType(pixelFormat), UnsafeMutableRawPointer(mutating: base),
            bytesPerRow, nil, nil, nil, &pixelBuffer)
    }
    guard status == kCVReturnSuccess, let buffer = pixelBuffer else { continue }

    let isDisparity = (type == kCGImageAuxiliaryDataTypeDisparity)
    depthData = AVDepthDataLike(pixelBuffer: buffer, isDisparity: isDisparity)
    break
}

guard let depth = depthData else { fail("no depth/disparity auxiliary image present") }

let buffer = depth.pixelBuffer
CVPixelBufferLockBaseAddress(buffer, .readOnly)
defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }

let width = CVPixelBufferGetWidth(buffer)
let height = CVPixelBufferGetHeight(buffer)
let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
let format = CVPixelBufferGetPixelFormatType(buffer)
guard let base = CVPixelBufferGetBaseAddress(buffer) else { fail("cannot map depth buffer") }

var out = [Float32](repeating: 0, count: width * height)

// Apple writes depth as either 16-bit half floats or 32-bit floats.
switch format {
case kCVPixelFormatType_DepthFloat32, kCVPixelFormatType_DisparityFloat32:
    for y in 0..<height {
        let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: Float32.self)
        for x in 0..<width { out[y * width + x] = row[x] }
    }
case kCVPixelFormatType_DepthFloat16, kCVPixelFormatType_DisparityFloat16:
    for y in 0..<height {
        let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: UInt16.self)
        for x in 0..<width { out[y * width + x] = Float32(Float16(bitPattern: row[x])) }
    }
case kCVPixelFormatType_OneComponent8:
    for y in 0..<height {
        let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: UInt8.self)
        for x in 0..<width { out[y * width + x] = Float32(row[x]) / 255.0 }
    }
default:
    fail("unsupported depth pixel format \(format)")
}

var header = Data()
header.append(contentsOf: Array("ODPT".utf8))
var w32 = UInt32(width).littleEndian;  header.append(Data(bytes: &w32, count: 4))
var h32 = UInt32(height).littleEndian; header.append(Data(bytes: &h32, count: 4))
var flags = UInt32(depth.isDisparity ? 1 : 0).littleEndian
header.append(Data(bytes: &flags, count: 4))

let payload = out.withUnsafeBufferPointer { Data(buffer: $0) }
FileHandle.standardOutput.write(header)
FileHandle.standardOutput.write(payload)
