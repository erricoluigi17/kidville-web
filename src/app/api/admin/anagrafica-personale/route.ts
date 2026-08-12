import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, assertUtenteInScope } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { verificaCoerenza } from '@/lib/fiscale/coerenza'
import { RUOLI_VALIDI } from '@/lib/auth/ruoli'
import { TIPI_DOCUMENTO } from '@/lib/forms/personale-template'
import {
  COLONNE_DOCUMENTO,
  DOC_MAX_LUNGHEZZA,
  percorsoDocumentoAmmesso,
} from '@/lib/personale/percorso-documento'
import { SOGLIA_MAX, giorniResidui } from '@/lib/anagrafica/scadenze'
import { dataCivile } from '@/i18n/config'

// =============================================================================
// IL CRUSCOTTO DELLE SCADENZE DEI DOCUMENTI — lato Segreteria.
//
// `GET`   cruscotto (`?scadenza=`) · dettaglio (`?utenteId=`) · documento (`?doc=`)
// `PATCH` correzione allo sportello («la maestra ha portato la carta d'identità nuova»)
//
// LA SEGRETERIA È INCLUSA, e non è una concessione: è chi sta al banco quando la
// persona arriva con il documento in mano. Un cruscotto che la esclude costringe
// a scrivere il dato su un foglio e a farlo inserire da qualcun altro il giorno
// dopo — cioè produce esattamente il ritardo che questo modulo esiste per togliere.
//
// ─── LA SEDE NON STA SU `anagrafica_personale`, E CAMBIA LA FORMA DELLA QUERY ─
//
// Quella tabella è 1:1 con `utenti` e NON ha `scuola_id`: la sede della persona
// vive in `utenti.scuola_id`, ed è `admin/staff:PATCH` a spostarla. Quindi il
// filtro di sede non si può mettere sull'anagrafica, e l'elenco si costruisce in
// DUE tempi:
//
//   1. `select id … from utenti where scuola_id in (<sedi attive>) and ruolo in (<personale>)`
//   2. `select … from anagrafica_personale where utente_id in (<quegli id>)`
//
// È la forma «elenco agganciato a id ricavati da una query precedente» che il
// lock `isolamento-sede-coverage` ammette esplicitamente, e l'unica onesta qui:
// il perimetro lo decide il passo 1, che il filtro di sede ce l'ha dentro.
//
// ⚠️ IL RUOLO SI FILTRA IN POSITIVO (`in`), NON IN NEGATIVO (`neq 'genitore'`).
// È la lezione già scritta per esteso in `staff-identity.ts` e misurata sulla
// stessa colonna: `utenti.ruolo` è un `character varying` senza CHECK e senza
// enum, quindi accetta qualunque stringa. Un `neq('ruolo','genitore')` CONCEDE a
// tutto ciò che non è quel letterale esatto — `'Genitore'`, `'genitore '`, un
// ruolo che nascesse domani — e qui concedere significa mettere il nome di un
// genitore dentro il cruscotto del personale. `RUOLI_VALIDI` è l'elenco degli
// ammessi, e viene dall'unico posto che li dichiara (`@/lib/auth/ruoli`).
//
// ─── L'ELENCO È POVERO, E QUESTA VOLTA È PIÙ DI UNA BUONA ABITUDINE ──────────
//
// In lista escono `utente_id`, nome, cognome, ruolo, sede, tipo e SCADENZA del
// documento: quanto basta a sapere chi va richiamato. Codice fiscale, numero del
// documento, residenza, data e luogo di nascita NON escono mai da qui — arrivano
// con `?utenteId=`, cioè aprendo UNA persona alla volta. È la stessa lezione di
// «Moduli ricevuti» (493 kB di codici fiscali di minori verso il browser a ogni
// apertura di pagina), e qui il dato è il numero di un documento d'identità: la
// chiave con cui si impersona qualcuno allo sportello di un ufficio.
// =============================================================================

/** Le due tabelle, in un posto solo: i nomi compaiono in sette query. */
const TABELLA = 'anagrafica_personale'
const TABELLA_UTENTI = 'utenti'

/** Il bucket privato in cui vive la scansione del documento (mai pubblico). */
const BUCKET_DOCUMENTI = 'documenti_personale'

/**
 * Quanto vive la URL firmata del documento: 300 secondi.
 *
 * Cinque minuti e non dieci come per il curriculum di una candidatura, ed è una
 * differenza di sostanza: quello è un curriculum, questo è la scansione di una
 * carta d'identità. Una URL firmata è scaricabile SENZA sessione da chiunque
 * l'abbia in mano — finisce nella cronologia del browser, nei log del proxy
 * aziendale, in una chat se qualcuno la incolla. Il tempo di aprirla basta.
 */
const DURATA_FIRMA_SECONDI = 300

/* ── I codici d'errore, letterali e in cima ───────────────────────────────────
 * Ogni risposta d'errore ne porta uno: il client traduce il codice, e chi lavora
 * con l'interfaccia in inglese non si ritrova la prosa italiana del server.
 * Sono dichiarati in `src/lib/ui/esito-fetch.ts` (lock `errori-con-codice`). */
const CODICE_NON_DISPONIBILE = 'ANAGRAFICA_PERSONALE_NON_DISPONIBILE'
const CODICE_NON_TROVATA = 'ANAGRAFICA_PERSONALE_NON_TROVATA'
const CODICE_NON_AGGIORNATA = 'ANAGRAFICA_PERSONALE_NON_AGGIORNATA'

/**
 * UN SOLO messaggio per «non esiste» e per «è di un'altra sede».
 *
 * Distinguerli direbbe a chi non ha titolo di vederla che quella persona lavora
 * qui — e su un documento d'identità la differenza fra le due frasi è, da sola,
 * un'informazione su una persona vera. La distinzione resta nel log, dove la
 * legge solo chi ha accesso ai log.
 */
const NON_TROVATA =
  'Anagrafica non accessibile: non esiste, oppure appartiene a un\'altra sede.'
const nonTrovata = (stato: 403 | 404) =>
  NextResponse.json({ error: NON_TROVATA, codice: CODICE_NON_TROVATA }, { status: stato })

/**
 * «Adesso non si può»: schema non migrato (è lo stato del database della CI),
 * lettura fallita, storage muto.
 *
 * **503 e non 200 con un elenco vuoto.** Un cruscotto vuoto è una risposta, e
 * sarebbe la risposta più pericolosa che questa pagina possa dare: «nessun
 * documento in scadenza» si legge come «va tutto bene», ed è indistinguibile da
 * «non abbiamo guardato».
 */
const nonDisponibile = (messaggio: string) =>
  NextResponse.json({ error: messaggio, codice: CODICE_NON_DISPONIBILE }, { status: 503 })

/** Codici con cui PostgREST/Postgres dicono «questa TABELLA qui non c'è». */
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])
/** …e «questa COLONNA qui non c'è» (database della CI non migrato). */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

const codiceDi = (err: unknown): string | null => (err as { code?: string } | null)?.code ?? null

/**
 * Il tetto dell'elenco del personale.
 *
 * In produzione gli account non-genitore sono 20 su 58 (misura del 2026-08-06,
 * tre sedi), quindi il troncamento è LATENTE e non attivo. Resta perché un
 * elenco troncato non produce nessun errore: produce un cruscotto con dentro
 * meno persone, un conteggio più basso e nessuno che se ne accorge — che è
 * esattamente il difetto per cui `LIMITE_ELENCO_ALUNNI` esiste. Quando morde, si
 * vede: la riga `warn` qui sotto lo dichiara.
 */
const LIMITE_PERSONALE = 500

/**
 * Clamp di un intero da query string, senza 400 e senza sorprese agli estremi.
 *
 * CLAMPA e non rifiuta, al contrario di `zLimite`, ed è una differenza di
 * conseguenze: questo parametro arriva anche da un collegamento di notifica, e
 * un 400 su un cruscotto aperto da una notifica è una schermata rotta al posto
 * di un elenco. Un orizzonte fuori scala, invece, non nasconde righe: le sposta
 * fra «elenco» e «conteggio».
 */
const interoClampato = (def: number, min: number, max: number) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return def
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    return Math.min(Math.max(Math.trunc(n), min), max)
  }, z.number())

const getQuerySchema = z.object({
  // Un percorso di storage non è lungo: una stringa senza tetto è solo superficie
  // d'attacco in più. Il tetto è quello che le COLONNE dichiarano
  // (`check (… length(…) <= 200)`), importato invece che ribattuto: qui c'era 500,
  // cioè un valore che il database non potrebbe nemmeno aver scritto.
  doc: z.string().max(DOC_MAX_LUNGHEZZA).optional(),
  utenteId: zUuid.optional(),
  scadenza: interoClampato(SOGLIA_MAX, 0, 365),
})

/** I tipi di documento ammessi: dall'unico posto che li dichiara. */
const TIPI_AMMESSI = TIPI_DOCUMENTO.map((o) => String(o.value))

/**
 * LA WHITELIST DELLA CORREZIONE ALLO SPORTELLO — quattro campi, e nient'altro.
 *
 * ⚠️ `utente_id` NON è modificabile, e non perché «è la chiave primaria»: perché
 * spostarlo significherebbe attaccare l'anagrafica — documento compreso — a
 * un'ALTRA persona, con un `PATCH` che risponde 200. Non c'è nessun percorso di
 * lavoro che lo richieda: si corregge il documento di una persona, non la
 * persona di un documento.
 *
 * ⚠️ `documento_fronte_path` e `documento_retro_path` NON sono modificabili per la
 * ragione gemella. Il percorso è la
 * chiave con cui `?doc=` firma un oggetto del bucket: chi potesse scriverlo a
 * mano potrebbe puntare l'anagrafica di una collega a un file qualunque e poi
 * chiederne la firma passando dal gate — che verificherebbe la SEDE, e la
 * troverebbe giusta. La scansione si sostituisce caricandone una nuova, che è
 * un'altra porta e ha il suo gate.
 *
 * `cessato_il` c'è, ed è l'unico campo che non parla del documento. Sta qui
 * perché è la sola via ONESTA per spegnere un allarme legittimo: senza, la
 * segreteria che ha in elenco una persona che non lavora più qui dovrebbe
 * inventarle una scadenza futura — cioè scrivere un dato falso nel fascicolo di
 * una persona vera pur di far tacere un riquadro rosso.
 */
const patchBodySchema = z
  .object({
    utenteId: zUuid,
    document_type: z
      .string()
      .trim()
      .refine((v) => TIPI_AMMESSI.includes(v), 'Tipo di documento non ammesso')
      .nullable()
      .optional(),
    document_number: z.string().trim().max(50).nullable().optional(),
    document_expiry: zDataYMD.nullable().optional(),
    cessato_il: zDataYMD.nullable().optional(),
  })
  .refine(
    (b) =>
      b.document_type !== undefined ||
      b.document_number !== undefined ||
      b.document_expiry !== undefined ||
      b.cessato_il !== undefined,
    // Una PATCH senza nessun campo non è «una modifica vuota»: è una richiesta
    // che il chiamante crede riuscita. Meglio un 400 che dice cosa manca.
    { error: 'Indicare almeno un campo da correggere' },
  )

/** I campi della whitelist, in un posto solo: li leggono lo schema, la scrittura e l'audit. */
const CAMPI_CORREGGIBILI = ['document_type', 'document_number', 'document_expiry', 'cessato_il'] as const
type CampoCorreggibile = (typeof CAMPI_CORREGGIBILI)[number]

/** L'ELENCO: la proiezione POVERA. Mai codice fiscale, mai numero di documento. */
const COLONNE_ELENCO = 'utente_id, document_type, document_expiry, cessato_il'

/**
 * IL DETTAGLIO: proiezione ESPLICITA (mai `select('*')`), una persona alla volta.
 *
 * I due percorsi ci sono perché sono ciò che il pulsante «Apri documento» rimanda
 * al server per farsi firmare l'oggetto; non sono dati da mostrare, ed è il motivo
 * per cui il cruscotto non li riceve in elenco.
 *
 * ⚠️ QUI C'ERA `documento_path`, E QUELLA COLONNA NON ESISTE PIÙ. La migrazione
 * `20260812194501` l'ha rinominata in `documento_fronte_path` aggiungendo
 * `documento_retro_path`, ed è stata applicata in PRODUZIONE. Una proiezione
 * esplicita che nomina una colonna assente non degrada e non torna vuota: risponde
 * `42703`, che qui sotto finisce in `COLONNA_ASSENTE` e diventa un **503 su OGNI
 * apertura del fascicolo di una persona**, in tutte e tre le sedi, con il messaggio
 * «lo schema non è ancora stato creato». Misurato sul database vero:
 *
 *     select documento_path from public.anagrafica_personale limit 1
 *     → ERROR 42703: column "documento_path" does not exist
 *
 * Nessun test era rosso: le prove di questa rotta seminano le righe che leggono.
 */
const COLONNE_DETTAGLIO = [
  'utente_id', 'gender', 'birth_date', 'birth_place', 'birth_province', 'birth_nation',
  'codice_belfiore_nascita', 'fiscal_code', 'citizenship',
  'address', 'residence_street_number', 'residence_city', 'residence_province', 'zip_code',
  'domicilio_address', 'domicilio_street_number', 'domicilio_city', 'domicilio_province',
  'domicilio_zip_code',
  'document_type', 'document_number', 'document_expiry',
  'documento_fronte_path', 'documento_retro_path',
  'titolo_studio', 'titolo_dettaglio',
  'emergenza_nome', 'emergenza_telefono', 'emergenza_relazione',
  'scadenza_soglia_avvisata', 'scadenza_avvisata_il', 'cessato_il',
  'origine_pratica_id', 'creata_il', 'aggiornata_il', 'aggiornata_da',
].join(', ')

interface RigaUtente {
  id: string
  nome: string | null
  cognome: string | null
  ruolo: string | null
  scuola_id: string | null
}

interface RigaAnagrafica {
  utente_id: string
  document_type?: string | null
  document_expiry?: string | null
  cessato_il?: string | null
}

// ─── GET ─────────────────────────────────────────────────────────────────────
export const GET = withRoute('admin/anagrafica-personale:GET', async (request: NextRequest) => {
  // Segreteria compresa: è chi sta al banco. Vedi la testata.
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const supabase = await createAdminClient()
    // Scope vuoto ⇒ elenco vuoto: `.in()` incondizionato, mai `if (scuole.length)`.
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)

    // ─── IL DOCUMENTO: `?doc=<percorso>` ──────────────────────────────────────
    if (q.data.doc) {
      const docPath = q.data.doc
      // PRIMA il gate sull'OGGETTO, POI la firma. Una URL firmata è scaricabile
      // SENZA sessione: produrla e poi rispondere 403 sarebbe una fuga con un
      // altro nome — è il difetto misurato in produzione il 2026-07-31 sui
      // documenti d'identità dei bambini, e qui l'oggetto è della stessa specie.
      const negato = await assertDocumentoInScope(supabase, auth.user, scuole, docPath)
      if (negato) return negato

      const { data, error } = await supabase.storage
        .from(BUCKET_DOCUMENTI)
        .createSignedUrl(docPath, DURATA_FIRMA_SECONDI)
      if (error || !data?.signedUrl) {
        // UN GUASTO NON SI VESTE DA DINIEGO: qui il gate di sede è GIÀ passato,
        // quel documento è della sede giusta e chi guarda ne ha titolo. Se lo
        // storage non risponde la risposta vera è «adesso non si può» (503), non
        // «non esiste, oppure è di un'altra sede» — che manderebbe la segreteria
        // a cercare un problema di permessi che non c'è.
        //
        // Il messaggio grezzo NON torna al client: contiene il percorso, cioè la
        // chiave che apre la scansione di un documento d'identità.
        logErrore({ operazione: 'admin/anagrafica-personale:GET', stato: 503, evento: 'storage' }, error)
        return nonDisponibile('Il documento non è scaricabile in questo momento: riprovare fra poco.')
      }
      return NextResponse.json({ url: data.signedUrl })
    }

    // ─── IL DETTAGLIO: `?utenteId=<uuid>` ─────────────────────────────────────
    if (q.data.utenteId) return await dettaglio(supabase, auth.user, q.data.utenteId)

    // ─── IL CRUSCOTTO ─────────────────────────────────────────────────────────
    return await cruscotto(supabase, auth.user, scuole, q.data.scadenza)
  } catch (err) {
    logErrore({ operazione: 'admin/anagrafica-personale:GET', stato: 503 }, err)
    return nonDisponibile('Le scadenze dei documenti non sono consultabili in questo momento: riprovare fra poco.')
  }
})

// ─── PATCH ───────────────────────────────────────────────────────────────────
export const PATCH = withRoute('admin/anagrafica-personale:PATCH', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { utenteId } = b.data

    const supabase = await createAdminClient()
    // Il gate sull'IDENTITÀ del bersaglio, prima di qualunque scrittura: senza,
    // il solo `requireStaff` lascerebbe correggere il documento del personale di
    // un'altra sede.
    const fuoriScope = await assertUtenteInScope(supabase, auth.user, utenteId)
    if (fuoriScope) return fuoriScope

    // LA SEDE DELLA PERSONA CORRETTA, non quella di chi corregge.
    //
    // È una query in più su un gesto che si fa una volta ogni tanto, e paga il
    // suo prezzo: l'unico admin reale ha Giugliano come sede primaria e gestisce
    // tutti e tre i plessi, quindi scrivere `auth.user.scuola_id` nell'audit
    // significherebbe archiviare a Giugliano ogni correzione fatta ad Aversa e a
    // Cesa — in un registro IMMUTABILE, dove `scuola_id` è il modo in cui si
    // filtra per plesso. Un errore che non si può correggere dopo.
    //
    // Best-effort: se la lettura non riesce si scrive `null`, e `logScrittura`
    // ripiega sulla sede dell'attore. Meglio un ripiego dichiarato qui che una
    // correzione bloccata per un uuid non letto.
    const { data: bersaglio, error: erroreBersaglio } = await supabase
      .from(TABELLA_UTENTI)
      .select('id, scuola_id')
      .eq('id', utenteId)
      .maybeSingle()
    if (erroreBersaglio) {
      logEvento('personale', 'warn', {
        operazione: 'admin/anagrafica-personale:PATCH',
        esito: 'sede-bersaglio-non-letta',
        entita_tipo: TABELLA_UTENTI,
        entita_id: utenteId,
        error_code: codiceDi(erroreBersaglio),
      }, erroreBersaglio)
    }
    const sedeBersaglio = (bersaglio as { scuola_id?: string | null } | null)?.scuola_id ?? null

    const patch: Record<string, unknown> = { aggiornata_da: auth.user.id }
    const toccati: CampoCorreggibile[] = []
    for (const campo of CAMPI_CORREGGIBILI) {
      const valore = b.data[campo]
      if (valore === undefined) continue
      // Stringa vuota ⇒ `null`: «ho cancellato il campo» e «non l'ho toccato»
      // sono due gesti diversi, e in tabella il primo è un NULL, non un `''`
      // (che passerebbe i CHECK di forma e resterebbe lì come dato falso).
      patch[campo] = typeof valore === 'string' && valore.trim() === '' ? null : valore
      toccati.push(campo)
    }

    // UPSERT e non UPDATE, ed è la differenza fra un cruscotto che si può usare e
    // uno che si può solo guardare: il bucket più grande — e il più azionabile —
    // è «documento mancante», cioè le persone che un'anagrafica non ce l'hanno
    // ancora. Un UPDATE su zero righe risponderebbe «fatto» senza scrivere niente
    // proprio nel caso per cui il pannello esiste.
    //
    // ⚠️ Il `PRIMARY KEY` è `utente_id`, quindi il conflitto è su quella colonna e
    // la 1:1 resta vera per costruzione: non esiste lo stato «due anagrafiche per
    // la stessa persona». Il trigger `anagrafica_personale_tocca` azzera da sé lo
    // stato del promemoria quando `document_expiry` cambia — quella regola vive in
    // un posto solo e non si replica qui.
    const { data, error } = await supabase
      .from(TABELLA)
      .upsert({ utente_id: utenteId, ...patch }, { onConflict: 'utente_id' })
      .select('utente_id, document_type, document_expiry, cessato_il')
      .maybeSingle()

    if (error) {
      const codice = codiceDi(error)
      const schemaAssente = TABELLA_ASSENTE.has(codice ?? '') || COLONNA_ASSENTE.has(codice ?? '')
      logEvento('personale', schemaAssente ? 'warn' : 'error', {
        operazione: 'admin/anagrafica-personale:PATCH',
        esito: schemaAssente ? 'schema-assente' : 'correzione-non-scritta',
        entita_tipo: TABELLA,
        entita_id: utenteId,
        error_code: codice,
      }, error)
      // Due risposte, non un ternario dentro `codice`: il lock
      // `errori-con-codice` legge il codice come LETTERALE o come costante del
      // file, e un'espressione condizionale gli è illeggibile — cioè nessuno
      // verificherebbe più che quei due codici siano dichiarati e tradotti.
      if (schemaAssente) {
        return nonDisponibile(
          'L\'anagrafica del personale non è disponibile su questo ambiente: lo schema non è ancora stato creato.',
        )
      }
      return NextResponse.json(
        { error: 'La correzione non è stata registrata: riprovare fra poco.', codice: CODICE_NON_AGGIORNATA },
        { status: 503 },
      )
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'anagrafica_personale',
      entitaId: utenteId,
      azione: 'update',
      scuolaId: sedeBersaglio,
      // L'audit dice CHE COSA è stato fatto, non è una copia dell'anagrafica.
      //
      // ⚠️ IL NUMERO DEL DOCUMENTO NON ENTRA QUI, e non è una dimenticanza: è la
      // chiave con cui si impersona qualcuno a uno sportello, e questo è il
      // registro IMMUTABILE — ciò che ci finisce non si toglie più. Che sia stato
      // cambiato si legge da `campi`; qual era, si legge nel fascicolo, che ha un
      // gate suo.
      //
      // La scadenza invece c'è, ed è deliberato: è l'unico dato che permette, fra
      // un anno, di ricostruire CHI ha spostato in avanti un allarme e di quanto.
      // Un audit che non lo conserva non risponde alla sola domanda per cui lo si
      // andrebbe a leggere.
      valoreDopo: {
        campi: toccati,
        ...(toccati.includes('document_expiry') ? { document_expiry: patch.document_expiry ?? null } : null),
        ...(toccati.includes('cessato_il') ? { cessato_il: patch.cessato_il ?? null } : null),
      },
    })

    // Evento critico → si logga anche il SUCCESSO. Senza, «nessun log» non
    // distinguerebbe «non corregge nessuno» da «la correzione non parte più» — ed
    // è la stessa ambiguità che ha tenuto invisibile per mesi il guasto delle
    // email. Nel log solo i NOMI dei campi toccati: mai i valori.
    logEvento('personale', 'info', {
      operazione: 'admin/anagrafica-personale:PATCH',
      esito: 'anagrafica-corretta',
      entita_tipo: TABELLA,
      entita_id: utenteId,
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: sedeBersaglio,
      campi: toccati.join('+'),
      n: toccati.length,
    })

    return NextResponse.json({ success: true, data: data ?? null })
  } catch (err) {
    logErrore({ operazione: 'admin/anagrafica-personale:PATCH', stato: 503 }, err)
    return NextResponse.json(
      { error: 'La correzione non è stata registrata: riprovare fra poco.', codice: CODICE_NON_AGGIORNATA },
      { status: 503 },
    )
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Gli aiutanti
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IL CRUSCOTTO — l'elenco del personale delle sedi attive, con la scadenza del
 * proprio documento accanto, e il numero di quelli che non hanno niente da dire.
 *
 * ─── PERCHÉ L'ORIZZONTE NON SCENDE SOTTO `SOGLIA_MAX` ───────────────────────
 *
 * `?scadenza=` è clampato fra 0 e 365 (vedi `interoClampato`), ma l'orizzonte che
 * governa la query è `max(richiesto, SOGLIA_MAX)`, e la ragione è che i quattro
 * riquadri del cruscotto sono FISSI — scaduti · 30 giorni · 90 giorni · mancante —
 * e il più largo è 90. Con un orizzonte a 30 il riquadro «Scadono entro 90
 * giorni» direbbe zero mentre in tabella ci sono righe: non un elenco corto, un
 * cruscotto che mente. Verso l'alto invece il parametro fa quello che promette:
 * `?scadenza=180` allarga davvero l'elenco. L'orizzonte EFFETTIVO torna nella
 * risposta (`orizzonteGiorni`), così il client non deve indovinarlo.
 *
 * ─── PERCHÉ «IN REGOLA» È UN NUMERO E NON DELLE RIGHE ───────────────────────
 *
 * Perché un riquadro che nessuno clicca è rumore, e perché ogni riga in più è un
 * nome di persona che attraversa la rete senza che nessuno l'abbia chiesto. Chi è
 * in regola si conta; chi va richiamato si elenca.
 */
async function cruscotto(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  scadenzaRichiesta: number,
): Promise<NextResponse> {
  const operazione = 'admin/anagrafica-personale:GET'
  const oggi = dataCivile()
  const orizzonte = Math.max(scadenzaRichiesta, SOGLIA_MAX)

  // ── 1. Il personale delle sedi attive. Il filtro di sede sta QUI, nella stessa
  //       query, ed è l'unico posto in cui è vero.
  const { data: utenti, error: erroreUtenti } = await supabase
    .from(TABELLA_UTENTI)
    .select('id, nome, cognome, ruolo, scuola_id')
    .in('scuola_id', scuole)
    .in('ruolo', RUOLI_VALIDI)
    .order('cognome', { ascending: true })
    .limit(LIMITE_PERSONALE)
  if (erroreUtenti) {
    logEvento('personale', 'error', {
      operazione,
      esito: 'personale-non-letto',
      entita_tipo: TABELLA_UTENTI,
      error_code: codiceDi(erroreUtenti),
    }, erroreUtenti)
    return nonDisponibile('Le scadenze dei documenti non sono consultabili in questo momento: riprovare fra poco.')
  }

  const righeUtenti = (utenti ?? []) as unknown as RigaUtente[]
  if (righeUtenti.length === LIMITE_PERSONALE) {
    // Un elenco troncato non produce nessun errore: produce un cruscotto con
    // dentro meno persone e nessuno che se ne accorge.
    logEvento('personale', 'warn', {
      operazione,
      esito: 'elenco-personale-troncato',
      n: righeUtenti.length,
      sedi_attive: scuole.length,
    })
  }

  const ids = righeUtenti.map((u) => u.id)
  // Nessun utente in scope ⇒ nessuna anagrafica da chiedere. `.in('utente_id',
  // [])` risponderebbe comunque a vuoto, ma è un viaggio verso il database per
  // sapere una cosa che si sa già.
  const anagrafiche = ids.length > 0 ? await leggiAnagrafiche(supabase, ids) : { righe: [], error: null }
  if (anagrafiche.error) {
    const codice = codiceDi(anagrafiche.error)
    const schemaAssente = TABELLA_ASSENTE.has(codice ?? '') || COLONNA_ASSENTE.has(codice ?? '')
    // ⚠️ QUI NON SI DEGRADA TOGLIENDO LA COLONNA, ed è una scelta contraria a
    // quella di `admin/candidature-insegnanti`. Là una colonna assente toglie un
    // campo dal dettaglio; qui `document_expiry` È il cruscotto: senza, ogni
    // persona risulterebbe «documento mancante» e la segreteria vedrebbe venti
    // righe rosse inventate. Un errore dichiarato è meglio di un allarme falso.
    logEvento('personale', schemaAssente ? 'warn' : 'error', {
      operazione,
      esito: schemaAssente ? 'schema-assente' : 'anagrafiche-non-lette',
      entita_tipo: TABELLA,
      error_code: codice,
    }, anagrafiche.error)
    return nonDisponibile(
      schemaAssente
        ? 'Le scadenze dei documenti non sono disponibili su questo ambiente: lo schema non è ancora stato creato.'
        : 'Le scadenze dei documenti non sono consultabili in questo momento: riprovare fra poco.',
    )
  }

  const perUtente = new Map<string, RigaAnagrafica>()
  for (const r of anagrafiche.righe) perUtente.set(r.utente_id, r)

  const data: Record<string, unknown>[] = []
  let inRegola = 0
  let cessati = 0
  for (const u of righeUtenti) {
    const a = perUtente.get(u.id)
    // Rapporto cessato: fuori dal cruscotto e fuori da ogni conteggio. Il
    // documento scaduto di chi non lavora più qui non è una non conformità: è
    // un fascicolo che aspetta la sua conservazione, e tenerlo in elenco
    // riempirebbe di rosso permanente proprio il riquadro che deve restare
    // azionabile.
    if (a?.cessato_il) { cessati++; continue }
    const scadenza = a?.document_expiry ?? null
    if (scadenza) {
      const giorni = giorniResidui(scadenza, oggi)
      // Fuori orizzonte ⇒ si conta e basta. `NaN` (data illeggibile in colonna)
      // NON è «in regola»: resta in elenco, dove si vede.
      if (Number.isFinite(giorni) && giorni > orizzonte) { inRegola++; continue }
    }
    data.push({
      utente_id: u.id,
      nome: u.nome,
      cognome: u.cognome,
      ruolo: u.ruolo,
      scuola_id: u.scuola_id,
      document_type: a?.document_type ?? null,
      document_expiry: scadenza,
    })
  }

  return NextResponse.json({
    data,
    // Il conteggio di chi non ha niente da dire: una riga sotto i riquadri, non
    // un riquadro suo.
    inRegola,
    cessati,
    orizzonteGiorni: orizzonte,
    // `oggi` viene dal SERVER, in `Europe/Rome`. È l'unica data con cui i giorni
    // residui si possono calcolare due volte (qui e nel browser) e dare lo stesso
    // numero: l'orologio di un portatile può essere avanti di un giorno, e su una
    // soglia «scaduto/non scaduto» un giorno è tutta la differenza.
    oggi,
    // Il totale del personale in scope, cessati compresi: dice quanto è grande la
    // popolazione da cui vengono i numeri. Senza, «3 documenti in regola» non si
    // sa se sia molto o pochissimo.
    totalePersonale: righeUtenti.length,
    limite: LIMITE_PERSONALE,
  })
}

/** Le anagrafiche degli id dati. `error` non si butta: PostgREST non lancia. */
async function leggiAnagrafiche(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  ids: string[],
): Promise<{ righe: RigaAnagrafica[]; error: { code?: string; message: string } | null }> {
  const { data, error } = await supabase
    .from(TABELLA)
    .select(COLONNE_ELENCO)
    .in('utente_id', ids)
  if (error) return { righe: [], error }
  return { righe: (data ?? []) as unknown as RigaAnagrafica[], error: null }
}

/**
 * IL DETTAGLIO di UNA persona — ed è qui, e solo qui, che escono codice fiscale,
 * numero del documento e residenza.
 *
 * La coerenza del codice fiscale si RICALCOLA in lettura, mai da una colonna di
 * cache: una colonna direbbe se il codice era coerente con i dati di ALLORA, e i
 * dati cambiano — cognome da nubile, luogo di nascita corretto a mano. La
 * funzione è pura e costa un microsecondo; una cache costa una verità vecchia.
 */
async function dettaglio(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  utenteId: string,
): Promise<NextResponse> {
  const operazione = 'admin/anagrafica-personale:GET'
  const fuoriScope = await assertUtenteInScope(supabase, user, utenteId)
  if (fuoriScope) return fuoriScope

  // Nome e cognome vivono in `utenti` e restano lì: `anagrafica_personale` non li
  // ha di proposito — due verità sulla stessa persona divergono al primo
  // aggiornamento. Servono qui perché senza di loro la coerenza del codice
  // fiscale non si può nemmeno calcolare.
  //
  // ⚠️ `cellulare` È IN QUESTO ELENCO PERCHÉ SENZA DI LUI LA SCHEDA MENTE.
  // Il campo si chiama `telefono` nel modulo e in `pratiche_personale`, e
  // `cellulare` su `utenti`: due nomi per lo stesso dato lungo il percorso
  // modulo → pratica → account. L'approvazione della pratica SCRIVE quella
  // colonna (`admin/pratiche-personale`, `cellulare: testo(riga.telefono)`),
  // quindi dal primo «Approva» il numero esiste. Finché non era proiettato, la
  // riga «Numero di cellulare» della scheda staff diceva «Non indicato» per
  // chiunque e per sempre — cioè il primo dato che questo modulo produce era
  // anche il primo che la sua scheda dichiarava mancante, e nessun test poteva
  // accorgersene perché `undefined` è indistinguibile da «vuoto».
  // Colonna del baseline (`20260704120000_baseline.sql`), quindi presente anche
  // sul DB E2E non migrato: non introduce un `42703`.
  const { data: utente, error: erroreUtente } = await supabase
    .from(TABELLA_UTENTI)
    .select('id, nome, cognome, ruolo, scuola_id, email, cellulare')
    .eq('id', utenteId)
    .maybeSingle()
  if (erroreUtente) {
    logEvento('personale', 'error', {
      operazione, esito: 'utente-non-letto', entita_tipo: TABELLA_UTENTI,
      entita_id: utenteId, error_code: codiceDi(erroreUtente),
    }, erroreUtente)
    return nonDisponibile('L\'anagrafica non è consultabile in questo momento: riprovare fra poco.')
  }
  if (!utente) return nonTrovata(404)

  const { data: riga, error } = await supabase
    .from(TABELLA)
    .select(COLONNE_DETTAGLIO)
    .eq('utente_id', utenteId)
    .maybeSingle()
  if (error) {
    const codice = codiceDi(error)
    const schemaAssente = TABELLA_ASSENTE.has(codice ?? '') || COLONNA_ASSENTE.has(codice ?? '')
    logEvento('personale', schemaAssente ? 'warn' : 'error', {
      operazione,
      esito: schemaAssente ? 'schema-assente' : 'dettaglio-non-letto',
      entita_tipo: TABELLA,
      entita_id: utenteId,
      error_code: codice,
    }, error)
    return nonDisponibile(
      schemaAssente
        ? 'L\'anagrafica del personale non è disponibile su questo ambiente: lo schema non è ancora stato creato.'
        : 'L\'anagrafica non è consultabile in questo momento: riprovare fra poco.',
    )
  }

  // `riga` è `null` quando la persona esiste ma un'anagrafica non ce l'ha
  // ancora: è il caso NORMALE del primo giorno — «documento mancante» è il
  // secchio più grande — e non è un errore. Il dettaglio esce con
  // `anagrafica: null`, e chi legge sa che non c'è niente invece di ricevere un
  // 404 che direbbe «questa persona non esiste».
  //
  // `documento_fronte_path` e `documento_retro_path` viaggiano dentro `riga` come
  // tutte le altre colonne, e servono a una cosa sola: rimandarli a `?doc=` per
  // farsi firmare l'oggetto — una faccia per volta, perché una faccia per volta si
  // apre. Non sono dati da mostrare, e in elenco non compaiono mai.
  const a = (riga ?? {}) as Record<string, unknown>
  const anagrafica = (riga ?? null) as Record<string, unknown> | null

  const coerenza = verificaCoerenza((a.fiscal_code as string | null) ?? null, {
    nome: (utente as { nome?: string | null }).nome ?? null,
    cognome: (utente as { cognome?: string | null }).cognome ?? null,
    sesso: (a.gender as string | null) ?? null,
    dataNascita: (a.birth_date as string | null) ?? null,
    codiceBelfiore: (a.codice_belfiore_nascita as string | null) ?? null,
  })

  // IL REGISTRO DEGLI ACCESSI RIUSCITI al fascicolo di una persona. `multi_sede`
  // è persistito: la riga resta in `app_log` e sopravvive al deploy. Senza,
  // «nessun log» non distingue «nessuno ha guardato» da «la sorveglianza non è
  // mai partita» — e da qui escono codice fiscale e residenza di una lavoratrice,
  // su cui lei ha diritto di chiedere chi li ha letti.
  logEvento('multi_sede', 'info', {
    operazione,
    esito: 'anagrafica-personale-aperta',
    azione: 'dettaglio',
    utente: user.id,
    ruolo: user.role,
    entita_tipo: TABELLA,
    entita_id: utenteId,
    sede_id: (utente as { scuola_id?: string | null }).scuola_id ?? null,
  })

  return NextResponse.json({
    data: {
      utente: {
        id: utenteId,
        nome: (utente as { nome?: string | null }).nome ?? null,
        cognome: (utente as { cognome?: string | null }).cognome ?? null,
        ruolo: (utente as { ruolo?: string | null }).ruolo ?? null,
        scuola_id: (utente as { scuola_id?: string | null }).scuola_id ?? null,
        email: (utente as { email?: string | null }).email ?? null,
        // Il recapito dell'ACCOUNT, non dell'anagrafica: vedi la proiezione.
        cellulare: (utente as { cellulare?: string | null }).cellulare ?? null,
      },
      anagrafica,
      // La coerenza è un ESITO calcolato adesso, non una colonna: `coerente`,
      // i motivi e i campi che non si sono potuti verificare.
      coerenza,
    },
  })
}

/**
 * GATE SULL'OGGETTO per `?doc=` — il percorso si RISOLVE all'anagrafica che lo
 * contiene, e quell'anagrafica deve essere di una persona delle sedi attive.
 *
 * Tre scelte, tutte deliberate e tutte già pagate altrove in questo repo:
 *  · fail-CLOSED: se una delle due letture fallisce non si firma. Non sapere di
 *    chi è un documento d'identità non può voler dire consegnarlo;
 *  · percorso che non si risolve ⇒ diniego: un file che non appartiene a nessuna
 *    anagrafica non ha una persona da verificare, quindi nessuno può dire che sia
 *    suo (ed è anche il caso del percorso INVENTATO, che è come si prova una fuga);
 *  · un solo messaggio per «di un'altra sede» e «inesistente».
 *
 * ── ⚠️ L'ORDINE: PRIMA LA FORMA, POI LA RISOLUZIONE ────────────────────────
 *
 * `?doc=` è testo di query string, e il suo schema `zod` impone SOLO un tetto di
 * lunghezza: la forma non la vincola nessuno. Quel testo va confrontato con DUE
 * colonne, e con due colonne la scrittura che viene naturale è
 *
 *     .or(`documento_fronte_path.eq.${doc},documento_retro_path.eq.${doc}`)
 *
 * che sarebbe la cosa sbagliata da fare: in quella sintassi la virgola SEPARA le
 * condizioni e le parentesi le RAGGRUPPANO, quindi un valore che ne contenga una
 * non rompe il filtro — lo RISCRIVE, e questo gate direbbe «è della tua sede» di
 * un documento che non lo è. Non è un'iniezione SQL (PostgREST non concatena
 * SQL): è un'iniezione di FILTRO, e qui produce lo stesso danno.
 *
 * Perciò la forma si decide PRIMA che il valore incontri qualunque query. Dopo il
 * gate l'alfabeto ammesso è `documenti/`, esadecimali, trattini, barre, punto e
 * `[A-Za-z0-9]+` di estensione: nessuna virgola, nessuna parentesi, nessun apice.
 *
 * ── …E PERCHÉ, ANCHE DOPO IL GATE, RESTANO DUE `.eq()` E NON UN `.or()` ────
 *
 * Perché le due difese sono indipendenti, e questa è la seconda. `.eq()` non
 * interpola niente — il valore viaggia come parametro e la virgola esce
 * percent-encodata (`new URLSearchParams({a:'x,y'}).toString()` → `a=x%2Cy`,
 * misurato) — quindi regge da solo anche il giorno in cui qualcuno allargasse la
 * forma per far passare un percorso legittimo che oggi non passa. Con un `.or()`
 * la sicurezza di questa riga dipenderebbe da una funzione che sta in un altro
 * file: un allentamento là dentro diventerebbe un buco qui, senza che nessuna
 * riga di questo file cambi. Il costo è una seconda lettura solo quando la prima
 * non trova nulla; il guadagno è che non esiste, in questo repo, un solo posto in
 * cui del testo di provenienza esterna entri in un filtro composto.
 *
 * Il rifiuto per forma è indistinguibile, per chi lo riceve, da «quel percorso
 * non esiste»: stessa risposta, stesso codice, stessa frase. Dire «malformato»
 * confermerebbe a chi prova che le forme rifiutate in un altro modo erano giuste.
 * La differenza sopravvive nel LOG, con un `esito` suo — ed è ciò che permette di
 * distinguere in SQL il collegamento vecchio di chi ha una scheda aperta da ieri
 * da qualcuno che scrive a mano percorsi che il prodotto non produce.
 */
async function assertDocumentoInScope(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  docPath: string,
): Promise<NextResponse | null> {
  const operazione = 'admin/anagrafica-personale:GET'

  // ── IL GATE DI FORMA, prima di qualunque query. Vedi la testata.
  if (!percorsoDocumentoAmmesso(docPath)) {
    // MAI il percorso nel log: non porta il nome del file (la rotta di caricamento
    // lo butta via), ma resta la chiave che apre il documento d'identità di una
    // persona, e `redact()` non lo ha in lista bianca. Si registra CHE un percorso
    // è stato respinto, e da chi; mai che cosa era.
    logEvento('multi_sede', 'warn', {
      operazione,
      esito: 'documento-forma-non-valida',
      azione: 'documento',
      utente: user.id,
      ruolo: user.role,
      sedi_attive: scuole.length,
    })
    return nonTrovata(403)
  }

  // ⚠️ SI CERCA IN OGNI COLONNA DEL DOCUMENTO, E L'ELENCO NON SI SCRIVE QUI.
  //
  // Questa riga interrogava `documento_path` fino al 12/08/2026, e quel giorno la
  // migrazione `20260812194501` ha rinominato la colonna in `documento_fronte_path`
  // aggiungendo `documento_retro_path`. Applicata in produzione, la lettura è diventata
  // un `42703` — e su un gate fail-CLOSED un errore di lettura vale «non firmo». Cioè
  // il fascicolo del personale ha smesso di consegnare qualunque scansione, con la
  // stessa risposta che riceve un tentativo abusivo, e nessun test era rosso.
  // `COLONNE_DOCUMENTO` è l'elenco derivato dal template (`@/lib/personale/percorso-documento`):
  // il retro entra da solo, e un rinomino futuro lo segue senza passare di qui.
  let utenteId: string | null = null
  for (const colonna of COLONNE_DOCUMENTO) {
    const { data, error } = await supabase
      .from(TABELLA)
      .select('utente_id')
      .eq(colonna, docPath)
      .limit(1)
      .maybeSingle()
    if (error) {
      logEvento('multi_sede', 'error', {
        operazione,
        esito: 'documento-non-verificabile',
        entita_tipo: TABELLA,
        error_code: codiceDi(error),
      }, error)
      return nonDisponibile('Verifica del documento non riuscita: riprovare fra poco.')
    }
    const trovato = (data as { utente_id?: string } | null)?.utente_id ?? null
    if (trovato) {
      utenteId = trovato
      break
    }
  }
  if (utenteId) {
    // La sede si legge da `utenti`, che è dove vive: il filtro sta NELLA query,
    // non in un `includes` a valle. Zero righe ⇒ quella persona non è in scope.
    const { data: inScope, error: erroreScope } = await supabase
      .from(TABELLA_UTENTI)
      .select('id, scuola_id')
      .eq('id', utenteId)
      .in('scuola_id', scuole)
      .maybeSingle()
    if (erroreScope) {
      logEvento('multi_sede', 'error', {
        operazione,
        esito: 'documento-sede-non-verificabile',
        entita_tipo: TABELLA_UTENTI,
        error_code: codiceDi(erroreScope),
      }, erroreScope)
      return nonDisponibile('Verifica del documento non riuscita: riprovare fra poco.')
    }
    if (inScope) {
      // Il registro degli accessi riusciti a una scansione di documento
      // d'identità. MAI il percorso: contiene il nome del file, che quasi sempre
      // è il nome di una persona.
      logEvento('multi_sede', 'info', {
        operazione,
        esito: 'documento-personale-firmato',
        azione: 'documento',
        utente: user.id,
        ruolo: user.role,
        sede_id: (inScope as { scuola_id?: string | null }).scuola_id ?? null,
        sedi_attive: scuole.length,
        entita_tipo: TABELLA,
        entita_id: utenteId,
      })
      return null
    }
  }

  // Diniego. Il `tipo` distingue il tentativo cross-sede dal percorso inventato:
  // senza quella distinzione il log di una fuga non si legge — si annega nei 404
  // banali di un link vecchio.
  logEvento('multi_sede', 'warn', {
    operazione,
    esito: utenteId ? 'documento-fuori-sede' : 'documento-non-risolto',
    azione: 'documento',
    utente: user.id,
    ruolo: user.role,
    sedi_attive: scuole.length,
  })
  return nonTrovata(403)
}
