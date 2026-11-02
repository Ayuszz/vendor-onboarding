/**
 * In-browser demo backend.
 *
 * Built only with `npm run build:demo` (VITE_DEMO=1). It implements the same surface as
 * the HTTP client using the *same* shared workflow engine, document rules and readiness
 * checks the real API uses — so the demo behaves exactly like production, minus
 * persistence. Verification and SAP sync are simulated with short delays.
 */
import {
  DOCUMENTS,
  DOCUMENT_KEYS,
  availableActions,
  decide,
  gstinCheckChar,
  mergeDraft,
  pendingWith,
  requiredDocumentKeys,
  sanitizeDocFields,
  submissionBlockers,
  vendorDraftSchema,
  type ActionBody,
  type Approval,
  type DocumentDTO,
  type DocumentKey,
  type EventDTO,
  type OtpRequestResult,
  type SessionDTO,
  type Paged,
  type Role,
  type SapDTO,
  type State,
  type StatsDTO,
  type UserAction,
  type UserDTO,
  type VendorDTO,
  type VendorDraft,
  type VendorListItem,
} from '@vo/shared';
import type { ListParams } from './api';

class DemoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STAFF_PASSWORD = 'Demo@1234';
const USERS: UserDTO[] = [
  { id: 'u_requester', name: 'Riya Sharma', email: 'buyer@example.com', roles: ['REQUESTER'] },
  { id: 'u_qc', name: 'Arjun Patil', email: 'qc@example.com', roles: ['QC'] },
  { id: 'u_scm', name: 'Meera Kulkarni', email: 'scm@example.com', roles: ['SCM'] },
  { id: 'u_finance', name: 'Vikram Desai', email: 'finance@example.com', roles: ['FINANCE'] },
  { id: 'u_admin', name: 'Admin', email: 'admin@example.com', roles: ['ADMIN'] },
];
const STAFF_IDS = new Set(USERS.map((u) => u.id));
const codes = new Map<string, { code: string; expires: number; attempts: number; sentAt: number }>();

interface Doc extends DocumentDTO {
  revision: number;
  blob: Blob | null;
}
interface Vendor {
  id: string;
  reference: string;
  state: State;
  profile: VendorDraft;
  approvals: Approval[];
  docs: Map<DocumentKey, Doc>;
  sap: SapDTO | null;
  createdBy: string;
  vendorUserId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  onboardedAt: string | null;
  version: number;
  events: EventDTO[];
}

const db = new Map<string, Vendor>();
let refSeq = 1001;
let cardSeq = 10001;
let eventSeq = 1;
let currentUser: UserDTO | null = null;

const now = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REVIEWERS: Role[] = ['QC', 'SCM', 'FINANCE', 'ADMIN'];
const isReviewer = (u: UserDTO) => u.roles.some((r) => REVIEWERS.includes(r));
const owns = (u: UserDTO, v: Vendor) => v.createdBy === u.id || v.vendorUserId === u.id;
const canView = (u: UserDTO, v: Vendor) => isReviewer(u) || owns(u, v);
const canEdit = (u: UserDTO, v: Vendor) =>
  (v.state === 'DRAFT' || v.state === 'SENT_BACK') &&
  (u.roles.includes('ADMIN') || (u.roles.some((r) => r === 'REQUESTER' || r === 'VENDOR') && owns(u, v)));

function me(): UserDTO {
  if (!currentUser) throw new DemoError(401, 'UNAUTHORIZED', 'Sign in first');
  return currentUser;
}
function find(id: string, u: UserDTO) {
  const v = db.get(id);
  if (!v || !canView(u, v)) throw new DemoError(404, 'NOT_FOUND', 'Vendor not found');
  return v;
}
function log(v: Vendor, e: Omit<EventDTO, 'id' | 'at'>) {
  v.events.push({ id: eventSeq++, at: now(), ...e });
}
const docStatusMap = (v: Vendor) => Object.fromEntries([...v.docs].map(([k, d]) => [k, { status: d.status }]));
const touch = (v: Vendor) => {
  v.version++;
  v.updatedAt = now();
};

function toDTO(v: Vendor, u: UserDTO): VendorDTO {
  const snapshot = { state: v.state, approvals: v.approvals };
  let allowed = availableActions(snapshot, u.roles);
  if (!canEdit(u, v)) allowed = allowed.filter((a) => a !== 'submit');
  const editable = v.state === 'DRAFT' || v.state === 'SENT_BACK';
  return clone({
    id: v.id,
    reference: v.reference,
    state: v.state,
    profile: v.profile,
    approvals: v.approvals,
    documents: DOCUMENT_KEYS.filter((k) => v.docs.has(k)).map((k) => {
      const { revision: _r, blob: _b, ...dto } = v.docs.get(k)!;
      return dto;
    }),
    sap: v.sap,
    blockers: editable ? submissionBlockers(v.profile, docStatusMap(v)) : [],
    pendingWith: pendingWith(snapshot),
    allowedActions: allowed,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    version: v.version,
  });
}

// ── simulated background jobs ──

function verify(v: Vendor, key: DocumentKey, revision: number) {
  const doc = v.docs.get(key);
  if (!doc || doc.revision !== revision) return;
  const ctx = Object.fromEntries([...v.docs].map(([k, d]) => [k, d.fields]));
  const res = DOCUMENTS[key].verify(doc.fields, v.profile, ctx);
  doc.status = res.ok ? 'VERIFIED' : 'FAILED';
  doc.reasons = res.reasons;
  doc.derived = res.derived ?? {};
  doc.verifiedAt = now();
  touch(v);
  log(v, {
    action: res.ok ? 'document_verified' : 'document_failed',
    fromState: null,
    toState: null,
    actorName: 'System',
    role: 'SYSTEM',
    reason: null,
    detail: { document: key, reasons: res.reasons },
  });
}

function requeue(v: Vendor, key: DocumentKey, delay: number) {
  const doc = v.docs.get(key);
  if (!doc) return;
  doc.status = 'PENDING';
  doc.verifiedAt = null;
  doc.revision++;
  const rev = doc.revision;
  if (delay === 0) verify(v, key, rev);
  else setTimeout(() => verify(v, key, rev), delay);
}

function sapSync(v: Vendor, delay: number) {
  const run = () => {
    if (v.state !== 'SAP_PENDING' || !v.sap) return;
    const d = decide({ state: v.state, approvals: v.approvals }, 'sap_success', { kind: 'system' });
    if (!d.ok) return;
    v.sap = { ...v.sap, status: 'SYNCED', attempts: v.sap.attempts + 1, lastError: null, syncedAt: now() };
    const from = v.state;
    v.state = d.to;
    v.onboardedAt = now();
    touch(v);
    log(v, { action: 'sap_success', fromState: from, toState: d.to, actorName: 'System', role: 'SYSTEM', reason: null, detail: null });
  };
  if (delay === 0) run();
  else setTimeout(run, delay);
}

// ── operations (mirroring services/vendors.ts) ──

function create(u: UserDTO, draft: VendorDraft) {
  if (!u.roles.some((r) => r === 'REQUESTER' || r === 'VENDOR' || r === 'ADMIN'))
    throw new DemoError(403, 'FORBIDDEN', 'Only vendors and buyers can start an application');
  const isVendor = u.roles.includes('VENDOR');
  if (isVendor && [...db.values()].some((x) => x.vendorUserId === u.id))
    throw new DemoError(409, 'CONFLICT', 'Your company already has an application.');
  if (isVendor) draft = { ...draft, contact: { ...draft.contact, email: u.email } };
  const t = now();
  const v: Vendor = {
    id: crypto.randomUUID(),
    reference: `VO-${new Date().getFullYear()}-${refSeq++}`,
    state: 'DRAFT',
    profile: vendorDraftSchema.parse(draft),
    approvals: [],
    docs: new Map(),
    sap: null,
    createdBy: u.id,
    vendorUserId: isVendor ? u.id : null,
    createdAt: t,
    updatedAt: t,
    submittedAt: null,
    onboardedAt: null,
    version: 0,
    events: [],
  };
  log(v, { action: 'created', fromState: null, toState: 'DRAFT', actorName: u.name, role: isVendor ? 'VENDOR' : 'REQUESTER', reason: null, detail: null });
  db.set(v.id, v);
  return v;
}

function upload(u: UserDTO, v: Vendor, key: DocumentKey, input: Record<string, unknown>, file: Blob | null, name: string | null, delay: number) {
  if (!canEdit(u, v)) throw new DemoError(403, 'FORBIDDEN', 'Documents can only be changed while the vendor is a draft');
  if (DOCUMENTS[key].requirement(v.profile) === 'hidden')
    throw new DemoError(422, 'DOCUMENT_NOT_APPLICABLE', `${DOCUMENTS[key].label} does not apply to this vendor`);
  const existing = v.docs.get(key);
  if (!existing && !file) throw new DemoError(400, 'BAD_REQUEST', 'A file is required for the first upload');
  const doc: Doc = {
    key,
    status: 'PENDING',
    fields: sanitizeDocFields(key, input),
    reasons: [],
    derived: {},
    file: file ? { name: name ?? 'file.pdf', size: file.size, mimeType: file.type || 'application/pdf' } : (existing?.file ?? null),
    uploadedAt: now(),
    verifiedAt: null,
    revision: (existing?.revision ?? 0) + 1,
    blob: file ?? existing?.blob ?? null,
  };
  v.docs.set(key, doc);
  touch(v);
  log(v, { action: 'document_uploaded', fromState: null, toState: null, actorName: u.name, role: 'REQUESTER', reason: null, detail: { document: key } });
  const rev = doc.revision;
  if (delay === 0) verify(v, key, rev);
  else setTimeout(() => verify(v, key, rev), delay);
  if (key === 'pan' && v.docs.has('gst')) requeue(v, 'gst', delay);
}

function act(u: UserDTO, v: Vendor, action: UserAction, body: ActionBody, delay: number) {
  if (body.version !== undefined && body.version !== v.version)
    throw new DemoError(409, 'CONFLICT', 'This vendor was changed by someone else. Refresh and try again.');
  if (action === 'submit' && !canEdit(u, v)) throw new DemoError(403, 'FORBIDDEN', 'Only the requester can submit this vendor');
  const blockers = action === 'submit' ? submissionBlockers(v.profile, docStatusMap(v)) : [];
  const d = decide(
    { state: v.state, approvals: v.approvals },
    action,
    { kind: 'user', id: u.id, roles: u.roles },
    { submissionBlockers: blockers, ...(body.reason ? { reason: body.reason } : {}) },
  );
  if (!d.ok) throw new DemoError(d.code === 'FORBIDDEN' ? 403 : 422, d.code, d.message);
  for (const e of d.effects) {
    if (e.type === 'clear_approvals') v.approvals = [];
    if (e.type === 'record_approval') v.approvals = [...v.approvals, { role: e.role, by: u.name, at: now() }];
    if (e.type === 'enqueue_sap_sync') {
      v.sap = v.sap
        ? { ...v.sap, status: 'QUEUED', lastError: null }
        : { status: 'QUEUED', cardCode: `V${String(cardSeq++).padStart(6, '0')}`, attempts: 0, lastError: null, syncedAt: null };
      sapSync(v, delay * 2);
    }
  }
  const from = v.state;
  v.state = d.to;
  if (action === 'submit') v.submittedAt = now();
  touch(v);
  log(v, { action, fromState: from, toState: d.to, actorName: u.name, role: d.actingRole, reason: body.reason ?? null, detail: null });
}

function inQueue(u: UserDTO, v: Vendor) {
  const done = new Set(v.approvals.map((a) => a.role));
  return (
    (u.roles.includes('QC') && v.state === 'IN_REVIEW' && !done.has('QC')) ||
    (u.roles.includes('SCM') && v.state === 'IN_REVIEW' && !done.has('SCM')) ||
    (u.roles.includes('FINANCE') && (v.state === 'FINANCE_REVIEW' || v.state === 'SAP_ERROR')) ||
    (u.roles.includes('ADMIN') && v.state === 'SAP_ERROR') ||
    (u.roles.some((r) => r === 'REQUESTER' || r === 'VENDOR') && (v.state === 'DRAFT' || v.state === 'SENT_BACK'))
  );
}

function list(u: UserDTO, p: ListParams): Paged<VendorListItem> {
  const q = p.q?.toLowerCase();
  const rows = [...db.values()]
    .filter((v) => canView(u, v))
    .filter((v) => !p.state || v.state === p.state)
    .filter((v) => !q || (v.profile.legalName ?? '').toLowerCase().includes(q) || v.reference.toLowerCase().includes(q))
    .filter((v) => !p.queue || inQueue(u, v))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const offset = p.offset ?? 0;
  return {
    total: rows.length,
    items: rows.slice(offset, offset + (p.limit ?? 25)).map((v) => {
      const required = requiredDocumentKeys(v.profile);
      return {
        id: v.id,
        reference: v.reference,
        legalName: v.profile.legalName || 'Untitled vendor',
        category: v.profile.category ?? null,
        state: v.state,
        pendingWith: pendingWith({ state: v.state, approvals: v.approvals }),
        docs: { verified: required.filter((k) => v.docs.get(k)?.status === 'VERIFIED').length, required: required.length },
        updatedAt: v.updatedAt,
      };
    }),
  };
}

// ── seed data: run real actions so histories look genuine ──

function seed() {
  const by = (id: string) => USERS.find((x) => x.id === id)!;
  const R = by('u_requester');
  const pdf = new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' });
  const companies: [string, VendorDraft['category'], string, string, string, string, string, string][] = [
    ['Shree Gurudev Packaging Pvt Ltd', 'packaging', 'AABCS1234K', '27', 'Kolhapur', 'Maharashtra', '416001', 'SBIN0001234'],
    ['Kaveri Agro Foods Pvt Ltd', 'food_ingredients', 'AACCK4821M', '29', 'Mysuru', 'Karnataka', '570001', 'CNRB0002211'],
    ['Sahyadri Polymers Pvt Ltd', 'raw_material', 'AAGCS7781P', '27', 'Sangli', 'Maharashtra', '416416', 'HDFC0004321'],
    ['Deccan Logistics Pvt Ltd', 'logistics', 'AAHCD9921Q', '27', 'Pune', 'Maharashtra', '411001', 'ICIC0000987'],
    ['Varad Corrugators Pvt Ltd', 'packaging', 'AAKCV3310L', '27', 'Ichalkaranji', 'Maharashtra', '416115', 'UTIB0001122'],
  ];
  const ids = companies.map(([name, category, pan, st, city, state, pincode, ifsc], i) => {
    const food = category === 'food_ingredients';
    const v = create(R, {
      legalName: name,
      constitution: 'private_limited',
      category,
      isFoodBusiness: food,
      paymentTermsDays: 45,
      contact: { name: 'Sanjay Kulkarni', email: `accounts@${name.split(' ')[0]!.toLowerCase()}.in`, phone: '9822012345' },
      address: { line1: 'Plot 24, MIDC Industrial Area', city, state, pincode, country: 'IN' },
      bank: { accountHolder: name, accountNumber: '50100234567812', ifsc },
    });
    const g = `${st}${pan}1Z`;
    upload(R, v, 'pan', { pan, nameOnPan: name }, pdf, 'pan.pdf', 0);
    upload(R, v, 'gst', { gstin: g + gstinCheckChar(g), legalName: name }, pdf, 'gst-certificate.pdf', 0);
    upload(R, v, 'bank_proof', { ifsc, accountNumber: '50100234567812' }, pdf, 'cancelled-cheque.pdf', 0);
    upload(R, v, 'moa_aoa', { cin: `U25209MH2015PTC1234${String(i).padStart(2, '0')}` }, pdf, 'moa-aoa.pdf', 0);
    if (food) upload(R, v, 'fssai', { licenseNumber: '11521998000123', expiryDate: '2029-03-31' }, pdf, 'fssai.pdf', 0);
    return v;
  });
  const [a, b, c, d, e] = ids as [Vendor, Vendor, Vendor, Vendor, Vendor];
  const run = (uid: string, v: Vendor, action: UserAction, reason?: string) => act(by(uid), v, action, reason ? { reason } : {}, 0);
  run('u_requester', a, 'submit');
  run('u_qc', a, 'approve');
  run('u_scm', a, 'approve');
  run('u_finance', a, 'approve');
  run('u_requester', b, 'submit');
  run('u_scm', b, 'approve');
  run('u_qc', b, 'approve');
  run('u_requester', c, 'submit');
  run('u_qc', c, 'approve');
  run('u_requester', d, 'submit');
  run('u_scm', d, 'send_back', 'Bank proof is a passbook photo. Please upload a cancelled cheque instead.');
  run('u_requester', e, 'submit');
  const draft = create(R, { legalName: 'Panchganga Spices', constitution: 'proprietorship', category: 'food_ingredients', isMsme: true });
  upload(R, draft, 'pan', { pan: 'ABCPK1234', nameOnPan: 'Kiran Patil' }, pdf, 'pan.jpg', 0);
}
let seeded = false;

function sessionFor(u: UserDTO, withToken: boolean): SessionDTO {
  const mine = u.roles.includes('VENDOR') ? [...db.values()].find((v) => v.vendorUserId === u.id) : undefined;
  return { ...(withToken ? { token: `demo:${u.id}` } : {}), user: clone(u), vendorId: mine?.id ?? null };
}

// ── public surface (same shape as the HTTP `api`) ──

const LATENCY = 180;
const VERIFY_MS = 1100;
async function wrap<T>(fn: () => T): Promise<T> {
  if (!seeded) {
    seeded = true;
    seed();
  }
  await sleep(LATENCY);
  return fn();
}

export const demoApi = {
  staffLogin: (email: string, password: string) =>
    wrap((): SessionDTO => {
      const u = USERS.find((x) => STAFF_IDS.has(x.id) && x.email === email.trim().toLowerCase());
      if (!u || password !== STAFF_PASSWORD) throw new DemoError(401, 'UNAUTHORIZED', 'Email or password is incorrect');
      currentUser = u;
      return sessionFor(u, true);
    }),
  requestCode: (raw: string) =>
    wrap((): OtpRequestResult => {
      const email = raw.trim().toLowerCase();
      if (USERS.some((u) => STAFF_IDS.has(u.id) && u.email === email))
        throw new DemoError(400, 'BAD_REQUEST', 'This is a staff email. Use the Employee tab to sign in with your password.');
      const prev = codes.get(email);
      if (prev && Date.now() - prev.sentAt < 30_000)
        throw new DemoError(429, 'TOO_SOON', 'Wait 30 seconds before asking for another code.');
      const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
      codes.set(email, { code, expires: Date.now() + 600_000, attempts: 0, sentAt: Date.now() });
      return { sent: true, expiresInSeconds: 600, devCode: code };
    }),
  verifyCode: (raw: string, code: string) =>
    wrap((): SessionDTO => {
      const email = raw.trim().toLowerCase();
      const c = codes.get(email);
      if (!c || c.expires < Date.now()) throw new DemoError(400, 'EXPIRED', 'This code has expired. Ask for a new one.');
      if (c.attempts >= 5) throw new DemoError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Ask for a new one.');
      if (c.code !== code) {
        c.attempts++;
        throw new DemoError(400, 'WRONG_CODE', 'That code is not right. Check the latest email and try again.');
      }
      codes.delete(email);
      let u = USERS.find((x) => x.email === email);
      if (!u) {
        const name = email.split('@')[0]!.replace(/[._-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
        u = { id: `v_${crypto.randomUUID()}`, name, email, roles: ['VENDOR'] };
        USERS.push(u);
      }
      // Pre-existing vendor in the "database" for this contact email → link it to this account.
      if (![...db.values()].some((x) => x.vendorUserId === u.id)) {
        const match = [...db.values()]
          .filter((x) => !x.vendorUserId && x.profile.contact?.email?.toLowerCase() === email)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (match) match.vendorUserId = u.id;
      }
      currentUser = u;
      return sessionFor(u, true);
    }),
  /** Restores the session from the stored token. */
  me: () =>
    wrap((): SessionDTO => {
      if (!currentUser) {
        let t: string | null = null;
        try {
          t = localStorage.getItem('vo.token');
        } catch {
          /* ignore */
        }
        currentUser = USERS.find((u) => t === `demo:${u.id}`) ?? null;
      }
      return sessionFor(me(), false);
    }),
  stats: () =>
    wrap((): StatsDTO => {
      const u = me();
      const vs = [...db.values()].filter((v) => canView(u, v));
      const byState: StatsDTO['byState'] = {};
      for (const v of vs) byState[v.state] = (byState[v.state] ?? 0) + 1;
      const done = vs.filter((v) => v.onboardedAt && v.submittedAt);
      const avg = done.length
        ? done.reduce((s, v) => s + (Date.parse(v.onboardedAt!) - Date.parse(v.submittedAt!)), 0) / done.length / 86_400_000
        : null;
      return { byState, myQueue: vs.filter((v) => inQueue(u, v)).length, avgDaysToOnboard: avg === null ? null : Math.round(avg * 10) / 10 };
    }),
  list: (p: ListParams) => wrap(() => list(me(), p)),
  get: (id: string) => wrap(() => toDTO(find(id, me()), me())),
  events: (id: string) => wrap(() => clone(find(id, me()).events)),
  create: (profile: VendorDraft) => wrap(() => toDTO(create(me(), profile), me())),
  update: (id: string, profile: VendorDraft, version?: number) =>
    wrap(() => {
      const u = me();
      const v = find(id, u);
      if (!canEdit(u, v)) throw new DemoError(403, 'FORBIDDEN', 'Vendor cannot be edited now');
      if (version !== undefined && version !== v.version)
        throw new DemoError(409, 'CONFLICT', 'This vendor was changed by someone else. Refresh and try again.');
      v.profile = mergeDraft(v.profile, vendorDraftSchema.parse(profile));
      touch(v);
      for (const k of v.docs.keys()) requeue(v, k, VERIFY_MS);
      return toDTO(v, u);
    }),
  act: (id: string, action: UserAction, body: ActionBody) =>
    wrap(() => {
      const u = me();
      const v = find(id, u);
      act(u, v, action, body, VERIFY_MS);
      return toDTO(v, u);
    }),
  upload: (id: string, key: DocumentKey, fields: Record<string, string>, file?: File) =>
    wrap(() => {
      const u = me();
      const v = find(id, u);
      if (file && !/^(application\/pdf|image\/(png|jpeg|webp))$/.test(file.type))
        throw new DemoError(400, 'BAD_REQUEST', 'Only PDF, PNG, JPEG or WEBP files are accepted');
      upload(u, v, key, fields, file ?? null, file?.name ?? null, VERIFY_MS);
      return toDTO(v, u);
    }),
  removeDoc: (id: string, key: DocumentKey) =>
    wrap(() => {
      const u = me();
      const v = find(id, u);
      if (!canEdit(u, v)) throw new DemoError(403, 'FORBIDDEN', 'Documents can only be changed while the vendor is a draft');
      v.docs.delete(key);
      touch(v);
      return toDTO(v, u);
    }),
  openFile: async (_id: string, _key: DocumentKey) => {
    throw new DemoError(400, 'DEMO', 'File preview opens in a new tab in the full app. It isn’t available in this demo.');
  },
};
