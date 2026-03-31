// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "LicenseClient",
    platforms: [
        .macOS(.v12),
        .iOS(.v15)
    ],
    products: [
        .library(
            name: "LicenseClient",
            targets: ["LicenseClient"]
        ),
    ],
    targets: [
        .target(
            name: "LicenseClient",
            dependencies: [],
            path: "Sources"
        ),
    ]
)
