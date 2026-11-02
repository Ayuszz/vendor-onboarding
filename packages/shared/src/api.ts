import { z } from 'zod';
import type { DocumentKey } from './documents.js';
import type { DocStatus } from './readiness.js';
import type { VendorDraft } from './vendor.js';
import { USER_ACTIONS, type Action, type Approval, type Role, type State, type UserAction } from './workflow.js';

/** Wire types shared by the API and the web client. */

export interface UserDTO {
  id: string;
  name: string;
  email: string;
  roles: Role[];
}

/** Session returned by every sign-in route and by GET /me. */
export interface SessionDTO {
  token?: string;
  user: UserDTO;
  /** For vendor accounts: their vendor record, or null when they have not started onboarding. */
  vendorId: string | null;
}

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);
export const staffLoginSchema = z.object({ email: emailSchema, password: z.string().min(1, 'Enter your password').max(200) });
export const otpRequestSchema = z.object({ email: emailSchema });
export const otpVerifySchema = z.object({ email: emailSchema, code: z.string().trim().regex(/^[0-9]{6}$/, 'Enter the 6-digit code') });

export interface OtpRequestResult {
  sent: true;
  expiresInSeconds: number;
  /** Only present in development/demo builds, where no email is actually sent. */
  devCode?: string;
}

/** What OCR read from the file before upload (sent by the browser, stored for reviewers). */
export const ocrMetaSchema = z.object({
  method: z.enum(['pdf-text', 'ocr', 'none']),
  confidence: z.number().min(0).max(100),
  /** Field keys that were filled from the document. */
  found: z.array(z.string().max(40)).max(20),
  /** Field keys the person changed after they were filled from the document. */
  edited: z.array(z.string().max(40)).max(20).default([]),
  ms: z.number().int().min(0).max(600_000).default(0),
});
export type OcrMeta = z.infer<typeof ocrMetaSchema>;

export interface DocumentDTO {
  key: DocumentKey;
  status: DocStatus;
  fields: Record<string, string>;
  reasons: string[];
  derived: Record<string, string>;
  file: { name: string; size: number; mimeType: string } | null;
  ocr: OcrMeta | null;
  uploadedAt: string;
  verifiedAt: string | null;
}

export interface EventDTO {
  id: number;
  action: Action | 'created' | 'document_uploaded' | 'document_verified' | 'document_failed';
  fromState: State | null;
  toState: State | null;
  actorName: string;
  role: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
  at: string;
}

export interface SapDTO {
  status: 'QUEUED' | 'SYNCED' | 'FAILED';
  cardCode: string | null;
  attempts: number;
  lastError: string | null;
  syncedAt: string | null;
}

export interface VendorDTO {
  id: string;
  reference: string;
  state: State;
  profile: VendorDraft;
  approvals: Approval[];
  documents: DocumentDTO[];
  sap: SapDTO | null;
  blockers: string[];
  pendingWith: Role[];
  allowedActions: UserAction[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface VendorListItem {
  id: string;
  reference: string;
  legalName: string;
  category: string | null;
  state: State;
  pendingWith: Role[];
  docs: { verified: number; required: number };
  updatedAt: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface StatsDTO {
  byState: Partial<Record<State, number>>;
  myQueue: number;
  avgDaysToOnboard: number | null;
}

export const actionBodySchema = z.object({
  reason: z.string().trim().max(1000).optional(),
  /** Optimistic concurrency: reject if someone else changed the vendor first. */
  version: z.number().int().nonnegative().optional(),
});
export type ActionBody = z.infer<typeof actionBodySchema>;

export const actionParamSchema = z.enum(USER_ACTIONS);

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
