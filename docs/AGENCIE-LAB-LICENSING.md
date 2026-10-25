# The Agencie Lab on the licence server

How the licence server licenses the Agencie Lab: the products, the routes an installation uses,
the routes an operator's scripts use, releases, and what to do when a key must be issued,
revoked or rotated. Written 23 October 2026, when it was built; the lab instance is
`https://licenseserver.lab.silo.red` (the same code as production; a product instance later is
only a different URL in the installations' configuration).

## The model

One product family, two products, one licence key per machine.

| Product | Slug | Components (the licensed modules) | For |
|---|---|---|---|
| Agencie Lab - Docker host | `agencie-lab` | `aos`, `codeeasy`, `cloudcode` | the Docker host (bosgame or its equivalent): AOS, Code Easy and CloudCode run there or against it |
| Agencie Lab - Models host | `agencie-lab-models` | `models-host` | each GPU machine serving models (a DGX Spark, CT 203) |

Both are `HYBRID` validation, seven days' offline grace, a daily check-in, `requiresActivation`,
a year's term, `maxActivations` 1 per licence (one key, one machine). The Docker host product's
features are the entitlements AOS reads: `connectors`, `escalation`, `images`,
`update-channel:stable`, `max-accounts:10`. A licence's `enabledComponents` narrows the product's
components for one customer (sell AOS and CloudCode without Code Easy, say); add-ons change the
features as they do for SILO. Seeded by `npm run seed:agencie-lab` (idempotent, by slug).

The parts that were already here and are reused as they are: products with `components`,
licences with `enabledComponents`, activations with a machine fingerprint, the deployment guard
(validate, heartbeat, kill, commands), releases, Stripe subscriptions for the platform fee.

## What an installation does

The installation (AOS on the Docker host, the guard on a models host) never holds the admin key.
It enrols with its licence key and then signs everything with the deployment secret it was given.

**Enrol** `POST /api/deployments/enrol` (public, rate-limited like validation), body
`{ licenseKey, deploymentId, machineHash, machineName?, version?, environment?, component }`.
The licence is validated (status, expiry, the component against the licence's components, the
activation ceiling) and activated for the machine; a deployment is created with the id given,
bound to the licence, its customer and its product, with a freshly minted secret. The answer
carries the secret ONCE, with `product`, `slug`, `tier` (the licence type), `components`,
`features`, `expiresAt`, `graceDays`, `checkInDays` and the customer's name. The same machine
enrolling again (a rebuilt host, a lost data volume) is re-keyed and the old secret dies; a
different machine presenting a taken id, or a killed deployment, is refused (409, 403).
`deployment.service.ts`.

**Validate** `POST /api/deployments/validate`, as SILO and Predict do: the fingerprint signed
with HMAC-SHA256 in `X-Deployment-Signature`, the answer signed the same way with `_ts` and
`_sig`. New: a successful answer carries `components` and `features`, so a change on the server
(a module removed, an add-on) reaches the deployment at its next check.

**Heartbeat** `POST /api/deployments/heartbeat` with metrics; pending commands come back
(`KILL`, `UPDATE { version }`, …) and are marked delivered.

**Updates** `GET /api/updates/manifest?product=<slug>&channel=stable&currentVersion=x.y.z`
answers the active release on the channel as a signed manifest (below), and
`POST /api/updates/download` with `{ deploymentId, product, version }` signed in
`X-Deployment-Signature` answers a bundle-store URL for the artefact, good for the configured
hours, for a deployment that is `ACTIVE` with a licence in force. With `component` and
`platform` in the signed body it answers that component's artefact instead, refused when the
licence leaves out the component's module.

**Bootstrap** `POST /api/updates/bootstrap` with `{ licenseKey, product, component, platform?,
version?, channel? }` answers the same for an installer that has enrolled nothing yet: the
licence key is the credential, the licence must be in force and for the product, and the
component's module must be in it. Without `version`, the active release on the channel.

## Releases

A release row names a product, a version, a channel (`stable` by default; one active release per
product and channel), release notes, a minimum version, the critical flag, and now the artefact:
its key in the bundle store, its size, its SHA-256, and for a container product the image
reference inside the tarball (`aos-colony:1.1.110`). The **manifest** is the canonical JSON of
those fields (keys sorted at every level, no spaces; `release.service.ts`), and the **signature**
is RSA-SHA256 over it with the server's licence key (`LICENSE_PRIVATE_KEY_PATH`, the key that
signs offline licences). It is made whenever a release is created, updated or given an artefact,
and stored on the row. An installation verifies it with the public key compiled into its build
before it believes a version, an artefact or an image reference; notes are outside the
signature, shown and never acted on.

`PUT /api/admin/releases/:id/artifact?filename=<name>` takes the artefact as the raw request body
(up to 1 GB), stores it under `releases/<product>/<filename>`, records size and SHA-256 and
re-signs. The same routes are mounted under the automation door for scripts.

**Several parts** (25 October 2026). A release of a product made of several parts carries one
artefact per component and platform (`release_artifacts`):
`PUT /api/admin/releases/:id/artifacts/:component?platform=<os-arch|any>&filename=&imageRef=&version=`
streams the body to the bundle store in 16 MB parts, hashing on the way (up to 8 GB, nothing
held in memory), under `releases/<product>/<version>/<component>-<platform>-<filename>`;
`DELETE` on the same path takes one out. The manifest gains `components`, component → platform
→ `{ key, size, sha256, imageRef, version }`, inside the signature; a release with none has no
`components` key, so its manifest is byte for byte what it was. The `aos` component on `any`
also fills the release's single artefact and image reference, which consoles that know only
those act on. A component's licence module: `aos` and `vscode` need `aos`, `codeeasy`
`codeeasy`, `cloudcode` `cloudcode`, `models-runtime` `models-host`; anything else (the
installer `glue`, the `updater`) needs only a licence for the product
(`COMPONENT_MODULE` in `release.service.ts`). Deleting a release leaves its objects in the store.

Checked on the lab the same day: a 1.1 GB component up in 14 seconds with its hash matching;
the manifest's components and signature; the stable manifest unchanged; bootstrap downloads
served, and refused for a licence without Code Easy, a platform with no artefact, an unknown
key and the wrong product.

## The automation door

The admin routes sign in a person (Cognito on the lab), which a build host cannot do.
`/api/automation/*` takes the admin API key (`x-api-key`, as the deployment admin routes do):

| Route | Does |
|---|---|
| `POST /api/automation/licences` `{ customerEmail, customerName?, productSlug, days? \| expiresAt?, maxActivations?, enabledComponents?, note? }` | issues a licence; the customer is created by email when new (a random password: such a customer does not use the portal); answers the key once |
| `GET /api/automation/licences?product=<slug>` | the product's licences without their keys: customer, status, expiry, activations, deployments |
| `POST /api/automation/licences/:id/revoke` | revokes |
| `/api/automation/releases/…` | the admin releases router as it is: create, update, activate, delete, the artefact upload, the component uploads |

The key stays in the server's environment; a script runs the calls from inside the container
(`docker exec -i license-server node -e …`, the artefact streamed on stdin), so nothing holds it
on the host. The lab's one-pastes are in LabSetup's `Bosgame/frontier-lab-licensing.md`.

## Operations

- **Issue a key**: the admin UI (`/admin.html`, Licenses, the product and the customer), or the
  automation door. One key per machine; a second machine needs a second key, or a licence with
  `maxActivations` 2 if that is the deal.
- **See what is enrolled**: Deployments in the admin UI (id, status, version, last seen,
  metrics), or `GET /api/deployments` with the admin key.
- **Stop an installation**: kill the deployment (`POST /api/deployments/:id/kill`, or the admin
  UI); its gateway refuses at the next check, within the hour. `SUSPENDED` warns and keeps
  serving.
- **Revoke a key**: the licence's status; the next validation refuses. Expiry does the same with
  `warn`, which the installation treats as a warning for its grace period and then as stopped.
- **Rotate**: issue a new key for the same customer and product; the installation enters it and
  is re-keyed; revoke the old one.
- **Publish a release**: create it (inactive), upload the artefact, activate it. For the lab,
  `release-aos.sh <version>` on the Docker host does all three.
- **What is never collected**: an installation's heartbeat carries its version and host name,
  never requests, tokens or models. The Agencie Lab is paid for by the licence subscription, not
  by usage (decided 24 October 2026; metering stays a note on paper, an option never planned);
  the `UsageRecord` and credits machinery here is Predict's and is not wired to the Lab products.
- **Push an update**: a `DeploymentCommand` of type `UPDATE` with `{ version }`; the heartbeat
  delivers it and the installation marks the release as asked for; applying stays the admin's
  click on its console.

## The lab instance

Deployed from `/opt/docker-projects/licenseserver` (a copy of this repository's files, not a
checkout; `docker-compose.silo.yml`, built with `prisma db push` at start, so a schema change
applies on the next container start). Its bundle store is `silo-storage` (MinIO) on the
`silo-lab` network, bucket `license-server-downloads`. Its keys are mounted from
`/opt/docker-projects/licenseserver/keys`; the container runs as uid 1001 and the private key
was labadmin's 0600, so until `sudo chown 1001 keys/private.pem` neither offline tokens nor
release signing could load it (the warning predates the Agencie Lab work). A database backup is
taken before each deploy into `backups/`.
