using System.Management;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LicenseClient;

#region Models

public record ValidationResult
{
    [JsonPropertyName("valid")]
    public bool Valid { get; init; }

    [JsonPropertyName("product")]
    public string? Product { get; init; }

    [JsonPropertyName("expiresAt")]
    public string? ExpiresAt { get; init; }

    [JsonPropertyName("features")]
    public string[]? Features { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }

    public bool Cached { get; init; }
}

public record DesktopValidationResult
{
    [JsonPropertyName("valid")]
    public bool Valid { get; init; }

    [JsonPropertyName("product")]
    public string? Product { get; init; }

    [JsonPropertyName("expiresAt")]
    public string? ExpiresAt { get; init; }

    [JsonPropertyName("features")]
    public string[]? Features { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }

    [JsonPropertyName("offlineToken")]
    public string? OfflineToken { get; init; }

    [JsonPropertyName("checkInDays")]
    public int CheckInDays { get; init; }

    [JsonPropertyName("activationId")]
    public string? ActivationId { get; init; }

    public bool Cached { get; init; }
}

public record CheckInResult
{
    [JsonPropertyName("valid")]
    public bool Valid { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }

    [JsonPropertyName("renewedToken")]
    public string? RenewedToken { get; init; }

    [JsonPropertyName("message")]
    public string? Message { get; init; }

    [JsonPropertyName("nextCheckIn")]
    public string? NextCheckIn { get; init; }
}

public record ActivationResult
{
    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }

    [JsonPropertyName("activation")]
    public ActivationInfo? Activation { get; init; }
}

public record ActivationInfo
{
    [JsonPropertyName("machineFingerprint")]
    public string MachineFingerprint { get; init; } = "";

    [JsonPropertyName("activatedAt")]
    public string ActivatedAt { get; init; } = "";
}

public record DeactivationResult
{
    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }
}

public record LicenseInfo
{
    public string LicenseKey { get; init; } = "";
    public string Product { get; init; } = "";
    public string[] Features { get; init; } = Array.Empty<string>();
    public string? ExpiresAt { get; init; }
    public string ValidatedAt { get; init; } = "";
    public string MachineFingerprint { get; init; } = "";
    public string? OfflineToken { get; init; }
    public DateTime? NextCheckIn { get; init; }
}

public enum Platform
{
    Windows,
    MacOS,
    Linux
}

#endregion

#region Configuration

public class LicenseClientConfig
{
    public string ServerUrl { get; init; } = "";
    public string? ProductId { get; init; }
    public string? AppVersion { get; init; }
    public string? CacheDirectory { get; init; }
    public TimeSpan CacheTTL { get; init; } = TimeSpan.FromHours(1);
    public TimeSpan OfflineGracePeriod { get; init; } = TimeSpan.FromDays(7);
    public TimeSpan CheckInInterval { get; init; } = TimeSpan.FromDays(7);
    public bool UseDesktopEndpoints { get; init; } = true;
}

#endregion

#region Client

public class LicenseClient : IDisposable
{
    private readonly LicenseClientConfig _config;
    private readonly string _machineFingerprint;
    private readonly string _cacheDirectory;
    private readonly HttpClient _httpClient;
    private readonly JsonSerializerOptions _jsonOptions;
    private readonly Platform _platform;

    public LicenseClient(LicenseClientConfig config)
    {
        _config = config with
        {
            ServerUrl = config.ServerUrl.TrimEnd('/')
        };

        _machineFingerprint = GenerateMachineFingerprint();
        _platform = DetectPlatform();

        _cacheDirectory = config.CacheDirectory
            ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "LicenseCache"
            );

        Directory.CreateDirectory(_cacheDirectory);

        _httpClient = new HttpClient
        {
            BaseAddress = new Uri(_config.ServerUrl),
            Timeout = TimeSpan.FromSeconds(30)
        };

        _jsonOptions = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        };
    }

    #region Platform Detection

    private static Platform DetectPlatform()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            return Platform.Windows;
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            return Platform.MacOS;
        return Platform.Linux;
    }

    private string GetPlatformString() => _platform switch
    {
        Platform.Windows => "windows",
        Platform.MacOS => "macos",
        Platform.Linux => "linux",
        _ => "windows"
    };

    private string GetOSVersion()
    {
        return RuntimeInformation.OSDescription;
    }

    #endregion

    #region Machine Fingerprint

    private static string GenerateMachineFingerprint()
    {
        var components = new List<string>
        {
            Environment.MachineName,
            Environment.OSVersion.ToString(),
            Environment.ProcessorCount.ToString()
        };

        // Get hardware identifiers on Windows
        if (OperatingSystem.IsWindows())
        {
            try
            {
                // CPU ID
                using var cpuSearcher = new ManagementObjectSearcher("SELECT ProcessorId FROM Win32_Processor");
                foreach (var obj in cpuSearcher.Get())
                {
                    components.Add(obj["ProcessorId"]?.ToString() ?? "");
                    break;
                }

                // Motherboard serial
                using var mbSearcher = new ManagementObjectSearcher("SELECT SerialNumber FROM Win32_BaseBoard");
                foreach (var obj in mbSearcher.Get())
                {
                    components.Add(obj["SerialNumber"]?.ToString() ?? "");
                    break;
                }

                // BIOS serial
                using var biosSearcher = new ManagementObjectSearcher("SELECT SerialNumber FROM Win32_BIOS");
                foreach (var obj in biosSearcher.Get())
                {
                    components.Add(obj["SerialNumber"]?.ToString() ?? "");
                    break;
                }
            }
            catch
            {
                // Fallback to basic identifiers
            }
        }

        var combined = string.Join("|", components.Where(c => !string.IsNullOrEmpty(c)));
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(combined));
        return Convert.ToHexString(hash)[..32].ToLowerInvariant();
    }

    public string GetMachineFingerprint() => _machineFingerprint;

    #endregion

    #region Desktop Validation

    /// <summary>
    /// Validate a desktop license with platform-specific handling.
    /// Returns offline token for grace period operation.
    /// </summary>
    public async Task<DesktopValidationResult> ValidateDesktopAsync(string licenseKey, CancellationToken ct = default)
    {
        // Check cache first
        var cached = GetCachedDesktopValidation(licenseKey);
        if (cached != null)
        {
            return cached with { Cached = true };
        }

        try
        {
            var result = await PerformDesktopValidationAsync(licenseKey, ct);
            if (result.Valid)
            {
                CacheDesktopValidation(licenseKey, result);
            }
            return result;
        }
        catch (Exception ex)
        {
            // Try offline validation
            var offline = ValidateDesktopOffline(licenseKey);
            if (offline != null)
            {
                return offline with { Cached = true };
            }

            return new DesktopValidationResult
            {
                Valid = false,
                Error = $"Network error: {ex.Message}",
                CheckInDays = 0
            };
        }
    }

    private async Task<DesktopValidationResult> PerformDesktopValidationAsync(string licenseKey, CancellationToken ct)
    {
        var request = new
        {
            licenseKey,
            machineFingerprint = _machineFingerprint,
            platform = GetPlatformString(),
            appVersion = _config.AppVersion,
            osVersion = GetOSVersion()
        };

        var response = await _httpClient.PostAsJsonAsync("/api/v1/desktop/validate", request, ct);
        response.EnsureSuccessStatusCode();

        var result = await response.Content.ReadFromJsonAsync<DesktopValidationResult>(_jsonOptions, ct);
        return result ?? new DesktopValidationResult { Valid = false, Error = "Invalid response", CheckInDays = 0 };
    }

    #endregion

    #region Check-In

    /// <summary>
    /// Perform periodic check-in with the license server.
    /// Should be called every CheckInDays to renew the offline token.
    /// </summary>
    public async Task<CheckInResult> CheckInAsync(string licenseKey, CancellationToken ct = default)
    {
        try
        {
            var request = new
            {
                licenseKey,
                machineFingerprint = _machineFingerprint,
                appVersion = _config.AppVersion,
                lastUsed = DateTime.UtcNow.ToString("o")
            };

            var response = await _httpClient.PostAsJsonAsync("/api/v1/desktop/checkin", request, ct);
            response.EnsureSuccessStatusCode();

            var result = await response.Content.ReadFromJsonAsync<CheckInResult>(_jsonOptions, ct);

            if (result?.Valid == true && result.RenewedToken != null)
            {
                // Update cached offline token
                UpdateCachedOfflineToken(licenseKey, result.RenewedToken);
            }

            return result ?? new CheckInResult { Valid = false, Error = "Invalid response" };
        }
        catch (Exception ex)
        {
            return new CheckInResult
            {
                Valid = false,
                Error = $"Network error: {ex.Message}"
            };
        }
    }

    /// <summary>
    /// Check if a check-in is required based on the last check-in time.
    /// </summary>
    public bool IsCheckInRequired(string licenseKey)
    {
        var cached = GetCachedDesktopValidation(licenseKey);
        if (cached == null) return true;

        var lastCheckIn = GetLastCheckInTime(licenseKey);
        if (lastCheckIn == null) return true;

        var daysSinceCheckIn = (DateTime.UtcNow - lastCheckIn.Value).TotalDays;
        return daysSinceCheckIn >= _config.CheckInInterval.TotalDays;
    }

    /// <summary>
    /// Perform check-in if required, otherwise return cached validation.
    /// </summary>
    public async Task<DesktopValidationResult> ValidateWithAutoCheckInAsync(string licenseKey, CancellationToken ct = default)
    {
        if (IsCheckInRequired(licenseKey))
        {
            var checkInResult = await CheckInAsync(licenseKey, ct);
            if (checkInResult.Valid)
            {
                SetLastCheckInTime(licenseKey, DateTime.UtcNow);
            }
        }

        return await ValidateDesktopAsync(licenseKey, ct);
    }

    #endregion

    #region Standard Validation (Web)

    public async Task<ValidationResult> ValidateAsync(string licenseKey, CancellationToken ct = default)
    {
        // Check cache first
        var cached = GetCachedValidation(licenseKey);
        if (cached != null)
        {
            return cached with { Cached = true };
        }

        try
        {
            var result = await PerformValidationAsync(licenseKey, ct);
            if (result.Valid)
            {
                CacheValidation(licenseKey, result);
            }
            return result;
        }
        catch (Exception ex)
        {
            // Try offline validation
            var offline = ValidateOffline(licenseKey);
            if (offline != null)
            {
                return offline with { Cached = true };
            }

            return new ValidationResult
            {
                Valid = false,
                Error = $"Network error: {ex.Message}"
            };
        }
    }

    private async Task<ValidationResult> PerformValidationAsync(string licenseKey, CancellationToken ct)
    {
        var request = new
        {
            licenseKey,
            machineFingerprint = _machineFingerprint,
            productId = _config.ProductId
        };

        var response = await _httpClient.PostAsJsonAsync("/api/v1/validate", request, ct);
        response.EnsureSuccessStatusCode();

        var result = await response.Content.ReadFromJsonAsync<ValidationResult>(_jsonOptions, ct);
        return result ?? new ValidationResult { Valid = false, Error = "Invalid response" };
    }

    #endregion

    #region Activation

    public async Task<ActivationResult> ActivateAsync(
        string licenseKey,
        string? machineName = null,
        CancellationToken ct = default)
    {
        try
        {
            var request = new
            {
                licenseKey,
                machineFingerprint = _machineFingerprint,
                machineName = machineName ?? Environment.MachineName
            };

            var response = await _httpClient.PostAsJsonAsync("/api/v1/activate", request, ct);
            response.EnsureSuccessStatusCode();

            var result = await response.Content.ReadFromJsonAsync<ActivationResult>(_jsonOptions, ct);

            if (result?.Success == true)
            {
                // Validate and cache after activation
                if (_config.UseDesktopEndpoints)
                {
                    await ValidateDesktopAsync(licenseKey, ct);
                }
                else
                {
                    await ValidateAsync(licenseKey, ct);
                }
            }

            return result ?? new ActivationResult { Success = false, Error = "Invalid response" };
        }
        catch (Exception ex)
        {
            return new ActivationResult
            {
                Success = false,
                Error = $"Network error: {ex.Message}"
            };
        }
    }

    #endregion

    #region Deactivation

    public async Task<DeactivationResult> DeactivateAsync(string licenseKey, CancellationToken ct = default)
    {
        try
        {
            var request = new
            {
                licenseKey,
                machineFingerprint = _machineFingerprint
            };

            var response = await _httpClient.PostAsJsonAsync("/api/v1/deactivate", request, ct);
            response.EnsureSuccessStatusCode();

            var result = await response.Content.ReadFromJsonAsync<DeactivationResult>(_jsonOptions, ct);

            if (result?.Success == true)
            {
                ClearCache(licenseKey);
            }

            return result ?? new DeactivationResult { Success = false, Error = "Invalid response" };
        }
        catch (Exception ex)
        {
            return new DeactivationResult
            {
                Success = false,
                Error = $"Network error: {ex.Message}"
            };
        }
    }

    #endregion

    #region Convenience Methods

    public async Task<bool> IsValidAsync(string licenseKey, CancellationToken ct = default)
    {
        if (_config.UseDesktopEndpoints)
        {
            var result = await ValidateDesktopAsync(licenseKey, ct);
            return result.Valid;
        }
        else
        {
            var result = await ValidateAsync(licenseKey, ct);
            return result.Valid;
        }
    }

    public async Task<bool> HasFeatureAsync(string licenseKey, string feature, CancellationToken ct = default)
    {
        if (_config.UseDesktopEndpoints)
        {
            var result = await ValidateDesktopAsync(licenseKey, ct);
            return result.Valid && (result.Features?.Contains(feature) ?? false);
        }
        else
        {
            var result = await ValidateAsync(licenseKey, ct);
            return result.Valid && (result.Features?.Contains(feature) ?? false);
        }
    }

    /// <summary>
    /// Get stored license info from cache.
    /// </summary>
    public LicenseInfo? GetStoredLicenseInfo(string licenseKey)
    {
        var cached = GetCachedDesktopValidation(licenseKey);
        if (cached == null || !cached.Valid)
            return null;

        return new LicenseInfo
        {
            LicenseKey = licenseKey,
            Product = cached.Product ?? "",
            Features = cached.Features ?? Array.Empty<string>(),
            ExpiresAt = cached.ExpiresAt,
            ValidatedAt = DateTime.UtcNow.ToString("o"),
            MachineFingerprint = _machineFingerprint,
            OfflineToken = cached.OfflineToken,
            NextCheckIn = GetLastCheckInTime(licenseKey)?.AddDays(_config.CheckInInterval.TotalDays)
        };
    }

    #endregion

    #region Caching

    private string GetCachePath(string licenseKey)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(licenseKey));
        var hashString = Convert.ToHexString(hash)[..16].ToLowerInvariant();
        return Path.Combine(_cacheDirectory, $"{hashString}.json");
    }

    private string GetDesktopCachePath(string licenseKey)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(licenseKey));
        var hashString = Convert.ToHexString(hash)[..16].ToLowerInvariant();
        return Path.Combine(_cacheDirectory, $"{hashString}_desktop.json");
    }

    private string GetCheckInPath(string licenseKey)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(licenseKey));
        var hashString = Convert.ToHexString(hash)[..16].ToLowerInvariant();
        return Path.Combine(_cacheDirectory, $"{hashString}_checkin.txt");
    }

    private record CacheEntry(long Timestamp, ValidationResult Result);
    private record DesktopCacheEntry(long Timestamp, DesktopValidationResult Result);

    private ValidationResult? GetCachedValidation(string licenseKey)
    {
        var cachePath = GetCachePath(licenseKey);
        if (!File.Exists(cachePath))
            return null;

        try
        {
            var json = File.ReadAllText(cachePath);
            var entry = JsonSerializer.Deserialize<CacheEntry>(json, _jsonOptions);
            if (entry == null)
                return null;

            var cacheAge = TimeSpan.FromMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - entry.Timestamp);

            // Within TTL
            if (cacheAge < _config.CacheTTL)
                return entry.Result;

            // Within grace period
            if (cacheAge < _config.OfflineGracePeriod && entry.Result.Valid)
                return entry.Result;

            return null;
        }
        catch
        {
            return null;
        }
    }

    private DesktopValidationResult? GetCachedDesktopValidation(string licenseKey)
    {
        var cachePath = GetDesktopCachePath(licenseKey);
        if (!File.Exists(cachePath))
            return null;

        try
        {
            var json = File.ReadAllText(cachePath);
            var entry = JsonSerializer.Deserialize<DesktopCacheEntry>(json, _jsonOptions);
            if (entry == null)
                return null;

            var cacheAge = TimeSpan.FromMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - entry.Timestamp);

            // Within TTL
            if (cacheAge < _config.CacheTTL)
                return entry.Result;

            // Within grace period (use offline token)
            if (cacheAge < _config.OfflineGracePeriod && entry.Result.Valid && entry.Result.OfflineToken != null)
                return entry.Result;

            return null;
        }
        catch
        {
            return null;
        }
    }

    private void CacheValidation(string licenseKey, ValidationResult result)
    {
        var cachePath = GetCachePath(licenseKey);
        var entry = new CacheEntry(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), result);
        var json = JsonSerializer.Serialize(entry, _jsonOptions);
        File.WriteAllText(cachePath, json);
    }

    private void CacheDesktopValidation(string licenseKey, DesktopValidationResult result)
    {
        var cachePath = GetDesktopCachePath(licenseKey);
        var entry = new DesktopCacheEntry(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), result);
        var json = JsonSerializer.Serialize(entry, _jsonOptions);
        File.WriteAllText(cachePath, json);
    }

    private void UpdateCachedOfflineToken(string licenseKey, string offlineToken)
    {
        var cached = GetCachedDesktopValidation(licenseKey);
        if (cached != null)
        {
            var updated = cached with { OfflineToken = offlineToken };
            CacheDesktopValidation(licenseKey, updated);
        }
    }

    private DateTime? GetLastCheckInTime(string licenseKey)
    {
        var path = GetCheckInPath(licenseKey);
        if (!File.Exists(path))
            return null;

        try
        {
            var content = File.ReadAllText(path);
            return DateTime.Parse(content);
        }
        catch
        {
            return null;
        }
    }

    private void SetLastCheckInTime(string licenseKey, DateTime time)
    {
        var path = GetCheckInPath(licenseKey);
        File.WriteAllText(path, time.ToString("o"));
    }

    private void ClearCache(string licenseKey)
    {
        var paths = new[]
        {
            GetCachePath(licenseKey),
            GetDesktopCachePath(licenseKey),
            GetCheckInPath(licenseKey)
        };

        foreach (var path in paths)
        {
            if (File.Exists(path))
                File.Delete(path);
        }
    }

    private ValidationResult? ValidateOffline(string licenseKey)
    {
        return GetCachedValidation(licenseKey);
    }

    private DesktopValidationResult? ValidateDesktopOffline(string licenseKey)
    {
        return GetCachedDesktopValidation(licenseKey);
    }

    #endregion

    public void Dispose()
    {
        _httpClient.Dispose();
        GC.SuppressFinalize(this);
    }
}

#endregion

#region Extensions

public static class LicenseClientExtensions
{
    /// <summary>
    /// Check license validity synchronously (blocks the calling thread)
    /// </summary>
    public static ValidationResult Validate(this LicenseClient client, string licenseKey)
    {
        return client.ValidateAsync(licenseKey).GetAwaiter().GetResult();
    }

    /// <summary>
    /// Check desktop license validity synchronously (blocks the calling thread)
    /// </summary>
    public static DesktopValidationResult ValidateDesktop(this LicenseClient client, string licenseKey)
    {
        return client.ValidateDesktopAsync(licenseKey).GetAwaiter().GetResult();
    }

    /// <summary>
    /// Perform check-in synchronously (blocks the calling thread)
    /// </summary>
    public static CheckInResult CheckIn(this LicenseClient client, string licenseKey)
    {
        return client.CheckInAsync(licenseKey).GetAwaiter().GetResult();
    }

    /// <summary>
    /// Activate license synchronously (blocks the calling thread)
    /// </summary>
    public static ActivationResult Activate(this LicenseClient client, string licenseKey, string? machineName = null)
    {
        return client.ActivateAsync(licenseKey, machineName).GetAwaiter().GetResult();
    }

    /// <summary>
    /// Deactivate license synchronously (blocks the calling thread)
    /// </summary>
    public static DeactivationResult Deactivate(this LicenseClient client, string licenseKey)
    {
        return client.DeactivateAsync(licenseKey).GetAwaiter().GetResult();
    }
}

#endregion
