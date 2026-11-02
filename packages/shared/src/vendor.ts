import { z } from 'zod';
import { ACCOUNT_NO_RE, IFSC_RE, PHONE_RE, PINCODE_RE, normalizeId } from './validators.js';

export const CONSTITUTIONS = [
  'proprietorship',
  'partnership',
  'llp',
  'private_limited',
  'public_limited',
  'trust',
  'other',
] as const;
export type Constitution = (typeof CONSTITUTIONS)[number];

export const CONSTITUTION_LABELS: Record<Constitution, string> = {
  proprietorship: 'Proprietorship',
  partnership: 'Partnership',
  llp: 'LLP',
  private_limited: 'Private Limited',
  public_limited: 'Public Limited',
  trust: 'Trust / Society',
  other: 'Other',
};

export const CATEGORIES = [
  'raw_material',
  'packaging',
  'food_ingredients',
  'services',
  'capital_goods',
  'logistics',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  raw_material: 'Raw Material',
  packaging: 'Packaging',
  food_ingredients: 'Food Ingredients',
  services: 'Services',
  capital_goods: 'Capital Goods',
  logistics: 'Logistics',
  other: 'Other',
};

const upperId = (re: RegExp, msg: string) =>
  z.string().transform(normalizeId).pipe(z.string().regex(re, msg));

export const addressSchema = z.object({
  line1: z.string().trim().min(3, 'Required'),
  line2: z.string().trim().optional().default(''),
  city: z.string().trim().min(2, 'Required'),
  state: z.string().trim().min(2, 'Required'),
  pincode: z.string().trim().regex(PINCODE_RE, 'Enter a valid 6-digit PIN code'),
  country: z.string().trim().length(2).default('IN'),
});

export const bankSchema = z.object({
  accountHolder: z.string().trim().min(3, 'Required'),
  accountNumber: z.string().trim().regex(ACCOUNT_NO_RE, '9–18 digits'),
  ifsc: upperId(IFSC_RE, 'Enter a valid IFSC (e.g. HDFC0001234)'),
});

export const contactSchema = z.object({
  name: z.string().trim().min(2, 'Required'),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  phone: z.string().trim().regex(PHONE_RE, 'Enter a 10-digit mobile number'),
});

/** The complete profile required before a vendor can be submitted for approval. */
export const vendorProfileSchema = z.object({
  legalName: z.string().trim().min(2, 'Required').max(200),
  tradeName: z.string().trim().max(200).optional().default(''),
  constitution: z.enum(CONSTITUTIONS),
  category: z.enum(CATEGORIES),
  isMsme: z.boolean().default(false),
  isImportExport: z.boolean().default(false),
  isFoodBusiness: z.boolean().default(false),
  paymentTermsDays: z.number().int().min(0).max(180).default(30),
  contact: contactSchema,
  address: addressSchema,
  bank: bankSchema,
});
export type VendorProfile = z.infer<typeof vendorProfileSchema>;

/**
 * Drafts are saved incrementally (autosave), so every field is optional and only
 * shape-checked. Completeness is enforced by `vendorProfileSchema` at submit time.
 */
export const vendorDraftSchema = z.object({
  legalName: z.string().trim().max(200).optional(),
  tradeName: z.string().trim().max(200).optional(),
  constitution: z.enum(CONSTITUTIONS).optional(),
  category: z.enum(CATEGORIES).optional(),
  isMsme: z.boolean().optional(),
  isImportExport: z.boolean().optional(),
  isFoodBusiness: z.boolean().optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  contact: contactSchema.partial().optional(),
  address: addressSchema.partial().optional(),
  bank: bankSchema.partial().optional(),
});
export type VendorDraft = z.infer<typeof vendorDraftSchema>;

/** Deep-merges a draft patch into an existing draft (objects merged one level deep). */
export function mergeDraft(base: VendorDraft, patch: VendorDraft): VendorDraft {
  return {
    ...base,
    ...patch,
    contact: { ...base.contact, ...patch.contact },
    address: { ...base.address, ...patch.address },
    bank: { ...base.bank, ...patch.bank },
  };
}
