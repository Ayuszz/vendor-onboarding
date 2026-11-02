import type {
  ActionBody,
  DocumentKey,
  EventDTO,
  Paged,
  State,
  StatsDTO,
  UserAction,
  UserDTO,
  VendorDTO,
  VendorDraft,
  VendorListItem,
} from '@vo/shared';

const TOKEN_KEY = 'vo.token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string | null) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable (private mode) — session-only auth */
    }
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 401 && token) {
    tokenStore.set(null);
    window.dispatchEvent(new Event('vo:logout'));
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`);
  }
  return json as T;
}

export interface ListParams {
  state?: State | undefined;
  q?: string | undefined;
  queue?: boolean | undefined;
  limit?: number;
  offset?: number;
}

const qs = (p: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '' && v !== false) s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  devUsers: () => request<UserDTO[]>('/auth/dev-users'),
  devLogin: (userId: string) =>
    request<{ token: string; user: UserDTO }>('/auth/dev-login', { method: 'POST', body: JSON.stringify({ userId }) }),
  me: () => request<UserDTO>('/me'),
  stats: () => request<StatsDTO>('/stats'),
  list: (p: ListParams) => request<Paged<VendorListItem>>(`/vendors${qs({ ...p })}`),
  get: (id: string) => request<VendorDTO>(`/vendors/${id}`),
  events: (id: string) => request<EventDTO[]>(`/vendors/${id}/events`),
  create: (profile: VendorDraft) =>
    request<VendorDTO>('/vendors', { method: 'POST', body: JSON.stringify({ profile }) }),
  update: (id: string, profile: VendorDraft, version?: number) =>
    request<VendorDTO>(`/vendors/${id}`, { method: 'PATCH', body: JSON.stringify({ profile, version }) }),
  act: (id: string, action: UserAction, body: ActionBody) =>
    request<VendorDTO>(`/vendors/${id}/actions/${action}`, { method: 'POST', body: JSON.stringify(body) }),
  upload: (id: string, key: DocumentKey, fields: Record<string, string>, file?: File) => {
    const fd = new FormData();
    fd.append('fields', JSON.stringify(fields));
    if (file) fd.append('file', file);
    return request<VendorDTO>(`/vendors/${id}/documents/${key}`, { method: 'PUT', body: fd });
  },
  removeDoc: (id: string, key: DocumentKey) =>
    request<VendorDTO>(`/vendors/${id}/documents/${key}`, { method: 'DELETE' }),
  /** Fetches a document file with auth and opens it in a new tab. */
  openFile: async (id: string, key: DocumentKey) => {
    const res = await fetch(`/api/vendors/${id}/documents/${key}/file`, {
      headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}` },
    });
    if (!res.ok) throw new ApiError(res.status, 'FILE', 'Could not open file');
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};
