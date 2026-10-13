// Makes the QR code for a demo page.
// Usage: swift tools/make-qr.swift <page-url> <output.png>
import CoreImage
import CoreImage.CIFilterBuiltins
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3 else { print("usage: make-qr.swift <url> <out.png>"); exit(1) }
let f = CIFilter.qrCodeGenerator()
f.message = Data(args[1].utf8)
f.correctionLevel = "M"
let img = f.outputImage!.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
let cg = CIContext().createCGImage(img, from: img.extent)!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, cg, nil)
CGImageDestinationFinalize(dest)
