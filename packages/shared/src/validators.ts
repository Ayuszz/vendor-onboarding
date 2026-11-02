/**
 * Pure, dependency-free validators for Indian statutory identifiers.
 * These run on both client (instant feedback) and server (source of truth).
 */

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const PINCODE_RE = /^[1-9][0-9]{5}$/;
export const FSSAI_RE = /^[0-9]{14}$/;
export const UDYAM_RE = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
export const IEC_RE = /^[A-Z0-9]{10}$/;
export const ACCOUNT_NO_RE = /^[0-9]{9,18}$/;
export const PHONE_RE = /^[6-9][0-9]{9}$/;

const GST_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GST_SHAPE_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Computes the GSTIN check character for the first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GST_CHARSET.indexOf(first14[i]!);
    if (value < 0) throw new Error('invalid GSTIN character');
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GST_CHARSET[(36 - (sum % 36)) % 36]!;
}

export function isValidGstin(raw: string): boolean {
  const gstin = normalizeId(raw);
  if (!GST_SHAPE_RE.test(gstin)) return false;
  const state = Number(gstin.slice(0, 2));
  if (state < 1 || state > 38) return false;
  return gstinCheckChar(gstin.slice(0, 14)) === gstin[14];
}

/** The PAN embedded in a GSTIN (characters 3–12). */
export const panFromGstin = (gstin: string) => normalizeId(gstin).slice(2, 12);

export const isValidPan = (raw: string) => PAN_RE.test(normalizeId(raw));
export const isValidIfsc = (raw: string) => IFSC_RE.test(normalizeId(raw));

export const normalizeId = (raw: string) => raw.trim().toUpperCase().replace(/\s+/g, '');

/**
 * Bank resolution from IFSC. The first four characters of an IFSC *are* the bank
 * code, so this replaces fragile bank-name string matching with a deterministic lookup.
 * Unknown codes are still valid IFSCs — they just resolve without a display name.
 */
export const BANKS: Record<string, string> = {
  SBIN: 'State Bank of India',
  HDFC: 'HDFC Bank',
  ICIC: 'ICICI Bank',
  UTIB: 'Axis Bank',
  KKBK: 'Kotak Mahindra Bank',
  PUNB: 'Punjab National Bank',
  BARB: 'Bank of Baroda',
  CNRB: 'Canara Bank',
  UBIN: 'Union Bank of India',
  BKID: 'Bank of India',
  IDIB: 'Indian Bank',
  CBIN: 'Central Bank of India',
  IOBA: 'Indian Overseas Bank',
  UCBA: 'UCO Bank',
  MAHB: 'Bank of Maharashtra',
  PSIB: 'Punjab & Sind Bank',
  YESB: 'Yes Bank',
  INDB: 'IndusInd Bank',
  IDFB: 'IDFC FIRST Bank',
  FDRL: 'Federal Bank',
  KARB: 'Karnataka Bank',
  SIBL: 'South Indian Bank',
  RATN: 'RBL Bank',
  AUBL: 'AU Small Finance Bank',
  KVBL: 'Karur Vysya Bank',
  TMBL: 'Tamilnad Mercantile Bank',
  DBSS: 'DBS Bank India',
  CITI: 'Citibank',
  HSBC: 'HSBC',
  SCBL: 'Standard Chartered Bank',
  SVCB: 'SVC Co-operative Bank',
  COSB: 'Cosmos Co-operative Bank',
};

export function resolveBank(ifsc: string): { code: string; name: string | null } | null {
  const v = normalizeId(ifsc);
  if (!IFSC_RE.test(v)) return null;
  const code = v.slice(0, 4);
  return { code, name: BANKS[code] ?? null };
}

/** True when an ISO date (yyyy-mm-dd) is strictly before `today`. */
export function isExpired(isoDate: string | undefined, today = new Date()): boolean {
  if (!isoDate) return false;
  const d = new Date(`${isoDate}T23:59:59Z`);
  return !Number.isNaN(d.getTime()) && d.getTime() < today.getTime();
}
