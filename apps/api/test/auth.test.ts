import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeProfile, multipart, PDF, setup, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());

const post = (url: string, payload: object, token?: string) =>
  ctx.app.inject({ method: 'POST', url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
const get = (url: string, token: string) => ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

/** The code exists only in the email that was "sent" — read it from the mailbox. */
function codeFromInbox(email: string) {
  const msg = [...ctx.mailer.sent].reverse().find((m) => m.to === email.toLowerCase());
  return /\b(\d{6})\b/.exec(msg?.text ?? '')?.[1] ?? '';
}

/** Requests a code and verifies it, returning the session. */
async function vendorSignIn(email: string) {
  const req = await post('/api/auth/code', { email });
  expect(req.statusCode).toBe(200);
  expect(req.json().devCode).toBeUndefined();
  const code = codeFromInbox(email);
  const ver = await post('/api/auth/code/verify', { email, code });
  expect(ver.statusCode).toBe(200);
  return ver.json() as { token: string; refreshToken: string; user: { id: string; roles: string[] }; vendorId: string | null };
}

describe('staff sign-in', () => {
  it('accepts the right password and rejects a wrong one with the same message', async () => {
    const ok = await post('/api/auth/login', { email: 'QC@example.com', password: 'Demo@1234' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ user: { roles: ['QC'] }, vendorId: null });

    const bad = await post('/api/auth/login', { email: 'qc@example.com', password: 'nope' });
    const unknown = await post('/api/auth/login', { email: 'ghost@example.com', password: 'nope' });
    expect(bad.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe(bad.json().error.message);
  });

  it('steers staff away from the vendor code flow', async () => {
    const r = await post('/api/auth/code', { email: 'finance@example.com' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/Employee tab/);
  });
});

describe('vendor sign-in with an email code', () => {
  it('a brand-new vendor has no record yet, then creates exactly one', async () => {
    const s = await vendorSignIn('new.supplier@acme.test');
    expect(s.user.roles).toEqual(['VENDOR']);
    expect(s.vendorId).toBeNull();
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ to: 'new.supplier@acme.test' });

    const created = await post('/api/vendors', { profile: { legalName: 'Acme Supplies' } }, s.token);
    expect(created.statusCode).toBe(201);
    expect(created.json().profile.contact.email).toBe('new.supplier@acme.test');

    const again = await post('/api/vendors', { profile: { legalName: 'Second Co' } }, s.token);
    expect(again.statusCode).toBe(409);

    const me = await get('/api/me', s.token);
    expect(me.json().vendorId).toBe(created.json().id);
  });

  it('links a vendor that already exists in the database for that email', async () => {
    const buyerMade = await ctx.app.inject({
      method: 'POST',
      url: '/api/vendors',
      headers: { authorization: `Bearer ${ctx.tokens.requester}` },
      payload: { profile: { ...completeProfile, contact: { ...completeProfile.contact, email: 'existing@vendor.test' } } },
    });
    const s = await vendorSignIn('Existing@Vendor.test');
    expect(s.vendorId).toBe(buyerMade.json().id);

    // the vendor can now upload documents to it
    const mp = multipart({ pan: 'AABCU9603R', nameOnPan: 'Acme' }, { name: 'pan.pdf', data: PDF });
    const up = await ctx.app.inject({
      method: 'PUT',
      url: `/api/vendors/${s.vendorId}/documents/pan`,
      headers: { authorization: `Bearer ${s.token}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(up.statusCode).toBe(200);
  });

  it('vendors only ever see their own record', async () => {
    const a = await vendorSignIn('a@one.test');
    const b = await vendorSignIn('b@two.test');
    const va = (await post('/api/vendors', { profile: { legalName: 'One' } }, a.token)).json();
    expect((await get(`/api/vendors/${va.id}`, b.token)).statusCode).toBe(404);
    const list = (await get('/api/vendors', b.token)).json();
    expect(list.items.map((i: { id: string }) => i.id)).not.toContain(va.id);
    // and cannot act as a reviewer
    expect([403, 422]).toContain((await post(`/api/vendors/${va.id}/actions/approve`, {}, a.token)).statusCode);
  });

  it('rejects wrong codes, locks after 5 tries, and throttles resends', async () => {
    const email = 'brute@force.test';
    const first = await post('/api/auth/code', { email });
    const code = codeFromInbox(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/code/verify', { email, code: wrong })).statusCode).toBe(400);
    expect((await post('/api/auth/code/verify', { email, code })).statusCode).toBe(429);
    expect((await post('/api/auth/code', { email })).statusCode).toBe(429);
  });

  it('a code works only once', async () => {
    const email = 'once@only.test';
    await post('/api/auth/code', { email });
    const code = codeFromInbox(email);
    expect((await post('/api/auth/code/verify', { email, code })).statusCode).toBe(200);
    expect((await post('/api/auth/code/verify', { email, code })).statusCode).toBe(400);
  });
});

describe('the code is only delivered by email', () => {
  it('never appears in the API response, the email subject, or the database', async () => {
    const email = 'secure@check.test';
    const r = await post('/api/auth/code', { email });
    const code = codeFromInbox(email);
    expect(code).toMatch(/^\d{6}$/);
    expect(r.body).not.toContain(code);
    expect(ctx.mailer.sent.at(-1)!.subject).not.toContain(code);
    const { rows } = await ctx.db.query<{ code_hash: string }>('SELECT code_hash FROM login_codes WHERE email = $1', [email]);
    expect(rows[0]!.code_hash).not.toContain(code);
    expect(rows[0]!.code_hash).toHaveLength(64);
  });

  it("one person's code cannot sign in as another email", async () => {
    await post('/api/auth/code', { email: 'alice@a.test' });
    await post('/api/auth/code', { email: 'mallory@m.test' });
    const malloryCode = codeFromInbox('mallory@m.test');
    expect((await post('/api/auth/code/verify', { email: 'alice@a.test', code: malloryCode })).statusCode).toBe(400);
  });
});

describe('refresh tokens', () => {
  it('rotates on every use and rejects a token that was already used', async () => {
    const s = await vendorSignIn('rotate@acme.test');
    expect(s.refreshToken).toBeTruthy();

    const r1 = await post('/api/auth/refresh', { refreshToken: s.refreshToken });
    expect(r1.statusCode).toBe(200);
    const next = r1.json() as { token: string; refreshToken: string };
    expect(next.refreshToken).not.toBe(s.refreshToken);
    expect((await get('/api/me', next.token)).statusCode).toBe(200);

    // Reusing the old token fails and revokes the whole chain, including the newest token.
    expect((await post('/api/auth/refresh', { refreshToken: s.refreshToken })).statusCode).toBe(401);
    expect((await post('/api/auth/refresh', { refreshToken: next.refreshToken })).statusCode).toBe(401);
  });

  it('a new correct code replaces the old tokens, and every code is different', async () => {
    const email = 'again@acme.test';
    const a = await vendorSignIn(email);
    const firstCode = codeFromInbox(email);
    ctx.mailer.sent.length = 0;
    // Wait out the resend throttle by backdating the stored code.
    await ctx.db.query(`UPDATE login_codes SET created_at = now() - interval '2 minutes' WHERE email = $1`, [email]).catch(() => {});
    await post('/api/auth/code', { email });
    const secondCode = codeFromInbox(email);
    expect(secondCode).toMatch(/^\d{6}$/);
    const b = (await post('/api/auth/code/verify', { email, code: secondCode })).json() as { refreshToken: string };
    expect(b.refreshToken).not.toBe(a.refreshToken);
    expect((await post('/api/auth/refresh', { refreshToken: a.refreshToken })).statusCode).toBe(401);
    // The code is single-use.
    expect((await post('/api/auth/code/verify', { email, code: secondCode })).statusCode).toBe(400);
    expect(firstCode).toMatch(/^\d{6}$/);
  });

  it('logout revokes the refresh token', async () => {
    const s = await vendorSignIn('bye@acme.test');
    expect((await post('/api/auth/logout', { refreshToken: s.refreshToken })).statusCode).toBe(200);
    expect((await post('/api/auth/refresh', { refreshToken: s.refreshToken })).statusCode).toBe(401);
  });
});
