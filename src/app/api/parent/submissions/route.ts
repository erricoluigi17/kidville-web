import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { assertGenitoreNonSospesoSalvoEssenziale } from '@/lib/pagamenti/sospensione';
import { leggiSempreFirmabile } from '@/lib/forms/sempre-firmabile';
import { persistSignedSubmission } from '@/lib/forms/persist-submission';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { staffScuola } from '@/lib/notifiche/destinatari';
import { sedeDiAlunno, sediDeiFigli } from '@/lib/anagrafiche/sedi';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3/M4) ─────────────────────────────────────
// L'identità viene dal gate (requireUser): il `parent_id` legacy in query/body
// è ignorato, nessun fallback demo (M4).

// student_id opzionale: stringa vuota trattata come assente
// (persistSignedSubmission fa già `student_id || null`).
const zStudentIdOpzionale = z.preprocess(
  (v) => (v === '' ? undefined : v),
  zUuid.nullish()
);

const postBodySchema = z.object({
  form_id: zUuid,
  student_id: zStudentIdOpzionale,
  // answers è un pass-through jsonb: oggi è accettato qualsiasi valore truthy.
  answers: z.unknown().refine((v) => !!v, 'form_id e risposte obbligatori'),
  // is_signed è già coercito a boolean (`!!is_signed`) in persistSignedSubmission.
  is_signed: z.coerce.boolean().optional(),
  signature_log: z.unknown().optional(),
});

const getQuerySchema = z.object({});

/**
 * LE SEGRETERIE DA AVVISARE: PRIMA QUELLA DEL MODULO, POI QUELLE DEI FIGLI.
 * MAI QUELLA DELL'ACCOUNT.
 *
 * ─── COS'ERA ─────────────────────────────────────────────────────────────────
 *     if (!scuolaId) scuolaId = auth.user.scuola_id ?? (await scuolaUnicaReale(supabase))
 *
 * `auth.user.scuola_id` è la sede dell'ACCOUNT, cioè il plesso in cui l'account è
 * stato aperto. Un genitore può avere due figli in due plessi — `parents` non ha
 * `scuola_id`, ed è una scelta esplicita (vedi `admin/parents/route.ts`) — quindi
 * quel valore è al più UNA delle sue sedi, e può non essere nessuna delle attuali.
 * Misurato in produzione il 2026-09-03: **639 account genitore su 639** hanno
 * `utenti.scuola_id` valorizzata — il ripiego non falliva mai, quindi decideva
 * sempre — e in 6 contraddice almeno un figlio. `scuolaUnicaReale`, l'anello dopo,
 * non veniva mai raggiunto: è deprecata e con tre sedi risponde comunque `null`.
 *
 * ─── E COS'ERA ANCORA, DOPO LA PRIMA CORREZIONE ──────────────────────────────
 * La prima riscrittura dedusse la sede dai FIGLI e, con due plessi, avvisò
 * ENTRAMBE le segreterie. Copre, ma risolve il problema sbagliato: **il modulo
 * una sede certa ce l'ha**. `forms_templates.scuola_id` è NOT NULL (baseline riga
 * 1732, riverificata in produzione il 2026-09-03), e `parent/forms:GET` elenca a
 * una famiglia solo i moduli delle sedi dei suoi figli. Un genitore con figli a
 * Giugliano e ad Aversa che firma un modulo DI AVERSA faceva arrivare «Modulo
 * compilato ricevuto» anche alla segreteria di Giugliano, con un link a una
 * modulistica che in quel plesso non esiste: la «Direzione senza titolo» che il
 * commento di `segnalazioni:POST` dice di evitare. E per giunta spegneva il
 * debounce senza motivo. La sede era a una `select` di distanza — la route
 * leggeva GIÀ `forms_templates`, per il titolo, e non ne prendeva il plesso.
 *
 * ─── L'ORDINE, E PERCHÉ È QUESTO ─────────────────────────────────────────────
 *  1. `forms_templates.scuola_id` — il dato certo, NOT NULL, di chi ha creato il
 *     modulo. Con questo la sede è UNA, il ramo a due non si imbocca e il
 *     debounce resta acceso.
 *  2. la sede del BAMBINO, se il modulo è legato a uno.
 *  3. le sedi dei FIGLI.
 * I punti 2 e 3 restano perché il punto 1 può mancare: su un database non
 * migrato la `select` fallisce in blocco (PostgREST `42703`), e degradare a
 * «avviso le segreterie dei figli» è meglio che non avvisare nessuno.
 *
 * ─── PERCHÉ AL PUNTO 3 SI COPRONO TUTTE, INVECE DI RIFIUTARE ─────────────────
 * Perché non si sta archiviando niente in un plesso: la compilazione è GIÀ
 * salvata e `forms_submissions` non ha una `scuola_id` da sbagliare. Qui si
 * decide soltanto CHI viene informato, e in un ramo di degradazione avvisare in
 * più è meno grave che non avvisare. (Dove invece si SCRIVE una riga, la regola
 * resta l'opposta: `segnalazioni:POST` rifiuta con 503 piuttosto che indovinare
 * il plesso.)
 *
 * Elenco vuoto = «non lo so», e il chiamante non accoda niente: `staffScuola(null)`
 * non avviserebbe nessuno, e una notifica senza destinatari è rumore che somiglia
 * a un successo.
 */
async function sediDaAvvisare(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sedeModulo: string | null,
  studentId: string | null | undefined,
  accountGenitore: string,
): Promise<string[]> {
  // Le due letture (bambino → plesso, figli → plessi) stanno in
  // `@/lib/anagrafiche/sedi`: erano scritte identiche in tre route, e in questo
  // repo una regola valida per più strade vive in un posto solo. Lì dentro c'è
  // anche il controllo di `{ error }` — PostgREST non lancia — e la riga di log
  // che distingue «non ha un plesso» da «non ho potuto leggerlo».
  const ctx = { gruppo: 'modulistica', operazione: 'parent/submissions:POST' };

  // 1) LA SEDE DEL MODULO. Non si deduce niente: è il plesso in cui il modulo è
  //    stato creato, ed è l'unico che abbia una modulistica dove aprire il link.
  if (sedeModulo) return [sedeModulo];

  // 2) Il modulo è legato a un bambino: quel bambino ha UN plesso.
  if (studentId) {
    const sede = await sedeDiAlunno(supabase, studentId, ctx);
    if (sede) return [sede];
  }

  // 3) Nessun bambino (o bambino senza plesso): le sedi sono quelle dei FIGLI.
  return await sediDeiFigli(supabase, accountGenitore, ctx);
}

// POST: Sottoscrive e firma un modulo
export const POST = withRoute('parent/submissions:POST', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const { form_id, student_id, answers, is_signed, signature_log } = b.data;

    const supabase = await createAdminClient();

    // ── IDOR: questa riga era scritta come un permesso e non controllava niente ──
    //
    // Diceva:
    //   `if (student_id && auth.user.role === 'genitore' && !genitoreHasFiglio(…))`
    // cioè: «se sei un genitore e quel bambino non è tuo figlio, ti nego». Per
    // chiunque NON avesse il ruolo ATTIVO `genitore` — la cuoca, la segreteria di
    // un altro plesso, l'educator di un'altra sede, e la docente-genitore in veste
    // di lavoro — il controllo semplicemente NON C'ERA: `requireUser` ammette ogni
    // utente autenticato, e questa condizione era l'unica cosa fra un account
    // qualunque e l'archiviazione di una compilazione a nome di un minore indicato
    // per uuid.
    //
    // Il rimedio NON è scambiare il predicato: `eFamiglia` avrebbe lasciato in
    // piedi la stessa forma (nego a un genitore, non chiedo niente agli altri). La
    // domanda giusta non è «di che ruolo sei» ma «questo bambino ti è
    // raggiungibile?», e `requireParentOfStudent` la risponde per TUTTI: legame di
    // famiglia per chi è famiglia — e la biforcazione è sul legame, non sulla veste,
    // così una docente-genitore compila per il proprio figlio anche fuori dalle
    // sezioni che insegna — plesso e sezione per tutti gli altri.
    //
    // `student_id` assente = onboarding: si compila PRIMA che esista un bambino a
    // cui riferire il modulo, quindi non c'è niente a cui applicare il gate.
    if (student_id) {
      const gateAlunno = await requireParentOfStudent(request, student_id);
      if (gateAlunno.response) return gateAlunno.response;
    }

    // Sospensione moroso (finding #4: ramo scoperto): sottoscrivere/firmare un
    // modulo Sistema B è un'azione di servizio → bloccata, salvo i moduli
    // essenziali (forms_templates.sempre_firmabile). Il flag si legge col retry 42703.
    const sempreFirmabile = await leggiSempreFirmabile(supabase, 'forms_templates', form_id);
    const sospesoErr = await assertGenitoreNonSospesoSalvoEssenziale(supabase, auth.user.id, { sempreFirmabile });
    if (sospesoErr) return sospesoErr;

    const result = await persistSignedSubmission(supabase, {
      form_id,
      parent_id: auth.user.id,
      student_id,
      answers: answers as Record<string, unknown>,
      is_signed,
      signature_log,
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Notifica alla segreteria: modulo firmato ricevuto (best-effort).
    try {
      // TITOLO E SEDE DEL MODULO SI LEGGONO INSIEME, in una `select` sola.
      // `forms_templates.scuola_id` è NOT NULL: il modulo un plesso ce l'ha
      // sempre, ed è quello — non c'è niente da dedurre dai figli finché questa
      // lettura riesce. `{ error }` va controllato (PostgREST non lancia): senza,
      // «il modulo non ha sede» e «non ho potuto leggerlo» sarebbero lo stesso
      // `null`, e solo uno dei due manda la notifica alla segreteria sbagliata.
      const { data: tpl, error: tplErr } = await supabase
        .from('forms_templates')
        .select('title, scuola_id')
        .eq('id', form_id)
        .maybeSingle();
      if (tplErr) {
        logEvento('modulistica', 'warn', {
          operazione: 'parent/submissions:POST',
          esito: 'modulo-non-letto',
          entita_id: form_id,
          error_code: (tplErr as { code?: string }).code ?? null,
        }, tplErr);
      }
      const titolo = (tpl as { title?: string } | null)?.title ?? 'un modulo';
      const sedeModulo = ((tpl as { scuola_id?: unknown } | null)?.scuola_id as string | null) ?? null;

      const sedi = await sediDaAvvisare(supabase, sedeModulo, student_id, auth.user.id);
      if (sedi.length === 0) {
        // Niente notifica al buio: `staffScuola(null)` non avviserebbe nessuno e
        // resterebbe una riga «accodata» senza destinatari, indistinguibile da un
        // successo. `error` perché a mancare è la NOSTRA anagrafica — un genitore
        // senza nemmeno un figlio con un plesso — non un dato dell'utente.
        logEvento('modulistica', 'error', {
          operazione: 'parent/submissions:POST',
          esito: 'sede-non-attribuibile',
          entita_id: form_id,
        });
      } else {
        // ⚠️ IL DEBOUNCE SI SPEGNE QUANDO LE SEDI SONO PIÙ D'UNA, e non è una
        // sfumatura: `notificaEvento` lo esegue come
        //   delete from notifiche where tipo = ? and entita_id = ? and push_inviata_il is null
        // senza filtro per sede né per destinatario. Con lo stesso `entitaId` (il
        // `form_id`) su due chiamate, la seconda cancellerebbe la riga appena
        // accodata per la prima segreteria — «avvisate entrambe» diventerebbe
        // «avvisata solo l'ultima», e in silenzio.
        //
        // Da quando la sede la dà il MODULO, questo ramo è di sola degradazione:
        // con la lettura di `forms_templates` riuscita la sede è una e il
        // debounce resta ACCESO, che è il caso normale — collassa le raffiche di
        // compilazioni dello stesso modulo in una notifica sola.
        const collassaLeRaffiche = sedi.length === 1;
        for (const scuolaId of sedi) {
          const destinatari = await staffScuola(supabase, scuolaId, ['admin', 'coordinator', 'segreteria']);
          await notificaEvento(supabase, {
            tipo: 'modulo_compilato',
            scuolaId,
            utenteIds: destinatari,
            titolo: 'Modulo compilato ricevuto',
            corpo: `Ci sono nuove compilazioni per «${titolo}».`,
            link: '/admin/modulistica',
            entitaTipo: 'forms_template',
            entitaId: form_id,
            bufferMin: 60,
            debounce: collassaLeRaffiche,
          });
        }
      }
    } catch (e) {
      // Il modulo è acquisito, ma la segreteria non saprà che è arrivato: notifica persa.
      logEvento('notifica', 'error', {
        operazione: 'parent/submissions:POST',
        tipo: 'modulo_compilato',
        esito: 'notifica_non_inviata',
      }, e);
    }

    return NextResponse.json(result.submission, { status: 201 });
  } catch (err) {
    logErrore({ operazione: 'parent/submissions:POST', stato: 500 }, err);
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
})

// GET: Recupera tutte le sottomissioni per l'archivio genitore
export const GET = withRoute('parent/submissions:GET', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;
    const parentId = auth.user.id;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

    const supabase = await createAdminClient();

    // Query difensiva: niente embed annidato PostgREST (che dà 500 quando la
    // relazione FK non è riconosciuta) → base + arricchimento con query separate.
    const { data: subs, error } = await supabase
      .from('forms_submissions')
      .select('*')
      .eq('parent_id', parentId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = (subs ?? []) as Record<string, unknown>[];
    const formIds = [...new Set(rows.map((s) => s.form_id).filter(Boolean))] as string[];
    const studentIds = [...new Set(rows.map((s) => s.student_id).filter(Boolean))] as string[];

    const [tplRes, alRes] = await Promise.all([
      formIds.length
        ? supabase.from('forms_templates').select('id, title, description').in('id', formIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      studentIds.length
        ? supabase.from('alunni').select('id, nome, cognome').in('id', studentIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    ]);

    const tById = new Map((tplRes.data ?? []).map((t: Record<string, unknown>) => [t.id, { title: t.title, description: t.description }]));
    const aById = new Map((alRes.data ?? []).map((a: Record<string, unknown>) => [a.id, { nome: a.nome, cognome: a.cognome }]));

    const enriched = rows.map((s) => ({
      ...s,
      forms_templates: s.form_id ? tById.get(s.form_id as string) ?? null : null,
      alunni: s.student_id ? aById.get(s.student_id as string) ?? null : null,
    }));

    return NextResponse.json(enriched);
  } catch (err) {
    logErrore({ operazione: 'parent/submissions:GET', stato: 500 }, err);
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
})
