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
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { annullaAppelloAlunno } from '@/lib/presenze/annulla-appello'
import { puoAnnullarePresaVisione } from '@/lib/presenze/presa-visione'
import {
  rispostaAnnullaAppello,
  rispostaAnnullaSoloOggi,
  rispostaAppelloNonAnnullato,
} from '@/lib/presenze/annulla-appello-risposta'

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
  'id, alunno_id, section_id, scuola_id, data, stato, orario_entrata, orario_uscita, note_appello, assenza_oraria_giustificata, registrato_da, giustificata, giust_vista_il'

/**
 * Gli stati su cui «ore giustificate» ha senso (migrazione 20260926100000): l'alunno
 * c'è stato, ma solo per una parte della giornata. Su `presente` non c'è nulla da
 * giustificare, e un `assente` ha già la sua giustifica firmata dal genitore.
 */
const STATI_GIUSTIFICABILI: ReadonlySet<string> = new Set(['ritardo', 'uscita_anticipata'])

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
  // Ritardo / uscita anticipata GIUSTIFICATI (es. terapia): le ore non contano nelle
  // ore di assenza, ma lo stato resta quello vero. Opzionale, e ASSENTE vale `false`:
  // la colonna si riscrive a ogni salvataggio (vedi la costruzione della riga).
  assenzaOrariaGiustificata: z.boolean().optional(),
})
const recordsSchema = z.array(recordSchema)

/**
 * La regola del flag, controllata DOPO la forma (che resta un 400 di `parseData`).
 *
 * È un 422 e non un 400 perché il corpo è ben formato: è la COMBINAZIONE a non avere
 * senso. Due casi, ciascuno col suo codice perché la finestra (A4) possa dire all'utente
 * che cosa correggere:
 *  · flag su uno stato che non è ritardo/uscita anticipata;
 *  · flag senza nota — il CHECK `presenze_giustificata_con_nota` lo rifiuterebbe comunque,
 *    ma come 500 dell'upsert e dopo aver letto e preparato tutto. Una giustificazione
 *    senza motivo è indistinguibile da un clic sbagliato.
 *
 * Nel blocco basta UN record sbagliato: non si scrive nessuno (l'upsert è unico).
 */
function erroreGiustificazione(records: z.output<typeof recordsSchema>): NextResponse | null {
  for (const r of records) {
    if (r.assenzaOrariaGiustificata !== true) continue
    if (!STATI_GIUSTIFICABILI.has(r.stato)) {
      return NextResponse.json(
        {
          error: 'Si possono giustificare solo un ritardo o un’uscita anticipata.',
          codice: 'GIUSTIFICAZIONE_STATO_NON_AMMESSO',
        },
        { status: 422 },
      )
    }
    if ((r.noteAppello ?? '').trim() === '') {
      return NextResponse.json(
        {
          error: 'Per giustificare il ritardo o l’uscita anticipata serve una nota con il motivo.',
          codice: 'GIUSTIFICAZIONE_SENZA_NOTA',
        },
        { status: 422 },
      )
    }
  }
  return null
}

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
  giust_vista_da: string | null
  registrato_da: string | null
  assenza_oraria_giustificata: boolean | null
}

/**
 * Le colonne della riga d'appello. Il motivo esce solo per chi la frase del genitore nomina.
 *
 * `registrato_da` si LEGGE ma non esce: alla schermata basta sapere SE l'appello è stato
 * fatto (`appello_fatto`), cioè se sotto c'è qualcosa che «Annulla» può togliere — lo
 * stesso criterio di `@/lib/presenze/annulla-appello`, dove `registrato_da` NULL vuol
 * dire «c'è solo la comunicazione del genitore» (`NIENTE_DA_ANNULLARE`). Lo uuid di chi
 * ha scritto la riga resta sul server.
 *
 * `giust_vista_da` vale allo stesso modo: si LEGGE per decidere
 * `presa_visione_annullabile` (chi può togliere la presa visione, regola unica in
 * `puoAnnullarePresaVisione`), e lo uuid del docente che ha letto non esce.
 */
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
  'giust_vista_da',
  'registrato_da',
  // Il flag «ore giustificate» (A3): la finestra ritardo/uscita (A4) lo riapre
  // com'era, insieme a `note_appello` che ne porta il motivo.
  'assenza_oraria_giustificata',
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

    const [{ data: alunni, error: alunniErr }, { data: presenze, error: presenzeErr }] = await Promise.all([
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

    // PostgREST non lancia (AGENTS.md, regola 7). E qui una lettura fallita non è
    // innocua: da questa stessa lettura dipende `appello_fatto`. Con `presenze` a
    // `null` ogni alunno uscirebbe «da registrare» e senza «Annulla», con un 200 —
    // e il docente rifarebbe un appello che sul server c'è già. Meglio un 500
    // col codice: la pagina tiene quello che aveva e non mostra il falso.
    if (alunniErr || presenzeErr) {
      logEvento('db', 'error', {
        operazione: 'primaria/appello:GET',
        esito: alunniErr ? 'alunni-non-letti' : 'presenze-non-lette',
        sezione: sectionId,
      }, alunniErr ?? presenzeErr)
      return NextResponse.json(
        { error: 'Appello non leggibile', codice: 'PRESENZE_NON_LETTE' },
        { status: 500 },
      )
    }

    const righe = (presenze ?? []) as unknown as RigaAppello[]
    const statoByAlunno = new Map(righe.map((p) => [p.alunno_id, p]))
    const data_ = (alunni ?? []).map((a) => {
      const p = statoByAlunno.get(a.id)
      return {
        ...a,
        presenza_id: p?.id ?? null,
        stato: p?.stato ?? null,
        note_appello: p?.note_appello ?? null,
        // Senza riga: `false`, mai `undefined` — la finestra parte da una spunta spenta.
        assenza_oraria_giustificata: p?.assenza_oraria_giustificata === true,
        orario_entrata: p?.orario_entrata ?? null,
        orario_uscita: p?.orario_uscita ?? null,
        giustificata: p?.giustificata ?? false,
        giustificazione_testo: p?.giustificazione_testo ?? null,
        giust_vista_il: p?.giust_vista_il ?? null,
        // Solo il booleano, mai lo uuid: vedi `COLONNE_RIGA_APPELLO`.
        appello_fatto: p?.registrato_da != null,
        // «Annulla presa visione» si offre solo a chi il server lo lascerebbe fare:
        // in primaria una classe ha più docenti, e agli altri il gesto finirebbe
        // sempre in 403 `PRESA_VISIONE_NON_TUA`. Solo il booleano, mai lo uuid.
        presa_visione_annullabile: puoAnnullarePresaVisione(auth.user, p),
      }
    })

    return NextResponse.json({ success: true, data: data_ })
  } catch (err) {
    logErrore({ operazione: 'primaria/appello:GET', stato: 500 }, err)
    // Mai `err.message` al client: il motivo tecnico resta nel log.
    return NextResponse.json(
      { error: 'Appello non leggibile', codice: 'PRESENZE_NON_LETTE' },
      { status: 500 },
    )
  }
})

// POST /api/primaria/appello?userId=
//   singolo: { sectionId, alunnoId, data, stato, noteAppello?, assenzaOrariaGiustificata? }
//   bulk:    { sectionId, data, records: [{ alunnoId, stato, noteAppello?, assenzaOrariaGiustificata? }] }
//   Contratto completo: docs/superpowers/specs/2026-09-26-orario-appello-contabilita-cf/contratti/A3.md
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
    for (const campo of ['alunnoId', 'stato', 'noteAppello', 'orarioEntrata', 'orarioUscita', 'assenzaOrariaGiustificata'] as const) {
      if (campo in (b.data as Record<string, unknown>)) singolo[campo] = (b.data as Record<string, unknown>)[campo]
    }
    const rawRecords = Array.isArray(b.data.records) ? b.data.records : [singolo]
    const rec = parseData(recordsSchema, rawRecords)
    if ('response' in rec) return rec.response
    const records = rec.data
    const giustErr = erroreGiustificazione(records)
    if (giustErr) return giustErr

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
        // «Ore giustificate»: si scrive SEMPRE, `true` o `false`. Non segue la regola
        // «ciò che il corpo non nomina sopravvive» delle note, e di proposito: un flag
        // che sopravvive a una correzione toglierebbe ore di assenza a un ritardo che
        // il docente ha appena ri-registrato senza giustificarlo. Chi vuole tenerlo lo
        // RIMANDA (la finestra A4 lo fa sempre). Fuori da ritardo/uscita è `false` anche
        // se il corpo dicesse altro — ma quel caso è già un 422 più sopra; il trigger
        // del DB lo spegnerebbe comunque.
        assenza_oraria_giustificata: STATI_GIUSTIFICABILI.has(r.stato) && r.assenzaOrariaGiustificata === true,
        // Provenienza operativa: chi ha registrato (può essere la segreteria). NON è una firma.
        registrato_da: userId,
      }
    })

    const { data: saved, error } = await supabase
      .from('presenze')
      .upsert(rows, { onConflict: 'alunno_id,data' })
      .select(COLONNE_APPELLO)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Giustificazioni salvate o tolte: evento di dominio, con il SUCCESSO (AGENTS.md,
    // regola 5). Solo uuid e stato: la nota è il motivo — spesso sanitario — di un
    // minore, e nei log non entra (regola 8).
    for (const riga of rows) {
      const prec = esistente.get(riga.alunno_id)
      const primaGiustificata = prec?.assenza_oraria_giustificata === true
      if (riga.assenza_oraria_giustificata) {
        logEvento('registro', 'info', {
          operazione: 'primaria/appello:POST',
          esito: 'assenza-oraria-giustificata-salvata',
          alunno: riga.alunno_id,
          sezione: sectionId,
          stato: riga.stato,
        })
      } else if (primaGiustificata) {
        logEvento('registro', 'info', {
          operazione: 'primaria/appello:POST',
          esito: 'assenza-oraria-giustificata-rimossa',
          alunno: riga.alunno_id,
          sezione: sectionId,
          stato: riga.stato,
        })
      }
    }

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

/**
 * ─── DELETE /api/primaria/appello?sectionId=&alunnoId=&data= — ANNULLA L'APPELLO ─
 *
 * La gemella di `DELETE /api/attendance/daily` per la primaria (spec 2026-09-24,
 * punto 6): il bambino torna a «da registrare». Se la riga portava una
 * comunicazione del genitore si torna a quella, altrimenti la riga si cancella;
 * l'avviso «assenza» ancora in coda si ritira. Tutto questo sta in
 * `@/lib/presenze/annulla-appello`, UNA volta sola per tutti i gradi.
 *
 * Qui restano le cose che sono della ROTTA, identiche alla POST di questo file:
 *  · gate `requireDocente` + `assertSezioneInScope` (docente della classe, o
 *    segreteria/direzione del plesso che lavora per conto del titolare) e
 *    `assertAlunniInSezione` (l'alunno è di QUESTA classe);
 *  · la riga si cerca anche per `section_id`: lo scope verificato è la classe;
 *  · il «solo il giorno stesso» in data di ROMA (`oggiFiscaleISO`);
 *  · la traccia di controllo: l'audit `logScrittura` lo scrive la libreria
 *    (con la sezione e la sede della riga), l'avviso al titolare quando a
 *    scrivere non è lui lo manda `notificaTitolariScrittura`, come per la POST;
 *  · la risposta NON si scrive qui: stati, codici e le sei colonne vengono da
 *    `@/lib/presenze/annulla-appello-risposta`, lo stesso contratto di
 *    `attendance/daily:DELETE` (500 compreso: `APPELLO_NON_ANNULLATO`).
 *
 * Nessuna coda offline: l'annullamento chiede la connessione.
 */
const deleteQuerySchema = z.object({
  sectionId: zUuid,
  alunnoId: zUuid,
  data: zDataYMD,
})

export const DELETE = withRoute('primaria/appello:DELETE', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { sectionId, alunnoId, data } = q.data

    const supabase = await createAdminClient()

    // LO SCOPE PRIMA DI TUTTO, come nella POST: dopo un diniego `presenze` non si
    // legge nemmeno.
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    const alunnoErr = await assertAlunniInSezione(supabase, [alunnoId], sectionId)
    if (alunnoErr) return alunnoErr

    // «Oggi» è quello di Roma: il runtime gira in UTC e fra mezzanotte e le due
    // `toISOString()` direbbe ancora ieri.
    if (data !== oggiFiscaleISO()) return rispostaAnnullaSoloOggi()

    const r = await annullaAppelloAlunno(supabase, {
      alunnoId,
      data,
      sectionId,
      attore: auth.user,
      operazione: 'primaria/appello:DELETE',
    })

    if (r.esito === 'cancellata' || r.esito === 'ripristinata-comunicazione') {
      // Stessa traccia della POST: se a annullare è la segreteria o la
      // direzione, il docente titolare lo viene a sapere. La sede è quella della
      // RIGA annullata, non quella dell'utente. Best-effort: la funzione logga da
      // sé i propri guasti e non lancia.
      await notificaTitolariScrittura(supabase, {
        attore: auth.user,
        sectionId,
        scuolaId: r.scuolaId,
        area: 'appello',
        link: `/teacher/primaria/${sectionId}/appello`,
      })
    }
    // Stati, codici e le sei colonne: un contratto solo, condiviso con
    // `attendance/daily:DELETE`.
    return rispostaAnnullaAppello(r)
  } catch (err) {
    logErrore({ operazione: 'primaria/appello:DELETE', stato: 500 }, err)
    return rispostaAppelloNonAnnullato()
  }
})
