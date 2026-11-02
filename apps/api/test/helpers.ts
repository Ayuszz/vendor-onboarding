import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gstinCheckChar, type VendorDraft, type VendorDTO } from '@vo/shared';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { migrate } from '../src/db/migrations.js';
import { seed } from '../src/db/seed.js';
import { MockSapClient } from '../src/integrations/sap.js';
import { localStorage } from '../src/storage.js';

export interface TestCtx {
  app: App;
  db: Db;
  sap: MockSapClient;
  tokens: Record<'requester' | 'qc' | 'scm' | 'finance' | 'admin', string>;
  close(): Promise<void>;
}

export async function setup(): Promise<TestCtx> {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'vo-uploads-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    WORKER_ENABLED: 'false',
    SAP_MAX_ATTEMPTS: '3',
    UPLOAD_DIR: uploadDir,
  });
  const db = await createDb({ pgliteDir: 'memory://' });
  await migrate(db);
  await seed(db);
  const sap = new MockSapClient();
  const app = await buildApp({ cfg, db, storage: localStorage(uploadDir), sap, backoffBaseMs: 0 });
  await app.ready();

  const login = async (userId: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { userId } });
    return (r.json() as { token: string }).token;
  };
  const tokens = {
    requester: await login('u_requester'),
    qc: await login('u_qc'),
    scm: await login('u_scm'),
    finance: await login('u_finance'),
    admin: await login('u_admin'),
  };
  return {
    app,
    db,
    sap,
    tokens,
    close: async () => {
      await app.close();
      await db.close();
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
export const GSTIN = '27AABCU9603R1Z' + gstinCheckChar('27AABCU9603R1Z');

export const completeProfile: VendorDraft = {
  legalName: 'Acme Packaging Private Limited',
  tradeName: 'Acme',
  constitution: 'private_limited',
  category: 'packaging',
  isMsme: false,
  isImportExport: false,
  isFoodBusiness: false,
  paymentTermsDays: 45,
  contact: { name: 'Neha Joshi', email: 'neha@acme.test', phone: '9876543210' },
  address: { line1: 'Plot 12, MIDC', line2: '', city: 'Kolhapur', state: 'Maharashtra', pincode: '416234', country: 'IN' },
  bank: { accountHolder: 'Acme Packaging Pvt Ltd', accountNumber: '123456789012', ifsc: 'HDFC0001234' },
};

export const validDocs: Record<string, Record<string, string>> = {
  pan: { pan: 'AABCU9603R', nameOnPan: 'Acme Packaging Private Limited' },
  gst: { gstin: GSTIN, legalName: 'Acme Packaging Pvt Ltd' },
  bank_proof: { ifsc: 'HDFC0001234', accountNumber: '123456789012' },
  moa_aoa: { cin: 'U25209MH2015PTC123456' },
};

/** Builds a multipart/form-data body for app.inject. */
export function multipart(fields: Record<string, unknown>, file?: { name: string; data: Buffer; type?: string }) {
  const boundary = '----vo' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  const push = (s: string) => chunks.push(Buffer.from(s));
  push(`--${boundary}\r\nContent-Disposition: form-data; name="fields"\r\n\r\n${JSON.stringify(fields)}\r\n`);
  if (file) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/pdf'}\r\n\r\n`,
    );
    chunks.push(file.data);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export function api(ctx: TestCtx) {
  const call = async (
    who: keyof TestCtx['tokens'],
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const r = await ctx.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${ctx.tokens[who]}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    return { status: r.statusCode, body: r.json() as any };
  };
  const upload = async (who: keyof TestCtx['tokens'], id: string, key: string, fields: Record<string, string>, withFile = true) => {
    const mp = multipart(fields, withFile ? { name: `${key}.pdf`, data: PDF } : undefined);
    const r = await ctx.app.inject({
      method: 'PUT',
      url: `/api/vendors/${id}/documents/${key}`,
      headers: { authorization: `Bearer ${ctx.tokens[who]}`, ...mp.headers },
      payload: mp.payload,
    });
    return { status: r.statusCode, body: r.json() as any };
  };
  return { call, upload };
}

/** Creates a vendor with a complete profile and all required documents verified. */
export async function readyVendor(ctx: TestCtx): Promise<VendorDTO> {
  const { call, upload } = api(ctx);
  const created = await call('requester', 'POST', '/api/vendors', { profile: completeProfile });
  const id = created.body.id as string;
  for (const [key, fields] of Object.entries(validDocs)) await upload('requester', id, key, fields);
  await ctx.app.worker.drain();
  return (await call('requester', 'GET', `/api/vendors/${id}`)).body;
}
