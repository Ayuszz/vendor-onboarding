import { resolveBank, type VendorProfile } from '@vo/shared';

/**
 * SAP port. The workflow only depends on this interface; the concrete client is chosen
 * by config. Errors are classified as retryable (network, 5xx, timeouts, session) or
 * permanent (validation), which drives the job queue's retry policy.
 */
export interface SapClient {
  createBusinessPartner(input: SapVendorInput): Promise<{ cardCode: string; alreadyExisted: boolean }>;
}

export interface SapVendorInput {
  cardCode: string;
  idempotencyKey: string;
  profile: VendorProfile;
  gstin?: string;
  pan?: string;
}

export class SapError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Maps our vendor profile to an SAP Business One `BusinessPartners` payload. */
export function toBusinessPartner(input: SapVendorInput) {
  const { profile: p } = input;
  const bank = resolveBank(p.bank.ifsc);
  return {
    CardCode: input.cardCode,
    CardName: p.legalName.slice(0, 100),
    CardForeignName: p.tradeName || undefined,
    CardType: 'cSupplier',
    EmailAddress: p.contact.email,
    Phone1: p.contact.phone,
    ContactPerson: p.contact.name,
    FederalTaxID: input.pan,
    PayTermsGrpCode: undefined, // map p.paymentTermsDays to your SAP payment-terms group here
    BPAddresses: [
      {
        AddressName: 'BILL TO',
        AddressType: 'bo_BillTo',
        Street: p.address.line1,
        Block: p.address.line2 || undefined,
        City: p.address.city,
        State: p.address.state,
        ZipCode: p.address.pincode,
        Country: p.address.country,
        GSTIN: input.gstin,
      },
    ],
    BPBankAccounts: [
      {
        BankCode: bank?.code,
        AccountNo: p.bank.accountNumber,
        AccountName: p.bank.accountHolder,
        BICSwiftCode: p.bank.ifsc,
        Country: 'IN',
      },
    ],
  };
}

/** In-memory SAP stand-in for local development and tests. */
export class MockSapClient implements SapClient {
  readonly created = new Map<string, ReturnType<typeof toBusinessPartner>>();
  /** Queue of failures to simulate, consumed one per call (e.g. [true, true] = two retryable failures). */
  failNext: boolean[] = [];

  async createBusinessPartner(input: SapVendorInput) {
    const fail = this.failNext.shift();
    if (fail !== undefined) throw new SapError(fail ? 'SAP temporarily unavailable (mock)' : 'Invalid payload (mock)', fail);
    if (this.created.has(input.cardCode)) return { cardCode: input.cardCode, alreadyExisted: true };
    this.created.set(input.cardCode, toBusinessPartner(input));
    return { cardCode: input.cardCode, alreadyExisted: false };
  }
}

/**
 * SAP Business One Service Layer client.
 * - Reuses the session cookie instead of logging in on every call; re-logs in on 401.
 * - Treats "already exists" as success, so retries are idempotent.
 * - Hard timeout on every request.
 */
export class ServiceLayerSapClient implements SapClient {
  private session: { cookie: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: { baseUrl: string; companyDb: string; username: string; password: string; timeoutMs?: number },
  ) {}

  async createBusinessPartner(input: SapVendorInput) {
    const res = await this.request('POST', '/BusinessPartners', toBusinessPartner(input));
    if (res.ok) return { cardCode: input.cardCode, alreadyExisted: false };
    const body = await res.text();
    // SAP B1 returns -10 / "already exists" when the CardCode is taken: our earlier attempt succeeded.
    if (/already exists/i.test(body)) return { cardCode: input.cardCode, alreadyExisted: true };
    throw new SapError(`SAP ${res.status}: ${body.slice(0, 300)}`, res.status >= 500 || res.status === 429);
  }

  private async login(): Promise<string> {
    const res = await this.fetchWithTimeout('POST', '/Login', {
      CompanyDB: this.cfg.companyDb,
      UserName: this.cfg.username,
      Password: this.cfg.password,
    });
    if (!res.ok) throw new SapError(`SAP login failed (${res.status})`, res.status >= 500);
    const cookie = (res.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const json = (await res.json()) as { SessionTimeout?: number };
    this.session = { cookie, expiresAt: Date.now() + ((json.SessionTimeout ?? 30) - 1) * 60_000 };
    return cookie;
  }

  private async request(method: string, path: string, body: unknown, retried = false): Promise<Response> {
    const cookie = this.session && this.session.expiresAt > Date.now() ? this.session.cookie : await this.login();
    const res = await this.fetchWithTimeout(method, path, body, cookie);
    if (res.status === 401 && !retried) {
      this.session = null;
      return this.request(method, path, body, true);
    }
    return res;
  }

  private async fetchWithTimeout(method: string, path: string, body: unknown, cookie?: string) {
    try {
      return await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new SapError(`SAP unreachable: ${(err as Error).message}`, true);
    }
  }
}
