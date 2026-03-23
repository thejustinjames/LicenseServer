import { prisma } from '../config/database.js';
import { SeatAssignment, License, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as emailService from './email.service.js';
import { logger } from './logger.service.js';

export interface AssignSeatInput {
  licenseId: string;
  email: string;
  name?: string;
  assignedBy?: string;
  sendInvite?: boolean;
}

export interface SeatAssignmentWithLicense extends SeatAssignment {
  license: {
    id: string;
    key: string;
    seatCount: number;
    seatsUsed: number;
    product: { id: string; name: string; features: string[] };
  };
}

/**
 * Get all seat assignments for a license
 */
export async function getSeatAssignments(licenseId: string): Promise<{
  seats: SeatAssignment[];
  available: number;
  total: number;
  license: License | null;
}> {
  const license = await prisma.license.findUnique({
    where: { id: licenseId },
    include: {
      seatAssignments: {
        orderBy: { assignedAt: 'asc' },
      },
    },
  });

  if (!license) {
    return { seats: [], available: 0, total: 0, license: null };
  }

  const total = license.seatCount;
  const used = license.seatAssignments.length;
  const available = Math.max(0, total - used);

  return {
    seats: license.seatAssignments,
    available,
    total,
    license,
  };
}

/**
 * Assign a seat to a user
 */
export async function assignSeat(input: AssignSeatInput): Promise<{
  success: boolean;
  assignment?: SeatAssignment;
  inviteUrl?: string;
  error?: string;
}> {
  const license = await prisma.license.findUnique({
    where: { id: input.licenseId },
    include: {
      seatAssignments: true,
      product: { select: { name: true } },
      customer: { select: { email: true, name: true } },
    },
  });

  if (!license) {
    return { success: false, error: 'License not found' };
  }

  if (license.licenseType !== 'TEAM' && license.licenseType !== 'ENTERPRISE') {
    return { success: false, error: 'License does not support seat assignments' };
  }

  // Check if seat is already assigned to this email
  const existingAssignment = license.seatAssignments.find(
    (s) => s.email.toLowerCase() === input.email.toLowerCase()
  );

  if (existingAssignment) {
    return { success: false, error: 'Seat already assigned to this email' };
  }

  // Check if seats are available
  if (license.seatAssignments.length >= license.seatCount) {
    return { success: false, error: 'No seats available' };
  }

  // Generate invite token
  const inviteToken = randomBytes(32).toString('hex');

  // Create the assignment
  const assignment = await prisma.seatAssignment.create({
    data: {
      licenseId: input.licenseId,
      email: input.email.toLowerCase(),
      name: input.name,
      assignedBy: input.assignedBy,
      inviteToken,
      inviteSentAt: input.sendInvite ? new Date() : null,
    },
  });

  // Update seats used count
  await prisma.license.update({
    where: { id: input.licenseId },
    data: { seatsUsed: license.seatAssignments.length + 1 },
  });

  // Generate invite URL
  const baseUrl = process.env.LICENSE_PORTAL_URL || process.env.PUBLIC_URL || 'https://license.agencio.cloud';
  const inviteUrl = `${baseUrl}/invite/${inviteToken}`;

  // Send invite email if requested
  if (input.sendInvite) {
    try {
      await emailService.sendSeatInviteEmail(
        input.email,
        input.name,
        license.product.name,
        license.customer.name || license.customer.email,
        inviteUrl
      );
    } catch (err) {
      logger.error('Failed to send seat invite email:', err);
    }
  }

  return { success: true, assignment, inviteUrl };
}

/**
 * Remove a seat assignment
 */
export async function removeSeat(
  licenseId: string,
  email: string
): Promise<{ success: boolean; error?: string }> {
  const assignment = await prisma.seatAssignment.findFirst({
    where: {
      licenseId,
      email: email.toLowerCase(),
    },
  });

  if (!assignment) {
    return { success: false, error: 'Seat assignment not found' };
  }

  // Delete the assignment
  await prisma.seatAssignment.delete({
    where: { id: assignment.id },
  });

  // Update seats used count
  const license = await prisma.license.findUnique({
    where: { id: licenseId },
    include: { seatAssignments: true },
  });

  if (license) {
    await prisma.license.update({
      where: { id: licenseId },
      data: { seatsUsed: license.seatAssignments.length },
    });
  }

  return { success: true };
}

/**
 * Bulk assign seats
 */
export async function bulkAssignSeats(
  licenseId: string,
  assignments: Array<{ email: string; name?: string }>,
  assignedBy?: string,
  sendInvites: boolean = true
): Promise<{
  assigned: number;
  failed: Array<{ email: string; error: string }>;
  invitesSent: number;
}> {
  const results = {
    assigned: 0,
    failed: [] as Array<{ email: string; error: string }>,
    invitesSent: 0,
  };

  for (const assignment of assignments) {
    const result = await assignSeat({
      licenseId,
      email: assignment.email,
      name: assignment.name,
      assignedBy,
      sendInvite: sendInvites,
    });

    if (result.success) {
      results.assigned++;
      if (sendInvites) {
        results.invitesSent++;
      }
    } else {
      results.failed.push({ email: assignment.email, error: result.error || 'Unknown error' });
    }
  }

  return results;
}

/**
 * Accept a seat invite
 */
export async function acceptSeatInvite(
  inviteToken: string,
  machineFingerprint?: string,
  machineName?: string
): Promise<{
  success: boolean;
  assignment?: SeatAssignmentWithLicense;
  error?: string;
}> {
  const assignment = await prisma.seatAssignment.findUnique({
    where: { inviteToken },
    include: {
      license: {
        include: {
          product: { select: { id: true, name: true, features: true } },
        },
      },
    },
  });

  if (!assignment) {
    return { success: false, error: 'Invalid or expired invite' };
  }

  if (assignment.inviteAcceptedAt) {
    return { success: false, error: 'Invite already accepted' };
  }

  // Update the assignment
  const updated = await prisma.seatAssignment.update({
    where: { id: assignment.id },
    data: {
      inviteAcceptedAt: new Date(),
      activated: !!machineFingerprint,
      activatedAt: machineFingerprint ? new Date() : null,
      machineFingerprint,
      machineName,
    },
    include: {
      license: {
        select: {
          id: true,
          key: true,
          seatCount: true,
          seatsUsed: true,
          product: { select: { id: true, name: true, features: true } },
        },
      },
    },
  });

  return { success: true, assignment: updated };
}

/**
 * Get seat assignment by email (across all licenses)
 */
export async function getSeatsByEmail(email: string): Promise<SeatAssignmentWithLicense[]> {
  return prisma.seatAssignment.findMany({
    where: { email: email.toLowerCase() },
    include: {
      license: {
        select: {
          id: true,
          key: true,
          seatCount: true,
          seatsUsed: true,
          product: { select: { id: true, name: true, features: true } },
        },
      },
    },
  });
}

/**
 * Resend seat invite
 */
export async function resendSeatInvite(
  licenseId: string,
  email: string
): Promise<{ success: boolean; error?: string }> {
  const assignment = await prisma.seatAssignment.findFirst({
    where: {
      licenseId,
      email: email.toLowerCase(),
    },
    include: {
      license: {
        include: {
          product: { select: { name: true } },
          customer: { select: { email: true, name: true } },
        },
      },
    },
  });

  if (!assignment) {
    return { success: false, error: 'Seat assignment not found' };
  }

  if (assignment.inviteAcceptedAt) {
    return { success: false, error: 'Invite already accepted' };
  }

  // Generate new invite token
  const inviteToken = randomBytes(32).toString('hex');

  await prisma.seatAssignment.update({
    where: { id: assignment.id },
    data: {
      inviteToken,
      inviteSentAt: new Date(),
    },
  });

  const baseUrl = process.env.LICENSE_PORTAL_URL || process.env.PUBLIC_URL || 'https://license.agencio.cloud';
  const inviteUrl = `${baseUrl}/invite/${inviteToken}`;

  try {
    await emailService.sendSeatInviteEmail(
      email,
      assignment.name || undefined,
      assignment.license.product.name,
      assignment.license.customer.name || assignment.license.customer.email,
      inviteUrl
    );
    return { success: true };
  } catch (err) {
    logger.error('Failed to send seat invite email:', err);
    return { success: false, error: 'Failed to send invite email' };
  }
}
