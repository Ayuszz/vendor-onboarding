import type { Role } from '@vo/shared';
import type { Db } from './client.js';

/** Demo users — one per role — so every screen can be tried locally. */
export const DEMO_USERS: { id: string; name: string; email: string; roles: Role[] }[] = [
  { id: 'u_requester', name: 'Riya Sharma', email: 'riya@example.com', roles: ['REQUESTER'] },
  { id: 'u_qc', name: 'Arjun Patil', email: 'arjun@example.com', roles: ['QC'] },
  { id: 'u_scm', name: 'Meera Kulkarni', email: 'meera@example.com', roles: ['SCM'] },
  { id: 'u_finance', name: 'Vikram Desai', email: 'vikram@example.com', roles: ['FINANCE'] },
  { id: 'u_admin', name: 'Admin', email: 'admin@example.com', roles: ['ADMIN'] },
];

export async function seed(db: Db) {
  for (const u of DEMO_USERS) {
    await db.query(
      `INSERT INTO users (id, name, email, roles) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, roles = EXCLUDED.roles`,
      [u.id, u.name, u.email, u.roles],
    );
  }
}
