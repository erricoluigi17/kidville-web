import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const STATI = ['presente', 'assente', 'ritardo', 'uscita_anticipata'] as const

/**
 * LE COLONNE DELL'APPELLO — quelle che questa rotta scrive, e le sole che
 * possono uscirne o finire in archivio.
 *
 * Restano fuori, e non per risparmiare banda:
 *  · `giustificazione_testo` — il motivo scritto dalla famiglia: testo libero di
 *    natura sanitaria di un MINORE (art. 9 GDPR);
 *  · `giustificazione_firma` — il log della firma elettronica del genitore, con
 *    la sua email, il suo indirizzo IP e il suo user-agent;
 *  · `giustificata_da` / `giustificata_il` / `giust_vista_da` — chi ha
 *    giustificato e quando: dati di un'altra operazione, di un altro attore.
 *
 * Il motivo NON sparisce dal prodotto: l'appello della primaria lo LEGGE dalla
 * sua GET, che è la superficie dichiarata alla famiglia. Qui si tratta di ciò
 * che torna dall'ECO di una scrittura e di ciò che finisce in
 * `audit_scritture_docente`, dove sarebbe conservato per anni senza che nessuno
 * l'abbia chiesto.
 */
const COLONNE_APPELLO =
  'id, alunno_id, section_id, scuola_id, data, stato, orario_entrata, orario_uscita, note_appello, registrato_da, giustificata, giust_vista_il'

const getQuerySchema = z.object({
  sectionId: zUuid,
  data: zDataYMD,
})

// Base loose: il dispatch singolo/bulk legge dal body campi diversi (records
// oppure alunnoId/stato/... top-level), poi validati con recordsSchema.
const postBaseSchema = z.object({
  sectionId: zUuid,
  data: zDataYMD,
}).loose()

const recordSchema = z.object({
  alunnoId: zUuid,
  stato: z.enum(STATI),
  noteAppello: z.string().nullish(),
  // 'HH:MM'; altri formati ricadono su null (toTs) come oggi: nessun vincolo qui.
  orarioEntrata: z.string().nullish(),
  orarioUscita: z.string().nullish(),
})
const recordsSchema = z.array(recordSchema)

// GET /api/primaria/appello?sectionId=&data=&userId=
// Alunni della classe + stato presenza del giorno.
export const GET = withRoute('primaria/appello:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId, data } = q.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    const [{ data: alunni }, { data: presenze }] = await Promise.all([
      supabase.from('alunni').select('id, nome, cognome').eq('section_id', sectionId).order('cognome'),
      supabase
        .from('presenze')
        .select('id, alunno_id, stato, note_appello, orario_entrata, orario_uscita, giustificata, giustificazione_testo, giust_vista_il')
        .eq('section_id', sectionId)
        .eq('data', data),
    ])

    const statoByAlunno = new Map((presenze ?? []).map((p) => [p.alunno_id, p]))
    const data_ = (alunni ?? []).map((a) => {
      const p = statoByAlunno.get(a.id)
      return {
        ...a,
        presenza_id: p?.id ?? null,
        stato: p?.stato ?? null,
        note_appello: p?.note_appello ?? null,
        orario_entrata: p?.orario_entrata ?? null,
        orario_uscita: p?.orario_uscita ?? null,
        giustificata: p?.giustificata ?? false,
        giustificazione_testo: p?.giustificazione_testo ?? null,
        giust_vista_il: p?.giust_vista_il ?? null,
      }
    })

    return NextResponse.json({ success: true, data: data_ })
  } catch (err) {
    logErrore({ operazione: 'primaria/appello:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/primaria/appello?userId=
//   singolo: { sectionId, alunnoId, data, stato, noteAppello? }
//   bulk:    { sectionId, data, records: [{ alunnoId, stato, noteAppello? }] }
export const POST = withRoute('primaria/appello:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id
    const b = await parseBody(request, postBaseSchema)
    if ('response' in b) return b.response
    const { sectionId, data } = b.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // Dispatch singolo/bulk come oggi: records array → bulk, altrimenti campi top-level.
    const rawRecords = Array.isArray(b.data.records)
      ? b.data.records
      : [{ alunnoId: b.data.alunnoId, stato: b.data.stato, noteAppello: b.data.noteAppello, orarioEntrata: b.data.orarioEntrata, orarioUscita: b.data.orarioUscita }]
    const rec = parseData(recordsSchema, rawRecords)
    if ('response' in rec) return rec.response
    const records = rec.data

    // Compone un timestamp completo da data (YYYY-MM-DD) + orario (HH:MM).
    const toTs = (orario?: string | null) =>
      orario && /^\d{2}:\d{2}$/.test(orario) ? `${data}T${orario}:00` : null

    // Gli alunni dei record devono appartenere alla sezione asserita (no upsert cross-sezione).
    const alunniErr = await assertAlunniInSezione(supabase, records.map((r) => r.alunnoId), sectionId)
    if (alunniErr) return alunniErr

    // La SEDE della presenza, letta PRIMA di scrivere (serviva già più sotto per
    // la notifica: qui è solo anticipata). Fino al 2026-07-31 l'upsert non
    // portava `scuola_id` e in produzione 12 presenze su 49 sono finite in
    // tabella con la chiave di tenant vuota: righe che nessun filtro
    // `.in('scuola_id', plessi)` può più vedere, cioè un registro che si
    // accorcia in silenzio. La sede è una proprietà del DATO, non del chiamante.
    //
    // PostgREST non lancia: si controlla `{ error }`. Sede non risolvibile ⇒ si
    // RIFIUTA la scrittura: una presenza senza plesso è peggio di un errore.
    const { data: sezione, error: sezErr } = await supabase
      .from('sections')
      .select('scuola_id')
      .eq('id', sectionId)
      .maybeSingle()
    const scuolaId = (sezione?.scuola_id as string | undefined) ?? null
    if (sezErr || !scuolaId) {
      logEvento('db', 'error', {
        operazione: 'primaria/appello:POST',
        esito: 'sede-sezione-non-risolta',
        sezione: sectionId,
      }, sezErr)
      return NextResponse.json({ error: 'Sede della sezione non risolvibile' }, { status: 500 })
    }

    // Stato PRIMA (per audit diff).
    //
    // ─── SI CHIEDONO LE COLONNE DELL'APPELLO, NON VENTICINQUE ───────────────
    //
    // `select('*')` qui costa più che altrove, e non per la banda: queste righe
    // finiscono in `audit_scritture_docente` come `valorePrima`/`valoreDopo`,
    // cioè in un ARCHIVIO che dura anni. Ci finivano perciò
    // `giustificazione_testo` — testo libero di natura sanitaria di un minore,
    // art. 9 — e `giustificazione_firma`, con EMAIL, INDIRIZZO IP e USER-AGENT
    // del genitore che ha firmato: dati che questa rotta non scrive, non mostra
    // e non deve conservare. `bonificaAuditScritture` esiste proprio per andarli
    // a ripulire dopo; è meglio non scriverceli.
    //
    // L'elenco è quello delle colonne che l'appello SCRIVE (più le due che
    // raccontano lo stato della giustifica come booleano/data): un diff su
    // colonne che la rotta non tocca non ha mai detto niente a nessuno.
    const alunnoIds = records.map((r) => r.alunnoId)
    const { data: prima, error: primaErr } = await supabase
      .from('presenze')
      .select(COLONNE_APPELLO)
      .eq('section_id', sectionId)
      .eq('data', data)
      .in('alunno_id', alunnoIds)
    if (primaErr) {
      // PostgREST non lancia (AGENTS.md, regola 7). Il salvataggio prosegue — il
      // diff «prima» è un di più — ma un audit a metà non deve essere muto.
      logEvento('db', 'warn', {
        operazione: 'primaria/appello:POST',
        esito: 'stato-precedente-non-letto',
        sezione: sectionId,
      }, primaErr)
    }

    const rows = records.map((r) => ({
      alunno_id: r.alunnoId,
      section_id: sectionId,
      scuola_id: scuolaId,
      data,
      stato: r.stato,
      note_appello: r.noteAppello ?? null,
      // Orario di entrata solo per ritardo, orario di uscita solo per uscita anticipata.
      orario_entrata: r.stato === 'ritardo' ? toTs(r.orarioEntrata) : null,
      orario_uscita: r.stato === 'uscita_anticipata' ? toTs(r.orarioUscita) : null,
      // Provenienza operativa: chi ha registrato (può essere la segreteria). NON è una firma.
      registrato_da: userId,
    }))

    const { data: saved, error } = await supabase
      .from('presenze')
      .upsert(rows, { onConflict: 'alunno_id,data' })
      .select(COLONNE_APPELLO)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Audit (diff prima/dopo) + notifica al docente titolare (se segreteria/direzione).
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'presenze',
      azione: 'update',
      sectionId,
      valorePrima: prima ?? [],
      valoreDopo: saved ?? [],
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, area: 'appello', link: `/teacher/primaria/${sectionId}/appello` })

    // Notifica "assenza all'appello" ai genitori (best-effort). Scatta SOLO per
    // chi DIVENTA assente senza assenza comunicata (giustificata/giustificata_da
    // sulla riga preesistente = il genitore aveva avvisato). Il buffer 10' è la
    // finestra di correzione: assente → presente/ritardo revoca la pending.
    try {
      const primaByAlunno = new Map(
        ((prima ?? []) as Array<{ alunno_id: string; stato?: string | null; giustificata?: boolean | null; giustificata_da?: string | null }>)
          .map((p) => [p.alunno_id, p]),
      )
      const revocati = records
        .filter((r) => r.stato !== 'assente' && primaByAlunno.get(r.alunnoId)?.stato === 'assente')
        .map((r) => r.alunnoId)
      for (const alunnoId of revocati) {
        await supabase
          .from('notifiche')
          .delete()
          .eq('tipo', 'assenza_non_comunicata')
          .eq('entita_id', alunnoId)
          .is('push_inviata_il', null)
      }

      const nuoviAssenti = records
        .filter((r) => {
          if (r.stato !== 'assente') return false
          const p = primaByAlunno.get(r.alunnoId)
          if (p?.stato === 'assente') return false // ri-salvataggio: già gestito
          if (p?.giustificata || p?.giustificata_da) return false // assenza comunicata
          return true
        })
        .map((r) => r.alunnoId)
      if (nuoviAssenti.length > 0) {
        const { data: anagrafiche } = await supabase.from('alunni').select('id, nome').in('id', nuoviAssenti)
        for (const a of (anagrafiche ?? []) as Array<{ id: string; nome?: string | null }>) {
          await notificaEvento(supabase, {
            tipo: 'assenza_non_comunicata',
            scuolaId,
            alunnoIds: [a.id],
            titolo: 'Assenza registrata all’appello',
            corpo: `${a.nome ?? 'Tuo figlio'} è risultato assente oggi senza un'assenza comunicata. Ricordati di giustificare.`,
            link: '/parent/primaria/assenze',
            entitaTipo: 'presenza',
            entitaId: a.id,
            bufferMin: 10,
            debounce: true,
          })
        }
      }
    } catch (e) {
      // L'appello è salvato, ma l'avviso di assenza non comunicata non partirà:
      // il genitore non saprà che il figlio risulta assente. Scrittura persa.
      logEvento('notifica', 'error', {
        operazione: 'primaria/appello:POST',
        tipo: 'assenza_non_comunicata',
        esito: 'notifica_non_inviata',
      }, e)
    }

    return NextResponse.json({ success: true, data: saved ?? [] })
  } catch (err) {
    logErrore({ operazione: 'primaria/appello:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
