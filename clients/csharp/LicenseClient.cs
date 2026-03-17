using System.Management;
using System.Net.Http.Json;
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
}

#endregion

#region Configuration

public class LicenseClientConfig
{
    public string ServerUrl { get; init; } = "";
    public string? ProductId { get; init; }
    public string? CacheDirectory { get; init; }
    public TimeSpan CacheTTL { get; init; } = TimeSpan.FromHours(1);
    public TimeSpan OfflineGracePeriod { get; init; } = TimeSpan.FromDays(7);
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

    public LicenseClient(LicenseClientConfig config)
    {
        _config = config with
        {
            ServerUrl = config.ServerUrl.TrimEnd('/')
        };

        _machineFingerprint = GenerateMachineFingerprint();

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

    #region Validation

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
                await ValidateAsync(licenseKey, ct);
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
        var result = await ValidateAsync(licenseKey, ct);
        return result.Valid;
    }

    public async Task<bool> HasFeatureAsync(string licenseKey, string feature, CancellationToken ct = default)
    {
        var result = await ValidateAsync(licenseKey, ct);
        return result.Valid && (result.Features?.Contains(feature) ?? false);
    }

    #endregion

    #region Caching

    private string GetCachePath(string licenseKey)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(licenseKey));
        var hashString = Convert.ToHexString(hash)[..16].ToLowerInvariant();
        return Path.Combine(_cacheDirectory, $"{hashString}.json");
    }

    private record CacheEntry(long Timestamp, ValidationResult Result);

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

    private void CacheValidation(string licenseKey, ValidationResult result)
    {
        var cachePath = GetCachePath(licenseKey);
        var entry = new CacheEntry(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), result);
        var json = JsonSerializer.Serialize(entry, _jsonOptions);
        File.WriteAllText(cachePath, json);
    }

    private void ClearCache(string licenseKey)
    {
        var cachePath = GetCachePath(licenseKey);
        if (File.Exists(cachePath))
            File.Delete(cachePath);
    }

    private ValidationResult? ValidateOffline(string licenseKey)
    {
        return GetCachedValidation(licenseKey);
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
