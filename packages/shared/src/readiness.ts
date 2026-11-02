import { DOCUMENTS, requiredDocumentKeys, type DocumentKey } from './documents.js';
import { vendorProfileSchema, type VendorDraft } from './vendor.js';

export type DocStatus = 'PENDING' | 'VERIFIED' | 'FAILED';

/**
 * Everything that stops a vendor from being submitted. Shared so the UI shows the
 * exact same checklist the server enforces.
 */
export function submissionBlockers(
  profile: VendorDraft,
  docs: Partial<Record<DocumentKey, { status: DocStatus }>>,
): string[] {
  const blockers: string[] = [];
  const parsed = vendorProfileSchema.safeParse(profile);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    blockers.push(`Complete profile fields: ${fields.slice(0, 6).join(', ')}${fields.length > 6 ? '…' : ''}`);
  }
  for (const key of requiredDocumentKeys(profile)) {
    const d = docs[key];
    const label = DOCUMENTS[key].label;
    if (!d) blockers.push(`${label} not uploaded`);
    else if (d.status === 'PENDING') blockers.push(`${label} is still being verified`);
    else if (d.status === 'FAILED') blockers.push(`${label} failed verification`);
  }
  return blockers;
}
