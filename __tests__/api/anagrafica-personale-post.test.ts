import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

// =============================================================================
// POST /api/iscrizione/personale — l'anagrafica di chi già lavora qui.
//
// È la porta anonima più pesante dell'applicazione: un anonimo ci scrive un
// CODICE FISCALE e il riferimento alla scansione di un DOCUMENTO D'IDENTITÀ. Il
// gate manca perché è stato deciso che manchi (titolare, 11/08/2026: link aperto,
// alternativa OTP valutata e scartata), quindi tutto ciò che resta fra un abuso e
// i dati di una persona è quello che si misura qui sotto.
//
// I difetti REALI che questi test impediscono — ognuno è già costato una volta,
// su questa corsia o su quella gemella delle candidature:
//
//  1. IL TETTO CHE NON C'È — e quello TROPPO BASSO, che è il difetto gemello e
//     costa quanto l'altro. `iscrizione/upload` accettava dieci POST di fila senza
//     mai un 429 (misurato in produzione il 2026-08-02); qui il tetto c'era ma era
//     3 l'ora, ereditato dalla candidatura spontanea insieme a una ragione che
//     parlava della PERSONA mentre il contatore conta le RETI — e questo modulo si
//     compila in gruppo, dietro il NAT di una sede.
//  2. LO SPREAD DI `data`. `data` è `.loose()` per non perdere le chiavi del
//     wizard: costruire la riga spargendolo significherebbe lasciare a un anonimo
//     scrivere `stato: 'approvata'` e `utente_id`, cioè consegnarsi da solo una
//     pratica già accolta e già collegata a un account.
//  3. IL CODICE FISCALE SBAGLIATO CHE ENTRA. Un carattere di controllo che non
//     torna è un refuso di battitura: non esiste nessuna persona con quel codice, e
//     farlo entrare significa scriverlo su un contratto e su una denuncia INPS.
//  4. IL CODICE FISCALE INCOERENTE CHE BLOCCA. L'errore opposto, e altrettanto
//     reale: bloccare respingerebbe omocodie e comuni soppressi, cioè persone vere
//     a cui si direbbe che il proprio codice fiscale non esiste.
//  5. IL PERCORSO DI UN ALTRO BUCKET. `documento_fronte_path` e `documento_retro_path`
//     sono le chiavi con cui la Segreteria farà firmare un oggetto dello Storage:
//     senza gate, un anonimo ci scrive quello che vuole. E i percorsi NON devono
//     comparire in nessun log. ⚠️ Erano UNA colonna sola (`documento_path`) fino alla
//     migrazione `20260812194501`: da lì in poi ogni prova di questo file che parlava
//     al singolare misurava un campo che il template non ha più — cioè un `validatePage`
//     che risponde 400 su un payload che nessuno aveva sbagliato.
//  6. IL 409 SUL DOPPIONE. Direbbe a chiunque digiti l'indirizzo di una maestra se
//     quella persona LAVORA qui. Si risponde 201, con la STESSA FORMA del primo
//     invio — perché una risposta di forma diversa è essa stessa l'oracolo.
//  7. IL 201 BUGIARDO SUL DB NON MIGRATO. Chi legge «ricevuta» non riprova, e la
//     sua anagrafica non esiste da nessuna parte.
// =============================================================================

const h = vi.hoisted(() => ({
  /** Colpi per chiave del rate-limit, e le opzioni con cui la route lo chiama. */
  colpi: new Map<string, number>(),
  opzioni: [] as { chiave: string; limit: number; windowMs: number }[],
  /** Le righe passate a `.insert()` su `pratiche_personale`. */
  inserts: [] as Record<string, unknown>[],
  /**
   * L'errore che l'INSERT deve restituire (PostgREST NON lancia: ritorna `{error}`).
   *
   * ⚠️ `details` FA PARTE DELLA FORMA, e la sua assenza da questo tipo non era un
   * dettaglio: finché il finto non poteva nemmeno esprimerlo, nessun test poteva
   * accorgersi che su una violazione di CHECK quel campo è `Failing row contains (…)`
   * — cioè la riga di una persona ricopiata per intero, che il ramo generico dei 500
   * passava a `logErrore`. Un finto più povero dell'oggetto vero rende invisibile
   * proprio ciò che l'oggetto vero porta in più.
   */
  erroreInsert: null as { code?: string; message?: string; details?: string } | null,
  /** Errori successivi, per provare il RITENTO senza la colonna caduta. */
  erroriSuccessivi: [] as ({ code?: string; message?: string } | null)[],
  /**
   * La riga «già viva» che la lettura per email deve restituire sul 23505, con
   * l'email CON CUI È IN TABELLA, il suo `stato` e la SUA sede.
   *
   * L'email sta qui e non è un dettaglio del finto: l'indice che genera il `23505`
   * è `unique (lower(email))`, quindi la riga si trova solo se il predicato della
   * rilettura è lo stesso dell'indice. Un mock che ignorasse il filtro
   * restituirebbe la riga comunque, e il ramo resterebbe non collaudato.
   */
  vivaPerEmail: null as { id: string; email: string; stato: string; scuola_id: string } | null,
  /** L'errore che la RILETTURA della riga viva deve restituire (PostgREST non lancia). */
  erroreRilettura: null as { code?: string; message?: string } | null,
  /** I filtri `.eq(...)` visti dal finto: colonna e valore, in ordine. */
  filtri: [] as { colonna: string; valore: unknown }[],
  /** I filtri `.in(...)` visti dal finto: colonna e valori ammessi, in ordine. */
  filtriIn: [] as { colonna: string; valori: unknown[] }[],
  /** Gli argomenti con cui `staffScuola` è stata chiamata: sede e ruoli. */
  destinatariChiesti: [] as { scuolaId: unknown; ruoli: unknown }[],
  /** Le sedi che `sediReali` deve vedere (`schools`). */
  sedi: [] as { id: string; nome: string }[],
  /** Il registro `scuole`: id → `attiva`. Assente ⇒ la sede è attiva. */
  attive: new Map<string, boolean>(),
  /** Ogni `logEvento` emesso durante la richiesta. */
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  /**
   * Ogni `logErrore`, CON L'OGGETTO CHE GLI È STATO PASSATO.
   *
   * Prima era `logErrore: () => {}`, e quel finto muto è precisamente ciò che ha
   * lasciato passare per un giro intero il difetto peggiore di questa rotta: sul ramo
   * generico dei 500 le andava l'oggetto PostgREST GREZZO, e il `details` di una
   * violazione di CHECK è `Failing row contains (…)` — la riga di una persona
   * ricopiata per intero, i percorsi delle DUE scansioni compresi. Un finto che scarta l'argomento
   * non può accorgersi di cosa c'era dentro.
   */
  errori: [] as { campi: Record<string, unknown>; err: unknown }[],
  /** Le notifiche accodate alla Segreteria. */
  notifiche: [] as Record<string, unknown>[],

  // ── il REGISTRO dei caricamenti ───────────────────────────────────────────
  /**
   * Percorso → pratica che l'ha reclamato (`null` = in sospeso). Un percorso che
   * NON è in questa mappa è un oggetto che non esiste: è la differenza fra un
   * riferimento vero e una stringa inventata nella forma giusta, e quella forma è
   * documentata in un repository pubblico.
   */
  registroCaricamenti: new Map<string, string | null>(),
  /** L'errore che la lettura del registro deve restituire (PostgREST non lancia). */
  erroreRegistro: null as { code?: string; message?: string } | null,
  /**
   * Ogni LETTURA del registro, con i percorsi che ha chiesto: una voce per query.
   *
   * ⚠️ SERVE A CONTARE LE LETTURE, e il conteggio è la proprietà portante del reclamo
   * al plurale. Con una lettura per faccia, fra la prima e la seconda si apre una
   * finestra in cui l'altra può essere reclamata da qualcun altro; e il verdetto
   * smetterebbe di essere un'aritmetica su una risposta sola. Senza questo elenco,
   * «una lettura per due facce» e «due letture» sono indistinguibili — cioè il difetto
   * si potrebbe reintrodurre col verde davanti.
   */
  lettureRegistro: [] as string[][],
  /** L'errore che il COLLEGAMENTO alla pratica deve restituire. */
  erroreCollegamento: null as { code?: string; message?: string } | null,
  /**
   * Ogni tentativo di collegare oggetti a una pratica, riuscito o no.
   *
   * ⚠️ UNA VOCE PER CHIAMATA, CON L'ELENCO DEI PERCORSI — non una per percorso. Dal
   * 12/08/2026 le facce sono due e `collegaCaricamenti` le collega con UN SOLO
   * `update … .in('percorso', …)`: è la sua proprietà portante, perché con una
   * chiamata per faccia il fronte può collegarsi e il retro no, e restano due righe di
   * log scoordinate che nessuno sa ricomporre. Un finto che contasse una voce per
   * percorso non potrebbe distinguere «una chiamata per due facce» da «due chiamate»,
   * cioè renderebbe invisibile proprio la differenza che quel plurale esiste per fare.
   */
  collegamenti: [] as {
    percorsi: string[]
    praticaId: unknown
    /** Quante righe l'`update` ha toccato DAVVERO: è lo stato, non l'intenzione. */
    collegati: number
    riuscito: boolean
  }[],

  /**
   * LA PRATICA DI QUELL'EMAIL, con le facce che NOMINA: email → riga.
   *
   * È lo stato che il SECONDO invio della stessa persona incontra davvero, e il finto
   * lo mantiene da solo a ogni INSERT riuscito invece di farlo scrivere ai test: la
   * riga appena creata nomina quegli oggetti ed è `pending`, e un test che dovesse
   * armare a mano quella conseguenza finirebbe per collaudare la propria messinscena
   * invece della sequenza vera.
   *
   * ⚠️ LA CHIAVE È L'EMAIL, e non è una comodità: è ciò che il database garantisce.
   * L'indice `unique (lower(email)) where stato in ('pending','in_approvazione')` dice
   * che di righe VIVE per una email ce n'è al massimo UNA, ed è la ragione per cui la
   * rotta legge il proprietario con un `.maybeSingle()` senza filtrare sui percorsi.
   * Un finto indicizzato per PERCORSO poteva restituire due proprietari diversi per la
   * stessa email — cioè uno stato che il database non può produrre — e con quello si
   * sarebbe potuta collaudare come «giusta» una query che nel mondo vero non regge.
   */
  praticaPerEmail: new Map<
    string,
    { id: string; stato: string; documenti: Record<string, string> }
  >(),
  /**
   * LE RIGHE VIVE IN PIÙ per la stessa email — cioè un database SENZA l'indice
   * `pratiche_personale_email_viva`.
   *
   * Non è un caso di scuola: questa rotta è scritta per tollerare un database
   * indietro con le migrazioni (è il senso del suo ramo di degrado sull'INSERT), e
   * su quel database l'indice unico può non esserci. Con `.maybeSingle()` due righe
   * vive facevano rispondere `PGRST116` a `documentiDiUnaPraticaViva`, che tornava
   * `false`: 400 sul documento a chi rimandava il PROPRIO modulo. Vuoto per difetto,
   * quindi ogni altro test continua a descrivere il database sano.
   */
  viveAggiuntive: [] as {
    email: string
    id: string
    stato: string
    documenti: Record<string, string>
  }[],
  /** I tetti (`.limit(n)`) che le letture su `pratiche_personale` hanno dichiarato. */
  limitiChiesti: [] as number[],
  /**
   * L'errore che la lettura del PROPRIETARIO del percorso deve restituire.
   *
   * Distinto da `erroreRilettura` di proposito: sono due letture diverse su
   * `pratiche_personale` (chi possiede questo file / qual è la riga viva per questa
   * email) e vanno in due direzioni opposte quando falliscono — la prima RIFIUTA
   * (non si presume una ragione per ammettere), la seconda lascia passare.
   */
  erroreProprietario: null as { code?: string; message?: string } | null,
}))

vi.mock('@/lib/security/rate-limit', () => ({
  // Un limitatore VERO in memoria, non uno stub che dice sempre sì: così il test
  // misura il tetto che la ROUTE dichiara (3/ora), non quello del finto.
  rateLimit: async (chiave: string, opts: { limit: number; windowMs: number }) => {
    h.opzioni.push({ chiave, ...opts })
    const n = (h.colpi.get(chiave) ?? 0) + 1
    h.colpi.set(chiave, n)
    return n <= opts.limit
      ? { ok: true, remaining: opts.limit - n, retryAfterMs: 0 }
      : { ok: false, remaining: 0, retryAfterMs: opts.windowMs }
  },
  clientIp: () => '203.0.113.7',
}))

vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
    logErrore: (campi: Record<string, unknown>, err: unknown) => {
      h.errori.push({ campi, err })
    },
  }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(tabella: string) {
      // `schools`: l'elenco grezzo. `scuole`: il registro del flag `attiva`, che
      // `sediReali` legge a parte per scartare le sedi soft-deleted. Due tabelle
      // diverse, due rami diversi: fusi in uno solo non si potrebbe mai provare una
      // sede disattivata, che è metà della differenza fra `tutte` e `reali`.
      if (tabella === 'schools') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.order = () => b
        b.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({
            data: h.sedi.map((s) => ({ id: s.id, nome: s.nome })),
            error: null,
          }).then(res)
        return b
      }
      if (tabella === 'scuole') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.in = () => b
        b.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({
            data: h.sedi.map((s) => ({ id: s.id, attiva: h.attive.get(s.id) ?? true })),
            error: null,
          }).then(res)
        return b
      }
      // `caricamenti_personale`: il registro degli oggetti caricati. Due sole
      // operazioni — la lettura che RECLAMA il percorso prima dell'INSERT, e
      // l'`update` che lo COLLEGA alla pratica appena creata — e i filtri si
      // memorizzano tutti e due: `eq('percorso', …)` dice QUALE oggetto, `is(
      // 'pratica_id', null)` dice che non deve essere già di qualcun altro. Un finto
      // che ignorasse il secondo lascerebbe verde proprio la catena d'attacco che
      // questo registro esiste per chiudere.
      if (tabella === 'caricamenti_personale') {
        let modo: 'select' | 'update' = 'select'
        /**
         * I percorsi chiesti da QUESTA query.
         *
         * ⚠️ SI ACCETTANO SIA `.eq('percorso', x)` SIA `.in('percorso', [...])`, ed è
         * voluto: il registro parla al plurale dal 12/08/2026 (`caricamentiReclamabili`
         * e `collegaCaricamenti` fanno una lettura e una scrittura sole per tutte le
         * facce), ma le due forme singolari continuano a esistere come scorciatoie che
         * delegano. Un finto che ne conoscesse una sola risponderebbe «nessuna riga» a
         * una query perfettamente legittima — cioè un 400 sul documento di chi non ha
         * sbagliato niente, che è precisamente il difetto misurato il 12/08/2026.
         */
        let chiesti: string[] = []
        let soloSospesi = false
        let patch: Record<string, unknown> = {}
        const c: Record<string, unknown> = {}
        c.select = () => c
        c.update = (p: Record<string, unknown>) => {
          modo = 'update'
          patch = p
          return c
        }
        c.eq = (colonna: string, valore: unknown) => {
          if (colonna === 'percorso') chiesti = [String(valore)]
          return c
        }
        c.in = (colonna: string, valori: unknown[]) => {
          if (colonna === 'percorso') chiesti = valori.map(String)
          return c
        }
        // ⚠️ ANCHE `anagrafica_utente_id`, non solo `pratica_id`. Dal 12/08/2026 un
        // oggetto ha DUE proprietari possibili (migrazione `20260812194501`), e un finto
        // che ignorasse il secondo predicato lascerebbe verde una pratica pubblica che
        // reclama la scansione già appesa all'anagrafica di una collega.
        c.is = (colonna: string, valore: unknown) => {
          if ((colonna === 'pratica_id' || colonna === 'anagrafica_utente_id') && valore === null) {
            soloSospesi = true
          }
          return c
        }
        /** Il percorso è nel registro E (se richiesto) non è ancora di nessuno. */
        const reclamabile = (percorso: string) => {
          if (!h.registroCaricamenti.has(percorso)) return false
          return !soloSospesi || h.registroCaricamenti.get(percorso) === null
        }
        const trovati = () => chiesti.filter(reclamabile).map((percorso) => ({ percorso }))
        c.maybeSingle = async () =>
          h.erroreRegistro
            ? { data: null, error: h.erroreRegistro }
            : { data: trovati()[0] ?? null, error: null }
        c.then = (res: (v: unknown) => unknown) => {
          if (modo !== 'update') {
            // LA LETTURA DEL RECLAMO, che ora è un `await` sul costruttore e non più un
            // `maybeSingle`: `caricamentiReclamabili` conta le righe tornate e ne ricava
            // il verdetto. Restituire sempre `[]`, com'era prima, significava dire «non
            // esiste nessuno di questi percorsi» a ogni richiesta.
            //
            // La lettura si REGISTRA anche quando fallisce: contare solo quelle riuscite
            // renderebbe invisibile un ciclo che ritenta faccia per faccia sul guasto.
            h.lettureRegistro.push([...chiesti])
            return Promise.resolve(
              h.erroreRegistro
                ? { data: null, error: h.erroreRegistro }
                : { data: trovati(), error: null },
            ).then(res)
          }
          if (h.erroreCollegamento) {
            h.collegamenti.push({
              percorsi: [...chiesti],
              praticaId: patch.pratica_id,
              collegati: 0,
              riuscito: false,
            })
            return Promise.resolve({ data: null, error: h.erroreCollegamento }).then(res)
          }
          const toccati = chiesti.filter(reclamabile)
          for (const percorso of toccati) {
            h.registroCaricamenti.set(percorso, String(patch.pratica_id))
          }
          h.collegamenti.push({
            percorsi: [...chiesti],
            praticaId: patch.pratica_id,
            collegati: toccati.length,
            // «Riuscito» è TUTTE, non ALCUNE: una pratica con una faccia collegata e
            // l'altra no è una pratica mezza documentata, e la spazzata toglie l'altra
            // entro 24 ore mentre la riga la nomina ancora.
            riuscito: toccati.length === chiesti.length && chiesti.length > 0,
          })
          return Promise.resolve({
            data: toccati.map((percorso) => ({ percorso })),
            error: null,
          }).then(res)
        }
        return c
      }
      // `pratiche_personale`: INSERT (con eventuale ritento) e lettura della riga
      // già viva per email sul 23505.
      const b: Record<string, unknown> = {}
      let scrittura = false
      // ⚠️ I FILTRI SI TENGONO ANCHE PER QUESTA QUERY, non solo nell'elenco globale.
      // Su `pratiche_personale` la route fa ORA DUE letture diverse (chi possiede
      // questo percorso / qual è la riga viva per questa email), e `from()` crea un
      // costruttore nuovo per ognuna: decidere la risposta leggendo l'elenco globale
      // significherebbe farle rispondere con i filtri l'una dell'altra. `h.filtri` e
      // `h.filtriIn` restano, e restano globali, ma servono alle ASSERZIONI.
      const eqLocali = new Map<string, unknown>()
      const inLocali = new Map<string, unknown[]>()
      /**
       * LE COLONNE CHIESTE, ed è ciò che ora distingue le due letture.
       *
       * Fino al 12/08/2026 la lettura del PROPRIETARIO si riconosceva dal filtro
       * `.eq('documento_*_path', …)`. Quel filtro non c'è più: la rotta fa UN solo
       * round trip — `select('id, documento_fronte_path, documento_retro_path')` per
       * email — e confronta i percorsi in memoria, perché un `.or(…)` con dentro il
       * testo di un anonimo non si scrive (la virgola RISCRIVE il filtro invece di
       * romperlo). Le due letture su `pratiche_personale` si distinguono quindi per la
       * PROIEZIONE, ed è giusto che il finto guardi quella: è l'unica cosa che le
       * differenzia anche nel client vero.
       */
      let colonneChieste = ''
      b.insert = (row: Record<string, unknown>) => {
        scrittura = true
        h.inserts.push(row)
        return b
      }
      b.select = (colonne?: string) => {
        colonneChieste = String(colonne ?? '')
        return b
      }
      // Il filtro si MEMORIZZA, non si ignora: un `eq` no-op restituirebbe la riga
      // viva qualunque cosa la route chiedesse, e il ramo del doppio invio resterebbe
      // verde anche con un predicato sbagliato.
      b.eq = (colonna: string, valore: unknown) => {
        h.filtri.push({ colonna, valore })
        eqLocali.set(colonna, valore)
        return b
      }
      // ANCHE `.in` SI MEMORIZZA: la rilettura filtra sugli STATI VIVI, ed è quel
      // filtro a distinguere «duplicata e tracciata» da una pratica già rifiutata che
      // non deve più contare.
      b.in = (colonna: string, valori: unknown[]) => {
        h.filtriIn.push({ colonna, valori })
        inLocali.set(colonna, [...valori])
        return b
      }
      b.single = async () => {
        const errore = h.inserts.length === 1 ? h.erroreInsert : (h.erroriSuccessivi.shift() ?? null)
        if (errore) return { data: null, error: errore }
        // LA CONSEGUENZA DELLA SCRITTURA, che è ciò che il secondo invio incontra: da
        // adesso esiste una pratica VIVA (`pending`) che NOMINA quel percorso. Senza
        // questa riga il finto direbbe che l'oggetto non è di nessuno un istante dopo
        // averlo assegnato, e il difetto del doppio invio resterebbe non misurabile.
        const scritta = h.inserts[h.inserts.length - 1] ?? {}
        // ⚠️ TUTTE LE FACCE, e si riconoscono dalla FORMA del nome invece che da un
        // elenco scritto qui: `documento_*_path`. Un elenco a mano dentro una fabbrica
        // `vi.mock` non può importare il template (è issata sopra gli import), e il
        // giorno del rinomino resterebbe indietro in silenzio — cioè il finto direbbe
        // che nessuna pratica nomina quell'oggetto un istante dopo averlo scritto.
        const documenti: Record<string, string> = {}
        for (const [colonna, valore] of Object.entries(scritta)) {
          if (!/^documento_.+_path$/.test(colonna)) continue
          if (typeof valore !== 'string' || valore === '') continue
          documenti[colonna] = valore
        }
        // La riga VIVA di quella email diventa questa: l'indice unico non ne ammette
        // due, quindi si SOSTITUISCE invece di accumulare — un finto che accumulasse
        // descriverebbe un database in cui la stessa persona ha due pratiche vive, che
        // è lo stato che l'indice esiste per rendere impossibile.
        h.praticaPerEmail.set(String(scritta.email ?? ''), {
          id: 'pratica-nuova',
          stato: 'pending',
          documenti,
        })
        return { data: { id: 'pratica-nuova' }, error: null }
      }
      /**
       * LE COLONNE DEL DOCUMENTO CHIESTE DA QUESTA `select`, o `[]`.
       *
       * ⚠️ SI GUARDA LA FORMA DEL NOME (`documento_*_path`), non un elenco battuto
       * qui: una fabbrica `vi.mock` è issata sopra gli import e non può leggere il
       * template, quindi un elenco a mano resterebbe indietro in silenzio al prossimo
       * rinomino — cioè il finto risponderebbe «nessuna riga» a ogni ricerca del
       * proprietario, e l'eccezione del secondo invio risulterebbe verde per il motivo
       * sbagliato. È già successo, il 12/08/2026, con `documento_path`.
       */
      const colonneDocumentoChieste = () =>
        colonneChieste
          .split(',')
          .map((c) => c.trim())
          .filter((c) => /^documento_.+_path$/.test(c))

      /**
       * LE RIGHE VIVE di questa email, proiettate come le chiede la `select`.
       *
       * ⚠️ RESTITUISCE UN ELENCO, e non una riga sola: dal 13/08/2026 la rotta legge
       * con `.limit()` invece che con `.maybeSingle()` proprio perché su un database
       * senza l'indice unico le righe vive possono essere più d'una. Un finto che ne
       * sapesse rendere una sola non potrebbe mai far scattare quel caso, cioè
       * lascerebbe non collaudato il ramo per cui il cambiamento è stato fatto.
       */
      const vivePerEmail = (colonneDocumento: string[]) => {
        const chiesta = String(eqLocali.get('email') ?? '')
        const stati = inLocali.get('stato') as string[] | undefined
        const prima = h.praticaPerEmail.get(chiesta)
        const tutte = [
          ...(prima === undefined ? [] : [prima]),
          // Le righe vive IN PIÙ, che esistono solo se un test le semina: è lo stato di
          // un database a cui manca `pratiche_personale_email_viva`.
          ...h.viveAggiuntive.filter((v) => v.email === chiesta),
        ]
        // Tutti e due i predicati contano, e un finto che ne ignorasse uno solo
        // lascerebbe verde l'eccezione più larga di com'è: senza l'email ammetterebbe
        // chiunque conosca un percorso, senza gli stati ammetterebbe anche una pratica
        // già evasa — cioè il caso in cui il `23505` NON scatta e due righe finirebbero
        // per nominare lo stesso oggetto.
        return tutte
          .filter((v) => stati === undefined || stati.includes(v.stato))
          // ⚠️ SI RESTITUISCE SOLO CIÒ CHE È STATO CHIESTO. Il client vero proietta: una
          // riga che portasse indietro anche le colonne non selezionate lascerebbe verde
          // una rotta che legge una faccia senza averla nominata nel `select`, cioè
          // proprio il giorno in cui il template ne aggiunge una terza.
          .map((v) => ({
            id: v.id,
            ...Object.fromEntries(
              colonneDocumento.map((colonna) => [colonna, v.documenti[colonna] ?? null]),
            ),
          }))
      }

      // `.limit()` non filtra niente qui: MEMORIZZA il tetto, così una prova può
      // pretendere che la rotta ne dichiari uno. Una lettura senza tetto su un
      // database senza indice è una scansione, ed è la ragione per cui esiste.
      b.limit = (n: number) => {
        h.limitiChiesti.push(n)
        return b
      }

      // ── LA DOMANDA DEL 9-bis: «quali pratiche VIVE ha QUESTA email, e quali facce
      //    nominano?». Si riconosce dalla PROIEZIONE — è l'unica lettura che chiede le
      //    colonne del documento — ed è l'unica che si `await`a sul costruttore.
      b.then = (res: (v: unknown) => unknown) => {
        const colonneDocumento = colonneDocumentoChieste()
        if (h.erroreProprietario) {
          return Promise.resolve({ data: null, error: h.erroreProprietario }).then(res)
        }
        const righe = vivePerEmail(colonneDocumento)
        // Il tetto lo applica il DATABASE, non il chiamante: se la rotta ne chiede
        // cinque e le righe fossero sei, la sesta non arriverebbe mai.
        const tetto = h.limitiChiesti[h.limitiChiesti.length - 1] ?? righe.length
        return Promise.resolve({ data: righe.slice(0, tetto), error: null }).then(res)
      }

      b.maybeSingle = async () => {
        if (scrittura) return { data: { id: 'pratica-nuova' }, error: null }

        if (h.erroreRilettura) return { data: null, error: h.erroreRilettura }
        // `.eq` È SENSIBILE ALLE MAIUSCOLE, e qui si comporta come tale: il confronto
        // è ESATTO contro l'email che la riga viva ha IN TABELLA. Il `23505` lo decide
        // l'indice, che confronta `lower(email)`; la rilettura la decide `eq`, che
        // confronta i byte. Un mock che ammorbidisse `eq` coprirebbe proprio il
        // disallineamento fra i due.
        const chiesta = eqLocali.get('email')
        const viva = h.vivaPerEmail
        const statiChiesti = inLocali.get('stato') as string[] | undefined
        const combacia =
          viva !== null &&
          chiesta === viva.email &&
          (statiChiesti === undefined || statiChiesti.includes(viva.stato))
        return { data: combacia ? { id: viva.id, scuola_id: viva.scuola_id } : null, error: null }
      }
      return b
    },
  }),
}))

vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: vi.fn(async (_s: unknown, p: Record<string, unknown>) => {
    h.notifiche.push(p)
  }),
}))
vi.mock('@/lib/notifiche/destinatari', () => ({
  // GLI ARGOMENTI SI MEMORIZZANO. Il payload di `notificaEvento` dice a CHI è
  // indirizzato l'avviso; `staffScuola` decide CHI lo riceve, ed è la seconda cosa a
  // poter sbagliare sede senza che la prima se ne accorga.
  staffScuola: vi.fn(async (_s: unknown, scuolaId: unknown, ruoli: unknown) => {
    h.destinatariChiesti.push({ scuolaId, ruoli })
    return ['utente-segreteria']
  }),
}))

import { POST } from '@/app/api/iscrizione/personale/route'
import {
  CONSENSI_PERSONALE_FIELDS,
  CONSENSI_PERSONALE_VERSIONE,
  PERSONALE_FIELDS,
} from '@/lib/forms/personale-template'
import { VERSIONE_PRIVACY } from '@/lib/legal/versioni'
import { calcolaCodiceFiscale } from '@/lib/fiscale/calcolo'
import { validaCodiceFiscale } from '@/lib/fiscale/validazione'
// Il serializzatore VERO: le prove sul dossier nel log devono passare dalla catena
// che gira in produzione (`logErrore` → `descriviErrore` → `sanificaMessaggio`), non
// da una sua imitazione. Un test che rifacesse la maschera proverebbe sé stesso.
import { descriviErrore } from '@/lib/logging/serialize'

/**
 * LE COLONNE CHE L'INSERT PUÒ TOCCARE, derivate dal TEMPLATE e non ribattute.
 *
 * La riga si costruisce campo per campo dal template, più `scuola_id` e
 * `consents_log`: sono queste, e nessun'altra. Derivarle invece di elencarle è la
 * sola forma che regge — un elenco a mano qui dentro resterebbe indietro il giorno
 * in cui il template guadagna un campo, e il test diventerebbe rosso per la ragione
 * sbagliata.
 */
const COLONNE_AMMESSE = [...PERSONALE_FIELDS.map((f) => f.id), 'scuola_id', 'consents_log'].sort()

/**
 * GLI ID DEI CAMPI CHE PORTANO UN PERCORSO DI DOCUMENTO, letti dal TEMPLATE.
 *
 * È lo stesso elenco che `rispostaDocumentoNonValido` usa per costruire la mappa dei
 * campi in errore, e per la stessa ragione: una chiave scritta a mano qui dentro
 * sopravviverebbe a un rinomino puntando al nulla, e la prova resterebbe verde su un
 * campo che il modulo non ha più. È esattamente com'è andata il 12/08/2026, quando
 * `documento_path` è diventato `documento_fronte_path` + `documento_retro_path`.
 */
const CAMPI_DOCUMENTO = PERSONALE_FIELDS.filter((f) => f.type === 'file').map((f) => f.id)

/**
 * I CODICI FISCALI SI CALCOLANO, NON SI INCOLLANO.
 *
 * Due ragioni, e la seconda è quella che conta. La prima: un codice scritto a mano
 * in un file tracciato di un repository PUBBLICO somiglia al codice di una persona
 * vera, e questo repo ha già una regola su cosa non si scrive nei file. La seconda:
 * un letterale non dice PERCHÉ è valido, quindi il giorno in cui l'algoritmo del
 * carattere di controllo cambiasse (o venisse rotto) il test resterebbe verde su una
 * costante — cioè misurerebbe la propria stringa invece del prodotto.
 *
 * `PERSONA` è un'anagrafica di fantasia; `H501` è il codice catastale di Roma, dato
 * aperto dell'Agenzia delle Entrate ed è già il placeholder del template.
 */
const PERSONA = {
  nome: 'Ines',
  cognome: 'Prova',
  sesso: 'F' as const,
  dataNascita: '1985-03-12',
  codiceBelfiore: 'H501',
}

function codiceDi(dati: Parameters<typeof calcolaCodiceFiscale>[0]): string {
  const esito = calcolaCodiceFiscale(dati)
  if (!esito.ok) throw new Error(`anagrafica di prova non calcolabile: ${esito.motivo}`)
  return esito.codice
}

/** Il codice VERO di `PERSONA`: forma giusta, carattere di controllo giusto, coerente. */
const CF_COERENTE = codiceDi(PERSONA)

/**
 * Un codice con il CARATTERE DI CONTROLLO SBAGLIATO: il refuso di battitura.
 *
 * Si costruisce cambiando l'ultima lettera di uno valido, che è esattamente ciò che
 * succede quando qualcuno ricopia il proprio codice da un documento.
 */
const CF_CHECKSUM_ROTTA =
  CF_COERENTE.slice(0, 15) + (CF_COERENTE[15] === 'A' ? 'B' : 'A')

/**
 * Un codice VALIDO ma di un'altra persona: stessa data, stesso sesso, stesso comune,
 * cognome diverso. La checksum torna — non è un refuso — ma le prime tre lettere
 * dicono un cognome che non è quello scritto nel modulo.
 */
const CF_INCOERENTE = codiceDi({ ...PERSONA, cognome: 'Diversa' })

/** Un percorso nella forma che SOLO `iscrizione/personale/upload:POST` può produrre. */
const percorsoValido = (estensione = 'pdf') =>
  `documenti/${crypto.randomUUID()}/${crypto.randomUUID()}.${estensione}`

/**
 * Un percorso nella forma giusta **e davvero caricato**: la riga di registro esiste
 * e nessuna pratica l'ha ancora reclamato.
 *
 * I due fatti sono distinti e vanno tenuti distinti nei test, perché è precisamente
 * la loro distanza il difetto che il registro chiude: la FORMA di un percorso è
 * documentata in un repository pubblico, quindi si inventa; l'ESISTENZA no.
 */
const caricato = (percorso = percorsoValido()): string => {
  h.registroCaricamenti.set(percorso, null)
  return percorso
}

/**
 * I TRE AVVISI SI DISTINGUONO DAL TESTO, e qui si guarda un FRAMMENTO.
 *
 * Il corpo è l'unica parte che dice alla Segreteria *quale dei tre fatti* è
 * successo: senza queste asserzioni, scambiare il corpo del ramo «altrove» con
 * quello «stessa sede» lascerebbe la suite verde.
 *
 * Si confronta un frammento e non la frase intera di proposito: un test che ricopia
 * il glossario diventa rosso per un apostrofo tipografico cambiato, e in questo repo
 * è già successo.
 */
const FRAMMENTO_AVVISO = {
  nuova: 'va verificata e approvata',
  duplicataQui: 'inviato di nuovo',
  duplicataAltrove: 'per la cooperativa',
} as const

function attendiCorpo(corpo: unknown, quale: keyof typeof FRAMMENTO_AVVISO): void {
  const testo = String(corpo ?? '')
  expect(testo, 'la Segreteria ha ricevuto un avviso SENZA testo').not.toBe('')
  expect(testo, `l’avviso non è quello di «${quale}»`).toContain(FRAMMENTO_AVVISO[quale])
  // L'asserzione negativa non è pignoleria: senza, scambiare due corpi fra i rami
  // resterebbe verde finché il corpo scambiato contiene per caso il frammento atteso.
  for (const [nome, frammento] of Object.entries(FRAMMENTO_AVVISO)) {
    if (nome === quale) continue
    expect(testo, `l’avviso di «${quale}» porta il testo di «${nome}»`).not.toContain(frammento)
  }
}

/**
 * LE DUE FACCE DEL DOCUMENTO, con due percorsi DISTINTI e davvero caricati.
 *
 * ⚠️ DISTINTI NON È UN DETTAGLIO: la rotta rifiuta due facce che puntano allo stesso
 * oggetto (`documento-facce-uguali`), perché il modo più facile di «finire» il modulo
 * sarebbe allegare due volte la stessa foto e la Segreteria si ritroverebbe una pratica
 * completa col retro mancante. Un payload di prova che ripetesse lo stesso percorso
 * prenderebbe 400 su ogni singolo test di questo file, e la causa non si leggerebbe da
 * nessuna parte.
 *
 * ⚠️ E SONO DUE DAL 12/08/2026: prima ce n'era una sola (`documento_path`). Le prove
 * che devono parlare di UNA faccia passano `{ documento_fronte_path: … }` e lasciano al
 * retro il suo percorso buono — così ciò che si misura è la faccia che il test nomina,
 * e non un secondo campo caduto per sbaglio.
 */
const facce = () => ({
  documento_fronte_path: caricato(),
  documento_retro_path: caricato(),
})

/** Un'anagrafica valida e completa: da qui si toglie o si sposta un pezzo per volta. */
const pratica = (extra: Record<string, unknown> = {}) => ({
  nome: PERSONA.nome,
  cognome: PERSONA.cognome,
  gender: PERSONA.sesso,
  birth_date: PERSONA.dataNascita,
  codice_belfiore_nascita: PERSONA.codiceBelfiore,
  birth_place: 'Comune di Prova',
  birth_province: 'NA',
  birth_nation: 'Italia',
  fiscal_code: CF_COERENTE,
  citizenship: 'Italiana',
  address: 'Via di Prova',
  residence_street_number: '1',
  residence_city: 'Comune di Prova',
  residence_province: 'NA',
  zip_code: '80014',
  email: 'ines.prova@example.invalid',
  telefono: '+39 333 0000000',
  document_type: 'CI',
  document_number: 'AB1234567',
  document_expiry: '2030-01-01',
  ...facce(),
  titolo_studio: 'laurea_triennale',
  gradi: ['nido', 'infanzia'],
  presa_visione_informativa_personale: true,
  dichiarazione_veridicita: true,
  presa_visione_copia_documento: true,
  ...extra,
})

const invia = (corpo: Record<string, unknown>) =>
  POST(
    new NextRequest('http://localhost/api/iscrizione/personale', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify(corpo),
    }),
  )

const inviaValida = (dati: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  invia({ scuola_id: SEDE_A, data: pratica(dati), ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  h.colpi.clear()
  h.opzioni = []
  h.inserts = []
  h.erroreInsert = null
  h.erroriSuccessivi = []
  h.vivaPerEmail = null
  h.erroreRilettura = null
  h.filtri = []
  h.filtriIn = []
  h.destinatariChiesti = []
  h.attive = new Map()
  h.sedi = [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ]
  h.eventi = []
  h.errori = []
  h.notifiche = []
  h.registroCaricamenti = new Map()
  h.erroreRegistro = null
  h.lettureRegistro = []
  h.erroreCollegamento = null
  h.collegamenti = []
  h.praticaPerEmail = new Map()
  h.viveAggiuntive = []
  h.limitiChiesti = []
  h.erroreProprietario = null
})

describe('l’anagrafica di prova è davvero valida (se cade, tutto il resto misura altro)', () => {
  it('il codice coerente torna, quello con la checksum rotta no, l’incoerente è valido', () => {
    // Se `CF_COERENTE` non fosse valido, il percorso felice non sarebbe mai
    // raggiungibile e metà di questo file proverebbe il ramo sbagliato senza dirlo.
    expect(validaCodiceFiscale(CF_COERENTE).valido, 'il codice di prova non è valido').toBe(true)
    expect(validaCodiceFiscale(CF_CHECKSUM_ROTTA).valido).toBe(false)
    expect(validaCodiceFiscale(CF_CHECKSUM_ROTTA).motivi).toEqual(['checksum'])
    // E l'incoerente dev'essere VALIDO: altrimenti proverebbe il ramo che blocca
    // invece di quello che segnala, che è la distinzione portante di questa rotta.
    expect(validaCodiceFiscale(CF_INCOERENTE).valido).toBe(true)
    expect(CF_INCOERENTE).not.toBe(CF_COERENTE)
  })
})

describe('POST /api/iscrizione/personale · il percorso felice', () => {
  it('201 con id e avvisi, la riga scritta e il successo LOGGATO', async () => {
    const res = await inviaValida()
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'pratica-nuova', avvisi: [] })

    expect(h.inserts).toHaveLength(1)
    const riga = h.inserts[0]
    // LE CHIAVI SONO ESATTAMENTE QUELLE, e si guardano tutte insieme.
    //
    // Un elenco di `toHaveProperty` prova che ci sono le colonne attese; non prova
    // che NON ce ne siano altre — che è la proprietà portante di questa rotta.
    expect(Object.keys(riga).sort(), 'l’INSERT tocca colonne che nessuno gli ha dato').toEqual(
      COLONNE_AMMESSE,
    )
    // La sede si DICHIARA: un INSERT che di plesso non parla archivia nel default.
    expect(riga.scuola_id).toBe(SEDE_A)
    expect(riga.nome).toBe('Ines')
    expect(riga.fiscal_code).toBe(CF_COERENTE)
    expect(riga.gradi).toEqual(['nido', 'infanzia'])

    // La prova del consenso, con le versioni dalle COSTANTI SERVER.
    const prova = riga.consents_log as Record<string, unknown>
    expect(prova.versione_informativa).toBe(VERSIONE_PRIVACY)
    expect(prova.versione_consensi).toBe(CONSENSI_PERSONALE_VERSIONE)
    const blocchi = prova.blocchi as { field_id: string; accepted: boolean }[]
    expect(blocchi.map((b) => b.field_id).sort()).toEqual(
      CONSENSI_PERSONALE_FIELDS.map((f) => f.id).sort(),
    )
    expect(blocchi.every((b) => b.accepted)).toBe(true)

    // Il successo si logga: senza, «nessun log» non distingue «non ha compilato
    // nessuno» da «il modulo non è mai partito».
    const felice = h.eventi.find(
      (e) => e.evento === 'personale' && e.campi.esito === 'pratica-ricevuta',
    )
    expect(felice?.livello).toBe('info')
    expect(felice?.campi.operazione).toBe('iscrizione/personale:POST')
    expect(felice?.campi.scuola_id).toBe(SEDE_A)
    expect(felice?.campi.n_gradi).toBe(2)
    expect(felice?.campi.n_avvisi_cf).toBe(0)
  })

  it('la Segreteria della STESSA sede viene avvisata, e l’avviso non nomina nessuno', async () => {
    await inviaValida()

    expect(h.notifiche).toHaveLength(1)
    const avviso = h.notifiche[0]
    expect(avviso.scuolaId, 'l’avviso è indirizzato a una sede diversa da quella scritta').toBe(
      SEDE_A,
    )
    // `staffScuola` decide CHI riceve: con tre plessi, due sedi diverse fra le due
    // righe consegnerebbero l'avviso di un plesso alla scrivania di un altro.
    expect(h.destinatariChiesti).toHaveLength(1)
    expect(h.destinatariChiesti[0].scuolaId).toBe(SEDE_A)
    expect(avviso.entitaId).toBe('pratica-nuova')
    attendiCorpo(avviso.corpo, 'nuova')

    // ⚠️ L'AVVISO NON PORTA IL NOME DI NESSUNO. Viaggia su più canali (in-app, push,
    // email) e non è il posto dove si scrive di chi è il codice fiscale appena
    // arrivato: chi legge la notifica sul telefono non ha ancora fatto nessun login.
    const testo = `${String(avviso.titolo ?? '')} ${String(avviso.corpo ?? '')}`
    for (const segreto of [PERSONA.nome, PERSONA.cognome, CF_COERENTE, 'ines.prova']) {
      expect(testo, `l’avviso alla Segreteria contiene «${segreto}»`).not.toContain(segreto)
    }
  })

  it('le colonne di STATO inviate da un ANONIMO non entrano nell’INSERT', async () => {
    // `data` è `.loose()` per non perdere le chiavi del wizard. Se la riga si
    // costruisse spargendolo, un POST SENZA LOGIN scriverebbe una pratica già
    // approvata e già collegata a un account — sulla porta più esposta dell'app.
    const res = await inviaValida({
      stato: 'approvata',
      utente_id: '00000000-0000-4000-8000-000000000001',
      evasa_da: '00000000-0000-4000-8000-000000000002',
      evasa_il: '1999-01-01T00:00:00.000Z',
      motivo_rifiuto: 'nessuno',
      creata_il: '1999-01-01T00:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000003',
    })
    // Le chiavi in più non fanno 400: `data` è `.loose()` per progetto. Vengono
    // semplicemente IGNORATE — ed è questa la differenza da provare.
    expect(res.status).toBe(201)
    for (const colonna of ['stato', 'utente_id', 'evasa_da', 'evasa_il', 'motivo_rifiuto', 'creata_il', 'id']) {
      expect(
        h.inserts[0],
        `«${colonna}» è entrata nell’INSERT da una richiesta senza login`,
      ).not.toHaveProperty(colonna)
    }
    expect(Object.keys(h.inserts[0]).sort()).toEqual(COLONNE_AMMESSE)
  })

  it('l’email si scrive MINUSCOLA: è la chiave dell’indice e quella dell’approvazione', async () => {
    // `unique (lower(email))` decide il doppione; `utenti.email` decide se
    // l'approvazione aggiorna un'anagrafica o apre un'utenza. Se in tabella
    // restassero le maiuscole digitate, il DATO e la CHIAVE che lo rende unico
    // sarebbero due cose diverse.
    await inviaValida({ email: 'Ines.PROVA@Example.Invalid' })
    expect(h.inserts[0].email).toBe('ines.prova@example.invalid')
  })

  it('la provincia scritta per esteso viene normalizzata, non troncata a valle', async () => {
    // Le colonne sono `varchar(2)`: senza normalizzazione «Napoli» arriverebbe al
    // database. È già successo, sull'altro modulo pubblico.
    await inviaValida({ residence_province: 'Napoli' })
    expect(h.inserts[0].residence_province).toBe('NA')
  })

  it('il codice fiscale con gli spazi del copia-e-incolla viene ripulito, non respinto', async () => {
    // Un codice incollato da un PDF arriva spezzato in gruppi, e lo spazio è spesso
    // U+00A0 — a schermo indistinguibile da uno normale. Respingerlo direbbe a una
    // persona che il proprio codice fiscale è scritto male.
    const spezzato = `${CF_COERENTE.slice(0, 6)} ${CF_COERENTE.slice(6, 11)} ${CF_COERENTE.slice(11)}`
    const res = await inviaValida({ fiscal_code: spezzato.toLowerCase() })
    expect(res.status).toBe(201)
    expect(h.inserts[0].fiscal_code).toBe(CF_COERENTE)
  })
})

describe('POST /api/iscrizione/personale · il tetto per IP', () => {
  it('l’invio OLTRE il tetto prende 429 con Retry-After, e non tocca il database', async () => {
    // Il tetto si legge dalle opzioni con cui la route chiama `rateLimit`, non da un
    // numero ricopiato qui: così questa prova misura il prodotto e non sé stessa, e
    // resta vera il giorno in cui il tetto cambia per una ragione misurata.
    await inviaValida()
    const tetto = h.opzioni[0].limit
    for (let i = 1; i < tetto; i++) {
      expect((await inviaValida()).status, `l’invio ${i + 1} doveva passare`).toBe(201)
    }
    const scritteFinora = h.inserts.length

    const res = await inviaValida()

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(
      h.inserts.length,
      'L’invio oltre il tetto è arrivato al database: un 429 dato DOPO la scrittura non è un tetto, è un commento.',
    ).toBe(scritteFinora)
  })

  it('il tetto regge la GIORNATA DI ALLINEAMENTO di una sede intera', async () => {
    // ⚠️ QUESTA PROVA ESISTE PER UN DIFETTO MISURATO, non per completezza. Il tetto
    // era 3 l'ora, ereditato da «Lavora con noi» insieme alla sua ragione — «una
    // maestra compila la propria anagrafica una volta, non tre» — che però è un
    // ragionamento sulla PERSONA applicato a un contatore per RETE. Là le due cose
    // coincidono (una candidatura spontanea arriva da casa, una per indirizzo); qui
    // no: `personale-template.ts` dichiara che «la Segreteria manda il link alle
    // maestre in servizio», cioè più dipendenti che compilano lo stesso pomeriggio
    // dietro il NAT della sede. Dalla quarta in poi prendevano un 429 indistinguibile
    // da un servizio rotto.
    //
    // I due estremi sono MISURATI, non scelti. In produzione, l'11/08/2026: Giugliano
    // 13 account di personale (8 educator, 2 admin, 1 segreteria, 1 coordinatrice,
    // 1 cuoca), Aversa 2, Cesa 2 — e il modulo esiste PROPRIO perché le altre non
    // sono nel sistema. Sotto i 13 non ci sta la sede più grande; sopra i 30 si
    // supererebbe il tetto del modulo pubblico d'iscrizione (5 ogni 10 minuti), che
    // dalla stessa porta anonima riceve i dati di famiglie vere.
    await inviaValida()
    expect(
      h.opzioni[0].limit,
      'Il tetto non basta per la sede più grande (13 persone in servizio): la giornata di allineamento diventa una fila di 429.',
    ).toBeGreaterThanOrEqual(13)
    expect(
      h.opzioni[0].limit,
      'Il tetto ha superato quello del modulo d’iscrizione (30 l’ora) su una porta che raccoglie codici fiscali e documenti d’identità.',
    ).toBeLessThanOrEqual(30)
  })

  it('la finestra è di un’ORA, e la dichiara la route (non il finto)', async () => {
    await inviaValida()
    expect(h.opzioni[0].windowMs).toBe(60 * 60 * 1000)
    // La chiave è PER IP e PER MODULO: se fosse condivisa con «Lavora con noi», una
    // candidatura spontanea consumerebbe il tetto di una maestra che deve consegnare
    // i propri documenti, e viceversa.
    expect(h.opzioni[0].chiave).toContain('203.0.113.7')
    expect(h.opzioni[0].chiave).not.toContain('candidature')
  })

  it('la motivazione di `gate-coverage` dichiara IL TETTO VERO, non un numero ricopiato', async () => {
    // ⚠️ QUESTA PROVA ESISTE PER UN DIFETTO MISURATO, ed è di una specie particolare:
    // il codice era giusto e la DOCUMENTAZIONE mentiva. `gate-coverage.test.ts` è
    // l'elenco in cui si scrive PERCHÉ una rotta anonima può stare senza gate, e la
    // sua stessa voce dice che questa «è la voce di questo elenco che va guardata con
    // più sospetto». Per un giro intero ha dichiarato «tetto 3 invii/ora» mentre la
    // rotta era passata a 20 con quaranta righe di misura a giustificarlo: chi la
    // guardava con sospetto concludeva che il contro-presidio fosse SETTE VOLTE più
    // stretto del vero. Il lock restava verde perché quella frase è prosa in una mappa
    // e nessuna asserzione la confrontava con niente.
    //
    // È la forma di difetto che questo repo si è già scritto in CLAUDE.md dopo averla
    // pagata due settimane: «un documento che descrive una protezione che non c'è più
    // è peggio di nessun documento». Qui la protezione c'era, ma era un'altra.
    //
    // Si confronta la frase con il valore che la ROTTA passa davvero a `rateLimit`,
    // non con un letterale: interpolarlo in `gate-coverage` non è possibile — un file
    // di route Next.js non può esportare altro che i metodi HTTP, e `TETTO_INVII_ORA`
    // resta perciò privato — quindi l'unico modo di legare i due lati è un'asserzione
    // che li legga entrambi.
    await inviaValida()
    const tetto = h.opzioni[0].limit

    const sorgente = readFileSync(
      join(process.cwd(), '__tests__/architecture/gate-coverage.test.ts'),
      'utf8',
    )
    const voce = sorgente
      .split('\n')
      .find((r) => r.includes('modulo pubblico «Anagrafica del personale»'))
    expect(voce, 'la voce di `gate-coverage` per questa rotta non esiste più').toBeTruthy()

    const dichiarato = /tetto (\d+) invii\/ora/.exec(String(voce))?.[1]
    expect(
      dichiarato,
      'la motivazione non dichiara più un tetto: senza quel numero la voce non è verificabile',
    ).toBeTruthy()
    expect(
      Number(dichiarato),
      `\`gate-coverage\` dichiara un tetto di ${dichiarato} invii/ora, la rotta ne passa ${tetto} a \`rateLimit\`. ` +
        'Chi legge quell’elenco per decidere se la porta anonima è difendibile sta leggendo un numero falso.',
    ).toBe(tetto)
  })
})

describe('POST /api/iscrizione/personale · le due date, e il dossier che finiva nel log', () => {
  // ⚠️ TUTTO QUESTO BLOCCO ESISTE PER UN DIFETTO MISURATO IL 12/08/2026, e la sua
  // gravità non sta nel dato sbagliato ma in dove finiva.
  //
  // `birth_date` e `document_expiry` sono `type: 'date'` nel template SENZA oggetto
  // `validation` — e non possono averlo, perché `FormField.validation` sa dire
  // `pattern`, `min_length`, `max_length` e `min`/`max` numerici, e nessuna di quelle
  // esprime «esiste sul calendario» o «dopo il 1990». Quindi `validateField` applicava
  // la sola forma ISO. Sonda eseguita sull'imbracatura di questo file:
  // `document_expiry: '1899-01-01'` → **201**, e '1899-01-01' scritto nell'INSERT;
  // `'9999-99-99'`, `'0000-00-00'`, `'2030-02-31'`, `'2030-13-45'` → **201**, tutte.
  //
  // In produzione la tabella dichiara `check (document_expiry is null or
  // document_expiry > date '1990-01-01')` (riletto con `pg_constraint` il 12/08/2026,
  // su `pratiche_personale` E su `anagrafica_personale`). Postgres rifiuta con
  // `23514`, che non era in nessuno dei tre elenchi di codici gestiti dalla rotta: la
  // riga cadeva sul ramo generico dei 500, che passava l'oggetto PostgREST GREZZO a
  // `logErrore` — e il `details` di un `23514` è `Failing row contains (…)`.
  //
  // Cosa sopravvive a `sanificaMessaggio` su quel testo, misurato eseguendo le regex
  // vere: mascherati `[email]` e `[cf]`; in chiaro nome, cognome, sesso, nascita,
  // residenza completa, telefono, tipo e NUMERO del documento d'identità, e
  // i PERCORSI DELLE DUE SCANSIONI. In `app_log`, 30 giorni, interrogabile in SQL — da
  // un modulo senza login, scrivendo nella «Scadenza del documento» una data di due
  // secoli fa.

  it('la scadenza di due secoli fa è respinta SOTTO IL CAMPO, e non arriva al database', async () => {
    const res = await inviaValida({ document_expiry: '1899-01-01' })

    expect(
      res.status,
      'la data che la tabella rifiuta con un 23514 è passata: il rifiuto arriverà dal database, come 500',
    ).toBe(400)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PRATICA_NON_INVIATA')
    expect(
      Object.keys(corpo.campi),
      'il rifiuto non nomina il campo: chi compila non sa cosa correggere',
    ).toContain('document_expiry')
    expect(h.inserts, 'la riga è stata tentata lo stesso').toHaveLength(0)
    expect(h.errori, 'un rifiuto di un dato di chi compila è stato loggato come guasto nostro').toHaveLength(0)
  })

  it('il confine è STRETTO come quello della tabella: `1990-01-01` esatto non passa', async () => {
    // Il CHECK è `> date '1990-01-01'`, non `>=`. Con un `>=` nella rotta l'unico
    // valore ammesso in più sarebbe proprio quello che il database rifiuta: un 500
    // opaco per una data sola, cioè il difetto rimesso in piedi in un punto.
    expect((await inviaValida({ document_expiry: '1990-01-01' })).status).toBe(400)
    expect((await inviaValida({ document_expiry: '1990-01-02' })).status).toBe(201)
  })

  it('un documento GIÀ SCADUTO passa: è la riga per cui l’allarme di scadenza esiste', async () => {
    // ⚠️ L'errore opposto, e sarebbe grave quanto l'altro. Il limite è SOLO inferiore,
    // e la migrazione lo dice con parole sue: «un CHECK sul futuro rifiuterebbe
    // esattamente le righe per cui l'allarme di scadenza esiste — il documento GIÀ
    // SCADUTO dev'essere registrabile, altrimenti la Segreteria non può nemmeno
    // annotare il problema che deve risolvere». Senza questa prova, «rispecchia il
    // CHECK» si trasforma alla prima riscrittura in «rifiuta le date passate».
    const res = await inviaValida({ document_expiry: '2020-06-30' })
    expect(res.status).toBe(201)
    expect(h.inserts[0].document_expiry).toBe('2020-06-30')
  })

  it('le date che sul calendario non esistono sono respinte, su ENTRAMBI i campi', async () => {
    // La forma ISO le accetta tutte: `9999-99-99` ha quattro cifre, un trattino, due
    // cifre, un trattino, due cifre. È il database a rifiutarle — con `22008`, cioè
    // ancora un 500 opaco davanti a una persona che non ha nessuno a cui chiedere.
    for (const data of ['9999-99-99', '0000-00-00', '2030-02-31', '2030-13-45']) {
      const scadenza = await inviaValida({ document_expiry: data })
      expect(scadenza.status, `\`document_expiry: ${data}\` è passata`).toBe(400)
      expect(Object.keys((await scadenza.json()).campi)).toContain('document_expiry')

      const nascita = await inviaValida({ birth_date: data })
      expect(nascita.status, `\`birth_date: ${data}\` è passata`).toBe(400)
      expect(Object.keys((await nascita.json()).campi)).toContain('birth_date')
    }
    expect(h.inserts, 'una data impossibile è arrivata al database').toHaveLength(0)
  })

  it('il 29 febbraio esiste negli anni bisestili e non negli altri', async () => {
    // Il controllo di calendario dev'essere un CALENDARIO, non un intervallo di cifre:
    // senza il round-trip, `2025-02-29` passerebbe come qualunque «29 del mese 02».
    expect((await inviaValida({ birth_date: '2024-02-29' })).status).toBe(201)
    expect((await inviaValida({ birth_date: '2025-02-29' })).status).toBe(400)
  })

  it('i campi data sbagliati escono INSIEME agli altri, in un invio solo', async () => {
    // Due rifiuti in fila costringerebbero chi compila a scoprire un errore per volta:
    // le due mappe si fondono apposta. E le due chiavi si contano tutte, perché un
    // `Object.assign` nell'ordine sbagliato farebbe sparire in silenzio una delle due.
    const res = await inviaValida({ document_expiry: '1899-01-01', zip_code: '8' })
    expect(res.status).toBe(400)
    expect(Object.keys((await res.json()).campi).sort()).toEqual(['document_expiry', 'zip_code'])
  })

  it('nel log del rifiuto ci sono gli ID DEI CAMPI, mai i valori', async () => {
    await inviaValida({ document_expiry: '1899-01-01' })
    const riga = h.eventi.find(
      (e) => e.evento === 'personale' && String(e.campi.esito).startsWith('campi-non-validi'),
    )
    expect(riga, 'il rifiuto sulla data non lascia nessuna riga di log').toBeTruthy()
    expect(String(riga?.campi.esito)).toContain('document_expiry')
    expect(JSON.stringify(riga?.campi)).not.toContain('1899-01-01')
  })

  it('sul 500 del database il log NON porta la riga rifiutata (`Failing row contains`)', async () => {
    // ⚠️ È LA PROVA CHE CONTA DI TUTTO QUESTO BLOCCO, e resta necessaria anche adesso
    // che `document_expiry` è rispecchiato: chiude la CLASSE, non il caso. Il giorno in
    // cui una migrazione aggiungerà un CHECK che nessuno rispecchia — o un `not null`
    // su una colonna nuova — il `23514`/`23502` tornerà, e con lui il `details`.
    //
    // Si arma un errore nella forma ESATTA in cui PostgREST lo restituisce (`details`
    // compreso: PostgREST NON lancia) e si guarda cosa arriva a `logErrore` DOPO essere
    // passato dal serializzatore vero.
    const percorso = caricato()
    h.erroreInsert = {
      code: '23514',
      message:
        'new row for relation "pratiche_personale" violates check constraint "pratiche_personale_document_expiry_check"',
      details:
        'Failing row contains (11111111-1111-1111-1111-111111111111, pending, Ines, Prova, F, ' +
        `1985-03-12, Comune di Prova, NA, Italia, H501, ${CF_COERENTE}, Italiana, Via di Prova, 1, ` +
        'Comune di Prova, NA, 80014, ines.prova@example.invalid, +39 333 0000000, CI, AB1234567, ' +
        `1899-01-01, ${percorso}, laurea_triennale, {nido,infanzia}).`,
    }

    const res = await inviaValida({ documento_fronte_path: percorso })
    expect(res.status).toBe(500)

    expect(h.errori, 'un 500 del database non ha lasciato nessuna riga di log').toHaveLength(1)
    const descritto = JSON.stringify(descriviErrore(h.errori[0].err))

    // Il PERCORSO per primo: è la chiave con cui si firma la fotografia di una carta
    // d'identità, e `redact()` non ce l'ha in lista bianca — la difesa deve stare qui.
    expect(
      descritto,
      'il percorso della scansione del documento d’identità è finito in `app_log`, dove resta 30 giorni',
    ).not.toContain(percorso)
    // E il resto del dossier. `[email]` e `[cf]` li maschera `sanificaMessaggio`; tutto
    // ciò che segue no, ed è la ragione per cui il campo `details` non si passa affatto.
    for (const [cosa, valore] of [
      ['il cognome', 'Prova'],
      ['il comune di nascita', 'Comune di Prova'],
      ['l’indirizzo di casa', 'Via di Prova'],
      ['il telefono', '+39 333 0000000'],
      ['il numero del documento', 'AB1234567'],
      ['il dump della riga', 'Failing row contains'],
    ] as const) {
      expect(descritto, `nel log è finito ${cosa}`).not.toContain(valore)
    }

    // ⚠️ E LA DIAGNOSI NON SI PERDE (AGENTS §3): `message` e `code` passano interi, e
    // il `message` di un `23514` NOMINA il vincolo saltato. Senza questa asserzione la
    // correzione più facile sarebbe smettere di loggare, che è il difetto opposto.
    expect(descritto).toContain('pratiche_personale_document_expiry_check')
    expect(descritto).toContain('23514')
  })
})

describe('POST /api/iscrizione/personale · ciò che non deve entrare', () => {
  it('l’esca piena prende 400 con un codice, MAI un finto 201', async () => {
    // Un successo inventato è una bugia scritta in grande: direbbe «ricevuta» quando
    // non c'è nessuna riga, e il giorno in cui l'esca scattasse su una persona vera
    // nessuno lo saprebbe mai.
    const res = await invia({ scuola_id: SEDE_A, data: pratica(), sito_web: 'https://spam' })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('PRATICA_NON_INVIATA')
    expect(h.inserts).toHaveLength(0)
    expect(h.eventi.some((e) => e.evento === 'personale' && e.campi.esito === 'honeypot')).toBe(true)
  })

  it('`honeypot` vale quanto `sito_web`: il modulo e la route si accordano sui due nomi', async () => {
    // Un'esca che scatta con un nome e non con l'altro è una difesa che sembra
    // esserci: costa zero riconoscerli entrambi.
    const res = await invia({ scuola_id: SEDE_A, data: pratica(), honeypot: 'x' })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('`gradi: []` è respinto da ZOD, non dal database con un `22P02`', async () => {
    // `pratiche_personale.gradi` è `school_type_enum[]`: un valore fuori enum non fa
    // un 400, arriva all'INSERT e prende `22P02` — cioè un 500 opaco davanti a una
    // persona che non ha nessuno a cui chiedere. Il rifiuto deve arrivare PRIMA.
    const res = await inviaValida({ gradi: [] })
    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo.error, 'il rifiuto non viene da zod').toBe('Dati non validi')
    expect(JSON.stringify(corpo.details)).toContain('gradi')
    expect(h.inserts, 'un array vuoto è arrivato al database').toHaveLength(0)
  })

  it('una fascia inventata è respinta da zod (l’enum lo dice il template, non un letterale)', async () => {
    const res = await inviaValida({ gradi: ['nido', 'universita'] })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('i campi non validi tornano SOTTO IL CAMPO, e nel log ci vanno solo gli id', async () => {
    const res = await inviaValida({ zip_code: '8', residence_province: 'ZZ' })
    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PRATICA_NON_INVIATA')
    expect(Object.keys(corpo.campi).sort()).toEqual(['residence_province', 'zip_code'])
    expect(h.inserts).toHaveLength(0)

    // L'ESITO STA IN 64 CARATTERI, altrimenti `redact()` lo riduce TUTTO a
    // `[redatto:str/N]` e nel log non resta nemmeno la parola «campi-non-validi».
    // Con 32 campi nel template non è un caso limite: è il primo invio incompleto.
    const rifiuto = h.eventi.find(
      (e) => e.evento === 'personale' && String(e.campi.esito).startsWith('campi-non-validi'),
    )
    expect(rifiuto?.livello).toBe('warn')
    expect(String(rifiuto?.campi.esito).length).toBeLessThanOrEqual(64)
    expect(rifiuto?.campi.n).toBe(2)
    // E NESSUN VALORE: nel log vanno gli id dei campi, non ciò che è stato digitato.
    expect(JSON.stringify(rifiuto?.campi)).not.toContain('ZZ')
  })

  it('un modulo quasi vuoto non fa esplodere l’esito oltre i 64 caratteri', async () => {
    // È il caso che innesca il troncamento: 20 campi obbligatori non compilati.
    // Senza il conteggio dei tagliati l'esito direbbe una cosa falsa — che i campi
    // respinti erano quelli e basta.
    const res = await invia({ scuola_id: SEDE_A, data: { gradi: ['nido'] } })
    expect(res.status).toBe(400)
    const rifiuto = h.eventi.find(
      (e) => e.evento === 'personale' && String(e.campi.esito).startsWith('campi-non-validi'),
    )
    const esito = String(rifiuto?.campi.esito)
    expect(esito.length).toBeLessThanOrEqual(64)
    expect(esito, 'l’elenco è troncato ma non dice quanti campi mancano').toMatch(/\+\d+$/)
  })

  it('senza tutte e tre le prese visione la pratica non si scrive', async () => {
    const res = await inviaValida({ presa_visione_copia_documento: false })
    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PRATICA_NON_INVIATA')
    expect(corpo.consensi).toEqual(['presa_visione_copia_documento'])
    expect(h.inserts).toHaveLength(0)
  })

  it('la versione dei consensi NON arriva dal client', async () => {
    // Dentro `data`, che è l'unico posto che conta: `postBodySchema` al primo livello
    // è uno `z.object` semplice, quindi una chiave in più là verrebbe scartata da
    // sola e il test non proverebbe niente.
    await inviaValida({
      versione_consensi: '1999-01-01',
      versione_informativa: '1999-01-01',
      consents_log: { versione_consensi: '1999-01-01' },
    })
    const prova = h.inserts[0].consents_log as Record<string, unknown>
    expect(prova.versione_consensi).toBe(CONSENSI_PERSONALE_VERSIONE)
    expect(prova.versione_informativa).toBe(VERSIONE_PRIVACY)
  })
})

describe('POST /api/iscrizione/personale · il codice fiscale, due livelli distinti', () => {
  it('il carattere di controllo sbagliato BLOCCA: quel codice non è di nessuno', async () => {
    // È un refuso di battitura, e farlo entrare significa scriverlo su un contratto,
    // su una comunicazione UNILAV e su una denuncia INPS.
    const res = await inviaValida({ fiscal_code: CF_CHECKSUM_ROTTA })
    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PRATICA_NON_INVIATA')
    expect(Object.keys(corpo.campi)).toEqual(['fiscal_code'])
    expect(h.inserts, 'un codice fiscale inesistente è arrivato in tabella').toHaveLength(0)

    // Il MOTIVO si logga come enumerato, così si può contare in SQL quale refuso
    // arriva davvero — e IL CODICE NO: sedici caratteri senza spazi sarebbero un
    // enumerato perfetto, e finirebbero in chiaro in `app_log`.
    const rifiuto = h.eventi.find((e) =>
      String(e.campi.esito).startsWith('codice-fiscale-non-valido'),
    )
    expect(rifiuto?.campi.esito).toBe('codice-fiscale-non-valido-checksum')
    expect(JSON.stringify(h.eventi)).not.toContain(CF_CHECKSUM_ROTTA)
  })

  it('il codice VALIDO ma incoerente col nome passa, e torna come `avvisi`', async () => {
    // Bloccare respingerebbe omocodie e comuni soppressi, cioè persone vere a cui si
    // direbbe che il proprio codice fiscale non esiste. La regola del repo è «segnala
    // sempre, non blocca mai».
    const res = await inviaValida({ fiscal_code: CF_INCOERENTE })
    expect(res.status).toBe(201)
    const corpo = await res.json()
    expect(corpo.id).toBe('pratica-nuova')
    expect(corpo.avvisi, 'l’incoerenza non è stata segnalata a chi compila').toEqual(['cognome'])
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0].fiscal_code).toBe(CF_INCOERENTE)

    // Quante contraddizioni si stanno accettando è una domanda da fare in SQL.
    const felice = h.eventi.find((e) => e.campi.esito === 'pratica-ricevuta')
    expect(felice?.campi.n_avvisi_cf).toBe(1)
  })

  it('un dato anagrafico MANCANTE non produce un avviso (mancante non è sbagliato)', async () => {
    // `birth_province` è facoltativo, e non entra nel calcolo del codice: la sua
    // assenza non deve diventare una contraddizione. È la regola misurata su 45
    // record su 83 in produzione — un pannello che segnala tutto non segnala niente.
    const res = await inviaValida({ birth_province: '', birth_place: '' })
    expect(res.status).toBe(201)
    expect((await res.json()).avvisi).toEqual([])
  })
})

describe('POST /api/iscrizione/personale · il percorso della scansione', () => {
  it('un percorso in un ALTRO bucket è respinto, e non compare in nessun log', async () => {
    // `iscrizioni/…` è il prefisso di `form_attachments`, cioè del bucket che
    // custodisce i documenti d'iscrizione dei MINORI. Se quel valore entrasse in
    // tabella, il pannello di Segreteria lo userebbe per farsi firmare un URL.
    const altrui = 'iscrizioni/modulo/00000000-0000-4000-8000-000000000000-carta.pdf'
    const res = await inviaValida({ documento_fronte_path: altrui })

    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(Object.keys(corpo.campi)).toEqual(CAMPI_DOCUMENTO)
    expect(h.inserts).toHaveLength(0)

    // ⚠️ IL PERCORSO NON SI LOGGA: è la chiave che apre il documento d'identità di
    // una persona. Si registra CHE è stato respinto, non che cosa era.
    const rifiuto = h.eventi.find((e) => e.campi.esito === 'documento-path-non-ammesso')
    expect(rifiuto?.livello).toBe('warn')
    expect(JSON.stringify(h.eventi), 'il percorso respinto è finito nei log').not.toContain(
      'iscrizioni/',
    )
  })

  // ⚠️ QUESTI CINQUE CASI ASSERIVANO IL SOLO `status`, ED È TROPPO POCO — un rilievo
  // misurato e non un gusto. Un 400 su questa rotta può arrivare da sei posti diversi
  // (`validatePage`, le date, il codice fiscale, i consensi, la sede, il gate del
  // percorso), e finché l'asserzione è «400» il test resta verde anche quando il 400
  // arriva da un campo obbligatorio mancante nel payload di prova — cioè anche
  // CANCELLANDO il gate che dice di misurare. È esattamente com'è andata il
  // 12/08/2026: il campo si chiamava ancora `documento_path`, il gate non girava mai, e
  // questi cinque restavano verdi perché `validatePage` respingeva le due facce nuove
  // che il payload non portava.
  //
  // Perciò ognuno asserisce ORA tre cose che solo il gate può produrre: il `codice`, i
  // `campi` (tutte e due le facce, derivate dal template) e la riga di log
  // `documento-path-non-ammesso`.
  it.each([
    ['una risalita nel percorso', 'documenti/../../etc/passwd'],
    ['un uuid inventato a mano', 'documenti/non-un-uuid/anche-questo.pdf'],
    ['un’estensione fuori elenco', `documenti/${crypto.randomUUID()}/${crypto.randomUUID()}.exe`],
    ['il nome del file al posto dell’uuid', `documenti/${crypto.randomUUID()}/carta-identita.pdf`],
    ['un percorso lunghissimo', `documenti/${'a'.repeat(300)}/x.pdf`],
  ])('%s è respinto DAL GATE, non da un campo obbligatorio', async (_caso, percorso) => {
    const res = await inviaValida({ documento_fronte_path: percorso })

    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PRATICA_NON_INVIATA')
    expect(Object.keys(corpo.campi).sort()).toEqual([...CAMPI_DOCUMENTO].sort())
    expect(h.inserts).toHaveLength(0)

    const rifiuto = h.eventi.find((e) => e.campi.esito === 'documento-path-non-ammesso')
    expect(rifiuto, 'il 400 non viene dal gate di forma: arriva da un altro controllo').toBeDefined()
    expect(rifiuto?.livello).toBe('warn')
    // ⚠️ E IL REGISTRO NON È STATO NEMMENO INTERROGATO: il gate di forma costa zero e
    // sta davanti: un percorso malformato non deve arrivare a una query.
    expect(h.lettureRegistro, 'un percorso malformato è arrivato fino al database').toHaveLength(0)
    expect(JSON.stringify(h.eventi), 'il percorso respinto è finito nei log').not.toContain(percorso)
  })

  // ⚠️ IL CICLO È SU `CAMPI_DOCUMENTO`: ogni faccia è una porta, e una porta che nessuno
  // prova è una porta aperta. Finché il caso esisteva solo sul fronte, un gate che
  // guardasse la prima faccia e basta sarebbe rimasto verde — ed è precisamente la forma
  // del difetto che questo giro ripara (la rotta reclamava `percorsiDocumento[0]`).
  it.each(CAMPI_DOCUMENTO)(
    'la faccia «%s» col traversal è respinta, e la risposta non dice QUALE',
    async (campo) => {
      const res = await inviaValida({ [campo]: 'documenti/../../etc/passwd' })

      expect(res.status).toBe(400)
      const corpo = await res.json()
      // ⚠️ TUTTE E DUE LE CHIAVI, QUALUNQUE FACCIA SIA IL COLPEVOLE. Nominare solo
      // quella caduta direbbe a chi tenta che l'ALTRA è stata accettata — cioè che
      // quell'oggetto esiste nel registro — e in due richieste si saprebbe quali
      // scansioni sono state caricate.
      expect(Object.keys(corpo.campi).sort()).toEqual([...CAMPI_DOCUMENTO].sort())
      expect(h.inserts).toHaveLength(0)
    },
  )

  it('il percorso che la rotta di upload produce davvero è accettato (controllo positivo)', async () => {
    // Senza questo, il gate potrebbe rifiutare TUTTO e i test sopra resterebbero
    // verdi: un modulo che non accetta nessun documento passerebbe per sicuro.
    const buono = caricato(percorsoValido('heic'))
    const res = await inviaValida({ documento_fronte_path: buono })
    expect(res.status).toBe(201)
    expect(h.inserts[0].documento_fronte_path).toBe(buono)
  })

  it('le due facce NON possono essere lo stesso oggetto, e la pratica non entra', async () => {
    // ⚠️ IL DANNO NON È «UN DATO SCRITTO DUE VOLTE»: due colonne che nominano lo stesso
    // oggetto significano che la conservazione di UN LATO cancella il file che l'altro
    // sta ancora usando — cioè l'invariante «un oggetto, un proprietario» rotta dentro
    // una riga sola. E il modo più facile di «finire» il modulo sarebbe allegare due
    // volte la stessa foto: la Segreteria aprirebbe una scheda «completa» col retro
    // mancante, senza nessuna riga che lo dica. Il database non può accorgersene
    // (nessun vincolo lega due colonne della stessa riga) e il client non basta: qui si
    // entra anche senza di lui.
    const stesso = caricato()
    const res = await inviaValida(
      Object.fromEntries(CAMPI_DOCUMENTO.map((campo) => [campo, stesso])),
    )

    expect(res.status).toBe(400)
    expect(h.inserts, 'una pratica con due facce identiche è entrata').toHaveLength(0)
    // Il registro non c'entra e non va nemmeno interrogato: il confronto costa zero.
    expect(h.lettureRegistro).toHaveLength(0)
    // L'esito è SUO — «le due facce sono lo stesso oggetto» non è «la forma è
    // sbagliata» né «non esiste»: chi legge `app_log` deve poterli separare.
    const rifiuto = h.eventi.find((e) => e.campi.esito === 'documento-facce-uguali')
    expect(rifiuto, 'due facce identiche sono passate senza lasciare traccia').toBeDefined()
    expect(rifiuto?.livello).toBe('warn')
    expect(JSON.stringify(h.eventi), 'il percorso è finito nei log').not.toContain(stesso)
  })

  it('la risposta alle facce uguali è IDENTICA a quella della forma sbagliata', async () => {
    // L'esito nel log è distinto (test qui sopra); la RISPOSTA no, ed è la stessa
    // regola dei quattro motivi di rifiuto: una risposta che dicesse «questi due sono
    // lo stesso oggetto» confermerebbe a chi tenta che quel percorso è stato
    // riconosciuto — cioè che esiste.
    const formaSbagliata = await inviaValida({
      documento_fronte_path: 'documenti/non-un-uuid/x.pdf',
    })
    const corpoForma = await formaSbagliata.json()

    h.colpi.clear()
    const stesso = caricato()
    const duplicate = await inviaValida(
      Object.fromEntries(CAMPI_DOCUMENTO.map((campo) => [campo, stesso])),
    )

    expect(duplicate.status).toBe(formaSbagliata.status)
    expect(await duplicate.json()).toEqual(corpoForma)
  })
})

// =============================================================================
// IL PERCORSO ESISTE, ED È ANCORA DI NESSUNO — i due difetti che il gate di sola
// FORMA lasciava aperti, e che nessun test coglieva perché la forma era giusta.
//
//  · L'OGGETTO CHE NON ESISTE. `documento_fronte_path` e `documento_retro_path` sono
//    `required: true` nel template e sono la ragione per cui questo modulo esiste, ma
//    il gate di forma si soddisfaceva con una stringa
//    inventata `documenti/<uuid>/<uuid>.pdf` — e quella forma è documentata in un
//    repository PUBBLICO. La Segreteria avrebbe visto una pratica «completa» e lo
//    avrebbe scoperto solo cliccando.
//  · L'OGGETTO CHE È GIÀ DI UN ALTRO. Un URL firmato contiene il percorso in
//    chiaro: basta un link inoltrato per conoscerlo. Il gemello delle candidature
//    chiude quella catena spostando il prefisso; qui il prefisso `documenti/` è LO
//    STESSO che genera l'unica rotta di caricamento, quindi quella difesa non c'è.
//    Chi conosce un percorso legittimo poteva allegarlo a una pratica per un'ALTRA
//    sede, e la Segreteria di quel plesso si sarebbe fatta firmare il documento
//    d'identità di una persona che non è sua. E la migrazione dichiara l'invariante
//    come un fatto — «Un oggetto, un proprietario» — senza che nessuno la imponesse:
//    due righe con lo stesso percorso, e la retention della prima cancella il file
//    che la seconda sta ancora usando.
// =============================================================================
describe('POST /api/iscrizione/personale · il registro dei caricamenti', () => {
  it('un percorso MAI CARICATO è respinto, anche se la forma è perfetta', async () => {
    const inventato = percorsoValido() // forma giusta, ma nessuno l'ha mai caricato
    const res = await inviaValida({ documento_fronte_path: inventato })

    expect(res.status).toBe(400)
    expect(Object.keys((await res.json()).campi)).toEqual(CAMPI_DOCUMENTO)
    expect(h.inserts, 'una pratica «completa» è entrata senza nessun documento dietro').toHaveLength(0)

    const rifiuto = h.eventi.find((e) => e.campi.esito === 'documento-path-non-reclamabile')
    expect(rifiuto?.livello).toBe('warn')
    // La sede c'è — serve a sapere QUALE Segreteria stava per ricevere la pratica —
    // e il percorso no: è la chiave che apre il documento d'identità di una persona.
    expect(rifiuto?.campi.scuola_id).toBe(SEDE_A)
    expect(JSON.stringify(h.eventi), 'il percorso respinto è finito nei log').not.toContain(
      'documenti/',
    )
  })

  it('il reclamo è UNA lettura sola, con dentro TUTTE E DUE le facce', async () => {
    // ⚠️ NON È UN CONTEGGIO PER ELEGANZA. Con una lettura per faccia, fra la prima e la
    // seconda si apre una finestra in cui l'altra può essere reclamata da qualcun
    // altro: il verdetto smette di essere un'aritmetica su una risposta sola e diventa
    // una race. `caricamentiReclamabili` fa un `.in('percorso', […])` solo, e questa è
    // l'unica prova che la rotta la usa così invece di ciclare.
    const fronte = caricato()
    const retro = caricato()

    const res = await inviaValida({
      documento_fronte_path: fronte,
      documento_retro_path: retro,
    })

    expect(res.status).toBe(201)
    expect(
      h.lettureRegistro,
      'il registro è stato interrogato una volta per faccia: fra le due letture c’è una finestra',
    ).toHaveLength(1)
    expect([...h.lettureRegistro[0]].sort()).toEqual([fronte, retro].sort())
  })

  it.each(CAMPI_DOCUMENTO)(
    'basta che la faccia «%s» non sia reclamabile perché la pratica NON entri',
    async (campo) => {
      // ⚠️ NON ESISTE LA PRATICA MEZZA DOCUMENTATA, ed è il cuore del plurale. Se si
      // accettasse la riga con la sola faccia buona, la Segreteria aprirebbe una scheda
      // che nomina due scansioni e ne trova una — senza sapere perché — e l'altra
      // sarebbe una stringa inventata che non apre niente. Accettare «quasi tutto» qui
      // significa spostare il problema sulla scrivania di chi deve approvare.
      //
      // L'altra faccia è REGOLARE e davvero caricata: se il rifiuto arrivasse da lei, o
      // dalla forma, questo test misurerebbe un'altra difesa.
      const res = await inviaValida({ [campo]: percorsoValido() })

      expect(res.status).toBe(400)
      expect(Object.keys((await res.json()).campi).sort()).toEqual([...CAMPI_DOCUMENTO].sort())
      expect(
        h.inserts,
        'una pratica con una faccia sola verificata è entrata in tabella',
      ).toHaveLength(0)
      // E il verdetto viene dal REGISTRO, non dalla forma: il percorso inventato ha la
      // forma perfetta, quindi il gate del punto 7 non lo tocca.
      const esiti = h.eventi.map((e) => e.campi.esito)
      expect(esiti).toContain('documento-path-non-reclamabile')
      expect(esiti).not.toContain('documento-path-non-ammesso')
      // Una faccia caduta su due: il numero sta nel log, e nella risposta no.
      expect(
        h.eventi.find((e) => e.campi.esito === 'documento-path-non-reclamabile')?.campi.n_mancanti,
      ).toBe(1)
    },
  )

  it('la faccia buona NON viene collegata quando l’altra cade: niente resta a metà', async () => {
    // Il rifiuto sta PRIMA dell'INSERT, quindi non c'è nessuna pratica a cui collegare
    // niente. Ma la prova serve lo stesso: un collegamento tentato qui lascerebbe la
    // faccia buona appesa a una pratica che non esiste — e la spazzata, che guarda
    // `pratica_id is null`, non la raccoglierebbe MAI più.
    const fronte = caricato()

    const res = await inviaValida({
      documento_fronte_path: fronte,
      documento_retro_path: percorsoValido(),
    })

    expect(res.status).toBe(400)
    expect(h.collegamenti, 'si è collegato un oggetto a una pratica mai nata').toHaveLength(0)
    expect(h.registroCaricamenti.get(fronte), 'la faccia buona ha cambiato proprietario').toBe(null)
  })

  it('un percorso GIÀ DI UN’ALTRA PRATICA è respinto: un oggetto, un proprietario', async () => {
    // La riga di registro esiste, ma `pratica_id` è valorizzato. È il percorso
    // trapelato da un URL firmato e riusato per una pratica di un'altra sede.
    const altrui = percorsoValido()
    h.registroCaricamenti.set(altrui, 'pratica-di-qualcun-altro')

    const res = await inviaValida({ documento_fronte_path: altrui })

    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
    // E il proprietario non cambia: nessuno se l'è portato via.
    expect(h.registroCaricamenti.get(altrui)).toBe('pratica-di-qualcun-altro')
  })

  it('la risposta è IDENTICA a quella della forma sbagliata: nessun oracolo', async () => {
    // Se le due risposte differissero, chi prova percorsi inventati saprebbe DALLA
    // RISPOSTA quando ne ha indovinato uno vero — cioè la verifica diventerebbe uno
    // strumento per censire le scansioni caricate. È lo stesso ragionamento con cui
    // il doppione risponde 201 invece di 409.
    const formaSbagliata = await inviaValida({ documento_fronte_path: 'documenti/non-un-uuid/x.pdf' })
    const corpoForma = await formaSbagliata.json()

    h.colpi.clear()
    const nonEsiste = await inviaValida({ documento_fronte_path: percorsoValido() })
    const corpoEsistenza = await nonEsiste.json()

    expect(nonEsiste.status).toBe(formaSbagliata.status)
    expect(corpoEsistenza).toEqual(corpoForma)
    // Ma nei LOG i due fatti restano distinti: chi legge `app_log` deve poter dire
    // «mi mandano percorsi malformati» da «mi mandano percorsi che non esistono».
    const esiti = h.eventi.map((e) => e.campi.esito)
    expect(esiti).toContain('documento-path-non-ammesso')
    expect(esiti).toContain('documento-path-non-reclamabile')
  })

  it('la pratica creata DIVENTA la proprietaria di TUTTE E DUE le facce', async () => {
    // ⚠️ È LA PROVA CHE HA MORSO PER PRIMA DOPO IL RINOMINO, e il difetto che chiude è
    // il peggiore di questa corsia: fino al 12/08/2026 la rotta reclamava e collegava UN
    // oggetto solo — il fronte — mentre `pratiche_personale` nominava anche il retro.
    // Il retro restava con `pratica_id is null`, cioè «in sospeso», e
    // `spazzaCaricamentiSospesi` lo toglie dal bucket entro 24 ore: la Segreteria
    // avrebbe aperto una scheda con metà del documento d'identità mancante, senza
    // nessuna riga di log che lo dicesse. Asserire solo sul fronte lasciava quel buco
    // verde, perché il fronte si collega benissimo.
    const fronte = caricato()
    const retro = caricato()
    const res = await inviaValida({
      documento_fronte_path: fronte,
      documento_retro_path: retro,
    })

    expect(res.status).toBe(201)
    // UNA chiamata sola per DUE facce: con una per faccia il fronte può collegarsi e il
    // retro no, e restano due righe di log scoordinate che nessuno sa ricomporre.
    expect(h.collegamenti, 'gli oggetti sono rimasti in sospeso: la spazzata li toglierà').toHaveLength(1)
    expect(
      [...h.collegamenti[0].percorsi].sort(),
      'una faccia non è stata nemmeno chiesta al registro: quella la spazzata la toglie entro 24 ore mentre la pratica la nomina',
    ).toEqual([fronte, retro].sort())
    // L'uuid della riga appena scritta, non uno qualunque: è ciò che lega i file
    // alla pratica di cui condividono il destino (90 giorni se non viene approvata).
    expect(h.collegamenti[0].praticaId).toBe('pratica-nuova')
    expect(h.collegamenti[0].collegati).toBe(2)
    expect(h.collegamenti[0].riuscito).toBe(true)
    // Lo STATO, non l'intenzione: le due righe di registro adesso nominano la pratica.
    expect(h.registroCaricamenti.get(fronte)).toBe('pratica-nuova')
    expect(h.registroCaricamenti.get(retro)).toBe('pratica-nuova')
  })

  it('il collegamento sta DOPO la riga: se fallisce la pratica resta, e lo si GRIDA', async () => {
    // La pratica c'è e non si torna indietro per questo. Ma senza il collegamento la
    // spazzata toglierà quell'oggetto fra qualche ora mentre una pratica lo nomina
    // ancora: la Segreteria aprirebbe una scheda col documento mancante.
    h.erroreCollegamento = { code: '57014', message: 'statement timeout' }

    const res = await inviaValida()

    expect(res.status).toBe(201)
    const guasto = h.eventi.find((e) => e.campi.esito === 'caricamento-non-collegato')
    expect(guasto?.livello).toBe('error')
    // L'uuid della pratica È nel log, ed è ciò che rende il guasto riparabile: è un
    // uuid, che `redact()` lascia passare per forma, non un dato personale.
    expect(guasto?.campi.entita_id).toBe('pratica-nuova')
    expect(JSON.stringify(h.eventi)).not.toContain('documenti/')
  })

  it('il doppio invio (`23505`) NON si appropria di niente', async () => {
    // Là nessuna riga nuova è stata scritta, quindi non c'è nessun proprietario da
    // registrare: quel percorso resta in sospeso e la spazzata lo toglie, che è
    // giusto — è un oggetto che nessuna pratica nominerà mai. Collegarlo alla pratica
    // VIVA di qualcun altro sarebbe peggio: le assegnerebbe un file che non è suo.
    h.erroreInsert = { code: '23505', message: 'duplicate key value' }
    h.vivaPerEmail = {
      id: 'pratica-viva',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }
    const percorso = caricato()

    const res = await inviaValida({ documento_fronte_path: percorso })

    expect(res.status).toBe(201)
    expect(h.collegamenti).toHaveLength(0)
    expect(h.registroCaricamenti.get(percorso), 'l’oggetto è stato assegnato alla pratica di un altro').toBe(null)
  })

  /**
   * ⚠️ QUESTA PROVA DICEVA IL CONTRARIO, ed è la seconda volta che succede in questo
   * modulo: la gemella dell'upload («registro ASSENTE: l'oggetto si RITIRA lo stesso»)
   * ha cambiato verso per la stessa ragione, misurata lo stesso giorno.
   *
   * Diceva «registro ASSENTE (CI non migrata): non blocca, e non fa RUMORE di livello
   * error», e pretendeva 201. Due misure l'hanno smontata:
   *
   *  · **quello NON è lo stato della CI, è quello della PRODUZIONE di oggi.**
   *    `pg_class` il 12/08/2026: `caricamenti_personale` assente (migrazione
   *    `20260811234334`, non applicata), bucket `documenti_personale` presente
   *    (`20260811205643`, applicata). Le due migrazioni non viaggiano insieme;
   *  · **sulla CI questo ramo non ci si arriva.** Il reclamo sta DOPO il controllo
   *    della sede, e `sediReali` esclude la sede E2E: sul database della CI la
   *    richiesta esce con 400 `SEDE_DA_SPECIFICARE` prima di arrivarci. La
   *    giustificazione del fail-open descriveva uno scenario irraggiungibile.
   *
   * E in quello stato il fail-open non proteggeva NESSUNA persona vera, perché nessuna
   * poteva avere un percorso valido: la rotta di upload, davanti allo stesso codice
   * d'errore, ritira l'oggetto e risponde 500. Proteggeva solo chi il percorso se lo
   * inventa — la forma sta scritta in un repository pubblico — e la Segreteria avrebbe
   * ricevuto una pratica «completa» che punta a un oggetto inesistente: il difetto
   * n. 2 dell'elenco in cima a questo blocco, ricreato dalla difesa stessa.
   */
  it('registro ASSENTE: il percorso INVENTATO è respinto, e le due rotte dicono la stessa cosa', async () => {
    // La tabella che non c'è NON risponde né alla lettura né all'`update`: armare solo
    // il primo dei due errori descriverebbe un database che esiste a metà, e il finto
    // direbbe che il collegamento riesce su una tabella che non esiste.
    const assente = { code: 'PGRST205', message: "Could not find the table 'caricamenti_personale'" }
    h.erroreRegistro = assente
    h.erroreCollegamento = assente
    // MAI CARICATO: è il percorso che qualunque lettore del repository pubblico sa
    // costruire, ed è l'unico che in questo stato del database possa esistere.
    const inventato = percorsoValido()

    const res = await inviaValida({ documento_fronte_path: inventato })

    expect(
      res.status,
      'il registro non c’è e la pratica è entrata: la Segreteria vedrà una scheda «completa» che punta al nulla',
    ).toBe(400)
    expect(h.inserts).toHaveLength(0)
    expect(Object.keys((await res.json()).campi)).toEqual(CAMPI_DOCUMENTO)

    // ── IL GRIDO, e perché adesso è `error` e non più `warn` ────────────────
    // Una tabella che manca in produzione è configurazione mancante (AGENTS §4) e da
    // adesso CHIUDE una porta: senza il numero della migrazione, «400 sul documento»
    // non è diagnosticabile da nessuno. È lo stesso livello e lo stesso messaggio con
    // cui la rotta di upload dichiara lo stesso stato — le due non devono divergere.
    const grido = h.eventi.find((e) => e.campi.esito === 'registro-caricamenti-assente')
    expect(grido?.livello).toBe('error')
    expect(String(grido?.campi.msg)).toContain('20260811234334')

    // E il rifiuto dice DA SOLO perché è successo: senza questo flag, «ho chiuso la
    // porta a tutti» e «mi hanno mandato un percorso falso» sono lo stesso esito.
    const rifiuto = h.eventi.find((e) => e.campi.esito === 'documento-path-non-reclamabile')
    expect(rifiuto?.campi.registro_assente).toBe(true)
    expect(JSON.stringify(h.eventi), 'il percorso è finito nei log').not.toContain('documenti/')
  })

  it('registro ASSENTE: il rifiuto vale anche per un percorso DAVVERO caricato', async () => {
    // Non è un doppione del test qui sopra: dice che il verdetto non dipende da cosa
    // c'è nella mappa del finto, perché la LETTURA non arriva a guardarla. È la
    // proprietà che rende la difesa onesta — in quello stato del database non esiste
    // nessun percorso valido, e infatti la porta di caricamento non ne consegna
    // nemmeno uno: risponde 500 dopo aver ritirato l'oggetto.
    const percorso = caricato()
    h.erroreRegistro = { code: 'PGRST205', message: 'Could not find the table' }

    const res = await inviaValida({ documento_fronte_path: percorso })

    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
    expect(h.collegamenti, 'si è provato a collegare un oggetto a una pratica mai nata').toHaveLength(0)
  })

  it('registro ASSENTE: chi RIMANDA il proprio modulo continua a leggere 201', async () => {
    // ⚠️ È QUI CHE SI VEDE SE LA PORTA È STATA CHIUSA IN FACCIA ALLE PERSONE SBAGLIATE.
    // Chiudere sul registro assente non deve riaprire il difetto che
    // `documentoDiUnaPraticaViva` ha chiuso: chi ha già inviato (quando il registro
    // c'era) e ripreme «Invia» deve leggere 201, non un errore sull'unico campo che non
    // ha niente di sbagliato — mentre la sua pratica è stata ricevuta.
    const percorso = caricato()
    expect((await inviaValida({ documento_fronte_path: percorso })).status).toBe(201)

    // Da qui in avanti il database è quello di oggi: la tabella non c'è più (o non c'è
    // ancora). La pratica viva, invece, sì — ed è lei a rendere l'eccezione sicura,
    // perché è la riga con cui l'INSERT sta per collidere.
    h.erroreRegistro = { code: 'PGRST205', message: 'Could not find the table' }
    h.inserts = []
    h.erroreInsert = { code: '23505', message: 'duplicate key value violates unique constraint' }
    h.vivaPerEmail = {
      id: 'pratica-viva',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }
    h.colpi.clear()

    const secondo = await inviaValida({ documento_fronte_path: percorso })

    expect(
      secondo.status,
      'col registro assente il secondo invio è stato respinto: la pratica c’è, e le si dice che il suo documento non vale',
    ).toBe(201)
    expect((await secondo.json()).id).toBe('pratica-viva')
    expect(h.inserts, 'il secondo invio non è nemmeno arrivato all’INSERT').toHaveLength(1)
    expect(h.eventi.map((e) => e.campi.esito)).toContain('documento-path-della-propria-pratica')
    expect(h.eventi.map((e) => e.campi.esito)).not.toContain('documento-path-non-reclamabile')
  })

  it('registro che NON RISPONDE: la pratica passa E il collegamento si TENTA lo stesso', async () => {
    // ⚠️ IL DIFETTO CHE QUESTO TEST IMPEDISCE, e che è passato inosservato una volta
    // proprio qui: c'era `if (!reclamo.degradato) caricamentoDaCollegare = …`, quindi
    // un guasto TRANSITORIO della lettura (tabella presente, query in errore) faceva
    // accettare la pratica senza tentare MAI il collegamento. Misurato con `57014`:
    // 201, i percorsi scritti nella riga, ZERO tentativi di collegamento, righe
    // di registro ancora `pratica_id = null`.
    //
    // La conseguenza non è un log mancante: il predicato della spazzata è esattamente
    // `pratica_id is null` (e, dal 12/08/2026, `anagrafica_utente_id is null`) +
    // `caricato_il` oltre soglia, quindi quelle scansioni escono dal bucket entro 24 ore
    // mentre `pratiche_personale.documento_fronte_path` e `documento_retro_path` — e,
    // dopo l'approvazione, le due colonne gemelle di `anagrafica_personale` — continuano
    // a nominarle. La Segreteria apre una scheda con l'allegato mancante, e nessuna riga
    // di log dice QUALE pratica ha perso il proprio documento: l'unico log che porta
    // l'`entita_id` è proprio quello che non veniva emesso.
    //
    // La versione precedente di questo test verificava il 201 e il livello del log ma
    // non asseriva niente su `h.collegamenti`: il buco restava verde.
    h.erroreRegistro = { code: '57014', message: 'statement timeout' }
    const fronte = caricato()
    const retro = caricato()

    const res = await inviaValida({
      documento_fronte_path: fronte,
      documento_retro_path: retro,
    })

    expect(res.status).toBe(201)
    // ⚠️ QUI SI SEPARA IL GUASTO TRANSITORIO DALLA TABELLA CHE NON C'È, e la
    // separazione ora decide il VERDETTO, non più solo il livello del log: la tabella
    // assente respinge (test qui sopra), il registro che non risponde lascia passare.
    // Ciò che distingue i due fatti in `app_log` è l'`esito`, ed è per questo che si
    // asserisce il nome esatto: entrambi sono `error` — chi bussa non può PROVOCARE
    // questo guasto, ma qualcosa è rotto e va detto.
    const guasto = h.eventi.find((e) => e.campi.esito === 'registro-caricamenti-non-letto')
    expect(guasto?.livello).toBe('error')
    expect(
      h.eventi.map((e) => e.campi.esito),
      'un guasto transitorio è stato scambiato per la tabella assente: il verdetto cambia',
    ).not.toContain('registro-caricamenti-assente')

    // E IL COLLEGAMENTO SI TENTA: la lettura è fallita, la scrittura no. E si tenta per
    // TUTTE le facce, non per la prima: un guasto di lettura non è una ragione per
    // lasciare indietro il retro, che è proprio l'oggetto che la spazzata raccoglie.
    expect(h.collegamenti, 'il collegamento non è stato nemmeno tentato').toHaveLength(1)
    expect([...h.collegamenti[0].percorsi].sort()).toEqual([fronte, retro].sort())
    expect(h.collegamenti[0].praticaId).toBe('pratica-nuova')
    expect(h.collegamenti[0].riuscito).toBe(true)
    // Lo STATO, non l'intenzione: le righe di registro adesso nominano la pratica,
    // quindi la spazzata non vedrà più quegli oggetti.
    expect(h.registroCaricamenti.get(fronte)).toBe('pratica-nuova')
    expect(h.registroCaricamenti.get(retro)).toBe('pratica-nuova')
  })
})

describe('POST /api/iscrizione/personale · lo STESSO modulo mandato due volte', () => {
  /**
   * IL DIFETTO, RIPRODOTTO COME SUCCEDE: due invii IDENTICI, uno dopo l'altro.
   *
   * Il reclamo del percorso respingeva con 400 ogni percorso già collegato —
   * compreso quello della stessa persona che rimanda il proprio modulo — e lo faceva
   * PRIMA dell'INSERT, quindi il ramo `23505` non veniva mai raggiunto. Chi preme
   * «Invia» due volte (connessione lenta, retry del browser, un campo corretto dopo il
   * primo invio) vedeva un ERRORE mentre la sua pratica ERA stata ricevuta.
   *
   * Il wizard client non è una difesa: non esiste ancora, e comunque una rotta pubblica
   * non può appoggiarsi al fatto che un client non reinvii mai.
   */
  const secondoInvioIdentico = async (percorso: string) => {
    // Il finto conta gli INSERT per decidere quale errore restituire: senza azzerare,
    // il secondo invio cadrebbe nel ramo del RITENTO invece che in quello del `23505`.
    h.inserts = []
    // È ciò che fa il database: l'indice `unique (lower(email))` sugli stati vivi vede
    // la riga del primo invio.
    h.erroreInsert = { code: '23505', message: 'duplicate key value violates unique constraint' }
    h.vivaPerEmail = {
      id: 'pratica-viva',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }
    h.colpi.clear()
    return inviaValida({ documento_fronte_path: percorso })
  }

  it('il secondo invio risponde 201 come il primo, NON un 400 sul documento', async () => {
    const percorso = caricato()
    const primo = await inviaValida({ documento_fronte_path: percorso })
    expect(primo.status).toBe(201)
    const formaPrimo = Object.keys(await primo.json()).sort()
    // Il primo invio si è preso l'oggetto: da qui in poi quel percorso NON è più
    // reclamabile, ed è esattamente la condizione che faceva scattare il 400.
    expect(h.registroCaricamenti.get(percorso)).toBe('pratica-nuova')

    const secondo = await secondoInvioIdentico(percorso)

    expect(
      secondo.status,
      'il secondo invio è stato respinto: la pratica c’è, e le si dice che il suo documento non vale',
    ).toBe(201)
    const corpo = await secondo.json()
    expect(corpo.id).toBe('pratica-viva')
    // La stessa FORMA del primo invio: una risposta di forma diversa sarebbe essa
    // stessa l'oracolo che il 201 serve a togliere.
    expect(Object.keys(corpo).sort()).toEqual(formaPrimo)
    // E il rifiuto non deve nemmeno essere stato pensato: se comparisse, vorrebbe dire
    // che si è risposto 201 per un'altra strada e il campo è ancora contestato.
    expect(h.eventi.map((e) => e.campi.esito)).not.toContain('documento-path-non-reclamabile')
  })

  it('il secondo invio ARRIVA all’INSERT e la Segreteria viene avvisata («duplicataQui»)', async () => {
    // Il 400 usciva PRIMA dell'INSERT: zero tentativi di scrittura e nessun avviso —
    // cioè si perdeva di nuovo il percorso utente che il ramo `23505` era stato scritto
    // per riparare, ed è la stessa forma di difetto che `iscrizione/insegnanti:POST` ha
    // già pagato («il ramo del doppio invio usciva con `return` PRIMA di arrivarci»).
    const percorso = caricato()
    await inviaValida({ documento_fronte_path: percorso })
    h.notifiche = []
    h.destinatariChiesti = []

    await secondoInvioIdentico(percorso)

    expect(h.inserts, 'il secondo invio non ha nemmeno provato a scrivere').toHaveLength(1)
    expect(h.notifiche, 'la Segreteria non è stata avvisata del secondo invio').toHaveLength(1)
    expect(h.notifiche[0].scuolaId).toBe(SEDE_A)
    expect(h.destinatariChiesti[0].scuolaId).toBe(SEDE_A)
    attendiCorpo(h.notifiche[0].corpo, 'duplicataQui')
    expect(h.eventi.find((e) => e.campi.esito === 'duplicata')?.campi.stessa_sede).toBe(true)
  })

  it('il riuso del PROPRIO documento lascia una riga, e non porta il percorso nei log', async () => {
    const percorso = caricato()
    await inviaValida({ documento_fronte_path: percorso })
    h.eventi = []

    await secondoInvioIdentico(percorso)

    // `warn` e non `info`, per la stessa ragione dell'esito `duplicata`: è l'unica riga
    // che dice che un percorso GIÀ DI QUALCUNO è stato ripresentato, e un `warn` si
    // persiste per livello — quindi resta interrogabile in SQL.
    const riuso = h.eventi.find((e) => e.campi.esito === 'documento-path-della-propria-pratica')
    expect(riuso?.livello).toBe('warn')
    expect(riuso?.campi.scuola_id).toBe(SEDE_A)
    // Il percorso è la chiave che apre il documento d'identità di una persona: nel log
    // non ci va, né qui né altrove.
    expect(JSON.stringify(h.eventi)).not.toContain('documenti/')
    expect(JSON.stringify(h.eventi)).not.toContain('ines.prova@example.invalid')
  })

  it('l’oggetto NON viene ricollegato: è già suo, e un secondo `update` sarebbe un falso guasto', async () => {
    const percorso = caricato()
    await inviaValida({ documento_fronte_path: percorso })
    h.collegamenti = []

    await secondoInvioIdentico(percorso)

    // Un `update … where pratica_id is null` su una riga già collegata tocca ZERO
    // righe, e `collegaCaricamento` — che verifica lo STATO e non l'intenzione —
    // griderebbe `caricamento-non-collegato` a livello `error` su un percorso che sta
    // benissimo. Il proprietario è già registrato: non c'è niente da scrivere.
    expect(h.collegamenti).toHaveLength(0)
    expect(h.registroCaricamenti.get(percorso)).toBe('pratica-nuova')
  })

  it('l’eccezione vale SOLO per la propria email: il percorso di un altro resta respinto', async () => {
    // È il confine dell'eccezione, ed è dove si decide se ha riaperto la catena
    // d'attacco che il registro chiude: un percorso trapelato da un URL firmato
    // inoltrato, riusato per una pratica di un'altra persona (magari in un'altra sede).
    const percorso = caricato()
    await inviaValida({ documento_fronte_path: percorso })

    h.inserts = []
    h.colpi.clear()
    const res = await invia({
      scuola_id: SEDE_B,
      data: pratica({ documento_fronte_path: percorso, email: 'altra.persona@example.invalid' }),
    })

    expect(res.status).toBe(400)
    expect(Object.keys((await res.json()).campi)).toEqual(CAMPI_DOCUMENTO)
    expect(h.inserts, 'una pratica ha nominato il documento d’identità di un’altra persona').toHaveLength(0)
    expect(h.registroCaricamenti.get(percorso)).toBe('pratica-nuova')
    expect(h.eventi.map((e) => e.campi.esito)).toContain('documento-path-non-reclamabile')
  })

  it('l’eccezione NON diventa un oracolo: email vera + percorsi INVENTATI resta 400', async () => {
    // ⚠️ QUESTO TEST CHIUDE UN BUCO CHE ERA APERTO, e il buco è quello che il commento
    // di `documentiDiUnaPraticaViva` descrive come «la versione più comoda»: rispondere
    // di sì appena si trova una pratica viva per quella email, senza guardare se i
    // percorsi presentati sono davvero suoi.
    //
    // Misurato il 12/08/2026 sostituendo `percorsi.some(p => sue.has(p))` con un
    // `return true`: la suite restava VERDE, 76 su 76. Nessuno dei test dell'eccezione
    // se ne accorgeva, perché tutti provano email SENZA pratica viva — e senza pratica
    // viva la lettura non trova niente e il rifiuto arriva per un'altra ragione.
    //
    // Il danno di quella versione: chiunque digiti l'indirizzo di una maestra e alleghi
    // due percorsi INVENTATI (la forma sta scritta in un repository pubblico) legge dalla
    // risposta se quella persona lavora qui — 201 se ha una pratica viva, 400 se no. È
    // ESATTAMENTE l'oracolo di enumerazione che il ramo `23505` esiste per togliere,
    // rimesso in piedi dalla porta accanto.
    const legittimo = caricato()
    expect((await inviaValida({ documento_fronte_path: legittimo })).status).toBe(201)

    // Ora la pratica viva di `ines.prova` esiste. Chi tenta ha la sua email — che si
    // indovina — ma NON un suo percorso: allega due stringhe nella forma giusta.
    h.inserts = []
    h.colpi.clear()
    h.erroreInsert = { code: '23505', message: 'duplicate key value violates unique constraint' }
    h.vivaPerEmail = {
      id: 'pratica-viva',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }

    const res = await inviaValida({
      documento_fronte_path: percorsoValido(),
      documento_retro_path: percorsoValido(),
    })

    expect(
      res.status,
      'con due percorsi inventati e l’email giusta la rotta ha risposto 201: dalla risposta si legge chi lavora qui',
    ).toBe(400)
    expect(Object.keys((await res.json()).campi).sort()).toEqual([...CAMPI_DOCUMENTO].sort())
    expect(h.inserts, 'l’INSERT è stato tentato con due percorsi inventati').toHaveLength(0)
    expect(h.eventi.map((e) => e.campi.esito)).toContain('documento-path-non-reclamabile')
    expect(h.eventi.map((e) => e.campi.esito)).not.toContain(
      'documento-path-della-propria-pratica',
    )
  })

  it('la pratica che possiede il file è già EVASA: si respinge, il `23505` non scatterebbe', async () => {
    // L'eccezione è sicura perché la riga che possiede l'oggetto è la STESSA con cui
    // l'INSERT sta per collidere: il `23505` è la garanzia che nessuna riga nuova
    // nasca. Su una pratica già approvata o rifiutata quella garanzia non c'è —
    // l'indice unico vale solo sugli stati vivi — quindi ammettere creerebbe una
    // seconda riga che nomina lo stesso oggetto, e la conservazione della prima
    // cancellerebbe il file che la seconda sta ancora usando.
    const percorso = caricato()
    h.registroCaricamenti.set(percorso, 'pratica-evasa')
    h.praticaPerEmail.set('ines.prova@example.invalid', {
      id: 'pratica-evasa',
      stato: 'approvata',
      documenti: { documento_fronte_path: percorso },
    })

    const res = await inviaValida({ documento_fronte_path: percorso })

    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('se la verifica del proprietario NON risponde, il rifiuto resta in piedi', async () => {
    // Direzione OPPOSTA a quella del reclamo, ed è voluta: là si cerca un motivo per
    // RIFIUTARE e un guasto lascia passare (è un presidio in più, e chi bussa non può
    // provocarlo); qui si cerca un motivo per AMMETTERE un percorso che è già di
    // qualcuno, e ciò che non si dimostra non si presume.
    const percorso = caricato()
    h.registroCaricamenti.set(percorso, 'pratica-di-qualcun-altro')
    h.erroreProprietario = { code: '57014', message: 'statement timeout' }

    const res = await inviaValida({ documento_fronte_path: percorso })

    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
    const nota = h.eventi.find((e) => e.campi.esito === 'documento-path-proprietario-non-letto')
    expect(nota?.livello).toBe('warn')
    expect(nota?.campi.error_code).toBe('57014')
    expect(JSON.stringify(h.eventi)).not.toContain('documenti/')
  })

  it('DUE righe vive per la stessa email (database senza indice) non riaprono il 400', async () => {
    // ⚠️ IL CASO CHE `.maybeSingle()` NON SAPEVA REGGERE, ed è il motivo per cui non
    // c'è più. La giustificazione scritta accanto a quella chiamata era: «l'indice
    // `unique (lower(email)) where stato in (…)` garantisce al massimo una riga, quindi
    // `.maybeSingle()` è esatto e non un'approssimazione». Vera in produzione, falsa
    // proprio dove questa rotta si sforza di funzionare: su un database indietro con le
    // migrazioni — quello per cui esiste tutto il ramo di degrado dell'INSERT —
    // l'indice può non esserci. Due righe vive ⇒ PostgREST risponde `PGRST116`, il
    // ramo d'errore torna `false`, e chi rimanda IL PROPRIO modulo si vede un 400 sul
    // campo del documento: cioè il difetto che questa funzione esiste per chiudere,
    // riaperto in un caso più stretto.
    //
    // Qui la seconda riga viva è quella che POSSIEDE il percorso: se la lettura si
    // fermasse alla prima, l'eccezione non scatterebbe e la risposta tornerebbe 400.
    const percorso = caricato()
    h.registroCaricamenti.set(percorso, 'pratica-vecchia')
    h.praticaPerEmail.set('ines.prova@example.invalid', {
      id: 'pratica-senza-documento',
      stato: 'pending',
      documenti: {},
    })
    h.viveAggiuntive = [
      {
        email: 'ines.prova@example.invalid',
        id: 'pratica-vecchia',
        stato: 'pending',
        documenti: { documento_fronte_path: percorso },
      },
    ]
    h.erroreInsert = { code: '23505', message: 'duplicate key value violates unique constraint' }
    h.vivaPerEmail = {
      id: 'pratica-vecchia',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }

    const res = await inviaValida({ documento_fronte_path: percorso })

    expect(
      res.status,
      'con due righe vive la ricerca del proprietario si è fermata alla prima: 400 sul ' +
        'documento di chi non ha sbagliato niente',
    ).toBe(201)
    // E l'INSERT è stato TENTATO: se il 400 fosse tornato, la rotta sarebbe uscita
    // prima di scrivere, ed è la differenza fra «respinta» e «duplicata».
    expect(h.inserts).toHaveLength(1)
    expect(h.eventi.map((e) => e.campi.esito)).toContain('documento-path-della-propria-pratica')
    // La lettura DICHIARA un tetto: senza, su un database senza indice sarebbe una
    // scansione di tutte le pratiche vive con quella email.
    expect(h.limitiChiesti, 'la lettura del proprietario non dichiara nessun tetto').not.toHaveLength(0)
    expect(h.limitiChiesti[0]).toBeGreaterThanOrEqual(2)
  })

  it('se il `23505` NON scatta, le due righe che nominano lo stesso file si GRIDANO', async () => {
    // La finestra è stretta ma reale: fra la verifica e l'INSERT la pratica viva può
    // essere approvata o rifiutata, uscendo dagli stati vivi e liberando l'indice. La
    // riga nuova nasce, e due pratiche nominano lo stesso oggetto — l'invariante «un
    // oggetto, un proprietario». Non si può disfare (cancellare la riga perderebbe
    // l'anagrafica di una persona vera), ma senza questa riga di log la si scoprirebbe
    // fra 90 giorni da un documento sparito.
    const percorso = caricato()
    await inviaValida({ documento_fronte_path: percorso })

    h.inserts = []
    h.colpi.clear()
    h.eventi = []
    // Nessun `erroreInsert`: la scrittura RIESCE, cioè l'indice non ha morso.
    const res = await inviaValida({ documento_fronte_path: percorso })

    expect(res.status).toBe(201)
    const guasto = h.eventi.find(
      (e) => e.campi.esito === 'documento-condiviso-con-altra-pratica',
    )
    expect(guasto?.livello, 'la finestra è passata in silenzio').toBe('error')
    expect(guasto?.campi.entita_id).toBe('pratica-nuova')
    expect(guasto?.campi.scuola_id).toBe(SEDE_A)
    expect(JSON.stringify(h.eventi)).not.toContain('documenti/')
  })
})

describe('POST /api/iscrizione/personale · la sede', () => {
  it('la sede E2E non è una sede: 400 `SEDE_DA_SPECIFICARE`', async () => {
    // In produzione quella sede ESISTE ed è collegata a 4 utenti, uno dei quali
    // `admin`. Accettarla su una scrittura ANONIMA vorrebbe dire aprire un plesso
    // finto che il selettore pubblico non mostra e non mostrerà mai.
    h.sedi = [...h.sedi, { id: SEDE_E2E, nome: NOME_SEDE_E2E }]
    const res = await invia({ scuola_id: SEDE_E2E, data: pratica() })

    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
    expect(h.inserts).toHaveLength(0)
    expect(h.eventi.some((e) => e.campi.esito === 'sede-non-valida')).toBe(true)
  })

  it('una sede DISATTIVATA è rifiutata come una sconosciuta', async () => {
    // L'elenco che si mostra e il predicato che accetta devono essere lo stesso:
    // accettare una sede che nessuno ha potuto scegliere è la divergenza che
    // `sediReali` esiste per chiudere.
    h.attive.set(SEDE_B, false)
    const res = await invia({ scuola_id: SEDE_B, data: pratica() })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('una sede sconosciuta non ricade su un default silenzioso', async () => {
    // Le sedi sono tre: una route che «indovina» archivia l'anagrafica nel plesso
    // sbagliato, e la Segreteria che l'aspetta crede che non sia arrivata.
    const res = await invia({
      scuola_id: '00000000-0000-4000-8000-0000000000ff',
      data: pratica(),
    })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
    expect(h.notifiche, 'è stato avvisato qualcuno per una pratica mai scritta').toHaveLength(0)
  })
})

describe('POST /api/iscrizione/personale · il database che non collabora', () => {
  it('tabella assente (`PGRST205`) ⇒ 503 con un codice, MAI un 201 bugiardo', async () => {
    // È lo stato del DB della CI, che non è migrato. Una persona a cui si dice
    // «ricevuta» non riprova, e la sua anagrafica non esiste da nessuna parte.
    h.erroreInsert = { code: 'PGRST205', message: 'relation does not exist' }
    const res = await inviaValida()

    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('PRATICHE_NON_DISPONIBILI')
    expect(h.eventi.some((e) => e.campi.esito === 'tabella-assente')).toBe(true)
  })

  it('colonna assente (`PGRST204`) ⇒ si ritenta senza, e il log la NOMINA', async () => {
    // Una pratica persa perché manca una colonna sarebbe peggio del degrado. Ma non
    // in silenzio: «si è degradato» senza dire *cosa* è caduto è un log che non serve
    // a nessuno il giorno in cui a cadere è la prova del consenso.
    h.erroreInsert = {
      code: 'PGRST204',
      message: "Could not find the 'consents_log' column of 'pratiche_personale'",
    }
    const res = await inviaValida()

    expect(res.status).toBe(201)
    expect(h.inserts).toHaveLength(2)
    expect(h.inserts[1]).not.toHaveProperty('consents_log')
    // Il resto della riga non si perde: si toglie UNA colonna, non si riscrive tutto.
    expect(h.inserts[1].scuola_id).toBe(SEDE_A)
    const degrado = h.eventi.find((e) => String(e.campi.esito).startsWith('colonna-assente'))
    expect(degrado?.campi.esito).toBe('colonna-assente-consents_log')
    expect(degrado?.campi.error_code).toBe('PGRST204')
  })

  /*
   * ╔══════════════════════════════════════════════════════════════════════════╗
   * ║  LA FACCIA DEL DOCUMENTO NON SI DEGRADA: 503, non un 201 senza scansione  ║
   * ╚══════════════════════════════════════════════════════════════════════════╝
   *
   * ⚠️ QUI, FINO AL 13/08/2026, C'ERA IL TEST CHE CODIFICAVA LA PERDITA. Si chiamava
   * «DUE colonne assenti ⇒ si ritenta finché la riga entra», asseriva `201` e
   * `not.toHaveProperty('documento_fronte_path')`, e non chiedeva né un log `error` né
   * la rinuncia al collegamento: cioè scriveva come esito ATTESO che una fotografia di
   * carta d'identità finisse nel bucket senza nessuna riga che la nominasse.
   *
   * La catena, per intero, perché è la ragione per cui questi test esistono in questa
   * forma:
   *   1. il ciclo toglie `documento_fronte_path` e `documento_retro_path` e la riga entra;
   *   2. al punto 10-bis `collegaCaricamenti` gira lo stesso: le righe di
   *      `caricamenti_personale` prendono `pratica_id`;
   *   3. `spazzaCaricamentiSospesi` filtra `pratica_id is null and anagrafica_utente_id
   *      is null` → non le vede più;
   *   4. `gdpr/retention-personale` scopre i file leggendo `documento_fronte_path` /
   *      `documento_retro_path` DALLE RIGHE → in quella riga non ci sono.
   * Risultato: un documento d'identità nel bucket, non spazzabile e non conservabile.
   *
   * La migrazione `20260812194501` prescriveva il contrario, e con queste parole: «la
   * scansione si perde in silenzio, che è il modo peggiore di perderla… migrazione
   * prima del codice = 503 per il tempo del deploy. È l'errore giusto: rumoroso e
   * reversibile.»
   */
  const mancante = (colonna: string) => ({
    code: 'PGRST204' as const,
    message: `Could not find the '${colonna}' column of 'pratiche_personale' in the schema cache`,
  })

  it.each(['documento_fronte_path', 'documento_retro_path'])(
    '`%s` assente ⇒ 503 rumoroso, e NESSUNA riga senza scansione',
    async (colonna) => {
      h.erroreInsert = mancante(colonna)
      // La coda dice che se la rotta ritentasse, il ritento RIUSCIREBBE: senza questa
      // riga un 503 potrebbe arrivare per il motivo sbagliato (un secondo errore), e
      // il test sarebbe verde su un prodotto rotto in un altro modo.
      h.erroriSuccessivi = [null]

      const res = await inviaValida()

      expect(
        res.status,
        'la rotta ha degradato una colonna che tiene un documento: 201 su una pratica senza scansione',
      ).toBe(503)
      expect((await res.json()).codice).toBe('PRATICHE_NON_DISPONIBILI')
      // UN SOLO INSERT: non si ritenta senza la colonna. Se qui ce ne fossero due, la
      // riga ridotta sarebbe nata e il 503 sarebbe una bugia.
      expect(h.inserts, 'la riga è stata riscritta senza il documento').toHaveLength(1)
      // E NESSUN COLLEGAMENTO: gli oggetti restano `pratica_id is null`, quindi
      // `spazzaCaricamentiSospesi` li toglie dal bucket entro 24 ore. È il verso
      // giusto in cui sbagliare — meglio una scansione da rifare che una scansione
      // che nessuno può più né trovare né cancellare.
      expect(
        h.collegamenti,
        'gli oggetti sono stati collegati a una pratica che non è nata: da lì non li vede più nessuno',
      ).toHaveLength(0)
      // Il log è di livello `error` (configurazione mancante = incidente, AGENTS §4),
      // NOMINA la colonna e NOMINA la migrazione da applicare: senza quest'ultima, chi
      // legge il log alle tre di notte sa che qualcosa manca e non sa cosa applicare.
      const grido = h.eventi.find(
        (e) => e.campi.esito === `colonna-documento-assente-${colonna}`,
      )
      expect(grido, 'nessuna riga di log dice perché il modulo ha smesso di ricevere').toBeTruthy()
      expect(grido?.livello).toBe('error')
      expect(String(grido?.campi.msg)).toContain('20260812194501')
      // Nessun degrado silenzioso è stato registrato: `warn` + `colonna-assente-…` qui
      // significherebbe che il ciclo ci ha provato lo stesso.
      expect(
        h.eventi.filter((e) => String(e.campi.esito).startsWith('colonna-assente-')),
      ).toHaveLength(0)
      // ⚠️ NEL LOG MAI IL PERCORSO: è la chiave che apre il documento di una persona.
      expect(JSON.stringify(h.eventi)).not.toContain('documenti/')
    },
  )

  it('la faccia assente vince sul tetto del ciclo: 503 anche DOPO un degrado legittimo', async () => {
    // Il caso che un tetto messo davanti alla guardia avrebbe sbagliato: `consents_log`
    // manca (degrado legittimo, un giro) e SUBITO DOPO manca il fronte. Con la guardia
    // valutata dopo il tetto, il secondo errore uscirebbe dal ciclo per esaurimento e
    // finirebbe nel ramo generico — **500 `PRATICA_NON_INVIATA`**, cioè un codice che
    // invita a ritentare fra qualche minuto una cosa che non può riuscire, e nessuna
    // riga che nomini la migrazione mancante.
    h.erroreInsert = mancante('consents_log')
    h.erroriSuccessivi = [mancante('documento_fronte_path'), null]

    const res = await inviaValida()

    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('PRATICHE_NON_DISPONIBILI')
    // Due INSERT: quello di partenza e il ritento senza `consents_log`. Il terzo — la
    // riga senza il documento — non esiste.
    expect(h.inserts).toHaveLength(2)
    expect(h.collegamenti).toHaveLength(0)
    expect(
      h.eventi.map((e) => e.campi.esito).filter((e) => String(e).includes('colonna')),
    ).toEqual(['colonna-assente-consents_log', 'colonna-documento-assente-documento_fronte_path'])
  })

  it('un messaggio di degrado irriconoscibile non fa cadere una colonna a caso', async () => {
    // Il nome si accetta SOLO se è davvero una colonna che stiamo scrivendo: un
    // messaggio che cambia forma non deve poter togliere `fiscal_code` dalla riga.
    h.erroreInsert = { code: '42703', message: 'qualcosa di inatteso' }
    await inviaValida()
    expect(h.inserts).toHaveLength(2)
    expect(h.inserts[1]).not.toHaveProperty('consents_log')
    expect(h.inserts[1]).toHaveProperty('fiscal_code')
  })

  it('un database che dice sempre «colonna assente» non fa martellare il ciclo', async () => {
    // ⚠️ È IL PREZZO DEL CICLO, e va misurato: un `while` che ritenta finché il
    // database si lamenta, davanti a un `PGRST204` che non sappiamo leggere,
    // rifarebbe l'INSERT una volta per colonna della riga — su una porta ANONIMA, cioè
    // un amplificatore che chiunque può innescare con un modulo compilato bene.
    //
    // Il ciclo si ferma per due ragioni, e questo test le tiene ferme entrambe: il
    // tetto (le colonne che un database indietro può legittimamente non avere) e la
    // guardia sulla colonna già caduta — senza la seconda, un messaggio
    // irriconoscibile due volte di fila rifarebbe lo STESSO INSERT identico.
    const opaco = { code: 'PGRST204' as const, message: 'un messaggio che non sappiamo leggere' }
    h.erroreInsert = opaco
    h.erroriSuccessivi = [opaco, opaco, opaco, opaco, opaco]

    const res = await inviaValida()

    // Un solo giro: cade `consents_log` (il ripiego), poi il ripiego non è più nella
    // riga e si smette. Il 500 è l'esito onesto — il database è rotto in un modo che
    // questa rotta non sa aggirare — e chi ha compilato legge «non siamo riusciti».
    expect(h.inserts, 'il ciclo ha continuato a ritentare su un errore che non sa leggere').toHaveLength(2)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('PRATICA_NON_INVIATA')
    // La coda degli errori non è stata consumata: è la prova che i giri sono finiti
    // prima, e non che il finto ha smesso di rispondere.
    expect(h.erroriSuccessivi).toHaveLength(4)
  })
})

describe('POST /api/iscrizione/personale · il doppio invio', () => {
  it('email già viva ⇒ 201 con la STESSA FORMA del primo invio, mai un 409', async () => {
    // Un 409 direbbe a chiunque digiti l'indirizzo di una maestra se quella persona
    // LAVORA qui. E la forma della risposta è metà dell'oracolo: `{id}` sul primo
    // invio e `{id, avvisi}` sul doppione si distinguono guardandoli.
    const primo = await inviaValida()
    const formaPrimo = Object.keys(await primo.json()).sort()

    // Il finto decide QUALE errore restituire contando gli INSERT già visti (il primo
    // prende `erroreInsert`, i successivi la coda del ritento): senza azzerare, il
    // secondo invio di questo test cadrebbe nel ramo del ritento invece che in quello
    // del `23505`, e la prova sulla forma della risposta girerebbe a vuoto.
    h.inserts = []
    h.erroreInsert = { code: '23505', message: 'duplicate key value violates unique constraint' }
    h.vivaPerEmail = {
      id: 'pratica-viva',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }
    const secondo = await inviaValida()

    expect(secondo.status).toBe(201)
    const corpo = await secondo.json()
    expect(corpo.id, 'il doppione non restituisce l’id della pratica viva').toBe('pratica-viva')
    expect(
      Object.keys(corpo).sort(),
      'la risposta del doppione ha una forma diversa: è l’oracolo che il 201 serve a togliere',
    ).toEqual(formaPrimo)

    const duplicata = h.eventi.find((e) => e.campi.esito === 'duplicata')
    expect(duplicata?.livello, 'un `info` su questo ramo non arriverebbe in SQL').toBe('warn')
    expect(duplicata?.campi.entita_id).toBe('pratica-viva')
    expect(duplicata?.campi.stessa_sede).toBe(true)
    expect(duplicata?.campi.error_code).toBe('23505')
    // MAI l'email nel log: è la chiave, e nel `message` di Postgres c'è per costruzione.
    expect(JSON.stringify(h.eventi)).not.toContain('ines.prova@example.invalid')
  })

  it('la rilettura usa lo STESSO valore che si è provato a scrivere, e gli stati vivi', async () => {
    // L'indice confronta `lower(email)`, `.eq` confronta i byte: se la route
    // rinormalizzasse per conto suo, la riga viva non si troverebbe e il log
    // perderebbe il puntatore — proprio quando la seconda Segreteria chiede «è
    // arrivata?».
    h.erroreInsert = { code: '23505', message: 'duplicate key' }
    h.vivaPerEmail = {
      id: 'pratica-viva',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }
    await inviaValida({ email: 'Ines.PROVA@Example.Invalid' })

    expect(h.filtri.find((f) => f.colonna === 'email')?.valore).toBe('ines.prova@example.invalid')
    expect(h.filtriIn.find((f) => f.colonna === 'stato')?.valori).toEqual([
      'pending',
      'in_approvazione',
    ])
  })

  it('la pratica viva è in un’ALTRA sede: la Segreteria di questa viene avvisata lo stesso', async () => {
    // L'indice unico è GLOBALE, l'avviso è PER SEDE. Senza questo ramo la seconda
    // Segreteria non vedrebbe niente e crederebbe che la pratica non sia arrivata —
    // ed è la crepa da cui, sul modulo gemello, usciva un percorso utente intero.
    h.erroreInsert = { code: '23505', message: 'duplicate key' }
    h.vivaPerEmail = {
      id: 'pratica-altrove',
      email: 'ines.prova@example.invalid',
      stato: 'in_approvazione',
      scuola_id: SEDE_B,
    }
    const res = await inviaValida()

    expect(res.status).toBe(201)
    expect(h.notifiche, 'nessuno è stato avvisato del secondo invio').toHaveLength(1)
    expect(h.notifiche[0].scuolaId).toBe(SEDE_A)
    attendiCorpo(h.notifiche[0].corpo, 'duplicataAltrove')
    // L'uuid NON esce: sarebbe quello di una pratica che questa Segreteria non ha
    // titolo per aprire, e un link che porta a un diniego è peggio di nessun link.
    expect(h.notifiche[0].entitaId).toBeNull()
    expect(h.eventi.find((e) => e.campi.esito === 'duplicata')?.campi.stessa_sede).toBe(false)
  })

  it('il `23505` con la riga viva NON leggibile lascia comunque una traccia distinta', async () => {
    // PostgREST non lancia: senza controllare `{ error }` questo ramo sarebbe muto.
    h.erroreInsert = { code: '23505', message: 'duplicate key' }
    h.erroreRilettura = { code: '42703', message: 'column does not exist' }
    const res = await inviaValida()

    expect(res.status).toBe(201)
    expect(h.eventi.some((e) => e.campi.esito === 'duplicata-riga-viva-non-letta')).toBe(true)
  })

  it('il `23505` senza riga viva (già evasa) ha un esito SUO, non un `entita_id` nullo qualunque', async () => {
    // Fra l'INSERT e la rilettura la pratica può essere stata approvata o rifiutata:
    // un esito diverso è ciò che distingue «duplicata e tracciata» da «duplicata e
    // persa di vista» quando qualcuno interroga `app_log` un mese dopo.
    h.erroreInsert = { code: '23505', message: 'duplicate key' }
    h.vivaPerEmail = {
      id: 'pratica-evasa',
      email: 'ines.prova@example.invalid',
      stato: 'approvata',
      scuola_id: SEDE_A,
    }
    const res = await inviaValida()

    expect(res.status).toBe(201)
    expect((await res.json()).id).toBeNull()
    expect(h.eventi.some((e) => e.campi.esito === 'duplicata-riga-viva-non-trovata')).toBe(true)
  })
})
