import { PrismaClient, PurchaseType, PricingType, ValidationMode } from '@prisma/client';

const prisma = new PrismaClient();

interface SiloProduct {
  name: string;
  description: string;
  category: string;
  purchaseType: PurchaseType;
  pricingType: PricingType;
  validationMode: ValidationMode;
  priceMonthly: number | null;
  priceAnnual: number | null;
  licenseDurationDays: number | null;
  trialDays: number | null;
  maxMachines: number;
  features: string[];
  s3PackageKey: string | null;
  version: string | null;
}

// SILO product tiers with USD pricing (stored in cents)
// Feature flags match silo-license/src/types.rs AllowedFeatures struct
const siloProducts: SiloProduct[] = [
  // ============================================
  // SILO Home - $29.99/year, 1 machine, 7-day trial
  // ============================================
  {
    name: 'SILO Home - Windows',
    description: 'Standalone SILO for Windows. Perfect for personal security research and learning.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 2999,        // USD $29.99/year
    licenseDurationDays: 365,
    trialDays: 7,
    maxMachines: 1,
    features: [
      'windows-x64',
      'windows-arm64',
      'standalone-mode',
      'local-tds-engine',
      'guardian-basic',
      'hal-attestation',
      'offline-mode',
      'community-support',
      '7-day-retention',
      'observe-restrict-only',  // Home edition limited to OBSERVE/RESTRICT responses
    ],
    s3PackageKey: 'silo/windows/silo-home-windows.zip',
    version: '1.3.0',
  },
  {
    name: 'SILO Home - macOS',
    description: 'Standalone SILO for macOS (Intel & Apple Silicon). Perfect for personal security research and learning.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 2999,        // USD $29.99/year
    licenseDurationDays: 365,
    trialDays: 7,
    maxMachines: 1,
    features: [
      'macos-x64',
      'macos-arm64',
      'standalone-mode',
      'local-tds-engine',
      'guardian-basic',
      'hal-attestation',
      'secure-enclave-t15',   // Apple Silicon T1.5 tier
      'offline-mode',
      'community-support',
      '7-day-retention',
      'observe-restrict-only',
    ],
    s3PackageKey: 'silo/macos/silo-home-macos.zip',
    version: '1.3.0',
  },
  {
    name: 'SILO Home - Linux',
    description: 'Standalone SILO for Linux. Perfect for personal security research and learning.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 2999,        // USD $29.99/year
    licenseDurationDays: 365,
    trialDays: 7,
    maxMachines: 1,
    features: [
      'linux-x64',
      'linux-arm64',
      'standalone-mode',
      'local-tds-engine',
      'guardian-basic',
      'hal-attestation',
      'offline-mode',
      'community-support',
      '7-day-retention',
      'observe-restrict-only',
    ],
    s3PackageKey: 'silo/linux/silo-home-linux.zip',
    version: '1.3.0',
  },

  // ============================================
  // SILO Professional - $49.99/year, 2 machines, 14-day trial
  // ============================================
  {
    name: 'SILO Professional - Windows',
    description: 'SILO Professional for Windows. Full standalone features with extended retention and all response levels.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 4999,        // USD $49.99/year
    licenseDurationDays: 365,
    trialDays: 14,
    maxMachines: 2,
    features: [
      'windows-x64',
      'windows-arm64',
      'standalone-mode',
      'local-tds-engine',
      'guardian-full',
      'hal-attestation',
      'all-response-levels',  // Professional: OBSERVE, RESTRICT, ISOLATE, TERMINATE
      'cloud_llm',            // Professional gets cloud LLM (OpenAI, Anthropic, Gemini)
      'local-llm-support',    // Also supports Ollama/LMStudio
      'service-mode',         // Can run as Windows Service
      'offline-mode',
      'email-support',
      '30-day-retention',
    ],
    s3PackageKey: 'silo/windows/silo-professional-windows.zip',
    version: '1.3.0',
  },
  {
    name: 'SILO Professional - macOS',
    description: 'SILO Professional for macOS. Full standalone features with extended retention and all response levels.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 4999,        // USD $49.99/year
    licenseDurationDays: 365,
    trialDays: 14,
    maxMachines: 2,
    features: [
      'macos-x64',
      'macos-arm64',
      'standalone-mode',
      'local-tds-engine',
      'guardian-full',
      'hal-attestation',
      'secure-enclave-t15',
      'all-response-levels',
      'cloud_llm',            // Professional gets cloud LLM
      'local-llm-support',
      'launchd-service',      // Can run as launchd service
      'offline-mode',
      'email-support',
      '30-day-retention',
    ],
    s3PackageKey: 'silo/macos/silo-professional-macos.zip',
    version: '1.3.0',
  },
  {
    name: 'SILO Professional - Linux',
    description: 'SILO Professional for Linux. Full standalone features with extended retention and all response levels.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 4999,        // USD $49.99/year
    licenseDurationDays: 365,
    trialDays: 14,
    maxMachines: 2,
    features: [
      'linux-x64',
      'linux-arm64',
      'standalone-mode',
      'local-tds-engine',
      'guardian-full',
      'hal-attestation',
      'all-response-levels',
      'cloud_llm',            // Professional gets cloud LLM
      'local-llm-support',
      'systemd-service',      // Can run as systemd service
      'offline-mode',
      'email-support',
      '30-day-retention',
    ],
    s3PackageKey: 'silo/linux/silo-professional-linux.zip',
    version: '1.3.0',
  },

  // ============================================
  // SILO Business - $499.99/year, 5 machines, NO trial
  // Includes Cortex but EXCLUDES enterprise features
  // ============================================
  {
    name: 'SILO Business',
    description: 'SILO for small teams. Includes Cortex central management for up to 5 machines. No cloud LLM, Docker, K8s, or VMware integration.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 49999,       // USD $499.99/year
    licenseDurationDays: 365,
    trialDays: null,          // No trial for Business
    maxMachines: 5,
    features: [
      // Platform support
      'all-platforms',
      'windows-x64',
      'windows-arm64',
      'macos-x64',
      'macos-arm64',
      'linux-x64',
      'linux-arm64',

      // Core Cortex features
      'cortex',
      'sidecar-management',
      'eventbus',
      'central-dashboard',
      'real-time-monitoring',
      'tds-engine',
      'correlation-engine',
      'all-response-levels',
      'guardian-full',
      'hal-attestation',

      // AI - LOCAL ONLY (no cloud providers)
      'local-llm-only',       // Ollama/LMStudio only
      // BLOCKED: cloud_llm (OpenAI, Anthropic, Gemini)
      // BLOCKED: ai_brain (autonomous mode)

      // Container/Orchestration - NONE
      // BLOCKED: docker_agent
      // BLOCKED: k8inspector

      // Virtualization - NONE
      // BLOCKED: vmware_phantom_visor

      // Federation - NONE
      // BLOCKED: child_cortex (multi-cortex federation)
      // BLOCKED: multi_tenant

      // Auth - BASIC ONLY
      'local-auth',
      // BLOCKED: sso (SAML/OIDC)

      // Integrations - NONE
      // BLOCKED: siem_integration (Splunk, Elastic, Sentinel)
      // BLOCKED: webhook_soar (external workflow triggers)
      // BLOCKED: gtn_access (Global Threat Network)
      // BLOCKED: custom_detection_rules (user-defined TDS patterns)

      // Support & Reporting
      '90-day-retention',
      'priority-support',
      'basic-reporting',
      // BLOCKED: extended_audit_log
      // BLOCKED: compliance_reports
      // BLOCKED: white_label
    ],
    s3PackageKey: 'silo/business/silo-business-multiplatform.zip',
    version: '1.3.0',
  },

  // ============================================
  // SILO Enterprise - $899.99/year, 20 machines, NO trial
  // ALL features included
  // ============================================
  {
    name: 'SILO Enterprise',
    description: 'Full SILO suite for organizations. All features including cloud LLM, Docker, K8s, VMware, federation, SSO, SIEM, and GTN.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 89999,       // USD $899.99/year
    licenseDurationDays: 365,
    trialDays: null,          // No trial for Enterprise
    maxMachines: 20,
    features: [
      // Platform support
      'all-platforms',
      'windows-x64',
      'windows-arm64',
      'macos-x64',
      'macos-arm64',
      'linux-x64',
      'linux-arm64',

      // Core Cortex features
      'cortex',
      'sidecar-management',
      'eventbus',
      'central-dashboard',
      'real-time-monitoring',
      'tds-engine',
      'correlation-engine',
      'all-response-levels',
      'guardian-full',
      'hal-attestation',

      // AI - ALL providers
      'cloud_llm',            // OpenAI, Anthropic, Gemini
      'ai_brain',             // Autonomous AI SecOps mode
      'local-llm-support',    // Ollama/LMStudio

      // Container/Orchestration - ALL
      'docker_agent',         // Docker container monitoring
      'k8inspector',          // Kubernetes inspection

      // Virtualization - ALL
      'vmware_phantom_visor', // VMware Fusion/Workstation L1 integration

      // Federation - ALL
      'child_cortex',         // Multi-Cortex federation
      'multi_tenant',         // Multi-tenant support

      // Auth - ALL
      'local-auth',
      'sso',                  // SAML/OIDC SSO

      // Integrations - ALL
      'siem_integration',     // Splunk, Elastic, Sentinel
      'webhook_soar',         // External workflow triggers
      'gtn_access',           // Global Threat Network IOC sharing
      'custom_detection_rules', // User-defined TDS patterns

      // Support & Reporting - ALL
      '365-day-retention',
      'extended_audit_log',   // Extended audit logging
      'compliance_reports',   // SOC2, ISO27001 reports
      'dedicated-support',
      'sla',
    ],
    s3PackageKey: 'silo/enterprise/silo-enterprise-multiplatform.zip',
    version: '1.3.0',
  },

  // ============================================
  // License Packs - Add-on machine bundles
  // Require Business or Enterprise base license
  // ============================================
  {
    name: 'SILO License Pack - 5 Machines',
    description: 'Add 5 additional machines to your SILO Business or Enterprise license.',
    category: 'silo-addons',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'ONLINE',
    priceMonthly: null,
    priceAnnual: 9900,        // USD $99/year
    licenseDurationDays: 365,
    trialDays: null,
    maxMachines: 5,           // +5 machines
    features: ['license-pack', 'addon', 'requires-business-or-enterprise'],
    s3PackageKey: null,
    version: '1.3.0',
  },
  {
    name: 'SILO License Pack - 10 Machines',
    description: 'Add 10 additional machines to your SILO Business or Enterprise license.',
    category: 'silo-addons',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'ONLINE',
    priceMonthly: null,
    priceAnnual: 17900,       // USD $179/year
    licenseDurationDays: 365,
    trialDays: null,
    maxMachines: 10,          // +10 machines
    features: ['license-pack', 'addon', 'requires-business-or-enterprise'],
    s3PackageKey: null,
    version: '1.3.0',
  },
  {
    name: 'SILO License Pack - 20 Machines',
    description: 'Add 20 additional machines to your SILO Business or Enterprise license.',
    category: 'silo-addons',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'ONLINE',
    priceMonthly: null,
    priceAnnual: 35000,       // USD $350/year
    licenseDurationDays: 365,
    trialDays: null,
    maxMachines: 20,          // +20 machines
    features: ['license-pack', 'addon', 'requires-business-or-enterprise'],
    s3PackageKey: null,
    version: '1.3.0',
  },

  // ============================================
  // Enterprise Custom - Contact sales (POA)
  // ============================================
  {
    name: 'SILO Enterprise Custom',
    description: 'Custom SILO deployment for large organizations. Unlimited licenses, on-premise, air-gapped options. Contact sales.',
    category: 'silo',
    purchaseType: 'ONE_TIME',
    pricingType: 'FIXED',
    validationMode: 'OFFLINE',
    priceMonthly: null,       // POA - contact sales
    priceAnnual: null,
    licenseDurationDays: 365,
    trialDays: null,
    maxMachines: 9999,        // Unlimited
    features: [
      'all-features',
      'unlimited-machines',
      'on-premise',
      'air-gapped',
      'white_label',
      'source-code-review',
      'dedicated-account-manager',
      'premium-sla',
      'custom-integrations',
    ],
    s3PackageKey: null,
    version: null,
  },
];

async function seed() {
  console.log('Seeding SILO products...');
  console.log('');
  console.log('Pricing Structure:');
  console.log('  - Home:         $29.99/year, 1 machine, 7-day trial');
  console.log('  - Professional: $49.99/year, 2 machines, 14-day trial');
  console.log('  - Business:     $499.99/year, 5 machines, no trial (Cortex, no enterprise features)');
  console.log('  - Enterprise:   $899.99/year, 20 machines, no trial (all features)');
  console.log('  - Pack 5:       $99/year (+5 machines)');
  console.log('  - Pack 10:      $179/year (+10 machines)');
  console.log('  - Pack 20:      $350/year (+20 machines)');
  console.log('');

  for (const product of siloProducts) {
    // Check if product already exists by name and category
    const existing = await prisma.product.findFirst({
      where: {
        name: product.name,
        category: product.category,
      },
    });

    if (existing) {
      // Update existing product
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          description: product.description,
          purchaseType: product.purchaseType,
          pricingType: product.pricingType,
          validationMode: product.validationMode,
          priceMonthly: product.priceMonthly,
          priceAnnual: product.priceAnnual,
          licenseDurationDays: product.licenseDurationDays,
          features: product.features,
          s3PackageKey: product.s3PackageKey,
          version: product.version,
        },
      });
      console.log(`  Updated: ${product.name}`);
    } else {
      // Create new product
      await prisma.product.create({
        data: {
          name: product.name,
          description: product.description,
          category: product.category,
          purchaseType: product.purchaseType,
          pricingType: product.pricingType,
          validationMode: product.validationMode,
          priceMonthly: product.priceMonthly,
          priceAnnual: product.priceAnnual,
          licenseDurationDays: product.licenseDurationDays,
          features: product.features,
          s3PackageKey: product.s3PackageKey,
          version: product.version,
        },
      });
      console.log(`  Created: ${product.name}`);
    }
  }

  console.log('');
  console.log('Done seeding SILO products.');
  console.log('');
  console.log('Enterprise features (blocked in Business tier):');
  console.log('  - cloud_llm: Cloud LLM providers (OpenAI, Anthropic, Gemini)');
  console.log('  - ai_brain: Autonomous AI SecOps mode');
  console.log('  - docker_agent: Docker container monitoring');
  console.log('  - k8inspector: Kubernetes inspection');
  console.log('  - vmware_phantom_visor: VMware L1 Phantom Visor');
  console.log('  - child_cortex: Multi-Cortex federation');
  console.log('  - multi_tenant: Multi-tenant support');
  console.log('  - sso: SAML/OIDC SSO');
  console.log('  - siem_integration: Splunk, Elastic, Sentinel');
  console.log('  - webhook_soar: External workflow triggers');
  console.log('  - gtn_access: Global Threat Network');
  console.log('  - custom_detection_rules: User-defined TDS patterns');
  console.log('  - extended_audit_log: Extended audit logging');
  console.log('  - compliance_reports: SOC2/ISO27001 reports');
  console.log('  - white_label: White-label branding');
}

seed()
  .catch((e) => {
    console.error('Error seeding SILO products:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
