# License Client for Node.js / Vite

A TypeScript client library for integrating license validation into Node.js, Vite, and Electron applications.

## Installation

```bash
npm install @license-server/client
```

## Quick Start

```typescript
import { LicenseClient } from '@license-server/client';

const client = new LicenseClient({
  serverUrl: 'https://your-license-server.com',
  productId: 'your-product-id', // optional
});

// Validate a license
const result = await client.validate('XXXX-XXXX-XXXX-XXXX');
if (result.valid) {
  console.log(`Licensed for: ${result.product}`);
  console.log(`Features: ${result.features?.join(', ')}`);
} else {
  console.error(`License invalid: ${result.error}`);
}
```

## Features

- **Online validation** with automatic caching
- **Offline grace period** for network outages
- **Machine fingerprinting** for activation limits
- **Express middleware** for server-side validation
- **Vite plugin** for build-time validation

## API

### LicenseClient

```typescript
const client = new LicenseClient({
  serverUrl: 'https://license.example.com',
  productId: 'optional-product-id',
  cacheDir: '~/.license-cache',      // Cache location
  cacheTTL: 3600,                     // Cache validity (seconds)
  offlineGracePeriod: 7,              // Offline grace period (days)
});
```

#### Methods

```typescript
// Validate license
const result = await client.validate('LICENSE-KEY');

// Activate on this machine
const activation = await client.activate('LICENSE-KEY', 'My Computer');

// Deactivate from this machine
const deactivation = await client.deactivate('LICENSE-KEY');

// Quick check
const isValid = await client.isValid('LICENSE-KEY');

// Feature check
const hasFeature = await client.hasFeature('LICENSE-KEY', 'premium');

// Get machine fingerprint
const fingerprint = client.getMachineFingerprint();

// Get cached license info
const info = client.getCachedLicense('LICENSE-KEY');
```

## Express Middleware

```typescript
import express from 'express';
import { LicenseClient, licenseMiddleware } from '@license-server/client';

const app = express();
const client = new LicenseClient({ serverUrl: 'https://license.example.com' });

// Protect all routes
app.use(licenseMiddleware(client));

// Or specific routes with required features
app.use('/api/premium', licenseMiddleware(client, {
  requiredFeatures: ['premium'],
  licenseHeader: 'X-License-Key',
}));

app.get('/api/data', (req, res) => {
  // Access license info via req.license
  res.json({ product: req.license.product });
});
```

## Vite Plugin

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { LicenseClient, viteLicensePlugin } from '@license-server/client';

const client = new LicenseClient({
  serverUrl: 'https://license.example.com',
});

export default defineConfig({
  plugins: [
    viteLicensePlugin('YOUR-LICENSE-KEY', client, {
      requiredFeatures: ['build'],
    }),
  ],
});
```

## Electron Integration

```typescript
// main.ts
import { app } from 'electron';
import { LicenseClient } from '@license-server/client';

const client = new LicenseClient({
  serverUrl: 'https://license.example.com',
  cacheDir: app.getPath('userData') + '/licenses',
});

app.whenReady().then(async () => {
  const result = await client.validate(storedLicenseKey);

  if (!result.valid) {
    // Show license activation dialog
  }
});
```

## Offline Support

The client automatically caches successful validations. When offline:

1. Uses cached validation if within `cacheTTL` (default: 1 hour)
2. Falls back to grace period if within `offlineGracePeriod` (default: 7 days)
3. Returns invalid after grace period expires

```typescript
const client = new LicenseClient({
  serverUrl: 'https://license.example.com',
  cacheTTL: 3600,           // Refresh every hour when online
  offlineGracePeriod: 30,   // Allow 30 days offline
});
```
