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
  // Generate invite token outside transaction
  const inviteToken = randomBytes(32).toString('hex');

  // Use transaction for atomic seat assignment and count update
  const result = await prisma.$transaction(async (tx) => {
    const license = await tx.license.findUnique({
      where: { id: input.licenseId },
      include: {
        seatAssignments: true,
        product: { select: { name: true } },
        customer: { select: { email: true, name: true } },
      },
    });

    if (!license) {
      return { success: false as const, error: 'License not found' };
    }

    if (license.licenseType !== 'TEAM' && license.licenseType !== 'ENTERPRISE') {
      return { success: false as const, error: 'License does not support seat assignments' };
    }

    // Check if seat is already assigned to this email
    const existingAssignment = license.seatAssignments.find(
      (s) => s.email.toLowerCase() === input.email.toLowerCase()
    );

    if (existingAssignment) {
      return { success: false as const, error: 'Seat already assigned to this email' };
    }

    // Check if seats are available (use current count from DB for accuracy)
    if (license.seatAssignments.length >= license.seatCount) {
      return { success: false as const, error: 'No seats available' };
    }

    // Create the assignment and update seat count atomically
    const assignment = await tx.seatAssignment.create({
      data: {
        licenseId: input.licenseId,
        email: input.email.toLowerCase(),
        name: input.name,
        assignedBy: input.assignedBy,
        inviteToken,
        inviteSentAt: input.sendInvite ? new Date() : null,
      },
    });

    // Increment seatsUsed atomically
    await tx.license.update({
      where: { id: input.licenseId },
      data: { seatsUsed: { increment: 1 } },
    });

    return {
      success: true as const,
      assignment,
      license,
    };
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Generate invite URL
  const baseUrl = process.env.LICENSE_PORTAL_URL || process.env.PUBLIC_URL || 'https://license.agencio.cloud';
  const inviteUrl = `${baseUrl}/invite/${inviteToken}`;

  // Send invite email if requested (outside transaction)
  if (input.sendInvite && result.license) {
    try {
      await emailService.sendSeatInviteEmail(
        input.email,
        input.name,
        result.license.product.name,
        result.license.customer.name || result.license.customer.email,
        inviteUrl
      );
    } catch (err) {
      logger.error('Failed to send seat invite email:', err);
    }
  }

  return { success: true, assignment: result.assignment, inviteUrl };
}

/**
 * Remove a seat assignment
 */
export async function removeSeat(
  licenseId: string,
  email: string
): Promise<{ success: boolean; error?: string }> {
  // Use transaction for atomic delete and count update
  const result = await prisma.$transaction(async (tx) => {
    const assignment = await tx.seatAssignment.findFirst({
      where: {
        licenseId,
        email: email.toLowerCase(),
      },
    });

    if (!assignment) {
      return { success: false as const, error: 'Seat assignment not found' };
    }

    // Delete the assignment
    await tx.seatAssignment.delete({
      where: { id: assignment.id },
    });

    // Decrement seatsUsed atomically (with floor at 0)
    await tx.license.update({
      where: { id: licenseId },
      data: {
        seatsUsed: {
          decrement: 1
        }
      },
    });

    return { success: true as const };
  });

  return result;
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
