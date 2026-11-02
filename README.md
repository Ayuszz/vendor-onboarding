# Vendor Onboarding

**Live demo:** https://ayuszz.github.io/vendor-onboarding/ (runs entirely in your browser; SAP and document checks are simulated and reset on reload)

A coded replacement for a low-code vendor onboarding workflow. A requester collects a supplier's details and statutory documents. Each document is checked automatically. Quality (QC) and Supply Chain (SCM) review in parallel, Finance gives the final approval, and the vendor is created in SAP. If SAP fails, the system retries and keeps the same card code each time.

```
Draft ──submit──▶ QC & SCM review ──(both ✓)──▶ Finance ──approve──▶ SAP sync ──▶ Onboarded
  ▲                     │                          │                    │
  └──── Sent back ◀─────┴──────────────────────────┘                    └─▶ SAP error ──retry──┘
                        └────────── Reject (final) ─┘
```

## Quick start

Requires Node 22+.

```bash
npm install
cp .env.example .env        # then set JWT_SECRET to any 32+ character string
npm run dev                 # API on :4000, web on :5173
```

Open <http://localhost:5173> and pick a demo user. There is one per role: Requester, QC, SCM, Finance and Admin. The database is an embedded Postgres (PGlite) stored in `.data/`, so nothing else needs installing. API docs are at <http://localhost:4000/docs>.

```bash
npm test          # 40 tests: workflow engine, validators, full API flows
npm run typecheck
npm run build
```

For a production-like stack with real Postgres, a separate worker and nginx, run `docker compose up --build` and open <http://localhost:8080>.

## Project layout

```
packages/shared    Domain logic shared by API and web — no I/O
  workflow.ts      State machine: states, roles, decide(), availableActions()
  documents.ts     Document registry: fields, when required, verification rules
  validators.ts    GSTIN checksum, PAN, IFSC → bank, Udyam, FSSAI…
  vendor.ts        Profile schemas (zod) for drafts and for submission
  readiness.ts     The "what's blocking submit" checklist

apps/api           Fastify + Postgres
  services/        Vendor use cases (create, edit, upload, actions, lists)
  jobs/            Postgres job queue, document verification, SAP sync
  integrations/    SAP port: mock + SAP Business One Service Layer client
  db/              Driver (PGlite or pg), versioned migrations, seed
  auth.ts          HS256 JWT (swap for your IdP)
  storage.ts       File storage port (local disk; S3/Azure drop-in)

apps/web           React 19 + Vite + Tailwind 4 + TanStack Query
  pages/           Overview, queue/list, vendor editor (stepper), vendor detail
  components/      Glass UI kit, document card, journey rail
```

## Design decisions

**The workflow is data, not screens.** `decide(snapshot, action, actor)` is a pure function. It returns the next state plus effects such as "record approval" or "queue SAP sync", and the API applies them in one transaction. Every rule is unit-tested. The UI calls the same function to decide which buttons to show, so it can never offer an action the server would refuse.

**One registry instead of 26 activities.** The low-code version had a separate "Upload X" and "Verify X" activity for each document. Here each document is one entry in `documents.ts`, which lists its fields, when it's required (for example, FSSAI only for food businesses and MOA only for companies) and its checks. To add a document type, you add one entry.

**Real verification, including cross-checks:**
- the GSTIN checksum is validated
- the PAN embedded in the GSTIN must match the PAN document
- a company's PAN must have holder type `C`
- the bank proof must match the profile's bank details
- expiry dates are enforced
- the bank is resolved from the IFSC prefix, which replaces the old 265-line bank-name lookup script

To call external providers (GSTN, NSDL, penny-drop), add them in `jobs/handlers.ts → verifyDocument`.

**SAP calls are safe to retry.**
- The card code is allocated once from a database sequence. This avoids the "read the latest code, then add one" race.
- Every retry reuses that code, and an "already exists" response counts as success.
- Transient errors back off exponentially. Permanent errors move the vendor to *SAP error* so Finance can retry it.
- The Service Layer client reuses its session instead of logging in on every call.

**Transactional outbox.** A job is inserted in the same transaction as the state change that needs it. Workers claim jobs with `FOR UPDATE SKIP LOCKED`, so you can run as many as you like.

**Other safeguards:**
- Optimistic locking: a stale write returns `409`.
- A complete audit trail of who did what and when.
- RBAC on every endpoint. Requesters see only their own vendors.
- Uploaded file types are detected from the file's bytes, never from the browser's claim.
- Only the last 4 digits of Aadhaar are stored.
- Secrets are redacted from logs.
- Config is validated at boot, so the app refuses to start when misconfigured.

**The UI is glass where it helps and solid where people read.** The sidebar, panels, action dock and dialogs use translucent blur. Inputs and document fields sit on a denser surface, so contrast never depends on what's behind them. The app supports light and dark mode, respects `prefers-reduced-motion` and `prefers-reduced-transparency`, works down to phone width with a bottom tab bar, and loads each page lazily.

## Going to production

1. **Auth.** Set `AUTH_MODE=jwt`, issue tokens from your SSO with `sub`, `name`, `email` and `roles` claims, and replace the demo sign-in screen with an SSO redirect. `AUTH_MODE=dev` refuses to start when `NODE_ENV=production`.
2. **Database.** Set `DATABASE_URL` to a managed Postgres. Migrations run on boot. You can also run them with `npm run db:migrate -w @vo/api`.
3. **SAP.** Set `SAP_MODE=service_layer` and the `SAP_*` variables, then map `PayTermsGrpCode` and any custom user-defined fields in `integrations/sap.ts → toBusinessPartner`.
4. **Files.** Implement `FileStorage` for S3 or Azure Blob. It needs three methods.
5. **Scaling.** Run API replicas with `WORKER_ENABLED=false` and scale `npm run worker -w @vo/api` separately.
