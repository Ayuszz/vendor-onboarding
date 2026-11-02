import { createHmac, timingSafeEqual } from 'node:crypto';
import { ROLES, type Role, type UserDTO } from '@vo/shared';
import { unauthorized } from './errors.js';

/**
 * Stateless HS256 JWT auth with no third-party dependency.
 * In production, put your IdP (Azure AD, Okta, Keycloak…) in front and either issue
 * tokens with the same claims or swap `verifyToken` for a JWKS-based verifier.
 */

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export function signToken(user: UserDTO, secret: string, ttlSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ sub: user.id, name: user.name, email: user.email, roles: user.roles, iat: now, exp: now + ttlSeconds }),
  );
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyToken(token: string, secret: string): UserDTO {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('Malformed token');
  const [header, payload, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw unauthorized('Invalid token signature');

  let claims: { sub?: unknown; name?: unknown; email?: unknown; roles?: unknown; exp?: unknown; alg?: unknown };
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (h.alg !== 'HS256') throw new Error('alg');
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    throw unauthorized('Malformed token');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw unauthorized('Token expired');
  if (typeof claims.sub !== 'string') throw unauthorized('Token missing subject');
  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((r): r is Role => (ROLES as readonly string[]).includes(r as string))
    : [];
  return {
    id: claims.sub,
    name: typeof claims.name === 'string' ? claims.name : claims.sub,
    email: typeof claims.email === 'string' ? claims.email : '',
    roles,
  };
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}
