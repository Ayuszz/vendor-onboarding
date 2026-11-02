import type { Role } from '@vo/shared';
import { hashPassword } from '../services/auth.js';
import type { Db } from './client.js';

/**
 * Development staff accounts — one per internal role. Only seeded when AUTH_MODE=dev.
 * Vendors are never seeded: they create their own account by signing in with an email code.
 */
export const DEMO_PASSWORD = process.env.SEED_STAFF_PASSWORD || 'Demo@1234';

export const DEMO_USERS: { id: string; name: string; email: string; roles: Role[] }[] = [
  { id: 'u_requester', name: 'Riya Sharma', email: 'buyer@example.com', roles: ['REQUESTER'] },
  { id: 'u_qc', name: 'Arjun Patil', email: 'qc@example.com', roles: ['QC'] },
  { id: 'u_scm', name: 'Meera Kulkarni', email: 'scm@example.com', roles: ['SCM'] },
  { id: 'u_finance', name: 'Vikram Desai', email: 'finance@example.com', roles: ['FINANCE'] },
  { id: 'u_admin', name: 'Admin', email: 'admin@example.com', roles: ['ADMIN'] },
];

export async function seed(db: Db) {
  const hash = await hashPassword(DEMO_PASSWORD);
  for (const u of DEMO_USERS) {
    await db.query(
      `INSERT INTO users (id, name, email, roles, kind, password_hash) VALUES ($1, $2, $3, $4, 'staff', $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, roles = EXCLUDED.roles,
         password_hash = EXCLUDED.password_hash`,
      [u.id, u.name, u.email, u.roles, hash],
    );
  }
}
