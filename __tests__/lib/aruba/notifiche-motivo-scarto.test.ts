import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * IL MOTIVO DI UNO SCARTO SDI VIVE NELLE NOTIFICHE, E IL PARAMETRO ERA SBAGLIATO.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL FATTO MISURATO, 2026-09-11. Corretta la lettura dello stato (PR #138), la coda del
 * cron ha ricominciato a girare e la prima fattura respinta è emersa alle 10:31Z con
 * `sdi_stato = 4`. A registro, in `sdi_scarto_motivo`, è finito:
 *
 *     Aruba: «Scartata» — nessun motivo dal provider
 *
 * cioè il ramo difensivo di `motivoScartoAruba`: `getByFilename` aveva risposto con
 * `statusDescription`, `errorCode` ed `errorDescription` TUTTI VUOTI. Non è una risposta
 * arrivata tardi — su quel canale il motivo NON C'È. Il perché di uno scarto lo scrive lo
 * SdI in una NOTIFICA, che ha un endpoint suo.
 *
 * E quell'endpoint, da giugno, era chiamato col parametro SBAGLIATO: `filename` dove la
 * doc ufficiale (v1 §11.2) chiede `invoiceFilename`. Era una «divergenza dormiente»
 * dichiarata in `docs/fatturazione/configurazione-aruba.md` (§1.5 e §5 riga 2) e innocua
 * solo finché la funzione non aveva chiamanti. Adesso ne ha uno.
 *
 * ⚠️ PERCHÉ IL TEST CHE C'ERA NON POTEVA ACCORGERSENE. `client-corpo-provider.test.ts:133`
 * chiama `arubaGetNotifications` con un `fetch` finto che IGNORA l'URL: risponde uguale al
 * nome giusto e a quello sbagliato. È verde con la correzione e senza — cioè non è un test
 * di quella riga. Qui l'URL si ISPEZIONA, e si ispeziona con `URLSearchParams`: un
 * `toContain('invoiceFilename')` sarebbe stato verde anche su `?filename=…` per il verso
 * opposto (`invoiceFilename` CONTIENE `filename`), quindi il confronto dev'essere sulle
 * CHIAVI, non sul testo.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

import { arubaGetNotifications } from '@/lib/aruba/client'
import {
  motivoDalleNotificheSdi,
  descriviForma,
  scartoSenzaDescrizione,
  motivoScartoAruba,
  mapStatoAruba,
  FORMA_MAX,
} from '@/lib/aruba/stato'
import { sanificaMessaggio } from '@/lib/logging/serialize'

const FILE = 'IT03394870616_00abc.xml.p7m'

/* ════════════════════════════════════════════════════════════════════════════
 * 1. IL PARAMETRO. `invoiceFilename`, non `filename`.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('arubaGetNotifications — il nome del parametro è quello documentato', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{"notifications":[]}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  /** L'URL che è DAVVERO partito, non quello che credevamo di comporre. */
  const chiamato = (): URL => new URL(String(fetchMock.mock.calls[0][0]))

  it('la query porta `invoiceFilename`, e NON una chiave `filename`', async () => {
    await arubaGetNotifications('production', 'AT', FILE)

    const q = chiamato().searchParams
    // ⚠️ `get` confronta la chiave ESATTA: con la sola `invoiceFilename` presente,
    // `get('filename')` è `null`. È questa asimmetria a distinguere i due nomi — un
    // `toContain` sulla stringa dell'URL non la vedrebbe, perché l'uno contiene l'altro.
    expect(q.get('invoiceFilename')).toBe(FILE)
    expect(q.get('filename'), 'il parametro vecchio non deve sopravvivere accanto al nuovo').toBeNull()
    // E non deve nemmeno esserci «per sicurezza» insieme al nuovo: mandarne due significa
    // lasciare che sia Aruba a scegliere, cioè non aver deciso.
    expect([...q.keys()]).toEqual(['invoiceFilename'])
  })

  it('colpisce l\'endpoint delle notifiche in uscita, sull\'host dell\'ambiente chiesto', async () => {
    await arubaGetNotifications('production', 'AT', FILE)
    const url = chiamato()
    expect(url.origin).toBe('https://ws.fatturazioneelettronica.aruba.it')
    expect(url.pathname).toBe('/services/notification/out/getByInvoiceFilename')
  })

  /**
   * ⚠️ UN ARRAY È UNA FORMA PLAUSIBILE PER UN ELENCO, e fino al 2026-09-11 questa funzione
   * lo buttava via: passava da `leggiCorpoJson`, che su un corpo non-oggetto restituisce
   * `{}` — e, peggio, scrive nel `msg` del log i primi 200 caratteri del CORPO GREZZO.
   * Su una notifica SDI quel corpo porta denominazione, codice fiscale e partita IVA
   * dell'intestatario: di una famiglia.
   */
  it('una risposta ARRAY arriva intera al chiamante, non ridotta a {}', async () => {
    fetchMock.mockResolvedValue(new Response('[{"notificationType":"NS"}]', { status: 200 }))
    const risposta = await arubaGetNotifications('demo', 'AT', FILE)
    expect(Array.isArray(risposta)).toBe(true)
    expect((risposta as unknown[]).length).toBe(1)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 2. L'ESTRATTORE. Difensivo, perché la forma NON è stata misurata.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('motivoDalleNotificheSdi — più forme plausibili, nessuna certezza inventata', () => {
  it('involucro `notifications` con una NS e un elenco di errori', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [
        {
          notificationType: 'NS',
          errors: [
            { errorCode: '00400', errorDescription: 'Natura non ammessa per aliquota diversa da zero' },
            { errorCode: '00417', errorDescription: 'Identificativo fiscale non valorizzato' },
          ],
        },
      ],
    })
    expect(r.motivo).toContain('Natura non ammessa')
    expect(r.motivo).toContain('00400')
    expect(r.motivo).toContain('00417')
    expect(r.tipo).toBe('NS')
    expect(r.notifiche).toBe(1)
  })

  it('un ARRAY nudo di notifiche, con i nomi italiani dei campi', () => {
    const r = motivoDalleNotificheSdi([
      { tipo: 'NS', errori: [{ codice: '00423', descrizione: 'Prezzo totale non coerente' }] },
    ])
    expect(r.motivo).toContain('Prezzo totale non coerente')
    expect(r.motivo).toContain('00423')
  })

  it('un involucro con `value.content`, e l\'elenco degli errori annidato in `listaErrori.errore`', () => {
    const r = motivoDalleNotificheSdi({
      value: { content: [{ notificationType: 'NS', listaErrori: { errore: [{ codice: '00301', descrizione: 'CF non valido' }] } }] },
    })
    expect(r.motivo).toContain('CF non valido')
    expect(r.motivo).toContain('00301')
  })

  /**
   * LA COMBINAZIONE DELLE DUE FORME, che presa a pezzi era coperta e insieme no.
   *
   * `value.content` con dentro un ARRAY funzionava (esce dal ramo `daElenco`), e la notifica
   * sola senza involucro funzionava. Ma involucri annidati CON una notifica sola in fondo —
   * cioè senza array — no: ogni livello della ricorsione riavvolgeva la notifica raggiunta
   * dentro il proprio involucro, e in fondo arrivava `{value: …}` invece della notifica.
   * Nessun tipo, nessun errore, motivo `null`: la fattura restava col motivo povero.
   *
   * È il buco esatto fra i due test qui sopra, ed è il motivo per cui un difetto può vivere
   * in mezzo a una copertura che sembra completa.
   */
  it('involucri annidati con una notifica SOLA in fondo (senza array): la notifica non si perde per strada', () => {
    const r = motivoDalleNotificheSdi({
      value: {
        content: {
          notificationType: 'NS',
          listaErrori: { errore: [{ codice: '00427', descrizione: 'Formato trasmissione non coerente' }] },
        },
      },
    })
    expect(r.motivo, 'la ricorsione ha riavvolto la notifica nel suo involucro').toContain(
      'Formato trasmissione non coerente',
    )
    expect(r.motivo).toContain('00427')
  })

  it('una notifica SOLA, senza involucro e senza elenco: i campi piatti bastano', () => {
    const r = motivoDalleNotificheSdi({
      notificationType: 'NS',
      errorCode: '00311',
      errorDescription: 'Codice destinatario non valido',
    })
    expect(r.motivo).toContain('Codice destinatario non valido')
    expect(r.motivo).toContain('00311')
  })

  /**
   * ⚠️ LA NOTIFICA GIUSTA FRA DUE. Con una `RC` (ricevuta di consegna) e una `NS` nello
   * stesso elenco, prendere «la prima con una descrizione» darebbe la RC — che descrive una
   * consegna RIUSCITA, cioè l'esatto contrario del motivo cercato, scritto nella colonna che
   * la Segreteria apre per capire cosa correggere.
   */
  it('fra RC e NS vince la NS, anche se la RC viene prima', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [
        { notificationType: 'RC', descrizione: 'Ricevuta di consegna' },
        { notificationType: 'NS', errori: [{ codice: '00200', descrizione: 'File non conforme al formato' }] },
      ],
    })
    expect(r.motivo).toContain('File non conforme al formato')
    expect(r.motivo).not.toContain('Ricevuta di consegna')
    expect(r.tipo).toBe('NS')
  })

  /** `0000` è il codice del percorso felice: come motivo di uno scarto non dice niente. */
  it('l\'involucro riuscito (`errorCode 0000`, `errorDescription "OK"`) NON diventa un motivo', () => {
    const r = motivoDalleNotificheSdi({ errorCode: '0000', errorDescription: 'OK' })
    expect(r.motivo).toBeNull()
  })

  /**
   * ⚠️ IL CASO CHE VALE L'INTERO ESTRATTORE: quando non si riconosce niente si risponde
   * `null` e si lascia in piedi il motivo povero. Indovinare un campo a caso in un corpo che
   * contiene l'anagrafica fiscale di una famiglia significherebbe scrivere il nome di
   * qualcuno in un registro fiscale al posto di un codice di errore.
   */
  it('forma ignota → null, e il numero di notifiche riconosciute è ZERO', () => {
    const r = motivoDalleNotificheSdi({ risultato: { esitoOperazione: 3, quandoSuccesse: '2026-09-11' } })
    expect(r.motivo).toBeNull()
    expect(r.notifiche).toBe(0)
  })

  it('risposta vuota, nulla o di tipo inatteso → null, senza lanciare', () => {
    for (const v of [null, undefined, '', 0, [], {}, 'una stringa']) {
      expect(motivoDalleNotificheSdi(v).motivo, `forma ${JSON.stringify(v)}`).toBeNull()
    }
  })

  /* ──────────────────────────────────────────────────────────────────────────
   * SI FILTRA, NON SI ORDINA. Mettere le `NS` per prime non impedisce a una `RC` di
   * fornire il motivo: impedisce solo che lo fornisca PER PRIMA. Se nell'elenco non c'è
   * nessuna `NS`, o se nessuna notifica dichiara un tipo riconoscibile, la prima con una
   * descrizione qualunque vince lo stesso — ed è tipicamente la ricevuta di CONSEGNA,
   * cioè il racconto di un successo scritto sotto il titolo «Perché lo SDI l'ha respinta».
   * ────────────────────────────────────────────────────────────────────────── */

  it('una RC DA SOLA non fornisce il motivo: nessuna NS ⇒ nessun motivo', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [{ notificationType: 'RC', descrizione: 'Ricevuta di consegna' }],
    })
    expect(r.motivo, 'una consegna riuscita non è il motivo di uno scarto').toBeNull()
    expect(r.tipo).toBeNull()
    // L'elenco è stato riconosciuto: è la riga `forma-ignota` a dover emergere, non un
    // «non ho trovato niente» che confonde «forma non capita» con «nessun motivo».
    expect(r.notifiche).toBe(1)
  })

  it('la RC non subentra nemmeno quando la NS accanto è muta', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [
        { notificationType: 'RC', descrizione: 'Ricevuta di consegna' },
        { notificationType: 'NS' },
      ],
    })
    expect(r.motivo).toBeNull()
  })

  /**
   * ⚠️ QUESTO È IL TEST CHE ISOLA IL FILTRO, e va letto sapendo perché è scritto così.
   *
   * Una `MC` («mancata consegna») porta DAVVERO un codice e una descrizione: spiega perché
   * il recapito è fallito. Quei campi passano ogni altro guardiano — il codice è vero, non
   * è uno zero — e l'unica cosa che impedisce a «Destinatario non raggiungibile» di finire
   * sotto il titolo «Perché lo SDI l'ha respinta» è il TIPO dichiarato.
   *
   * La prima versione di questo test dava alle altre notifiche una `descrizione` e basta:
   * era verde anche rimettendo l'ordinamento al posto del filtro, perché a fermarle bastava
   * il ramo dei campi piatti. Due protezioni sovrapposte sono una buona cosa in produzione
   * e una pessima cosa in un test: ne misurava una sola, e non diceva quale.
   */
  it('nessuna altra notifica SDI fornisce il motivo, NEMMENO con un codice d\'errore vero', () => {
    const messaggi: Record<string, string> = {
      RC: 'Consegna completata',
      MC: 'Destinatario non raggiungibile',
      NE: 'Esito positivo del destinatario',
      DT: 'Decorrenza termini',
      AT: 'Attestazione di trasmissione',
    }
    for (const [tipo, descrizione] of Object.entries(messaggi)) {
      const piatta = motivoDalleNotificheSdi({
        notifications: [{ notificationType: tipo, errorCode: '00001', errorDescription: descrizione }],
      })
      expect(piatta.motivo, `la notifica ${tipo} (campi piatti) ha fornito un motivo`).toBeNull()

      const conElenco = motivoDalleNotificheSdi({
        notifications: [{ notificationType: tipo, errori: [{ codice: '00001', descrizione }] }],
      })
      expect(conElenco.motivo, `la notifica ${tipo} (elenco errori) ha fornito un motivo`).toBeNull()
    }
  })

  it('e non subentrano nemmeno accanto a una NS muta, che è il caso che le fa vincere', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [
        { notificationType: 'MC', errori: [{ codice: '00001', descrizione: 'Destinatario non raggiungibile' }] },
        { notificationType: 'NS' },
      ],
    })
    expect(r.motivo).toBeNull()
  })

  /**
   * ⚠️ IL TIPO ASSENTE RESTA DIFENSIVO, ed è l'altra metà della regola. `null` non
   * significa «non è uno scarto»: significa «la chiave che porta il tipo non è fra quelle
   * che conosciamo», cioè non abbiamo capito la forma. Lì rinunciare al motivo
   * costerebbe l'unica informazione disponibile su una fattura che È scartata — la
   * chiamata parte solo per quelle.
   */
  it('senza NESSUN tipo dichiarato il difensivo resta: il motivo si prende', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [{ errori: [{ codice: '00423', descrizione: 'Prezzo totale non coerente' }] }],
    })
    expect(r.motivo).toContain('Prezzo totale non coerente')
    expect(r.tipo).toBeNull()
  })

  it('fra una NS e una senza tipo, il motivo viene dalla NS', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [
        { errori: [{ descrizione: 'Descrizione di una notifica senza tipo' }] },
        { notificationType: 'NS', errori: [{ codice: '00200', descrizione: 'File non conforme al formato' }] },
      ],
    })
    expect(r.motivo).toContain('File non conforme al formato')
    expect(r.motivo).not.toContain('senza tipo')
    expect(r.tipo).toBe('NS')
  })

  /* ──────────────────────────────────────────────────────────────────────────
   * IL GUARDIANO DELLO ZERO HA UNA FAMIGLIA, NON UNA FORMA SOLA. I codici arrivano da
   * `String(v)` su JSON: `0` numerico, `'0'`, `'00'`, `'000'` sono tutti «nessun errore»,
   * e nessuno di loro è la stringa `'0000'`.
   * ────────────────────────────────────────────────────────────────────────── */

  it('TUTTA la famiglia degli zeri è «nessun errore», non solo `0000`', () => {
    for (const codice of ['0000', '0', 0, '00', '000', '0000.0', '+0']) {
      const r = motivoDalleNotificheSdi({ errorCode: codice, errorDescription: 'OK' })
      expect(r.motivo, `il codice ${JSON.stringify(codice)} è passato per un motivo`).toBeNull()
    }
  })

  /**
   * ⚠️ E UN CODICE NON NUMERICO NON È UNO ZERO. `Number('ABC')` è `NaN`, e `NaN` è FALSY:
   * un guardiano scritto `!Number(codice)` butterebbe via ogni codice alfanumerico —
   * cioè trasformerebbe la correzione in una perdita di informazione più grande del bug.
   */
  it('un codice non numerico resta un codice: `ABC` non è uno zero', () => {
    const r = motivoDalleNotificheSdi({
      notificationType: 'NS',
      errorCode: 'ABC',
      errorDescription: 'Deleghe non valide',
    })
    expect(r.motivo).toContain('ABC')
    expect(r.motivo).toContain('Deleghe non valide')
  })

  it('lo zero non entra nemmeno dentro un elenco di errori', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [{ notificationType: 'NS', errors: [{ errorCode: '0', errorDescription: 'Natura non ammessa' }] }],
    })
    expect(r.motivo).toBe('Natura non ammessa')
    expect(r.motivo).not.toContain('(0)')
  })

  /**
   * ⚠️ SENZA UN CODICE D'ERRORE VERO, IL RAMO DEI CAMPI PIATTI NON SCRIVE NIENTE.
   * `errorDescription: 'OK'` su un involucro riuscito non diventa un motivo di scarto solo
   * perché il codice accanto era vuoto invece che `0000`: è la stessa frase, e in
   * `sdi_scarto_motivo` di una fattura respinta è peggio del motivo povero, perché SEMBRA
   * un'informazione. Serve o un codice d'errore vero, o una notifica che si dichiari `NS`.
   */
  it('l\'involucro riuscito senza codice («OK» e basta) NON diventa un motivo', () => {
    for (const codice of [undefined, null, '', '   ']) {
      const r = motivoDalleNotificheSdi({ errorCode: codice, errorDescription: 'OK' })
      expect(r.motivo, `codice ${JSON.stringify(codice)}`).toBeNull()
    }
  })

  it('ma una NS con la sola descrizione, senza codice, il motivo lo dà', () => {
    const r = motivoDalleNotificheSdi({
      notificationType: 'NS',
      errorDescription: 'Codice destinatario non valido',
    })
    expect(r.motivo).toBe('Codice destinatario non valido')
  })

  /**
   * ⚠️ LA RICERCA DELL'ELENCO NON SI FERMA ALLA PRIMA CHIAVE NOTA. `data` e `value` sono
   * involucri comunissimi e possono portare un oggetto che non c'entra niente; l'elenco
   * vero può stare sotto una chiave successiva. Uscire alla prima significa perdere la
   * risposta per l'ordine in cui il provider ha scritto le chiavi.
   */
  it('un contenitore noto ma inutile non nasconde l\'elenco che viene dopo', () => {
    const r = motivoDalleNotificheSdi({
      data: { esito: 'ok' },
      notifications: [{ notificationType: 'NS', errori: [{ codice: '00400', descrizione: 'Natura non ammessa' }] }],
    })
    expect(r.motivo).toContain('Natura non ammessa')
    expect(r.notifiche).toBe(1)
  })

  it('il motivo non cresce oltre il tetto: `sdi_scarto_motivo` è un registro, non un dump', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [{ notificationType: 'NS', errors: [{ descrizione: 'x'.repeat(5_000) }] }],
    })
    expect(r.motivo!.length).toBeLessThanOrEqual(500)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 3. LA FORMA NEL LOG: i NOMI dei campi, MAI i valori.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('descriviForma — è ciò che si può loggare di un corpo che contiene dati di una famiglia', () => {
  /**
   * ⚠️ IL VINCOLO DI PRIVACY, in un test. Il corpo di una notifica SDI porta denominazione,
   * codice fiscale e partita IVA dell'intestatario della fattura. `msg` finisce in `app_log`
   * in chiaro per trenta giorni, e `sanificaMessaggio` maschera email e codici fiscali — non
   * una ragione sociale. Perciò della risposta si logga la STRUTTURA: nomi dei campi, tipi,
   * lunghezze, conteggi. Mai un valore.
   */
  it('nessun VALORE compare nella descrizione, nemmeno annidato', () => {
    const forma = descriviForma({
      notifications: [
        {
          notificationType: 'NS',
          receiver: { denominazione: 'Famiglia Esempio', codiceFiscale: 'AAAAAA00A00A000A', partitaIVA: '01234567890' },
          importo: 150.5,
        },
      ],
    })
    for (const valore of ['Famiglia Esempio', 'AAAAAA00A00A000A', '01234567890', '150.5', 'NS']) {
      expect(forma, `il valore «${valore}» è finito nella descrizione di forma`).not.toContain(valore)
    }
    // E i NOMI ci sono tutti: sono l'unica cosa che permetterà di riconoscere questa forma.
    expect(forma).toContain('notifications')
    expect(forma).toContain('notificationType')
    expect(forma).toContain('denominazione')
    expect(forma).toContain('codiceFiscale')
  })

  it('dice la forma, non il contenuto: tipi, lunghezze e conteggi', () => {
    expect(descriviForma({ a: 'xyz' })).toContain('stringa(3)')
    expect(descriviForma({ a: [1, 2, 3] })).toContain('array(3)')
    expect(descriviForma({ a: true })).toContain('booleano')
    expect(descriviForma({ a: 7 })).toContain('numero')
    expect(descriviForma(null)).toBe('null')
  })

  /* ──────────────────────────────────────────────────────────────────────────
   * LA PROFONDITÀ È UNA MISURA DI UTILITÀ. Questa riga è l'unica via per scoprire la
   * forma vera alla prima notifica reale: se si ferma prima dei nomi che servono —
   * `codice`, `descrizione`, `errorCode` — dice «c'è qualcosa lì dentro» e tanti saluti,
   * cioè costa un giro di log e non risolve niente.
   *
   * Le forme qui sotto sono ESATTAMENTE quelle che `elencoNotifiche` attraversa: fino a
   * tre involucri annidati (`INVOLUCRI_MAX`), poi l'array, poi la notifica, poi
   * l'eventuale `listaErrori.errore` della conversione XML→JSON dell'`NS`.
   * ────────────────────────────────────────────────────────────────────────── */

  const ERRORE = { codice: '00400', descrizione: 'Natura non ammessa' }
  const NOTIFICA_XML = { notificationType: 'NS', listaErrori: { errore: [ERRORE] } }

  it('arriva ai nomi degli errori dentro `notifications` (un involucro)', () => {
    const f = descriviForma({ notifications: [NOTIFICA_XML] })
    expect(f).toContain('errore')
    expect(f).toContain('codice')
    expect(f).toContain('descrizione')
  })

  it('ci arriva anche sotto `value.content` — l\'involucro che ne consuma DUE', () => {
    const f = descriviForma({ value: { content: [NOTIFICA_XML] } })
    expect(f).toContain('errore')
    expect(f).toContain('codice')
    expect(f).toContain('descrizione')
  })

  it('e sotto TRE involucri, che è il massimo che `elencoNotifiche` attraversa', () => {
    const f = descriviForma({ value: { content: { items: [NOTIFICA_XML] } } })
    expect(f).toContain('codice')
    expect(f).toContain('descrizione')
  })

  it('con l\'elenco piatto `errors` i nomi inglesi ci sono tutti', () => {
    const f = descriviForma({ notifications: [{ notificationType: 'NS', errors: [{ errorCode: '1', errorDescription: 'x' }] }] })
    expect(f).toContain('errorCode')
    expect(f).toContain('errorDescription')
  })

  /**
   * ⚠️ IL BUDGET DEVE STARE DENTRO IL CANALE CHE LO TRASPORTA, altrimenti è una bugia:
   * la forma finisce nel `msg` di una riga di log, e `sanificaMessaggio` tronca a
   * `MESSAGGIO_MAX`. Un `FORMA_MAX` più largo di quel tetto promette caratteri che
   * verranno buttati via in silenzio, e li butta via dalla CODA — cioè proprio dai nomi
   * più annidati, quelli per cui la profondità qui sopra è stata alzata.
   *
   * Il tetto del canale NON si copia da `serialize.ts`: si MISURA, chiedendolo alla
   * funzione che tronca davvero. Un numero copiato diverge il giorno in cui l'originale
   * cambia, e diverge in silenzio.
   */
  const capDelCanale = sanificaMessaggio('x'.repeat(10_000)).length

  it('il budget della forma sta dentro il tetto del messaggio, con margine per il prefisso', () => {
    expect(FORMA_MAX).toBeLessThan(capDelCanale)
    // Il prefisso della riga `notifiche-forma-ignota` sta davanti alla forma: il margine
    // non è un vezzo, è lo spazio in cui quel prefisso vive.
    expect(capDelCanale - FORMA_MAX).toBeGreaterThanOrEqual(40)
  })

  it('una forma al massimo del budget, col prefisso davanti, NON viene troncata dal logger', () => {
    const grande: Record<string, string> = {}
    for (let i = 0; i < 400; i++) grande[`campo_numero_${i}`] = 'x'.repeat(50)
    const forma = descriviForma(grande)
    expect(forma.length).toBeLessThanOrEqual(FORMA_MAX)

    // La prova vera: il messaggio composto come lo compone la route esce INTATTO.
    const msg = `${'p'.repeat(40)}: ${forma}`
    expect(sanificaMessaggio(msg), 'il logger ha tagliato la forma').toBe(msg)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 4. QUANDO IL MOTIVO È «POVERO» — la condizione che accende la chiamata in più.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('scartoSenzaDescrizione — la stessa condizione del ramo difensivo, non una sua copia', () => {
  /**
   * ⚠️ NON SI DEDUCE DAL TESTO CHE ABBIAMO APPENA SCRITTO NOI. Riconoscere il ramo difensivo
   * cercando «nessun motivo dal provider» dentro la frase italiana di `motivoScartoAruba`
   * funzionerebbe fino al giorno in cui qualcuno riscrive quella frase — e quel giorno
   * smetterebbe di funzionare in silenzio. Le due funzioni leggono gli STESSI pezzi.
   */
  it('il caso misurato in produzione: tutte e tre le descrizioni vuote → povero', () => {
    expect(scartoSenzaDescrizione({ descrizioneAruba: '', errorCode: '', errorDescription: '' })).toBe(true)
    expect(scartoSenzaDescrizione({})).toBe(true)
    expect(scartoSenzaDescrizione(undefined)).toBe(true)
  })

  it('un codice senza descrizione resta povero: «Scarto Aruba 0093» non dice cosa correggere', () => {
    expect(scartoSenzaDescrizione({ errorCode: '0093' })).toBe(true)
  })

  it('una descrizione qualunque, da uno dei due campi, basta a NON essere povero', () => {
    expect(scartoSenzaDescrizione({ descrizioneAruba: 'Codice destinatario non valido' })).toBe(false)
    expect(scartoSenzaDescrizione({ errorDescription: 'deleghe non valide' })).toBe(false)
  })

  it('spazi soli non sono una descrizione', () => {
    expect(scartoSenzaDescrizione({ descrizioneAruba: '   ', errorDescription: '\n' })).toBe(true)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 5. LO STESSO GUARDIANO SULL'ALTRO INGRESSO — `getByFilename`.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('motivoScartoAruba — il codice «nessun errore» è lo stesso di là e di qua', () => {
  const SCARTO = mapStatoAruba(4)

  it('uno zero di qualunque forma non finisce fra parentesi davanti al motivo', () => {
    for (const codice of ['0000', '0', '00', '000']) {
      const m = motivoScartoAruba(SCARTO, 'Scartata', {
        errorCode: codice,
        errorDescription: 'Deleghe non valide',
      })
      expect(m, `codice ${codice}`).toBe('Deleghe non valide')
    }
  })

  it('un codice vero resta davanti al motivo, dove la Segreteria lo cerca', () => {
    const m = motivoScartoAruba(SCARTO, 'Scartata', {
      errorCode: '0093',
      errorDescription: 'Deleghe non valide',
    })
    expect(m).toBe('(0093) Deleghe non valide')
  })

  it('e senza descrizione il codice vero regge da solo, lo zero no', () => {
    expect(motivoScartoAruba(SCARTO, 'Scartata', { errorCode: '0093' })).toContain('0093')
    expect(motivoScartoAruba(SCARTO, 'Scartata', { errorCode: '0' })).toBe(
      'Aruba: «Scartata» — nessun motivo dal provider',
    )
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 6. IL CORPO DELLE NOTIFICHE NON ENTRA NEI LOG. È un lock, non un commento.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ LA GARANZIA PIÙ DELICATA DI QUESTO LAVORO, e fino a oggi era affidata a un docblock.
 *
 * `leggiCorpoQualunque` esiste per una ragione sola: il corpo di una notifica SDI porta
 * denominazione, codice fiscale e partita IVA dell'intestatario della fattura — di una
 * FAMIGLIA — e `leggiCorpoConDiagnosi` (la lettura ordinaria, giusta su ogni altro
 * endpoint) di un corpo non interpretabile scrive i primi 200 caratteri GREZZI dentro il
 * `msg`. `msg` finisce in `app_log` in chiaro per trenta giorni, e `sanificaMessaggio`
 * maschera email e codici fiscali, NON una ragione sociale.
 *
 * Rimettere il corpo nel messaggio lasciava VERDE l'intera suite Aruba. Da qui in poi no.
 *
 * COME SI OSSERVA: stesso schema di `client-corpo-provider.test.ts` — si ricarica il grafo
 * con la guardia SILENZIOSO spenta e il sink `app_log` finto, così si vedono le righe VERE
 * (console + riga persistita) senza toccare nessun database. Mockare `logEvento` avrebbe
 * guardato l'intenzione; qui si guarda ciò che esce.
 */
describe('leggiCorpoQualunque — la sentinella non esce, la lunghezza sì', () => {
  const SENTINELLA = '<html>SENTINELLA-NON-DEVE-USCIRE</html>'

  let appLog: ReturnType<typeof vi.fn>
  let spiaLog: ReturnType<typeof vi.spyOn>
  let spiaErr: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('KV_LOG_LEVEL', '')
    spiaLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    spiaErr = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.doUnmock('@/lib/logging/app-log')
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function carica() {
    appLog = vi.fn(async () => {})
    vi.resetModules()
    vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
    return await import('@/lib/aruba/client')
  }

  /** TUTTO ciò che è uscito: le righe su console e quelle persistite, in un testo solo. */
  function tuttoIlLog(): string {
    const console_ = [...spiaLog.mock.calls, ...spiaErr.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : String((a as Error)?.message ?? a)))
    const persistite = appLog.mock.calls.map((c) => JSON.stringify(c[0]))
    return [...console_, ...persistite].join('\n')
  }

  it('un corpo 200 NON-JSON non compare da nessuna parte, e la riga c\'è lo stesso', async () => {
    const { arubaGetNotifications } = await carica()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SENTINELLA, { status: 200 })))

    const risposta = await arubaGetNotifications('demo', 'AT', FILE)
    expect(risposta, 'un corpo non interpretabile non diventa una risposta').toBeUndefined()

    await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThan(0))
    const uscito = tuttoIlLog()

    // 🔴 IL PUNTO. Nemmeno un pezzo della sentinella, in nessuna riga, in nessun campo.
    expect(uscito, 'il corpo grezzo della notifica è finito nei log').not.toContain('SENTINELLA')
    expect(uscito).not.toContain('NON-DEVE-USCIRE')
    expect(uscito).not.toContain('<html>')

    // E la riga esiste davvero, con la LUNGHEZZA al posto del contenuto: senza questa
    // metà il test sarebbe verde anche se il log fosse sparito del tutto, e «nessun log»
    // non distingue «tutto ok» da «non è mai partito niente».
    const riga = appLog.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((r) => JSON.stringify(r).includes('corpo-non-json'))
    expect(riga, 'la riga che dichiara il corpo illeggibile non è stata emessa').toBeTruthy()
    expect(JSON.stringify(riga)).toContain(String(SENTINELLA.length))
  })

  it('lo stesso vale per un corpo VUOTO: la riga c\'è, il corpo non esiste', async () => {
    const { arubaGetNotifications } = await carica()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))

    expect(await arubaGetNotifications('demo', 'AT', FILE)).toBeUndefined()
    await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThan(0))
    expect(tuttoIlLog()).toContain('corpo-vuoto')
  })
})
