import { describe, expect, it } from 'vitest';
import { extractFields, gstinCheckChar } from '../src/index.js';

const GSTIN = '27AABCU9603R1Z' + gstinCheckChar('27AABCU9603R1Z');

describe('GST certificate', () => {
  it('reads GSTIN and legal name from a clean certificate', () => {
    const text = `Government of India\nForm GST REG-06\nRegistration Certificate\nRegistration Number : ${GSTIN}\n1. Legal Name  ACME PACKAGING PRIVATE LIMITED\n2. Trade Name, if any  ACME`;
    expect(extractFields('gst', text).fields).toEqual({ gstin: GSTIN, legalName: 'ACME PACKAGING PRIVATE LIMITED', tradeName: 'ACME' });
  });

  it('repairs OCR confusions and spaces inside the GSTIN', () => {
    // 0→O, 1→I, spaces inserted, lower case
    const noisy = GSTIN.replace(/0/g, 'O').replace(/1/g, 'I').toLowerCase().replace(/(.{5})/g, '$1 ');
    expect(extractFields('gst', `Registration Number: ${noisy}`).fields.gstin).toBe(GSTIN);
  });

  it('does not guess when the checksum fails', () => {
    expect(extractFields('gst', 'GSTIN 27AABCU9603R1ZX').found).not.toContain('gstin');
  });
});

describe('PAN card', () => {
  it('reads PAN and the name line', () => {
    const text = `INCOME TAX DEPARTMENT\nGOVT. OF INDIA\nPermanent Account Number Card\nAABCU96O3R\nName\nACME PACKAGING PRIVATE LIMITED\nDate of Incorporation\n12/04/2015`;
    expect(extractFields('pan', text).fields).toEqual({ pan: 'AABCU9603R', nameOnPan: 'ACME PACKAGING PRIVATE LIMITED' });
  });
});

describe('cancelled cheque / bank letter', () => {
  it('reads IFSC and account number', () => {
    const text = `HDFC BANK\nKolhapur Branch\nIFSC: HDFCOOO1234\nA/C No. 5010 0234 5678 12\nPay ____________ or bearer`;
    expect(extractFields('bank_proof', text).fields).toEqual({ ifsc: 'HDFC0001234', accountNumber: '50100234567812' });
  });
});

describe('Udyam certificate', () => {
  it('reads Udyam number and enterprise type', () => {
    const text = `UDYAM REGISTRATION CERTIFICATE\nUDYAM REGISTRATION NUMBER UDYAM-MH-26-0012345\nTYPE OF ENTERPRISE  MICRO`;
    expect(extractFields('msme', text).fields).toEqual({ udyamNumber: 'UDYAM-MH-26-0012345', enterpriseType: 'Micro' });
  });
});

describe('FSSAI license', () => {
  it('reads the license number and expiry in several date formats', () => {
    expect(extractFields('fssai', 'License No. 1152 1998 0001 23\nValid Upto: 31/03/2029').fields).toEqual({
      licenseNumber: '11521998000123',
      expiryDate: '2029-03-31',
    });
    expect(extractFields('fssai', 'Registration Number 11521998000123\nValid till 5 Mar 2028').fields.expiryDate).toBe('2028-03-05');
  });
});
