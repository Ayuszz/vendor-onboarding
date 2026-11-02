import { createHmac, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { OtpRequestResult, Role, SessionDTO, UserDTO } from '@vo/shared';
import { signToken } from '../auth.js';
import type { Config } from '../config.js';
import type { Db, Queryable } from '../db/client.js';
import { AppError, badRequest, unauthorized } from '../errors.js';
import type { Mailer } from '../integrations/mailer.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: string, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomUUID().replace(/-/g, '');
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Always run scrypt so response time does not reveal whether the account exists.
  const [, salt = 'x'.repeat(32), hex = ''] = (stored ?? '').split('$');
  const hash = await scrypt(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return !!stored && expected.length === hash.length && timingSafeEqual(expected, hash);
}

const CODE_TTL_SECONDS = 600;
const RESEND_AFTER_SECONDS = 30;
const MAX_ATTEMPTS = 5;

export interface AuthDeps {
  db: Db;
  cfg: Config;
  mailer: Mailer;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  kind: 'staff' | 'vendor';
  password_hash: string | null;
}

/** Only an HMAC of the code is stored, so a database leak does not reveal live codes. */
const codeHash = (cfg: Config, email: string, code: string) =>
  createHmac('sha256', cfg.JWT_SECRET).update(`${email}:${code}`).digest('hex');

async function vendorIdFor(q: Queryable, user: UserDTO): Promise<string | null> {
  if (!user.roles.includes('VENDOR')) return null;
  const { rows } = await q.query<{ id: string }>('SELECT id FROM vendors WHERE vendor_user_id = $1', [user.id]);
  return rows[0]?.id ?? null;
}

function toUser(r: UserRow): UserDTO {
  return { id: r.id, name: r.name, email: r.email, roles: r.roles };
}

export async function session(deps: AuthDeps, user: UserDTO, withToken = false): Promise<SessionDTO> {
  return {
    ...(withToken ? { token: signToken(user, deps.cfg.JWT_SECRET, deps.cfg.JWT_TTL_SECONDS) } : {}),
    user,
    vendorId: await vendorIdFor(deps.db, user),
  };
}

/** Staff (QC, SCM, Finance, buyers, admins) sign in with email and password. */
export async function staffLogin(deps: AuthDeps, email: string, password: string): Promise<SessionDTO> {
  const { rows } = await deps.db.query<UserRow>(
    `SELECT id, name, email, roles, kind, password_hash FROM users WHERE lower(email) = $1 AND kind = 'staff'`,
    [email],
  );
  const row = rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? null);
  if (!row || !ok) throw unauthorized('Email or password is incorrect');
  return session(deps, toUser(row), true);
}

/** Vendors sign in with a 6-digit code sent to their email. No password to remember. */
export async function requestCode(deps: AuthDeps, email: string): Promise<OtpRequestResult> {
  const { rows: staff } = await deps.db.query(`SELECT 1 FROM users WHERE lower(email) = $1 AND kind = 'staff'`, [email]);
  if (staff.length) throw badRequest('This is a staff email. Use the Employee tab to sign in with your password.');

  const { rows: recent } = await deps.db.query(
    `SELECT 1 FROM login_codes WHERE email = $1 AND created_at > now() - ($2 || ' seconds')::interval`,
    [email, String(RESEND_AFTER_SECONDS)],
  );
  if (recent.length) throw new AppError(429, 'TOO_SOON', `Wait ${RESEND_AFTER_SECONDS} seconds before asking for another code.`);

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await deps.db.query(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval, 0, now())
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
       attempts = 0, created_at = now()`,
    [email, codeHash(deps.cfg, email, code), String(CODE_TTL_SECONDS)],
  );
  try {
    await deps.mailer.send(codeEmail(email, code));
  } catch (err) {
    // Don't leave a code nobody received; let the user try again straight away.
    await deps.db.query('DELETE FROM login_codes WHERE email = $1', [email]);
    throw new AppError(502, 'EMAIL_FAILED', 'We couldn’t send the email just now. Try again in a minute.', String(err));
  }
  // The code itself is never returned, unless a developer has explicitly turned on
  // DEV_SHOW_OTP for local testing (refused in production by config validation).
  return { sent: true, expiresInSeconds: CODE_TTL_SECONDS, ...(deps.cfg.DEV_SHOW_OTP ? { devCode: code } : {}) };
}

function codeEmail(to: string, code: string) {
  const minutes = CODE_TTL_SECONDS / 60;
  return {
    to,
    subject: 'Your vendor portal sign-in code',
    text: `Your sign-in code is ${code}\n\nEnter it on the sign-in page to continue. It expires in ${minutes} minutes and can be used once.\n\nIf you didn’t try to sign in, you can ignore this email. Never share this code with anyone.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1b2330">
  <p style="font-size:15px;margin:0 0 16px">Your sign-in code for the vendor portal:</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:0 0 16px;font-variant-numeric:tabular-nums">${code}</p>
  <p style="font-size:14px;color:#4a5566;margin:0 0 8px">It expires in ${minutes} minutes and can be used once.</p>
  <p style="font-size:13px;color:#7b8696;margin:0">If you didn’t try to sign in, ignore this email. Never share this code with anyone.</p>
</div>`,
  };
}

/**
 * Checks the code, creates the vendor account on first sign-in, and links any vendor
 * record that already exists for this contact email (e.g. one a buyer started).
 */
export async function verifyCode(deps: AuthDeps, email: string, code: string): Promise<SessionDTO> {
  const user = await deps.db.transaction(async (tx) => {
    const { rows } = await tx.query<{ code_hash: string; expired: boolean; attempts: number }>(
      `SELECT code_hash, expires_at < now() AS expired, attempts FROM login_codes WHERE email = $1 FOR UPDATE`,
      [email],
    );
    const row = rows[0];
    if (!row || row.expired) throw badRequest('This code has expired. Ask for a new one.');
    if (row.attempts >= MAX_ATTEMPTS) throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Ask for a new one.');
    const expected = Buffer.from(row.code_hash, 'hex');
    const given = Buffer.from(codeHash(deps.cfg, email, code), 'hex');
    if (!timingSafeEqual(expected, given)) {
      await tx.query('UPDATE login_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
      return null;
    }
    await tx.query('DELETE FROM login_codes WHERE email = $1', [email]);

    const { rows: existing } = await tx.query<UserRow>(
      `SELECT id, name, email, roles, kind, password_hash FROM users WHERE lower(email) = $1`,
      [email],
    );
    let u = existing[0];
    if (!u) {
      const id = `v_${randomUUID()}`;
      const name = email.split('@')[0]!.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      await tx.query(`INSERT INTO users (id, name, email, roles, kind) VALUES ($1, $2, $3, '{VENDOR}', 'vendor')`, [id, name, email]);
      u = { id, name, email, roles: ['VENDOR'], kind: 'vendor', password_hash: null };
    }
    if (u.kind !== 'vendor') throw badRequest('This is a staff email. Use the Employee tab.');

    // Pre-existing vendor in the database for this contact email → attach it to this account.
    await tx.query(
      `UPDATE vendors SET vendor_user_id = $1
       WHERE id = (SELECT id FROM vendors
                   WHERE vendor_user_id IS NULL AND lower(profile->'contact'->>'email') = $2
                   ORDER BY created_at DESC LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM vendors WHERE vendor_user_id = $1)`,
      [u.id, email],
    );
    return toUser(u);
  });
  if (!user) throw badRequest('That code is not right. Check the latest email and try again.');
  return session(deps, user, true);
}

/** Tiny fixed-window limiter for the public sign-in routes (per IP). */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return;
    }
    if (++h.n > limit) throw new AppError(429, 'RATE_LIMITED', 'Too many attempts. Try again in a minute.');
  };
}
