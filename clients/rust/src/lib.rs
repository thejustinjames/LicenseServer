//! License validation client for Rust applications
//!
//! # Example
//!
//! ```no_run
//! use license_client::{LicenseClient, LicenseClientConfig};
//!
//! #[tokio::main]
//! async fn main() {
//!     let client = LicenseClient::new(LicenseClientConfig {
//!         server_url: "https://license.example.com".to_string(),
//!         ..Default::default()
//!     });
//!
//!     let result = client.validate("XXXX-XXXX-XXXX-XXXX").await;
//!     if result.valid {
//!         println!("Licensed for: {}", result.product.unwrap_or_default());
//!     }
//! }
//! ```

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum LicenseError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("License validation failed: {0}")]
    Validation(String),
}

pub type Result<T> = std::result::Result<T, LicenseError>;

// MARK: - Models

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ValidationResult {
    pub valid: bool,
    pub product: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<String>,
    pub features: Option<Vec<String>>,
    pub error: Option<String>,
    #[serde(skip)]
    pub cached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivationResult {
    pub success: bool,
    pub error: Option<String>,
    pub activation: Option<ActivationInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivationInfo {
    #[serde(rename = "machineFingerprint")]
    pub machine_fingerprint: String,
    #[serde(rename = "activatedAt")]
    pub activated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeactivationResult {
    pub success: bool,
    pub error: Option<String>,
}

// MARK: - Configuration

#[derive(Debug, Clone)]
pub struct LicenseClientConfig {
    pub server_url: String,
    pub product_id: Option<String>,
    pub cache_dir: Option<PathBuf>,
    pub cache_ttl: Duration,
    pub offline_grace_period: Duration,
}

impl Default for LicenseClientConfig {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            product_id: None,
            cache_dir: None,
            cache_ttl: Duration::from_secs(3600),
            offline_grace_period: Duration::from_secs(7 * 24 * 3600),
        }
    }
}

// MARK: - Client

pub struct LicenseClient {
    config: LicenseClientConfig,
    machine_fingerprint: String,
    cache_dir: PathBuf,
    http_client: reqwest::Client,
}

#[derive(Serialize, Deserialize)]
struct CacheEntry {
    timestamp: u64,
    result: ValidationResult,
}

impl LicenseClient {
    pub fn new(config: LicenseClientConfig) -> Self {
        let machine_fingerprint = Self::generate_machine_fingerprint();

        let cache_dir = config.cache_dir.clone().unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("license-cache")
        });

        fs::create_dir_all(&cache_dir).ok();

        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            config: LicenseClientConfig {
                server_url: config.server_url.trim_end_matches('/').to_string(),
                ..config
            },
            machine_fingerprint,
            cache_dir,
            http_client,
        }
    }

    // MARK: - Machine Fingerprint

    fn generate_machine_fingerprint() -> String {
        let mut components = Vec::new();

        // Hostname
        if let Ok(hostname) = hostname::get() {
            components.push(hostname.to_string_lossy().to_string());
        }

        // OS info
        components.push(std::env::consts::OS.to_string());
        components.push(std::env::consts::ARCH.to_string());

        // Platform-specific identifiers
        #[cfg(target_os = "windows")]
        {
            if let Some(id) = Self::get_windows_machine_id() {
                components.push(id);
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let Some(id) = Self::get_macos_hardware_uuid() {
                components.push(id);
            }
        }

        #[cfg(target_os = "linux")]
        {
            if let Some(id) = Self::get_linux_machine_id() {
                components.push(id);
            }
        }

        let combined = components.join("|");
        let mut hasher = Sha256::new();
        hasher.update(combined.as_bytes());
        let result = hasher.finalize();
        hex::encode(&result[..16])
    }

    #[cfg(target_os = "windows")]
    fn get_windows_machine_id() -> Option<String> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(key) = hklm.open_subkey("SOFTWARE\\Microsoft\\Cryptography") {
            if let Ok(id) = key.get_value::<String, _>("MachineGuid") {
                return Some(id);
            }
        }
        None
    }

    #[cfg(target_os = "macos")]
    fn get_macos_hardware_uuid() -> Option<String> {
        use std::process::Command;
        let output = Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.contains("IOPlatformUUID") {
                if let Some(uuid) = line.split('"').nth(3) {
                    return Some(uuid.to_string());
                }
            }
        }
        None
    }

    #[cfg(target_os = "linux")]
    fn get_linux_machine_id() -> Option<String> {
        fs::read_to_string("/etc/machine-id")
            .ok()
            .map(|s| s.trim().to_string())
    }

    pub fn get_machine_fingerprint(&self) -> &str {
        &self.machine_fingerprint
    }

    // MARK: - Validation (Async)

    #[cfg(feature = "async")]
    pub async fn validate(&self, license_key: &str) -> ValidationResult {
        // Check cache first
        if let Some(cached) = self.get_cached_validation(license_key) {
            return ValidationResult {
                cached: true,
                ..cached
            };
        }

        match self.perform_validation(license_key).await {
            Ok(result) => {
                if result.valid {
                    self.cache_validation(license_key, &result);
                }
                result
            }
            Err(_) => {
                // Try offline validation
                if let Some(offline) = self.validate_offline(license_key) {
                    return ValidationResult {
                        cached: true,
                        ..offline
                    };
                }

                ValidationResult {
                    valid: false,
                    error: Some("Network error".to_string()),
                    ..Default::default()
                }
            }
        }
    }

    #[cfg(feature = "async")]
    async fn perform_validation(&self, license_key: &str) -> Result<ValidationResult> {
        #[derive(Serialize)]
        struct Request<'a> {
            #[serde(rename = "licenseKey")]
            license_key: &'a str,
            #[serde(rename = "machineFingerprint")]
            machine_fingerprint: &'a str,
            #[serde(rename = "productId", skip_serializing_if = "Option::is_none")]
            product_id: Option<&'a str>,
        }

        let response = self
            .http_client
            .post(format!("{}/api/v1/validate", self.config.server_url))
            .json(&Request {
                license_key,
                machine_fingerprint: &self.machine_fingerprint,
                product_id: self.config.product_id.as_deref(),
            })
            .send()
            .await?;

        // Check HTTP status before parsing JSON
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(LicenseError::Validation(format!(
                "Server returned {}: {}",
                status,
                error_text
            )));
        }

        Ok(response.json().await?)
    }

    // MARK: - Activation (Async)

    #[cfg(feature = "async")]
    pub async fn activate(
        &self,
        license_key: &str,
        machine_name: Option<&str>,
    ) -> ActivationResult {
        #[derive(Serialize)]
        struct Request<'a> {
            #[serde(rename = "licenseKey")]
            license_key: &'a str,
            #[serde(rename = "machineFingerprint")]
            machine_fingerprint: &'a str,
            #[serde(rename = "machineName")]
            machine_name: &'a str,
        }

        // Get machine name - use provided or fall back to hostname
        let default_name = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "Unknown".to_string());
        let name = machine_name.unwrap_or(default_name.as_str());

        match self
            .http_client
            .post(format!("{}/api/v1/activate", self.config.server_url))
            .json(&Request {
                license_key,
                machine_fingerprint: &self.machine_fingerprint,
                machine_name: name,
            })
            .send()
            .await
        {
            Ok(response) => {
                let result: ActivationResult = response.json().await.unwrap_or(ActivationResult {
                    success: false,
                    error: Some("Invalid response".to_string()),
                    activation: None,
                });

                if result.success {
                    // Validate and cache
                    let _ = self.validate(license_key).await;
                }

                result
            }
            Err(e) => ActivationResult {
                success: false,
                error: Some(format!("Network error: {}", e)),
                activation: None,
            },
        }
    }

    // MARK: - Deactivation (Async)

    #[cfg(feature = "async")]
    pub async fn deactivate(&self, license_key: &str) -> DeactivationResult {
        #[derive(Serialize)]
        struct Request<'a> {
            #[serde(rename = "licenseKey")]
            license_key: &'a str,
            #[serde(rename = "machineFingerprint")]
            machine_fingerprint: &'a str,
        }

        match self
            .http_client
            .post(format!("{}/api/v1/deactivate", self.config.server_url))
            .json(&Request {
                license_key,
                machine_fingerprint: &self.machine_fingerprint,
            })
            .send()
            .await
        {
            Ok(response) => {
                let result: DeactivationResult =
                    response.json().await.unwrap_or(DeactivationResult {
                        success: false,
                        error: Some("Invalid response".to_string()),
                    });

                if result.success {
                    self.clear_cache(license_key);
                }

                result
            }
            Err(e) => DeactivationResult {
                success: false,
                error: Some(format!("Network error: {}", e)),
            },
        }
    }

    // MARK: - Blocking API

    #[cfg(feature = "blocking")]
    pub fn validate_blocking(&self, license_key: &str) -> ValidationResult {
        if let Some(cached) = self.get_cached_validation(license_key) {
            return ValidationResult {
                cached: true,
                ..cached
            };
        }

        let client = reqwest::blocking::Client::new();

        #[derive(Serialize)]
        struct Request<'a> {
            #[serde(rename = "licenseKey")]
            license_key: &'a str,
            #[serde(rename = "machineFingerprint")]
            machine_fingerprint: &'a str,
        }

        match client
            .post(format!("{}/api/v1/validate", self.config.server_url))
            .json(&Request {
                license_key,
                machine_fingerprint: &self.machine_fingerprint,
            })
            .send()
        {
            Ok(response) => {
                let result: ValidationResult = response.json().unwrap_or_default();
                if result.valid {
                    self.cache_validation(license_key, &result);
                }
                result
            }
            Err(_) => {
                if let Some(offline) = self.validate_offline(license_key) {
                    return ValidationResult {
                        cached: true,
                        ..offline
                    };
                }
                ValidationResult {
                    valid: false,
                    error: Some("Network error".to_string()),
                    ..Default::default()
                }
            }
        }
    }

    // MARK: - Convenience Methods

    #[cfg(feature = "async")]
    pub async fn is_valid(&self, license_key: &str) -> bool {
        self.validate(license_key).await.valid
    }

    #[cfg(feature = "async")]
    pub async fn has_feature(&self, license_key: &str, feature: &str) -> bool {
        let result = self.validate(license_key).await;
        result.valid && result.features.as_ref().map_or(false, |f| f.contains(&feature.to_string()))
    }

    // MARK: - Caching

    fn get_cache_path(&self, license_key: &str) -> PathBuf {
        let mut hasher = Sha256::new();
        hasher.update(license_key.as_bytes());
        let hash = hex::encode(&hasher.finalize()[..8]);
        self.cache_dir.join(format!("{}.json", hash))
    }

    fn get_cached_validation(&self, license_key: &str) -> Option<ValidationResult> {
        let cache_path = self.get_cache_path(license_key);
        let data = fs::read_to_string(&cache_path).ok()?;
        let entry: CacheEntry = serde_json::from_str(&data).ok()?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_secs();
        let cache_age = Duration::from_secs(now.saturating_sub(entry.timestamp));

        // Within TTL
        if cache_age < self.config.cache_ttl {
            return Some(entry.result);
        }

        // Within grace period
        if cache_age < self.config.offline_grace_period && entry.result.valid {
            return Some(entry.result);
        }

        None
    }

    fn cache_validation(&self, license_key: &str, result: &ValidationResult) {
        let cache_path = self.get_cache_path(license_key);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let entry = CacheEntry {
            timestamp,
            result: result.clone(),
        };

        if let Ok(data) = serde_json::to_string(&entry) {
            let _ = fs::write(cache_path, data);
        }
    }

    fn clear_cache(&self, license_key: &str) {
        let cache_path = self.get_cache_path(license_key);
        let _ = fs::remove_file(cache_path);
    }

    fn validate_offline(&self, license_key: &str) -> Option<ValidationResult> {
        self.get_cached_validation(license_key)
    }
}

// Add hostname crate functionality
mod hostname {
    use std::ffi::OsString;
    use std::io;

    pub fn get() -> io::Result<OsString> {
        #[cfg(unix)]
        {
            use std::ffi::CStr;
            let mut buf = [0i8; 256];
            unsafe {
                if libc::gethostname(buf.as_mut_ptr(), buf.len()) != 0 {
                    return Err(io::Error::last_os_error());
                }
                let cstr = CStr::from_ptr(buf.as_ptr());
                Ok(OsString::from(cstr.to_string_lossy().into_owned()))
            }
        }

        #[cfg(windows)]
        {
            use std::ptr;
            use std::os::windows::ffi::OsStringExt;

            unsafe {
                let mut size: u32 = 0;
                windows_sys::Win32::System::SystemInformation::GetComputerNameExW(
                    windows_sys::Win32::System::SystemInformation::ComputerNameDnsHostname,
                    ptr::null_mut(),
                    &mut size,
                );

                let mut buf = vec![0u16; size as usize];
                windows_sys::Win32::System::SystemInformation::GetComputerNameExW(
                    windows_sys::Win32::System::SystemInformation::ComputerNameDnsHostname,
                    buf.as_mut_ptr(),
                    &mut size,
                );

                buf.truncate(size as usize);
                Ok(OsString::from_wide(&buf))
            }
        }
    }
}
