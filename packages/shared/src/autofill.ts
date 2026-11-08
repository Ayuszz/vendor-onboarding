import type { DocumentKey } from './documents.js';
import { isValidGstin, isValidIfsc, isValidPan, normalizeId } from './validators.js';
import type { Constitution, VendorDraft } from './vendor.js';

/**
 * Builds the company profile from the documents a vendor uploaded, so nothing that is
 * printed on a certificate has to be typed again. Pure and shared by the browser and the server.
 */

/** GSTIN state codes (first two digits). */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

type Fields = Record<string, string>;
export type DocFieldsByKey = Partial<Record<DocumentKey, Fields>>;

/** Which document each auto-filled value came from, keyed by a path such as "address.city". */
export type FieldSources = Record<string, string>;

const titleCase = (s: string) =>
  s === s.toUpperCase() ? s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Pvt|Ltd|Llp|Llc)\b/g, (w) => ({ Pvt: 'Pvt', Ltd: 'Ltd', Llp: 'LLP', Llc: 'LLC' })[w] ?? w) : s;

export function constitutionFrom(text: string | undefined, pan: string | undefined): Constitution | undefined {
  const t = (text ?? '').toLowerCase();
  if (t) {
    if (/limited liability partnership|\bllp\b/.test(t)) return 'llp';
    if (/public\s+limited|public\s+company|\bpublic\b/.test(t)) return 'public_limited';
    if (/private\s+limited|pvt|private\s+company|\bprivate\b|company/.test(t)) return 'private_limited';
    if (/partnership|firm/.test(t)) return 'partnership';
    if (/proprietor/.test(t)) return 'proprietorship';
    if (/trust|society|association/.test(t)) return 'trust';
  }
  const p = normalizeId(pan ?? '');
  if (p && isValidPan(p)) {
    // 4th character of a PAN is the holder type.
    return ({ C: 'private_limited', F: 'partnership', P: 'proprietorship', T: 'trust', A: 'trust', B: 'other', G: 'other', J: 'other', L: 'other', H: 'other' } as Record<string, Constitution>)[p[3]!];
  }
  return undefined;
}

/** Splits a one-line Indian address into the fields of the form. */
export function parseAddress(raw: string, gstin?: string): VendorDraft['address'] {
  const text = raw.replace(/\s+/g, ' ').trim();
  const pin = /\b(\d{6})\b/.exec(text);
  const stateFromCode = gstin && isValidGstin(normalizeId(gstin)) ? GST_STATES[normalizeId(gstin).slice(0, 2)] : undefined;
  const names = [...new Set(Object.values(GST_STATES))].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const found = names.find((n) => lower.includes(n.toLowerCase()));
  const state = found ?? stateFromCode;
  let body = pin ? text.slice(0, pin.index) : text;
  if (found) body = body.slice(0, lower.lastIndexOf(found.toLowerCase()));
  const parts = body.split(',').map((x) => x.replace(/[-–\s]+$/, '').trim()).filter(Boolean);
  const out: NonNullable<VendorDraft['address']> = { country: 'IN' };
  if (pin) out.pincode = pin[1]!;
  if (state) out.state = state;
  if (parts.length >= 2) {
    out.city = parts[parts.length - 1]!;
    const rest = parts.slice(0, -1);
    out.line1 = rest.slice(0, 2).join(', ');
    if (rest.length > 2) out.line2 = rest.slice(2).join(', ');
  } else if (parts.length === 1) out.line1 = parts[0]!;
  return out;
}

/** The profile fields that can be read from the uploaded documents, and where each one came from. */
export function deriveProfile(docs: DocFieldsByKey): { profile: VendorDraft; sources: FieldSources } {
  const profile: VendorDraft = {};
  const sources: FieldSources = {};
  const set = (path: string, src: string, apply: () => void) => {
    apply();
    sources[path] = src;
  };

  const gst = docs.gst, pan = docs.pan, bank = docs.bank_proof;
  const legal = gst?.legalName?.trim() || pan?.nameOnPan?.trim();
  if (legal) set('legalName', gst?.legalName?.trim() ? 'GST certificate' : 'PAN card', () => (profile.legalName = titleCase(legal)));
  const trade = gst?.tradeName?.trim();
  if (trade && trade.toLowerCase() !== legal?.toLowerCase()) set('tradeName', 'GST certificate', () => (profile.tradeName = titleCase(trade)));
  const c = constitutionFrom(gst?.constitution, pan?.pan);
  if (c) set('constitution', gst?.constitution ? 'GST certificate' : 'PAN card', () => (profile.constitution = c));

  if (gst?.address || gst?.gstin) {
    const a = parseAddress(gst.address ?? '', gst.gstin) ?? {};
    for (const [k, v] of Object.entries(a)) if (v && k !== 'country') set(`address.${k}`, 'GST certificate', () => ((profile.address ??= {})[k as 'line1'] = v));
    if (Object.keys(a).length) (profile.address ??= {}).country = 'IN';
  }

  if (bank) {
    const acc = bank.accountNumber?.replace(/\D/g, '');
    const ifsc = normalizeId(bank.ifsc ?? '');
    if (acc) set('bank.accountNumber', 'Bank proof', () => ((profile.bank ??= {}).accountNumber = acc));
    if (ifsc && isValidIfsc(ifsc)) set('bank.ifsc', 'Bank proof', () => ((profile.bank ??= {}).ifsc = ifsc));
    const holder = bank.accountHolder?.trim() || legal;
    if (holder) set('bank.accountHolder', bank.accountHolder?.trim() ? 'Bank proof' : 'Company name', () => ((profile.bank ??= {}).accountHolder = titleCase(holder)));
  }
  return { profile, sources };
}
