import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppUser } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';
import { ensureParentIdentity, firstEmail } from '@/lib/auth/parent-identity';
import { sincronizzaLegamiRuntime } from '@/lib/anagrafiche/legami';
import { sendEmailDetailed } from '@/lib/email/send';
import { risolviContestoSede } from '@/lib/email/contesto';
import { messaggioCredenziali } from '@/lib/email/messaggi/credenziali';
import { logEvento } from '@/lib/logging/logger';

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
  /**
   * Il codice catastale (Belfiore) del luogo di nascita → `parents.codice_belfiore_nascita`.
   * Nullable, mai obbligatorio: è il dato che rende il codice fiscale CALCOLABILE e
   * RICONTROLLABILE domani, quando il comune sarà stato rinominato o soppresso.
   */
  codice_belfiore_nascita?: unknown;
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
  /** Esito dell'invio automatico delle credenziali (solo se l'account è stato creato ora). */
  credenzialiEmail?: { email: string; inviata: boolean; errore: string | null };
  /** Identità di accesso non completata (email presente ma creazione fallita). */
  identitaErrore?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const orNull = (v: unknown): string | null => str(v).trim() || null;

/**
 * Costruisce il record `parents` dal payload del form adulto.
 *
 * ⚠️ QUESTA FUNZIONE ELENCA LE COLONNE A MANO, e per questo un campo nuovo del form
 * non arriva in archivio finché qualcuno non lo scrive QUI. Non è un'ipotesi: fino
 * al 2026-08-11 `codice_belfiore_nascita` usciva da `ScrollableAdultForm.validate()`,
 * viaggiava nel corpo di `POST /api/admin/students` e dell'azione `create_parent`, e
 * spariva esattamente in questo `return` — su una colonna che in produzione ESISTE
 * ed è nullable (misurato l'11 agosto su `information_schema.columns`; 0 righe su 50
 * la avevano valorizzata, ed è la ragione per cui nessuno se n'era accorto).
 *
 * È esportata perché il giro «payload del form → record da scrivere» va misurabile
 * senza toccare la rete: `__tests__/lib/anagrafiche/parents-record.test.ts` parte dal
 * payload vero di `validate()` e verifica che ogni campo sopravviva.
 */
export function buildParentRecord(payload: ParentPayload): Record<string, unknown> {
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
    codice_belfiore_nascita: orNull(payload.codice_belfiore_nascita),
    // '' ⇒ `null`, e su questa colonna non è un dettaglio di stile: `fiscal_code` è
    // UNIQUE, e con UNIQUE la stringa vuota è un valore come un altro mentre `NULL`
    // no. In produzione, l'11 agosto, un genitore ha già `''`: il secondo che lo
    // ricevesse collide con lui e il salvataggio fallisce per un dato ASSENTE.
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

/**
 * Il nome della colonna che l'ambiente non conosce, letto dall'errore — oppure
 * `null` se l'errore non parla di una colonna mancante.
 *
 * ⚠️ DUE CODICI, NON UNO, e il secondo è quello che serve davvero in scrittura.
 * `42703` («column … of relation … does not exist») lo emette POSTGRES, e su un
 * INSERT/UPDATE arriva raramente: PostgREST valida il corpo contro la propria cache
 * dello schema PRIMA di parlare col database, e quando una colonna lì non c'è
 * risponde `PGRST204` — «Could not find the 'x' column of 'parents' in the schema
 * cache». È il caso del DB E2E della CI, che è un progetto SEPARATO e NON migrato
 * (vedi CLAUDE.md): senza questo ramo, aggiungere `codice_belfiore_nascita` al
 * record avrebbe fatto fallire in CI ogni creazione di genitore — cioè avrebbe
 * trasformato un campo in più in un'intera funzionalità in meno.
 *
 * ⚠️ ESPORTATA DALL'11 AGOSTO, e la ragione è un guasto misurato: il ciclo di
 * resilienza di `PATCH /api/admin/parents` guardava SOLO `42703` — cioè il codice
 * che in scrittura non arriva quasi mai — e ignorava `PGRST204`, che è quello che
 * arriva davvero. Con l'aggiunta di `codice_belfiore_nascita` al corpo del PATCH,
 * sul DB E2E della CI (progetto separato e non migrato) ogni salvataggio di
 * genitore sarebbe diventato un 500. Una regola valida per due strade vive in un
 * posto solo: l'INSERT la usa qui sotto, l'UPDATE la importa.
 */
export function colonnaSconosciuta(errore: { code?: string; message?: string } | null): string | null {
  if (!errore) return null;
  const msg = errore.message ?? '';
  if (errore.code === '42703') return /column "?([a-z_]+)"? of relation/i.exec(msg)?.[1] ?? null;
  if (errore.code === 'PGRST204') return /'([a-z_]+)' column/i.exec(msg)?.[1] ?? null;
  return null;
}

/** Insert resiliente: rimuove le colonne che l'ambiente non conosce e riprova. */
async function insertParentResilient(supabase: SupabaseClient, record: Record<string, unknown>) {
  const rec = { ...record };
  let res = await supabase.from('parents').insert(rec).select('id').single();
  let attempts = 0;
  for (;;) {
    const col = colonnaSconosciuta(res.error as { code?: string; message?: string } | null);
    if (!col || !(col in rec) || attempts >= 6) break;
    delete rec[col];
    // Un dato che l'ambiente non sa dove mettere non è un fallimento silenzioso:
    // qui la riga viene scritta SENZA quel campo, e chi legge i log deve poterlo
    // sapere. Nessun valore a log — solo il nome della colonna, che non è un dato
    // di persona.
    logEvento('anagrafica', 'warn', {
      operazione: 'linkOrCreateParent:insert',
      azione: 'colonna-assente-scartata',
      esito: col,
    });
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
  // Dati per l'identità di accesso (punto 4 sotto): dal record per i nuovi,
  // dalla riga esistente per i riusi via CF.
  let identityInput = {
    id: '',
    auth_user_id: null as string | null,
    emails: record.emails,
    first_name: record.first_name as string | null,
    last_name: record.last_name as string | null,
    phone: (Array.isArray(record.phone_numbers) && typeof record.phone_numbers[0] === 'string'
      ? (record.phone_numbers[0] as string)
      : null),
  };

  // 1. Genitore già esistente per CF (solo se il CF è valorizzato).
  if (record.fiscal_code) {
    const { data: existing } = await supabase
      .from('parents')
      .select('id, auth_user_id, emails, first_name, last_name')
      .eq('fiscal_code', record.fiscal_code)
      .maybeSingle();
    if (existing) {
      parentId = existing.id;
      identityInput = {
        ...identityInput,
        auth_user_id: (existing as { auth_user_id?: string | null }).auth_user_id ?? null,
        // L'anagrafica com'è a DB ha priorità; il payload copre solo il caso
        // riga storica senza email.
        emails: firstEmail((existing as { emails?: unknown }).emails)
          ? (existing as { emails?: unknown }).emails
          : record.emails,
        first_name: (existing as { first_name?: string | null }).first_name ?? null,
        last_name: (existing as { last_name?: string | null }).last_name ?? null,
      };
    }
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
  identityInput.id = parentId;

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
      entitaId: studentId,
      azione: 'insert',
      valoreDopo: { student_id: studentId, parent_id: parentId, relation_type: role || 'delegate' },
    });
  }

  // 4. Identità di accesso (auth.users + utenti + ponte) — S6bis. Best-effort:
  //    un fallimento qui non annulla il salvataggio anagrafico, perché l'invio
  //    credenziali (S11) è auto-riparante e completa i pezzi mancanti al primo
  //    utilizzo. I record-staff della tab Staff (citizenship=ruolo) non sono
  //    genitori dell'app: per loro nessun account.
  let credenzialiEmail: LinkOrCreateParentResult['credenzialiEmail'];
  let identitaErrore: string | undefined;
  if (!STAFF_ROLES.includes(role)) {
    // LA SEDE DEL GENITORE VIENE DAI FIGLI, e il legame col figlio è stato
    // appena scritto qui sopra (punto 3): `ensureParentIdentity` lo trova. Qui
    // si passava `scuolaId: actor.scuola_id`, cioè la sede di chi salva —
    // l'operatore di Giugliano che registrava una famiglia di Aversa creava un
    // genitore «di Giugliano». Ora l'operatore serve solo come criterio di
    // scelta quando i figli stanno in più plessi, o quando non ci sono figli
    // (anagrafica genitore creata senza alunno: lì non c'è nulla da cui dedurre).
    const identita = await ensureParentIdentity(supabase, identityInput, {
      sedeOperatore: actor.scuola_id ?? null,
    });
    // Ora che un account esiste, il legame anagrafico scritto al punto 3 può
    // avere il suo gemello runtime (`legame_genitori_alunni`, FK su `utenti.id`).
    // Serve alle policy RLS del baseline, che quella tabella la leggono ancora e
    // non si toccano. Best-effort e idempotente: non tocca le quote esistenti.
    if (identita.ok) await sincronizzaLegamiRuntime(supabase, parentId);
    if (identita.ok && (identita.createdAuth || identita.createdUtenti || identita.boundNow)) {
      // Account APPENA creato → invio AUTOMATICO delle credenziali (nessun
      // passaggio manuale della Segreteria). Un account riusato ha già le sue.
      let emailed: boolean | null = null;
      let emailError: string | null = null;
      if (identita.createdAuth && identita.password) {
        // Il nome della sede nel corpo: con tre plessi «Kidville» non dice a
        // quale scuola sia stato iscritto il figlio, e il genitore non ha modo
        // di accorgersi di un plesso sbagliato. La sede è quella che
        // `ensureParentIdentity` ha risolto dai FIGLI, non quella di chi salva.
        const sede = await risolviContestoSede(supabase, identita.scuolaId, 'anagrafiche/parents:credenziali');
        const messaggio = messaggioCredenziali({
          nome: identityInput.first_name,
          email: identita.email,
          password: identita.password,
          occasione: 'inserimento-anagrafica',
        }, sede);
        const invio = await sendEmailDetailed({
          to: identita.email,
          subject: messaggio.oggetto,
          text: messaggio.testo,
          html: messaggio.html,
        });
        emailed = invio.ok;
        emailError = invio.error;
        credenzialiEmail = { email: identita.email, inviata: invio.ok, errore: invio.error };
      }
      await logScrittura(supabase, {
        attore: actor,
        entitaTipo: 'credenziali',
        entitaId: parentId,
        azione: 'insert',
        valoreDopo: {
          auto: 'creazione-anagrafica',
          authUserId: identita.authUserId,
          createdAuth: identita.createdAuth,
          createdUtenti: identita.createdUtenti,
          emailed,
          emailError,
        },
      });
    } else if (!identita.ok && identita.reason !== 'no_email') {
      // Senza email è il caso normale "solo anagrafica": nessun rumore.
      identitaErrore = identita.message;
      // `identita.message` NON va a log: nel ramo `email_conflict` contiene
      // l'INDIRIZZO EMAIL del genitore in chiaro (parent-identity.ts), e questo
      // codice gira in una funzione Vercel, dove `console.*` scrive nei Runtime
      // Logs senza passare da `redact()`. A log va solo `reason`, che è un enum
      // chiuso ('no_email' | 'email_conflict' | 'error'). Il messaggio esteso
      // resta dov'era già: nella risposta al chiamante, per la Segreteria.
      // `parent_id` è un uuid e passa dal canale strutturato, non dal messaggio.
      logEvento('anagrafica', 'warn', {
        operazione: 'linkOrCreateParent:identita',
        azione: 'identita-non-completata',
        esito: identita.reason,
        parent_id: parentId,
      });
    }
  }

  return { parentId, created, credenzialiEmail, identitaErrore };
}
