# License Client for Swift (macOS/iOS)

A Swift package for integrating license validation into macOS and iOS applications, optimized for Apple Silicon.

## Installation

### Swift Package Manager

Add to your `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/your-org/license-client-swift", from: "1.0.0")
]
```

Or in Xcode: File > Add Packages > Enter repository URL

## Quick Start

```swift
import LicenseClient

let client = LicenseClient(config: LicenseClientConfig(
    serverUrl: "https://your-license-server.com",
    productId: "your-product-id"
))

// Validate a license
let result = await client.validate(licenseKey: "XXXX-XXXX-XXXX-XXXX")
if result.valid {
    print("Licensed for: \(result.product ?? "Unknown")")
    print("Features: \(result.features?.joined(separator: ", ") ?? "None")")
} else {
    print("License invalid: \(result.error ?? "Unknown error")")
}
```

## Features

- **Native Apple Silicon support** (arm64)
- **Secure machine fingerprinting** using hardware UUID and serial number
- **Offline validation** with configurable grace period
- **Async/await API** for modern Swift
- **Automatic caching** with configurable TTL

## API

### Configuration

```swift
let config = LicenseClientConfig(
    serverUrl: "https://license.example.com",
    productId: "optional-product-id",
    cacheDirectory: nil,           // Uses Application Support by default
    cacheTTL: 3600,                // 1 hour
    offlineGracePeriodDays: 7      // 7 days offline grace period
)

let client = LicenseClient(config: config)
```

### Validation

```swift
// Full validation
let result = await client.validate(licenseKey: "LICENSE-KEY")
// result.valid, result.product, result.features, result.expiresAt

// Quick check
let isValid = await client.isValid(licenseKey: "LICENSE-KEY")

// Feature check
let hasPremium = await client.hasFeature(licenseKey: "LICENSE-KEY", feature: "premium")
```

### Activation

```swift
// Activate on this machine
let result = await client.activate(
    licenseKey: "LICENSE-KEY",
    machineName: "John's MacBook Pro"  // Optional
)

if result.success {
    print("Activated at: \(result.activation?.activatedAt ?? "")")
} else {
    print("Activation failed: \(result.error ?? "")")
}
```

### Deactivation

```swift
let (success, error) = await client.deactivate(licenseKey: "LICENSE-KEY")
if success {
    print("Deactivated successfully")
}
```

### Machine Fingerprint

```swift
// Get the unique machine fingerprint
let fingerprint = client.getMachineFingerprint()
```

## macOS App Integration

### App Delegate Example

```swift
import Cocoa
import LicenseClient

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private var licenseClient: LicenseClient!
    private var licenseKey: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        licenseClient = LicenseClient(config: LicenseClientConfig(
            serverUrl: "https://license.example.com"
        ))

        // Check stored license
        if let key = UserDefaults.standard.string(forKey: "licenseKey") {
            Task {
                let result = await licenseClient.validate(licenseKey: key)
                if result.valid {
                    self.licenseKey = key
                    // Continue to main window
                } else {
                    // Show license activation window
                    showLicenseWindow()
                }
            }
        } else {
            showLicenseWindow()
        }
    }

    func showLicenseWindow() {
        // Present license activation UI
    }
}
```

### SwiftUI Example

```swift
import SwiftUI
import LicenseClient

@main
struct MyApp: App {
    @StateObject private var licenseManager = LicenseManager()

    var body: some Scene {
        WindowGroup {
            if licenseManager.isLicensed {
                ContentView()
            } else {
                LicenseActivationView()
            }
        }
        .environmentObject(licenseManager)
    }
}

@MainActor
class LicenseManager: ObservableObject {
    @Published var isLicensed = false
    @Published var features: [String] = []

    private let client = LicenseClient(config: LicenseClientConfig(
        serverUrl: "https://license.example.com"
    ))

    func validate(licenseKey: String) async -> Bool {
        let result = await client.validate(licenseKey: licenseKey)
        isLicensed = result.valid
        features = result.features ?? []
        return result.valid
    }

    func activate(licenseKey: String) async -> (Bool, String?) {
        let result = await client.activate(licenseKey: licenseKey)
        if result.success {
            _ = await validate(licenseKey: licenseKey)
        }
        return (result.success, result.error)
    }
}
```

## Offline Support

The client automatically handles offline scenarios:

1. **Within TTL**: Uses cached validation (default: 1 hour)
2. **Within Grace Period**: Allows offline use (default: 7 days)
3. **After Grace Period**: Returns invalid until online validation succeeds

```swift
let config = LicenseClientConfig(
    serverUrl: "https://license.example.com",
    cacheTTL: 3600,                // Refresh hourly when online
    offlineGracePeriodDays: 30     // Allow 30 days offline
)
```

## Security Notes

- Machine fingerprint uses hardware UUID and serial number
- License validation cached securely in Application Support
- Network requests use URLSession with default security
- Consider code signing and notarization for distribution
