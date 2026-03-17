# License Server - TODO

## Remaining Tasks

### Testing
- [ ] Add integration tests for API endpoints
- [ ] Add E2E tests for Stripe checkout flow
- [ ] Add load testing scripts

### CI/CD Pipeline
- [ ] Set up GitHub Actions workflow
- [ ] Automated testing on PR
- [ ] Automated deployment to staging
- [ ] Docker image build and push

### Monitoring & Alerting
- [ ] CloudWatch/Datadog integration
- [ ] Error tracking (Sentry)
- [ ] Performance monitoring
- [ ] Alert rules for critical metrics

### Optional Enhancements
- [ ] Admin dashboard UI (currently API-only)
- [ ] License transfer between customers
- [ ] Multi-currency support
- [ ] Webhook retry queue with dead letter handling
- [ ] Rate limiting with Redis (for distributed deployment)

---

## Completed

See [COMPLETED.md](./COMPLETED.md) for full details on implemented features.

### Recently Completed
- [x] RSA key generation for offline licensing
- [x] Microsoft Graph email service (Office 365)
- [x] Unit tests with Vitest
- [x] Production deployment documentation
