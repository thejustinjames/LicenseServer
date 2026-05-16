# Software Releases Management

The License Server includes a release management system that enables update notifications for K8 Inspector, SILO, and other Agencio products. This document covers the admin UI, API endpoints, and database schema.

## Overview

The releases system allows administrators to:
- Create and manage software releases for multiple products
- Set active releases that clients check against
- Include release notes, download URLs, and version requirements
- Flag critical security updates for urgent notifications

## Admin UI

Access the Releases section from the admin sidebar at `/admin.html`.

### Features

- **Product Filter**: Filter releases by product (K8 Inspector, SILO, Agencio Predict)
- **Active Only**: Toggle to show only current active releases
- **Create Release**: Add new releases with version info, release notes, and metadata
- **Edit/Delete**: Modify or remove existing releases
- **Activate**: Set a release as the current active version for its product

### Release Fields

| Field | Description | Required |
|-------|-------------|----------|
| Product | Product identifier (e.g., `k8inspector`, `silo`) | Yes |
| Version | Semantic version (e.g., `2.0.1`) | Yes |
| Release Date | When the release was published | Yes |
| Minimum Version | Minimum version required to upgrade | No |
| Download URL | Link to download the release | No |
| Release Notes | Markdown-formatted changelog | No |
| Critical | Flag for security updates | No |
| Active | Whether this is the current release | No |

## API Endpoints

### Public Endpoints (Rate Limited)

These endpoints are used by K8 Inspector and other products to check for updates.

#### GET /api/updates/check
Quick version check returning the latest version.

**Query Parameters:**
- `product` - Product slug (default: `k8inspector`)

**Response:**
```json
{
  "latestVersion": "2.0.1",
  "releaseDate": "2026-05-16",
  "downloadUrl": "https://agencio.app/downloads",
  "critical": false
}
```

#### POST /api/updates/check
Full version check with comparison.

**Request Body:**
```json
{
  "currentVersion": "2.0.0",
  "licenseKey": "optional-license-key",
  "deploymentMethod": "kubernetes",
  "platform": "linux"
}
```

**Response:**
```json
{
  "success": true,
  "currentVersion": "2.0.0",
  "latestVersion": "2.0.1",
  "updateAvailable": true,
  "isOutdated": false,
  "critical": false,
  "releaseDate": "2026-05-16",
  "releaseNotes": "## What's New\n...",
  "downloadUrl": "https://agencio.app/downloads",
  "upgradeInstructions": {
    "title": "Kubernetes Upgrade",
    "steps": ["..."],
    "command": "kubectl set image ..."
  }
}
```

#### GET /api/updates/latest
Get full release information.

#### GET /api/updates/changelog
Get release notes for the current version.

#### GET /api/updates/history
Get release history for a product.

**Query Parameters:**
- `product` - Product slug (default: `k8inspector`)
- `limit` - Number of releases to return (default: 10, max: 50)

### Admin Endpoints (Authenticated)

All admin endpoints require authentication and admin privileges.

#### GET /api/admin/releases
List all releases.

**Query Parameters:**
- `productSlug` - Filter by product
- `activeOnly` - Only return active releases (`true`/`false`)

#### GET /api/admin/releases/products
Get list of known product slugs.

#### GET /api/admin/releases/:id
Get a specific release by ID.

#### POST /api/admin/releases
Create a new release.

**Request Body:**
```json
{
  "productSlug": "k8inspector",
  "version": "2.0.2",
  "releaseDate": "2026-05-17T12:00:00Z",
  "releaseNotes": "## Bug Fixes\n- Fixed issue X",
  "downloadUrl": "https://agencio.app/downloads",
  "minVersion": "1.0.0",
  "isCritical": false,
  "isActive": true
}
```

#### PUT /api/admin/releases/:id
Update an existing release.

#### DELETE /api/admin/releases/:id
Delete a release.

#### POST /api/admin/releases/:id/activate
Set a release as the active release for its product. This deactivates any other active releases for the same product.

## Database Schema

```sql
CREATE TABLE releases (
  id            TEXT PRIMARY KEY,
  product_slug  TEXT NOT NULL,
  version       TEXT NOT NULL,
  release_date  TIMESTAMP NOT NULL,
  release_notes TEXT,
  download_url  TEXT,
  min_version   TEXT,
  is_critical   BOOLEAN DEFAULT false,
  is_active     BOOLEAN DEFAULT true,
  created_by    TEXT,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP,

  UNIQUE(product_slug, version)
);

CREATE INDEX idx_releases_product ON releases(product_slug);
CREATE INDEX idx_releases_active ON releases(is_active);
```

## Product Slugs

| Slug | Product |
|------|---------|
| `k8inspector` | K8 Inspector |
| `silo` | SILO Security Suite |
| `agencio-predict` | Agencio Predict |

## Workflow

### Creating a New Release

1. Navigate to **Releases** in the admin sidebar
2. Click **+ New Release**
3. Select the product and enter the version number
4. Set the release date and optionally the minimum version requirement
5. Add release notes in Markdown format
6. Enter the download URL
7. Check **Critical Security Update** if this is a security fix
8. Check **Set as Active Release** to make this the current version
9. Click **Save Release**

### Updating K8 Inspector Version

When releasing a new version of K8 Inspector:

1. Build and distribute the new version
2. Create a new release in the License Server admin UI
3. Set it as the active release
4. Users running K8 Inspector will see the update notification

## Integration

K8 Inspector checks for updates using the `updateCheckerService.js`:

```javascript
// Default update server URL
const UPDATE_SERVER_URL = process.env.UPDATE_SERVER_URL
  || 'https://licensing.agencio.cloud/api/updates/check';

// Checks run every 6 hours
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
```

Users can disable update checks:
```bash
DISABLE_UPDATE_CHECK=true
```

## See Also

- [K8 Inspector License Integration](../k8inspector/docs/LICENSESERVER_INTEGRATION.md)
- [Deployment Guide](./DEPLOYMENT.md)
