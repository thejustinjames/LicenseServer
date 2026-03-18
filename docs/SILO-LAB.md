# Silo-Lab Deployment

Local development deployment of the License Server integrated with the silo-lab infrastructure.

## Access URLs

| Service | URL |
|---------|-----|
| **Frontend** | https://licencing.agencio.cloud |
| **Admin Panel** | https://licencing.agencio.cloud/admin.html |
| **API** | https://licencing.agencio.cloud/api/ |
| **Health Check** | https://licencing.agencio.cloud/health |

## Credentials

### Admin User

| Field | Value |
|-------|-------|
| Email | `admin@agencio.cloud` |
| Password | `Admin123!@#xyz` |

## Architecture

```
Internet/Local Machine
        |
        v
    silo-dns (172.30.0.2:53) - port 10053 on localhost
    - licencing.agencio.cloud -> 172.30.0.5 (nginx)
        |
        v
    silo-nginx (172.30.0.5:443)
    - SSL termination (self-signed cert)
    - Reverse proxy to license-server
        |
        v
    license-server (172.30.0.50:3000)
    - Node.js/Express API
    - Frontend SPA
        |
        +---> license_server_db (5433) - PostgreSQL
        +---> silo-storage (172.30.0.12:9000) - S3/MinIO for downloads
```

## Docker Containers

| Container | IP | Port | Purpose |
|-----------|----|----- |---------|
| license-server | 172.30.0.50 | 3000 | Main application |
| license_server_db | - | 5433 | PostgreSQL database |
| silo-nginx | 172.30.0.5 | 443 | SSL reverse proxy |
| silo-dns | 172.30.0.2 | 10053 | DNS resolution |
| silo-storage | 172.30.0.12 | 9000 | S3-compatible storage |

## Management Commands

### Start Services

```bash
# Start license server stack
docker compose -f docker-compose.silo.yml up -d

# Check status
docker ps | grep license
```

### View Logs

```bash
docker logs -f license-server
```

### Database Access

```bash
# Connect to PostgreSQL
docker exec -it license_server_db psql -U postgres -d license_server

# Or from host
psql -h localhost -p 5433 -U postgres -d license_server
```

### Seed k8inspector Products

```bash
docker exec license-server npm run seed:k8inspector
```

### Create Admin User

```bash
# Register user via API
curl -X POST 'http://localhost:3000/api/portal/auth/register' \
  -H 'Content-Type: application/json' \
  -d '{"email": "admin@agencio.cloud", "password": "Admin123!@#xyz", "name": "Admin"}'

# Promote to admin
docker exec license-server npx prisma db execute \
  --stdin <<< "UPDATE customers SET is_admin = true WHERE email = 'admin@agencio.cloud';"
```

## SSL Certificate

The silo-lab uses a self-signed certificate. To trust it on macOS:

```bash
# Extract certificate
docker exec silo-nginx cat /etc/nginx/certs/silo-lab.crt > /tmp/silo-lab.crt

# Add to Keychain (requires sudo)
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/silo-lab.crt
```

## DNS Configuration

### macOS Resolver

To resolve `licencing.agencio.cloud` locally:

```bash
sudo mkdir -p /etc/resolver
echo -e "nameserver 127.0.0.1\nport 10053" | sudo tee /etc/resolver/agencio.cloud
```

### Test DNS

```bash
dig @localhost -p 10053 licencing.agencio.cloud
# Expected: 172.30.0.5
```

## Products

### k8inspector (5 products)

| Product | Monthly | Annual | Type |
|---------|---------|--------|------|
| Free Edition | $0 | - | Subscription (30-day renewal) |
| Professional | $79 | $790 | Subscription |
| Enterprise | $199 | $1,990 | Subscription |
| Enterprise Custom | POA | - | One-time (contact sales) |
| Enterprise Source | POA | - | One-time (contact sales) |

### SILO (9 products)

| Product | Price | Type |
|---------|-------|------|
| SILO Home - Windows | $99 one-time | One-time (1 year license) |
| SILO Home - macOS | $99 one-time | One-time (1 year license) |
| SILO Business | $199/mo or $1,990/yr | Subscription |
| SILO Enterprise | $499/mo or $4,990/yr | Subscription |
| Enterprise Pack - 5 Licenses | $22,500/yr | Subscription |
| Enterprise Pack - 10 Licenses | $40,000/yr | Subscription |
| Enterprise Pack - 20 Licenses | $70,000/yr | Subscription |
| Enterprise Pack - 50 Licenses | $150,000/yr | Subscription |
| SILO Enterprise Custom | POA | One-time (contact sales) |

### SILO Add-ons (2 products)

| Product | Monthly | Annual | Type |
|---------|---------|--------|------|
| SILO k8inspector Integration | $49 | $490 | Subscription |
| SILO Docker Monitor | $29 | $290 | Subscription |

## API Endpoints

### Public

- `GET /health` - Health check
- `POST /api/v1/validate` - Validate license key
- `POST /api/v1/activate` - Activate license
- `POST /api/v1/deactivate` - Deactivate license

### Portal (Customer)

- `POST /api/portal/auth/register` - Register
- `POST /api/portal/auth/login` - Login
- `GET /api/portal/products` - List products
- `GET /api/portal/licenses` - Customer licenses

### Admin

- `GET /api/admin/customers` - List customers
- `GET /api/admin/licenses` - List all licenses
- `POST /api/admin/licenses` - Create license
- `GET /api/admin/products` - List products
- `POST /api/admin/products` - Create product
- `POST /api/admin/products/:id/upload` - Upload bundle file
- `GET /api/admin/products/:id/bundles` - List product bundles
- `PUT /api/admin/products/:id/bundle` - Set active bundle
- `DELETE /api/admin/products/:id/bundles/:key` - Delete bundle file

## Troubleshooting

### License Server Not Starting

```bash
# Check logs
docker logs license-server

# Common issues:
# - Database not ready: wait for postgres healthcheck
# - Missing public/ directory: rebuild image
# - Prisma binary mismatch: check binaryTargets in schema.prisma
```

### DNS Not Resolving

```bash
# Verify silo-dns is running
docker ps | grep silo-dns

# Check dnsmasq config
docker exec silo-dns cat /etc/dnsmasq.conf | grep agencio

# Rebuild if config changed
cd underworld/silo-poc/lab && docker compose build silo-dns && docker compose up -d silo-dns
```

### 502 Bad Gateway

```bash
# Check if license-server is running and healthy
docker ps | grep license-server

# Check nginx can reach license-server
docker exec silo-nginx curl -s http://172.30.0.50:3000/health
```

## MinIO Storage (S3)

Download packages are stored in MinIO at `silo-storage:9000`.

**Bucket:** `license-server-downloads`

```
license-server-downloads/
├── k8inspector/
│   └── (k8inspector packages)
└── silo/
    ├── windows/
    │   └── silo-home-windows-x64.zip
    ├── macos/
    │   └── silo-home-macos-arm64.zip
    ├── business/
    │   └── silo-business-multiplatform.zip
    ├── enterprise/
    │   └── silo-enterprise-multiplatform.zip
    └── addons/
        ├── silo-k8inspector-addon.zip
        └── silo-docker-monitor-addon.zip
```

### Upload a Package

**Option 1: Admin Panel (Recommended)**

1. Go to Admin Panel: https://licencing.agencio.cloud/admin.html
2. Navigate to Products
3. Click Edit on the product
4. In the "Download Package" section, use the file upload area to upload a .zip, .tar, .exe, .dmg, etc.
5. The file is automatically stored in MinIO with the path: `{category}/{product-name}/filename-vX.X.X.ext`
6. Check "Set as active bundle after upload" to make it the active download

**Option 2: mc CLI (Manual)**

```bash
# Using mc CLI
docker run --rm --network silo-lab -v /path/to/package:/data minio/mc:latest \
  sh -c "mc alias set silo http://silo-storage:9000 silo-admin silo-secret-key && \
         mc cp /data/package.zip silo/license-server-downloads/silo/windows/silo-home-windows-x64.zip"
```

### MinIO Console

Access MinIO console at: http://localhost:19001
- Username: `silo-admin`
- Password: `silo-secret-key`

## Files

| File | Purpose |
|------|---------|
| `docker-compose.silo.yml` | Silo-lab deployment config |
| `prisma/seed-k8inspector.ts` | k8inspector product seeding |
| `prisma/seed-silo.ts` | SILO product seeding |
| `docs/SILO-LAB.md` | This document |
