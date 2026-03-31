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

public struct DesktopValidationResult: Codable, Sendable {
    public let valid: Bool
    public let product: String?
    public let expiresAt: String?
    public let features: [String]?
    public let error: String?
    public let offlineToken: String?
    public let checkInDays: Int
    public let activationId: String?
    public var cached: Bool = false

    enum CodingKeys: String, CodingKey {
        case valid, product, expiresAt, features, error, offlineToken, checkInDays, activationId
    }
}

public struct CheckInResult: Codable, Sendable {
    public let valid: Bool
    public let error: String?
    public let renewedToken: String?
    public let message: String?
    public let nextCheckIn: String?
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
    public let offlineToken: String?
    public let nextCheckIn: Date?
}

public enum Platform: String, Sendable {
    case windows
    case macos
    case linux
}

// MARK: - Configuration

public struct LicenseClientConfig: Sendable {
    public let serverUrl: String
    public let productId: String?
    public let appVersion: String?
    public let cacheDirectory: URL?
    public let cacheTTL: TimeInterval
    public let offlineGracePeriod: TimeInterval
    public let checkInInterval: TimeInterval
    public let useDesktopEndpoints: Bool

    public init(
        serverUrl: String,
        productId: String? = nil,
        appVersion: String? = nil,
        cacheDirectory: URL? = nil,
        cacheTTL: TimeInterval = 3600,
        offlineGracePeriodDays: Int = 7,
        checkInIntervalDays: Int = 7,
        useDesktopEndpoints: Bool = true
    ) {
        self.serverUrl = serverUrl.hasSuffix("/") ? String(serverUrl.dropLast()) : serverUrl
        self.productId = productId
        self.appVersion = appVersion
        self.cacheDirectory = cacheDirectory
        self.cacheTTL = cacheTTL
        self.offlineGracePeriod = TimeInterval(offlineGracePeriodDays * 24 * 3600)
        self.checkInInterval = TimeInterval(checkInIntervalDays * 24 * 3600)
        self.useDesktopEndpoints = useDesktopEndpoints
    }
}

// MARK: - License Client

@available(macOS 12.0, iOS 15.0, *)
public final class LicenseClient: @unchecked Sendable {
    private let config: LicenseClientConfig
    private let machineFingerprint: String
    private let cacheDirectory: URL
    private let session: URLSession
    private let platform: Platform

    public init(config: LicenseClientConfig) {
        self.config = config
        self.machineFingerprint = Self.generateMachineFingerprint()
        self.platform = Self.detectPlatform()

        if let cacheDir = config.cacheDirectory {
            self.cacheDirectory = cacheDir
        } else if let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            self.cacheDirectory = appSupport.appendingPathComponent("LicenseCache", isDirectory: true)
        } else {
            // Fallback to temp directory if application support is unavailable
            self.cacheDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("LicenseCache", isDirectory: true)
        }

        // Create cache directory
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)

        self.session = URLSession(configuration: .default)
    }

    // MARK: - Platform Detection

    private static func detectPlatform() -> Platform {
        #if os(macOS)
        return .macos
        #elseif os(Linux)
        return .linux
        #else
        return .macos
        #endif
    }

    private func getOSVersion() -> String {
        let info = ProcessInfo.processInfo
        let version = info.operatingSystemVersion
        return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
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

    // MARK: - Desktop Validation

    /// Validate a desktop license with platform-specific handling.
    /// Returns offline token for grace period operation.
    public func validateDesktop(licenseKey: String) async -> DesktopValidationResult {
        // Check cache first
        if let cached = getCachedDesktopValidation(licenseKey: licenseKey) {
            var result = cached
            result.cached = true
            return result
        }

        // Online validation
        do {
            let result = try await performDesktopValidation(licenseKey: licenseKey)
            if result.valid {
                cacheDesktopValidation(licenseKey: licenseKey, result: result)
            }
            return result
        } catch {
            // Try offline validation
            if let offline = validateDesktopOffline(licenseKey: licenseKey) {
                var result = offline
                result.cached = true
                return result
            }

            return DesktopValidationResult(
                valid: false,
                product: nil,
                expiresAt: nil,
                features: nil,
                error: "Network error: \(error.localizedDescription)",
                offlineToken: nil,
                checkInDays: 0,
                activationId: nil
            )
        }
    }

    private func performDesktopValidation(licenseKey: String) async throws -> DesktopValidationResult {
        guard let url = URL(string: "\(config.serverUrl)/api/v1/desktop/validate") else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "licenseKey": licenseKey,
            "machineFingerprint": machineFingerprint,
            "platform": platform.rawValue,
            "osVersion": getOSVersion()
        ]

        if let appVersion = config.appVersion {
            body["appVersion"] = appVersion
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)

        // Validate HTTP response status
        if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
            throw URLError(.badServerResponse)
        }

        return try JSONDecoder().decode(DesktopValidationResult.self, from: data)
    }

    // MARK: - Check-In

    /// Perform periodic check-in with the license server.
    /// Should be called every checkInDays to renew the offline token.
    public func checkIn(licenseKey: String) async -> CheckInResult {
        do {
            guard let url = URL(string: "\(config.serverUrl)/api/v1/desktop/checkin") else {
                return CheckInResult(
                    valid: false,
                    error: "Invalid server URL",
                    renewedToken: nil,
                    message: nil,
                    nextCheckIn: nil
                )
            }

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            var body: [String: Any] = [
                "licenseKey": licenseKey,
                "machineFingerprint": machineFingerprint,
                "lastUsed": ISO8601DateFormatter().string(from: Date())
            ]

            if let appVersion = config.appVersion {
                body["appVersion"] = appVersion
            }

            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, response) = try await session.data(for: request)

            // Validate HTTP response status
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                return CheckInResult(
                    valid: false,
                    error: "Server error: \(httpResponse.statusCode)",
                    renewedToken: nil,
                    message: nil,
                    nextCheckIn: nil
                )
            }

            let result = try JSONDecoder().decode(CheckInResult.self, from: data)

            if result.valid, let renewedToken = result.renewedToken {
                updateCachedOfflineToken(licenseKey: licenseKey, offlineToken: renewedToken)
            }

            return result
        } catch {
            return CheckInResult(
                valid: false,
                error: "Network error: \(error.localizedDescription)",
                renewedToken: nil,
                message: nil,
                nextCheckIn: nil
            )
        }
    }

    /// Check if a check-in is required based on the last check-in time.
    public func isCheckInRequired(licenseKey: String) -> Bool {
        guard let lastCheckIn = getLastCheckInTime(licenseKey: licenseKey) else {
            return true
        }

        let daysSinceCheckIn = Date().timeIntervalSince(lastCheckIn) / (24 * 3600)
        return daysSinceCheckIn >= config.checkInInterval / (24 * 3600)
    }

    /// Perform check-in if required, otherwise return cached validation.
    public func validateWithAutoCheckIn(licenseKey: String) async -> DesktopValidationResult {
        if isCheckInRequired(licenseKey: licenseKey) {
            let checkInResult = await checkIn(licenseKey: licenseKey)
            if checkInResult.valid {
                setLastCheckInTime(licenseKey: licenseKey, time: Date())
            }
        }

        return await validateDesktop(licenseKey: licenseKey)
    }

    // MARK: - Standard Validation (Web)

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
        guard let url = URL(string: "\(config.serverUrl)/api/v1/validate") else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
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

        let (data, response) = try await session.data(for: request)

        // Validate HTTP response status
        if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
            throw URLError(.badServerResponse)
        }

        return try JSONDecoder().decode(ValidationResult.self, from: data)
    }

    // MARK: - Activation

    public func activate(licenseKey: String, machineName: String? = nil) async -> ActivationResult {
        do {
            guard let url = URL(string: "\(config.serverUrl)/api/v1/activate") else {
                return ActivationResult(
                    success: false,
                    error: "Invalid server URL",
                    activation: nil
                )
            }

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            let body: [String: Any] = [
                "licenseKey": licenseKey,
                "machineFingerprint": machineFingerprint,
                "machineName": machineName ?? Host.current().localizedName ?? "Mac"
            ]

            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, response) = try await session.data(for: request)

            // Validate HTTP response status
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                return ActivationResult(
                    success: false,
                    error: "Server error: \(httpResponse.statusCode)",
                    activation: nil
                )
            }

            let result = try JSONDecoder().decode(ActivationResult.self, from: data)

            if result.success {
                // Cache validation after activation
                if config.useDesktopEndpoints {
                    _ = await validateDesktop(licenseKey: licenseKey)
                } else {
                    _ = await validate(licenseKey: licenseKey)
                }
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
            guard let url = URL(string: "\(config.serverUrl)/api/v1/deactivate") else {
                return (false, "Invalid server URL")
            }

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            let body: [String: Any] = [
                "licenseKey": licenseKey,
                "machineFingerprint": machineFingerprint
            ]

            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, response) = try await session.data(for: request)

            // Validate HTTP response status
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                return (false, "Server error: \(httpResponse.statusCode)")
            }

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
        if config.useDesktopEndpoints {
            let result = await validateDesktop(licenseKey: licenseKey)
            return result.valid
        } else {
            let result = await validate(licenseKey: licenseKey)
            return result.valid
        }
    }

    public func hasFeature(licenseKey: String, feature: String) async -> Bool {
        if config.useDesktopEndpoints {
            let result = await validateDesktop(licenseKey: licenseKey)
            return result.valid && (result.features?.contains(feature) ?? false)
        } else {
            let result = await validate(licenseKey: licenseKey)
            return result.valid && (result.features?.contains(feature) ?? false)
        }
    }

    /// Get stored license info from cache.
    public func getStoredLicenseInfo(licenseKey: String) -> LicenseInfo? {
        guard let cached = getCachedDesktopValidation(licenseKey: licenseKey),
              cached.valid else {
            return nil
        }

        let nextCheckIn = getLastCheckInTime(licenseKey: licenseKey)?
            .addingTimeInterval(config.checkInInterval)

        return LicenseInfo(
            licenseKey: licenseKey,
            product: cached.product ?? "",
            features: cached.features ?? [],
            expiresAt: cached.expiresAt,
            validatedAt: ISO8601DateFormatter().string(from: Date()),
            machineFingerprint: machineFingerprint,
            offlineToken: cached.offlineToken,
            nextCheckIn: nextCheckIn
        )
    }

    // MARK: - Caching

    private func getCachePath(licenseKey: String) -> URL {
        let hash = SHA256.hash(data: Data(licenseKey.utf8))
        let hashString = hash.prefix(8).map { String(format: "%02x", $0) }.joined()
        return cacheDirectory.appendingPathComponent("\(hashString).json")
    }

    private func getDesktopCachePath(licenseKey: String) -> URL {
        let hash = SHA256.hash(data: Data(licenseKey.utf8))
        let hashString = hash.prefix(8).map { String(format: "%02x", $0) }.joined()
        return cacheDirectory.appendingPathComponent("\(hashString)_desktop.json")
    }

    private func getCheckInPath(licenseKey: String) -> URL {
        let hash = SHA256.hash(data: Data(licenseKey.utf8))
        let hashString = hash.prefix(8).map { String(format: "%02x", $0) }.joined()
        return cacheDirectory.appendingPathComponent("\(hashString)_checkin.txt")
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

    private func getCachedDesktopValidation(licenseKey: String) -> DesktopValidationResult? {
        let cachePath = getDesktopCachePath(licenseKey: licenseKey)

        guard FileManager.default.fileExists(atPath: cachePath.path),
              let data = try? Data(contentsOf: cachePath) else {
            return nil
        }

        struct CacheEntry: Codable {
            let timestamp: TimeInterval
            let result: DesktopValidationResult
        }

        guard let entry = try? JSONDecoder().decode(CacheEntry.self, from: data) else {
            return nil
        }

        let cacheAge = Date().timeIntervalSince1970 - entry.timestamp

        // Within TTL
        if cacheAge < config.cacheTTL {
            return entry.result
        }

        // Within grace period (use offline token)
        if cacheAge < config.offlineGracePeriod && entry.result.valid && entry.result.offlineToken != nil {
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

    private func cacheDesktopValidation(licenseKey: String, result: DesktopValidationResult) {
        let cachePath = getDesktopCachePath(licenseKey: licenseKey)

        struct CacheEntry: Codable {
            let timestamp: TimeInterval
            let result: DesktopValidationResult
        }

        let entry = CacheEntry(
            timestamp: Date().timeIntervalSince1970,
            result: result
        )

        if let data = try? JSONEncoder().encode(entry) {
            try? data.write(to: cachePath)
        }
    }

    private func updateCachedOfflineToken(licenseKey: String, offlineToken: String) {
        guard let cached = getCachedDesktopValidation(licenseKey: licenseKey) else { return }

        // Create updated result with new token
        let updated = DesktopValidationResult(
            valid: cached.valid,
            product: cached.product,
            expiresAt: cached.expiresAt,
            features: cached.features,
            error: cached.error,
            offlineToken: offlineToken,
            checkInDays: cached.checkInDays,
            activationId: cached.activationId,
            cached: cached.cached
        )

        cacheDesktopValidation(licenseKey: licenseKey, result: updated)
    }

    private func getLastCheckInTime(licenseKey: String) -> Date? {
        let path = getCheckInPath(licenseKey: licenseKey)

        guard FileManager.default.fileExists(atPath: path.path),
              let content = try? String(contentsOf: path, encoding: .utf8) else {
            return nil
        }

        return ISO8601DateFormatter().date(from: content)
    }

    private func setLastCheckInTime(licenseKey: String, time: Date) {
        let path = getCheckInPath(licenseKey: licenseKey)
        let content = ISO8601DateFormatter().string(from: time)
        try? content.write(to: path, atomically: true, encoding: .utf8)
    }

    private func clearCache(licenseKey: String) {
        let paths = [
            getCachePath(licenseKey: licenseKey),
            getDesktopCachePath(licenseKey: licenseKey),
            getCheckInPath(licenseKey: licenseKey)
        ]

        for path in paths {
            try? FileManager.default.removeItem(at: path)
        }
    }

    private func validateOffline(licenseKey: String) -> ValidationResult? {
        return getCachedValidation(licenseKey: licenseKey)
    }

    private func validateDesktopOffline(licenseKey: String) -> DesktopValidationResult? {
        return getCachedDesktopValidation(licenseKey: licenseKey)
    }
}
