# License Server - TODO

## Phase 1: Foundation
- [ ] Initialize Node.js/TypeScript project with Express
- [ ] Set up Prisma with PostgreSQL schema
- [ ] Configure Docker Compose (app + postgres)
- [ ] Create environment configuration

## Phase 2: Core Services
- [ ] License key generation (cryptographically secure)
- [ ] License service (create, validate, activate, revoke)
- [ ] Product service (CRUD)
- [ ] Customer service (CRUD, auth)

## Phase 3: Stripe Integration
- [ ] Stripe SDK setup
- [ ] Create checkout sessions
- [ ] Webhook handlers for subscription lifecycle
- [ ] Automatic license provisioning on payment

## Phase 4: APIs
- [ ] Admin API with JWT auth
- [ ] License validation API
- [ ] Customer portal API
- [ ] Stripe webhook endpoint

## Phase 5: S3 Integration
- [ ] AWS SDK setup
- [ ] Signed URL generation for downloads
- [ ] Upload endpoint for admin

## Phase 6: Customer Portal Frontend
- [ ] React/Next.js frontend setup
- [ ] Login/Register pages
- [ ] License dashboard
- [ ] Download software page
- [ ] Stripe billing portal redirect

## Phase 7: Offline License Support
- [ ] RSA key pair generation
- [ ] Signed license token creation
- [ ] Document client-side validation

## Phase 8: Testing & Deployment
- [ ] Unit tests for services
- [ ] Integration tests for APIs
- [ ] Docker build verification
- [ ] Production deployment docs
