import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { JWT_SECRET: 'x'.repeat(40) };

describe('sign-in code safety rails', () => {
  it('codes are not shown on screen unless explicitly enabled', () => {
    expect(loadConfig(base).DEV_SHOW_OTP).toBe(false);
  });

  it('refuses to show codes on screen in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'jwt', MAILER: 'smtp', SMTP_HOST: 'smtp.test', MAIL_FROM: 'a@b.c', DEV_SHOW_OTP: 'true' }),
    ).toThrow(/DEV_SHOW_OTP/);
  });

  it('refuses to show codes on screen on a publicly reachable host', () => {
    expect(() => loadConfig({ ...base, DEV_SHOW_OTP: 'true' })).toThrow(/DEV_SHOW_OTP/);
    expect(loadConfig({ ...base, DEV_SHOW_OTP: 'true', HOST: '127.0.0.1' }).DEV_SHOW_OTP).toBe(true);
  });

  it('requires a real mail server in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'jwt' })).toThrow(/MAILER=smtp/);
    expect(() => loadConfig({ ...base, MAILER: 'smtp' })).toThrow(/SMTP_HOST/);
  });
});
