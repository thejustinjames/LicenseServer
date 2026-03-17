# License Client for .NET (Windows)

A .NET library for integrating license validation into Windows applications, supporting both AMD64 and ARM64 architectures.

## Installation

### NuGet Package

```bash
dotnet add package LicenseClient
```

### Manual Installation

```bash
cd clients/csharp
dotnet build -c Release
```

## Quick Start

```csharp
using LicenseClient;

var client = new LicenseClient(new LicenseClientConfig
{
    ServerUrl = "https://your-license-server.com",
    ProductId = "your-product-id"
});

// Validate a license
var result = await client.ValidateAsync("XXXX-XXXX-XXXX-XXXX");
if (result.Valid)
{
    Console.WriteLine($"Licensed for: {result.Product}");
    Console.WriteLine($"Features: {string.Join(", ", result.Features ?? Array.Empty<string>())}");
}
else
{
    Console.WriteLine($"License invalid: {result.Error}");
}
```

## Features

- **Windows AMD64 and ARM64** support
- **Hardware fingerprinting** using CPU, motherboard, and BIOS serials
- **Offline validation** with configurable grace period
- **Async/await API** with sync extensions
- **Automatic caching** with configurable TTL

## API

### Configuration

```csharp
var config = new LicenseClientConfig
{
    ServerUrl = "https://license.example.com",
    ProductId = "optional-product-id",
    CacheDirectory = null,                    // Uses LocalApplicationData by default
    CacheTTL = TimeSpan.FromHours(1),         // Cache validity
    OfflineGracePeriod = TimeSpan.FromDays(7) // Offline grace period
};

var client = new LicenseClient(config);
```

### Validation

```csharp
// Async validation
var result = await client.ValidateAsync("LICENSE-KEY");
// result.Valid, result.Product, result.Features, result.ExpiresAt

// Sync validation (blocks thread)
var result = client.Validate("LICENSE-KEY");

// Quick check
bool isValid = await client.IsValidAsync("LICENSE-KEY");

// Feature check
bool hasPremium = await client.HasFeatureAsync("LICENSE-KEY", "premium");
```

### Activation

```csharp
// Async activation
var result = await client.ActivateAsync(
    "LICENSE-KEY",
    "John's PC"  // Optional machine name
);

if (result.Success)
{
    Console.WriteLine($"Activated at: {result.Activation?.ActivatedAt}");
}
else
{
    Console.WriteLine($"Activation failed: {result.Error}");
}

// Sync activation
var result = client.Activate("LICENSE-KEY");
```

### Deactivation

```csharp
var result = await client.DeactivateAsync("LICENSE-KEY");
if (result.Success)
{
    Console.WriteLine("Deactivated successfully");
}
```

### Machine Fingerprint

```csharp
// Get the unique machine fingerprint
string fingerprint = client.GetMachineFingerprint();
```

## WPF Application Example

```csharp
using System.Windows;
using LicenseClient;

public partial class App : Application
{
    public static LicenseClient.LicenseClient License { get; private set; } = null!;
    public static string? CurrentLicenseKey { get; set; }

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        License = new LicenseClient.LicenseClient(new LicenseClientConfig
        {
            ServerUrl = "https://license.example.com"
        });

        // Check stored license
        var storedKey = Properties.Settings.Default.LicenseKey;
        if (!string.IsNullOrEmpty(storedKey))
        {
            var result = await License.ValidateAsync(storedKey);
            if (result.Valid)
            {
                CurrentLicenseKey = storedKey;
                new MainWindow().Show();
                return;
            }
        }

        // Show license activation window
        new LicenseWindow().Show();
    }
}

public partial class LicenseWindow : Window
{
    private async void ActivateButton_Click(object sender, RoutedEventArgs e)
    {
        var licenseKey = LicenseKeyTextBox.Text.Trim();

        var result = await App.License.ActivateAsync(licenseKey);

        if (result.Success)
        {
            Properties.Settings.Default.LicenseKey = licenseKey;
            Properties.Settings.Default.Save();

            App.CurrentLicenseKey = licenseKey;
            new MainWindow().Show();
            Close();
        }
        else
        {
            MessageBox.Show($"Activation failed: {result.Error}");
        }
    }
}
```

## Console Application Example

```csharp
using LicenseClient;

var client = new LicenseClient.LicenseClient(new LicenseClientConfig
{
    ServerUrl = "https://license.example.com"
});

Console.Write("Enter license key: ");
var licenseKey = Console.ReadLine()?.Trim();

if (string.IsNullOrEmpty(licenseKey))
{
    Console.WriteLine("No license key provided");
    return 1;
}

var result = await client.ActivateAsync(licenseKey);

if (!result.Success)
{
    Console.WriteLine($"Activation failed: {result.Error}");
    return 1;
}

Console.WriteLine("License activated successfully!");
Console.WriteLine($"Machine: {client.GetMachineFingerprint()}");

// Your application logic here...

return 0;
```

## Building for Different Architectures

```bash
# Windows x64
dotnet publish -c Release -r win-x64 --self-contained

# Windows ARM64
dotnet publish -c Release -r win-arm64 --self-contained
```

## Offline Support

The client automatically handles offline scenarios:

1. **Within TTL**: Uses cached validation (default: 1 hour)
2. **Within Grace Period**: Allows offline use (default: 7 days)
3. **After Grace Period**: Returns invalid until online validation succeeds

```csharp
var config = new LicenseClientConfig
{
    ServerUrl = "https://license.example.com",
    CacheTTL = TimeSpan.FromHours(1),        // Refresh hourly when online
    OfflineGracePeriod = TimeSpan.FromDays(30) // Allow 30 days offline
};
```

## Security Notes

- Machine fingerprint uses hardware identifiers (CPU ID, motherboard serial, BIOS serial)
- License cache stored in LocalApplicationData
- Consider code signing for distribution
- Use obfuscation tools for additional protection
