import { randomUUID } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { caricaPrefillAlunno, nucleoAlunno } from '@/lib/prestampati/prefill'
import { chiaveEtichetta, prestampatiPerRuolo, type VocePrestampato } from '@/lib/prestampati/registro'
import { modelloGenitore } from '@/lib/prestampati/modelli/genitore'
import { cartaDaDati, renderPrestampatoGenitore } from '@/lib/prestampati/render'
import { applicaCartaIntestata } from '@/lib/carta'
import { annoFiscale } from '@/lib/format/fiscal-date'
import {
  dataOraItaliana,
  formatNumeroProtocollo,
  righeSegnatura,
} from '@/lib/protocolli/segnatura'
import {
  ensureBucket,
  pathDefinitivi,
  sha256Impronta,
  slugNomeFile,
  PROTOCOLLO_BUCKET,
} from '@/lib/protocolli/store'
import { denominazioneScuola } from '@/lib/protocolli/server'
import {
  BUCKET_FASCICOLO,
  datiUscitaDaEvento,
  descrizioneArchivioProtocollata,
  dipendeDallUscita,
  garantisciBucketFascicolo,
  ilFileRestaNelBucket,
  motivoMancatoArchivioDa,
  motivoNonFirmabile,
  motivoNonGenerabile,
  type MotivoNonGenerabile,
  numeroProtocolloDaDescrizione,
  rifiutoDelRender,
  serveElencoDelegati,
  soloFamiglia,
  sconosciuto,
  voceDelGenitore,
  zSlug,
} from '@/app/api/parent/prestampati/banco-famiglia'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

/** Il tempo di aprire il file appena generato, non di girarlo. */
const TTL_LINK = 60

/**
 * GET /api/parent/prestampati — che cosa la FAMIGLIA può firmare, e con che cosa è
 * già compilato.
 *
 * È la porta di lettura del banco «genitore»: l'elenco dei modelli che il registro
 * dichiara suoi (`prestampatiPerRuolo('genitore')`), e — quando ne indica uno — i campi
 * che il form deve chiedere insieme al precompilato che l'app ha già in archivio.
 *
 * ─── DUE COSE CHE QUESTA ROTTA NON FA ────────────────────────────────────────────
 *
 * 1. **Non genera niente.** Nessun PDF, nessun numero di protocollo, nessuna riga
 *    d'archivio: quello è il PATCH di `parent/prestampati/firma`, che pretende la firma
 *    OTP. Una rotta di lettura che producesse il documento renderebbe la firma un
 *    passaggio facoltativo.
 * 2. **Non riscrive il perimetro della famiglia.** Lo chiude `requireParentOfStudent`,
 *    che sa la cosa che qui si sbaglierebbe: per un genitore lo scope è la FAMIGLIA e
 *    non la sede, perché due fratelli possono stare in due plessi diversi. Quella
 *    chiamata è anche l'unica risoluzione d'identità dell'handler — il ruolo si legge
 *    dall'utente che restituisce, non da un `requireUser` in più.
 *
 * ─── PERCHÉ IL RUOLO SI CONTROLLA LO STESSO ─────────────────────────────────────
 *
 * `requireParentOfStudent` verifica il legame di famiglia SOLO a chi è `genitore`; per
 * ogni altro ruolo applica lo scope di sede e lascia passare. Sta bene alle venti rotte
 * che serve — una segretaria il fascicolo del proprio plesso lo apre davvero — e NON sta
 * bene qui: gli otto modelli di questo elenco si firmano con l'OTP di chi li sottoscrive,
 * e il riquadro di firma stampa il nome della sessione che ha risposto al codice. Dallo
 * sportello quel nome sarebbe quello della segretaria, sotto una dichiarazione che
 * comincia con «il/la sottoscritto/a». La segreteria ha il suo pannello.
 *
 * ─── COSA NON ESCE DA QUI ───────────────────────────────────────────────────────
 *
 * I recapiti dell'ALTRO tutore. Il precompilato li porta (`DatiGenitore.telefono`,
 * `.email`) perché alcuni modelli li stampano sul foglio, ma il foglio lo compone il
 * server: farli passare anche dalla risposta JSON significherebbe mandare al browser di
 * un genitore il numero di telefono dell'altro per una comodità che nessuno ha chiesto.
 * Di qui escono nome e ruolo, che sono ciò che serve a sapere chi firma.
 */

const getQuerySchema = z.object({
  alunnoId: zUuid,
  /** Lo slug di UN modello, quando si sta per compilarlo. La forma è quella del banco. */
  slug: zSlug.optional(),
})

/**
 * Un delegato LETTO da `delegates`, come arriva da PostgREST.
 *
 * Il nome dice «letto» perché in questo repo di `delegates` si legge e basta: nessuna riga ci
 * nasce da nessuna parte, e il n. 08 — l'unico che le scriverebbe — oggi non si firma (la
 * scansione del documento di un terzo non ha una porta da cui entrare, vedi
 * `banco-famiglia.ts`). Quando quella porta esisterà, la riga da SCRIVERE nascerà insieme a
 * lei e avrà un nome suo: due contratti diversi sotto lo stesso nome si leggono sbagliati
 * saltando da un file all'altro.
 *
 * ⚠️ `document_number` NON SI LEGGE, ed è la disciplina della testata applicata anche qui: è
 * il numero del documento d'identità di un TERZO (la nonna, la vicina), e al form serve solo
 * per il n. 08 — che questa stessa rotta dichiara non firmabile. Al n. 09, l'unico modello che
 * i delegati li usa davvero, bastano l'id e il nome. Torna il giorno in cui il n. 08 torna
 * firmabile, insieme alla porta che gli manca.
 */
interface DelegatoLetto {
  id: string
  first_name: string | null
  last_name: string | null
  relation: string | null
}

export const GET = withRoute('parent/prestampati:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunnoId, slug } = q.data

    // ── IL GATE, UNO SOLO, E DÀ ANCHE L'UTENTE ──────────────────────────────────────
    //
    // `requireParentOfStudent` risolve l'identità (chiama `requireUser` al proprio
    // interno) E chiude la portata: per un genitore il perimetro è la FAMIGLIA — due
    // fratelli possono stare in due plessi diversi — e per ogni altro ruolo è lo scope di
    // sede. È il presidio delle venti rotte che leggono i dati di UN alunno indicato dal
    // client, e riscriverne qui la biforcazione vorrebbe dire due copie della stessa
    // regola di sicurezza su un documento che porta dati sanitari di un minore.
    //
    // Il RUOLO si legge dall'utente che il gate restituisce, invece di chiamare
    // `requireUser` per conto proprio: erano due risoluzioni identiche della stessa
    // identità nella stessa richiesta, e la seconda non aggiungeva niente.
    //
    // ⚠️ PERCHÉ IL GATE STA QUI E NON SOLO DENTRO `caricaPrefillAlunno`, che pure lo rifà.
    // Non è una cintura in più per scrupolo: è la difesa che il lock
    // `__tests__/architecture/isolamento-sede-coverage.test.ts` sa leggere. Il lock
    // riconosce i gate dal NOME della funzione chiamata dentro l'handler, e
    // `caricaPrefillAlunno` non è fra quelli — misurato togliendolo: l'handler diventa
    // «handler-senza-scope su `delegates`». Con questa riga il permesso di leggere i
    // delegati si vede accanto alla query che ne approfitta, che è esattamente ciò che il
    // lock pretende e ciò che serve a chi rilegge il file.
    const portata = await requireParentOfStudent(request, alunnoId)
    if (portata.response) return portata.response
    const utente = portata.user
    if (utente.role !== 'genitore') return soloFamiglia()

    // IL CANCELLO DELLO SLUG: uno slug che il banco «genitore» non ha è un 404, non un
    // elenco filtrato male. `document_type` finisce dentro `student_documents` e dentro il
    // nome del file nel bucket — una stringa scelta da chi chiama sarebbe una riga
    // d'archivio che nessun elenco della segreteria saprà più mostrare. Il cancello è quello
    // di `banco-famiglia`, lo stesso che usano il POST e il PATCH della firma.
    const disponibili = prestampatiPerRuolo('genitore')
    const scelto = slug ? voceDelGenitore(slug) : null
    if (slug && !scelto) return sconosciuto()

    const supabase = await createAdminClient()

    // Il precompilato porta i rifiuti già pronti per il bambino archiviato, anonimizzato o
    // senza sede: quelli non sono di competenza del gate.
    const esito = await caricaPrefillAlunno(request, supabase, alunnoId)
    if (esito.response) return esito.response
    const { prefill } = esito

    // ── IL REGISTRO DEGLI ACCESSI AL FASCICOLO ──────────────────────────────────────
    //
    // Regola 5 di `docs/prestampati/README.md`: «ogni lettura del fascicolo passa da
    // `fascicolo_accessi_audit`. Esiste già». Questa rotta l'anagrafica del bambino la legge
    // davvero — nome, data e luogo di nascita, codice fiscale, sezione, e per due modelli
    // anche i delegati al ritiro — quindi la riga ci va, come la scrive la strada gemella
    // dello sportello (`prestampati:GET`, `azione: 'view'`).
    //
    // DOPO i gate e dopo il precompilato, mai prima: si registra una lettura AVVENUTA, e una
    // riga scritta sopra un 403 racconterebbe un accesso che non c'è stato. `app_log` non è
    // un sostituto: ha trenta giorni di ritenzione e non è il registro che si mostra a chi
    // chiede chi ha aperto il fascicolo di suo figlio.
    //
    // `view` e non `list` anche per l'elenco: la portata è UN bambino in tutti e due i casi
    // — quello che cambia è se si sta preparando un modulo o guardando quali ci sono, e lo
    // dice `finalita`.
    await logAccessoFascicolo(supabase, {
      alunnoId: prefill.alunnoId,
      utenteId: utente.id,
      azione: 'view',
      finalita: scelto
        ? `Precompilato prestampato ${scelto.slug} (famiglia)`
        : 'Elenco prestampati della famiglia',
      request,
    })

    // ── I delegati al ritiro ────────────────────────────────────────────────────────
    //
    // Si leggono SOLO quando il modello scelto li usa (`opzioniDaApp: 'delegati_attivi'`
    // sul n. 09, `precompilatoDa: 'delegates'` sul n. 08). «Ciò che non si legge non si può
    // perdere»: su quindici modelli su diciassette quell'elenco non c'entra niente, e
    // caricarlo per comodità lo farebbe passare da ogni singola richiesta.
    //
    // La query sta QUI dentro e non in un helper di file, e non è una questione di stile:
    // è ancorata ad `alunnoId`, che il gate della famiglia ha appena verificato in questo
    // stesso handler. Fuori, quel legame non sarebbe più leggibile — né da chi rilegge il
    // file né dal lock `isolamento-sede-coverage`, che è la difesa che lo tiene fermo.
    //
    // ⚠️ «ATTIVI» QUI VUOL DIRE «PRESENTI», e va detto invece che lasciato dedurre:
    // `delegates` non ha una colonna di scadenza né di revoca — misurato sullo schema di
    // produzione il 2026-08-14 — quindi non c'è niente da filtrare. Il giorno in cui la
    // delega a termine dell'08 avrà la sua data, il filtro nasce qui.
    //
    // Il predicato sta in `banco-famiglia.ts` perché la stessa domanda se la pone il PATCH
    // della firma, che dalla scelta arrivata nelle risposte deve ricavare un nome: due porte,
    // una regola sola.
    const serveDelegati = scelto ? serveElencoDelegati(scelto.campi) : false

    let delegati: DelegatoLetto[] | null = null
    /**
     * ⚠️ IL FATTO VIAGGIA FINO AL CLIENT, e non basta la riga di log: a schermo un elenco
     * vuoto e un elenco non letto sono identici, e il n. 09 pretende l'id di un delegato per
     * chi non ritira di persona. Con la lettura fallita e un `[]` in risposta il genitore non
     * vedrebbe la nonna, sceglierebbe «io stesso» o abbandonerebbe, e nessuno saprebbe perché.
     *
     * Perciò due valori distinti: `delegati: null` + `delegatiNonLetti: true` per «non l'ho
     * potuto leggere» (il form chiede il nome a mano, che è il degrado previsto), `[]` per
     * «non ce ne sono». Non è un 503 perché il resto del modulo è preparato e valido: fermare
     * tutta la modulistica per un elenco accessorio sarebbe un rimedio più grande del guasto.
     */
    let delegatiNonLetti = false
    if (serveDelegati) {
      // PostgREST non lancia: il valore di ritorno va controllato, sempre.
      const { data: righe, error: erroreDelegati } = await supabase
        .from('delegates')
        .select('id, first_name, last_name, relation')
        .eq('student_id', alunnoId)
        .order('last_name', { ascending: true })
      if (erroreDelegati) {
        delegatiNonLetti = true
        logEvento(
          'modulistica',
          'warn',
          {
            operazione: 'parent/prestampati:GET',
            esito: 'delegati-non-letti',
            alunno_id: alunnoId,
            error_code: (erroreDelegati as { code?: string }).code ?? null,
          },
          erroreDelegati,
        )
      } else {
        delegati = (righe ?? []) as unknown as DelegatoLetto[]
      }
    }

    const dati = prefill.dati

    // ── L'USCITA PUBBLICATA PER LA SEZIONE DI QUESTO BAMBINO ────────────────────────
    //
    // È ciò che accende il n. 10, e prima del 2026-08-16 non lo accendeva niente: le gite
    // vivono in `eventi_agenda` (`tipo='uscita'`, scritte da `teacher/uscite:POST`) e
    // `DatiUscita` non lo costruiva nessuno in tutto il repo, quindi il modulo restava
    // spento anche quando la gita c'era davvero. Ora: **c'è un'uscita ⇒ il modulo compare,
    // con destinazione, data e orari veri dentro; non c'è ⇒ non compare affatto** (vedi il
    // filtro qui sotto). Un lucchetto su una gita che non esiste è una promessa a chi non
    // ha niente da firmare.
    //
    // La query sta QUI dentro e non in un helper di file, come quella dei delegati e per la
    // stessa ragione: è ancorata alla sezione di UN bambino, che il gate della famiglia ha
    // appena verificato in questo stesso handler.
    //
    // ⚠️ `gte('data', dataOggi)` e non «l'ultima creata»: un'autorizzazione si firma PRIMA
    // di partire, e la gita di marzo scorso non si autorizza più. `dataOggi` è la data
    // CIVILE italiana che il precompilato ha già calcolato — non `new Date()` del processo,
    // che su Vercel è UTC e a mezzanotte e mezza indicherebbe ieri.
    //
    // ⚠️ `visibile_genitori` è parte della domanda, non un filtro di comodo: un'uscita non
    // ancora annunciata alla famiglia non è un'uscita da autorizzare.
    let uscita = null
    let uscitaNonLetta = false
    if (prefill.sezioneId) {
      // PostgREST non lancia: il valore di ritorno va controllato, sempre.
      const { data: righeUscita, error: erroreUscita } = await supabase
        .from('eventi_agenda')
        .select('titolo, descrizione, data, orario_inizio, orario_fine')
        // La sede accanto alla sezione, e non è ridondanza: `eventi_agenda` ha una colonna
        // `scuola_id`, e una lettura che non la nomina è una lettura che si fida di un id
        // di sezione per sapere in quale plesso sta guardando. Con tre sedi in produzione
        // quella fiducia è ciò che il lock `isolamento-sede` esiste per non concedere.
        .eq('scuola_id', prefill.scuolaId)
        .eq('section_id', prefill.sezioneId)
        .eq('tipo', 'uscita')
        .eq('visibile_genitori', true)
        .gte('data', dati.dataOggi)
        .order('data', { ascending: true })
        .limit(1)
      if (erroreUscita) {
        // «Non l'ho potuto leggere» NON diventa «non c'è»: il modulo sparirebbe
        // dall'elenco proprio il giorno della gita, e nessuno collegherebbe le due cose.
        uscitaNonLetta = true
        logEvento(
          'modulistica',
          'warn',
          {
            operazione: 'parent/prestampati:GET',
            esito: 'uscita-non-letta',
            alunno_id: alunnoId,
            sezione_id: prefill.sezioneId,
            error_code: (erroreUscita as { code?: string }).code ?? null,
          },
          erroreUscita,
        )
      } else {
        uscita = datiUscitaDaEvento((righeUscita ?? [])[0])
      }
    }

    // ── QUELLO CHE È GIÀ IN ARCHIVIO, per modello ───────────────────────────────────
    //
    // Serve a due cose che prima non c'erano: far riscaricare SEMPRE i moduli già firmati
    // (05, 07, 09 — finora il PDF esisteva solo nell'istante della firma, dentro la
    // risposta 201, e chi chiudeva la pagina lo perdeva) e dire al POST se un certificato
    // per questo bambino esiste già, che è la regola del riscarico identico.
    //
    // ⚠️ NIENTE `document_type` DENTRO LA QUERY, ed è la riga che tiene in piedi la CI: il
    // DB E2E non è migrato, e `.in('document_type', [...i diciassette slug])` con
    // un'enumerazione che quei valori non li ha risponde `22P02` — cioè l'elenco della
    // famiglia diventerebbe un 503 su un ambiente dove tutto il resto funziona. Si legge
    // ciò che quel bambino ha e si filtra in TypeScript, dove uno slug è una stringa.
    const archiviati = new Map<string, { id: string; creatoIl: string | null; protocollo: string | null }>()
    // PostgREST non lancia: il valore di ritorno va controllato, sempre.
    //
    // `descrizione` entra nella `select` perché è l'unico posto in cui vive il numero di
    // protocollo del documento archiviato: `student_documents` non ha una colonna per il
    // protocollo (schema di produzione, 2026-08-16). Vedi `descrizioneArchivioProtocollata`.
    // Sul DB E2E non migrato una colonna che manca risponde `42703`, e questa lettura
    // degrada già: l'elenco esce lo stesso, senza i pulsanti «Scarica».
    const { data: righeArchivio, error: erroreArchivio } = await supabase
      .from('student_documents')
      .select('id, document_type, descrizione, created_at')
      .eq('student_id', alunnoId)
      .order('created_at', { ascending: false })
    if (erroreArchivio) {
      // Non ferma l'elenco: senza, i pulsanti «Scarica» non compaiono e la compilazione
      // resta possibile. Ciò che non può succedere è che passi in silenzio.
      logEvento(
        'modulistica',
        'warn',
        {
          operazione: 'parent/prestampati:GET',
          esito: 'archivio-non-letto',
          alunno_id: alunnoId,
          error_code: (erroreArchivio as { code?: string }).code ?? null,
        },
        erroreArchivio,
      )
    } else {
      for (const riga of (righeArchivio ?? []) as unknown as {
        id: string
        document_type: string | null
        descrizione: string | null
        created_at: string | null
      }[]) {
        const tipo = riga.document_type?.trim()
        // `order` è discendente: la prima riga di ogni tipo è la più recente, e le altre
        // non la sostituiscono. È il documento che il genitore riscarica.
        if (tipo && !archiviati.has(tipo)) {
          archiviati.set(tipo, {
            id: riga.id,
            creatoIl: riga.created_at,
            protocollo: numeroProtocolloDaDescrizione(riga.descrizione),
          })
        }
      }
    }

    // Niente uscita ⇒ il n. 10 non compare AFFATTO. Se la lettura è fallita si lascia
    // com'era (`uscitaNonLetta`): togliere una voce per un guasto di lettura vorrebbe dire
    // dire alla famiglia «non c'è nessuna gita» quando la risposta vera è «non lo so».
    const elencoModelli = disponibili.filter(
      (v) => !dipendeDallUscita(v.slug) || uscita !== null || uscitaNonLetta,
    )

    logEvento('modulistica', 'info', {
      operazione: 'parent/prestampati:GET',
      esito: 'elenco-servito',
      alunno_id: alunnoId,
      utente: utente.id,
      tipo: scelto?.slug ?? 'elenco',
      n: elencoModelli.length,
    })

    return NextResponse.json({
      success: true,
      alunno: { id: prefill.alunnoId, ...nucleoAlunno(prefill) },
      sede: {
        nome: dati.sede.scuola_nome,
        citta: dati.sede.scuola_citta,
      },
      annoScolastico: dati.annoScolastico,
      dataOggi: dati.dataOggi,
      // Solo nome e ruolo: i recapiti restano al server (vedi la testata).
      genitori: dati.genitori.map((g) => ({ nomeCompleto: g.nomeCompleto, ruolo: g.ruolo ?? null })),
      richiedente: dati.richiedente
        ? { nomeCompleto: dati.richiedente.nomeCompleto, ruolo: dati.richiedente.ruolo ?? null }
        : null,
      /**
       * L'uscita che il n. 10 autorizza, quando c'è: destinazione, data e orari REALI.
       *
       * Esce dalla risposta perché il genitore deve vedere che cosa sta per autorizzare
       * PRIMA di aprire il modulo — sul foglio ci finisce comunque, ma un modulo che si
       * apre senza dire dove va il bambino si firma alla cieca. Niente id dell'evento e
       * niente descrizione integrale: quella porta anche accompagnatori e quota, che sono
       * dati di servizio della sezione e non servono a questa schermata.
       */
      uscita: uscita
        ? {
            destinazione: uscita.destinazione,
            data: uscita.data,
            oraPartenza: uscita.oraPartenza ?? null,
            oraRientro: uscita.oraRientro ?? null,
          }
        : null,
      modelli: elencoModelli.map((v) => {
        /**
         * ⚠️ `firmabileOra` DICE CIÒ CHE IL PATCH PRETENDE DAVVERO, non solo chi sottoscrive.
         *
         * Chi guarda il solo requisito di firma spegne i due certificati (che li firma il
         * legale rappresentante) e accende tutti gli altri sei — ma due di quei sei il PATCH
         * non li genera mai:
         *
         *  · il **n. 10** vuole i dati dell'uscita, che nessun punto del repo costruisce —
         *    l'uscita la pubblica la segreteria, e quella strada non esiste ancora;
         *  · il **n. 08** vuole due sottoscrizioni quando in anagrafica ci sono due tutori,
         *    e la raccolta della seconda firma non c'è: su questo bambino la risposta
         *    dipende dal precompilato, ed è per questo che `dati` entra nel verdetto.
         *
         * `motivoNonFirmabile()` è la stessa funzione con cui il POST decide se spedire il
         * codice e il PATCH se comporre il foglio: una regola valida per tre strade vive in
         * un posto solo. Il motivo esce accanto al booleano perché un pulsante spento deve
         * poter dire perché — è un enumerato, non prosa da tradurre.
         *
         * Le due lacune (uscite create dalla segreteria, raccolta della seconda firma) sono
         * segnalate all'orchestratore: sono funzioni che mancano, non casi limite.
         */
        const motivo = motivoNonFirmabile(v, dati)
        /**
         * ⚠️ IL SECONDO VERDETTO, e risponde a una domanda diversa: non «questa famiglia lo
         * può firmare?» ma «la Scuola lo può emettere, per QUESTO bambino, adesso?».
         *
         * 🔴 Serve perché il Bonus Nido offriva a chiunque un pulsante `primary` che per la
         * maggioranza dei bambini non poteva funzionare — sulla sede di Giugliano la
         * maggioranza non è al nido — e il rifiuto del server arrivava 777 px fuori dallo
         * schermo di un telefono: al genitore sembrava che il clic non avesse fatto niente.
         * Il rifiuto era però prevedibile qui, senza chiedere niente: il precompilato porta
         * già livello, sede e legale rappresentante. `motivoNonGenerabile()` è la STESSA
         * funzione che il POST usa per rifiutare con un 422, così la scheda non può accendere
         * un pulsante che la rotta respinge.
         */
        const motivoEmissione = motivoNonGenerabile(v, dati, prefill.legaleRappresentante)
        const archiviato = archiviati.get(v.slug) ?? null
        return {
          slug: v.slug,
          etichetta: v.etichetta,
          chiaveEtichetta: chiaveEtichetta(v.slug),
          firma: v.firma,
          soggetto: v.soggetto,
          protocollo: v.protocollo,
          archiviazione: v.archiviazione,
          firmabileOra: motivo === null,
          motivoNonFirmabile: motivo,
          /**
           * `true` solo sui due certificati, e solo quando il POST li emetterebbe davvero.
           * Sugli altri sei è `false` con `motivoNonGenerabile: null` — «non è roba tua»,
           * che è diverso da «non si può»: quelli nascono dalla firma.
           */
          generabileOra: v.firma === 'legale_rappresentante' && motivoEmissione === null,
          motivoNonGenerabile: motivoEmissione,
          /**
           * Il documento già nel fascicolo, quando c'è: è ciò che rende i moduli firmati
           * riscaricabili SEMPRE e non solo nell'istante della firma. L'id serve al POST
           * per riconsegnare **lo stesso file** — sui due certificati vuol dire anche lo
           * stesso numero di protocollo, che è la regola del riscarico (§4.3).
           */
          documentoArchiviatoId: archiviato?.id ?? null,
          documentoArchiviatoIl: archiviato?.creatoIl ?? null,
          /**
           * QUALE numero riconsegna il riscarico. Il pannello promette «lo stesso numero di
           * protocollo» e fino al 2026-08-16 non diceva quale: per sapere se il foglio che
           * stava per mandare all'INPS era il 5 o il 6, il genitore doveva aprire il PDF.
           * `null` sui sei moduli firmati, che un numero non ce l'hanno.
           */
          protocolloArchiviato: archiviato?.protocollo ?? null,
        }
      }),
      // I campi escono TALI E QUALI dal registro: portano già `opzioniDaApp`,
      // `precompilatoDa` e `mostraSe`, che sono il modo in cui il form sa che cosa fare
      // dell'elenco `delegati` qui sotto. Rimaneggiarli qui creerebbe una seconda
      // descrizione del modulo accanto a quella dei modelli.
      modello: scelto
        ? {
            slug: scelto.slug,
            etichetta: scelto.etichetta,
            chiaveEtichetta: chiaveEtichetta(scelto.slug),
            firma: scelto.firma,
            campi: scelto.campi,
          }
        : null,
      // Id, nome e relazione: è tutto ciò che serve a scegliere chi ritira il bambino. Il
      // numero del documento del delegato resta al server — vedi `DelegatoLetto`.
      delegati: delegati
        ? delegati.map((d) => ({
            id: d.id,
            nomeCompleto: [d.last_name, d.first_name].filter(Boolean).join(' ').trim(),
            relazione: d.relation,
          }))
        : null,
      /**
       * `true` SOLO quando l'elenco c'era da leggere e la lettura è fallita: è ciò che
       * distingue «questo bambino non ha delegati» (`delegati: []`) da «non lo sappiamo»
       * (`delegati: null` con questo vero). Per i quindici modelli che i delegati non li
       * usano resta `false` con `delegati: null`, che vuol dire «non chiesto».
       */
      delegatiNonLetti,
    })
  } catch (err) {
    // Il messaggio interno resta nel LOG e non torna al chiamante: su una rotta che
    // apparecchia moduli sanitari di un minore, il testo di un'eccezione può nominare
    // tabelle, colonne e vincoli.
    logErrore({ operazione: 'parent/prestampati:GET', stato: 503 }, err)
    return NextResponse.json(
      {
        error:
          'Non è stato possibile preparare la modulistica. Riprova fra qualche minuto.',
        codice: 'PRESTAMPATO_ANAGRAFICA_NON_LETTA',
      },
      { status: 503 },
    )
  }
})

// ─── POST: il certificato che la famiglia si prende da sé ───────────────────────

/**
 * POST /api/parent/prestampati — «dammi il documento di questo modello per questo
 * bambino», e la risposta è **sempre lo stesso file** finché il genitore non ne chiede
 * uno nuovo.
 *
 * ─── LA REGOLA, TESTUALE DAL TITOLARE ───────────────────────────────────────────
 *
 * > «Una volta che il genitore ha scaricato il suo certificato, quel certificato resta
 * > salvato, e quando lo va a riprendere riscarica sempre lo stesso.»
 *
 * Quindi: se nel fascicolo c'è già un documento di quel tipo, si riconsegna **quello** —
 * stesso PDF, stesso numero di protocollo, **nessuna riga nuova in `protocolli`**. Il
 * registro è WORM e un numero consumato non torna indietro: rigenerare a ogni download
 * vorrebbe dire bruciare un numero ogni volta che qualcuno tocca «Scarica». `nuovo: true`
 * è il gesto esplicito che ne emette un altro, e ha il suo pulsante secondario.
 *
 * ─── TRE COSE CHE QUESTA ROTTA FA, E UNA CHE NON FA ─────────────────────────────
 *
 *  1. **riconsegna** ciò che è già in archivio (vale per tutti e otto i modelli: è ciò che
 *     rende i moduli firmati — 05, 07, 09 — riscaricabili sempre, e non solo nell'istante
 *     della firma, dove il PDF viveva dentro la risposta 201 e chi chiudeva la pagina lo
 *     perdeva);
 *  2. **genera** i due certificati (26·27 e 28), che li sottoscrive il legale
 *     rappresentante e non la famiglia: carta intestata, numero di protocollo in USCITA,
 *     segnatura, archiviazione nel fascicolo;
 *  3. **non firma niente**: la firma OTP è di `parent/prestampati/firma`, e un modulo che
 *     la pretende e non è ancora in archivio esce di qui con un 409 che lo dice.
 *
 * Ciò che NON fa: generare i sei moduli della famiglia. Quelli nascono dalla firma, e
 * comporli qui vorrebbe dire un secondo modo di produrre lo stesso foglio — senza firma,
 * quindi senza valore, con lo stesso `document_type` nel fascicolo di un minore.
 *
 * ─── PERCHÉ IL PROTOCOLLO È IN QUESTA ROTTA E NON IN QUELLA DELLO SPORTELLO ─────
 *
 * `prestampati/genera:POST` fa la stessa sequenza per la segreteria, ed è la sua gemella:
 * le due si somigliano riga per riga (numero → render → carta e segnatura → upload → riga
 * di registro) perché la specifica impone quell'ordine, non perché una copi l'altra. Ciò
 * che le rende due rotte è il gate — là `requireDocente` e `resolveScuolaScrittura`, qui la
 * portata sulla FAMIGLIA, che non è la sede: due fratelli possono stare in due plessi
 * diversi, e la sede la dichiara il precompilato del bambino, non la sessione del genitore.
 * La casa comune sarebbe `src/app/api/prestampati/banco.ts`, che è di un'altra mano e si
 * sta scrivendo in parallelo: dichiarato all'orchestratore fra le modifiche da fare fuori.
 */

const postBodySchema = z.object({
  alunnoId: zUuid,
  slug: zSlug,
  /**
   * «Generane uno nuovo»: emette data e protocollo nuovi, consapevolmente.
   *
   * Il valore predefinito è `false` e non è una comodità: un client che dimentica il campo
   * deve ottenere il RISCARICO, non un numero di protocollo bruciato. La direzione in cui
   * si sbaglia si sceglie qui.
   */
  nuovo: z.boolean().optional().default(false),
})

/** I modelli che questa rotta sa GENERARE: quelli che sottoscrive la Scuola. */
function generabileDallaFamiglia(voce: VocePrestampato): boolean {
  return voce.firma === 'legale_rappresentante' && voce.protocollo === 'uscita'
}

/**
 * La frase italiana di ciascun rifiuto d'emissione, per il campo `error`.
 *
 * ⚠️ IL CLIENT NON LA USA, e non è ridondanza: l'app è bilingue, quindi la scheda traduce
 * l'enumerato `motivo` dal proprio catalogo (`CHIAVE_MOTIVO_CERTIFICATO`). Questa resta per
 * chi la risposta la legge nuda — un log, una prova con `curl`, un client futuro — perché un
 * 422 con il solo codice non si capisce, e un errore che non si capisce si riapre due volte.
 */
const SPIEGAZIONE_NON_GENERABILE: Record<MotivoNonGenerabile, string> = {
  'legale-rappresentante-assente':
    'Nelle impostazioni della sede manca il nome del legale rappresentante: il certificato non si può firmare.',
  'livello-non-nido':
    'Il certificato per il Bonus Asilo Nido si rilascia solo a un bambino iscritto al nido.',
  'autorizzazione-nido-mancante':
    'Gli estremi dell’autorizzazione al funzionamento del nido non sono configurati per questa sede: il certificato non si emette.',
}

export const POST = withRoute('parent/prestampati:POST', async (request: NextRequest) => {
  try {
    // ── PRIMO GIRO: chi sei, e prima del corpo ─────────────────────────────────────
    //
    // Regola R2 del lock `corpo-letto-dopo-il-gate`: un handler che ha un gate lo chiama
    // PRIMA di leggere il corpo. Qui `requireUser` serve anche a dare il ruolo, perché
    // `requireParentOfStudent` lascia passare lo staff con lo scope di sede — e questi
    // certificati li emette lo sportello dalla sua rotta, con il suo operatore in calce.
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    if (auth.user.role !== 'genitore') return soloFamiglia()
    const parentId = auth.user.id

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { alunnoId, slug, nuovo } = b.data

    const voce = voceDelGenitore(slug)
    if (!voce) return sconosciuto()

    // ── SECONDO GIRO: di quale bambino ─────────────────────────────────────────────
    //
    // È il presidio che `isolamento-sede-coverage` riconosce, ed è la portata vera: per un
    // genitore lo scope è la FAMIGLIA e non la sede. Senza, un id altrui farebbe uscire il
    // certificato di iscrizione di un bambino qualsiasi — con nome, data di nascita e
    // codice fiscale dentro.
    const portata = await requireParentOfStudent(request, alunnoId)
    if (portata.response) return portata.response

    const supabase = await createAdminClient()

    // Il precompilato porta i rifiuti già pronti per il bambino archiviato, anonimizzato o
    // senza sede: un certificato su un bambino che quest'anno non frequenta è una
    // dichiarazione falsa su carta intestata, diretta a un datore di lavoro o all'INPS.
    const esitoPrefill = await caricaPrefillAlunno(request, supabase, alunnoId)
    if (esitoPrefill.response) return esitoPrefill.response
    const { prefill } = esitoPrefill

    // ── 1. IL RISCARICO: prima di tutto, e prima di toccare la numerazione ──────────
    //
    // La query sta QUI e non in un helper di file: è ancorata ad `alunnoId`, che il gate
    // della famiglia ha appena verificato in questo stesso handler. E niente
    // `document_type` dentro la query, per la stessa ragione dell'elenco qui sopra: sul DB
    // E2E non migrato un valore fuori dall'enumerazione risponde `22P02`.
    let documentoInArchivio: { id: string; storage_path: string | null; descrizione: string | null } | null =
      null
    if (!nuovo) {
      // PostgREST non lancia: il valore di ritorno va controllato, sempre.
      const { data: righe, error: erroreLettura } = await supabase
        .from('student_documents')
        .select('id, document_type, storage_path, descrizione, created_at')
        .eq('student_id', alunnoId)
        .order('created_at', { ascending: false })
      if (erroreLettura) {
        // ⚠️ QUI NON SI PROSEGUE, e su una rotta che genera è la scelta che conta: «non so
        // se ce n'è già uno» + «genero» = un secondo numero di protocollo bruciato su un
        // registro WORM per un guasto di lettura. Meglio un 503 che si ritenta.
        logEvento(
          'modulistica',
          'error',
          {
            operazione: 'parent/prestampati:POST',
            esito: 'archivio-non-letto',
            entita_tipo: 'student_documents',
            tipo: voce.slug,
            alunno_id: alunnoId,
            error_code: (erroreLettura as { code?: string }).code ?? null,
          },
          erroreLettura,
        )
        return NextResponse.json(
          {
            error:
              'Non è stato possibile leggere i documenti già archiviati: riprova fra qualche minuto.',
            codice: 'PRESTAMPATO_ANAGRAFICA_NON_LETTA',
          },
          { status: 503 },
        )
      }
      documentoInArchivio =
        ((righe ?? []) as unknown as {
          id: string
          document_type: string | null
          storage_path: string | null
          descrizione: string | null
        }[]).find((r) => r.document_type?.trim() === voce.slug) ?? null
    }

    if (documentoInArchivio?.storage_path) {
      const { data: link, error: erroreLink } = await supabase.storage
        .from(BUCKET_FASCICOLO)
        .createSignedUrl(documentoInArchivio.storage_path, TTL_LINK)
      if (erroreLink || !link?.signedUrl) {
        // L'API dello storage non lancia: ritorna `{ data, error }`. Senza questa riga
        // «il documento c'è ma non si apre» non lascerebbe traccia da nessuna parte.
        logEvento(
          'storage',
          'error',
          {
            operazione: 'parent/prestampati:POST',
            esito: 'link-non-firmato',
            bucket: BUCKET_FASCICOLO,
            tipo: voce.slug,
            alunno_id: alunnoId,
            documento_id: documentoInArchivio.id,
          },
          erroreLink,
        )
        return NextResponse.json(
          {
            error:
              'Il documento è archiviato ma non si è riusciti ad aprirlo: riprova fra qualche minuto.',
            codice: 'PRESTAMPATO_NON_GENERATO',
          },
          { status: 503 },
        )
      }

      /**
       * IL NUMERO CHE SI STA RICONSEGNANDO, riletto dalla descrizione già selezionata.
       *
       * La query lo aveva in mano e lo buttava via: la risposta diceva `protocollo: null`
       * mentre la riga d'archivio portava `… — Prot. n. 0000005/2026`. Il pannello promette
       * «riscarica sempre lo stesso certificato, con lo stesso numero di protocollo» e poi
       * non diceva QUALE — cioè una promessa lasciata a metà su un foglio che va all'INPS.
       *
       * `null` resta una risposta legittima: i sei moduli firmati dalla famiglia si
       * archiviano con la sola etichetta, e un numero non ce l'hanno.
       */
      const protocolloRiuso = numeroProtocolloDaDescrizione(documentoInArchivio.descrizione)

      // Il SUCCESSO si logga: con i soli errori «nessun log» non distingue «i riscarichi
      // funzionano» da «non ne è mai partito uno». `riuso: true` è ciò che si conta in SQL
      // per sapere quante volte un numero di protocollo NON è stato bruciato.
      logEvento('modulistica', 'info', {
        operazione: 'parent/prestampati:POST',
        esito: 'documento-riconsegnato',
        tipo: voce.slug,
        utente: parentId,
        alunno_id: alunnoId,
        scuola_id: prefill.scuolaId,
        documento_id: documentoInArchivio.id,
      })

      await logAccessoFascicolo(supabase, {
        alunnoId,
        utenteId: parentId,
        azione: 'download',
        documentoId: documentoInArchivio.id,
        finalita: `Riscarico ${voce.slug} (famiglia)`,
        request,
      })

      return NextResponse.json({
        success: true,
        /** `true` quando il file è quello di prima: nessun numero nuovo, nessuna riga nuova. */
        riuso: true,
        /** Il file c'era già: per definizione è in archivio, e il client non deve avvisare. */
        archiviato: true,
        documentoId: documentoInArchivio.id,
        titolo: voce.etichetta,
        url: link.signedUrl,
        protocollo: protocolloRiuso,
      })
    }

    // ── 2. NON C'È NIENTE DA RICONSEGNARE: si genera, ma solo ciò che si può ────────
    //
    // I sei moduli della famiglia nascono dalla FIRMA. Un 409 con
    // `PRESTAMPATO_FIRMA_NON_VALIDA`, la cui frase di catalogo dice esattamente questo —
    // «la firma non risulta raccolta o non è valida: il documento non si genera prima
    // della firma» — invece di un 404 che manderebbe a cercare un modulo che c'è.
    if (!generabileDallaFamiglia(voce)) {
      return NextResponse.json(
        {
          error:
            'Questo modulo si ottiene firmandolo: finché non è firmato non c’è nessun documento da scaricare.',
          codice: 'PRESTAMPATO_FIRMA_NON_VALIDA',
        },
        { status: 409 },
      )
    }

    // ── 2bis. I MOTIVI CHE SI CONOSCONO PRIMA DEL REGISTRO ─────────────────────────
    //
    // Tutti e tre si vedono senza comporre niente, e stanno qui perché un numero di
    // protocollo non si brucia per un motivo che si sapeva già. Il render li rifiuterebbe
    // comunque (`verificaContesto` del n. 28, `componiFirma` di `render.ts`) — ma il suo
    // rifiuto è prosa italiana dentro `errori[]`, e questa risposta arriva a un'app
    // BILINGUE: di qui esce un `motivo` ENUMERATO, che il client traduce.
    //
    // ⚠️ 422 CON UN MOTIVO LEGGIBILE, MAI UN 500. Senza gli estremi dell'autorizzazione al
    // funzionamento, per esempio, il Bonus Nido uscirebbe con «N. ______ del ______»: un
    // documento che l'INPS rifiuta e che la famiglia scopre di non avere quando le serve.
    //
    // Il verdetto lo dà `motivoNonGenerabile()`, che è la stessa funzione con cui il GET
    // spegne la scheda e ci scrive sopra il perché: se le due divergessero, il pannello
    // accenderebbe un pulsante che questa rotta rifiuta — che è il difetto misurato il
    // 2026-08-16, con il rifiuto disegnato fuori dallo schermo.
    const motivoEmissione = motivoNonGenerabile(voce, prefill.dati, prefill.legaleRappresentante)
    if (motivoEmissione) {
      // Configurazione mancante = livello `error`, mai `info` (AGENTS.md §4). Il livello
      // non è per motivo: `livello-non-nido` NON è una configurazione mancante — è una
      // proprietà del bambino, e un `error` per ogni famiglia dell'infanzia che tocca quel
      // certificato riempirebbe il canale dei guasti di cose che funzionano.
      if (motivoEmissione !== 'livello-non-nido') {
        logEvento('config', 'error', {
          operazione: 'parent/prestampati:POST',
          esito:
            motivoEmissione === 'legale-rappresentante-assente'
              ? 'legale-rappresentante-non-configurato'
              : 'autorizzazione-nido-non-configurata',
          tipo: voce.slug,
          scuola_id: prefill.scuolaId,
        })
      }
      return NextResponse.json(
        { error: SPIEGAZIONE_NON_GENERABILE[motivoEmissione], codice: 'PRESTAMPATO_DATI_MANCANTI', motivo: motivoEmissione },
        { status: 422 },
      )
    }

    const modello = modelloGenitore(voce.slug)
    // Difensivo: registro e modelli sono due file diversi, e un modello del genitore che
    // fosse nel registro e non fra i modelli genererebbe un 500 nudo invece di un 404.
    if (!modello) return sconosciuto()

    // ── 3. IL NUMERO, e da qui in poi è consumato ──────────────────────────────────
    //
    // ⚠️ LA PROVA A VUOTO PRIMA DELLA NUMERAZIONE, come la gemella dello sportello: il
    // render si chiama una volta in più con `copiaFamiglia` — l'altra forma legittima
    // dello stesso foglio (§4.1), che un numero non lo chiede — solo per vedere se quel
    // foglio sarebbe generabile. Un rifiuto DOPO la numerazione lascerebbe un buco in un
    // registro WORM, e i buchi non si richiudono. Quei byte si buttano.
    const opzioniBase = {
      carta: cartaDaDati(prefill.dati),
      legaleRappresentante: prefill.legaleRappresentante,
    }
    const prova = renderPrestampatoGenitore(modello, prefill.dati, {}, {
      ...opzioniBase,
      copiaFamiglia: true,
    })
    if (!prova.ok) return rifiutoDelRender(prova)

    // ── 2ter. IL MAGAZZINO PRIMA DEL NUMERO ────────────────────────────────────────
    //
    // 🔴 IL DIFETTO MISURATO IN PRODUZIONE IL 2026-08-16, e la riga che lo chiude.
    // `sensitive_documents` non esisteva (`storage.buckets`: quattordici righe, nessuna era
    // quella) e questa rotta caricava lo stesso: due POST identici del certificato hanno
    // risposto **201** con `documentoId: null`, non hanno lasciato nessuna riga in
    // `student_documents` e hanno consumato **due numeri di protocollo** — il 3 e il 4,
    // stesso bambino, stesso oggetto, a settanta secondi di distanza. Poi il fascicolo è
    // rimasto vuoto, quindi il POST successivo non trovava niente da riconsegnare e ne
    // bruciava un altro: la regola §4.3 («riscarica sempre lo stesso, stesso numero,
    // nessuna riga nuova») era disattesa sul 100% dei download.
    //
    // La regola è una riga sola: **un numero non si consuma se il magazzino in cui il foglio
    // deve finire non c'è.** Perciò qui, prima della RPC, e non tre passi più giù dove
    // l'upload se ne accorgerebbe a numero già speso.
    //
    // Il 503 e non un 500: è un guasto dell'infrastruttura, si ritenta, e nel frattempo il
    // registro non si è mosso. La causa — col corpo dell'errore del provider — l'ha già
    // registrata `garantisciBucketFascicolo`.
    if (!(await garantisciBucketFascicolo(supabase, 'parent/prestampati:POST'))) {
      logEvento('modulistica', 'error', {
        operazione: 'parent/prestampati:POST',
        esito: 'fascicolo-non-disponibile',
        tipo: voce.slug,
        alunno_id: alunnoId,
        scuola_id: prefill.scuolaId,
      })
      return NextResponse.json(
        {
          error:
            'L’archivio della scuola non è raggiungibile: il certificato non è stato generato. Riprova fra qualche minuto.',
          codice: 'PRESTAMPATO_NON_GENERATO',
        },
        { status: 503 },
      )
    }

    const anno = annoFiscale()
    const { data: numeroGrezzo, error: erroreNumero } = await supabase.rpc(
      'prossimo_numero_protocollo',
      { p_scuola: prefill.scuolaId, p_anno: anno },
    )
    if (erroreNumero) {
      // PostgREST non lancia: senza questo ramo si proseguirebbe con `numero = NaN`.
      logErrore(
        {
          operazione: 'parent/prestampati:POST',
          evento: `protocollo-numero:${(erroreNumero as { code?: string }).code ?? 'ignoto'}`,
        },
        erroreNumero,
      )
      return protocolloNonRiuscito()
    }
    const numero = Number(numeroGrezzo)
    if (!Number.isInteger(numero) || numero < 1) {
      logEvento('modulistica', 'error', {
        operazione: 'parent/prestampati:POST',
        esito: 'protocollo-numero-non-valido',
        scuola_id: prefill.scuolaId,
      })
      return protocolloNonRiuscito()
    }

    const quando = new Date()
    const numeroFormattato = formatNumeroProtocollo(numero, anno)
    const reso = renderPrestampatoGenitore(modello, prefill.dati, {}, {
      ...opzioniBase,
      protocollo: { numero: numeroFormattato, data: dataOraItaliana(quando).data },
    })
    if (!reso.ok) {
      // Il numero è già consumato: resta un buco nella numerazione, che è il rischio
      // dichiarato dal design del registro. Va però LOGGATO, perché un buco senza
      // spiegazione, fra sei mesi, è una domanda a cui nessuno sa rispondere.
      logEvento('modulistica', 'warn', {
        operazione: 'parent/prestampati:POST',
        esito: 'protocollo-bruciato-render-fallito',
        tipo: voce.slug,
        scuola_id: prefill.scuolaId,
        protocollo_numero: numero,
        protocollo_anno: anno,
      })
      return rifiutoDelRender(reso)
    }

    // ── 4. LA CARTA DELLA SCUOLA E LA SEGNATURA, IN UNA PASSATA SOLA ───────────────
    //
    // `applicaSegnatura()` no: quella stende una fascia verde in cima al foglio e su carta
    // intestata finirebbe **sopra il marchio della scuola**, con un secondo logo sopra il
    // primo. Resta il timbro dei documenti ACQUISITI, che arrivano su un foglio bianco.
    //
    // Da qui in giù il documento È questo: quello che si consegna, quello che si archivia
    // e quello di cui si registra l'impronta sono lo stesso file — quindi il riquadro di
    // verifica stampato in fondo («l'impronta SHA-256 di QUESTO documento è registrata nel
    // registro di protocollo») è vero per chi il foglio ce l'ha in mano.
    const denominazione = await denominazioneScuola(supabase, prefill.scuolaId)
    const pdf = await applicaCartaIntestata(reso.pdf, {
      segnatura: {
        righe: righeSegnatura({ denominazione, numero, anno, tipo: 'uscita', quando }),
      },
    })

    // ── 5. I due depositi, e l'ordine ──────────────────────────────────────────────
    //
    // Prima il bucket del PROTOCOLLO con la sua riga di registro (il documento esce dalla
    // scuola: senza la riga, il numero stampato sul foglio non lo conferma nessuno), poi
    // il fascicolo del bambino. Se il registro non riesce, non si consegna niente: un
    // certificato in uscita senza la sua riga è un foglio che dichiara un numero che nessun
    // registro conferma.
    const percorsi = pathDefinitivi(prefill.scuolaId, anno, numero)
    const pathOriginale = percorsi.originale('pdf')
    const caricati: string[] = []
    await ensureBucket(supabase)
    try {
      for (const path of [pathOriginale, percorsi.timbrato]) {
        const { error } = await supabase.storage
          .from(PROTOCOLLO_BUCKET)
          .upload(path, Buffer.from(pdf), { contentType: 'application/pdf', upsert: true })
        // Il CORPO dell'errore, non solo il suo codice: `403` non dice niente,
        // `403 "new row violates row-level security policy"` dice tutto.
        if (error) throw new Error(`Archiviazione protocollo non riuscita: ${error.message}`)
        caricati.push(path)
      }

      const { error: erroreInsert } = await supabase.from('protocolli').insert({
        scuola_id: prefill.scuolaId,
        anno,
        numero,
        tipo: 'uscita',
        data_registrazione: quando.toISOString(),
        oggetto: `${voce.etichetta} — ${prefill.dati.alunno.cognome} ${prefill.dati.alunno.nome}`.trim(),
        // Il foglio lo prende la FAMIGLIA, che se lo è generato da sé: il destinatario è
        // il genitore richiedente, il mezzo è l'app. Scrivere «INPS» sarebbe una
        // supposizione su che cosa il genitore ne farà, su una riga WORM.
        destinatario:
          prefill.dati.richiedente?.nomeCompleto?.trim() || 'Genitore/tutore richiedente',
        mezzo: 'Scaricato dall’area famiglia',
        impronta_sha256: sha256Impronta(pdf),
        file_originale: pathOriginale,
        file_timbrato: percorsi.timbrato,
        file_nome_originale: `${slugNomeFile(reso.titolo)}.pdf`,
        file_mime: 'application/pdf',
        file_size: pdf.byteLength,
        created_by: parentId,
      })
      // PostgREST non lancia: il `throw` lo scrive questa riga, perché il rollback dei
      // file vive nel `catch`. Il CORPO dell'errore, non solo il codice.
      if (erroreInsert) throw new Error(`Registrazione a protocollo non riuscita: ${erroreInsert.message}`)
    } catch (err) {
      // Rollback best-effort dei soli FILE. Un file orfano nel bucket è molto meglio di
      // una riga di registro che punta a un file che non c'è.
      logErrore({ operazione: 'parent/prestampati:POST', evento: 'protocollo-non-registrato' }, err)
      for (const path of caricati) {
        const { error } = await supabase.storage.from(PROTOCOLLO_BUCKET).remove([path])
        if (error) {
          logEvento(
            'storage',
            'error',
            {
              operazione: 'parent/prestampati:POST',
              esito: 'protocollo-file-non-rimosso',
              bucket: PROTOCOLLO_BUCKET,
              tipo: voce.slug,
            },
            error,
          )
        }
      }
      return protocolloNonRiuscito()
    }

    // ── 6. Il fascicolo del bambino: è la copia che il genitore riscarica ──────────
    const percorsoFascicolo = `${alunnoId}/prestampati/${voce.slug}-${randomUUID()}.pdf`
    const { error: erroreUpload } = await supabase.storage
      .from(BUCKET_FASCICOLO)
      .upload(percorsoFascicolo, Buffer.from(pdf), {
        contentType: 'application/pdf',
        upsert: false,
      })
    if (erroreUpload) {
      logEvento(
        'storage',
        'error',
        {
          operazione: 'parent/prestampati:POST',
          esito: 'pdf-non-caricato',
          bucket: BUCKET_FASCICOLO,
          tipo: voce.slug,
          alunno_id: alunnoId,
          protocollo_numero: numero,
        },
        erroreUpload,
      )
    }

    let documentoId: string | null = null
    let codiceArchivio: string | null = null
    if (!erroreUpload) {
      // PostgREST non lancia: il valore di ritorno va controllato, sempre.
      const { data: riga, error: erroreRiga } = await supabase
        .from('student_documents')
        .insert({
          student_id: alunnoId,
          section_id: prefill.sezioneId,
          document_type: voce.slug,
          // Il formato lo scrive — e lo rilegge — `banco-famiglia.ts`: è l'unico posto in
          // cui il numero di protocollo può viaggiare, perché `student_documents` non ha
          // una colonna per il protocollo. Round-trip verificato dal test.
          descrizione: descrizioneArchivioProtocollata(voce.etichetta, numeroFormattato),
          file_name: `${slugNomeFile(reso.titolo)}.pdf`,
          storage_path: percorsoFascicolo,
          // Percorso privato, non un indirizzo: il download passa da un URL firmato.
          file_url: percorsoFascicolo,
          // I due certificati non dichiarano una scadenza nelle risposte, e non ne hanno
          // una nel calendario: attestano un fatto alla data di emissione.
          expiry_date: null,
          caricato_da: parentId,
        })
        .select('id')
        .single()
      if (erroreRiga) {
        codiceArchivio = (erroreRiga as { code?: string }).code ?? null
        logEvento(
          'modulistica',
          'error',
          {
            operazione: 'parent/prestampati:POST',
            esito: 'archivio-non-scritto',
            entita_tipo: 'student_documents',
            tipo: voce.slug,
            alunno_id: alunnoId,
            protocollo_numero: numero,
            error_code: codiceArchivio,
          },
          erroreRiga,
        )
      }
      documentoId = (riga as unknown as { id: string } | null)?.id ?? null
    }

    if (documentoId !== null) {
      // Regola 5 di `docs/prestampati/README.md`: un deposito nel fascicolo si registra,
      // e si registra DOPO che è avvenuto.
      await logAccessoFascicolo(supabase, {
        alunnoId,
        utenteId: parentId,
        azione: 'upload',
        documentoId,
        finalita: `Certificato ${voce.slug} generato dalla famiglia`,
        request,
      })
    } else if (!erroreUpload && !ilFileRestaNelBucket(motivoMancatoArchivioDa(codiceArchivio))) {
      // Il file si toglie SOLO quando ritentare ha senso: sui codici dello schema resta,
      // perché è l'unica copia recuperabile il giorno in cui l'enumerazione si allarga.
      const { error } = await supabase.storage.from(BUCKET_FASCICOLO).remove([percorsoFascicolo])
      if (error) {
        logEvento(
          'storage',
          'error',
          {
            operazione: 'parent/prestampati:POST',
            esito: 'pdf-orfano-non-rimosso',
            bucket: BUCKET_FASCICOLO,
            tipo: voce.slug,
            alunno_id: alunnoId,
          },
          error,
        )
      }
    }

    // Il SUCCESSO si logga: senza, «nessun log» non distingue «i certificati escono» da
    // «non ne è mai uscito uno». Solo uuid, enumerati e numeri.
    logEvento('modulistica', 'info', {
      operazione: 'parent/prestampati:POST',
      esito: documentoId ? 'certificato-generato' : 'certificato-generato-non-archiviato',
      tipo: voce.slug,
      utente: parentId,
      alunno_id: alunnoId,
      scuola_id: prefill.scuolaId,
      documento_id: documentoId,
      protocollo_numero: numero,
      protocollo_anno: anno,
      n: pdf.byteLength,
    })

    let url: string | null = null
    if (documentoId) {
      const { data: link, error: erroreLink } = await supabase.storage
        .from(BUCKET_FASCICOLO)
        .createSignedUrl(percorsoFascicolo, TTL_LINK)
      if (erroreLink) {
        logEvento(
          'storage',
          'warn',
          {
            operazione: 'parent/prestampati:POST',
            esito: 'link-non-firmato',
            bucket: BUCKET_FASCICOLO,
            tipo: voce.slug,
            alunno_id: alunnoId,
          },
          erroreLink,
        )
      }
      url = link?.signedUrl ?? null
    }

    return NextResponse.json(
      {
        success: true,
        riuso: false,
        documentoId,
        archiviato: documentoId !== null,
        titolo: reso.titolo,
        protocollo: numeroFormattato,
        url,
        /**
         * Il foglio, consegnato qui perché quando l'archiviazione non riesce questa è
         * l'unica copia che la famiglia riceve — e il numero di protocollo è già stato
         * consumato, quindi non si può fare finta di niente.
         */
        pdfBase64: url ? null : Buffer.from(pdf).toString('base64'),
      },
      { status: 201 },
    )
  } catch (err) {
    logErrore({ operazione: 'parent/prestampati:POST', stato: 500 }, err)
    return NextResponse.json(
      {
        error: 'Non è stato possibile generare il documento. Riprova fra qualche minuto.',
        codice: 'PRESTAMPATO_NON_GENERATO',
      },
      { status: 500 },
    )
  }
})

/**
 * Il 503 di un protocollo che non si è potuto registrare.
 *
 * Il documento NON viene consegnato, ed è deliberato: un certificato in uscita senza la
 * sua riga nel registro è un foglio che dichiara un numero che nessun registro conferma.
 */
function protocolloNonRiuscito(): NextResponse {
  return NextResponse.json(
    {
      error:
        'Non è stato possibile registrare il documento al protocollo: non è stato generato niente. Riprova fra qualche minuto.',
      codice: 'PRESTAMPATO_NON_GENERATO',
    },
    { status: 503 },
  )
}
