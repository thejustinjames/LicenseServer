import Foundation
import CryptoKit
import IOKit

// MARK: - Models

public struct ValidationResult: Codable, Sendable {
    public let valid: Bool
    public let product: String?
    public let expiresAt: String?
    public let features: [String]?
    public let error: String?
    public var cached: Bool = false

    enum CodingKeys: String, CodingKey {
        case valid, product, expiresAt, features, error
    }
}

public struct ActivationResult: Codable, Sendable {
    public let success: Bool
    public let error: String?
    public let activation: ActivationInfo?
}

public struct ActivationInfo: Codable, Sendable {
    public let machineFingerprint: String
    public let activatedAt: String
}

public struct LicenseInfo: Codable, Sendable {
    public let licenseKey: String
    public let product: String
    public let features: [String]
    public let expiresAt: String?
    public let validatedAt: String
    public let machineFingerprint: String
}

// MARK: - Configuration

public struct LicenseClientConfig: Sendable {
    public let serverUrl: String
    public let productId: String?
    public let cacheDirectory: URL?
    public let cacheTTL: TimeInterval
    public let offlineGracePeriod: TimeInterval

    public init(
        serverUrl: String,
        productId: String? = nil,
        cacheDirectory: URL? = nil,
        cacheTTL: TimeInterval = 3600,
        offlineGracePeriodDays: Int = 7
    ) {
        self.serverUrl = serverUrl.hasSuffix("/") ? String(serverUrl.dropLast()) : serverUrl
        self.productId = productId
        self.cacheDirectory = cacheDirectory
        self.cacheTTL = cacheTTL
        self.offlineGracePeriod = TimeInterval(offlineGracePeriodDays * 24 * 3600)
    }
}

// MARK: - License Client

@available(macOS 12.0, iOS 15.0, *)
public final class LicenseClient: @unchecked Sendable {
    private let config: LicenseClientConfig
    private let machineFingerprint: String
    private let cacheDirectory: URL
    private let session: URLSession

    public init(config: LicenseClientConfig) {
        self.config = config
        self.machineFingerprint = Self.generateMachineFingerprint()

        if let cacheDir = config.cacheDirectory {
            self.cacheDirectory = cacheDir
        } else {
            let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            self.cacheDirectory = appSupport.appendingPathComponent("LicenseCache", isDirectory: true)
        }

        // Create cache directory
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)

        self.session = URLSession(configuration: .default)
    }

    // MARK: - Machine Fingerprint

    private static func generateMachineFingerprint() -> String {
        var components: [String] = []

        // Get hardware UUID
        if let uuid = getHardwareUUID() {
            components.append(uuid)
        }

        // Get model identifier
        components.append(getModelIdentifier())

        // Get serial number (if available)
        if let serial = getSerialNumber() {
            components.append(serial)
        }

        let combined = components.joined(separator: "|")
        let hash = SHA256.hash(data: Data(combined.utf8))
        return hash.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    private static func getHardwareUUID() -> String? {
        let platformExpert = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPlatformExpertDevice")
        )

        guard platformExpert != 0 else { return nil }
        defer { IOObjectRelease(platformExpert) }

        if let uuid = IORegistryEntryCreateCFProperty(
            platformExpert,
            "IOPlatformUUID" as CFString,
            kCFAllocatorDefault,
            0
        )?.takeRetainedValue() as? String {
            return uuid
        }

        return nil
    }

    private static func getModelIdentifier() -> String {
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        var model = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.model", &model, &size, nil, 0)
        return String(cString: model)
    }

    private static func getSerialNumber() -> String? {
        let platformExpert = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPlatformExpertDevice")
        )

        guard platformExpert != 0 else { return nil }
        defer { IOObjectRelease(platformExpert) }

        if let serial = IORegistryEntryCreateCFProperty(
            platformExpert,
            kIOPlatformSerialNumberKey as CFString,
            kCFAllocatorDefault,
            0
        )?.takeRetainedValue() as? String {
            return serial
        }

        return nil
    }

    public func getMachineFingerprint() -> String {
        return machineFingerprint
    }

    // MARK: - Validation

    public func validate(licenseKey: String) async -> ValidationResult {
        // Check cache first
        if let cached = getCachedValidation(licenseKey: licenseKey) {
            var result = cached
            result.cached = true
            return result
        }

        // Online validation
        do {
            let result = try await performValidation(licenseKey: licenseKey)
            if result.valid {
                cacheValidation(licenseKey: licenseKey, result: result)
            }
            return result
        } catch {
            // Try offline validation
            if let offline = validateOffline(licenseKey: licenseKey) {
                var result = offline
                result.cached = true
                return result
            }

            return ValidationResult(
                valid: false,
                product: nil,
                expiresAt: nil,
                features: nil,
                error: "Network error: \(error.localizedDescription)"
            )
        }
    }

    private func performValidation(licenseKey: String) async throws -> ValidationResult {
        var request = URLRequest(url: URL(string: "\(config.serverUrl)/api/v1/validate")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "licenseKey": licenseKey,
            "machineFingerprint": machineFingerprint
        ]

        if let productId = config.productId {
            body["productId"] = productId
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, _) = try await session.data(for: request)
        return try JSONDecoder().decode(ValidationResult.self, from: data)
    }

    // MARK: - Activation

    public func activate(licenseKey: String, machineName: String? = nil) async -> ActivationResult {
        do {
            var request = URLRequest(url: URL(string: "\(config.serverUrl)/api/v1/activate")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            let body: [String: Any] = [
                "licenseKey": licenseKey,
                "machineFingerprint": machineFingerprint,
                "machineName": machineName ?? Host.current().localizedName ?? "Mac"
            ]

            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, _) = try await session.data(for: request)
            let result = try JSONDecoder().decode(ActivationResult.self, from: data)

            if result.success {
                // Cache validation after activation
                _ = await validate(licenseKey: licenseKey)
            }

            return result
        } catch {
            return ActivationResult(
                success: false,
                error: "Network error: \(error.localizedDescription)",
                activation: nil
            )
        }
    }

    // MARK: - Deactivation

    public func deactivate(licenseKey: String) async -> (success: Bool, error: String?) {
        do {
            var request = URLRequest(url: URL(string: "\(config.serverUrl)/api/v1/deactivate")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            let body: [String: Any] = [
                "licenseKey": licenseKey,
                "machineFingerprint": machineFingerprint
            ]

            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, _) = try await session.data(for: request)

            struct Response: Codable {
                let success: Bool
                let error: String?
            }

            let result = try JSONDecoder().decode(Response.self, from: data)

            if result.success {
                clearCache(licenseKey: licenseKey)
            }

            return (result.success, result.error)
        } catch {
            return (false, "Network error: \(error.localizedDescription)")
        }
    }

    // MARK: - Convenience Methods

    public func isValid(licenseKey: String) async -> Bool {
        let result = await validate(licenseKey: licenseKey)
        return result.valid
    }

    public func hasFeature(licenseKey: String, feature: String) async -> Bool {
        let result = await validate(licenseKey: licenseKey)
        return result.valid && (result.features?.contains(feature) ?? false)
    }

    // MARK: - Caching

    private func getCachePath(licenseKey: String) -> URL {
        let hash = SHA256.hash(data: Data(licenseKey.utf8))
        let hashString = hash.prefix(8).map { String(format: "%02x", $0) }.joined()
        return cacheDirectory.appendingPathComponent("\(hashString).json")
    }

    private func getCachedValidation(licenseKey: String) -> ValidationResult? {
        let cachePath = getCachePath(licenseKey: licenseKey)

        guard FileManager.default.fileExists(atPath: cachePath.path),
              let data = try? Data(contentsOf: cachePath) else {
            return nil
        }

        struct CacheEntry: Codable {
            let timestamp: TimeInterval
            let result: ValidationResult
        }

        guard let entry = try? JSONDecoder().decode(CacheEntry.self, from: data) else {
            return nil
        }

        let cacheAge = Date().timeIntervalSince1970 - entry.timestamp

        // Within TTL
        if cacheAge < config.cacheTTL {
            return entry.result
        }

        // Within grace period
        if cacheAge < config.offlineGracePeriod && entry.result.valid {
            return entry.result
        }

        return nil
    }

    private func cacheValidation(licenseKey: String, result: ValidationResult) {
        let cachePath = getCachePath(licenseKey: licenseKey)

        struct CacheEntry: Codable {
            let timestamp: TimeInterval
            let result: ValidationResult
        }

        let entry = CacheEntry(
            timestamp: Date().timeIntervalSince1970,
            result: result
        )

        if let data = try? JSONEncoder().encode(entry) {
            try? data.write(to: cachePath)
        }
    }

    private func clearCache(licenseKey: String) {
        let cachePath = getCachePath(licenseKey: licenseKey)
        try? FileManager.default.removeItem(at: cachePath)
    }

    private func validateOffline(licenseKey: String) -> ValidationResult? {
        return getCachedValidation(licenseKey: licenseKey)
    }
}
