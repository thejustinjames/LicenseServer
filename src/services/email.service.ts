import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { config } from '../config/index.js';
import { logger } from './logger.service.js';

// Email configuration
interface EmailConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderEmail: string;
}

// Email template types
type EmailTemplate =
  | 'welcome'
  | 'trial_ending'
  | 'payment_failed'
  | 'refund_processed'
  | 'license_activated'
  | 'license_revoked'
  | 'subscription_canceled'
  | 'password_reset'
  | 'seat_invite'
  | 'quote_sent';

interface EmailData {
  to: string;
  toName?: string;
  template: EmailTemplate;
  data: Record<string, string | number | boolean | undefined>;
}

// Graph client singleton
let graphClient: Client | null = null;
let emailConfig: EmailConfig | null = null;

/**
 * Initialize the Microsoft Graph client
 */
export function initializeEmailService(): boolean {
  const tenantId = config.AZURE_TENANT_ID;
  const clientId = config.AZURE_CLIENT_ID;
  const clientSecret = config.AZURE_CLIENT_SECRET;
  const senderEmail = config.EMAIL_SENDER;

  if (!tenantId || !clientId || !clientSecret || !senderEmail) {
    logger.info('Email service not configured (missing Azure AD credentials)');
    return false;
  }

  emailConfig = { tenantId, clientId, clientSecret, senderEmail };

  try {
    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });

    graphClient = Client.initWithMiddleware({ authProvider });
    logger.info('Email service initialized (Microsoft Graph)');
    return true;
  } catch (error) {
    logger.error('Failed to initialize email service:', error);
    return false;
  }
}

/**
 * Check if email service is available
 */
export function isEmailServiceAvailable(): boolean {
  return graphClient !== null && emailConfig !== null;
}

/**
 * Send an email using Microsoft Graph
 */
export async function sendEmail(email: EmailData): Promise<boolean> {
  if (!graphClient || !emailConfig) {
    logger.warn('Email service not available, skipping email send');
    return false;
  }

  const { subject, body } = getEmailContent(email.template, email.data);

  const message = {
    message: {
      subject,
      body: {
        contentType: 'HTML',
        content: body,
      },
      toRecipients: [
        {
          emailAddress: {
            address: email.to,
            name: email.toName,
          },
        },
      ],
    },
    saveToSentItems: true,
  };

  try {
    await graphClient
      .api(`/users/${emailConfig.senderEmail}/sendMail`)
      .post(message);

    logger.info(`Email sent: ${email.template} to ${email.to}`);
    return true;
  } catch (error) {
    logger.error(`Failed to send email (${email.template}):`, error);
    return false;
  }
}

/**
 * Get email subject and body for a template
 */
function getEmailContent(template: EmailTemplate, data: Record<string, string | number | boolean | undefined>): {
  subject: string;
  body: string;
} {
  const appName = config.APP_NAME || 'License Server';
  const supportEmail = config.SUPPORT_EMAIL || emailConfig?.senderEmail || 'support@example.com';

  switch (template) {
    case 'welcome':
      return {
        subject: `Welcome to ${appName}!`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #2563eb;">Welcome to ${appName}!</h1>
            <p>Hi ${data.name || 'there'},</p>
            <p>Thank you for signing up! Your account has been created successfully.</p>
            <p>You can now:</p>
            <ul>
              <li>Browse and purchase licenses</li>
              <li>Manage your subscriptions</li>
              <li>Download your software</li>
            </ul>
            <p>If you have any questions, please don't hesitate to contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
            <p>Best regards,<br>The ${appName} Team</p>
          </div>
        `,
      };

    case 'trial_ending':
      return {
        subject: `Your trial ends in ${data.daysRemaining} days`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #f59e0b;">Your Trial is Ending Soon</h1>
            <p>Hi ${data.name || 'there'},</p>
            <p>Your free trial for <strong>${data.productName}</strong> will end in <strong>${data.daysRemaining} days</strong>.</p>
            <p>To continue using the software without interruption, please ensure you have a valid payment method on file.</p>
            <p>Your subscription will automatically renew at <strong>$${data.price}</strong>/${data.interval || 'month'}.</p>
            <p>If you have any questions, please contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
            <p>Best regards,<br>The ${appName} Team</p>
          </div>
        `,
      };

    case 'payment_failed':
      return {
        subject: `Action Required: Payment Failed`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #ef4444;">Payment Failed</h1>
            <p>Hi ${data.name || 'there'},</p>
            <p>We were unable to process your payment for <strong>${data.productName}</strong>.</p>
            <p>Please update your payment method to avoid any interruption to your service.</p>
            <p><a href="${data.billingPortalUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Update Payment Method</a></p>
            <p>If you believe this is an error, please contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
            <p>Best regards,<br>The ${appName} Team</p>
          </div>
        `,
      };

    case 'refund_processed':
      return {
        subject: `Refund Processed`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #10b981;">Refund Processed</h1>
            <p>Hi ${data.name || 'there'},</p>
            <p>Your refund of <strong>$${(Number(data.amount) / 100).toFixed(2)} ${data.currency?.toString().toUpperCase()}</strong> has been processed.</p>
            <p>Please allow 5-10 business days for the refund to appear in your account.</p>
            ${data.licensesRevoked ? '<p><em>Note: Associated licenses have been deactivated.</em></p>' : ''}
            <p>If you have any questions, please contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
            <p>Best regards,<br>The ${appName} Team</p>
          </div>
        `,
      };

    case 'license_activated':
      return {
        subject: `License Activated: ${data.productName}`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #10b981;">License Activated!</h1>
            <p>Hi ${data.name || 'there'},</p>
            <p>Your license for <strong>${data.productName}</strong> has been activated.</p>
            <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin: 16px 0;">
              <p style="margin: 0;"><strong>License Key:</strong></p>
              <code style="font-size: 1.2em; color: #2563eb;">${data.licenseKey}</code>
            </div>
            <p><strong>Device:</strong> ${data.machineName || 'Unknown'}</p>
            ${data.expiresAt ? `<p><strong>Expires:</strong> ${data.expiresAt}</p>` : ''}
            <p>If you have any questions, please contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
            <p>Best regards,<br>The ${appName} Team</p>
          </div>
        `,
      };

    case 'license_revoked':
      return {
        subject: `License Revoked: ${data.productName}`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #ef4444;">License Revoked</h1>
            <p>Hi ${data.name || 'there'},</p>
            <p>Your license for <strong>${data.productName}</strong> has been revoked.</p>
            ${data.reason ? `<p><strong>Reason:</strong> ${data.reason}</p>` : ''}
            <p>If you believe this is an error, please contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
            <p>Best regards,<br>The ${appName} Team</p>
          </div>
        `,
      };

    case 'subscription_canceled':
      return {
        subject: `Subscription Canceled`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #64748b;">Subscription Canceled</h1>
            <p>Hi ${data.name || 'there'},</p>
            <p>Your subscription for <strong>${data.productName}</strong> has been canceled.</p>
            ${data.periodEnd ? `<p>You will continue to have access until <strong>${data.periodEnd}</strong>.</p>` : ''}
            <p>We're sorry to see you go! If you change your mind, you can always resubscribe from your dashboard.</p>
            <p>If you have any feedback or questions, please contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
            <p>Best regards,<br>The ${appName} Team</p>
          </div>
        `,
      };

    case 'password_reset':
      return {
        subject: `Reset Your Password`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #2563eb;">Password Reset Request</h1>
            <p>Hi ${data.name || 'there'},</p>
            <p>We received a request to reset your password. Click the button below to create a new password:</p>
            <p style="margin: 24px 0;">
              <a href="${data.resetUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
                Reset Password
              </a>
            </p>
            <p>This link will expire in ${data.expiryHours || 1} hour(s).</p>
            <p>If you didn't request this, you can safely ignore this email.</p>
            <p style="color: #64748b; font-size: 12px; margin-top: 24px;">
              If the button doesn't work, copy and paste this link into your browser:<br>
              <a href="${data.resetUrl}">${data.resetUrl}</a>
            </p>
            <p>Best regards,<br>The ${appName} Team</p>
          </div>
        `,
      };

    case 'seat_invite':
      return {
        subject: `You've been assigned a ${data.productName} license`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #2563eb;">You've Been Assigned a License!</h1>
            <p>Hi ${data.name || 'there'},</p>
            <p><strong>${data.assignedBy}</strong> has assigned you a seat for <strong>${data.productName}</strong>.</p>
            <p>Click the button below to activate your license:</p>
            <p style="margin: 24px 0;">
              <a href="${data.inviteUrl}" style="background: #10b981; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
                Activate License
              </a>
            </p>
            <p>This will create your account and activate your seat on your device.</p>
            <p style="color: #64748b; font-size: 12px; margin-top: 24px;">
              If the button doesn't work, copy and paste this link into your browser:<br>
              <a href="${data.inviteUrl}">${data.inviteUrl}</a>
            </p>
            <p>If you have any questions, please contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
            <p>Best regards,<br>The ${appName} Team</p>
          </div>
        `,
      };

    case 'quote_sent':
      return {
        subject: `Your Quote from ${appName} - ${data.quoteNumber}`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #2563eb;">Your Quote is Ready</h1>
            <p>Hi ${data.name || 'there'},</p>
            <p>Thank you for your interest in <strong>${data.productName}</strong>.</p>
            <div style="background: #f1f5f9; padding: 20px; border-radius: 8px; margin: 24px 0;">
              <p style="margin: 0 0 12px 0;"><strong>Quote Number:</strong> ${data.quoteNumber}</p>
              <p style="margin: 0 0 12px 0;"><strong>Product:</strong> ${data.productName}</p>
              <p style="margin: 0 0 12px 0;"><strong>Seats:</strong> ${data.seatCount}</p>
              <p style="margin: 0 0 12px 0;"><strong>Term:</strong> ${data.termYears} year(s)</p>
              <p style="margin: 0;"><strong>Total:</strong> $${(Number(data.finalPrice) / 100).toFixed(2)} ${data.currency?.toString().toUpperCase()}</p>
            </div>
            <p>This quote is valid until <strong>${data.validUntil}</strong>.</p>
            <p>To proceed with your purchase, please contact our sales team or click below:</p>
            <p style="margin: 24px 0;">
              <a href="${data.acceptUrl}" style="background: #10b981; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
                Accept Quote
              </a>
            </p>
            <p>If you have any questions, please contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
            <p>Best regards,<br>The ${appName} Team</p>
          </div>
        `,
      };

    default:
      return {
        subject: `Notification from ${appName}`,
        body: `<p>You have a new notification from ${appName}.</p>`,
      };
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export async function sendWelcomeEmail(to: string, name?: string): Promise<boolean> {
  return sendEmail({
    to,
    toName: name,
    template: 'welcome',
    data: { name },
  });
}

export async function sendTrialEndingEmail(
  to: string,
  name: string | undefined,
  productName: string,
  daysRemaining: number,
  price?: number,
  interval?: string
): Promise<boolean> {
  return sendEmail({
    to,
    toName: name,
    template: 'trial_ending',
    data: { name, productName, daysRemaining, price, interval },
  });
}

export async function sendPaymentFailedEmail(
  to: string,
  name: string | undefined,
  productName: string,
  billingPortalUrl: string
): Promise<boolean> {
  return sendEmail({
    to,
    toName: name,
    template: 'payment_failed',
    data: { name, productName, billingPortalUrl },
  });
}

export async function sendRefundProcessedEmail(
  to: string,
  name: string | undefined,
  amount: number,
  currency: string,
  licensesRevoked: boolean
): Promise<boolean> {
  return sendEmail({
    to,
    toName: name,
    template: 'refund_processed',
    data: { name, amount, currency, licensesRevoked },
  });
}

export async function sendLicenseActivatedEmail(
  to: string,
  name: string | undefined,
  productName: string,
  licenseKey: string,
  machineName?: string,
  expiresAt?: string
): Promise<boolean> {
  return sendEmail({
    to,
    toName: name,
    template: 'license_activated',
    data: { name, productName, licenseKey, machineName, expiresAt },
  });
}

export async function sendLicenseRevokedEmail(
  to: string,
  name: string | undefined,
  productName: string,
  reason?: string
): Promise<boolean> {
  return sendEmail({
    to,
    toName: name,
    template: 'license_revoked',
    data: { name, productName, reason },
  });
}

export async function sendSubscriptionCanceledEmail(
  to: string,
  name: string | undefined,
  productName: string,
  periodEnd?: string
): Promise<boolean> {
  return sendEmail({
    to,
    toName: name,
    template: 'subscription_canceled',
    data: { name, productName, periodEnd },
  });
}

export async function sendPasswordResetEmail(
  to: string,
  name: string | undefined,
  resetUrl: string,
  expiryHours: number = 1
): Promise<boolean> {
  return sendEmail({
    to,
    toName: name,
    template: 'password_reset',
    data: { name, resetUrl, expiryHours },
  });
}

export async function sendSeatInviteEmail(
  to: string,
  name: string | undefined,
  productName: string,
  assignedBy: string,
  inviteUrl: string
): Promise<boolean> {
  return sendEmail({
    to,
    toName: name,
    template: 'seat_invite',
    data: { name, productName, assignedBy, inviteUrl },
  });
}

export async function sendQuoteEmail(
  to: string,
  name: string | undefined,
  quoteNumber: string,
  productName: string,
  seatCount: number,
  termYears: number,
  finalPrice: number,
  currency: string,
  validUntil: string,
  acceptUrl: string
): Promise<boolean> {
  return sendEmail({
    to,
    toName: name,
    template: 'quote_sent',
    data: {
      name,
      quoteNumber,
      productName,
      seatCount,
      termYears,
      finalPrice,
      currency,
      validUntil,
      acceptUrl,
    },
  });
}
