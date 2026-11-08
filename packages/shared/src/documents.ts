import type { VendorDraft } from './vendor.js';
import {
  FSSAI_RE,
  IEC_RE,
  UDYAM_RE,
  isExpired,
  isValidGstin,
  isValidIfsc,
  isValidPan,
  normalizeId,
  panFromGstin,
  resolveBank,
} from './validators.js';

/**
 * Document registry.
 *
 * In the low-code version every document had its own "Upload X" and "Verify X"
 * activity (~26 activities). Here each document type is a single declarative entry:
 * adding a new document is a config change, and the upload → verify → status
 * flow is one generic code path.
 */

export type DocFieldType = 'text' | 'date' | 'number';

export interface DocField {
  key: string;
  label: string;
  type: DocFieldType;
  required?: boolean;
  placeholder?: string;
  /** Upper-case and strip spaces before validating/storing. */
  normalize?: boolean;
}

export type Requirement = 'required' | 'optional' | 'hidden';

export interface VerifyResult {
  ok: boolean;
  reasons: string[];
  /** Facts derived during verification (e.g. resolved bank name). */
  derived?: Record<string, string>;
}

export interface DocumentType {
  key: DocumentKey;
  label: string;
  hint: string;
  group: 'Tax' | 'Identity' | 'Bank' | 'Compliance' | 'Corporate' | 'Trade' | 'Other';
  fields: DocField[];
  requirement: (p: VendorDraft) => Requirement;
  /** Pure checks; `context` carries other already-submitted documents for cross-checks. */
  verify: (fields: Record<string, string>, p: VendorDraft, context: DocContext) => VerifyResult;
}

export type DocContext = Partial<Record<DocumentKey, Record<string, string>>>;

export const DOCUMENT_KEYS = [
  'gst',
  'pan',
  'bank_proof',
  'msme',
  'fssai',
  'aadhaar',
  'moa_aoa',
  'board_resolution',
  'iec',
  'ad_code',
  'rcmc',
  'dsc',
  'other',
] as const;
export type DocumentKey = (typeof DOCUMENT_KEYS)[number];

const isCompany = (p: VendorDraft) =>
  p.constitution === 'private_limited' || p.constitution === 'public_limited';

function result(reasons: string[], derived?: Record<string, string>): VerifyResult {
  return { ok: reasons.length === 0, reasons, ...(derived ? { derived } : {}) };
}

function requireFields(fields: Record<string, string>, keys: string[], reasons: string[]) {
  for (const k of keys) if (!fields[k]?.trim()) reasons.push(`${k} is required`);
}

function expiryCheck(fields: Record<string, string>, reasons: string[], key = 'expiryDate') {
  if (isExpired(fields[key])) reasons.push('Document has expired');
}

export const DOCUMENTS: Record<DocumentKey, DocumentType> = {
  gst: {
    key: 'gst',
    label: 'GST Certificate',
    hint: 'GST registration certificate (Form REG-06)',
    group: 'Tax',
    fields: [
      { key: 'gstin', label: 'GSTIN', type: 'text', required: true, normalize: true, placeholder: '27AAPFU0939F1ZV' },
      { key: 'legalName', label: 'Legal name on certificate', type: 'text', required: true },
      { key: 'tradeName', label: 'Trade name', type: 'text' },
      { key: 'constitution', label: 'Constitution of business', type: 'text' },
      { key: 'address', label: 'Principal place of business', type: 'text' },
    ],
    requirement: () => 'required',
    verify: (f, p, ctx) => {
      const reasons: string[] = [];
      requireFields(f, ['gstin', 'legalName'], reasons);
      const gstin = normalizeId(f.gstin ?? '');
      if (gstin && !isValidGstin(gstin)) reasons.push('GSTIN format or checksum is invalid');
      const pan = ctx.pan?.pan;
      if (gstin && pan && panFromGstin(gstin) !== normalizeId(pan))
        reasons.push('PAN inside GSTIN does not match the PAN document');
      if (f.legalName && p.legalName && !namesMatch(f.legalName, p.legalName))
        reasons.push('Legal name does not match the vendor profile');
      return result(reasons, gstin ? { stateCode: gstin.slice(0, 2) } : undefined);
    },
  },
  pan: {
    key: 'pan',
    label: 'PAN Card',
    hint: 'Permanent Account Number of the entity',
    group: 'Tax',
    fields: [
      { key: 'pan', label: 'PAN', type: 'text', required: true, normalize: true, placeholder: 'AAPFU0939F' },
      { key: 'nameOnPan', label: 'Name on PAN', type: 'text', required: true },
    ],
    requirement: () => 'required',
    verify: (f, p) => {
      const reasons: string[] = [];
      requireFields(f, ['pan', 'nameOnPan'], reasons);
      const pan = normalizeId(f.pan ?? '');
      if (pan && !isValidPan(pan)) reasons.push('PAN format is invalid');
      // 4th character encodes holder type: P = individual, C = company, F = firm …
      if (pan && isValidPan(pan) && isCompany(p) && pan[3] !== 'C')
        reasons.push('PAN holder type is not a company (4th character should be C)');
      return result(reasons);
    },
  },
  bank_proof: {
    key: 'bank_proof',
    label: 'Bank Proof',
    hint: 'Cancelled cheque or bank letter',
    group: 'Bank',
    fields: [
      { key: 'ifsc', label: 'IFSC', type: 'text', required: true, normalize: true },
      { key: 'accountNumber', label: 'Account number', type: 'text', required: true },
      { key: 'accountHolder', label: 'Account holder name', type: 'text' },
    ],
    requirement: () => 'required',
    verify: (f, p) => {
      const reasons: string[] = [];
      requireFields(f, ['ifsc', 'accountNumber'], reasons);
      const ifsc = normalizeId(f.ifsc ?? '');
      if (ifsc && !isValidIfsc(ifsc)) reasons.push('IFSC format is invalid');
      if (p.bank?.ifsc && ifsc && normalizeId(p.bank.ifsc) !== ifsc)
        reasons.push('IFSC does not match bank details in the profile');
      if (p.bank?.accountNumber && f.accountNumber && p.bank.accountNumber.trim() !== f.accountNumber.trim())
        reasons.push('Account number does not match bank details in the profile');
      const bank = resolveBank(ifsc);
      const derived: Record<string, string> = {};
      if (bank) {
        derived.bankCode = bank.code;
        if (bank.name) derived.bankName = bank.name;
      }
      return result(reasons, derived);
    },
  },
  msme: {
    key: 'msme',
    label: 'MSME / Udyam Certificate',
    hint: 'Udyam registration certificate',
    group: 'Compliance',
    fields: [
      { key: 'udyamNumber', label: 'Udyam number', type: 'text', required: true, normalize: true, placeholder: 'UDYAM-MH-26-0012345' },
      { key: 'enterpriseType', label: 'Enterprise type (Micro/Small/Medium)', type: 'text', required: true },
    ],
    requirement: (p) => (p.isMsme ? 'required' : 'hidden'),
    verify: (f) => {
      const reasons: string[] = [];
      requireFields(f, ['udyamNumber', 'enterpriseType'], reasons);
      if (f.udyamNumber && !UDYAM_RE.test(normalizeId(f.udyamNumber))) reasons.push('Udyam number format is invalid');
      if (f.enterpriseType && !/^(micro|small|medium)$/i.test(f.enterpriseType.trim()))
        reasons.push('Enterprise type must be Micro, Small or Medium');
      return result(reasons);
    },
  },
  fssai: {
    key: 'fssai',
    label: 'FSSAI License',
    hint: 'Food business operator license',
    group: 'Compliance',
    fields: [
      { key: 'licenseNumber', label: 'License number', type: 'text', required: true, placeholder: '14 digits' },
      { key: 'expiryDate', label: 'Valid until', type: 'date', required: true },
    ],
    requirement: (p) => (p.isFoodBusiness || p.category === 'food_ingredients' ? 'required' : 'hidden'),
    verify: (f) => {
      const reasons: string[] = [];
      requireFields(f, ['licenseNumber', 'expiryDate'], reasons);
      if (f.licenseNumber && !FSSAI_RE.test(f.licenseNumber.trim())) reasons.push('FSSAI number must be 14 digits');
      expiryCheck(f, reasons);
      return result(reasons);
    },
  },
  aadhaar: {
    key: 'aadhaar',
    label: 'Aadhaar (Proprietor)',
    hint: 'Masked Aadhaar of the proprietor — we only store the last 4 digits',
    group: 'Identity',
    fields: [
      { key: 'last4', label: 'Last 4 digits', type: 'text', required: true, placeholder: '1234' },
      { key: 'holderName', label: 'Holder name', type: 'text', required: true },
    ],
    requirement: (p) => (p.constitution === 'proprietorship' ? 'required' : 'hidden'),
    verify: (f) => {
      const reasons: string[] = [];
      requireFields(f, ['last4', 'holderName'], reasons);
      if (f.last4 && !/^[0-9]{4}$/.test(f.last4.trim())) reasons.push('Enter only the last 4 digits');
      return result(reasons);
    },
  },
  moa_aoa: {
    key: 'moa_aoa',
    label: 'MOA & AOA',
    hint: 'Memorandum and Articles of Association',
    group: 'Corporate',
    fields: [{ key: 'cin', label: 'CIN', type: 'text', required: true, normalize: true }],
    requirement: (p) => (isCompany(p) ? 'required' : 'hidden'),
    verify: (f) => {
      const reasons: string[] = [];
      requireFields(f, ['cin'], reasons);
      if (f.cin && !/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(normalizeId(f.cin)))
        reasons.push('CIN format is invalid');
      return result(reasons);
    },
  },
  board_resolution: {
    key: 'board_resolution',
    label: 'Board Resolution / Authorization',
    hint: 'Authorizing the signatory to transact',
    group: 'Corporate',
    fields: [
      { key: 'signatory', label: 'Authorized signatory', type: 'text', required: true },
      { key: 'resolutionDate', label: 'Resolution date', type: 'date', required: true },
    ],
    requirement: (p) => (isCompany(p) || p.constitution === 'llp' ? 'optional' : 'hidden'),
    verify: (f) => {
      const reasons: string[] = [];
      requireFields(f, ['signatory', 'resolutionDate'], reasons);
      return result(reasons);
    },
  },
  iec: {
    key: 'iec',
    label: 'Importer-Exporter Code',
    hint: 'IEC issued by DGFT',
    group: 'Trade',
    fields: [{ key: 'iec', label: 'IEC', type: 'text', required: true, normalize: true }],
    requirement: (p) => (p.isImportExport ? 'required' : 'hidden'),
    verify: (f) => {
      const reasons: string[] = [];
      requireFields(f, ['iec'], reasons);
      if (f.iec && !IEC_RE.test(normalizeId(f.iec))) reasons.push('IEC must be 10 alphanumeric characters');
      return result(reasons);
    },
  },
  ad_code: {
    key: 'ad_code',
    label: 'AD Code Certificate',
    hint: 'Authorized Dealer code registered with customs',
    group: 'Trade',
    fields: [{ key: 'adCode', label: 'AD code', type: 'text', required: true, normalize: true }],
    requirement: (p) => (p.isImportExport ? 'required' : 'hidden'),
    verify: (f) => {
      const reasons: string[] = [];
      requireFields(f, ['adCode'], reasons);
      if (f.adCode && !/^[0-9]{7,14}$/.test(normalizeId(f.adCode))) reasons.push('AD code must be 7–14 digits');
      return result(reasons);
    },
  },
  rcmc: {
    key: 'rcmc',
    label: 'RCMC',
    hint: 'Registration-cum-Membership Certificate',
    group: 'Trade',
    fields: [
      { key: 'rcmcNumber', label: 'RCMC number', type: 'text', required: true },
      { key: 'expiryDate', label: 'Valid until', type: 'date', required: true },
    ],
    requirement: (p) => (p.isImportExport ? 'optional' : 'hidden'),
    verify: (f) => {
      const reasons: string[] = [];
      requireFields(f, ['rcmcNumber', 'expiryDate'], reasons);
      expiryCheck(f, reasons);
      return result(reasons);
    },
  },
  dsc: {
    key: 'dsc',
    label: 'Digital Signature Certificate',
    hint: 'Class 3 DSC of the authorized signatory',
    group: 'Identity',
    fields: [
      { key: 'serialNumber', label: 'Certificate serial number', type: 'text', required: true },
      { key: 'holderName', label: 'Holder name', type: 'text', required: true },
      { key: 'expiryDate', label: 'Valid until', type: 'date', required: true },
    ],
    requirement: () => 'optional',
    verify: (f) => {
      const reasons: string[] = [];
      requireFields(f, ['serialNumber', 'holderName', 'expiryDate'], reasons);
      expiryCheck(f, reasons);
      return result(reasons);
    },
  },
  other: {
    key: 'other',
    label: 'Other Documents',
    hint: 'Anything else that supports the application',
    group: 'Other',
    fields: [{ key: 'description', label: 'Description', type: 'text', required: true }],
    requirement: () => 'optional',
    verify: (f) => {
      const reasons: string[] = [];
      requireFields(f, ['description'], reasons);
      return result(reasons);
    },
  },
};

export const DOCUMENT_LIST: DocumentType[] = DOCUMENT_KEYS.map((k) => DOCUMENTS[k]);

/** Documents that apply to this profile, in display order. */
export function applicableDocuments(p: VendorDraft) {
  return DOCUMENT_LIST.map((d) => ({ doc: d, requirement: d.requirement(p) })).filter(
    (x) => x.requirement !== 'hidden',
  );
}

export function requiredDocumentKeys(p: VendorDraft): DocumentKey[] {
  return DOCUMENT_LIST.filter((d) => d.requirement(p) === 'required').map((d) => d.key);
}

/** Normalizes values per field config and drops unknown keys. */
export function sanitizeDocFields(key: DocumentKey, input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of DOCUMENTS[key].fields) {
    const v = input[field.key];
    if (v === undefined || v === null) continue;
    const s = String(v).trim().slice(0, 300);
    out[field.key] = field.normalize ? normalizeId(s) : s;
  }
  return out;
}

function namesMatch(a: string, b: string) {
  const clean = (s: string) =>
    s
      .toUpperCase()
      .replace(/\b(PRIVATE|PVT|LIMITED|LTD|LLP|M\/S|THE)\b/g, '')
      .replace(/[^A-Z0-9]/g, '');
  return clean(a) === clean(b);
}
