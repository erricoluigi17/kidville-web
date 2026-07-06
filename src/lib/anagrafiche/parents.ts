import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppUser } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';

// =============================================================================
// Helper condiviso creazione/collegamento genitore (anagrafica).
//
// Usato sia dall'endpoint POST /api/admin/parents (create_parent) sia dal
// salvataggio atomico alunno+genitori in POST /api/admin/students. Centralizza:
//  - normalizzazione del CF vuoto ('' -> null) per non violare il vincolo UNIQUE
//    `parents_fiscal_code_key` (era la causa del "genitore non salvato" silente);
//  - mapping payload del form -> colonne `parents` (incl. residence_province,
//    residence_street_number/civico, birth_city<-birth_place);
//  - citizenship REALE per i ruoli-genitore; sovrascritta col ruolo SOLO per lo
//    staff (educator/coordinator/admin), preservando il workaround della tab Staff;
//  - dedup per CF, insert resiliente alle colonne mancanti (pre-migrazione),
//    upsert del legame student_parents e audit immodificabile.
// =============================================================================

const STAFF_ROLES = ['educator', 'coordinator', 'admin'];

export interface ParentPayload {
  first_name?: unknown;
  last_name?: unknown;
  role?: unknown;
  gender?: unknown;
  birth_date?: unknown;
  citizenship?: unknown;
  birth_nation?: unknown;
  birth_place?: unknown;
  birth_province?: unknown;
  fiscal_code?: unknown;
  address?: unknown;
  civico?: unknown;
  residence_city?: unknown;
  residence_province?: unknown;
  zip_code?: unknown;
  emails?: unknown;
  phones?: unknown;
  [key: string]: unknown;
}

export interface LinkOrCreateParentResult {
  parentId: string;
  created: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const orNull = (v: unknown): string | null => str(v).trim() || null;

/** Costruisce il record `parents` dal payload del form adulto. */
function buildParentRecord(payload: ParentPayload): Record<string, unknown> {
  const role = str(payload.role) || 'delegate';
  const realCitizenship = orNull(payload.citizenship);
  return {
    first_name: orNull(payload.first_name),
    last_name: orNull(payload.last_name),
    gender: orNull(payload.gender),
    birth_date: orNull(payload.birth_date),
    citizenship: STAFF_ROLES.includes(role) ? role : realCitizenship,
    birth_nation: orNull(payload.birth_nation),
    birth_city: orNull(payload.birth_place),
    birth_province: orNull(payload.birth_province),
    fiscal_code: orNull(payload.fiscal_code),
    residence_address: orNull(payload.address),
    residence_street_number: orNull(payload.civico),
    residence_city: orNull(payload.residence_city),
    residence_province: str(payload.residence_province).trim().toUpperCase() || null,
    zip_code: orNull(payload.zip_code),
    phone_numbers: Array.isArray(payload.phones) ? payload.phones : [],
    emails: Array.isArray(payload.emails) ? payload.emails : [],
  };
}

/** Insert resiliente: rimuove le colonne non ancora esistenti (42703) e riprova. */
async function insertParentResilient(supabase: SupabaseClient, record: Record<string, unknown>) {
  const rec = { ...record };
  let res = await supabase.from('parents').insert(rec).select('id').single();
  let attempts = 0;
  while (res.error && (res.error as { code?: string }).code === '42703' && attempts < 6) {
    const col = /column "?([a-z_]+)"? of relation/i.exec(res.error.message)?.[1];
    if (!col || !(col in rec)) break;
    delete rec[col];
    res = await supabase.from('parents').insert(rec).select('id').single();
    attempts++;
  }
  return res;
}

/**
 * Crea (o riusa per CF) un genitore e lo collega allo studente.
 * Lancia `Error` con messaggio parlante in caso di fallimento.
 */
export async function linkOrCreateParent(
  supabase: SupabaseClient,
  actor: AppUser,
  { studentId, payload }: { studentId?: string | null; payload: ParentPayload },
): Promise<LinkOrCreateParentResult> {
  const role = str(payload.role) || 'delegate';
  const record = buildParentRecord(payload);

  let parentId: string | null = null;
  let created = false;

  // 1. Genitore già esistente per CF (solo se il CF è valorizzato).
  if (record.fiscal_code) {
    const { data: existing } = await supabase
      .from('parents')
      .select('id')
      .eq('fiscal_code', record.fiscal_code)
      .maybeSingle();
    if (existing) parentId = existing.id;
  }

  // 2. Altrimenti crea il genitore.
  if (!parentId) {
    const { data: newParent, error } = await insertParentResilient(supabase, record);
    if (error || !newParent) {
      throw new Error(error?.message || 'Errore nel salvataggio del genitore');
    }
    parentId = newParent.id;
    created = true;
    await logScrittura(supabase, {
      attore: actor,
      entitaTipo: 'genitori',
      entitaId: parentId,
      azione: 'insert',
      valoreDopo: record,
    });
  }

  if (!parentId) throw new Error('Creazione del genitore non riuscita');

  // 3. Collega il genitore allo studente.
  if (studentId) {
    const { error: linkError } = await supabase.from('student_parents').upsert(
      {
        student_id: studentId,
        parent_id: parentId,
        relation_type: role || 'delegate',
        is_primary: role === 'mother' || role === 'father',
      },
      { onConflict: 'student_id,parent_id', ignoreDuplicates: true },
    );
    if (linkError) throw new Error(linkError.message);
    await logScrittura(supabase, {
      attore: actor,
      entitaTipo: 'legame',
      entitaId: `${studentId}:${parentId}`,
      azione: 'insert',
      valoreDopo: { student_id: studentId, parent_id: parentId, relation_type: role || 'delegate' },
    });
  }

  return { parentId, created };
}
