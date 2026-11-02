import { describe, expect, it } from 'vitest';
import { DOCUMENTS, gstinCheckChar, requiredDocumentKeys, submissionBlockers, type VendorDraft } from '../src/index.js';

const company: VendorDraft = { constitution: 'private_limited', category: 'packaging', legalName: 'Acme Packaging Pvt Ltd' };

describe('requirements depend on the profile', () => {
  it('company needs MOA; proprietor needs Aadhaar; food needs FSSAI', () => {
    expect(requiredDocumentKeys(company)).toEqual(['gst', 'pan', 'bank_proof', 'moa_aoa']);
    expect(requiredDocumentKeys({ constitution: 'proprietorship' })).toContain('aadhaar');
    expect(requiredDocumentKeys({ category: 'food_ingredients' })).toContain('fssai');
    expect(requiredDocumentKeys({ isImportExport: true })).toEqual(expect.arrayContaining(['iec', 'ad_code']));
  });
});

describe('cross-document checks', () => {
  const gstin = '27AABCU9603R1Z' + gstinCheckChar('27AABCU9603R1Z');

  it('GST passes when its PAN matches the PAN document and the name matches', () => {
    const r = DOCUMENTS.gst.verify({ gstin, legalName: 'ACME PACKAGING PRIVATE LIMITED' }, company, {
      pan: { pan: 'AABCU9603R' },
    });
    expect(r).toMatchObject({ ok: true, derived: { stateCode: '27' } });
  });

  it('GST fails when the PAN inside it differs', () => {
    const r = DOCUMENTS.gst.verify({ gstin, legalName: 'Acme Packaging' }, company, { pan: { pan: 'AAACX1234Z' } });
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/PAN inside GSTIN/);
  });

  it('company PAN must have holder type C', () => {
    expect(DOCUMENTS.pan.verify({ pan: 'AAPFU0939F', nameOnPan: 'x' }, company, {}).ok).toBe(false);
  });

  it('bank proof must match profile bank details and resolves the bank', () => {
    const p: VendorDraft = { bank: { ifsc: 'HDFC0001234', accountNumber: '123456789012' } };
    expect(DOCUMENTS.bank_proof.verify({ ifsc: 'HDFC0001234', accountNumber: '123456789012' }, p, {})).toMatchObject({
      ok: true,
      derived: { bankCode: 'HDFC', bankName: 'HDFC Bank' },
    });
    expect(DOCUMENTS.bank_proof.verify({ ifsc: 'HDFC0001234', accountNumber: '999' }, p, {}).ok).toBe(false);
  });
});

describe('submission blockers', () => {
  it('lists missing profile fields and documents', () => {
    const b = submissionBlockers(company, { gst: { status: 'PENDING' } });
    expect(b[0]).toMatch(/Complete profile fields/);
    expect(b).toContain('GST Certificate is still being verified');
    expect(b).toContain('PAN Card not uploaded');
  });
});
