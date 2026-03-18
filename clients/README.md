# License Client SDKs

Client libraries for integrating license validation into your applications.

## Status

| SDK | Platform | Status |
|-----|----------|--------|
| Node.js/TypeScript | Any | Ready |
| Swift | macOS/iOS (Apple Silicon) | Ready |
| C# | Windows (AMD64/ARM64) | Ready |
| Rust | Cross-platform | Ready |

## Available SDKs

| Platform | Language | Directory | Use Case |
|----------|----------|-----------|----------|
| **Node.js/Vite** | TypeScript | `node/` | Web servers, Electron, Vite builds |
| **macOS** | Swift | `swift/` | Native Mac apps (Apple Silicon) |
| **Windows** | C# | `csharp/` | .NET apps (AMD64/ARM64) |
| **Cross-platform** | Rust | `rust/` | Native apps, CLI tools |

---

## Installation

### Node.js

```bash
cd clients/node
npm install
npm run build
```

Or copy to your project:
```bash
cp -r clients/node your-project/packages/license-client
```

### Swift (macOS)

Add to your `Package.swift`:
```swift
dependencies: [
    .package(path: "../clients/swift")
]
```

Or build standalone:
```bash
cd clients/swift
swift build -c release
```

### C# (Windows)

```bash
cd clients/csharp
dotnet build -c Release

# For specific architectures:
dotnet publish -c Release -r win-x64 --self-contained
dotnet publish -c Release -r win-arm64 --self-contained
```

### Rust

```bash
cd clients/rust
cargo build --release

# Cross-compile:
cargo build --release --target aarch64-apple-darwin      # Mac Silicon
cargo build --release --target x86_64-pc-windows-msvc    # Windows x64
cargo build --release --target aarch64-pc-windows-msvc   # Windows ARM64
```

---

## Desktop App Integration

For desktop applications (Windows/macOS), use the desktop-specific endpoints that provide:
- **Offline token**: Allows the app to work offline within a grace period
- **Periodic check-in**: Renews the offline token
- **Platform tracking**: Records which OS is being used

### C# (Windows Desktop)

```csharp
using LicenseClient;

var client = new LicenseClient(new LicenseClientConfig
{
    ServerUrl = "https://license.agencio.cloud",
    AppVersion = "1.0.0",
    UseDesktopEndpoints = true,  // Use /api/v1/desktop/* endpoints
    CheckInInterval = TimeSpan.FromDays(7),
    OfflineGracePeriod = TimeSpan.FromDays(7)
});

// Desktop validation with offline token
var result = await client.ValidateDesktopAsync("XXXX-XXXX-XXXX-XXXX");
if (result.Valid)
{
    Console.WriteLine($"Product: {result.Product}");
    Console.WriteLine($"Offline token: {result.OfflineToken != null}");
    Console.WriteLine($"Check-in every: {result.CheckInDays} days");
}

// Auto check-in (validates + checks in if needed)
var autoResult = await client.ValidateWithAutoCheckInAsync("XXXX-XXXX-XXXX-XXXX");

// Manual check-in to renew offline token
var checkIn = await client.CheckInAsync("XXXX-XXXX-XXXX-XXXX");
if (checkIn.Valid)
{
    Console.WriteLine($"Token renewed, next check-in: {checkIn.NextCheckIn}");
}
```

### Swift (macOS Desktop)

```swift
import LicenseClient

let client = LicenseClient(config: LicenseClientConfig(
    serverUrl: "https://license.agencio.cloud",
    appVersion: "1.0.0",
    useDesktopEndpoints: true,
    checkInIntervalDays: 7,
    offlineGracePeriodDays: 7
))

// Desktop validation with offline token
let result = await client.validateDesktop(licenseKey: "XXXX-XXXX-XXXX-XXXX")
if result.valid {
    print("Product: \(result.product ?? "")")
    print("Offline token available: \(result.offlineToken != nil)")
    print("Check-in every: \(result.checkInDays) days")
}

// Auto check-in (validates + checks in if needed)
let autoResult = await client.validateWithAutoCheckIn(licenseKey: "XXXX-XXXX-XXXX-XXXX")

// Manual check-in
let checkIn = await client.checkIn(licenseKey: "XXXX-XXXX-XXXX-XXXX")
if checkIn.valid {
    print("Token renewed, next check-in: \(checkIn.nextCheckIn ?? "")")
}
```

### Desktop Validation Flow

```
┌───────────────────────────────────────────────────────────────┐
│                    Desktop Application                         │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│   1. First Launch                                              │
│      │                                                         │
│      ▼                                                         │
│   ┌──────────────────────┐                                     │
│   │ POST /desktop/validate│ ──▶ License Server                 │
│   │  + platform: windows  │      Returns: offlineToken,        │
│   │  + appVersion: 1.0.0  │              checkInDays: 7        │
│   └──────────┬───────────┘                                     │
│              │                                                 │
│              ▼                                                 │
│   ┌──────────────────────┐                                     │
│   │ Store offline token  │                                     │
│   │ Record check-in date │                                     │
│   └──────────┬───────────┘                                     │
│              │                                                 │
│   2. Subsequent Launches (within 7 days)                       │
│      │                                                         │
│      ▼                                                         │
│   ┌──────────────────────┐                                     │
│   │ Use cached token     │ ◀── No network needed               │
│   │ App works offline!   │                                     │
│   └──────────┬───────────┘                                     │
│              │                                                 │
│   3. After 7 days (check-in required)                          │
│      │                                                         │
│      ▼                                                         │
│   ┌──────────────────────┐                                     │
│   │ POST /desktop/checkin│ ──▶ License Server                  │
│   │  Returns: renewedToken│     Renews for another 7 days      │
│   └──────────────────────┘                                     │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

---

## Quick Start Examples

### Node.js (Vite/Express/Electron)

```typescript
import { LicenseClient } from '@license-server/client';

const client = new LicenseClient({
  serverUrl: 'https://license.example.com',
  cacheTTL: 3600,           // 1 hour cache
  offlineGracePeriod: 7,    // 7 days offline
});

// Validate
const result = await client.validate('XXXX-XXXX-XXXX-XXXX');
if (result.valid) {
  console.log(`Product: ${result.product}`);
  console.log(`Features: ${result.features?.join(', ')}`);
}

// Activate on this machine
const activation = await client.activate('XXXX-XXXX-XXXX-XXXX', 'My Computer');

// Check specific feature
const hasPremium = await client.hasFeature('XXXX-XXXX-XXXX-XXXX', 'premium');
```

### Swift (macOS/iOS)

```swift
import LicenseClient

let client = LicenseClient(config: LicenseClientConfig(
    serverUrl: "https://license.example.com",
    cacheTTL: 3600,
    offlineGracePeriodDays: 7
))

// Validate
let result = await client.validate(licenseKey: "XXXX-XXXX-XXXX-XXXX")
if result.valid {
    print("Product: \(result.product ?? "")")
    print("Features: \(result.features?.joined(separator: ", ") ?? "")")
}

// Activate
let activation = await client.activate(
    licenseKey: "XXXX-XXXX-XXXX-XXXX",
    machineName: "My Mac"
)

// Check feature
let hasPremium = await client.hasFeature(licenseKey: "XXXX-XXXX-XXXX-XXXX", feature: "premium")
```

### C# (.NET/Windows)

```csharp
using LicenseClient;

var client = new LicenseClient(new LicenseClientConfig
{
    ServerUrl = "https://license.example.com",
    CacheTTL = TimeSpan.FromHours(1),
    OfflineGracePeriod = TimeSpan.FromDays(7)
});

// Validate
var result = await client.ValidateAsync("XXXX-XXXX-XXXX-XXXX");
if (result.Valid)
{
    Console.WriteLine($"Product: {result.Product}");
    Console.WriteLine($"Features: {string.Join(", ", result.Features ?? Array.Empty<string>())}");
}

// Activate
var activation = await client.ActivateAsync("XXXX-XXXX-XXXX-XXXX", "My PC");

// Check feature
var hasPremium = await client.HasFeatureAsync("XXXX-XXXX-XXXX-XXXX", "premium");
```

### Rust (Cross-platform)

```rust
use license_client::{LicenseClient, LicenseClientConfig};
use std::time::Duration;

let client = LicenseClient::new(LicenseClientConfig {
    server_url: "https://license.example.com".to_string(),
    cache_ttl: Duration::from_secs(3600),
    offline_grace_period: Duration::from_secs(7 * 24 * 3600),
    ..Default::default()
});

// Validate
let result = client.validate("XXXX-XXXX-XXXX-XXXX").await;
if result.valid {
    println!("Product: {}", result.product.unwrap_or_default());
    println!("Features: {:?}", result.features.unwrap_or_default());
}

// Activate
let activation = client.activate("XXXX-XXXX-XXXX-XXXX", Some("My Computer")).await;

// Check feature
let has_premium = client.has_feature("XXXX-XXXX-XXXX-XXXX", "premium").await;
```

---

## API Response Formats

### Validation Response

```json
{
  "valid": true,
  "product": "MyApp Pro",
  "expiresAt": "2025-12-31T23:59:59Z",
  "features": ["feature1", "feature2", "premium"],
  "cached": false
}
```

### Activation Response

```json
{
  "success": true,
  "activation": {
    "machineFingerprint": "abc123def456...",
    "activatedAt": "2024-01-15T10:30:00Z"
  }
}
```

### Error Response

```json
{
  "valid": false,
  "error": "License has expired"
}
```

---

## Common Features

All SDKs provide:

| Feature | Description |
|---------|-------------|
| **Online validation** | Validates against license server |
| **Machine fingerprinting** | Hardware-based unique ID per machine |
| **Offline caching** | Works without network within grace period |
| **Activation management** | Activate/deactivate on specific machines |
| **Feature checking** | Check if specific features are enabled |
| **Auto-retry** | Handles network errors gracefully |

---

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `serverUrl` | (required) | License server URL |
| `productId` | (optional) | Filter validation to specific product |
| `cacheDir` | OS default | Directory for cached validations |
| `cacheTTL` | 1 hour | How long cached validation is fresh |
| `offlineGracePeriod` | 7 days | How long to allow offline usage |

---

## Build Targets

### macOS Apple Silicon (arm64)
```bash
# Swift - native
swift build -c release

# Rust
cargo build --release --target aarch64-apple-darwin
```

### Windows AMD64 (x64)
```bash
# C#
dotnet publish -c Release -r win-x64 --self-contained

# Rust
cargo build --release --target x86_64-pc-windows-msvc
```

### Windows ARM64
```bash
# C#
dotnet publish -c Release -r win-arm64 --self-contained

# Rust
cargo build --release --target aarch64-pc-windows-msvc
```

### Node.js/Vite
```bash
# Works on any platform with Node.js 18+
npm run build
```

---

## Choosing an SDK

| If you're building... | Use | Why |
|-----------------------|-----|-----|
| Express/Fastify API | Node.js | Native integration, middleware support |
| Vite/Next.js app | Node.js | Vite plugin, SSR support |
| Electron app | Node.js | Same runtime as app |
| Native Mac app | Swift | Native APIs, async/await |
| WPF/WinForms app | C# | .NET ecosystem |
| Cross-platform native | Rust | Single codebase, all targets |
| CLI tool | Rust | Small binary, fast startup |

---

## License Validation Flow

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Application                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   1. App Startup                                             │
│      │                                                       │
│      ▼                                                       │
│   ┌──────────────────┐                                       │
│   │ Load stored key  │                                       │
│   └────────┬─────────┘                                       │
│            │                                                 │
│            ▼                                                 │
│   ┌──────────────────┐    ┌─────────────────────────────┐   │
│   │ Check cache      │───▶│ Cache valid? Use cached     │   │
│   └────────┬─────────┘    └─────────────────────────────┘   │
│            │ Cache miss/expired                              │
│            ▼                                                 │
│   ┌──────────────────┐    ┌─────────────────────────────┐   │
│   │ Online validate  │───▶│ License Server              │   │
│   └────────┬─────────┘    │ POST /api/v1/validate       │   │
│            │              └─────────────────────────────┘   │
│            ▼                                                 │
│   ┌──────────────────┐                                       │
│   │ Cache result     │                                       │
│   └────────┬─────────┘                                       │
│            │                                                 │
│            ▼                                                 │
│   ┌──────────────────┐                                       │
│   │ valid? Continue  │                                       │
│   │ invalid? Block   │                                       │
│   └──────────────────┘                                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Machine Fingerprinting

Each SDK generates a unique machine fingerprint using hardware identifiers:

| Platform | Identifiers Used |
|----------|------------------|
| **macOS** | Hardware UUID, Serial Number, Model ID |
| **Windows** | CPU ID, Motherboard Serial, BIOS Serial, Machine GUID |
| **Linux** | /etc/machine-id, CPU info, MAC addresses |
| **Node.js** | Hostname, Platform, CPU, MAC address |

The fingerprint is a SHA-256 hash truncated to 32 characters.

---

## Error Handling

All SDKs handle errors consistently:

```typescript
// Node.js example
const result = await client.validate('INVALID-KEY');
if (!result.valid) {
  switch (result.error) {
    case 'Invalid license key':
      // Show activation dialog
      break;
    case 'License has expired':
      // Show renewal prompt
      break;
    case 'Maximum activations reached':
      // Show deactivation instructions
      break;
    case 'License has been revoked':
      // Contact support
      break;
    default:
      // Network error - use cached if available
  }
}
```

---

## Security Recommendations

1. **Store license keys securely**
   - macOS: Use Keychain
   - Windows: Use Credential Manager or DPAPI
   - Node.js: Use OS keychain via `keytar`

2. **Validate on startup**
   - Check license before showing main UI
   - Show splash screen during validation

3. **Periodic revalidation**
   - Refresh in background every hour
   - Handle grace period for offline use

4. **Handle offline gracefully**
   - Use cached validation during network outages
   - Show warning when approaching grace period end

5. **Code sign your app**
   - macOS: Sign and notarize
   - Windows: Sign with EV certificate
   - Prevents tampering with validation logic

---

## Testing

Each SDK can be tested against the license server:

```bash
# Start the license server
cd .. && npm run dev

# Test with Node.js SDK
cd clients/node
npx ts-node -e "
import { LicenseClient } from './src';
const c = new LicenseClient({ serverUrl: 'http://localhost:3000' });
c.validate('TEST-KEY').then(console.log);
"

# Test with Rust CLI
cd clients/rust
LICENSE_SERVER_URL=http://localhost:3000 cargo run --bin license-cli -- validate TEST-KEY
```

---

## Support

- See individual SDK READMEs for detailed documentation
- Report issues at the main repository
- PRs welcome for additional language SDKs
