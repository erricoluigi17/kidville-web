import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, formaConfronto } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { sendEmailDetailed } from '@/lib/email/send'
import { risolviContestoSede } from '@/lib/email/contesto'
import { messaggioEsitoCandidatura } from '@/lib/email/messaggi/esito-candidatura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { BUCKET_CURRICULUM } from '@/lib/candidature/percorso-cv'
import { LIMITE_ISCRIZIONI_DEFAULT, LIMITE_ISCRIZIONI_MAX } from '@/lib/api/paginazione'

// =============================================================================
// IL COCKPIT DELLE CANDIDATURE INSEGNANTI — lato segreteria di `/lavora-con-noi`.
//
// `GET`   elenco · dettaglio (`?id=`) · curriculum (`?doc=`)  → staff, segreteria compresa
// `PATCH` approva | rifiuta                                    → Direzione soltanto
//
// La segreteria smista la posta e deve vedere chi si è candidato; approvare, però,
// può CREARE UN ACCOUNT DOCENTE — e un account docente legge l'anagrafica dei
// bambini. È la stessa linea che `admin/staff:PATCH` e `regenerate-credentials`
// tracciano già per le credenziali del personale, e qui si tiene identica.
//
// ⚠️ «PUÒ», dal 2026-08-15, e prima era «CREA». Il modulo pubblico non raccoglie
// più soltanto insegnanti: da quel giorno si candidano anche collaboratrici
// scolastiche, cucina, segreteria e un «altro» scritto a mano. L'account nasce
// SOLO se fra le posizioni ce n'è almeno una da insegnante; per tutte le altre la
// candidatura si chiude come `approvata` senza account e senza credenziali (vedi
// `approvaSenzaAccount`, che spiega anche perché non passa dal claim in due
// tempi). La risposta lo DICE, con `esitoAccount`: `creato` · `riusato` ·
// `nessuno`.
// =============================================================================

/** La tabella, in un posto solo: il nome compare in sei query. */
const TABELLA = 'candidature_insegnanti'
/** Le righe di sede: una per plesso a cui la candidatura è rivolta. */
const TABELLA_SEDI = 'candidature_sedi'

/**
 * Il bucket dove il modulo pubblico deposita il curriculum (nessun bucket nuovo).
 *
 * ⚠️ SI IMPORTA, non si ribatte. Fino al 2026-08-15 questo file scriveva
 * `'form_attachments'` a mano e il cron di conservazione lo chiamava
 * `BUCKET_ALLEGATI`: due nomi per lo stesso archivio, in due file dove uno FIRMA
 * ciò che l'altro CANCELLA. Adesso lo dichiara `@/lib/candidature/percorso-cv`,
 * insieme alla forma del percorso e al prefisso.
 */
const BUCKET_CV = BUCKET_CURRICULUM

/* ── I codici d'errore, letterali e in cima ───────────────────────────────────
 * Ogni risposta d'errore ne porta uno: il client traduce il codice, e chi lavora
 * con l'interfaccia in inglese non si ritrova la prosa italiana del server.
 * Sono i codici già dichiarati in `src/lib/ui/esito-fetch.ts` per le candidature. */
const CODICE_NON_TROVATA = 'CANDIDATURA_NON_TROVATA'
/**
 * IL GUASTO DEL COCKPIT — e non è `CANDIDATURE_NON_DISPONIBILI`.
 *
 * Quel codice è della PORTA PUBBLICA (`iscrizione/insegnanti`), e la frase che il
 * client mostra è, testualmente: «In questo momento non possiamo ricevere
 * candidature. Riprova più avanti, oppure scrivi alla segreteria della scuola» —
 * scritta per chi si candida, con dentro un consiglio che, mostrato qui, la
 * segreteria darebbe a sé stessa. Peggio: la sua documentazione dichiara che il
 * modulo è chiuso dalla Scuola e che riprovare non serve a niente, mentre in
 * questi rami riprovare è ESATTAMENTE ciò che serve.
 *
 * Qui il fatto è un altro: la lettura o la scrittura del cockpit non è riuscita.
 */
const CODICE_OPERAZIONE_NON_RIUSCITA = 'CANDIDATURE_OPERAZIONE_NON_RIUSCITA'
const CODICE_GIA_EVASA = 'CANDIDATURA_GIA_EVASA'
// ⚠️ `CANDIDATURA_EMAIL_GIA_STAFF` e `CANDIDATURA_EMAIL_GIA_GENITORE` non si
// dichiarano più qui: erano i due 409 di `ensureStaffIdentity`, e questa route non
// crea più nessun account (vedi `approva`). I codici restano nel catalogo del
// client — `src/lib/ui/esito-fetch.ts` — perché li produce ancora
// `admin/pratiche-personale:PATCH`, che è il posto dove un accesso nasce davvero.

/**
 * UN SOLO messaggio per «non esiste» e per «è di un'altra sede».
 *
 * Distinguerli direbbe a chi non ha titolo di vederla che quella candidatura c'è
 * — e da lì escono il recapito e il curriculum di una persona che quasi sempre
 * sta lavorando altrove. La differenza vive nel log, dove la legge solo chi ha
 * accesso ai log.
 */
const NON_TROVATA = 'Candidatura non accessibile: non esiste, oppure appartiene a un\'altra sede.'
const nonTrovata = () => NextResponse.json({ error: NON_TROVATA, codice: CODICE_NON_TROVATA }, { status: 404 })

/** Stesso messaggio del 404, ma sull'ALLEGATO: un curriculum non si conferma. */
const docNegato = () =>
  NextResponse.json({ error: NON_TROVATA, codice: CODICE_NON_TROVATA }, { status: 403 })

/**
 * «Adesso non si può»: schema non ancora migrato (DB della CI), lettura o
 * scrittura fallita. **503 e non 200 con una lista vuota**: un elenco vuoto è una
 * risposta, e sarebbe una risposta falsa — la segreteria concluderebbe che non si
 * è candidato nessuno.
 */
const nonDisponibile = (messaggio: string) =>
  NextResponse.json({ error: messaggio, codice: CODICE_OPERAZIONE_NON_RIUSCITA }, { status: 503 })

const giaEvasa = () =>
  NextResponse.json(
    {
      error: 'Questa candidatura è già stata valutata: ricaricare la pagina per vedere l\'esito aggiornato.',
      codice: CODICE_GIA_EVASA,
    },
    { status: 409 },
  )

/** Codici con cui PostgREST/Postgres dicono «questa TABELLA qui non c'è». */
const TABELLA_ASSENTE = new Set([
  '42P01',
  'PGRST205',
  // ⚠️ `PGRST200` — «Could not find a relationship … in the schema cache».
  // È il codice che PostgREST restituisce quando manca la RELAZIONE INCORPORATA,
  // non la tabella: dal 2026-08-19 questo cockpit legge `candidature_sedi` con
  // un embed, quindi sul DB E2E della CI — che non è migrato — l'errore che
  // arriva è questo, non `PGRST205`. Senza, la rotta lo trattava come guasto
  // generico: livello `error` e «riprovare fra poco», cioè mandava a cercare un
  // problema transitorio dove c'è una migrazione mancante. Che sia questo il
  // codice lo dice il repo stesso: nove rotte merch lo elencano già fra i loro
  // `SCHEMA_MANCANTE`.
  'PGRST200',
])
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
 * L'ELENCO È POVERO, e non è un'ottimizzazione: è la stessa lezione di «Moduli
 * ricevuti» (`ModuliRicevuti.tsx:33-42`), dove il payload completo di 299 domande
 * — codici fiscali di minori, allergie, note mediche — partiva verso il browser di
 * ogni membro dello staff a ogni apertura della pagina, anche senza aprire niente.
 *
 * Qui in lista escono solo i campi che servono a RICONOSCERE una candidatura:
 * chi è, per quali POSIZIONI (che dal 2026-08-15 è ciò che distingue una maestra
 * da una cuoca), in quale stato, di quando. Email, telefono, titolo di
 * studio, presentazione e curriculum arrivano con `?id=`, cioè quando qualcuno
 * apre QUELLA candidatura: un gesto deliberato, e uno alla volta.
 */
const COLONNE_ELENCO = ['id', 'scuola_id', 'stato', 'nome', 'cognome', 'posizioni', 'gradi', 'creata_il']

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  IL FILTRO DI SEDE PASSA DA `candidature_sedi`, NON PIÙ DALLA COLONNA    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Dal 2026-08-19 una candidatura può essere rivolta a PIÙ plessi, e ogni plesso
 * la valuta per conto suo. `candidature_insegnanti.scuola_id` è rimasta, ma è
 * la sede di PRIMO ARRIVO: un dato storico, non un criterio d'accesso.
 *
 * ⚠️ FILTRARE ANCORA SULLA COLONNA sarebbe il difetto peggiore dei due possibili,
 * e non è quello che si immagina: non fa vedere di più, fa vedere di MENO. Una
 * candidatura arrivata a Giugliano e rivolta anche ad Aversa resterebbe
 * invisibile alla segreteria di Aversa, che pure la deve valutare — una pratica
 * che non compare in nessun elenco e di cui nessuno sa niente.
 *
 * ⚠️ E NON SI TENGONO ENTRAMBI «per sicurezza». Due criteri di sede sulla stessa
 * risorsa sono due risposte diverse alla stessa domanda, e quale delle due vinca
 * lo si scopre il giorno in cui qualcuno vede ciò che non deve.
 *
 * ─── LE DUE FORME, E PERCHÉ SONO DUE ────────────────────────────────────────
 * MISURATO sulla produzione il 2026-08-20, con una candidatura rivolta a due
 * sedi entrambe visibili:
 *
 *  · `!inner` + `.in('candidature_sedi.scuola_id', scuole)` NON sdoppia la riga
 *    né il conteggio — la candidatura compare UNA volta, `count` è esatto. Chi
 *    guarda cerca una persona, non una pratica.
 *
 *  · ma l'array incorporato porta SOLO le sedi che hanno passato il filtro.
 *    Filtrando su Aversa si legge `[{Aversa}]`, e di Giugliano nessuna traccia.
 *    Per la SCHEDA non basta: chi valuta deve sapere che quella persona è in
 *    gioco anche altrove, altrimenti due segreterie istruiscono la stessa
 *    pratica senza saperlo. Serve un SECONDO embed, non filtrato — provato, e
 *    restituisce tutte e due.
 */
/**
 * L'embed che RESTRINGE, per l'elenco: solo il plesso, nient'altro.
 * `!inner` più il filtro `.in('candidature_sedi.scuola_id', …)` è ciò che rende
 * la query di sede, invece di limitarsi ad arricchirla.
 */
const EMBED_FILTRO = 'candidature_sedi!inner(scuola_id)'

/**
 * L'embed che restringe, per la SCHEDA: porta anche lo stato e la NOTA INTERNA.
 *
 * ⚠️ Il motivo del rifiuto sta QUI, cioè nell'embed FILTRATO, e non in quello che
 * elenca tutti i plessi. È filtrato per sede, quindi ne esce solo la nota della
 * PROPRIA sede: chi valuta ad Aversa legge quello che ha scritto Aversa, e di
 * Giugliano vede lo stato — «rifiutata» — senza le parole con cui una collega ha
 * giudicato quella persona. Verificato sul database vero il 2026-08-20: con la
 * nota scritta da Aversa e il filtro su Giugliano, la nota NON esce dalla query.
 */
const EMBED_FILTRO_SCHEDA = 'candidature_sedi!inner(scuola_id, stato, motivo_rifiuto, evasa_il)'
/**
 * Le sedi della candidatura per l'ELENCO: il plesso e lo stato, niente altro.
 *
 * ⚠️ QUI NON ENTRA `motivo_rifiuto`, ed è la stessa lezione di «Moduli ricevuti»
 * che il blocco su `COLONNE_ELENCO` racconta più sopra. Quell'embed NON è
 * filtrato per sede — è il suo scopo, dire anche i plessi altrui — quindi ogni
 * campo che ci si mette viaggia CROSS-SEDE, verso il browser di ogni membro
 * dello staff, a ogni apertura della pagina, senza che nessuno apra niente.
 *
 * `motivo_rifiuto` è testo libero di giudizio su una persona: questa stessa
 * rotta lo chiama «nota INTERNA» e lo tiene fuori perfino dall'audit, perché
 * «l'audit deve dire che cosa è successo, non conservarne il giudizio». Metterlo
 * nell'elenco lo avrebbe mandato alla segreteria di Aversa insieme a quello che
 * ha scritto la collega di Giugliano.
 */
const EMBED_FILTRO_ELENCO = 'candidature_sedi!inner(scuola_id, stato)'
/*
 * ⚠️ `stato` NON È UN DI PIÙ, ED È IL DIFETTO CHE QUESTA RIGA CHIUDE.
 *
 * Fino al 2026-08-20 l'elenco interrogava con `EMBED_FILTRO`, cioè
 * `candidature_sedi!inner(scuola_id)` — **senza `stato`** — mentre
 * `CandidatureInsegnanti.tsx:942-945` legge `candidature_sedi[…].stato` per i tre
 * contatori e per il badge di riga. Il campo arrivava `undefined`, la catena di
 * `??` scivolava fino a `r.stato`, e quello che si vedeva era l'AGGREGATO: cioè
 * esattamente il numero che il commit `84a91ef5` dichiarava di aver corretto.
 *
 * MISURATO sulla produzione, in sola lettura:
 *   embed FILTRATO: [{"scuola_id":"d53b0fbc-…"}]          ← nessuno `stato`
 *   embed `sedi`:   [{"stato":"pending","scuola_id":"…"}]
 *
 * Perché nessuno se n'era accorto, e vale più della correzione: il tipo del
 * componente dichiara `stato?` OPZIONALE, quindi TypeScript non poteva dirlo; e
 * il finto dei test popolava gli array a mano invece di proiettare le colonne
 * chieste, quindi nessun test poteva vederlo. Un campo facoltativo che nessuno
 * consegna non è un campo facoltativo: è un ripiego che si accende sempre.
 * Il guardiano ora è `__tests__/helpers/embed-sede.ts`, che proietta come il
 * database: un embed consegna SOLO le colonne che ha chiesto.
 *
 * ⚠️ È l'embed FILTRATO, quindi lo stato che porta è solo quello delle sedi di
 * chi guarda.
 */

/*
 * ⚠️ L'ELENCO NON PORTA PIÙ LE SEDI ALTRUI, e la dottrina è quella di
 * `COLONNE_ELENCO`: l'elenco è POVERO.
 *
 * C'era `EMBED_ELENCO = 'sedi:candidature_sedi(scuola_id, stato)'`, non filtrato
 * per sede, che spediva il piano decisionale di OGNI plesso al browser di ogni
 * membro dello staff a ogni apertura di pagina — e nell'elenco non lo disegnava
 * nessuno: `riga.sedi` serve solo alla SCHEDA (`sedeSuCuiDecido`, il selettore
 * dei plessi, l'avviso «è in gioco anche altrove»), che si apre una candidatura
 * alla volta e di proposito. La giustificazione scritta per la scheda — «due
 * segreterie non devono istruire la stessa pratica senza saperlo» — non vale per
 * una lista che quel dato non lo mostra.
 *
 * Era la stessa regola applicata a `motivo_rifiuto` e non al resto.
 */

/**
 * Le sedi per la SCHEDA: una candidatura alla volta, aperta di proposito.
 *
 * ⚠️ `motivo_rifiuto` non c'è NEMMENO QUI. La scheda è un gesto deliberato, ma
 * l'embed resta non filtrato: la nota che ha scritto un altro plesso continuerebbe
 * a uscire. Chi valuta deve sapere CHE un'altra sede ha rifiutato — quello sì, e
 * `stato` glielo dice — non con quali parole l'ha giudicata una collega.
 */
const EMBED_TUTTE = 'sedi:candidature_sedi(scuola_id, stato, evasa_il)'
/*
 * ⚠️ LA COLONNA DEL FILTRO SI SCRIVE PER ESTESO, OGNI VOLTA.
 *
 * C'era una costante `FILTRO_SEDE = 'candidature_sedi.scuola_id'`, ed era una
 * comodità pagata carissima: il lock `isolamento-sede-coverage` riconosce il
 * filtro di sede cercando la colonna come STRINGA LETTERALE dentro `.in(…)`, e
 * con la costante non la vedeva più. MISURATO il 2026-08-20 togliendo il filtro
 * dall'elenco: il lock è rimasto VERDE. Cioè la query più importante del cockpit
 * era uscita dalla sorveglianza senza che nessuno lo notasse.
 *
 * Che il lock non insegua le costanti è voluto, non un suo limite: un rilevatore
 * che risolve indirezioni lo si aggira aggiungendone un'altra. Il contratto è che
 * il filtro sia LEGGIBILE nel punto in cui si applica — da una persona come da
 * una regex. Quattro ripetizioni di una stringa sono il prezzo, ed è basso.
 */

/** Il dettaglio: proiezione ESPLICITA (mai `select('*')`), una candidatura alla volta. */
const COLONNE_DETTAGLIO = [
  'id', 'scuola_id', 'stato', 'nome', 'cognome', 'email', 'telefono',
  'residence_city', 'residence_province', 'posizioni', 'posizione_altro', 'gradi',
  'titolo_studio', 'titolo_dettaglio',
  'anni_esperienza', 'disponibilita', 'note', 'cv_path', 'consents_log',
  'creata_il', 'aggiornata_il', 'evasa_il', 'evasa_da', 'utente_id',
]
/*
 * ⚠️ `motivo_rifiuto` DELLA MADRE NON È IN QUESTO ELENCO, e non ci deve tornare.
 *
 * È testo libero con cui una segreteria giudica una persona. Questa rotta lo
 * chiama «nota INTERNA» e lo tiene fuori perfino dall'audit — «l'audit deve dire
 * che cosa è successo, non conservarne il giudizio» — e lo esclude dai due embed
 * non filtrati con altrettanti blocchi di commento.
 *
 * Restava qui, cioè nell'UNICO posto dove la regola non era applicata: questa
 * proiezione è della tabella madre e per sede non è filtrata. Oggi non perdeva
 * niente, perché dal 2026-08-19 nessuno scrive più quella colonna (il verdetto
 * vive sulla riga di sede) — ma «oggi è vuota» non è un presidio: il giorno di
 * un import o di un backfill tornerebbe a uscire verso ogni plesso in scope
 * senza che una riga di codice cambi, e nessun test sarebbe rosso.
 *
 * La nota che il pannello disegna arriva da `EMBED_FILTRO_SCHEDA`, che è
 * filtrato: chi valuta ad Aversa legge quello che ha scritto Aversa.
 */

/**
 * Le colonne che si RILEGGONO dopo aver scritto lo stato (`cambiaStato`).
 *
 * ⚠️ RESTA UNA STRINGA E RESTA SENZA `posizioni`, ed è una scelta misurata. Questa
 * proiezione NON passa da `conResilienza`: il ciclo di degrado di `cambiaStato`
 * guarda solo il `record` che sta SCRIVENDO, non ciò che rilegge. Una colonna
 * assente qui dentro non verrebbe tolta da nessuno, e l'`UPDATE` fallirebbe per
 * intero — cioè il claim non partirebbe e l'approvazione morirebbe con un 503, su
 * un database in cui invece si potrebbe benissimo cambiare stato.
 */
const COLONNE_LAVORO = 'id, scuola_id, stato, nome, cognome, email, telefono, gradi'

/**
 * Le colonne che servono per DECIDERE — cioè per scegliere se l'approvazione crea
 * un account.
 *
 * È `COLONNE_LAVORO` più `posizioni`, e viaggia come ARRAY perché la lettura che
 * la usa passa da `conResilienza`: su un database senza quella colonna la si
 * toglie e si riprova, invece di far morire l'intera PATCH.
 *
 * ⚠️ E il degrado ha un VERSO, che va detto: senza `posizioni`,
 * `comprendeInsegnamento(undefined)` risponde `false`, quindi NON si crea nessun
 * account. È la direzione giusta — un account `educator` legge l'anagrafica dei
 * bambini, e «non so per quale posizione si è candidata» non può voler dire
 * «creaglielo lo stesso» — ma è anche un degrado che si vede: `conResilienza`
 * lascia una riga `colonna-assente-rimossa` che NOMINA la colonna.
 */
const COLONNE_DECISIONE = [...COLONNE_LAVORO.split(',').map((c) => c.trim()), 'posizioni']

/**
 * Clamp di un intero da query string, senza 400 e senza sorprese agli estremi —
 * gemello di quello di `admin/iscrizioni:GET` (là è inline: non è esportato).
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
  // Un percorso di storage non è lungo: una stringa senza tetto è solo
  // superficie d'attacco in più (stesso tetto di `pagamenti/cassa/allegato:GET`).
  doc: z.string().max(500).optional(),
  id: zUuid.optional(),
  limit: interoClampato(LIMITE_ISCRIZIONI_DEFAULT, 1, LIMITE_ISCRIZIONI_MAX),
  offset: interoClampato(0, 0, Number.MAX_SAFE_INTEGER),
})

const patchBodySchema = z.object({
  id: zUuid,
  action: z.enum(['approva', 'rifiuta']),
  /**
   * SU QUALE SEDE si sta decidendo.
   *
   * Dal 2026-08-19 una candidatura può essere rivolta a più plessi e ogni plesso
   * la valuta per conto suo: senza questo campo, un operatore con due sedi
   * attive chiederebbe «approva» e la route dovrebbe INDOVINARE quale delle sue
   * pratiche sta chiudendo.
   *
   * ⚠️ FACOLTATIVO, e non per pigrizia: chi ha UNA sola sede attiva non ha
   * niente da scegliere, e obbligarlo a dichiararla vorrebbe dire far scrivere
   * al client un uuid che il server già conosce — cioè aprire la porta a un
   * client che lo scrive sbagliato. Con più sedi e nessuna indicata la risposta
   * è 400, mai una scelta arbitraria: è lo stesso contratto di
   * `resolveScuolaScrittura`, e la ragione è la stessa — una rotta che indovina
   * la sede archivia i dati nel plesso sbagliato in silenzio.
   */
  scuola_id: zUuid.optional(),
  /** Nota INTERNA: resta in tabella, non esce nell'email e non entra nei log. */
  motivo: z.string().max(2000).optional(),
  inviaEmailEsito: z.boolean().optional(),
})

// Le fasce della candidatura non si ripuliscono più qui: servivano a creare
// l'account docente, e questa route non lo crea più. Restano nella riga, le legge
// il cockpit, e chi assume le assegna dal pannello Personale guardando la persona.

// ─── GET ─────────────────────────────────────────────────────────────────────
export const GET = withRoute('admin/candidature-insegnanti:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const supabase = await createAdminClient()
    // Scope vuoto ⇒ elenco vuoto: `.in()` incondizionato, mai `if (scuole.length)`.
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)

    // ─── IL CURRICULUM: `?doc=<percorso>` ─────────────────────────────────────
    if (q.data.doc) {
      const docPath = q.data.doc
      // PRIMA il gate sull'OGGETTO, POI la firma. Una signed URL vive dieci
      // minuti ed è scaricabile SENZA sessione: produrla e poi rispondere 403
      // sarebbe una fuga con un altro nome (è il difetto misurato in produzione
      // il 2026-07-31 sui documenti d'identità dei bambini).
      const fuoriScope = await assertCurriculumInScope(supabase, auth.user, scuole, docPath)
      if (fuoriScope) return fuoriScope

      const { data, error } = await supabase.storage.from(BUCKET_CV).createSignedUrl(docPath, 60 * 10)
      if (error || !data?.signedUrl) {
        // UN GUASTO NON SI VESTE DA DINIEGO. Qui il gate di sede è GIÀ passato:
        // quel curriculum è della sede giusta e chi guarda ne ha titolo. Se lo
        // storage non risponde, la risposta vera è «adesso non si può, riprova»
        // (503) — non «non esiste, oppure è di un'altra sede» (403), che manderebbe
        // la segreteria a cercare un problema di permessi che non c'è. È la stessa
        // dottrina di `leggiFallita` trenta righe più sotto, e prima di oggi era
        // l'unico ramo del file che non la seguiva.
        //
        // Lo `stato` loggato è quello RESTITUITO: prima diceva 404 mentre la
        // risposta era 403, e chi legge `app_log` cercava un numero mai uscito.
        // Il messaggio grezzo NON torna al client: contiene il percorso, cioè il
        // nome del file caricato dalla persona.
        logErrore({ operazione: 'admin/candidature-insegnanti:GET', stato: 503, evento: 'storage' }, error)
        return NextResponse.json(
          {
            error: 'Il curriculum non è scaricabile in questo momento: riprovare fra poco.',
            codice: CODICE_OPERAZIONE_NON_RIUSCITA,
          },
          { status: 503 },
        )
      }
      return NextResponse.json({ url: data.signedUrl })
    }

    // ─── IL DETTAGLIO: `?id=<uuid>` ───────────────────────────────────────────
    if (q.data.id) {
      const idCandidatura = q.data.id
      const { data: riga, error } = await conResilienza(COLONNE_DETTAGLIO, 'admin/candidature-insegnanti:GET', (colonne) =>
        supabase
          .from(TABELLA)
          // Due embed: uno RESTRINGE (`!inner` + filtro), l'altro DESCRIVE.
          // Vedi il blocco su `EMBED_FILTRO`: l'array filtrato mostrerebbe solo
          // le sedi di chi guarda, e la scheda deve dire anche le altre.
          .select(`${colonne}, ${EMBED_FILTRO_SCHEDA}, ${EMBED_TUTTE}`)
          // Il filtro di sede sta nella STESSA query dell'id (AND), non «da
          // qualche parte nell'handler»: è l'unico posto in cui è vero.
          .eq('id', idCandidatura)
          .in('candidature_sedi.scuola_id', scuole)
          .maybeSingle(),
      )
      if (error) return leggiFallita('admin/candidature-insegnanti:GET', 'dettaglio-non-letto', error)
      if (!riga) {
        logEvento('multi_sede', 'warn', {
          operazione: 'admin/candidature-insegnanti:GET',
          esito: 'dettaglio-non-in-scope',
          utente: auth.user.id,
          ruolo: auth.user.role,
          entita_tipo: TABELLA,
          entita_id: idCandidatura,
          sedi_attive: scuole.length,
        })
        return nonTrovata()
      }
      return NextResponse.json({ data: riga })
    }

    // ─── L'ELENCO ─────────────────────────────────────────────────────────────
    const { limit, offset } = q.data
    const { data, error, count } = await conResilienza(COLONNE_ELENCO, 'admin/candidature-insegnanti:GET', (colonne) =>
      supabase
        .from(TABELLA)
        // `!inner` restringe: senza, il join arricchirebbe e basta, e l'elenco
        // mostrerebbe le candidature di TUTTE le sedi con accanto quelle proprie.
        .select(`${colonne}, ${EMBED_FILTRO_ELENCO}`, { count: 'exact' })
        .in('candidature_sedi.scuola_id', scuole)
        .order('creata_il', { ascending: false })
        .range(offset, offset + limit - 1),
    )
    if (error) return leggiFallita('admin/candidature-insegnanti:GET', 'elenco-non-letto', error)

    const righe = (data ?? []) as unknown as Record<string, unknown>[]
    // `total` dal conteggio ESATTO: con 60 righe su 200 la lunghezza della pagina
    // direbbe «60», e nessuno saprebbe delle altre 140.
    const total = typeof count === 'number' ? count : offset + righe.length
    return NextResponse.json({ data: righe, total, limit, offset })
  } catch (err) {
    logErrore({ operazione: 'admin/candidature-insegnanti:GET', stato: 503 }, err)
    return nonDisponibile('Le candidature non sono consultabili in questo momento: riprovare fra poco.')
  }
})

// ─── PATCH ───────────────────────────────────────────────────────────────────
export const PATCH = withRoute('admin/candidature-insegnanti:PATCH', async (request: NextRequest) => {
  // Direzione soltanto: approvare crea un account che legge l'anagrafica dei bambini.
  const auth = await requireStaff(request, ['admin', 'coordinator'])
  if (auth.response) return auth.response
  try {
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, action } = b.data
    const motivo = (b.data.motivo ?? '').trim() || null
    const inviaEmailEsito = b.data.inviaEmailEsito === true

    const supabase = await createAdminClient()
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)

    // La candidatura si carica UNA volta, PRIMA di qualunque scrittura, e già
    // ristretta alle sedi attive: «di un'altra sede» e «non esiste» escono dalla
    // stessa porta.
    const { data: cand, error: errCand } = await conResilienza(
      COLONNE_DECISIONE,
      'admin/candidature-insegnanti:PATCH',
      (colonne) =>
        supabase
          .from(TABELLA)
          .select(`${colonne}, ${EMBED_FILTRO}`)
          .eq('id', id)
          .in('candidature_sedi.scuola_id', scuole)
          .maybeSingle(),
    )
    if (errCand) return leggiFallita('admin/candidature-insegnanti:PATCH', 'candidatura-non-letta', errCand)
    if (!cand) {
      logEvento('multi_sede', 'warn', {
        operazione: 'admin/candidature-insegnanti:PATCH',
        esito: 'candidatura-non-in-scope',
        azione: action,
        utente: auth.user.id,
        ruolo: auth.user.role,
        entita_tipo: TABELLA,
        entita_id: id,
        sedi_attive: scuole.length,
      })
      return nonTrovata()
    }
    const riga = cand as unknown as CandidaturaDiLavoro

    // ── SU QUALE SEDE SI STA DECIDENDO ──────────────────────────────────────
    // Dichiarata nel corpo, oppure — se l'operatore ha una sede sola — quella.
    // Con più sedi e nessuna indicata: 400. Mai una scelta arbitraria.
    /**
     * ⚠️ SI CONFRONTA NORMALIZZATO, E POI SI PORTA AVANTI LA FORMA DEL DATABASE.
     *
     * In Postgres `uuid` è un TIPO: `'AAAA-…'` e `'aaaa-…'` sono lo STESSO
     * valore. In JavaScript sono due stringhe diverse, e `zUuid` è `z.guid()`,
     * che il maiuscolo lo accetta. Con un `Array.includes()` fra la stringa del
     * client e le forme canoniche lette dal database, chi dichiara la PROPRIA
     * sede in maiuscolo si prende un 404 «non esiste, oppure appartiene a
     * un'altra sede» — più un `warn` `sede-fuori-scope`.
     *
     * Due danni, e il secondo è quello che dura: una scrittura legittima negata
     * (la si vede, ci si accorge) e un contatore nato come SEGNALE DI SICUREZZA
     * riempito di falsi positivi, che nessuno guarda finché non serve. È parola
     * per parola il difetto che `scope.ts:95-107` racconta come già misurato il
     * 2026-07-31 sui dati veri, ripreso qui perché il confronto era fatto a mano
     * invece che con `formaConfronto`.
     *
     * Ciò che prosegue è `canonica`, cioè il valore del DATABASE: il resto della
     * rotta ci fa `===` con altri uuid già letti, e un `'AAAA-…'` di ritorno
     * sarebbe lo stesso difetto spostato di un metro.
     *
     * Normalizzare è un CONFRONTO, non un permesso: una sede ALTRUI in maiuscolo
     * resta negata, e il controllo negativo sta accanto a questo caso in
     * `candidature-insegnanti-scope-sede.test.ts`.
     */
    const dichiarataDalClient = b.data.scuola_id ?? (scuole.length === 1 ? scuole[0] : null)
    const canonica =
      dichiarataDalClient === null
        ? null
        : (scuole.find((s) => formaConfronto(s) === formaConfronto(dichiarataDalClient)) ?? null)
    if (dichiarataDalClient === null) {
      logEvento('multi_sede', 'warn', {
        operazione: 'admin/candidature-insegnanti:PATCH',
        esito: 'sede-non-dichiarata',
        azione: action,
        utente: auth.user.id,
        ruolo: auth.user.role,
        entita_id: id,
        sedi_attive: scuole.length,
      })
      return NextResponse.json(
        {
          error: 'Specificare la sede su cui si sta decidendo: questa candidatura è rivolta a più plessi.',
          codice: 'SEDE_DA_SPECIFICARE',
        },
        { status: 400 },
      )
    }
    // …e deve essere UNA DELLE SUE. Un uuid nel corpo è scritto dal client, e un
    // client può scrivere qualunque cosa: senza questo controllo, chi ha Aversa
    // potrebbe dichiarare Giugliano e chiudere una pratica che non è sua.
    if (canonica === null) {
      logEvento('multi_sede', 'warn', {
        operazione: 'admin/candidature-insegnanti:PATCH',
        esito: 'sede-fuori-scope',
        azione: action,
        utente: auth.user.id,
        ruolo: auth.user.role,
        entita_id: id,
        sede_id: dichiarataDalClient,
        sedi_attive: scuole.length,
      })
      return nonTrovata()
    }

    // Da qui in giù la sede è UNA, in forma CANONICA: le funzioni ricevono
    // più tutte le sedi attive, così la scrittura non può toccare la riga di un
    // plesso su cui nessuno ha deciso niente.
    return action === 'approva'
      ? await approva(supabase, auth.user, [canonica], riga)
      : await rifiuta(supabase, auth.user, [canonica], riga, motivo, inviaEmailEsito)
  } catch (err) {
    logErrore({ operazione: 'admin/candidature-insegnanti:PATCH', stato: 503 }, err)
    return nonDisponibile('Non è stato possibile evadere la candidatura: riprovare fra poco.')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Gli aiutanti
// ─────────────────────────────────────────────────────────────────────────────

interface CandidaturaDiLavoro {
  id: string
  scuola_id: string
  stato: string
  nome: string | null
  cognome: string | null
  email: string | null
  telefono: string | null
  gradi: unknown
  /**
   * `unknown` come `gradi`, e per la stessa ragione: arriva grezza da PostgREST.
   * Facoltativa nel tipo perché la lettura che la porta passa da `conResilienza`
   * e su un database non migrato quella colonna viene tolta dalla proiezione —
   * il che è esattamente il caso in cui `comprendeInsegnamento` deve rispondere
   * «no», non «non lo so, procedi».
   */
  posizioni?: unknown
}

type EsitoQuery<T> = { data: T; error: { code?: string; message: string } | null; count?: number | null }

/**
 * Resilienza alla COLONNA assente (`42703`/`PGRST204`): il progetto E2E della CI
 * non è migrato, e una proiezione esplicita — al contrario di `select('*')` —
 * fallisce. Si toglie la colonna che il database dichiara di non avere e si
 * riprova, lasciando una riga che la NOMINA (in `msg`, che finisce in chiaro
 * nella colonna `app_log.messaggio`: `redact` è a lista bianca per chiave).
 *
 * La TABELLA assente non è qui: quella non si degrada, si dichiara (503).
 */
async function conResilienza<T>(
  colonneIniziali: string[],
  operazione: string,
  esegui: (colonne: string) => PromiseLike<EsitoQuery<T>>,
): Promise<EsitoQuery<T>> {
  let colonne = [...colonneIniziali]
  let esito = await esegui(colonne.join(', '))
  let tentativi = 0
  while (esito.error && COLONNA_ASSENTE.has(codiceDi(esito.error) ?? '') && tentativi < 6) {
    const col = colonnaMancante(esito.error.message ?? '')
    if (!col || !colonne.includes(col)) break
    logEvento('candidatura', 'warn', {
      operazione,
      esito: 'colonna-assente-rimossa',
      entita_tipo: TABELLA_SEDI,
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
 * Una lettura fallita NON è «non trovata»: i due hanno rimedi opposti — la prima
 * si risolve riprovando, la seconda no — e rispondere 404 su un guasto significa
 * affermare qualcosa su un dato che non si è letto.
 */
function leggiFallita(operazione: string, esito: string, error: unknown): NextResponse {
  const codice = codiceDi(error)
  const schemaAssente = TABELLA_ASSENTE.has(codice ?? '')
  logEvento('candidatura', schemaAssente ? 'warn' : 'error', {
    operazione,
    esito: schemaAssente ? 'tabella-assente' : esito,
    entita_tipo: TABELLA,
    error_code: codice,
  }, error)
  return nonDisponibile(
    schemaAssente
      ? 'Le candidature non sono disponibili su questo ambiente: la tabella non è ancora stata creata.'
      : 'Le candidature non sono consultabili in questo momento: riprovare fra poco.',
  )
}

/**
 * GATE SULL'OGGETTO per `?doc=` — il percorso si RISOLVE alla candidatura che lo
 * contiene, interrogando le sole sedi attive, e si firma solo se ne esce una riga.
 *
 * Tre scelte, tutte deliberate e tutte già pagate altrove in questo repo:
 *  · fail-CLOSED: se la lettura fallisce non si firma. Non sapere di chi è un
 *    curriculum non può voler dire consegnarlo;
 *  · percorso che non si risolve ⇒ diniego: un file che non appartiene a nessuna
 *    candidatura non ha una sede da verificare, quindi nessuno può dire che sia suo;
 *  · un solo messaggio per «di un'altra sede» e «inesistente».
 */
async function assertCurriculumInScope(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  docPath: string,
): Promise<NextResponse | null> {
  // ⚠️ NIENTE `.limit(1)`, e la sua assenza È la difesa. Con il `.limit(1)` che
  // c'era fino al 2026-08-15, PostgREST non restituiva mai più di una riga e il
  // ramo `PGRST116` di `maybeSingle()` era IRRAGGIUNGIBILE per costruzione —
  // misurato nel sorgente installato
  // (`node_modules/@supabase/postgrest-js/dist/index.cjs:471`: l'errore si
  // sintetizza solo quando `data.length > 1`). Cioè: due candidature che
  // dichiaravano lo stesso `cv_path` non producevano nessun errore e nessuna
  // segnalazione — se ne prendeva UNA A CASO (non c'è nessun `order by`), la
  // firma riusciva, e la riga di sorveglianza qui sotto attribuiva la lettura
  // alla candidatura sbagliata.
  //
  // Quella collisione adesso non può nascere dal prodotto: l'indice unico
  // `candidature_insegnanti_cv_unico` la impedisce, e la porta pubblica la
  // riconosce dal nome del vincolo. Ma su questo database `execute_sql` gira
  // senza conferma umana, quindi una riga scritta a mano resta possibile: senza
  // il `.limit(1)`, quel caso diventa un `PGRST116` che questo gate tratta come
  // un guasto — fail-closed, e LOGGATO — invece di una firma silenziosa.
  // ⚠️ IL FILTRO PASSA DALLE RIGHE DI SEDE, come l'elenco e la scheda.
  // Restando sulla colonna, il criterio sarebbe diventato «di chi era la PRIMA
  // sede» invece di «chi ha titolo»: la segreteria di Aversa non avrebbe potuto
  // aprire il curriculum di una candidatura rivolta anche ad Aversa ma arrivata
  // prima a Giugliano — e si sarebbe trovata a valutare una persona senza poterne
  // leggere il documento che la descrive.
  const { data, error } = await supabase
    .from(TABELLA)
    .select(`id, scuola_id, ${EMBED_FILTRO}`)
    .eq('cv_path', docPath)
    .in('candidature_sedi.scuola_id', scuole)
    // ⚠️ NESSUN `.limit(1)`: vedi il blocco qui sopra, che spiega perché la sua
    // ASSENZA è la difesa. Ce n'era finito uno il 2026-08-20 durante il lavoro
    // sulla multi-sede, sotto quel commento e in contraddizione con esso —
    // riaprendo una regressione dichiarata chiusa cinque giorni prima. Non serve
    // nemmeno: l'embed `!inner` non sdoppia la riga, ed è misurato.
    .maybeSingle()
  if (error) {
    logEvento('multi_sede', 'error', {
      operazione: 'admin/candidature-insegnanti:GET',
      esito: 'curriculum-non-verificabile',
      entita_tipo: TABELLA,
      error_code: codiceDi(error),
    }, error)
    return nonDisponibile('Verifica del curriculum non riuscita: riprovare fra poco.')
  }
  if (data) {
    const trovata = data as { id?: unknown; scuola_id?: unknown }
    // IL REGISTRO DEGLI ACCESSI RIUSCITI. `multi_sede` è persistito: la riga resta
    // in `app_log` e sopravvive al deploy. Senza, «nessun log» non distingue
    // «nessuno ha guardato» da «la sorveglianza non è mai partita» — e da qui esce
    // un curriculum, cioè un dato personale su cui l'interessata ha diritto di
    // chiedere chi l'ha letto. MAI il percorso: contiene il nome del file, che
    // quasi sempre è il nome di una persona.
    logEvento('multi_sede', 'info', {
      operazione: 'admin/candidature-insegnanti:GET',
      esito: 'curriculum-firmato',
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
  // distinzione il log di una fuga non si legge. Best-effort: legge una riga e la
  // sola `scuola_id`, e un errore qui non cambia l'esito.
  let sedeAltrove: string | null = null
  const { data: altrove, error: errAltrove } = await supabase
    .from(TABELLA)
    .select('scuola_id')
    .eq('cv_path', docPath)
    .limit(1)
    .maybeSingle()
  if (errAltrove) {
    logEvento('multi_sede', 'info', {
      operazione: 'admin/candidature-insegnanti:GET',
      esito: 'curriculum-origine-non-verificabile',
      entita_tipo: TABELLA,
      error_code: codiceDi(errAltrove),
    }, errAltrove)
  } else {
    const sede = (altrove as { scuola_id?: unknown } | null)?.scuola_id
    if (typeof sede === 'string') sedeAltrove = sede
  }

  logEvento('multi_sede', 'warn', {
    operazione: 'admin/candidature-insegnanti:GET',
    esito: sedeAltrove ? 'curriculum-fuori-sede' : 'curriculum-non-risolto',
    azione: 'documento',
    utente: user.id,
    ruolo: user.role,
    sede_id: sedeAltrove,
    sedi_attive: scuole.length,
  })
  return docNegato()
}

/**
 * Il passaggio di stato, con la sede NELLA STESSA istruzione che scrive e gli
 * stati di partenza ammessi nel `WHERE`: è ciò che rende ATOMICO il passaggio e
 * chiude la corsa fra due clic o due schede.
 * Zero righe non è un errore: è «qualcun altro è arrivato prima».
 *
 * ─── DAL 2026-08-19 SCRIVE SU `candidature_sedi`, NON PIÙ SULLA CANDIDATURA ──
 * Ogni sede valuta per conto suo, quindi il verdetto appartiene alla COPPIA
 * (candidatura, sede). Lo `stato` di `candidature_insegnanti` diventa
 * l'aggregato, e lo ricalcola il trigger `candidature_sedi_aggrega`.
 *
 * ⚠️ QUI NON SI SCRIVE PIÙ `candidature_insegnanti.stato`. Scriverlo vorrebbe
 * dire due autorità sulla stessa colonna — questa funzione e il trigger — che
 * prima o poi dicono cose diverse, e la differenza si vedrebbe solo nel caso
 * multi-sede, cioè in quello raro.
 */
async function cambiaStato(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  args: { id: string; scuole: string[]; da: string[]; patch: Record<string, unknown> },
): Promise<{
  righe: Record<string, unknown>[]
  error: { code?: string; message: string } | null
  /**
   * Le colonne TOLTE dalla scrittura perché il database non le ha. Va restituita,
   * e non solo loggata, perché senza di essa il chiamante non può distinguere
   * «scritto tutto» da «scritto in parte»: l'UPDATE ritorna comunque una riga —
   * `stato` c'è ancora — e ogni misura a valle direbbe «riuscito». È il modo in
   * cui l'audit tornava a dichiarare `utente_id: <uid>` su una riga che a
   * quell'account non era legata.
   */
  colonneCadute: string[]
}> {
  const record = { ...args.patch }
  const colonneCadute: string[] = []
  const scrivi = () =>
    supabase
      .from(TABELLA_SEDI)
      .update(record)
      .eq('candidatura_id', args.id)
      .in('stato', args.da)
      // La sede è UNA: quella su cui l'operatore ha titolo e che ha dichiarato.
      // `.in` con un elenco di uno, per restare nella stessa forma degli altri
      // filtri di sede del file e non introdurre un `.eq` che si legge diverso.
      .in('scuola_id', args.scuole)
      .select('candidatura_id, scuola_id, stato')
  let esito = await scrivi()
  let tentativi = 0
  // Degrado sulla COLONNA assente (DB della CI non migrato). `stato` non si toglie
  // mai: senza quello l'istruzione non fa più ciò per cui esiste.
  while (esito.error && COLONNA_ASSENTE.has(codiceDi(esito.error) ?? '') && tentativi < 6) {
    const col = colonnaMancante(esito.error.message ?? '')
    if (!col || !(col in record) || col === 'stato') break
    logEvento('candidatura', 'warn', {
      operazione,
      esito: 'colonna-assente-rimossa',
      entita_tipo: TABELLA_SEDI,
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

// ⚠️ `rimettiPending` NON C'È PIÙ, e con essa il claim in due tempi
// (`pending → in_approvazione → approvata`). Esisteva per una ragione sola:
// chiudere la corsa fra due clic MENTRE si creava un account e si spediva una
// password. Da quando approvare non crea niente e non spedisce niente, quel
// doppio passo non protegge nulla e costa: un guasto fra i due tempi lasciava la
// candidatura in `in_approvazione`, cioè in uno stato che l'interfaccia racconta
// come «l'account docente È STATO CREATO» e che spegne per sempre i due pulsanti.
// Un `cambiaStato` unico `da: ['pending'] → 'approvata'` è già atomico: lo stato
// di partenza sta nel WHERE.
//
// Misurato il 2026-08-15 prima di rimuoverla: nessuna riga di
// `candidature_insegnanti` si trova in `in_approvazione`, quindi non resta
// nessuna candidatura che avesse bisogno del ripristino.

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  APPROVA SENZA CREARE NESSUN ACCOUNT                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * È la strada delle candidature NON docenti — collaboratrice scolastica, cucina,
 * segreteria, «altro» — che dal 2026-08-15 il modulo pubblico raccoglie.
 *
 * ── PERCHÉ NON SI CREA UN ACCOUNT, detto una volta e senza giri ─────────────
 *
 * Perché l'unico account che questa rotta sa creare è `ruolo: 'educator'`, e un
 * account educator LEGGE L'ANAGRAFICA DEI BAMBINI. Approvare una cuoca creandole
 * un profilo docente le darebbe l'accesso a nomi, allergie e note mediche di
 * minori — per un lavoro che in quell'anagrafica non entra mai. Fra i sei ruoli
 * dell'applicazione ce ne sono due che sarebbero calzanti (`cuoca`, `segreteria`)
 * e uno che non esiste affatto (la collaboratrice scolastica): scegliere qui
 * quale assegnare significherebbe far nascere da un modulo ANONIMO un account con
 * un ruolo deciso da chi lo compila. La decisione del titolare, il 2026-08-15, è
 * stata l'unica che non allarga nessun accesso: l'account, se serve, lo crea la
 * Direzione a mano dal pannello Personale, guardando la persona.
 *
 * ── ⚠️ E NON PASSA DAL CLAIM IN DUE TEMPI ──────────────────────────────────
 *
 * `pending → in_approvazione → approvata` esiste per UNA ragione sola: chiudere
 * la corsa fra due clic mentre si crea un account e si spedisce una password.
 * Qui non si crea niente e non si spedisce niente, quindi quel doppio passo non
 * proteggerebbe nulla — e costerebbe caro: un guasto fra i due tempi lascerebbe
 * la candidatura in `in_approvazione`, cioè in uno stato che l'interfaccia
 * racconta testualmente come «l'account docente È STATO CREATO e le credenziali
 * sono già state generate» (`candSospesaTesto`) e che spegne per sempre i due
 * pulsanti, perché il claim pretende `pending`. Una frase falsa e una riga
 * bloccata, per proteggere un'operazione che non c'è.
 *
 * Un `cambiaStato` UNICO `da: ['pending'] → 'approvata'` è già atomico per
 * costruzione — lo stato di partenza sta nel `WHERE` — e chiude la stessa corsa
 * con un'istruzione sola: zero righe vuol dire «qualcun altro è arrivato prima».
 */
async function approvaSenzaAccount(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  riga: CandidaturaDiLavoro,
): Promise<NextResponse> {
  const operazione = 'admin/candidature-insegnanti:PATCH'
  /**
   * La sede su cui si sta decidendo.
   *
   * Il PATCH passa qui un elenco di UNO — la sede dichiarata nel corpo, o l'unica
   * attiva dell'operatore — dopo averne verificato la titolarità. Non è
   * `riga.scuola_id`, che dal 2026-08-19 è la sede di PRIMO ARRIVO e non dice
   * niente su chi sta valutando.
   */
  const sedeCheDecide = scuole[0]
  const adesso = new Date().toISOString()
  const warnings: string[] = []

  const chiusura = await cambiaStato(supabase, operazione, {
    id: riga.id,
    scuole,
    da: ['pending'],
    patch: {
      stato: 'approvata',
      evasa_il: adesso,
      evasa_da: user.id,
      // ⚠️ NIENTE `aggiornata_il` QUI. Quella colonna sta su
      // `candidature_insegnanti`, non sulle righe di sede, e la scrive il TRIGGER
      // quando ricalcola lo stato aggregato.
      //
      // Nominarla qui non è innocuo: PostgREST risponde `PGRST204`, il ciclo di
      // degrado di `cambiaStato` la toglie e ritenta, l'operazione riesce — ma
      // OGNI approvazione e OGNI rifiuto lasciano una riga `warn`
      // `colonna-assente-rimossa` e mostrano all'operatore «Chiusura registrata
      // solo in parte: su questo ambiente mancano le colonne aggiornata_il».
      // Cioè: il segnale che dovrebbe dire «questo ambiente non è migrato»
      // diventa rumore costante e smette di significare qualcosa, e a chi lavora
      // si annuncia un guasto che non c'è. Misurato sullo schema di produzione:
      // `candidature_sedi` ha sette colonne e `aggiornata_il` non è fra quelle.
      // ⚠️ `utente_id` NON si scrive, e non si scrive nemmeno `null`: la colonna
      // è già `null` e nominarla nel patch la esporrebbe al ciclo di degrado di
      // `cambiaStato`, che la toglierebbe e la conterebbe fra le `colonneCadute`
      // — un avviso all'operatore su una colonna che non si voleva scrivere.
    },
  })
  if (chiusura.error) {
    logEvento('candidatura', 'error', {
      operazione,
      esito: 'approvazione-senza-account-non-riuscita',
      entita_tipo: TABELLA,
      entita_id: riga.id,
      sede_id: sedeCheDecide,
      error_code: codiceDi(chiusura.error),
    }, chiusura.error)
    return nonDisponibile('Non è stato possibile approvare la candidatura: riprovare fra poco.')
  }
  if (chiusura.righe.length === 0) {
    logEvento('candidatura', 'warn', {
      operazione,
      esito: 'candidatura-gia-evasa',
      azione: 'approva',
      entita_tipo: TABELLA,
      entita_id: riga.id,
      stato: riga.stato,
    })
    return giaEvasa()
  }
  if (chiusura.colonneCadute.length > 0) {
    warnings.push(
      `Chiusura registrata solo in parte: su questo ambiente mancano le colonne ${chiusura.colonneCadute.join(', ')}.`,
    )
  }

  await logScrittura(supabase, {
    attore: user,
    entitaTipo: 'candidatura',
    entitaId: riga.id,
    azione: 'update',
    // ⚠️ LA SEDE CHE DECIDE, non quella di primo arrivo. `riga.scuola_id` è un
    // dato storico dal 2026-08-19: usarlo qui attribuirebbe la decisione di
    // Aversa al registro di Giugliano, sulle candidature rivolte a entrambe.
    scuolaId: sedeCheDecide,
    // ESPLICITI e non omessi: fra mesi «la chiave non c'era» e «la chiave valeva
    // null» si leggono diversi, e la domanda che qualcuno farà a questo registro
    // immutabile è esattamente «a quale account è legata questa candidatura?».
    // La risposta vera è «a nessuno, e apposta».
    valoreDopo: {
      stato: 'approvata',
      chiusura_riuscita: true,
      utente_id: null,
      account_uid: null,
      account_creato: false,
    },
  })

  // ⚠️ UN ESITO TUTTO SUO, e non `candidatura-approvata`. Quel battito è il
  // conteggio delle assunzioni di insegnanti («quante ne sono state assunte
  // questo mese?»): una riga emessa qui lo gonfierebbe con approvazioni che non
  // hanno prodotto nessun account. È la stessa ragione per cui, poco più sotto,
  // la chiusura fallita ha già un esito suo invece di un campo in più.
  logEvento('candidatura', 'info', {
    operazione,
    esito: 'candidatura-approvata-senza-account',
    entita_tipo: TABELLA,
    entita_id: riga.id,
    sede_id: sedeCheDecide,
    account_creato: false,
    // Quante posizioni portava, mai QUALI: `redact()` lascia passare i numeri per
    // tipo, e a chi interroga `app_log` serve sapere che il ramo è stato preso,
    // non che lavoro cercava quella persona.
    n_posizioni: Array.isArray(riga.posizioni) ? riga.posizioni.length : 0,
  })

  return NextResponse.json({
    success: true,
    id: riga.id,
    stato: 'approvata',
    credentials: null,
    credentialsEmailSent: false,
    esitoAccount: 'nessuno',
    warnings,
  })
}

/**
 * APPROVA — e dal 2026-08-15 approvare NON crea nessun accesso.
 *
 * Questa funzione era lunga duecento righe: claim in due tempi, creazione
 * dell'account docente, generazione della password, invio dell'email, chiusura.
 * Adesso è una riga, e la riga è la decisione.
 *
 * ── PERCHÉ ──────────────────────────────────────────────────────────────────
 *
 * Una candidatura è una domanda di lavoro, non un'assunzione. Farle produrre un
 * account `educator` — che LEGGE L'ANAGRAFICA DEI BAMBINI, con nomi, allergie e
 * note mediche — significava che il gesto di «prendo in considerazione questa
 * persona» consegnava, nello stesso clic, le chiavi del registro di 33 minori,
 * spedite a un indirizzo email arrivato da un modulo pubblico.
 *
 * L'accesso ora nasce in UN POSTO SOLO: l'approvazione dell'ANAGRAFICA del
 * personale (`admin/pratiche-personale:PATCH`), che è il momento in cui la
 * Direzione ha davanti il documento d'identità, il codice fiscale e la persona
 * assunta davvero — e da lì parte l'email con le credenziali.
 *
 * ── COSA RESTA A CHI SI CANDIDA ─────────────────────────────────────────────
 *
 * L'email di CONFERMA, che parte già alla ricezione del modulo
 * (`iscrizione/insegnanti:POST` → `messaggioConfermaCandidatura`), e in caso di
 * rifiuto l'email di esito. L'approvazione, di suo, non scrive a nessuno: chi è
 * stato scelto lo sente dalla scuola, con una telefonata, non da un messaggio
 * automatico che gli consegna una password.
 *
 * ⚠️ Il ramo esisteva già dal 2026-08-15 mattina per le posizioni NON docenti
 * (cucina, collaboratrice scolastica, segreteria): la ragione scritta lì —
 * «l'account, se serve, lo crea la Direzione a mano guardando la persona» — vale
 * parola per parola anche per le insegnanti. Adesso vale per tutte, e
 * `comprendeInsegnamento` non serve più a decidere niente qui.
 */
async function approva(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  riga: CandidaturaDiLavoro,
): Promise<NextResponse> {
  return await approvaSenzaAccount(supabase, user, scuole, riga)
}

/** RIFIUTA: nessun account, nessuna riga `utenti`, e il motivo resta una nota interna. */
async function rifiuta(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  riga: CandidaturaDiLavoro,
  motivo: string | null,
  inviaEmailEsito: boolean,
): Promise<NextResponse> {
  const operazione = 'admin/candidature-insegnanti:PATCH'
  /**
   * La sede su cui si sta decidendo.
   *
   * Il PATCH passa qui un elenco di UNO — la sede dichiarata nel corpo, o l'unica
   * attiva dell'operatore — dopo averne verificato la titolarità. Non è
   * `riga.scuola_id`, che dal 2026-08-19 è la sede di PRIMO ARRIVO e non dice
   * niente su chi sta valutando.
   */
  const sedeCheDecide = scuole[0]
  const warnings: string[] = []
  const adesso = new Date().toISOString()

  /**
   * Si rifiuta ciò che è ancora in gioco: sulle righe di sede è `pending`, e
   * basta. Zero righe ⇒ ha già deciso qualcun altro.
   *
   * ⚠️ QUI C'ERA ANCHE `'in_approvazione'`, ED ERA UN VALORE MORTO. Il commento
   * lo giustificava («una presa in carico rimasta appesa») e `cambiaStato`
   * scrive su `candidature_sedi`, il cui `CHECK` — verificato in produzione —
   * ammette solo `pending | approvata | rifiutata`. Quel valore nel `WHERE` non
   * poteva corrispondere a niente: descriveva uno stato che su quella tabella
   * non esiste.
   *
   * Non è cosmesi. Un `IN` con dentro un valore impossibile fa credere a chi
   * legge che quel caso sia coperto, e il giorno in cui qualcuno reintroduce
   * davvero uno stato intermedio penserà di non dover toccare niente qui. Lo
   * stato a tre passi vive sulla CANDIDATURA, non sulle sue righe di sede: se un
   * giorno dovrà vivere anche lì, prima va allargato il `CHECK`.
   */
  const esito = await cambiaStato(supabase, operazione, {
    id: riga.id,
    scuole,
    da: ['pending'],
    patch: {
      stato: 'rifiutata',
      evasa_il: adesso,
      evasa_da: user.id,
      motivo_rifiuto: motivo,
      // ⚠️ Niente `aggiornata_il`: sta sulla candidatura e la scrive il trigger.
      // Vedi il blocco in `approvaSenzaAccount` per che cosa succedeva a
      // nominarla — un falso guasto annunciato a ogni singola decisione.
    },
  })
  if (esito.error) {
    logEvento('candidatura', 'error', {
      operazione, esito: 'rifiuto-non-registrato', entita_tipo: TABELLA, entita_id: riga.id,
      error_code: codiceDi(esito.error),
    }, esito.error)
    return nonDisponibile('Non è stato possibile registrare il rifiuto: riprovare fra poco.')
  }
  if (esito.righe.length === 0) {
    logEvento('candidatura', 'warn', {
      operazione, esito: 'candidatura-gia-evasa', azione: 'rifiuta',
      entita_tipo: TABELLA, entita_id: riga.id, stato: riga.stato,
    })
    return giaEvasa()
  }
  if (esito.colonneCadute.length > 0) {
    warnings.push(
      `Rifiuto registrato solo in parte: su questo ambiente mancano le colonne ${esito.colonneCadute.join(', ')}.`,
    )
  }

  await logScrittura(supabase, {
    attore: user,
    entitaTipo: 'candidatura',
    entitaId: riga.id,
    azione: 'update',
    // ⚠️ LA SEDE CHE DECIDE, non quella di primo arrivo. `riga.scuola_id` è un
    // dato storico dal 2026-08-19: usarlo qui attribuirebbe la decisione di
    // Aversa al registro di Giugliano, sulle candidature rivolte a entrambe.
    scuolaId: sedeCheDecide,
    // Il TESTO del motivo non entra nell'audit: è una nota interna su una persona,
    // e l'audit deve dire che cosa è successo, non conservarne il giudizio.
    //
    // `motivo_presente` parla della RIGA, non dell'intenzione di chi ha premuto:
    // se `motivo_rifiuto` è caduta dal degrado su colonna assente, la nota non è
    // stata scritta da nessuna parte e dichiararla presente manderebbe qualcuno,
    // fra mesi, a cercare in tabella un testo che non c'è.
    valoreDopo: {
      stato: 'rifiutata',
      motivo_presente: Boolean(motivo) && !esito.colonneCadute.includes('motivo_rifiuto'),
    },
  })

  // Email di cortesia: SOLO se l'operatore l'ha chiesta, e senza motivazione —
  // quello che si scrive in segreteria non è quello che si dice alla persona.
  let esitoEmailInviato = false
  const email = (riga.email ?? '').trim()
  if (inviaEmailEsito && email) {
    // ⚠️ LA SEDE CHE HA RIFIUTATO. L'email dice «La Segreteria di <nome>», e
    // firmarla col plesso di primo arrivo manderebbe a chi si è candidato una
    // risposta a nome di una sede che non ha deciso niente — mentre quella che
    // ha deciso sta ancora zitta.
    const sedeEsito = await risolviContestoSede(supabase, sedeCheDecide, operazione)
    // Il MOTIVO del rifiuto non entra qui, e non perché ce ne dimentichiamo: il
    // generatore non lo riceve affatto. Non si può far uscire un dato che una
    // funzione non ha.
    const messaggioEsito = messaggioEsitoCandidatura({ nome: riga.nome }, sedeEsito)
    const invio = await sendEmailDetailed({
      to: email,
      subject: messaggioEsito.oggetto,
      text: messaggioEsito.testo,
      html: messaggioEsito.html,
    })
    esitoEmailInviato = invio.ok
    logEvento('candidatura', invio.ok ? 'info' : 'warn', {
      operazione,
      esito: invio.ok ? 'esito-inviato' : 'esito-non-inviato',
      canale: 'email',
      entita_tipo: TABELLA,
      entita_id: riga.id,
      sede_id: sedeCheDecide,
    }, invio.ok ? undefined : new Error(invio.error ?? 'motivo sconosciuto'))
    if (!invio.ok) {
      warnings.push(`Email di esito NON inviata: ${invio.error ?? 'motivo sconosciuto'}.`)
    }
  }

  logEvento('candidatura', 'info', {
    operazione,
    esito: 'candidatura-rifiutata',
    entita_tipo: TABELLA,
    entita_id: riga.id,
    sede_id: sedeCheDecide,
    motivo_presente: Boolean(motivo),
    email_inviata: esitoEmailInviato,
  })

  return NextResponse.json({
    success: true,
    id: riga.id,
    stato: 'rifiutata',
    esitoEmailInviato,
    warnings,
  })
}

