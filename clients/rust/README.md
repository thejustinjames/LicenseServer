# License Client for Rust

A cross-platform Rust library and CLI for license validation, supporting macOS (Apple Silicon), Windows (AMD64/ARM64), and Linux.

## Installation

### Cargo

```toml
[dependencies]
license-client = "1.0"
```

### Build from Source

```bash
cd clients/rust
cargo build --release
```

## Quick Start

```rust
use license_client::{LicenseClient, LicenseClientConfig};

#[tokio::main]
async fn main() {
    let client = LicenseClient::new(LicenseClientConfig {
        server_url: "https://license.example.com".to_string(),
        ..Default::default()
    });

    let result = client.validate("XXXX-XXXX-XXXX-XXXX").await;
    if result.valid {
        println!("Licensed for: {}", result.product.unwrap_or_default());
        println!("Features: {:?}", result.features.unwrap_or_default());
    } else {
        eprintln!("License invalid: {}", result.error.unwrap_or_default());
    }
}
```

## Features

- **Cross-platform**: macOS, Windows, Linux
- **Apple Silicon** (M1/M2/M3) native support
- **Windows ARM64** native support
- **Machine fingerprinting** using hardware identifiers
- **Offline validation** with configurable grace period
- **Async/await** and blocking APIs
- **CLI tool** for testing and scripting

## CLI Tool

```bash
# Build the CLI
cargo build --release --bin license-cli

# Set server URL
export LICENSE_SERVER_URL=https://license.example.com

# Validate a license
./target/release/license-cli validate XXXX-XXXX-XXXX-XXXX

# Activate on this machine
./target/release/license-cli activate XXXX-XXXX-XXXX-XXXX "My Computer"

# Deactivate
./target/release/license-cli deactivate XXXX-XXXX-XXXX-XXXX

# Show machine fingerprint
./target/release/license-cli fingerprint
```

## API

### Configuration

```rust
let config = LicenseClientConfig {
    server_url: "https://license.example.com".to_string(),
    product_id: Some("product-uuid".to_string()),
    cache_dir: None,  // Uses system data directory by default
    cache_ttl: Duration::from_secs(3600),  // 1 hour
    offline_grace_period: Duration::from_secs(7 * 24 * 3600),  // 7 days
};

let client = LicenseClient::new(config);
```

### Async Validation

```rust
// Full validation
let result = client.validate("LICENSE-KEY").await;
// result.valid, result.product, result.features, result.expires_at

// Quick check
let is_valid = client.is_valid("LICENSE-KEY").await;

// Feature check
let has_premium = client.has_feature("LICENSE-KEY", "premium").await;
```

### Blocking Validation

Enable the `blocking` feature:

```toml
[dependencies]
license-client = { version = "1.0", features = ["blocking"] }
```

```rust
let result = client.validate_blocking("LICENSE-KEY");
```

### Activation

```rust
let result = client.activate(
    "LICENSE-KEY",
    Some("Machine Name")
).await;

if result.success {
    println!("Activated at: {}", result.activation.unwrap().activated_at);
} else {
    eprintln!("Failed: {}", result.error.unwrap_or_default());
}
```

### Deactivation

```rust
let result = client.deactivate("LICENSE-KEY").await;
if result.success {
    println!("Deactivated successfully");
}
```

### Machine Fingerprint

```rust
let fingerprint = client.get_machine_fingerprint();
```

## Building for Different Targets

```bash
# macOS Apple Silicon
cargo build --release --target aarch64-apple-darwin

# macOS Intel
cargo build --release --target x86_64-apple-darwin

# Windows x64
cargo build --release --target x86_64-pc-windows-msvc

# Windows ARM64
cargo build --release --target aarch64-pc-windows-msvc

# Linux x64
cargo build --release --target x86_64-unknown-linux-gnu

# Linux ARM64
cargo build --release --target aarch64-unknown-linux-gnu
```

## C/C++ Integration

The library can be compiled as a C-compatible shared library:

```bash
cargo build --release --crate-type cdylib
```

This produces `liblicense_client.dylib` (macOS), `license_client.dll` (Windows), or `liblicense_client.so` (Linux).

## Example: GUI Application

```rust
use license_client::{LicenseClient, LicenseClientConfig};
use std::sync::Arc;

struct App {
    license_client: Arc<LicenseClient>,
    license_key: Option<String>,
    is_licensed: bool,
}

impl App {
    fn new() -> Self {
        let client = LicenseClient::new(LicenseClientConfig {
            server_url: "https://license.example.com".to_string(),
            ..Default::default()
        });

        Self {
            license_client: Arc::new(client),
            license_key: None,
            is_licensed: false,
        }
    }

    async fn check_license(&mut self) -> bool {
        if let Some(key) = &self.license_key {
            let result = self.license_client.validate(key).await;
            self.is_licensed = result.valid;
            return result.valid;
        }
        false
    }

    async fn activate(&mut self, key: &str) -> Result<(), String> {
        let result = self.license_client.activate(key, None).await;
        if result.success {
            self.license_key = Some(key.to_string());
            self.is_licensed = true;
            Ok(())
        } else {
            Err(result.error.unwrap_or_else(|| "Unknown error".to_string()))
        }
    }
}
```

## Offline Support

The client automatically handles offline scenarios:

1. **Within TTL**: Uses cached validation (default: 1 hour)
2. **Within Grace Period**: Allows offline use (default: 7 days)
3. **After Grace Period**: Returns invalid until online validation succeeds

## Security Notes

- Machine fingerprint uses hardware identifiers specific to each platform
- License cache stored in system data directory
- Consider code signing for distribution
- Use `strip = true` in release profile to remove debug symbols
