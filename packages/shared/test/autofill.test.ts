import { describe, expect, it } from 'vitest';
import { constitutionFrom, deriveProfile, extractFields, parseAddress } from '../src/index.js';

const GST_TEXT = `Government of India
Registration Certificate
Registration Number: 27ABCCA1234D1ZA
Legal Name: ACME PARTS PRIVATE LIMITED
Trade Name: Acme Parts
Constitution of Business: Private Limited Company
Principal Place of Business: 12 Industrial Area, MIDC,
Pune, Maharashtra 411019
Date of Liability: 01/04/2022`;

describe('reading the GST certificate', () => {
  it('extracts name, constitution and a multi-line address', () => {
    const { fields } = extractFields('gst', GST_TEXT);
    expect(fields.gstin).toBe('27ABCCA1234D1ZA');
    expect(fields.legalName).toBe('ACME PARTS PRIVATE LIMITED');
    expect(fields.tradeName).toBe('Acme Parts');
    expect(fields.constitution).toMatch(/Private Limited/);
    expect(fields.address).toMatch(/Pune, Maharashtra 411019$/);
  });
});

describe('parseAddress', () => {
  it('splits street, city, state and PIN', () => {
    expect(parseAddress('12 Industrial Area, MIDC, Pune, Maharashtra 411019')).toEqual({
      country: 'IN', pincode: '411019', state: 'Maharashtra', city: 'Pune', line1: '12 Industrial Area, MIDC',
    });
  });
  it('falls back to the GSTIN state code when the state name is missing', () => {
    expect(parseAddress('Plot 4, Hosur Road, Bengaluru 560100', '29ABCCA1234D1Z6')?.state).toBe('Karnataka');
  });
});

describe('constitutionFrom', () => {
  it('prefers the certificate text, then the PAN holder type', () => {
    expect(constitutionFrom('Limited Liability Partnership', undefined)).toBe('llp');
    expect(constitutionFrom('Proprietorship', 'ABCPA1234D')).toBe('proprietorship');
    expect(constitutionFrom(undefined, 'ABCCA1234D')).toBe('private_limited');
    expect(constitutionFrom(undefined, 'ABCPA1234D')).toBe('proprietorship');
  });
});

describe('deriveProfile', () => {
  it('fills company, address and bank from the documents and says where each came from', () => {
    const { profile, sources } = deriveProfile({
      gst: extractFields('gst', GST_TEXT).fields,
      pan: { pan: 'ABCCA1234D', nameOnPan: 'ACME PARTS PRIVATE LIMITED' },
      bank_proof: { ifsc: 'HDFC0001234', accountNumber: '123456789012' },
    });
    expect(profile).toMatchObject({
      legalName: 'Acme Parts Private Limited',
      tradeName: 'Acme Parts',
      constitution: 'private_limited',
      address: { city: 'Pune', state: 'Maharashtra', pincode: '411019' },
      bank: { ifsc: 'HDFC0001234', accountNumber: '123456789012', accountHolder: 'Acme Parts Private Limited' },
    });
    expect(sources['legalName']).toBe('GST certificate');
    expect(sources['bank.accountNumber']).toBe('Bank proof');
    expect(sources['bank.accountHolder']).toBe('Company name');
  });
  it('returns nothing it cannot read', () => {
    expect(deriveProfile({}).profile).toEqual({});
  });
});
