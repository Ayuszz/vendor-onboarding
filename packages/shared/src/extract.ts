import type { DocumentKey } from './documents.js';
import { BANKS, FSSAI_RE, IFSC_RE, UDYAM_RE, isValidGstin, isValidPan, normalizeId } from './validators.js';

/**
 * Turns raw text from a document (PDF text layer or OCR) into form fields.
 *
 * Pure functions, shared by the browser (to prefill the form the moment a file is
 * chosen) and available to the server. OCR output is noisy, so each extractor:
 *  - searches near the label it expects ("Legal Name", "IFSC", "Valid upto"…),
 *  - repairs the classic OCR confusions (O↔0, I/l↔1, S↔5, B↔8) only inside
 *    positions that must be digits or letters,
 *  - validates candidates (GSTIN checksum, PAN shape, IFSC shape) before accepting.
 * Anything it cannot find confidently is left out, never guessed.
 */

export interface Extraction {
  fields: Record<string, string>;
  /** Field keys that were found in the text. */
  found: string[];
}

const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', Z: '2', S: '5', B: '8', G: '6', T: '7' };
const TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '6': 'G', '7': 'T' };

/** Re-types each character to digit or letter according to a pattern of D/A/X (X = either). */
function coerce(raw: string, pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = raw[i] ?? '';
    const p = pattern[i];
    if (p === 'D') out += /\d/.test(c) ? c : (TO_DIGIT[c] ?? c);
    else if (p === 'A') out += /[A-Z]/.test(c) ? c : (TO_LETTER[c] ?? c);
    else out += c;
  }
  return out;
}

const lines = (text: string) =>
  text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

/** Sliding windows of N alphanumeric characters (spaces and punctuation removed). */
function windows(text: string, n: number): string[] {
  const flat = text.toUpperCase().replace(/[^A-Z0-9|]/g, '');
  const out: string[] = [];
  for (let i = 0; i + n <= flat.length; i++) out.push(flat.slice(i, i + n));
  return out;
}

/** Value on the same line after a label, or on the next line. */
function afterLabel(text: string, labels: RegExp): string | null {
  const ls = lines(text);
  for (let i = 0; i < ls.length; i++) {
    const m = labels.exec(ls[i]!);
    if (!m) continue;
    const rest = ls[i]!.slice(m.index + m[0].length).replace(/^[\s:.\-–—]+/, '').trim();
    if (rest.length >= 2) return rest;
    const next = ls[i + 1];
    if (next && next.length >= 2) return next;
  }
  return null;
}

const cleanName = (s: string | null) =>
  s
    ?.replace(/[^A-Za-z0-9&.,'()\-/ ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || null;

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/** Finds a date near a label and returns it as yyyy-mm-dd. Accepts dd/mm/yyyy, dd-mm-yyyy, dd Mon yyyy. */
export function findDate(text: string, labels: RegExp): string | null {
  const ls = lines(text);
  const parse = (s: string): string | null => {
    let m = /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(s);
    if (m) {
      const [, d, mo, y] = m;
      if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31)
        return `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
    }
    m = /(\d{1,2})[\s-]*([A-Za-z]{3})[A-Za-z]*[\s,-]*(\d{4})/.exec(s);
    if (m && MONTHS[m[2]!.toUpperCase()]) return `${m[3]}-${MONTHS[m[2]!.toUpperCase()]}-${m[1]!.padStart(2, '0')}`;
    m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
  };
  for (let i = 0; i < ls.length; i++) {
    if (!labels.test(ls[i]!)) continue;
    const d = parse(ls[i]!) ?? (ls[i + 1] ? parse(ls[i + 1]!) : null);
    if (d) return d;
  }
  return null;
}

export function findGstin(text: string): string | null {
  for (const w of windows(text, 15)) {
    const c = coerce(w, 'DDAAAAADDDDAXZX');
    // Positions 13 and 15 may be a digit or a letter; OCR can turn 1 into I there, so try both readings.
    const alt = (ch: string) => [...new Set([ch, TO_DIGIT[ch] ?? ch])];
    for (const a of alt(c[12]!)) for (const b of alt(c[14]!)) {
      const candidate = c.slice(0, 12) + a + 'Z' + b;
      if (isValidGstin(candidate)) return candidate;
    }
  }
  return null;
}

export function findPan(text: string, avoidInsideGstin = true): string | null {
  const gstin = avoidInsideGstin ? findGstin(text) : null;
  for (const w of windows(text, 10)) {
    const c = coerce(w, 'AAAAADDDDA');
    if (isValidPan(c) && !(gstin && gstin.slice(2, 12) === c && !/PAN|PERMANENT/i.test(text))) return c;
  }
  // A GSTIN always embeds the PAN.
  return gstin ? gstin.slice(2, 12) : null;
}

export function findIfsc(text: string): string | null {
  const scan = (t: string, knownBankOnly: boolean) => {
    for (const w of windows(t, 11)) {
      if (w[4] !== '0' && w[4] !== 'O') continue; // 5th character of an IFSC is always zero
      const c = coerce(w, 'AAAADXXXXXX');
      // Branch codes are nearly always numeric: when most of the tail is digits, read O/I/S… as digits too.
      let tail = c.slice(5);
      if ((tail.match(/\d/g) ?? []).length >= 3) tail = coerce(tail, 'DDDDDD').replace(/[^0-9A-Z]/g, '');
      const fixed = c.slice(0, 4) + '0' + tail;
      if (IFSC_RE.test(fixed) && (!knownBankOnly || BANKS[fixed.slice(0, 4)])) return fixed;
    }
    return null;
  };
  // Prefer the value printed next to an "IFSC" label; otherwise accept only known bank codes.
  const near = afterLabel(text, /IFS\s*C(ODE)?/i);
  return (near && scan(near, false)) || scan(text, true);
}

export function findAccountNumber(text: string): string | null {
  const ls = lines(text);
  const label = /(A\/?C|ACCOUNT|ACCT)\s*(NO|NUMBER|#)?/i;
  for (let i = 0; i < ls.length; i++) {
    if (!label.test(ls[i]!)) continue;
    for (const l of [ls[i]!, ls[i + 1] ?? '']) {
      const m = /(?:\d[\s-]?){9,18}/.exec(l.replace(/[OoQ]/g, '0'));
      if (m) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length >= 9 && digits.length <= 18) return digits;
      }
    }
  }
  // Fallback: the longest 9–18 digit run that is not a phone number or IFSC-adjacent.
  const runs = (text.match(/\b\d{9,18}\b/g) ?? []).filter((r) => !/^[6-9]\d{9}$/.test(r));
  return runs.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function findUdyam(text: string): string | null {
  const flat = text.toUpperCase().replace(/\s+/g, '');
  const m = /UDYAM[-–]?([A-Z]{2})[-–]?(\d{2})[-–]?(\d{7})/.exec(flat.replace(/[O]/g, (c, i, s) => (/\d/.test(s[i - 1] ?? '') ? '0' : c)));
  if (!m) return null;
  const v = `UDYAM-${m[1]}-${m[2]}-${m[3]}`;
  return UDYAM_RE.test(v) ? v : null;
}

export function findFssai(text: string): string | null {
  const ls = lines(text);
  const label = /(LICEN[CS]E|REGISTRATION|FSSAI|LIC\.?)\s*(NO|NUMBER)?/i;
  const pick = (l: string) => {
    const m = /(?:\d\s?){14}/.exec(l.replace(/[OoQ]/g, '0'));
    const d = m?.[0].replace(/\s/g, '');
    return d && FSSAI_RE.test(d) ? d : null;
  };
  for (let i = 0; i < ls.length; i++) if (label.test(ls[i]!)) {
    const d = pick(ls[i]!) ?? pick(ls[i + 1] ?? '');
    if (d) return d;
  }
  for (const l of ls) {
    const d = pick(l);
    if (d) return d;
  }
  return null;
}

/** Address after a label, continued over following lines until a 6-digit PIN code ends it. */
export function findAddress(text: string): string | null {
  const ls = lines(text);
  const label = /(PRINCIPAL\s*PLACE\s*OF\s*BUSINESS|REGISTERED\s*ADDRESS|ADDRESS\s*OF\s*(THE\s*)?(PRINCIPAL|BUSINESS)|^ADDRESS\b)/i;
  for (let i = 0; i < ls.length; i++) {
    const m = label.exec(ls[i]!);
    if (!m) continue;
    let acc = ls[i]!.slice(m.index + m[0].length).replace(/^[\s:.\-–—]+/, '');
    for (let j = i + 1; j < Math.min(i + 5, ls.length) && !/\b\d{6}\b/.test(acc); j++) acc += ' ' + ls[j]!;
    acc = acc.replace(/\s+/g, ' ').trim();
    const pin = /\b\d{6}\b/.exec(acc);
    const out = (pin ? acc.slice(0, pin.index + 6) : acc).slice(0, 240).trim();
    if (out.length >= 8) return out;
  }
  return null;
}

const put = (out: Extraction, key: string, value: string | null | undefined) => {
  if (value) {
    out.fields[key] = value;
    out.found.push(key);
  }
};

/** Extracts the registry fields for one document type from its text. */
export function extractFields(key: DocumentKey, text: string): Extraction {
  const out: Extraction = { fields: {}, found: [] };
  const T = text ?? '';
  switch (key) {
    case 'gst':
      put(out, 'gstin', findGstin(T));
      put(out, 'legalName', cleanName(afterLabel(T, /LEGAL\s*NAME(\s*OF\s*(THE\s*)?BUSINESS)?/i)));
      put(out, 'tradeName', cleanName(afterLabel(T, /TRADE\s*NAME(\s*,?\s*IF\s*ANY)?/i)));
      put(out, 'constitution', cleanName(afterLabel(T, /CONSTITUTION\s*OF\s*(THE\s*)?BUSINESS/i)));
      put(out, 'address', findAddress(T));
      break;
    case 'pan':
      put(out, 'pan', findPan(T));
      put(out, 'nameOnPan', cleanName(afterLabel(T, /^(NAME|नाम\s*\/?\s*NAME)\b/i)));
      break;
    case 'bank_proof':
      put(out, 'ifsc', findIfsc(T));
      put(out, 'accountNumber', findAccountNumber(T));
      put(out, 'accountHolder', cleanName(afterLabel(T, /(ACCOUNT\s*(HOLDER|NAME)|A\/C\s*(HOLDER|NAME)|NAME\s*OF\s*(THE\s*)?ACCOUNT\s*HOLDER|BENEFICIARY(\s*NAME)?)/i)));
      break;
    case 'msme': {
      put(out, 'udyamNumber', findUdyam(T));
      const t = /\b(MICRO|SMALL|MEDIUM)\b/i.exec(afterLabel(T, /(TYPE\s*OF\s*ENTERPRISE|ENTERPRISE\s*TYPE|CLASSIFICATION)/i) ?? T);
      put(out, 'enterpriseType', t ? t[1]![0]!.toUpperCase() + t[1]!.slice(1).toLowerCase() : null);
      break;
    }
    case 'fssai':
      put(out, 'licenseNumber', findFssai(T));
      put(out, 'expiryDate', findDate(T, /(VALID\s*(UP\s*TO|UPTO|TILL|UNTIL)|EXPIRY|EXPIRES|VALIDITY)/i));
      break;
    case 'iec':
      put(out, 'iec', normalizeId(afterLabel(T, /(IEC|IMPORTER[-\s]*EXPORTER\s*CODE)\s*(NO|NUMBER)?/i) ?? '').slice(0, 10) || null);
      break;
    case 'moa_aoa': {
      const m = /[LU]\s?\d{5}\s?[A-Z]{2}\s?\d{4}\s?[A-Z]{3}\s?\d{6}/.exec(T.toUpperCase());
      put(out, 'cin', m ? m[0].replace(/\s/g, '') : null);
      break;
    }
    case 'rcmc':
    case 'dsc':
      put(out, 'expiryDate', findDate(T, /(VALID\s*(UP\s*TO|UPTO|TILL|UNTIL)|EXPIRY|EXPIRES|VALIDITY|NOT\s*AFTER)/i));
      break;
    default:
      break;
  }
  return out;
}
