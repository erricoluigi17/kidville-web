import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertParentInScope, resolveScuolaScrittura } from '@/lib/auth/scope';
import { rifiutoSede } from '@/lib/auth/rifiuto-sede';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody } from '@/lib/validation/http';
import { parseFamilyRow } from '@/lib/import/template';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// POST /api/admin/import/anagrafiche
// Body: { rows: [{ <intestazione italiana>: valore, ... }], scuola_id? }
// Il client parsa il foglio (xlsx/csv) → righe JSON; il server mappa, deduplica su
// CF e crea alunni + genitori + collegamenti (service-role, come le altre route admin).
const bodySchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).max(2000),
  scuola_id: z.string().optional(),
});

/**
 * Codici che significano «qui lo schema non c'è» (il DB E2E della CI non è
 * migrato): non sono guasti, sono un ambiente diverso. Su questi la dedup per
 * sede si salta a livello `info` — non si blocca un import per un problema
 * d'infrastruttura del database di test.
 */
const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

/**
 * Il messaggio che vede chi sta importando. Non è arredamento: è l'unica cosa che
 * dice a una persona cosa fare del foglio che ha in mano. «Errore alla riga 7» la
 * lascia lì; questo le dice che quel bambino esiste già altrove e che la strada è
 * il trasferimento. Stesso testo di `admin/iscrizioni`, perché è lo stesso fatto.
 */
const MSG_CF_ALTRA_SEDE =
  "alunno: questo codice fiscale risulta già iscritto in un'altra sede: serve un trasferimento, " +
  'non una nuova iscrizione. Verificare con la sede di provenienza prima di procedere; se il ' +
  'codice fiscale è stato digitato male, correggerlo nel foglio.';

/**
 * Ultima rete: `alunni.codice_fiscale` ha un vincolo UNIQUE **globale**
 * (`alunni_codice_fiscale_key`), quindi con la dedup ristretta alla sede l'INSERT
 * di un bambino già iscritto altrove finisce in 23505. Senza questa mappatura il
 * foglio si riprenderebbe indietro `duplicate key value violates unique
 * constraint "alunni_codice_fiscale_key"`, che non dice niente a una segreteria.
 */
const MSG_CF_DUPLICATO =
  'alunno: codice fiscale già presente in anagrafica. Se il bambino è iscritto in un\'altra sede ' +
  'serve un trasferimento, non una nuova iscrizione.';

const msgGenitoreAltraSede = (cognome: string) =>
  `genitore ${cognome}: questo codice fiscale è già in anagrafica, ma risulta collegato solo a ` +
  "minori di un'altra sede. Il collegamento fra sedi lo fa la Direzione: nessun legame è stato creato.";

const msgGenitoreNonVerificabile = (cognome: string) =>
  `genitore ${cognome}: verifica della sede non riuscita, nessun legame è stato creato. Riprovare; ` +
  'se il problema resta, segnalarlo.';

export const POST = withRoute('admin/import/anagrafiche:POST', async (request: NextRequest) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const b = await parseBody(request, bodySchema);
  if ('response' in b) return b.response;

  try {
    const supabase = await createAdminClient();
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, b.data.scuola_id);
    if (sw.response) return sw.response;
    const scuolaId = sw.scuolaId;
    if (!scuolaId) {
      // Difensivo: per contratto `resolveScuolaScrittura` o dà la sede o dà la
      // risposta. Se un giorno non fosse più vero, un import "a sede ignota"
      // archivierebbe una scolaresca nel plesso sbagliato in silenzio.
      logEvento('multi_sede', 'error', {
        operazione: 'admin/import/anagrafiche:POST',
        esito: 'sede-scrittura-non-risolta',
        ruolo: auth.user.role,
      });
      return rifiutoSede('SEDE_DA_SPECIFICARE');
    }

    const families = b.data.rows.map(parseFamilyRow);
    let alunniCreati = 0;
    let genitoriCreati = 0;
    let legami = 0;
    const errori: { riga: number; messaggio: string }[] = [];

    // Conteggi per i log RIASSUNTIVI (una riga per import, non una per foglio: un
    // logger loquace acceca — vedi la testata di src/lib/logging/logger.ts, e un
    // foglio può avere 2000 righe).
    let bloccatiCfAltraSede = 0;
    let bloccatiGenitoreAltraSede = 0;
    let lettureNonRiuscite = 0;
    let ultimoCodice: string | null = null;
    let soloSchemaAssente = true;

    /** PostgREST non lancia: `{ error }` va guardato, e un guasto va distinto da un DB non migrato. */
    const registraGuasto = (err: unknown) => {
      lettureNonRiuscite++;
      const codice = (err as { code?: string } | null)?.code ?? null;
      ultimoCodice = codice;
      if (!codice || !SCHEMA_ASSENTE.has(codice)) soloSchemaAssente = false;
    };

    for (let i = 0; i < families.length; i++) {
      const fam = families[i];
      if (!fam) continue;
      try {
        // ─── 1. Alunno — dedup su codice_fiscale, RISTRETTA alla sede ──────────
        // La dedup e il controllo di appartenenza sono due cose diverse, e qui
        // erano una sola: `.eq('codice_fiscale', cf)` e basta. Se il CF del foglio
        // era di un minore di un ALTRO plesso, `studentId` diventava l'id di quel
        // minore, il ramo di creazione veniva saltato e al punto 2 i genitori del
        // foglio gli venivano agganciati con `student_parents.upsert`. Quella riga
        // non è un dato anagrafico: `public.current_parent_student_ids()` legge
        // proprio `student_parents`, ed è la funzione su cui fanno join le policy
        // RLS di presenze, pagamenti e note disciplinari. È la chiave che apre in
        // lettura la scheda di un minore dell'altra sede, per sempre e in silenzio.
        let studentId: string | null = null;
        const cf = fam.alunno.codice_fiscale;
        if (cf) {
          // (A) La dedup vera e propria, dentro la sede di scrittura.
          const { data: inSede, error: inSedeErr } = await supabase
            .from('alunni')
            .select('id')
            .eq('codice_fiscale', cf)
            .eq('scuola_id', scuolaId)
            .maybeSingle();
          if (inSedeErr) {
            // Non si boccia un import per una lettura fallita: si prosegue senza
            // dedup, e il doppione lo intercetta l'INSERT (23505, qui sotto).
            registraGuasto(inSedeErr);
          } else if (inSede?.id) {
            studentId = inSede.id as string;
          } else {
            // (B) Nessun record in sede: lo stesso CF esiste ALTROVE? Questa
            // lettura non produce MAI un riuso — distingue soltanto «bambino
            // nuovo» da «bambino di un'altra sede», che finivano nello stesso ramo.
            const { data: altrove, error: altroveErr } = await supabase
              .from('alunni')
              .select('scuola_id')
              .eq('codice_fiscale', cf);
            if (altroveErr || !Array.isArray(altrove)) {
              // Non sapere non può voler dire riusare: si prosegue verso l'INSERT,
              // che sul vincolo UNIQUE globale darà 23505 (→ MSG_CF_DUPLICATO).
              registraGuasto(altroveErr);
            } else {
              const altraSede = (altrove as { scuola_id?: unknown }[]).find(
                (r) => typeof r?.scuola_id === 'string' && r.scuola_id !== scuolaId,
              );
              if (altraSede) {
                // Qui si FERMA la riga, e si ferma PRIMA di qualunque scrittura:
                // gli adulti si creano più sotto, quindi bloccare a valle avrebbe
                // comunque prodotto il `parents` e — con l'upsert su
                // `student_parents` — il diritto di lettura che si vuole negare.
                bloccatiCfAltraSede++;
                throw new Error(MSG_CF_ALTRA_SEDE);
              }
            }
          }
        }
        if (!studentId) {
          const record = {
            scuola_id: scuolaId,
            nome: fam.alunno.nome,
            cognome: fam.alunno.cognome,
            data_nascita: fam.alunno.data_nascita || null,
            gender: fam.alunno.sesso || null,
            codice_fiscale: fam.alunno.codice_fiscale || null,
            birth_city: fam.alunno.comune_nascita || null,
            birth_province: fam.alunno.provincia_nascita || null,
            residence_address: fam.alunno.indirizzo_residenza || null,
            residence_city: fam.alunno.comune_residenza || null,
            zip_code: fam.alunno.cap || null,
            // Il trigger DB sincronizza section_id da classe_sezione.
            classe_sezione: fam.alunno.classe_sezione || null,
            stato: 'iscritto',
          };
          const { data: created, error } = await supabase
            .from('alunni')
            .insert(record)
            .select('id')
            .single();
          if (error) {
            const codice = (error as { code?: string }).code ?? null;
            throw new Error(codice === '23505' ? MSG_CF_DUPLICATO : `alunno: ${error.message}`);
          }
          studentId = created.id;
          alunniCreati++;
        }

        // ─── 2. Genitori — dedup su parents.fiscal_code; link student_parents ───
        for (const gen of fam.genitori) {
          let parentId: string | null = null;
          if (gen.fiscal_code) {
            // La dedup dei GENITORI resta DELIBERATAMENTE globale, al contrario di
            // quella dei bambini: un adulto PUÒ avere figli in due sedi (Giugliano,
            // Aversa e Cesa sono la stessa cooperativa), `parents` non ha
            // `scuola_id` e non deve averlo — la sede di un adulto è un attributo
            // dei suoi LEGAMI, non suo. Restringerla creerebbe una seconda
            // identità per lo stesso genitore.
            const { data: ep, error: epErr } = await supabase
              .from('parents')
              .select('id')
              .eq('fiscal_code', gen.fiscal_code)
              .maybeSingle();
            if (epErr) registraGuasto(epErr);
            else if (ep) parentId = ep.id as string;
          }
          if (parentId) {
            // …ma RIUSARE quel record non è gratis: il legame che si sta per
            // scrivere dà a un account già esistente la scheda del bambino che si
            // sta importando. `assertParentInScope` deriva lo scope dai FIGLI: un
            // genitore raggiungibile solo attraverso minori di un'altra sede non è
            // roba di chi importa. Cross-sede resta possibile — ma solo per la
            // Direzione, che quelle sedi le ha in scope (decisione del 30/07).
            const fuoriScope = await assertParentInScope(supabase, auth.user, parentId);
            if (fuoriScope) {
              if (fuoriScope.status === 403) bloccatiGenitoreAltraSede++;
              else registraGuasto(null);
              throw new Error(
                fuoriScope.status === 403
                  ? msgGenitoreAltraSede(gen.last_name)
                  : msgGenitoreNonVerificabile(gen.last_name),
              );
            }
          }
          if (!parentId) {
            const { data: np, error: pe } = await supabase
              .from('parents')
              .insert({
                first_name: gen.first_name,
                last_name: gen.last_name,
                fiscal_code: gen.fiscal_code || null,
                emails: gen.email ? [gen.email] : [],
                phone_numbers: gen.phone ? [gen.phone] : [],
                // `citizenship` conserva il ruolo (workaround esistente della codebase).
                citizenship: gen.role,
              })
              .select('id')
              .single();
            if (pe) throw new Error(`genitore ${gen.last_name}: ${pe.message}`);
            parentId = np.id;
            genitoriCreati++;
          }

          const { error: le } = await supabase.from('student_parents').upsert(
            {
              student_id: studentId,
              parent_id: parentId,
              relation_type: gen.role,
              is_primary: gen.role === 'mother' || gen.role === 'father',
            },
            { onConflict: 'student_id,parent_id', ignoreDuplicates: true },
          );
          if (le) throw new Error(`legame ${gen.last_name}: ${le.message}`);
          legami++;
        }
      } catch (err) {
        // +2: intestazione + indice 1-based → numero riga nel foglio.
        errori.push({ riga: i + 2, messaggio: (err as Error).message });
      }
    }

    if (bloccatiCfAltraSede > 0 || bloccatiGenitoreAltraSede > 0) {
      // `error` → persistito. Un tentativo di agganciare un minore (o una famiglia)
      // di un'altra sede è un evento di sicurezza, non un refuso: va visto anche
      // quando chi importava non lo racconta. Solo uuid e conteggi — il codice
      // fiscale e il nome sono dati di un minore, e per giunta della potenziale
      // vittima dell'aggancio: mai in `app_log`.
      logEvento('multi_sede', 'error', {
        operazione: 'admin/import/anagrafiche:POST',
        esito: 'import-bloccato-cross-sede',
        sede_id: scuolaId,
        ruolo: auth.user.role,
        righe_cf_altra_sede: bloccatiCfAltraSede,
        righe_genitore_altra_sede: bloccatiGenitoreAltraSede,
        righe_totali: families.filter(Boolean).length,
      });
    }
    if (lettureNonRiuscite > 0) {
      // Configurazione/schema assente ⇒ `info` (è il DB E2E della CI, non migrato);
      // qualunque altro guasto ⇒ `error`: la dedup per sede non ha girato, e
      // «nessun log» non deve poter significare «tutto a posto».
      logEvento('db', soloSchemaAssente ? 'info' : 'error', {
        operazione: 'admin/import/anagrafiche:POST',
        esito: 'dedup-sede-non-disponibile',
        letture: lettureNonRiuscite,
        error_code: ultimoCodice,
      });
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'import_anagrafiche',
      azione: 'insert',
      scuolaId,
      valoreDopo: {
        alunniCreati,
        genitoriCreati,
        legami,
        errori: errori.length,
        bloccatiCrossSede: bloccatiCfAltraSede + bloccatiGenitoreAltraSede,
      },
    });

    return NextResponse.json({
      ok: true,
      totale: families.filter(Boolean).length,
      alunniCreati,
      genitoriCreati,
      legami,
      errori,
    });
  } catch (err) {
    logErrore({ operazione: 'admin/import/anagrafiche:POST', stato: 500 }, err);
    const msg = err instanceof Error ? err.message : 'Errore interno';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
