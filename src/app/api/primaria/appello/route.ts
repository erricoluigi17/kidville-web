import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { colonneConMotivo } from '@/lib/presenze/motivo-visibile'
import { aOrarioIso } from '@/lib/presenze/orario'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid, zOraHHMM } from '@/lib/validation/common'
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
  // `zOraHHMM`, lo STESSO schema della rettifica 0-6. Prima era `z.string()` nudo:
  // «pippo» superava la validazione e moriva dentro il costruttore del timestamp,
  // che restituiva `null` — cioè un 200 e un orario sparito in silenzio. Un formato
  // sbagliato è un errore del client e si dice: 400.
  orarioEntrata: zOraHHMM.nullish(),
  orarioUscita: zOraHHMM.nullish(),
})
const recordsSchema = z.array(recordSchema)

// GET /api/primaria/appello?sectionId=&data=&userId=
// Alunni della classe + stato presenza del giorno.
/**
 * La riga d'appello come torna dal database.
 *
 * `giustificazione_testo` è OPZIONALE nel tipo, ed è la parte che conta: la colonna non
 * viene chiesta quando chi guarda vede tutte le classi del plesso (`colonneConMotivo`),
 * quindi «assente» è un esito legittimo e non un errore. Con una stringa di select
 * dinamica l'inferenza di postgrest-js non può più dedurre la forma: si dichiara qui, una
 * volta, invece di castare a `any` nel punto d'uso.
 */
interface RigaAppello {
  id: string
  alunno_id: string
  stato: string | null
  note_appello: string | null
  orario_entrata: string | null
  orario_uscita: string | null
  giustificata: boolean | null
  giustificazione_testo?: string | null
  giust_vista_il: string | null
}

/** Le colonne della riga d'appello. Il motivo esce solo per chi la frase del genitore nomina. */
const COLONNE_RIGA_APPELLO = [
  'id',
  'alunno_id',
  'stato',
  'note_appello',
  'orario_entrata',
  'orario_uscita',
  'giustificata',
  'giustificazione_testo',
  'giust_vista_il',
] as const

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
        // `colonneConMotivo`: la stessa regola della rotta gemella
        // `attendance/daily:GET` — `requireDocente` + `assertSezioneInScope`
        // restringono alla sezione SOLO chi non passa da `vedeTutteLeClassi`,
        // quindi senza questo filtro il motivo dell'assenza arriva ad admin,
        // coordinator e segreteria per OGNI classe del plesso, mentre la frase
        // mostrata al genitore dice «le insegnanti della sezione» (rilievo Q1).
        // Il rilievo nominava l'altra rotta: la regola vale per tutte e due, e
        // vive in `src/lib/presenze/motivo-visibile.ts`.
        .select(colonneConMotivo(COLONNE_RIGA_APPELLO, auth.user))
        .eq('section_id', sectionId)
        .eq('data', data),
    ])

    const righe = (presenze ?? []) as unknown as RigaAppello[]
    const statoByAlunno = new Map(righe.map((p) => [p.alunno_id, p]))
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
    //
    // ⚠️ NEL RAMO SINGOLO SI COPIANO SOLO LE CHIAVI CHE IL CORPO PORTA DAVVERO.
    // Prima l'oggetto si costruiva elencando i cinque campi sempre, quindi
    // `noteAppello` esisteva comunque — con valore `undefined` — e a valle non c'era
    // più modo di distinguere «non l'ho mandato» da «mandalo vuoto». È lì che si
    // perdeva la nota dell'appello: `setOrario` non la manda, e la riga la riscriveva
    // a `null`. Il ramo bulk non aveva il problema perché il client i suoi campi li
    // elenca da sé.
    const singolo: Record<string, unknown> = {}
    for (const campo of ['alunnoId', 'stato', 'noteAppello', 'orarioEntrata', 'orarioUscita'] as const) {
      if (campo in (b.data as Record<string, unknown>)) singolo[campo] = (b.data as Record<string, unknown>)[campo]
    }
    const rawRecords = Array.isArray(b.data.records) ? b.data.records : [singolo]
    const rec = parseData(recordsSchema, rawRecords)
    if ('response' in rec) return rec.response
    const records = rec.data

    // L'istante si compone col MOTORE UNICO (`@/lib/presenze/orario`), non a mano.
    // Il vecchio `${data}T${orario}:00` produceva una forma ISO NAÏVE — senza fuso —
    // ed era la sorgente delle righe non canoniche in colonna: alle 08:45 di
    // settembre e alle 08:45 di gennaio scriveva la stessa identica stringa, benché
    // siano due istanti diversi. `aOrarioIso` sa che l'orologio è quello di Roma e
    // gestisce i due giorni dell'anno in cui l'ora cambia.
    const toTs = (orario?: string | null) => (orario ? aOrarioIso(data, orario) : null)

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
      // PostgREST non lancia (AGENTS.md, regola 7).
      //
      // ⚠️ QUESTA LETTURA È PORTANTE, e fino al 2026-09-07 non lo era: il salvataggio
      // proseguiva con un `warn` perché il diff «prima» era «un di più». Da quando la
      // riga si costruisce a partire da ciò che c'era, proseguire con un `prima` vuoto
      // significa azzerare note e orari IN SILENZIO — cioè rifare per un'altra strada
      // il difetto che questo blocco esiste per chiudere. Meglio un 500 visibile che
      // una nota di un docente cancellata senza che nessuno lo sappia.
      logEvento('db', 'error', {
        operazione: 'primaria/appello:POST',
        esito: 'stato-precedente-non-letto',
        sezione: sectionId,
      }, primaErr)
      return NextResponse.json(
        { error: 'Stato precedente non leggibile', codice: 'APPELLO_STATO_PRIMA_NON_LETTO' },
        { status: 500 },
      )
    }

    // Ciò che c'È GIÀ in tabella, per alunno. È la base su cui si costruisce la riga
    // nuova: l'upsert riscrive la RIGA INTERA, quindi una colonna non nominata dal
    // corpo tornerebbe `null`.
    const esistente = new Map<string, Record<string, unknown>>(
      ((prima ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.alunno_id), r]),
    )
    // «Il corpo lo nomina?» — e non «ha un valore?». `null` esplicito è un COMANDO
    // («togli la nota»), l'assenza del campo non lo è mai. Con `?? undefined` i due
    // casi si confondono, ed è la confusione che cancellava le note.
    const nominato = (r: Record<string, unknown>, campo: string) => campo in r

    const rows = records.map((r) => {
      const prec = esistente.get(r.alunnoId) ?? {}
      const grezzo = r as unknown as Record<string, unknown>

      // Un ASSENTE non ha orari: quelli si azzerano davvero (stessa regola dello 0-6).
      // Per tutti gli altri stati l'orario si CONSERVA se il corpo non lo nomina.
      const assente = r.stato === 'assente'
      const orarioEntrata = assente
        ? null
        : nominato(grezzo, 'orarioEntrata')
          ? toTs(r.orarioEntrata)
          : (prec.orario_entrata ?? null)
      const orarioUscita = assente
        ? null
        : nominato(grezzo, 'orarioUscita')
          ? toTs(r.orarioUscita)
          : (prec.orario_uscita ?? null)

      return {
        alunno_id: r.alunnoId,
        section_id: sectionId,
        scuola_id: scuolaId,
        data,
        stato: r.stato,
        // La nota dell'appello sopravvive a un gesto che non la nomina. Correggere
        // un orario la cancellava; «Tutti presenti» le cancellava tutte insieme.
        note_appello: nominato(grezzo, 'noteAppello') ? (r.noteAppello ?? null) : (prec.note_appello ?? null),
        // L'orario NON È PIÙ LEGATO ALLO STATO. Prima: entrata solo per `ritardo`,
        // uscita solo per `uscita_anticipata`, `null` in ogni altro caso — quindi un
        // `presente` non poteva avere un'ora d'ingresso, e chi usciva prima PERDEVA
        // quella d'entrata. Ma chi esce prima era comunque entrato, e l'ora d'ingresso
        // di un presente è un fatto che la scuola registra.
        orario_entrata: orarioEntrata,
        orario_uscita: orarioUscita,
        // Provenienza operativa: chi ha registrato (può essere la segreteria). NON è una firma.
        registrato_da: userId,
      }
    })

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
