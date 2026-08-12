import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { ensureStaffIdentity, type Grado } from '@/lib/auth/staff-identity'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { nomeSede, sediReali } from '@/lib/scuole/reali'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { GRADI_OPTIONS } from '@/lib/forms/insegnanti-template'
import { PERSONALE_FIELDS } from '@/lib/forms/personale-template'
import {
  BUCKET_DOCUMENTI_PERSONALE,
  collegaCaricamenti,
  facceChieste,
} from '@/lib/personale/caricamenti'
import {
  COLONNE_DOCUMENTO,
  DOC_MAX_LUNGHEZZA,
  percorsoDocumentoAmmesso,
} from '@/lib/personale/percorso-documento'
import { LIMITE_ISCRIZIONI_DEFAULT, LIMITE_ISCRIZIONI_MAX } from '@/lib/api/paginazione'

// =============================================================================
// IL COCKPIT DELLE PRATICHE DEL PERSONALE — lato Segreteria di `/anagrafica-personale`.
//
// `GET`   elenco · dettaglio (`?id=`) · scansione del documento (`?doc=`)
// `PATCH` approva | rifiuta | sposta-sede
//
// ── PERCHÉ QUI LA SEGRETERIA PUÒ APPROVARE, E SULLE CANDIDATURE NO ───────────
//
// Sul gemello (`admin/candidature-insegnanti`) la `PATCH` è riservata alla Direzione,
// e la ragione scritta lì è che approvare CREA UN ACCOUNT DOCENTE, cioè un accesso
// all'anagrafica dei bambini: è una decisione di assunzione, e chi si candida è una
// persona di cui la Scuola non sa ancora niente.
//
// Qui la premessa è rovesciata, e non per comodità: `/anagrafica-personale` è il
// modulo delle insegnanti GIÀ DIPENDENTI — il rapporto di lavoro esiste, l'ha
// firmato la Scuola, e il link glielo manda la Segreteria. Il gesto non è «assumere»
// ma «riconoscere una scheda e archiviarla». Tenerlo alla sola Direzione avrebbe
// significato che l'unica persona che può chiudere una pratica è l'unica che non
// smista la posta: le pratiche sarebbero rimaste in attesa, che è il modo in cui una
// funzionalità nuova muore senza che nessun test diventi rosso.
//
// La linea NON si è però spostata sui poteri: l'approvazione tocca `utenti` con un
// patch STRETTO (`nome`, `cognome`, `cellulare` — e basta) e non scrive MAI `ruolo`,
// `scuola_id`, `email`, `attivo` né `gradi` — per costruzione, non per omissione
// (vedi `COLONNE_UTENTI_AGGIORNABILI`). Sono i CINQUE modi in cui un modulo ANONIMO
// potrebbe promuovere qualcuno, spostarlo di plesso, dirottargli l'accesso,
// riattivare un account cessato — o allargargli le fasce d'età, che non è una
// preferenza d'interfaccia ma lo scope con cui `api/primaria/classi` decide a quali
// bambini quella persona arriva. Il quinto è stato l'ultimo a chiudersi (2026-08-12)
// e i primi quattro non lo dicevano: era dentro l'elenco degli ammessi.
//
// ── L'ELENCO È POVERO, e non è un'ottimizzazione ─────────────────────────────
//
// È la lezione di «Moduli ricevuti» (`ModuliRicevuti.tsx`), dove il payload completo
// di ogni domanda partiva verso il browser di OGNI membro dello staff a ogni apertura
// della pagina. Qui pesa il doppio: una pratica contiene codice fiscale, residenza,
// domicilio, estremi del documento d'identità e il recapito di un TERZO (il contatto
// d'emergenza, che non ha ricevuto nessuna informativa). In lista escono i soli campi
// che servono a RICONOSCERE una pratica; il resto arriva con `?id=`, cioè quando
// qualcuno apre QUELLA pratica: un gesto deliberato, e una alla volta.
// =============================================================================

/** La tabella della pratica, in un posto solo: il nome compare in otto query. */
const TABELLA = 'pratiche_personale'
/** …e quella del fascicolo definitivo, 1:1 con `utenti` (PK = `utente_id`). */
const TABELLA_ANAGRAFICA = 'anagrafica_personale'

/**
 * IL RUOLO È CABLATO, e non è un campo del modulo.
 *
 * `/anagrafica-personale` è pubblico e anonimo: se il ruolo arrivasse da lì — o anche
 * solo da una tendina del cockpit — chiunque abbia il link potrebbe proporsi come
 * `admin`, e basterebbe una segretaria distratta perché la proposta diventi vera.
 * Il modulo dichiara le FASCE (che cosa insegno), mai il livello d'accesso.
 */
const RUOLO_APPROVATO = 'educator' as const

/** Chi riceve gli avvisi di segreteria di una sede. */
const RUOLI_SEGRETERIA = ['admin', 'coordinator', 'segreteria']
/** Chi riceve l'avviso che è nato un accesso nuovo: è una notizia di Direzione. */
const RUOLI_DIREZIONE = ['admin', 'coordinator']

/** Dove porta il collegamento delle notifiche: la linguetta di questo cockpit. */
const LINK_COCKPIT = '/admin/modulistica?tab=personale'

/* ── I codici d'errore, letterali e in cima ───────────────────────────────────
 * Ogni risposta d'errore ne porta uno: il client traduce il codice, e chi lavora
 * con l'interfaccia in inglese non si ritrova la prosa italiana del server.
 * Sono dichiarati in `src/lib/ui/esito-fetch.ts`, e NON riusano quelli delle
 * candidature: le due porte si somigliano riga per riga, ma le frasi che una
 * persona legge parlano di due cose diverse. */
const CODICE_NON_TROVATA = 'PRATICA_NON_TROVATA'
const CODICE_OPERAZIONE_NON_RIUSCITA = 'PRATICHE_OPERAZIONE_NON_RIUSCITA'
const CODICE_GIA_EVASA = 'PRATICA_GIA_EVASA'
const CODICE_EMAIL_GIA_GENITORE = 'PRATICA_EMAIL_GIA_GENITORE'
const CODICE_SEDE_NON_AMMESSA = 'PRATICA_SEDE_NON_AMMESSA'
const CODICE_ACCOUNT_ALTRA_SEDE = 'PRATICA_ACCOUNT_ALTRA_SEDE'

/**
 * GLI AVVISI SONO CODICI, NON FRASI — la stessa regola già valida per gli errori.
 *
 * Fino al 2026-08-12 questa route componeva i suoi `warnings` in italiano a mano e il
 * cockpit li stampava verbatim. Era esattamente ciò che il file accanto evita per gli
 * errori («si passa dal CATALOGO, non dalla prosa del server, altrimenti in interfaccia
 * inglese uscirebbe l'italiano scritto nella route»), lasciato aperto proprio sui
 * messaggi che dicono che cosa è stato scritto A METÀ: «l'account NON è stato
 * aggiornato», «la pratica NON risulta legata all'account: NON ripremere Approva».
 * Sono le frasi che devono essere capite al primo colpo, ed erano le uniche non
 * tradotte della schermata.
 *
 * Adesso viaggia `{ codice, parametri }` e la frase la sceglie il catalogo del client
 * (`pratAvviso*`). I `parametri` sono SOLO nomi di colonna, etichette di fascia e nomi
 * di sede: nessun valore anagrafico, nessuna email, nessun percorso — un avviso è una
 * cosa che si legge a schermo, non un posto dove far uscire ciò che l'elenco povero
 * tiene fuori.
 *
 * ⚠️ Un codice che il client non conosce NON si perde: `PratichePersonale.tsx` ha una
 * voce di ripiego che lo NOMINA. Un client con la pagina in cache e una route
 * aggiornata è la condizione normale dopo un deploy, e un avviso perso lì è proprio
 * quello che dice «l'accesso È STATO CREATO lo stesso».
 */
// ⚠️ NON esportata, e non è una svista: un file `route.ts` di App Router ammette solo
// i suoi handler HTTP e poche chiavi di configurazione fra gli export. Un tipo si
// cancella in compilazione e passerebbe, ma la regola vale come abitudine — chi domani
// esportasse `avviso()` per riusarla altrove romperebbe la build. Il cockpit dichiara
// la stessa forma dalla sua parte, ed è il confine fra due processi.
interface Avviso {
  codice: string
  parametri?: Record<string, string | number>
}

/** Un avviso: la forma è una sola, e la si scrive in un posto solo. */
const avviso = (codice: string, parametri?: Record<string, string | number>): Avviso =>
  parametri ? { codice, parametri } : { codice }

/**
 * UN SOLO messaggio per «non esiste» e per «è di un'altra sede».
 *
 * Distinguerli direbbe a chi non ha titolo di vederla che quella pratica c'è — e da
 * lì escono il codice fiscale, la residenza e la fotografia di un documento
 * d'identità. La differenza vive nel log, dove la legge solo chi ha accesso ai log.
 */
const NON_TROVATA = 'Pratica non accessibile: non esiste, oppure appartiene a un\'altra sede.'
const nonTrovata = () =>
  NextResponse.json({ error: NON_TROVATA, codice: CODICE_NON_TROVATA }, { status: 404 })

/** Stesso messaggio del 404, ma sull'ALLEGATO: una scansione non si conferma. */
const docNegato = () =>
  NextResponse.json({ error: NON_TROVATA, codice: CODICE_NON_TROVATA }, { status: 403 })

/**
 * «Adesso non si può»: schema non ancora migrato (DB della CI), lettura o scrittura
 * fallita. **503 e non 200 con una lista vuota**: un elenco vuoto è una risposta, e
 * sarebbe una risposta falsa — la Segreteria concluderebbe che non ha compilato
 * nessuno, e le maestre che hanno consegnato il proprio documento resterebbero
 * invisibili.
 */
const nonDisponibile = (messaggio: string) =>
  NextResponse.json({ error: messaggio, codice: CODICE_OPERAZIONE_NON_RIUSCITA }, { status: 503 })

const giaEvasa = () =>
  NextResponse.json(
    {
      error: 'Questa pratica è già stata valutata: ricaricare la pagina per vedere l\'esito aggiornato.',
      codice: CODICE_GIA_EVASA,
    },
    { status: 409 },
  )

/** Codici con cui PostgREST/Postgres dicono «questa TABELLA qui non c'è». */
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])
/** …e «questa COLONNA qui non c'è». */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

const codiceDi = (err: unknown): string | null => (err as { code?: string } | null)?.code ?? null

const colonnaMancante = (messaggio: string): string | null => {
  const m =
    /column\s+(?:\w+\.)?"?(\w+)"?\s+does not exist|Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(
      messaggio,
    )
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? null
}

/**
 * I CAMPI SI LEGGONO DAL TEMPLATE, non si ribattono.
 *
 * `PERSONALE_FIELDS` è il contratto del modulo pubblico: `id` = nome della colonna di
 * destinazione. Derivare da lì significa che il giorno in cui il modulo chiederà un
 * campo in più, il dettaglio del cockpit lo mostrerà e l'approvazione lo archivierà
 * senza che nessuno debba ricordarsi di aggiungerlo in tre elenchi diversi — che è il
 * modo in cui un campo raccolto smette di essere un campo letto.
 */
const CAMPI_TEMPLATE = PERSONALE_FIELDS.map((f) => f.id)

/**
 * I campi del modulo che vivono in `utenti` e NON in `anagrafica_personale`.
 *
 * Il DDL di `20260811205643` lo dichiara: «NON contiene nome, cognome, email,
 * cellulare, ruolo, gradi né scuola_id: quelli vivono in `utenti` e restano lì — due
 * verità sulla stessa persona divergono al primo aggiornamento».
 */
const CAMPI_DI_UTENTI = new Set(['nome', 'cognome', 'email', 'telefono', 'gradi'])

/** Le colonne del FASCICOLO, cioè tutto il resto del template. */
const COLONNE_ANAGRAFICA = CAMPI_TEMPLATE.filter((c) => !CAMPI_DI_UTENTI.has(c))

/**
 * L'ELENCO. Sette colonne, e nessuna è un dato che identifichi una persona oltre il
 * suo nome: `document_expiry` c'è perché è ciò che la Segreteria deve VEDERE senza
 * aprire nulla — una pratica con il documento già scaduto è quella da guardare per
 * prima. Codice fiscale, residenza, numero del documento e contatto d'emergenza
 * arrivano solo con `?id=`.
 */
const COLONNE_ELENCO = ['id', 'scuola_id', 'stato', 'nome', 'cognome', 'document_expiry', 'creata_il']

/** Il dettaglio: proiezione ESPLICITA (mai `select('*')`), una pratica alla volta. */
const COLONNE_DETTAGLIO = [
  ...new Set([
    'id', 'scuola_id', 'stato',
    ...CAMPI_TEMPLATE,
    'consents_log',
    'creata_il', 'aggiornata_il', 'evasa_il', 'evasa_da', 'utente_id', 'motivo_rifiuto',
  ]),
]

/**
 * Le colonne che servono per DECIDERE. È la stessa proiezione del dettaglio meno
 * `consents_log`: approvare significa travasare il fascicolo, quindi qui serve tutto
 * — ma la prova dell'informativa resta dov'è, non si ricopia in una seconda tabella.
 */
const COLONNE_LAVORO = COLONNE_DETTAGLIO.filter((c) => c !== 'consents_log')

/**
 * LE UNICHE COLONNE DI `utenti` CHE UN'APPROVAZIONE PUÒ TOCCARE.
 *
 * È una lista di AMMESSI e non di esclusi, ed è la differenza fra «per costruzione» e
 * «per omissione»: con un elenco di vietati, un campo nuovo del modulo passerebbe da
 * solo il giorno in cui qualcuno lo aggiunge al template. Qui il patch viene FILTRATO
 * attraverso questo insieme prima di partire, quindi `ruolo`, `scuola_id`, `email` e
 * `attivo` non sono scrivibili nemmeno per errore di battitura.
 *
 * ⚠️ `gradi` NON È QUI, e fino al 2026-08-12 c'era. Le tre colonne rimaste sono
 * ANAGRAFICA — come ti chiami, che numero hai —; `utenti.gradi` no: è uno SCOPE DI
 * AUTORIZZAZIONE letto lato server. `api/primaria/classi/route.ts:34` legge
 * `loadGradoContext(user.id)` e risponde 403 su `!ctx.gradi.includes('primaria')`,
 * cioè le fasce decidono a quali BAMBINI si arriva. E il valore che finiva in quel
 * patch veniva da una casella di spunta di un modulo PUBBLICO e ANONIMO
 * (`personale-template.ts:230`): una maestra d'infanzia che spunta «primaria» sul
 * telefono, approvata da chi quella riga non l'ha guardata, si ritrovava l'elenco
 * delle classi di primaria. Misurato: account con `["infanzia"]`, pratica con
 * `["primaria"]` ⇒ 200 e in tabella `["primaria"]`.
 *
 * Il quinto modo di promuovere qualcuno da una porta anonima era dentro l'elenco
 * degli ammessi. Adesso è fuori, come gli altri quattro: le fasce si scrivono SOLO
 * alla nascita dell'account, dentro l'INSERT di `ensureStaffIdentity` (dove non c'è
 * nessuno scope preesistente da allargare), e su un account che esiste già NON si
 * toccano — si cambiano dal pannello Personale, che ha un gate di Direzione e una
 * persona che sceglie. Il patch qui non le porta più nemmeno per errore di battitura.
 */
const COLONNE_UTENTI_AGGIORNABILI = new Set(['nome', 'cognome', 'cellulare'])

/**
 * Clamp di un intero da query string, senza 400 e senza sorprese agli estremi.
 * `limit=0` non deve diventare il default, cioè la pagina intera.
 */
const interoClampato = (def: number, min: number, max: number) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return def
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    return Math.min(Math.max(Math.trunc(n), min), max)
  }, z.number())

const getQuerySchema = z.object({
  // Un percorso di storage non è lungo: il tetto è lo STESSO del CHECK in tabella, e
  // adesso lo è davvero — `DOC_MAX_LUNGHEZZA` è la costante che le colonne dichiarano
  // (`length(…) <= 200`). Prima qui c'era `.max(500)` con accanto questa stessa frase:
  // il commento diceva 200, il codice ne ammetteva 500, e nessuno dei due mentiva per
  // cattiveria — semplicemente il numero era ribattuto invece che importato.
  doc: z.string().max(DOC_MAX_LUNGHEZZA).optional(),
  id: zUuid.optional(),
  limit: interoClampato(LIMITE_ISCRIZIONI_DEFAULT, 1, LIMITE_ISCRIZIONI_MAX),
  offset: interoClampato(0, 0, Number.MAX_SAFE_INTEGER),
})

/**
 * Le tre azioni, come UNIONE DISCRIMINATA e non come oggetto con tutto opzionale.
 *
 * `sposta-sede` senza `scuola_id` deve essere un 400 di validazione, non un ramo che
 * arriva fino al database e ci scrive `undefined`: con un solo schema permissivo la
 * differenza fra «non me l'hai detto» e «me l'hai detto sbagliato» si perde, e la
 * seconda è l'unica che l'operatore può correggere.
 */
const patchBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approva'), id: zUuid }),
  z.object({
    action: z.literal('rifiuta'),
    id: zUuid,
    /** Nota INTERNA: resta in tabella, non esce in nessuna email e non entra nei log. */
    motivo: z.string().max(2000).optional(),
  }),
  z.object({ action: z.literal('sposta-sede'), id: zUuid, scuola_id: zUuid }),
])

/** Le fasce ammesse, dall'unico posto che le dichiara (enum `school_type_enum`). */
const GRADI_AMMESSI = new Set(GRADI_OPTIONS.map((o) => String(o.value)))

/**
 * Il nome LEGGIBILE di una fascia, dallo stesso elenco delle ammesse.
 *
 * Serve agli avvisi: `'primaria'` è il valore che sta in colonna, «Primaria (6-11)» è
 * ciò che la segreteria ha visto scritto sul modulo. Un avviso che dice «le fasce non
 * sono state applicate» senza dire QUALI non permette di decidere se andare a
 * correggere qualcosa o lasciar perdere — e questa route esiste anche per quello.
 */
const ETICHETTA_GRADO = new Map(GRADI_OPTIONS.map((o) => [String(o.value), String(o.label)]))

/** Le fasce della pratica, ripulite: un valore fuori enum prende `22P02` all'INSERT. */
function gradiValidi(grezzi: unknown): Grado[] {
  if (!Array.isArray(grezzi)) return []
  return [...new Set(grezzi.map((g) => String(g)).filter((g) => GRADI_AMMESSI.has(g)))] as Grado[]
}

const testo = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * LA PROVA DELL'INFORMATIVA ESCE RIDOTTA — tre campi, non l'oggetto intero.
 *
 * `consents_log` è la prova legale che va CONSERVATA, non un dato da mostrare: dentro
 * ci sono il testo congelato dei tre blocchi e — soprattutto — `extractRequestMeta`,
 * cioè l'INDIRIZZO IP e lo user-agent con cui la persona ha compilato da casa. Sono
 * dati suoi, raccolti per poter dimostrare un consenso, non perché qualcuno li guardi:
 * spedirli al browser di ogni membro dello staff che apre una pratica è la stessa
 * fuga di «Moduli ricevuti», con l'aggravante che qui nessuna schermata li usa.
 *
 * Ciò che alla Segreteria serve davvero è solo: le prese visione ci sono, di quando
 * sono, e a quale versione del testo. Il resto resta in tabella, dove serve.
 */
function riduciConsensi(grezzo: unknown): Record<string, unknown> | null {
  if (grezzo === null || typeof grezzo !== 'object' || Array.isArray(grezzo)) return null
  const c = grezzo as Record<string, unknown>
  const blocchi = Array.isArray(c.blocchi) ? c.blocchi : []
  return {
    versione_consensi: typeof c.versione_consensi === 'string' ? c.versione_consensi : null,
    versione_informativa: typeof c.versione_informativa === 'string' ? c.versione_informativa : null,
    accettato_il: typeof c.accettato_il === 'string' ? c.accettato_il : null,
    n_blocchi: blocchi.length,
  }
}

// ─── GET ─────────────────────────────────────────────────────────────────────
export const GET = withRoute('admin/pratiche-personale:GET', async (request: NextRequest) => {
  // Segreteria COMPRESA: è lei che smista la posta e riconosce le colleghe.
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const supabase = await createAdminClient()
    // Scope vuoto ⇒ elenco vuoto: `.in()` incondizionato, mai `if (scuole.length)`.
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)

    // ─── LA SCANSIONE DEL DOCUMENTO: `?doc=<percorso>` ────────────────────────
    if (q.data.doc) {
      const docPath = q.data.doc
      // PRIMA il gate sull'OGGETTO, POI la firma. Una URL firmata è scaricabile
      // SENZA sessione: produrla e poi rispondere 403 sarebbe una fuga con un altro
      // nome (è il difetto misurato in produzione il 2026-07-31 sui documenti
      // d'identità dei bambini).
      const fuoriScope = await assertDocumentoInScope(supabase, auth.user, scuole, docPath)
      if (fuoriScope) return fuoriScope

      // ⚠️ 300 SECONDI, e non i 600 del curriculum. Non è pignoleria: quello è un
      // curriculum, questo è la fotografia di una carta d'identità — il documento con
      // cui si apre un conto, si firma un contratto e si passa un controllo. Una URL
      // firmata è un segreto portabile: vive quanto dura la finestra in cui, se
      // finisce in una cronologia condivisa o in una chat, chiunque la scarica.
      // Cinque minuti bastano ad aprirla e a leggerla; dieci sono il doppio del
      // necessario su un dato che vale il doppio.
      const { data, error } = await supabase.storage
        .from(BUCKET_DOCUMENTI_PERSONALE)
        .createSignedUrl(docPath, 300)
      if (error || !data?.signedUrl) {
        // UN GUASTO NON SI VESTE DA DINIEGO. Il gate di sede è GIÀ passato: quella
        // scansione è della sede giusta e chi guarda ne ha titolo. Se lo storage non
        // risponde, la risposta vera è «adesso non si può, riprova» (503) — non «non
        // esiste, oppure è di un'altra sede» (403), che manderebbe la Segreteria a
        // cercare un problema di permessi che non c'è.
        //
        // Il messaggio grezzo NON torna al client: contiene il percorso, cioè
        // l'indirizzo dell'oggetto dentro un bucket privato.
        logErrore({ operazione: 'admin/pratiche-personale:GET', stato: 503, evento: 'storage' }, error)
        return NextResponse.json(
          {
            error: 'La scansione non è scaricabile in questo momento: riprovare fra poco.',
            codice: CODICE_OPERAZIONE_NON_RIUSCITA,
          },
          { status: 503 },
        )
      }
      return NextResponse.json({ url: data.signedUrl })
    }

    // ─── IL DETTAGLIO: `?id=<uuid>` ───────────────────────────────────────────
    if (q.data.id) {
      const idPratica = q.data.id
      const { data: riga, error } = await conResilienza(
        COLONNE_DETTAGLIO,
        'admin/pratiche-personale:GET',
        (colonne) =>
          supabase
            .from(TABELLA)
            .select(colonne)
            // Il filtro di sede sta nella STESSA query dell'id (AND), non «da
            // qualche parte nell'handler»: è l'unico posto in cui è vero.
            .eq('id', idPratica)
            .in('scuola_id', scuole)
            .maybeSingle(),
      )
      if (error) return leggiFallita('admin/pratiche-personale:GET', 'dettaglio-non-letto', error)
      if (!riga) {
        logEvento('multi_sede', 'warn', {
          operazione: 'admin/pratiche-personale:GET',
          esito: 'dettaglio-non-in-scope',
          utente: auth.user.id,
          ruolo: auth.user.role,
          entita_tipo: TABELLA,
          entita_id: idPratica,
          sedi_attive: scuole.length,
        })
        return nonTrovata()
      }
      // La prova dell'informativa esce RIDOTTA, non intera: vedi `riduciConsensi`.
      const dettaglio = riga as unknown as Record<string, unknown>
      return NextResponse.json({
        data: 'consents_log' in dettaglio
          ? { ...dettaglio, consents_log: riduciConsensi(dettaglio.consents_log) }
          : dettaglio,
        account: await sguardoSullAccount(supabase, scuole, testo(dettaglio.email)),
      })
    }

    // ─── L'ELENCO ─────────────────────────────────────────────────────────────
    const { limit, offset } = q.data
    const { data, error, count } = await conResilienza(
      COLONNE_ELENCO,
      'admin/pratiche-personale:GET',
      (colonne) =>
        supabase
          .from(TABELLA)
          .select(colonne, { count: 'exact' })
          .in('scuola_id', scuole)
          .order('creata_il', { ascending: false })
          .range(offset, offset + limit - 1),
    )
    if (error) return leggiFallita('admin/pratiche-personale:GET', 'elenco-non-letto', error)

    const righe = (data ?? []) as unknown as Record<string, unknown>[]
    // `total` dal conteggio ESATTO: con 12 righe su 40 la lunghezza della pagina
    // direbbe «12», e nessuno saprebbe delle altre 28.
    const total = typeof count === 'number' ? count : offset + righe.length
    return NextResponse.json({ data: righe, total, limit, offset })
  } catch (err) {
    logErrore({ operazione: 'admin/pratiche-personale:GET', stato: 503 }, err)
    return nonDisponibile('Le pratiche del personale non sono consultabili in questo momento: riprovare fra poco.')
  }
})

// ─── PATCH ───────────────────────────────────────────────────────────────────
export const PATCH = withRoute('admin/pratiche-personale:PATCH', async (request: NextRequest) => {
  // Segreteria compresa: vedi la testata. Il ruolo scritto resta `educator` e non è
  // una scelta di chi approva.
  const auth = await requireStaff(request, ['admin', 'coordinator', 'segreteria'])
  if (auth.response) return auth.response
  try {
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const corpo = b.data

    const supabase = await createAdminClient()
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)

    // La pratica si carica UNA volta, PRIMA di qualunque scrittura, e già ristretta
    // alle sedi attive: «di un'altra sede» e «non esiste» escono dalla stessa porta.
    const { data: trovata, error: errPratica } = await conResilienza(
      COLONNE_LAVORO,
      'admin/pratiche-personale:PATCH',
      (colonne) =>
        supabase
          .from(TABELLA)
          .select(colonne)
          .eq('id', corpo.id)
          .in('scuola_id', scuole)
          .maybeSingle(),
    )
    if (errPratica) return leggiFallita('admin/pratiche-personale:PATCH', 'pratica-non-letta', errPratica)
    if (!trovata) {
      logEvento('multi_sede', 'warn', {
        operazione: 'admin/pratiche-personale:PATCH',
        esito: 'pratica-non-in-scope',
        azione: corpo.action,
        utente: auth.user.id,
        ruolo: auth.user.role,
        entita_tipo: TABELLA,
        entita_id: corpo.id,
        sedi_attive: scuole.length,
      })
      return nonTrovata()
    }
    const riga = trovata as unknown as PraticaDiLavoro

    if (corpo.action === 'approva') return await approva(supabase, auth.user, scuole, riga)
    if (corpo.action === 'rifiuta') {
      return await rifiuta(supabase, auth.user, scuole, riga, testo(corpo.motivo) || null)
    }
    return await spostaSede(supabase, auth.user, scuole, riga, corpo.scuola_id)
  } catch (err) {
    logErrore({ operazione: 'admin/pratiche-personale:PATCH', stato: 503 }, err)
    return nonDisponibile('Non è stato possibile evadere la pratica: riprovare fra poco.')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Gli aiutanti
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La pratica com'è letta per decidere: le colonne sono quelle del template, quindi
 * l'indice è aperto — tipizzare a mano 32 campi significherebbe ribattere il
 * contratto che `PERSONALE_FIELDS` già dichiara, e divergere alla prima aggiunta.
 * I quattro campi nominati sono quelli su cui questo file RAGIONA.
 */
interface PraticaDiLavoro extends Record<string, unknown> {
  id: string
  scuola_id: string
  stato: string
  email?: string | null
}

type EsitoQuery<T> = { data: T; error: { code?: string; message: string } | null; count?: number | null }

/**
 * Resilienza alla COLONNA assente (`42703`/`PGRST204`): il progetto E2E della CI non
 * è migrato, e una proiezione esplicita — al contrario di `select('*')` — fallisce.
 * Si toglie la colonna che il database dichiara di non avere e si riprova, lasciando
 * una riga che la NOMINA (in `msg`, che finisce in chiaro nella colonna
 * `app_log.messaggio`: `redact` è a lista bianca per chiave, e un nome di colonna non
 * è un dato personale).
 *
 * La TABELLA assente non è qui: quella non si degrada, si dichiara (503).
 *
 * ⚠️ DEBITO DICHIARATO: questo helper e `cambiaStato` qui sotto sono i gemelli di
 * quelli di `admin/candidature-insegnanti/route.ts`. Vivere in due copie è
 * esattamente ciò che il repo ha già pagato («una regola valida per due strade deve
 * vivere in un posto solo»), e la strada giusta è estrarli in `src/lib`. Non si fa in
 * questo passaggio perché toccherebbe la route delle candidature, che qui non è in
 * perimetro: il giorno in cui si estraggono, si estraggono per entrambe.
 */
async function conResilienza<T>(
  colonneIniziali: string[],
  operazione: string,
  esegui: (colonne: string) => PromiseLike<EsitoQuery<T>>,
): Promise<EsitoQuery<T>> {
  let colonne = [...colonneIniziali]
  let esito = await esegui(colonne.join(', '))
  let tentativi = 0
  while (esito.error && COLONNA_ASSENTE.has(codiceDi(esito.error) ?? '') && tentativi < 8) {
    const col = colonnaMancante(esito.error.message ?? '')
    if (!col || !colonne.includes(col)) break
    logEvento('personale', 'warn', {
      operazione,
      esito: 'colonna-assente-rimossa',
      entita_tipo: TABELLA,
      error_code: codiceDi(esito.error),
      msg: `colonna assente, rimossa dalla proiezione: ${col}`,
    })
    colonne = colonne.filter((c) => c !== col)
    esito = await esegui(colonne.join(', '))
    tentativi++
  }
  return esito
}

/**
 * Una lettura fallita NON è «non trovata»: i due hanno rimedi opposti — la prima si
 * risolve riprovando, la seconda no — e rispondere 404 su un guasto significa
 * affermare qualcosa su un dato che non si è letto.
 */
function leggiFallita(operazione: string, esito: string, error: unknown): NextResponse {
  const codice = codiceDi(error)
  const schemaAssente = TABELLA_ASSENTE.has(codice ?? '')
  logEvento('personale', schemaAssente ? 'warn' : 'error', {
    operazione,
    esito: schemaAssente ? 'tabella-assente' : esito,
    entita_tipo: TABELLA,
    error_code: codice,
  }, error)
  return nonDisponibile(
    schemaAssente
      ? 'Le pratiche del personale non sono disponibili su questo ambiente: la tabella non è ancora stata creata.'
      : 'Le pratiche del personale non sono consultabili in questo momento: riprovare fra poco.',
  )
}

/**
 * GATE SULL'OGGETTO per `?doc=` — il percorso si RISOLVE alla pratica che lo contiene,
 * interrogando le sole sedi attive, e si firma solo se ne esce una riga.
 *
 * Tre scelte, tutte deliberate:
 *  · fail-CLOSED: se la lettura fallisce non si firma. Non sapere di chi è la
 *    fotografia di un documento d'identità non può voler dire consegnarla;
 *  · percorso che non si risolve ⇒ diniego: un oggetto che nessuna pratica nomina non
 *    ha una sede da verificare, quindi nessuno può dire che sia suo — ed è anche lo
 *    stato di un oggetto APPROVATO, il cui percorso è passato ad
 *    `anagrafica_personale` (la pratica lo rilascia, «un oggetto, un proprietario»).
 *    Da questo cockpit quella scansione non si firma più, ed è giusto: adesso è del
 *    fascicolo, e il fascicolo ha la sua schermata e i suoi termini;
 *  · un solo messaggio per «di un'altra sede» e «inesistente».
 *
 * ── ⚠️ LE COLONNE SI ITERANO, E NON SI SCRIVONO QUI ────────────────────────
 *
 * Fino al 12/08/2026 questa funzione interrogava `documento_path`. Quel giorno la
 * migrazione `20260812194501` ha rinominato la colonna in `documento_fronte_path`, e
 * l'ha fatto in produzione: la lettura è diventata un `42703` («column does not
 * exist»), che su un gate fail-CLOSED significa «non firmo». Cioè la Segreteria di
 * tutte e tre le sedi ha smesso di poter aprire QUALUNQUE documento d'identità,
 * ricevendo la stessa risposta di un tentativo abusivo, senza che nessun test fosse
 * rosso. Verificato sul database vero:
 *
 *     select id from pratiche_personale where documento_path = '…'
 *     → ERROR 42703: column "documento_path" does not exist
 *
 * Da qui il ciclo su `COLONNE_DOCUMENTO` (`@/lib/personale/percorso-documento`), che è
 * l'elenco derivato dal template: una faccia in più domani non tocca questa riga, e un
 * rinomino la segue da solo.
 *
 * ── ⚠️ PRIMA LA FORMA, POI LA RISOLUZIONE — E PERCHÉ NON UN `.or(…)` SOLO ──
 *
 * `?doc=` è testo di query string e il suo schema `zod` impone SOLO un tetto di
 * lunghezza: la forma non la vincola nessuno. Con due colonne da confrontare la
 * scrittura che viene naturale è
 * `.or('documento_fronte_path.eq.<X>,documento_retro_path.eq.<X>')`, che INTERPOLA
 * `<X>` dentro la sintassi del filtro. Lì la virgola separa le condizioni: un valore
 * che ne contenga una non rompe il filtro, lo RISCRIVE — e questo gate direbbe «è
 * della tua sede» di un documento che non lo è. Non è un'iniezione SQL (PostgREST non
 * concatena SQL): è un'iniezione di FILTRO, e qui il danno è lo stesso.
 *
 * Da qui l'ordine: `percorsoDocumentoAmmesso` decide la forma PRIMA che il valore
 * incontri qualunque query, e dopo quel gate l'alfabeto ammesso non contiene virgole,
 * parentesi né apici.
 *
 * E ANCHE DOPO IL GATE restano due `.eq()`, perché le due difese sono indipendenti:
 * `.eq()` non interpola niente (la virgola esce percent-encodata — misurato,
 * `new URLSearchParams({a:'x,y'}).toString()` → `a=x%2Cy`), quindi regge da solo anche
 * il giorno in cui qualcuno allargasse la forma in un altro file per far passare un
 * percorso legittimo. Con un `.or()` la sicurezza di questa funzione dipenderebbe da
 * una riga che non sta qui. Il costo sono due letture invece di una, e solo quando la
 * prima non trova nulla.
 *
 * Per chi lo riceve, il rifiuto per FORMA è indistinguibile da «quel percorso non
 * esiste»: stessa risposta, stessa frase, stesso codice. Dire «malformato»
 * confermerebbe a chi prova che le forme respinte in altro modo erano giuste. La
 * differenza resta nel log, con un `esito` suo.
 */
async function assertDocumentoInScope(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  docPath: string,
): Promise<NextResponse | null> {
  // ── IL GATE DI FORMA, prima di qualunque query. Vedi la testata.
  if (!percorsoDocumentoAmmesso(docPath)) {
    // MAI il percorso nel log: non porta il nome del file, ma è la chiave che apre la
    // fotografia della carta d'identità di una persona, e `redact()` non lo ha in
    // lista bianca. Si registra CHE è stato respinto, e da chi.
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/pratiche-personale:GET',
      esito: 'documento-forma-non-valida',
      azione: 'documento',
      utente: user.id,
      ruolo: user.role,
      sedi_attive: scuole.length,
    })
    // `docNegato()` e non `nonTrovata()`: è la STESSA risposta che riceve chi chiede
    // un percorso ben formato e inesistente (403, stesso messaggio, stesso codice).
    // Basterebbe uno status diverso a dire a chi prova che la forma, quella volta, era
    // giusta — cioè a trasformare il gate in un oracolo sulla forma dei percorsi.
    return docNegato()
  }

  let trovataInScope: { id?: unknown; scuola_id?: unknown } | null = null
  for (const colonna of COLONNE_DOCUMENTO) {
    const { data, error } = await supabase
      .from(TABELLA)
      .select('id, scuola_id')
      .eq(colonna, docPath)
      .in('scuola_id', scuole)
      .limit(1)
      .maybeSingle()
    if (error) {
      logEvento('multi_sede', 'error', {
        operazione: 'admin/pratiche-personale:GET',
        esito: 'documento-non-verificabile',
        entita_tipo: TABELLA,
        error_code: codiceDi(error),
      }, error)
      return nonDisponibile('Verifica della scansione non riuscita: riprovare fra poco.')
    }
    if (data) {
      trovataInScope = data as { id?: unknown; scuola_id?: unknown }
      break
    }
  }
  if (trovataInScope) {
    const trovata = trovataInScope
    // IL REGISTRO DEGLI ACCESSI RIUSCITI. `multi_sede` è persistito: la riga resta in
    // `app_log` e sopravvive al deploy. Senza, «nessun log» non distingue «nessuno ha
    // guardato» da «la sorveglianza non è mai partita» — e da qui esce la copia di un
    // documento d'identità, su cui l'interessata ha diritto di chiedere chi l'ha
    // letta. MAI il percorso: è l'indirizzo dell'oggetto.
    logEvento('multi_sede', 'info', {
      operazione: 'admin/pratiche-personale:GET',
      esito: 'documento-firmato',
      azione: 'documento',
      utente: user.id,
      ruolo: user.role,
      sede_id: typeof trovata.scuola_id === 'string' ? trovata.scuola_id : null,
      sedi_attive: scuole.length,
      entita_tipo: TABELLA,
      entita_id: typeof trovata.id === 'string' ? trovata.id : null,
    })
    return null
  }

  // Diniego. Solo PER IL LOG si guarda se quel percorso esista in un'altra sede:
  // distingue un tentativo cross-sede da un percorso inventato, e senza quella
  // distinzione il log di una fuga non si legge. Best-effort: legge una riga e la sola
  // `scuola_id`, e un errore qui non cambia l'esito. Stesso ciclo sulle colonne del
  // gate qui sopra: cercare il fronte e non il retro direbbe «inventato» di un
  // documento che esiste, cioè renderebbe illeggibile proprio il log di una fuga.
  let sedeAltrove: string | null = null
  for (const colonna of COLONNE_DOCUMENTO) {
    const { data: altrove, error: errAltrove } = await supabase
      .from(TABELLA)
      .select('scuola_id')
      .eq(colonna, docPath)
      .limit(1)
      .maybeSingle()
    if (errAltrove) {
      logEvento('multi_sede', 'info', {
        operazione: 'admin/pratiche-personale:GET',
        esito: 'documento-origine-non-verificabile',
        entita_tipo: TABELLA,
        error_code: codiceDi(errAltrove),
      }, errAltrove)
      continue
    }
    const sede = (altrove as { scuola_id?: unknown } | null)?.scuola_id
    if (typeof sede === 'string') {
      sedeAltrove = sede
      break
    }
  }

  logEvento('multi_sede', 'warn', {
    operazione: 'admin/pratiche-personale:GET',
    esito: sedeAltrove ? 'documento-fuori-sede' : 'documento-non-risolto',
    azione: 'documento',
    utente: user.id,
    ruolo: user.role,
    sede_id: sedeAltrove,
    sedi_attive: scuole.length,
  })
  return docNegato()
}

/**
 * Il passaggio di stato, con la sede NELLA STESSA istruzione che scrive e gli stati di
 * partenza ammessi nel `WHERE`: è ciò che rende ATOMICO il claim
 * (`pending → in_approvazione`) e chiude la corsa fra due clic o due schede.
 * Zero righe non è un errore: è «qualcun altro è arrivato prima».
 */
async function cambiaStato(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  args: { id: string; scuole: string[]; da: string[]; patch: Record<string, unknown> },
): Promise<{
  righe: Record<string, unknown>[]
  error: { code?: string; message: string } | null
  /**
   * Le colonne TOLTE dalla scrittura perché il database non le ha. Va RESTITUITA, e
   * non solo loggata: senza, il chiamante non può distinguere «scritto tutto» da
   * «scritto in parte» — l'UPDATE ritorna comunque una riga (`stato` c'è ancora) e
   * ogni misura a valle direbbe «riuscito».
   */
  colonneCadute: string[]
}> {
  const record = { ...args.patch }
  const colonneCadute: string[] = []
  const scrivi = () =>
    supabase
      .from(TABELLA)
      .update(record)
      .eq('id', args.id)
      .in('stato', args.da)
      .in('scuola_id', args.scuole)
      .select('id, scuola_id, stato')
  let esito = await scrivi()
  let tentativi = 0
  // Degrado sulla COLONNA assente (DB della CI non migrato). `stato` non si toglie
  // mai: senza quello l'istruzione non fa più ciò per cui esiste.
  while (esito.error && COLONNA_ASSENTE.has(codiceDi(esito.error) ?? '') && tentativi < 8) {
    const col = colonnaMancante(esito.error.message ?? '')
    if (!col || !(col in record) || col === 'stato') break
    logEvento('personale', 'warn', {
      operazione,
      esito: 'colonna-assente-rimossa',
      entita_tipo: TABELLA,
      error_code: codiceDi(esito.error),
      msg: `colonna assente, rimossa dalla scrittura: ${col}`,
    })
    delete record[col]
    colonneCadute.push(col)
    esito = await scrivi()
    tentativi++
  }
  return { righe: (esito.data ?? []) as Record<string, unknown>[], error: esito.error, colonneCadute }
}

/**
 * Rimette `pending` una pratica CLAIMATA e non conclusa.
 *
 * Ogni uscita anticipata dell'approvazione passa di qui, e non è una cortesia: una
 * pratica ferma in `in_approvazione` non è più approvabile da nessuno — il claim
 * pretende `pending` — e nessuno saprebbe perché. Il fallimento del ripristino si
 * logga a `error`: da lì in poi serve una mano umana.
 */
async function rimettiPending(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  args: { id: string; scuole: string[] },
): Promise<void> {
  const esito = await cambiaStato(supabase, 'admin/pratiche-personale:PATCH', {
    id: args.id,
    scuole: args.scuole,
    da: ['in_approvazione'],
    patch: { stato: 'pending', aggiornata_il: new Date().toISOString() },
  })
  if (esito.error || esito.righe.length === 0) {
    logEvento('personale', 'error', {
      operazione: 'admin/pratiche-personale:PATCH',
      esito: 'ripristino-pending-non-riuscito',
      entita_tipo: TABELLA,
      entita_id: args.id,
      error_code: codiceDi(esito.error),
    }, esito.error ?? undefined)
  }
}

/**
 * L'ACCOUNT DI QUESTA EMAIL ESISTE GIÀ? — e si chiede PRIMA del claim.
 *
 * ⚠️ IL PUNTO NON È IL RISULTATO, È IL GUASTO. PostgREST non lancia: ritorna
 * `{ error }`. Una lettura fallita, senza questo controllo, si travestirebbe da «email
 * libera» e la strada proseguirebbe fino a creare un SECONDO account per una maestra
 * che ce l'ha già — cioè un registro diviso in due, e un accesso perso. Qui un errore
 * di lettura vale **503 fail-closed**, e vale PRIMA di aver toccato lo stato: nessun
 * claim da disfare, nessuna pratica lasciata in `in_approvazione`.
 *
 * ⚠️ `lower(email)` NON è esprimibile in PostgREST, e va detto invece di lasciarlo
 * credere: la migrazione `20260811205643` crea `utenti (lower(email))` proprio per
 * questa domanda, ma quell'indice serve alla forma SQL, non a `.eq()`. Si interrogano
 * le due forme (com'è scritta e minuscola), che è lo stesso presidio di
 * `staff-identity.ts` e ne condivide il limite dichiarato: un indirizzo archiviato
 * `Mario.Rossi@x.it` contro un modulo che scrive `mario.rossi@x.it` qui non esce. La
 * chiusura vera è una RPC su `lower(email)`, ed è un debito scritto, non un'illusione.
 *
 * NIENTE `.ilike()`: PostgREST traduce `*` in `%` dentro i pattern, quindi un carattere
 * jolly arrivato dal modulo pubblico ALLARGHEREBBE la ricerca invece di stringerla.
 * `.in()` è uguaglianza pura.
 *
 * ⚠️ E NIENTE FILTRO DI SEDE, di proposito: la domanda è «esiste un account con questa
 * email in QUALUNQUE plesso?». Restringendola alle sedi attive, approvare la pratica di
 * una maestra trasferita creerebbe il suo secondo account — che è esattamente il
 * difetto che questa lettura esiste per impedire. La riga esce con `.maybeSingle()`:
 * non è un elenco, è una domanda con risposta sì/no.
 */
interface AccountNoto {
  utenteId: string
  ruolo: string | null
  scuolaId: string | null
}

/**
 * La lettura vera e propria, in un posto solo perché la fanno in DUE: la `PATCH`
 * (fail-closed, prima del claim) e il dettaglio della `GET`, che deve poter DIRE a chi
 * sta per premere «Approva» che quell'email un account ce l'ha già. Due letture
 * scritte due volte divergono alla prima modifica, e allora il riquadro di conferma
 * direbbe una cosa e l'approvazione ne farebbe un'altra.
 *
 * `ruolo` e `scuola_id` escono insieme all'id perché costano zero nella stessa
 * proiezione e sono precisamente ciò che serve sapere PRIMA: «sto per riscrivere il
 * profilo di un'amministratrice» e «sto per riscrivere il fascicolo di una persona di
 * un altro plesso» sono due frasi che nessuno può dedurre da un booleano.
 */
async function leggiAccountPerEmail(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  email: string,
): Promise<{ account: AccountNoto | null; error: { code?: string; message: string } | null }> {
  const forme = [...new Set([email, email.toLowerCase()])]
  const { data, error } = await supabase
    .from('utenti')
    .select('id, ruolo, scuola_id')
    .in('email', forme)
    .limit(1)
    .maybeSingle()
  if (error) {
    logEvento('personale', 'error', {
      operazione,
      esito: 'verifica-account-non-riuscita',
      entita_tipo: 'utenti',
      error_code: codiceDi(error),
    }, error)
    return { account: null, error: error as { code?: string; message: string } }
  }
  const riga = data as { id?: unknown; ruolo?: unknown; scuola_id?: unknown } | null
  const id = typeof riga?.id === 'string' ? riga.id : null
  if (!id) return { account: null, error: null }
  return {
    account: {
      utenteId: id,
      ruolo: typeof riga?.ruolo === 'string' && riga.ruolo !== '' ? riga.ruolo : null,
      scuolaId: typeof riga?.scuola_id === 'string' && riga.scuola_id !== '' ? riga.scuola_id : null,
    },
    error: null,
  }
}

async function risolviAccountEsistente(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  email: string,
): Promise<{ response: NextResponse } | { account: AccountNoto | null }> {
  const { account, error } = await leggiAccountPerEmail(supabase, 'admin/pratiche-personale:PATCH', email)
  if (error) {
    return {
      response: nonDisponibile(
        'Non è stato possibile verificare se questa persona ha già un account: riprovare fra poco. ' +
          'La pratica non è stata toccata.',
      ),
    }
  }
  return { account }
}

/**
 * LA PERSONA STA IN UN PLESSO CHE QUESTA POSTAZIONE GESTISCE? — e si chiede PRIMA di
 * scrivere il fascicolo, non dopo.
 *
 * ⚠️ È IL GATE CHE MANCAVA, ed era l'unica scrittura di questa route senza. Il patch di
 * `utenti` la sede ce l'ha nell'istruzione (`aggiornaUtente`, `.in('scuola_id', …)`); il
 * fascicolo no — ed è la tabella che contiene codice fiscale, nascita, residenza,
 * domicilio, estremi del documento e il percorso della scansione. `anagrafica_personale`
 * NON ha una `scuola_id` (per scelta del DDL: la sede del personale vive in `utenti`),
 * quindi la clausola non si può mettere nell'`upsert` e va messa qui, sulla riga di
 * `utenti` che ne è la chiave.
 *
 * MISURATO il 2026-08-12, prima di questa funzione: pratica in SEDE_A, account con la
 * stessa email in SEDE_B, cockpit con scope [SEDE_A] ⇒ HTTP 200, `upsert` eseguito,
 * `fiscal_code` e `document_number` del fascicolo di SEDE_B **sovrascritti** con quelli
 * di un modulo pubblico e anonimo, mentre l'UPDATE su `utenti` veniva correttamente
 * rifiutato. Il modulo `/anagrafica-personale` è aperto e gli indirizzi delle maestre
 * sono pubblici: bastava inviare una pratica con l'email di una collega di un altro
 * plesso.
 *
 * ── PERCHÉ `.in('scuola_id', scuole)` E NON `assertUtenteInScope` ─────────────
 * Quel presidio confronta con `scuoleDiUtente` — TUTTI i plessi accessibili — mentre
 * ogni altra scrittura di questa route usa `scuole`, cioè `resolveScuoleAttive`, che è
 * il sottoinsieme scelto nel SedeSelector. Passare da lì avrebbe lasciato scrivere il
 * fascicolo su un plesso che l'operatore ha appena tolto dalla selezione: un gate più
 * debole di quello accanto, nella stessa funzione. La sede sta nell'istruzione che
 * legge, con lo stesso array di quella che scrive.
 *
 * ── E PERCHÉ SOLO SUL RIUSO ──────────────────────────────────────────────────
 * Se l'account è NATO in questa chiamata, `ensureStaffIdentity` l'ha creato con
 * `scuolaId: sedePratica`, e la pratica è già ristretta a `scuole`: chiederlo di nuovo
 * al database aggiungerebbe un modo di sbagliare (una `scuola_id` caduta per degrado su
 * un ambiente non migrato negherebbe un'approvazione legittima) senza aggiungere
 * nessuna difesa.
 *
 * Fail-closed: una lettura fallita NON vale «è nel plesso giusto». PostgREST non lancia.
 */
async function accountNelloScope(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  args: { utenteId: string; scuole: string[] },
): Promise<{ esito: 'dentro'; sede: string | null } | { esito: 'fuori' | 'illeggibile' }> {
  const { data, error } = await supabase
    .from('utenti')
    .select('id, scuola_id')
    .eq('id', args.utenteId)
    .in('scuola_id', args.scuole)
    .maybeSingle()
  if (error) {
    logEvento('personale', 'error', {
      operazione,
      esito: 'scope-account-non-risolto',
      entita_tipo: 'utenti',
      entita_id: args.utenteId,
      error_code: codiceDi(error),
    }, error)
    return { esito: 'illeggibile' }
  }
  if (!data) return { esito: 'fuori' }
  const sede = (data as { scuola_id?: unknown }).scuola_id
  return { esito: 'dentro', sede: typeof sede === 'string' && sede !== '' ? sede : null }
}

/**
 * QUELL'EMAIL HA GIÀ UN ACCESSO? — la risposta viaggia col DETTAGLIO, cioè PRIMA che
 * qualcuno prema «Approva».
 *
 * ⚠️ PERCHÉ È UN CAMPO DELLA RISPOSTA E NON UN DETTAGLIO INTERNO. La route lo sapeva
 * già — `risolviAccountEsistente` gira apposta prima del claim — e fino al 2026-08-12
 * lo buttava in un campo di log (`account_preesistente`). Il riquadro di conferma non
 * poteva dirlo e non lo diceva. Misurato lo stesso giorno: una pratica ANONIMA con
 * l'email di un account `admin` della propria sede ⇒ HTTP 200, ruolo e sede
 * correttamente intatti (il patch stretto regge), ma nome, cognome e cellulare
 * dell'amministratrice riscritti con quelli del modulo, e il fascicolo — codice
 * fiscale, residenza, documento — scritto sul suo `utente_id`. Chi ha premuto non
 * aveva modo di accorgersene: la risposta del dettaglio, 23 chiavi, non nominava
 * l'account da nessuna parte.
 *
 * `/anagrafica-personale` è pubblico e anonimo, e gli indirizzi delle maestre sono
 * pubblici: chiunque può inviare una pratica con l'email di una collega o della
 * Direzione. La difesa che impedisce la PROMOZIONE resta il patch stretto; questa
 * risposta serve all'altra metà, cioè a far vedere il fatto a chi decide.
 *
 * ── COSA NON ESCE, E PERCHÉ ──────────────────────────────────────────────────
 * Nessun uuid dell'account e nessuna email diversa da quella già in pratica: qui non
 * si apre una finestra sull'anagrafica del personale, si risponde a una domanda che
 * riguarda QUESTA pratica. E quando l'account sta in un plesso che questa postazione
 * non gestisce, il ruolo NON esce: la decisione lì è già presa (l'approvazione verrà
 * negata dal punto 5), e il ruolo di una persona di un altro plesso non serve a
 * prenderla.
 *
 * Tre stati e non due: `esiste: null` è «non si è potuto verificare», e non si
 * confonde con «non c'è» — che è precisamente l'errore che il fail-closed della
 * `PATCH` esiste per evitare.
 */
async function sguardoSullAccount(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  scuole: string[],
  email: string,
): Promise<{ esiste: boolean | null; ruolo: string | null; sede_gestita: boolean | null; sede_nome: string | null }> {
  const ignoto = { esiste: null, ruolo: null, sede_gestita: null, sede_nome: null }
  if (email === '') return ignoto
  const operazione = 'admin/pratiche-personale:GET'
  const { account, error } = await leggiAccountPerEmail(supabase, operazione, email)
  if (error) return ignoto
  if (!account) return { esiste: false, ruolo: null, sede_gestita: null, sede_nome: null }

  const gestita = account.scuolaId !== null && scuole.includes(account.scuolaId)
  if (!gestita) return { esiste: true, ruolo: null, sede_gestita: false, sede_nome: null }
  return {
    esiste: true,
    ruolo: account.ruolo,
    sede_gestita: true,
    sede_nome: await nomeSede(supabase, account.scuolaId, operazione),
  }
}

/**
 * IL FASCICOLO — `upsert` su `anagrafica_personale`, chiave `utente_id`.
 *
 * `onConflict: 'utente_id'` e non un INSERT: la PK è l'utente, e una maestra che
 * ricompila il modulo l'anno dopo (documento rinnovato, trasloco) deve AGGIORNARE la
 * sua scheda, non prendere un `23505`. Il trigger `anagrafica_personale_tocca` azzera
 * da solo il promemoria di scadenza quando `document_expiry` cambia: quella regola non
 * si ripete qui, vive in un posto solo.
 *
 * Le colonne cadute per degrado si RESTITUISCONO, non si loggano soltanto: «fascicolo
 * scritto» e «fascicolo scritto a metà» sono due fatti diversi, e chi ha premuto
 * «Approva» deve poterli distinguere.
 */
async function scriviFascicolo(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  record: Record<string, unknown>,
): Promise<{ error: { code?: string; message: string } | null; colonneCadute: string[] }> {
  const dati = { ...record }
  const colonneCadute: string[] = []
  const scrivi = () =>
    supabase.from(TABELLA_ANAGRAFICA).upsert(dati, { onConflict: 'utente_id' }).select('utente_id')
  let esito = await scrivi()
  let tentativi = 0
  while (esito.error && COLONNA_ASSENTE.has(codiceDi(esito.error) ?? '') && tentativi < 12) {
    const col = colonnaMancante(esito.error.message ?? '')
    // `utente_id` non si toglie MAI: è la chiave primaria, e senza di lei l'upsert non
    // ha più niente su cui riconoscere la riga — scriverebbe un fascicolo di nessuno.
    if (!col || !(col in dati) || col === 'utente_id') break
    logEvento('personale', 'warn', {
      operazione,
      esito: 'colonna-assente-rimossa',
      entita_tipo: TABELLA_ANAGRAFICA,
      error_code: codiceDi(esito.error),
      msg: `colonna assente, rimossa dal fascicolo: ${col}`,
    })
    delete dati[col]
    colonneCadute.push(col)
    esito = await scrivi()
    tentativi++
  }
  return { error: esito.error, colonneCadute }
}

/**
 * GLI OGGETTI HANNO UN PROPRIETARIO? — presidio, non scrittura di routine.
 *
 * `iscrizione/personale:POST` collega già le righe di `caricamenti_personale` alla
 * pratica appena creata, ma quel collegamento è best-effort: se è saltato, l'oggetto
 * risulta «in sospeso» e la spazzata degli orfani lo toglie dal bucket entro poche ore
 * — cioè la Segreteria approverebbe una scheda il cui documento sta per sparire.
 *
 * ⚠️ NON si chiama `collegaCaricamenti` a occhi chiusi: quella funzione logga `error`
 * quando non collega nessuna riga, e all'approvazione il caso NORMALE è proprio quello
 * (la riga è già collegata dalla porta pubblica). Un `error` a ogni approvazione è un
 * allarme che si impara a ignorare, ed è il modo in cui il guasto vero, quando arriva,
 * non lo vede nessuno. Quindi prima si guarda, poi si agisce — e la regola non cambia
 * col plurale: cambia solo che adesso si guarda una volta sola per DUE facce.
 *
 * ⚠️ UNA LETTURA SOLA, E UNA RIGA DI LOG PER FATTO. Con una chiamata per faccia lo
 * stesso guasto uscirebbe in due righe scoordinate, e nessuna delle due direbbe che la
 * pratica è rimasta MEZZA documentata. Con `.in()` il fatto è un'aritmetica: quante
 * facce erano attese, quante sono a posto.
 */
async function assicuraCaricamentiCollegati(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  percorsi: string[],
  praticaId: string,
): Promise<void> {
  // ⚠️ LA NORMALIZZAZIONE NON SI RISCRIVE QUI, e la prima stesura di questa funzione lo
  // aveva fatto: `[...new Set(percorsi)]`, senza `trim()`, cioè una copia già divergente
  // dall'originale nel momento in cui è stata scritta. `facceChieste` deduplica (la PK è
  // `percorso`: due facce uguali sono UNA riga, e contarle due volte griderebbe un guasto
  // che non c'è) e soprattutto CONTA le facce arrivate vuote invece di scartarle.
  const { distinti: attesi, attese } = facceChieste(percorsi)
  // `.in('percorso', [])` è un viaggio al database per nulla.
  if (attesi.length === 0) return

  // ⚠️ SI GUARDANO ENTRAMBE LE COLONNE DI PROPRIETÀ, e non solo `pratica_id`.
  //
  // La migrazione `20260812194501` ha aggiunto `caricamenti_personale.anagrafica_utente_id`
  // — il proprietario alternativo, per gli oggetti che la Segreteria carica dalla scheda
  // della persona — con `check (num_nonnulls(pratica_id, anagrafica_utente_id) <= 1)`, e
  // ha riscritto l'indice dei sospesi come `where pratica_id is null and
  // anagrafica_utente_id is null`. Leggendo la sola `pratica_id`, un oggetto di
  // proprietà di un'ANAGRAFICA risulta «in sospeso» — la sua `pratica_id` è NULL per
  // costruzione — e finirebbe in `daCollegare`; `collegaCaricamenti` filtra anch'essa
  // `.is('anagrafica_utente_id', null)` (stesso predicato del reclamo e della spazzata),
  // quindi aggiornerebbe ZERO righe e lascerebbe un `error` in `app_log` su uno stato
  // sano. È letteralmente l'allarme che si impara a ignorare di cui parla la testata di
  // questa funzione.
  //
  // ⚠️ E SE LA COLONNA NON C'È SU QUESTO DATABASE, la lettura risponde `42703` e si esce
  // dal ramo qui sotto — best-effort, con una riga di `warn` e nessun blocco. È lo stesso
  // comportamento che `@/lib/personale/caricamenti` ha già scelto nominando quella colonna
  // senza rete: una seconda regola di degrado, diversa, in un secondo file, è il modo in
  // cui due strade che devono decidere la stessa cosa cominciano a decidere cose diverse.
  const { data, error } = await supabase
    .from('caricamenti_personale')
    .select('percorso, pratica_id, anagrafica_utente_id')
    .in('percorso', attesi)
  if (error) {
    // Best-effort: il registro non risponde. Non si blocca un'approvazione per questo,
    // ma tacere sarebbe peggio — è l'unica riga che dice perché, fra qualche ora, un
    // documento potrebbe non esserci più.
    logEvento('personale', 'warn', {
      operazione,
      esito: 'registro-caricamenti-non-letto',
      entita_tipo: 'caricamenti_personale',
      entita_id: praticaId,
      n_attesi: attese,
      error_code: codiceDi(error),
    }, error)
    return
  }

  // MAI il percorso nei log: è la chiave con cui si firma la fotografia di un documento
  // d'identità, e `app_log` è interrogabile in SQL per 30 giorni. Qui i percorsi vivono
  // solo dentro questa mappa, e di fuori escono conteggi.
  const proprietaria = new Map<string, { pratica: string | null; anagrafica: string | null }>()
  for (const r of (data ?? []) as {
    percorso?: unknown
    pratica_id?: unknown
    anagrafica_utente_id?: unknown
  }[]) {
    if (typeof r.percorso !== 'string') continue
    proprietaria.set(r.percorso, {
      pratica: typeof r.pratica_id === 'string' ? r.pratica_id : null,
      anagrafica: typeof r.anagrafica_utente_id === 'string' ? r.anagrafica_utente_id : null,
    })
  }

  const senzaRiga = attesi.filter((p) => !proprietaria.has(p))
  // «In sospeso» è ciò che l'indice parziale della migrazione chiama così: NESSUNO dei
  // due proprietari. È l'unico stato che vada riparato, ed è l'unico che la spazzata
  // raccoglie — quindi l'unico in cui non riparare costa un documento.
  const daCollegare = attesi.filter((p) => {
    const chi = proprietaria.get(p)
    return chi !== undefined && chi.pratica === null && chi.anagrafica === null
  })
  const diAltraPratica = attesi.filter((p) => {
    const chi = proprietaria.get(p)?.pratica
    return typeof chi === 'string' && chi !== praticaId
  })
  const diUnAnagrafica = attesi.filter((p) => proprietaria.get(p)?.anagrafica != null)

  if (senzaRiga.length > 0) {
    logEvento('personale', 'warn', {
      operazione,
      esito: 'caricamento-non-registrato',
      entita_tipo: 'caricamenti_personale',
      entita_id: praticaId,
      n_attesi: attese,
      n_senza_riga: senzaRiga.length,
      msg:
        `${operazione}: ${senzaRiga.length} scansioni su ${attese} non hanno una riga nel ` +
        `registro dei caricamenti, quindi la conservazione non sa che esistono`,
    })
  }

  if (diAltraPratica.length > 0) {
    // L'oggetto è di un'ALTRA pratica: due righe nominano lo stesso file, e la
    // conservazione della prima cancellerebbe ciò che la seconda usa. Non si disfa qui
    // (il fascicolo esiste già), ma si NOMINA: senza questa riga la cosa si scoprirebbe
    // da un documento sparito, mesi dopo.
    logEvento('personale', 'error', {
      operazione,
      esito: 'caricamento-di-altra-pratica',
      entita_tipo: 'caricamenti_personale',
      entita_id: praticaId,
      n_attesi: attese,
      n_di_altra_pratica: diAltraPratica.length,
      msg:
        `${operazione}: una scansione approvata risulta di un'altra pratica; la conservazione di ` +
        `quella cancellerebbe il file che questo fascicolo sta usando`,
    })
  }

  if (diUnAnagrafica.length > 0) {
    // L'oggetto è già di un'ANAGRAFICA — l'ha caricato la Segreteria dalla scheda di
    // una persona, non è mai passato da una pratica — e adesso una pratica lo nomina.
    // È lo stesso danno del caso qui sopra, dall'altra parte: due righe per un file
    // solo, e la conservazione della PRATICA (90 giorni) porterebbe via ciò che il
    // fascicolo (dieci anni) sta usando.
    //
    // Esito PROPRIO e non appiccicato a `caricamento-di-altra-pratica`: sono due fatti
    // diversi per chi legge `app_log`, hanno due rimedi diversi, e una frase che dicesse
    // «di un'altra pratica» su un oggetto che nessuna pratica possiede manderebbe a
    // cercare una pratica che non esiste.
    logEvento('personale', 'error', {
      operazione,
      esito: 'caricamento-di-unanagrafica',
      entita_tipo: 'caricamenti_personale',
      entita_id: praticaId,
      n_attesi: attese,
      n_di_unanagrafica: diUnAnagrafica.length,
      msg:
        `${operazione}: una scansione approvata risulta già di un'anagrafica; la conservazione ` +
        `della pratica cancellerebbe il file che quel fascicolo sta usando`,
    })
  }

  // Si AGISCE solo su ciò che è davvero in sospeso, e con UNA istruzione sola.
  // `collegaCaricamenti` al plurale non è comodità: con una chiamata per faccia lo
  // stesso fallimento parziale uscirebbe in due righe scoordinate, e nessuna delle due
  // direbbe che la pratica è rimasta MEZZA documentata. Là il fatto è un'aritmetica —
  // `n_attesi` e `n_collegati` — e nessun percorso finisce nel registro.
  if (daCollegare.length > 0) {
    await collegaCaricamenti(supabase, daCollegare, praticaId, operazione)
  }
}

/** L'avviso, best-effort: `notificaEvento` non lancia, ma un guasto lascia una riga. */
async function avvisa(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  params: {
    tipo: string
    scuolaId: string
    ruoli: string[]
    titolo: string
    corpo: string
    entitaId: string | null
  },
): Promise<void> {
  try {
    // ⚠️ La sede è la STESSA con cui sono stati scelti i destinatari: `staffScuola`
    // decide CHI riceve, `scuolaId` dice a chi è indirizzato. Con tre plessi, due sedi
    // diverse fra le due righe consegnerebbero l'avviso di un plesso alla scrivania di
    // un altro senza che nessun controllo se ne accorga.
    const destinatari = await staffScuola(supabase, params.scuolaId, params.ruoli)
    await notificaEvento(supabase, {
      tipo: params.tipo,
      scuolaId: params.scuolaId,
      utenteIds: destinatari,
      titolo: params.titolo,
      // ⚠️ NIENTE NOMI nel corpo: una notifica finisce in una push sul telefono di chi
      // la riceve, cioè fuori dall'applicazione e fuori dai suoi permessi.
      corpo: params.corpo,
      link: LINK_COCKPIT,
      entitaTipo: 'pratica_personale',
      entitaId: params.entitaId,
      bufferMin: 0,
    })
  } catch (e) {
    logEvento('notifica', 'error', {
      operazione,
      esito: 'avviso-non-accodato',
      tipo: params.tipo,
      scuola_id: params.scuolaId,
    }, e)
  }
}

/**
 * APPROVA — nove passi, in quest'ordine, e l'ordine è metà del presidio.
 *
 *  1. la pratica è già stata caricata e ristretta alla sede (nel `PATCH`);
 *  2. si risolve l'esistenza dell'account PRIMA del claim: fail-closed;
 *  3. claim atomico `pending → in_approvazione`;
 *  4. identità (`ruolo` cablato, sede QUELLA DELLA PRATICA);
 *  5. il plesso della persona: se non è fra quelli di questa postazione, ci si ferma;
 *  6. se l'utenza è nata adesso, la Direzione lo viene a sapere;
 *  7. il fascicolo (`upsert` su `anagrafica_personale`);
 *  8. il patch STRETTO di `utenti`;
 *  9. la chiusura: la scansione passa al fascicolo e la pratica la rilascia;
 * 10. audit e battito, che dicono CHE COSA è stato fatto, mai i valori.
 */
async function approva(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  riga: PraticaDiLavoro,
): Promise<NextResponse> {
  const operazione = 'admin/pratiche-personale:PATCH'
  const warnings: Avviso[] = []
  const adesso = new Date().toISOString()
  const sedePratica = riga.scuola_id
  const email = testo(riga.email)
  /**
   * IL PLESSO DELLA PERSONA, quando NON coincide con quello della pratica.
   *
   * Resta `null` nel caso normale (coincidono, oppure l'account nasce adesso). Serve
   * all'audit: `entitaTipo: 'pratica_personale'` ha per sede quella della PRATICA, ed è
   * giusto così — ma il fascicolo atterra sulla PERSONA, e una riga d'audit che nomina
   * solo la prima non risponde a «dove è finito il dato?».
   */
  let sedeAccount: string | null = null

  if (!email) {
    // La colonna è NOT NULL in tabella: qui si arriva solo se il degrado su colonna
    // assente l'ha tolta dalla proiezione, cioè su un database non migrato. Senza
    // email non c'è nessuna chiave con cui decidere se aggiornare o creare: si dice,
    // non si indovina — e la pratica non è stata ancora toccata.
    logEvento('personale', 'error', {
      operazione, esito: 'pratica-senza-email', entita_tipo: TABELLA, entita_id: riga.id,
    })
    return nonDisponibile('Questa pratica non ha un indirizzo email: non è possibile approvarla.')
  }

  // ── 2. L'ACCOUNT ESISTE GIÀ? (fail-closed, e PRIMA del claim) ──────────────
  const esistenza = await risolviAccountEsistente(supabase, email)
  if ('response' in esistenza) return esistenza.response

  // ── 3. CLAIM ATOMICO ───────────────────────────────────────────────────────
  // Senza, due clic (o due schede) creano DUE account per la stessa persona. Zero
  // righe ⇒ qualcuno è arrivato prima.
  const claim = await cambiaStato(supabase, operazione, {
    id: riga.id,
    scuole,
    da: ['pending'],
    patch: { stato: 'in_approvazione', aggiornata_il: adesso },
  })
  if (claim.error) {
    logEvento('personale', 'error', {
      operazione, esito: 'claim-non-riuscito', entita_tipo: TABELLA, entita_id: riga.id,
      error_code: codiceDi(claim.error),
    }, claim.error)
    return nonDisponibile('Non è stato possibile prendere in carico la pratica: riprovare fra poco.')
  }
  if (claim.righe.length === 0) {
    logEvento('personale', 'warn', {
      operazione, esito: 'pratica-gia-evasa', azione: 'approva',
      entita_tipo: TABELLA, entita_id: riga.id, stato: riga.stato,
    })
    return giaEvasa()
  }

  const gradi = gradiValidi(riga.gradi)

  // ── 4. L'IDENTITÀ ──────────────────────────────────────────────────────────
  // `seEsisteRiusa: true` perché qui il caso normale è che l'account CI SIA: questo
  // modulo è per le insegnanti già dipendenti, e il `409` del gemello renderebbe la
  // funzione inutilizzabile proprio per il suo scopo. La porta del GENITORE resta
  // chiusa, ed è una decisione che prende una persona, non una route.
  const identita = await ensureStaffIdentity(
    supabase,
    {
      email,
      nome: testo(riga.nome),
      cognome: testo(riga.cognome),
      cellulare: testo(riga.telefono) || null,
      // ⚠️ CABLATO. Non è un campo del modulo e non è una scelta di chi approva.
      ruolo: RUOLO_APPROVATO,
      // ⚠️ LA SEDE È QUELLA DELLA PRATICA, mai `user.scuola_id`: l'unico admin reale
      // ha Giugliano come sede primaria e gestisce tutti e tre i plessi.
      scuolaId: sedePratica,
      gradi,
    },
    { seEsisteRiusa: true },
  )
  if (!identita.ok) {
    await rimettiPending(supabase, { id: riga.id, scuole })
    if (identita.reason === 'email_gia_genitore') {
      return NextResponse.json(
        { error: identita.message, codice: CODICE_EMAIL_GIA_GENITORE },
        { status: 409 },
      )
    }
    if (identita.accountOrfano) {
      logEvento('personale', 'error', {
        operazione,
        esito: 'account-orfano-lasciato',
        entita_tipo: TABELLA,
        entita_id: riga.id,
        utente: identita.authUserIdOrfano ?? null,
        sede_id: sedePratica,
      })
      return NextResponse.json(
        {
          error: identita.message,
          codice: CODICE_OPERAZIONE_NON_RIUSCITA,
          warnings: [avviso('accountOrfano')],
        },
        { status: 503 },
      )
    }
    logEvento('personale', 'error', {
      operazione, esito: 'account-non-creato', entita_tipo: TABELLA, entita_id: riga.id,
    })
    return nonDisponibile(identita.message)
  }

  /**
   * L'UTENZA È NATA ADESSO?
   *
   * `riusato` risponde a «il profilo del personale è nato in questa chiamata?», ed è
   * una domanda diversa da `createdAuth` («è nato l'account di login?»): le due hanno
   * risposte diverse nel caso che capita di più — accesso preesistente e riga `utenti`
   * creata adesso. Dedurlo dal secondo tratterebbe quel caso come «c'era già tutto».
   */
  const utenzaNuova = identita.riusato !== true
  if (identita.riusato) {
    warnings.push(avviso('profiloPreesistente'))
  }

  // ── 5. IL PLESSO DELLA PERSONA ────────────────────────────────────────────
  //
  // Il gate sta QUI e non più avanti perché tutto ciò che segue — la notifica, il
  // fascicolo, il patch, la chiusura — parla di QUELLA riga di `utenti`. Vedi
  // `accountNelloScope` per la misura che ha reso necessaria questa decina di righe.
  if (identita.riusato) {
    const dove = await accountNelloScope(supabase, operazione, {
      utenteId: identita.authUserId,
      scuole,
    })
    if (dove.esito !== 'dentro') {
      // Niente è stato scritto: la pratica torna in attesa e il gesto resta ripetibile
      // da una postazione che quel plesso lo gestisce.
      await rimettiPending(supabase, { id: riga.id, scuole })
      logEvento('multi_sede', 'warn', {
        operazione,
        esito: dove.esito === 'fuori' ? 'account-fuori-sede-non-approvato' : 'scope-account-illeggibile',
        utente: user.id,
        ruolo: user.role,
        entita_tipo: TABELLA,
        entita_id: riga.id,
        sede_id: sedePratica,
        sedi_attive: scuole.length,
      })
      if (dove.esito === 'illeggibile') {
        return nonDisponibile(
          'Non è stato possibile verificare in quale plesso è registrata questa persona: ' +
            'riprovare fra poco. La pratica è tornata in attesa.',
        )
      }
      return NextResponse.json(
        {
          error:
            'Questa email appartiene a un account registrato su una sede che questa postazione non ' +
            'gestisce: l\'anagrafica non è stata scritta e la pratica è tornata in attesa. ' +
            'Va approvata dalla Direzione o da una postazione che gestisce quel plesso.',
          codice: CODICE_ACCOUNT_ALTRA_SEDE,
        },
        { status: 403 },
      )
    }
    // DENTRO, ma non nella sede della pratica: legittimo (l'admin gestisce tre plessi)
    // e da DIRE, perché il fascicolo atterra sulla persona e la persona sta altrove.
    // Senza questa riga l'audit registrerebbe `scuolaId: sedePratica` — vero per la
    // pratica, muto su dove il dato è finito.
    if (dove.sede && dove.sede !== sedePratica) {
      sedeAccount = dove.sede
      const nome = await nomeSede(supabase, dove.sede, operazione)
      warnings.push(avviso('accountAltraSede', nome ? { sede: nome } : undefined))
      logEvento('multi_sede', 'warn', {
        operazione,
        esito: 'account-in-altro-plesso-in-scope',
        utente: user.id,
        ruolo: user.role,
        entita_tipo: 'utenti',
        entita_id: identita.authUserId,
        sede_id: dove.sede,
        sede_dichiarata: sedePratica,
      })
    }
  }

  /**
   * LE FASCE, DETTE PER NOME — e dette SEMPRE, non solo quando mancano.
   *
   * Fino al 2026-08-12 l'unico avviso su questo punto compariva quando le fasce erano
   * VUOTE, e quello che invece succedeva nel caso pieno — la pratica ne dichiarava
   * una e l'approvazione la scriveva sopra a quelle dell'account — non veniva
   * nominato da nessuna parte. Chi premeva leggeva «RUOLO e SEDE sono rimasti quelli
   * che aveva» e ne concludeva, ragionevolmente, che non fosse cambiato nient'altro.
   *
   * Adesso le fasce non si scrivono più su un account che esiste (vedi
   * `COLONNE_UTENTI_AGGIORNABILI`), e questo avviso lo DICE con dentro i nomi: senza
   * i nomi, chi legge non sa se deve andare a correggere qualcosa nel pannello
   * Personale o se può lasciar perdere.
   */
  const nomiGradi = gradi.map((g) => ETICHETTA_GRADO.get(g) ?? g).join(', ')
  if (!utenzaNuova && gradi.length > 0) {
    warnings.push(avviso('fasceNonApplicate', { fasce: nomiGradi }))
  }
  if (gradi.length === 0) {
    warnings.push(avviso(utenzaNuova ? 'fasceAssentiNuovo' : 'fasceAssentiEsistente'))
  }
  // L'account è NUOVO e le fasce non sono finite in tabella (colonna assente sul DB
  // non migrato): `ensureStaffIdentity` lo dichiara, e senza ridirlo qui l'esito
  // sarebbe indistinguibile da «scritte».
  if (utenzaNuova && gradi.length > 0 && identita.gradiScritti === false) {
    warnings.push(avviso('fasceNonRegistrate', { fasce: nomiGradi }))
  }

  // ── 6. LA DIREZIONE VIENE AVVISATA — SOLO se è nato un accesso nuovo ───────
  //
  // «Solo in quel caso» non è una limitazione, è la ragione per cui l'avviso serve a
  // qualcosa: una notifica a ogni approvazione diventa rumore, e un allarme che suona
  // sempre viene spento — e allora il giorno in cui una porta ANONIMA fa nascere un
  // accesso all'anagrafica dei bambini, nessuno se ne accorge. Un accesso nuovo è
  // l'unico fatto che meriti di svegliare qualcuno.
  if (utenzaNuova) {
    const sedeNome = await nomeSede(supabase, sedePratica, operazione)
    await avvisa(supabase, operazione, {
      tipo: 'personale_account_creato',
      scuolaId: sedePratica,
      ruoli: RUOLI_DIREZIONE,
      titolo: 'Nuovo accesso del personale creato',
      corpo:
        `L'approvazione di un'anagrafica del personale ha creato un accesso nuovo` +
        `${sedeNome ? ` su ${sedeNome}` : ''}. Se non era atteso, va verificato subito nel pannello Personale.`,
      entitaId: riga.id,
    })
  }

  // ── 7. IL FASCICOLO ────────────────────────────────────────────────────────
  //
  // DUE FACCE, DUE PERCORSI, DUE DESTINI SEPARATI. Fino al 12/08/2026 il documento
  // d'identità era UNA scansione sola; dalla migrazione `20260812194501` sono il fronte
  // e il retro, e da qui in avanti nessuna riga di questo file li tratta come una cosa
  // sola — il travaso sa degradare una colonna alla volta, quindi possono avere esiti
  // diversi nella stessa approvazione.
  const frontePath = testo(riga.documento_fronte_path) || null
  const retroPath = testo(riga.documento_retro_path) || null
  const fascicolo: Record<string, unknown> = {
    utente_id: identita.authUserId,
    // ⚠️ `origine_pratica_id` NON è un di più. Senza, il fascicolo nasce senza il
    // puntatore al modulo che l'ha generato: `retention-personale` chiuderebbe
    // l'anagrafica a dieci anni lasciando la pratica approvata in tabella, orfana e
    // irraggiungibile, con dentro codice fiscale, nascita, residenza, domicilio,
    // recapiti, estremi del documento e `consents_log`.
    origine_pratica_id: riga.id,
    aggiornata_da: user.id,
    aggiornata_il: adesso,
  }
  for (const col of COLONNE_ANAGRAFICA) {
    // La colonna esiste nella pratica letta? Se il degrado l'ha tolta dalla
    // proiezione, non si scrive `undefined` sopra un valore già archiviato.
    if (col in riga) fascicolo[col] = riga[col]
  }

  const scritto = await scriviFascicolo(supabase, operazione, fascicolo)
  if (scritto.error) {
    // IL FASCICOLO NON C'È, quindi la pratica NON si chiude: si rimette `pending`.
    //
    // È la scelta opposta a quella del gemello sulle candidature, e la ragione è nello
    // schema: una pratica marcata `approvata` che nessuna anagrafica cita è lo stato
    // che `retention-personale` dichiara di non saper trattare («su un'operazione
    // irreversibile "non so" vale "non toccare"»), e resterebbe in tabella per sempre
    // con dentro il codice fiscale di una persona. Rimettendola `pending`, il gesto è
    // ripetibile: `ensureStaffIdentity` riuserà l'account appena creato e non
    // produrrà un secondo accesso.
    logEvento('personale', 'error', {
      operazione,
      esito: 'fascicolo-non-scritto',
      entita_tipo: TABELLA_ANAGRAFICA,
      entita_id: riga.id,
      utente: identita.authUserId,
      error_code: codiceDi(scritto.error),
    }, scritto.error)
    await rimettiPending(supabase, { id: riga.id, scuole })
    return NextResponse.json(
      {
        error: 'L\'anagrafica non è stata registrata: la pratica è tornata in attesa e si può riprovare.',
        codice: CODICE_OPERAZIONE_NON_RIUSCITA,
        warnings: utenzaNuova ? [avviso('accountCreatoLoStesso')] : [],
      },
      { status: 503 },
    )
  }
  if (scritto.colonneCadute.length > 0) {
    warnings.push(avviso('fascicoloParziale', { colonne: scritto.colonneCadute.join(', ') }))
  }

  // ── 8. IL PATCH STRETTO DI `utenti` ────────────────────────────────────────
  //
  // TRE colonne, filtrate attraverso `COLONNE_UTENTI_AGGIORNABILI`: `ruolo`,
  // `scuola_id`, `email`, `attivo` e `gradi` non sono scrivibili da qui per
  // COSTRUZIONE. Le tre che restano sono anagrafica — come ti chiami, che numero hai
  // — e non danno accesso a niente che non fosse già accessibile.
  //
  // `gradi` è uscito da qui il 2026-08-12, e il perché sta per esteso su
  // `COLONNE_UTENTI_AGGIORNABILI`: le fasce non sono una preferenza d'interfaccia, e
  // un modulo pubblico non le cambia a chi un account ce l'ha già. Restano scritte
  // dove nascono, cioè nell'INSERT di `ensureStaffIdentity` al punto 4.
  const patchUtente: Record<string, unknown> = {}
  const proposta: Record<string, unknown> = {
    nome: testo(riga.nome),
    cognome: testo(riga.cognome),
    cellulare: testo(riga.telefono) || null,
  }
  for (const [col, valore] of Object.entries(proposta)) {
    if (COLONNE_UTENTI_AGGIORNABILI.has(col)) patchUtente[col] = valore
  }

  const anagraficaUtente = await aggiornaUtente(supabase, operazione, {
    utenteId: identita.authUserId,
    scuole,
    patch: patchUtente,
  })
  if (anagraficaUtente.errore) {
    // L'UPDATE NON È PASSATO. Non si torna un errore HTTP — l'anagrafica è stata
    // registrata e la pratica va chiusa lo stesso, altrimenti si riparte da capo su
    // una persona che il fascicolo ce l'ha già — ma «fatto» non si può dire: chi ha
    // premuto deve sapere che su `utenti` è rimasto tutto com'era, o andrà avanti
    // convinto che il cellulare nuovo sia in tabella.
    warnings.push(avviso('accountNonAggiornato'))
  } else if (anagraficaUtente.fuoriScope) {
    // La persona è agganciata a un plesso che questa Segreteria non gestisce. Il gate
    // del punto 5 lo avrebbe già negato: qui ci si arriva solo se qualcuno l'ha
    // spostata FRA la verifica e questa istruzione. Il ramo resta — la sede
    // nell'istruzione che scrive è l'ultima linea, e non si toglie perché ne è nata una
    // prima.
    logEvento('multi_sede', 'warn', {
      operazione,
      esito: 'utente-fuori-sede-non-aggiornato',
      utente: user.id,
      ruolo: user.role,
      sede_id: sedePratica,
      sedi_attive: scuole.length,
      entita_tipo: 'utenti',
      entita_id: identita.authUserId,
    })
    warnings.push(avviso('accountAltroPlesso'))
  } else if (anagraficaUtente.colonneCadute.length > 0) {
    warnings.push(avviso('accountColonneCadute', { colonne: anagraficaUtente.colonneCadute.join(', ') }))
  }

  // ── 9. LA CHIUSURA — e le scansioni cambiano proprietario ─────────────────
  //
  // ⚠️ I FILE NON SI COPIANO. `anagrafica_personale.documento_fronte_path` e
  // `…_retro_path` puntano agli STESSI due oggetti, e la pratica li rilascia mettendo a
  // NULL le proprie colonne: «un oggetto, un proprietario», che è il contratto della
  // migrazione `20260811205643` — esteso alla seconda faccia da `20260812194501` — ed è
  // ciò che impedisce alla conservazione della PRATICA di cancellare i file che il
  // FASCICOLO sta usando. Lasciandovi una copia dei percorsi, quella riga se li
  // porterebbe per dieci anni mentre `/privacy` promette dodici mesi per la copia del
  // documento d'identità: si sforerebbe proprio il termine con la base giuridica più
  // fragile.
  //
  // ⚠️ E IL RILASCIO È PER FACCIA, INDIPENDENTE. Con una scansione sola bastava un
  // booleano; con due no, e non è una raffinatezza: `scriviFascicolo` degrada UNA
  // colonna alla volta (`colonneCadute`), quindi su un database a cui manchi solo
  // `documento_retro_path` il fronte passa e il retro NO. Azzerarle insieme
  // cancellerebbe dalla pratica l'unico riferimento al file non passato — che nessuna
  // altra riga nomina — e quell'oggetto resterebbe nel bucket per sempre: invisibile
  // alla conservazione e non cancellabile nemmeno su richiesta dell'interessata. Ogni
  // faccia risponde per sé.
  //
  // `colonna in fascicolo` risponde alla prima delle tre domande: «al travaso è stata
  // CHIESTA questa colonna?». `colonneCadute` risponde soltanto a «gliel'hanno tolta»,
  // e una colonna mai chiesta non cade mai: il giorno in cui `COLONNE_ANAGRAFICA`
  // smettesse di nominarne una, il solo `colonneCadute` direbbe «passata» su un
  // percorso che il fascicolo non ha mai visto.
  //
  // ⚠️ MA OGGI QUEL TERMINE È IMPLICATO DAGLI ALTRI DUE, e va detto invece di lasciar
  // credere che sia lui a tenere la linea. Misurato il 12/08/2026, non dedotto:
  //   · togliendolo, i 5 file del perimetro restano verdi 107/107 — nessun input di
  //     questa rotta lo fa scattare, perché `percorso` si legge dalla STESSA `riga` da
  //     cui il fascicolo si riempie e la proiezione (`COLONNE_LAVORO`) discende dallo
  //     stesso `CAMPI_TEMPLATE` di `COLONNE_ANAGRAFICA`: una colonna assente da questa
  //     è assente anche da quella, quindi `percorso` è già `null`;
  //   · rompendo invece la PREMESSA — `CAMPI_DI_UTENTI` allargato a
  //     `documento_retro_path`, cioè `COLONNE_ANAGRAFICA` che smette di nominarla
  //     mentre la proiezione continua a leggerla — vanno in rosso 8 test di questo
  //     file. È lo scenario che il termine difende, ed è già inchiodato.
  //
  // Resta scritto, e non è codice morto per finta: è la rete per il giorno in cui la
  // proiezione smettesse di derivare dal template (un `select('*')`, un elenco scritto
  // a mano). Costa un `in`, e la direzione in cui sbaglia è non rilasciare — che su una
  // carta d'identità è l'unica parte giusta in cui sbagliare.
  const passata = (colonna: string, percorso: string | null) =>
    percorso !== null && colonna in fascicolo && !scritto.colonneCadute.includes(colonna)
  const frontePassato = passata('documento_fronte_path', frontePath)
  const retroPassato = passata('documento_retro_path', retroPath)

  const chiusura = await cambiaStato(supabase, operazione, {
    id: riga.id,
    scuole,
    da: ['in_approvazione'],
    patch: {
      stato: 'approvata',
      evasa_il: adesso,
      evasa_da: user.id,
      utente_id: identita.authUserId,
      aggiornata_il: adesso,
      ...(frontePassato ? { documento_fronte_path: null } : {}),
      ...(retroPassato ? { documento_retro_path: null } : {}),
    },
  })
  const chiusuraRiuscita = !chiusura.error && chiusura.righe.length > 0
  /**
   * …E LA CHIUSURA NON È UNA COSA SOLA. `chiusuraRiuscita` risponde a «la riga è
   * passata ad `approvata`?»; questo a «la riga è LEGATA all'account?». Il degrado su
   * colonna assente può togliere `utente_id` dal patch: l'UPDATE passa lo stesso (solo
   * `stato` è protetto) e una misura sola direbbe di sì a entrambe le domande mentre
   * la seconda risposta è no.
   */
  const utenteIdScritto = chiusuraRiuscita && !chiusura.colonneCadute.includes('utente_id')
  /**
   * LA PRATICA HA DAVVERO RILASCIATO LE SCANSIONI? — tre condizioni per faccia.
   *
   * `frontePassato`/`retroPassato` rispondono solo a «il fascicolo l'ha presa»; il
   * rilascio è l'altra metà, e vive nell'UPDATE qui sopra. Se la chiusura non è passata,
   * o se il degrado ha tolto QUELLA colonna dal patch, la pratica il percorso ce l'ha
   * ANCORA — e affermare il contrario è lo stesso difetto già chiuso per
   * `campi_aggiornati`: un registro che dichiara una scrittura mai avvenuta manda a
   * cercare, fra un anno, la causa di una modifica che nessuno ha fatto.
   *
   * Esce anche nella RISPOSTA, e non solo nel log: è il pannello a doverlo sapere.
   * Dopo un'approvazione riuscita il pulsante che apre quella faccia punta a un percorso
   * che nessuna pratica nomina più, e riproporlo significa servire un 403 di SEDE su
   * una pratica appena approvata dalla persona che sta guardando — un diniego travestito
   * da guasto di permessi, esattamente ciò che il commento a `assertDocumentoInScope`
   * dice di voler evitare — più una riga `documento-non-risolto` in `multi_sede` a ogni
   * clic: il registro di sorveglianza degli accessi alle scansioni si riempirebbe di
   * falsi positivi generati dal percorso NORMALE.
   *
   * ⚠️ DUE BOOLEANI, NON UNO. Il pannello deve poter nascondere il fronte e tenere il
   * retro: nel degrado parziale quel secondo pulsante è l'unica strada rimasta verso
   * l'unica copia raggiungibile di una faccia del documento.
   */
  const rilasciata = (colonna: string, passato: boolean) =>
    passato && chiusuraRiuscita && !chiusura.colonneCadute.includes(colonna)
  const documentiRilasciati = {
    fronte: rilasciata('documento_fronte_path', frontePassato),
    retro: rilasciata('documento_retro_path', retroPassato),
  }
  if (chiusura.colonneCadute.length > 0) {
    // DUE codici e non uno con la coda appiccicata: «manca una colonna» e «la pratica
    // non è legata all'account» sono due gravità diverse, e concatenarle in una frase
    // sola le rendeva traducibili solo insieme.
    warnings.push(
      avviso(utenteIdScritto ? 'chiusuraParziale' : 'chiusuraParzialeNonLegata', {
        colonne: chiusura.colonneCadute.join(', '),
      }),
    )
  }
  if (!chiusuraRiuscita) {
    logEvento('personale', 'error', {
      operazione,
      esito: 'approvazione-non-marcata',
      entita_tipo: TABELLA,
      entita_id: riga.id,
      utente: identita.authUserId,
      error_code: codiceDi(chiusura.error),
    }, chiusura.error ?? undefined)
    warnings.push(avviso('approvazioneNonMarcata'))
  }

  // Le scansioni hanno ancora un proprietario nel registro dei caricamenti?
  //
  // Si guardano SOLO le facce che il fascicolo ha davvero preso: quelle rimaste alla
  // pratica hanno ancora lei come proprietaria nel registro, ed è giusto così — non c'è
  // niente da riparare, e chiederselo produrrebbe un allarme su uno stato sano.
  await assicuraCaricamentiCollegati(
    supabase,
    operazione,
    [frontePassato ? frontePath : null, retroPassato ? retroPath : null].filter(
      (p): p is string => p !== null,
    ),
    riga.id,
  )

  // ── 10. L'AUDIT ─────────────────────────────────────────────────────────────
  //
  // Dice CHE COSA è stato fatto, non è una copia della pratica: niente email, niente
  // nome, niente codice fiscale, niente percorsi. `campi_aggiornati` sono i NOMI delle
  // colonne toccate su `utenti`, che è l'unica informazione con cui, fra un anno, si
  // può rispondere a «chi ha cambiato il cellulare di questa maestra?».
  //
  // ⚠️ TOCCATE DAVVERO. `campi_aggiornati` si svuota su TUTTI E TRE i modi in cui la
  // scrittura può non essere avvenuta — fuori scope, UPDATE fallito, colonne cadute —
  // e non solo sul primo, che era il caso trattato fino al 2026-08-12. La risposta
  // sbagliata a quella domanda è peggio di nessuna risposta: manda a cercare la causa
  // di una modifica che non è mai stata scritta.
  const campiScrittiSuUtenti =
    anagraficaUtente.errore || anagraficaUtente.fuoriScope
      ? []
      : Object.keys(patchUtente).filter((c) => !anagraficaUtente.colonneCadute.includes(c))
  await logScrittura(supabase, {
    attore: user,
    entitaTipo: 'pratica_personale',
    entitaId: riga.id,
    azione: 'update',
    scuolaId: sedePratica,
    valoreDopo: {
      stato: chiusuraRiuscita ? 'approvata' : 'in_approvazione',
      chiusura_riuscita: chiusuraRiuscita,
      utente_id: utenteIdScritto ? identita.authUserId : null,
      account_uid: identita.authUserId,
      account_creato: utenzaNuova,
      campi_aggiornati: campiScrittiSuUtenti,
      account_non_aggiornato: anagraficaUtente.errore,
      // UNA VOCE PER FACCIA, e non un solo `documento_rilasciato` messo in AND: un
      // registro che dicesse «no» su un'approvazione in cui il fronte è passato manda a
      // cercare un file che sta esattamente dove deve stare, e — peggio — nasconde
      // quale delle due facce sia rimasta indietro, che è l'unica cosa da sapere per
      // rimediare.
      documento_fronte_rilasciato: documentiRilasciati.fronte,
      documento_retro_rilasciato: documentiRilasciati.retro,
      // DOVE È FINITO IL FASCICOLO, quando non è dove sta la pratica. `scuolaId` qui
      // sopra è la sede della PRATICA — giusto, perché l'entità dell'audit è la pratica
      // — ma l'`upsert` atterra sulla PERSONA, e finché questo campo non c'era il
      // registro non aveva modo di dire che le due sedi erano diverse. `null` nel caso
      // normale: un campo sempre valorizzato smette di farsi notare.
      sede_account: sedeAccount,
    },
  })

  // Evento critico → si logga anche il SUCCESSO: senza, «nessun log» non
  // distinguerebbe «non si approva nessuno» da «l'approvazione non parte più».
  //
  // Due esiti DIVERSI, e non un campo in più su uno solo: `pratica-approvata` è il
  // conteggio delle approvazioni VERE, e una riga emessa su una chiusura fallita lo
  // gonfierebbe proprio quando il sistema sta sbagliando.
  const battito = {
    operazione,
    entita_tipo: TABELLA,
    entita_id: riga.id,
    sede_id: sedePratica,
    utente: identita.authUserId,
    account_creato: utenzaNuova,
    account_preesistente: esistenza.account !== null,
    // L'account stava in un plesso DIVERSO da quello della pratica (e dentro lo scope):
    // è la query con cui, fra mesi, si vede quante approvazioni hanno travasato un
    // fascicolo fuori dalla sede che l'ha ricevuto.
    account_in_altro_plesso: sedeAccount !== null,
    n_gradi: gradi.length,
    // Le fasce DICHIARATE e non applicate perché l'account esisteva già: si conta,
    // non si nomina nessuno. È la query con cui, fra mesi, si vede quante persone
    // hanno spuntato sul modulo pubblico una fascia che non hanno — cioè se il campo
    // sul modulo sta davvero servendo a qualcosa o sta solo confondendo.
    gradi_non_applicati: !utenzaNuova && gradi.length > 0,
    // L'UPDATE su `utenti` è fallito? Senza questo campo, «nessun log» non
    // distinguerebbe «non succede mai» da «non passa più».
    account_non_aggiornato: anagraficaUtente.errore,
    n_colonne_cadute: scritto.colonneCadute.length,
    chiusura_riuscita: chiusuraRiuscita,
    utente_id_scritto: utenteIdScritto,
    documento_fronte_rilasciato: documentiRilasciati.fronte,
    documento_retro_rilasciato: documentiRilasciati.retro,
    // La query che, fra mesi, dice quante pratiche hanno travasato una faccia sola:
    // è lo stato in cui un oggetto rischia di restare senza nessuna riga che lo nomini.
    documento_rilasciato_a_meta: documentiRilasciati.fronte !== documentiRilasciati.retro,
  }
  if (chiusuraRiuscita) {
    logEvento('personale', 'info', { ...battito, esito: 'pratica-approvata' })
  } else {
    logEvento('personale', 'warn', { ...battito, esito: 'pratica-approvata-non-marcata' })
  }

  return NextResponse.json({
    success: true,
    id: riga.id,
    stato: chiusuraRiuscita ? 'approvata' : 'in_approvazione',
    accountCreato: utenzaNuova,
    // Le scansioni passate al fascicolo, faccia per faccia: la pratica non le nomina
    // più, e il pannello deve smettere di offrire QUEL pulsante — da adesso risponde
    // 403. Un booleano solo per tutte e due avrebbe nascosto anche il pulsante della
    // faccia rimasta alla pratica, cioè l'unica strada verso l'unica copia
    // raggiungibile di quel file.
    documentiRilasciati,
    // La password si vede UNA volta sola, qui. Non è archiviata da nessuna parte: per
    // riaverla c'è «Rigenera credenziali», che la sostituisce e lascia traccia.
    credentials: identita.createdAuth && identita.password ? { email, password: identita.password } : null,
    warnings,
  })
}

/**
 * Il patch di `utenti`, con la SEDE NELL'ISTRUZIONE CHE SCRIVE.
 *
 * `.in('scuola_id', scuole)` non è una cintura in più: è l'unico posto in cui il
 * presidio è vero. Un gate «da qualche parte nell'handler» si può spostare, duplicare
 * o dimenticare in un ramo; la clausola no. Zero righe toccate significa che quella
 * persona è agganciata a un plesso che questa postazione non gestisce — non è un
 * errore, è un fatto che il chiamante deve poter dire a schermo.
 *
 * TRE ESITI, NON DUE, e il terzo mancava fino al 2026-08-12.
 *  · `fuoriScope`     — l'UPDATE è passato e non ha toccato nessuna riga;
 *  · `colonneCadute`  — è passato, ma con meno colonne di quante gliene erano state
 *                       date (DB non migrato);
 *  · `errore`         — NON è passato affatto.
 *
 * Prima, il ramo dell'errore tornava `{ fuoriScope: false, colonneCadute: [] }`, cioè
 * ESATTAMENTE la forma del successo pieno: il chiamante non aveva modo di distinguerli
 * e l'audit registrava `campi_aggiornati: ['nome','cognome','cellulare']` mentre in
 * tabella non era cambiato niente. Un registro che AFFERMA una scrittura mai avvenuta
 * è peggio di un registro vuoto — manda a cercare, fra un anno, la causa di una
 * modifica che nessuno ha fatto — e chi aveva premuto «Approva» leggeva «fatto» senza
 * nessun avviso. Il degrado su colonna assente ha `colonneCadute` proprio per non
 * confondere «scritto tutto» con «scritto in parte»: al fallimento secco mancava lo
 * stesso trattamento.
 */
async function aggiornaUtente(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  args: { utenteId: string; scuole: string[]; patch: Record<string, unknown> },
): Promise<{ fuoriScope: boolean; colonneCadute: string[]; errore: boolean }> {
  const record = { ...args.patch }
  const colonneCadute: string[] = []
  if (Object.keys(record).length === 0) return { fuoriScope: false, colonneCadute, errore: false }

  const scrivi = () =>
    supabase
      .from('utenti')
      .update(record)
      .eq('id', args.utenteId)
      .in('scuola_id', args.scuole)
      .select('id')
  let esito = await scrivi()
  let tentativi = 0
  while (esito.error && COLONNA_ASSENTE.has(codiceDi(esito.error) ?? '') && tentativi < 6) {
    const col = colonnaMancante(esito.error.message ?? '')
    if (!col || !(col in record)) break
    logEvento('personale', 'warn', {
      operazione,
      esito: 'colonna-assente-rimossa',
      entita_tipo: 'utenti',
      error_code: codiceDi(esito.error),
      msg: `colonna assente, rimossa dall'aggiornamento dell'account: ${col}`,
    })
    delete record[col]
    colonneCadute.push(col)
    // Tutte le colonne sono cadute: non è rimasto niente da scrivere, e non è un
    // errore — è un patch svuotato dal degrado. `errore: false`, `campi_aggiornati`
    // lo dirà comunque con `colonneCadute`.
    if (Object.keys(record).length === 0) return { fuoriScope: false, colonneCadute, errore: false }
    esito = await scrivi()
    tentativi++
  }
  if (esito.error) {
    logEvento('personale', 'error', {
      operazione,
      esito: 'account-non-aggiornato',
      entita_tipo: 'utenti',
      entita_id: args.utenteId,
      error_code: codiceDi(esito.error),
    }, esito.error)
    // `errore: true` — e il chiamante NON deve poter confondere questo ritorno con
    // quello del successo: è la ragione per cui il campo esiste.
    return { fuoriScope: false, colonneCadute, errore: true }
  }
  const toccate = Array.isArray(esito.data) ? esito.data.length : 0
  return { fuoriScope: toccate === 0, colonneCadute, errore: false }
}

/** RIFIUTA: nessuna scrittura su `utenti`, e il motivo resta una nota interna. */
async function rifiuta(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  riga: PraticaDiLavoro,
  motivo: string | null,
): Promise<NextResponse> {
  const operazione = 'admin/pratiche-personale:PATCH'
  const warnings: Avviso[] = []
  const adesso = new Date().toISOString()

  // Si rifiuta ciò che è ancora in gioco: `pending` oppure `in_approvazione` (una presa
  // in carico rimasta appesa). Zero righe ⇒ ha già deciso qualcun altro.
  const esito = await cambiaStato(supabase, operazione, {
    id: riga.id,
    scuole,
    da: ['pending', 'in_approvazione'],
    patch: {
      stato: 'rifiutata',
      evasa_il: adesso,
      evasa_da: user.id,
      motivo_rifiuto: motivo,
      aggiornata_il: adesso,
    },
  })
  if (esito.error) {
    logEvento('personale', 'error', {
      operazione, esito: 'rifiuto-non-registrato', entita_tipo: TABELLA, entita_id: riga.id,
      error_code: codiceDi(esito.error),
    }, esito.error)
    return nonDisponibile('Non è stato possibile registrare il rifiuto: riprovare fra poco.')
  }
  if (esito.righe.length === 0) {
    logEvento('personale', 'warn', {
      operazione, esito: 'pratica-gia-evasa', azione: 'rifiuta',
      entita_tipo: TABELLA, entita_id: riga.id, stato: riga.stato,
    })
    return giaEvasa()
  }
  if (esito.colonneCadute.length > 0) {
    warnings.push(avviso('rifiutoParziale', { colonne: esito.colonneCadute.join(', ') }))
  }

  await logScrittura(supabase, {
    attore: user,
    entitaTipo: 'pratica_personale',
    entitaId: riga.id,
    azione: 'update',
    scuolaId: riga.scuola_id,
    // Il TESTO del motivo non entra nell'audit: è una nota interna su una persona, e
    // l'audit deve dire che cosa è successo, non conservarne il giudizio.
    //
    // `motivo_presente` parla della RIGA, non dell'intenzione di chi ha premuto: se
    // `motivo_rifiuto` è caduta dal degrado, la nota non è stata scritta da nessuna
    // parte e dichiararla presente manderebbe qualcuno, fra mesi, a cercare in tabella
    // un testo che non c'è.
    valoreDopo: {
      stato: 'rifiutata',
      motivo_presente: Boolean(motivo) && !esito.colonneCadute.includes('motivo_rifiuto'),
    },
  })

  // Nessuna email di esito, ed è una scelta e non una dimenticanza: chi ha compilato
  // questo modulo LAVORA qui, e la Segreteria che rifiuta la pratica la incontra il
  // giorno dopo. Una mail automatica di rifiuto a una collega — senza motivazione,
  // perché il motivo è una nota interna — direbbe meno di niente e la allarmerebbe.
  logEvento('personale', 'info', {
    operazione,
    esito: 'pratica-rifiutata',
    entita_tipo: TABELLA,
    entita_id: riga.id,
    sede_id: riga.scuola_id,
    motivo_presente: Boolean(motivo),
  })

  return NextResponse.json({ success: true, id: riga.id, stato: 'rifiutata', warnings })
}

/**
 * SPOSTA-SEDE — il rimedio all'errore che il modulo pubblico rende inevitabile.
 *
 * ── PERCHÉ ESISTE ────────────────────────────────────────────────────────────
 * `/anagrafica-personale` chiede la sede in una schermata di card, e chi compila è una
 * maestra che sta guardando il telefono: sbagliare card è il caso normale, non l'abuso.
 * Da quel momento la pratica la vede SOLO la Segreteria del plesso sbagliato —
 * l'isolamento fra sedi, che qui lavora contro di noi — e quella giusta la aspetta
 * credendo che non sia mai arrivata. Senza questa azione l'unico rimedio sarebbe
 * rifiutarla e far ricompilare tutto: 32 campi e una nuova fotografia del documento.
 *
 * ── LE TRE REGOLE ────────────────────────────────────────────────────────────
 *  · GATE SULLA SEDE DI PARTENZA: si sposta solo ciò che si vede. La pratica è già
 *    stata caricata con `.in('scuola_id', scuole)`, e l'UPDATE ripete la clausola.
 *  · SOLO DA `pending`: una pratica già approvata ha generato un fascicolo e un
 *    account su QUELLA sede; spostarla dopo cambierebbe la sede della pratica e non
 *    quella della persona, cioè creerebbe la divergenza che si voleva chiudere.
 *  · LA DESTINAZIONE DEVE ESSERE UNA SEDE VERA e non la sede fittizia della CI
 *    (`sediReali` la esclude). NON deve invece essere una sede di questa postazione:
 *    proprio il caso che rende utile l'azione — una segreteria di un plesso solo che
 *    passa la pratica al plesso giusto — sarebbe l'unico impossibile.
 */
async function spostaSede(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  riga: PraticaDiLavoro,
  destinazione: string,
): Promise<NextResponse> {
  const operazione = 'admin/pratiche-personale:PATCH'
  const partenza = riga.scuola_id

  if (destinazione === partenza) {
    // Non è un errore e non si scrive niente: dirlo con un 400 manderebbe l'operatore
    // a cercare che cosa ha sbagliato in un gesto che semplicemente non serviva.
    logEvento('personale', 'info', {
      operazione, esito: 'sposta-sede-stessa-sede', entita_tipo: TABELLA, entita_id: riga.id,
      sede_id: partenza,
    })
    return NextResponse.json({ success: true, id: riga.id, spostata: false, scuola_id: partenza })
  }

  if (riga.stato !== 'pending') {
    logEvento('personale', 'warn', {
      operazione, esito: 'sposta-sede-stato-non-ammesso', entita_tipo: TABELLA, entita_id: riga.id,
      stato: riga.stato,
    })
    return NextResponse.json(
      {
        error: 'Solo una pratica ancora in attesa si può spostare di sede: questa è già stata valutata.',
        codice: CODICE_GIA_EVASA,
      },
      { status: 409 },
    )
  }

  const { reali, error: erroreSedi } = await sediReali(supabase, operazione)
  if (erroreSedi) {
    // Fail-CLOSED: senza l'elenco delle sedi non si sa dove si sta mandando una pratica
    // con dentro un codice fiscale e la fotografia di un documento d'identità.
    logEvento('personale', 'error', {
      operazione, esito: 'sedi-non-lette', entita_tipo: TABELLA, entita_id: riga.id,
    }, erroreSedi)
    return nonDisponibile('L\'elenco delle sedi non è leggibile in questo momento: riprovare fra poco.')
  }
  if (!reali.some((s) => s.id === destinazione)) {
    logEvento('multi_sede', 'warn', {
      operazione, esito: 'sposta-sede-destinazione-non-ammessa', entita_tipo: TABELLA,
      entita_id: riga.id, utente: user.id, ruolo: user.role, sede_id: destinazione,
    })
    return NextResponse.json(
      {
        error: 'La sede indicata non è una sede della cooperativa: la pratica non è stata spostata.',
        codice: CODICE_SEDE_NON_AMMESSA,
      },
      { status: 400 },
    )
  }

  const esito = await cambiaStato(supabase, operazione, {
    id: riga.id,
    scuole,
    da: ['pending'],
    patch: { scuola_id: destinazione, aggiornata_il: new Date().toISOString() },
  })
  if (esito.error) {
    logEvento('personale', 'error', {
      operazione, esito: 'sposta-sede-non-riuscito', entita_tipo: TABELLA, entita_id: riga.id,
      error_code: codiceDi(esito.error),
    }, esito.error)
    return nonDisponibile('Non è stato possibile spostare la pratica: riprovare fra poco.')
  }
  if (esito.righe.length === 0) {
    logEvento('personale', 'warn', {
      operazione, esito: 'pratica-gia-evasa', azione: 'sposta-sede',
      entita_tipo: TABELLA, entita_id: riga.id, stato: riga.stato,
    })
    return giaEvasa()
  }

  await logScrittura(supabase, {
    attore: user,
    entitaTipo: 'pratica_personale',
    entitaId: riga.id,
    azione: 'update',
    // La sede dell'audit è quella di PARTENZA: la riga registra chi ha spostato una
    // pratica FUORI dal proprio plesso, ed è la domanda a cui questo registro deve
    // saper rispondere. Le due sedi stanno per esteso nel diff.
    scuolaId: partenza,
    valorePrima: { scuola_id: partenza },
    valoreDopo: { scuola_id: destinazione },
  })

  // La Segreteria di DESTINAZIONE deve saperlo: per lei è una pratica che compare, e
  // senza avviso resterebbe in elenco senza che nessuno l'abbia annunciata. Si riusa il
  // tipo `pratica_personale_ricevuta` di proposito — una scuola che ha spento quegli
  // avvisi non deve riceverne uno dalla porta di servizio.
  await avvisa(supabase, operazione, {
    tipo: 'pratica_personale_ricevuta',
    scuolaId: destinazione,
    ruoli: RUOLI_SEGRETERIA,
    titolo: 'Un\'anagrafica del personale è stata spostata su questa sede',
    corpo:
      'Una pratica arrivata su un\'altra sede è stata riassegnata a questa: va verificata e ' +
      'approvata prima di diventare una scheda vera.',
    entitaId: riga.id,
  })

  // `multi_sede` è persistito: uno spostamento fra plessi è esattamente il gesto che,
  // fra sei mesi, qualcuno vorrà poter ricostruire in SQL.
  logEvento('multi_sede', 'info', {
    operazione,
    esito: 'pratica-spostata',
    azione: 'sposta-sede',
    utente: user.id,
    ruolo: user.role,
    entita_tipo: TABELLA,
    entita_id: riga.id,
    sede_id: destinazione,
    sedi_attive: scuole.length,
  })

  return NextResponse.json({
    success: true,
    id: riga.id,
    spostata: true,
    scuola_id: destinazione,
    warnings: esito.colonneCadute.length > 0
      ? [avviso('spostamentoParziale', { colonne: esito.colonneCadute.join(', ') })]
      : [],
  })
}
