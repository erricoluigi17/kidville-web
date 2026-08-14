import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { caricaPrefillAlunno, nucleoAlunno } from '@/lib/prestampati/prefill'
import { chiaveEtichetta, prestampatiPerRuolo } from '@/lib/prestampati/registro'
import {
  motivoNonFirmabile,
  serveElencoDelegati,
  soloFamiglia,
  sconosciuto,
  voceDelGenitore,
  zSlug,
} from '@/app/api/parent/prestampati/banco-famiglia'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

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

    logEvento('modulistica', 'info', {
      operazione: 'parent/prestampati:GET',
      esito: 'elenco-servito',
      alunno_id: alunnoId,
      utente: utente.id,
      tipo: scelto?.slug ?? 'elenco',
      n: disponibili.length,
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
      modelli: disponibili.map((v) => {
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
