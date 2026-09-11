import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * IL MOTIVO NON È IN UN CAMPO JSON: È DENTRO L'ALLEGATO, IN 6304 CARATTERI.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * LA FORMA VERA, MISURATA IN PRODUZIONE IL 2026-09-11 ALLE 16:30Z. Il codice della PR
 * #139 ha interrogato Aruba per davvero: `aruba:notifiche` ha risposto **HTTP 200** in
 * 626 ms — cioè `invoiceFilename` era il parametro giusto, confermato sul campo. Ma
 * `motivoDalleNotificheSdi` non ha riconosciuto NIENTE, e la riga diagnostica
 * `notifiche-forma-ignota` ha portato in `app_log` la forma esatta (nomi e lunghezze,
 * mai i valori):
 *
 *     {count: numero,
 *      notifications: array(1) di {
 *        filename: stringa(35), number: null, notificationDate: null,
 *        docType: stringa(2),      ← il TIPO della notifica, «NS» per lo scarto
 *        date: stringa(29), invoiceId: stringa(24),
 *        file: stringa(6304),      ← ⬅️ IL MOTIVO È QUI DENTRO
 *        result: null,
 *        errorCode: null,          ← NULL: cercarlo qui non porterà MAI a niente
 *        errorDescription: null},
 *      errorCode: stringa(4),      ← livello involucro, «0000» = nessun errore
 *      errorDescription: null}
 *
 * DUE COSE, ed è per quelle che esiste questo file:
 *
 *  (A) il motivo non è in nessun campo JSON — sta dentro `file`, che è l'XML della
 *      notifica SdI. Una `NS` porta, per lo standard, `<ListaErrori><Errore>` con dentro
 *      `<Codice>` e `<Descrizione>` (e spesso `<Suggerimento>`), con prefissi di namespace
 *      variabili. ⚠️ E NON si dà per scontato che sia base64: 6304 caratteri possono anche
 *      essere XML in chiaro. Si riconosce quale dei due è, e si gestiscono entrambi;
 *
 *  (B) `docType` non era fra `CHIAVI_TIPO_NOTIFICA`, quindi il tipo di quella notifica
 *      risultava `null` e passava solo per il ramo difensivo «tipo assente». Con `doctype`
 *      riconosciuto la `NS` è una `NS`, e — l'altra metà, che conta di più — una `RC`
 *      DICHIARATA smette di poter fornire il motivo di uno scarto.
 *
 * 🔴 E LA REGOLA CHE VALE PIÙ DI TUTTE. Quell'XML è una notifica fiscale: porta
 * denominazione, codice fiscale e partita IVA dell'intestatario, cioè di una FAMIGLIA.
 * `sanificaMessaggio` maschera email e CF, NON una ragione sociale. Vale qui la stessa
 * regola già scritta in `stato.ts`: i NOMI sì, i valori mai — nemmeno il motivo, che pure
 * è ciò che stiamo cercando e che va in `sdi_scarto_motivo`, che è una COLONNA.
 *
 * I dati di questo file sono inventati e riconoscibili come tali: il repository è pubblico.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

import {
  motivoDalleNotificheSdi,
  descriviForma,
  FORMA_MAX,
  ALLEGATO_MAX,
} from '@/lib/aruba/stato'
import { sanificaMessaggio } from '@/lib/logging/serialize'

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64')

/** Una `NS` come la scrive lo SdI: root con prefisso, figli senza, entità nella descrizione. */
const NS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ns3:NotificaScarto xmlns:ns3="http://www.fatturapa.gov.it/sdi/messaggi/v1.0" versione="1.0">
  <IdentificativoSdI>0000000000</IdentificativoSdI>
  <NomeFile>IT00000000000_00001.xml.p7m</NomeFile>
  <DataOraRicezione>2026-09-10T12:00:00.000+02:00</DataOraRicezione>
  <ListaErrori>
    <Errore>
      <Codice>00400</Codice>
      <Descrizione>2.2.1.14 &lt;Natura&gt; non presente a fronte di &lt;AliquotaIVA&gt; pari a zero</Descrizione>
      <Suggerimento>Valorizzare la natura dell'operazione</Suggerimento>
    </Errore>
  </ListaErrori>
  <MessageId>00000000</MessageId>
</ns3:NotificaScarto>`

/**
 * L'INVOLUCRO MISURATO, con il campo `file` al posto suo. I valori sono inventati e hanno la
 * LUNGHEZZA di quelli veri, che è l'unica cosa che la misura aveva il diritto di dire.
 */
const involucroMisurato = (file: string): Record<string, unknown> => ({
  count: 1,
  notifications: [
    {
      filename: 'IT00000000000_00001_NS_001.xml',
      number: null,
      notificationDate: null,
      docType: 'NS',
      date: '2026-09-10T12:00:00.000+0200',
      invoiceId: '000000000000000000000000',
      file,
      result: null,
      errorCode: null,
      errorDescription: null,
    },
  ],
  errorCode: '0000',
  errorDescription: null,
})

/* ════════════════════════════════════════════════════════════════════════════
 * 1. L'ALLEGATO, NELLE DUE FORME CHE PUÒ AVERE.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('motivoDalleNotificheSdi — il motivo vive dentro l\'XML allegato alla notifica', () => {
  /** ⚠️ IL TEST CHE VALE IL LAVORO: è la forma misurata, non una forma plausibile. */
  it('la forma VERA del 2026-09-11, con l\'XML della NS in base64', () => {
    const r = motivoDalleNotificheSdi(involucroMisurato(b64(NS_XML)))

    expect(r.motivo, 'l\'allegato non è stato nemmeno guardato').not.toBeNull()
    expect(r.motivo).toContain('00400')
    expect(r.motivo).toContain('non presente a fronte di')
    // Il tipo arriva da `docType`, che prima non era fra le chiavi riconosciute.
    expect(r.tipo).toBe('NS')
    expect(r.notifiche).toBe(1)
  })

  /**
   * ⚠️ 6304 CARATTERI NON SONO PER FORZA BASE64. Dare per scontata la codifica significa
   * non leggere l'unico allegato che arriva in chiaro, e non accorgersene mai: il ramo
   * difensivo risponde `null` con la stessa faccia in entrambi i casi.
   */
  it('lo stesso XML IN CHIARO, senza base64, dà lo stesso motivo', () => {
    const r = motivoDalleNotificheSdi(involucroMisurato(NS_XML))
    expect(r.motivo).toContain('00400')
    expect(r.motivo).toContain('non presente a fronte di')
  })

  it('e in chiaro lo riconosce anche con il BOM e gli spazi davanti', () => {
    const r = motivoDalleNotificheSdi(involucroMisurato(`﻿\n  ${NS_XML}`))
    expect(r.motivo).toContain('00400')
  })

  /**
   * I PREFISSI DI NAMESPACE SONO VARIABILI, e non solo sulla radice: lo stesso documento
   * può arrivare con `ns3:Errore`, `p:Codice`, o senza niente. Il confronto va fatto sul
   * nome LOCALE — quello dopo i due punti — altrimenti si riconosce un provider solo.
   */
  it('i tag con prefisso di namespace si leggono come quelli senza', () => {
    const xml = `<ns3:NotificaScarto><ns3:ListaErrori><ns3:Errore>` +
      `<p:Codice>00423</p:Codice><p:Descrizione>Prezzo totale non coerente</p:Descrizione>` +
      `</ns3:Errore></ns3:ListaErrori></ns3:NotificaScarto>`
    const r = motivoDalleNotificheSdi(involucroMisurato(b64(xml)))
    expect(r.motivo).toBe('(00423) Prezzo totale non coerente')
  })

  /** Una `NS` può elencare più errori: servono tutti, perché vanno corretti tutti. */
  it('più errori nella lista: li raccoglie tutti, nello stesso formato degli altri rami', () => {
    const errori = [
      ['00400', 'Natura non ammessa'],
      ['00417', 'Identificativo fiscale non valorizzato'],
      ['00423', 'Prezzo totale non coerente'],
    ]
      .map(([c, d]) => `<Errore><Codice>${c}</Codice><Descrizione>${d}</Descrizione></Errore>`)
      .join('')
    const r = motivoDalleNotificheSdi(involucroMisurato(b64(`<NotificaScarto><ListaErrori>${errori}</ListaErrori></NotificaScarto>`)))

    expect(r.motivo).toBe(
      '(00400) Natura non ammessa · (00417) Identificativo fiscale non valorizzato · (00423) Prezzo totale non coerente',
    )
  })

  /** Il tetto `ERRORI_MAX` è già nel file e vale anche qui: dieci, non venti. */
  it('oltre il tetto degli errori si smette di raccogliere', () => {
    const errori = Array.from(
      { length: 25 },
      (_, i) => `<Errore><Codice>0040${i}</Codice><Descrizione>Errore numero ${i}</Descrizione></Errore>`,
    ).join('')
    const r = motivoDalleNotificheSdi(involucroMisurato(b64(`<ListaErrori>${errori}</ListaErrori>`)))

    expect(r.motivo!.split(' · ')).toHaveLength(10)
    expect(r.motivo).toContain('Errore numero 0')
    expect(r.motivo, 'l\'undicesimo errore è entrato lo stesso').not.toContain('Errore numero 10')
  })

  /**
   * ⚠️ LE ENTITÀ, E L'ORDINE IN CUI SI DECODIFICANO. `&amp;` va sciolta per ULTIMA: farlo
   * per prima trasformerebbe `&amp;lt;` in `&lt;` e poi in `<`, cioè inventerebbe della
   * marcatura dentro una descrizione. E senza scioglierle affatto, la colonna che la
   * Segreteria apre direbbe «Fattura &amp;amp; nota di credito».
   */
  it('le entità XML si decodificano, e `&amp;` non si scioglie due volte', () => {
    const xml =
      `<ListaErrori><Errore><Codice>00301</Codice>` +
      `<Descrizione>Fattura &amp; nota: il tag &amp;lt;Natura&amp;gt; e &lt;AliquotaIVA&gt; non coerenti &quot;2.2.1&quot; l&apos;uno</Descrizione>` +
      `</Errore></ListaErrori>`
    const r = motivoDalleNotificheSdi(involucroMisurato(b64(xml)))

    expect(r.motivo).toContain('Fattura & nota')
    expect(r.motivo, '`&amp;lt;` è stata sciolta due volte').toContain('&lt;Natura&gt;')
    expect(r.motivo).toContain('<AliquotaIVA>')
    expect(r.motivo).toContain('"2.2.1"')
    expect(r.motivo).toContain("l'uno")
  })

  /** Il CDATA è un involucro, non contenuto: la descrizione dentro va letta lo stesso. */
  it('una descrizione dentro CDATA si legge', () => {
    const xml = `<Errore><Codice>00311</Codice><Descrizione><![CDATA[Codice destinatario non valido]]></Descrizione></Errore>`
    const r = motivoDalleNotificheSdi(involucroMisurato(b64(xml)))
    expect(r.motivo).toBe('(00311) Codice destinatario non valido')
  })

  /** Senza `<Descrizione>`, il `<Suggerimento>` è l'ultima cosa che dice cosa correggere. */
  it('senza descrizione parla il suggerimento, che è il ripiego dichiarato', () => {
    const xml = `<Errore><Codice>00404</Codice><Suggerimento>Verificare la data del documento</Suggerimento></Errore>`
    const r = motivoDalleNotificheSdi(involucroMisurato(b64(xml)))
    expect(r.motivo).toBe('(00404) Verificare la data del documento')
  })

  /**
   * L'ALLEGATO PUÒ ESSERE FIRMATO (`.p7m`): i byte dell'XML restano dentro l'involucro
   * CAdES, circondati da binario. Decodificati come UTF-8 il binario diventa spazzatura, ma
   * i tag ASCII sopravvivono — e sono l'unica cosa che serve. Perciò i tag si cercano DOVUNQUE
   * nel testo, non solo a partire dal primo carattere.
   */
  it('un allegato firmato (XML annegato nel binario) dà comunque il motivo', () => {
    // ⚠️ BYTE VERI, non una stringa JS che SEMBRA binaria.
    //
    // Qui c'era una stringa con \u00FF, \u00FE e qualche carattere di controllo: scritta
    // così, `Buffer.from(s,'utf-8')` la codifica in UTF-8 valido e la decodifica la
    // restituisce IDENTICA. Cioè il test provava soltanto che i tag si cercano anche a
    // metà stringa — già vero — e NON il caso che conta: un `.p7m` è un involucro CAdES
    // binario, i cui byte non sono UTF-8 valido e alla decodifica diventano U+FFFD. Se
    // l'estrattore dipendesse dall'integrità del testo intorno, qui si romperebbe e lì no.
    //
    // La misura dice che è proprio questo il caso probabile: 6304 caratteri base64 sono
    // ~4728 byte, circa quattro volte una `NotificaScarto` in chiaro (~1,2 KB).
    // `SEQUENCE` DER (0x30 0x82) + OID PKCS#7 signedData: l'inizio vero di un p7m.
    const testa = Buffer.from([0x30, 0x82, 0x1a, 0x3c, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02])
    const coda = Buffer.from([0xa0, 0x82, 0x0b, 0xd4, 0x30, 0x82, 0xfe, 0x80, 0x81, 0x9f])
    const firmato = Buffer.concat([
      testa,
      Buffer.from(
        '<ListaErrori><Errore><Codice>00200</Codice><Descrizione>File non conforme al formato</Descrizione></Errore></ListaErrori>',
        'utf-8',
      ),
      coda,
    ]).toString('base64')

    // Il binario NON sopravvive alla decodifica UTF-8, ed è il punto: i tag sì.
    expect(Buffer.from(firmato, 'base64').toString('utf-8')).toContain('\uFFFD')

    const r = motivoDalleNotificheSdi(involucroMisurato(firmato))
    expect(r.motivo).toBe('(00200) File non conforme al formato')
  })

  it('e i tag si cercano anche a metà testo, non solo dal primo carattere', () => {
    const rumore = 'MIIF-preambolo-'
    const r = motivoDalleNotificheSdi(
      involucroMisurato(b64(`${rumore}<ListaErrori><Errore><Codice>00200</Codice><Descrizione>File non conforme al formato</Descrizione></Errore></ListaErrori>${rumore}`)),
    )
    expect(r.motivo).toBe('(00200) File non conforme al formato')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 2. `docType` — il tipo c'era, e non lo stavamo leggendo.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('docType è una chiave del TIPO di notifica: è quella che Aruba manda davvero', () => {
  it('una `NS` dichiarata con `docType` viene riconosciuta per quello che è', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [{ docType: 'NS', errorDescription: 'Codice destinatario non valido' }],
    })
    expect(r.tipo).toBe('NS')
    expect(r.motivo).toBe('Codice destinatario non valido')
  })

  /**
   * ⚠️ È L'ALTRA METÀ, E CONTA DI PIÙ. Finché `docType` non era una chiave del tipo, OGNI
   * notifica di Aruba risultava «tipo assente» e passava dal ramo difensivo: una `RC` —
   * la ricevuta di CONSEGNA, il racconto di un successo — poteva finire in
   * `sdi_scarto_motivo` sotto il titolo «Perché lo SDI l'ha respinta».
   */
  it('una `RC` DICHIARATA con `docType` non fornisce più il motivo di uno scarto', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [{ docType: 'RC', errori: [{ codice: '00001', descrizione: 'Consegna completata' }] }],
    })
    expect(r.motivo, 'una consegna riuscita è finita sotto «perché è stata respinta»').toBeNull()
  })

  it('fra una RC con `docType` e una NS con `docType`, vince la NS', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [
        { docType: 'RC', descrizione: 'Ricevuta di consegna' },
        { docType: 'NS', file: b64(NS_XML) },
      ],
    })
    expect(r.motivo).toContain('00400')
    expect(r.motivo).not.toContain('Ricevuta di consegna')
    expect(r.tipo).toBe('NS')
  })

  /** Il difensivo «tipo assente» resta: `null` vuol dire «non abbiamo capito la forma». */
  it('senza nessuna chiave di tipo, l\'allegato parla lo stesso', () => {
    const r = motivoDalleNotificheSdi({ notifications: [{ file: b64(NS_XML) }] })
    expect(r.motivo).toContain('00400')
    expect(r.tipo).toBeNull()
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 3. QUANDO L'ALLEGATO NON PARLA — la diagnostica del livello più profondo.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('la traccia diagnostica scende di un gradino: i NOMI dei tag, mai il contenuto', () => {
  /**
   * ⚠️ È LA RIGA CHE HA RESO POSSIBILE QUESTO LAVORO, spinta di un gradino. `descriviForma`
   * si fermava a `file: stringa(6304)`: se domani l'XML dentro non desse i tag attesi,
   * saremmo di nuovo ciechi — e per scoprirlo servirebbe un'altra interrogazione dell'API
   * dentro un secchio da 12 richieste al minuto.
   */
  it('un allegato XML senza errori riconoscibili lascia i NOMI dei tag nella forma', () => {
    const xml = `<ns3:RicevutaConsegna><IdentificativoSdI>1</IdentificativoSdI>` +
      `<NomeFile>a.xml</NomeFile><DataOraConsegna>2026-09-10</DataOraConsegna></ns3:RicevutaConsegna>`
    const r = motivoDalleNotificheSdi(involucroMisurato(b64(xml)))

    expect(r.motivo).toBeNull()
    // Il nome LOCALE, senza il prefisso: è quello che serve per riconoscere il documento, e
    // il prefisso è variabile — tenerlo vorrebbe dire che `ns3:X` e `ns2:X` sono due nomi.
    expect(r.forma).toContain('RicevutaConsegna')
    expect(r.forma, 'il prefisso di namespace è rimasto attaccato al nome').not.toContain('ns3:')
    expect(r.forma).toContain('IdentificativoSdI')
    expect(r.forma).toContain('DataOraConsegna')
    // E la lunghezza dell'allegato, che è l'altra metà della diagnosi.
    expect(r.forma).toContain(String(b64(xml).length))
    // La forma del JSON non si perde: è ancora lì, accanto.
    expect(r.forma).toContain('notifications')
    expect(r.forma).toContain('docType')
  })

  /**
   * 🔴 IL VINCOLO DI PRIVACY, in un test. Una notifica SdI porta l'anagrafica fiscale
   * dell'intestatario. I nomi dei tag non sono dati di nessuno; il contenuto dei tag sì.
   */
  it('nessun VALORE dell\'XML entra nella traccia, nemmeno la ragione sociale', () => {
    const xml = `<NotificaEsito><Denominazione>Rossi Costruzioni S.r.l.</Denominazione>` +
      `<CodiceFiscale>AAAAAA00A00A000A</CodiceFiscale><PartitaIVA>01234567890</PartitaIVA>` +
      `<Indirizzo>Via Inventata 1</Indirizzo></NotificaEsito>`
    const r = motivoDalleNotificheSdi(involucroMisurato(b64(xml)))

    expect(r.motivo).toBeNull()
    for (const valore of ['Rossi Costruzioni', 'AAAAAA00A00A000A', '01234567890', 'Via Inventata']) {
      expect(r.forma, `il valore «${valore}» è finito nella traccia`).not.toContain(valore)
    }
    // E i nomi ci sono: sono l'unica cosa che permetterà di riconoscere questo documento.
    expect(r.forma).toContain('Denominazione')
    expect(r.forma).toContain('PartitaIVA')
  })

  it('i nomi dei tag non si ripetono, e sono un numero finito', () => {
    const xml = Array.from({ length: 60 }, (_, i) => `<Tag${i}>v</Tag${i}><Ripetuto>v</Ripetuto>`).join('')
    const r = motivoDalleNotificheSdi(involucroMisurato(b64(xml)))

    expect(r.motivo).toBeNull()
    expect(r.forma.match(/Ripetuto/g) ?? [], 'un nome ripetuto occupa il budget di tutti gli altri').toHaveLength(1)
    expect(r.forma).toContain('Tag0')
    expect(r.forma, 'la traccia non ha tetto: si mangia la forma del JSON').not.toContain('Tag59')
    // ⚠️ I NOMI RIMASTI FUORI SI DICHIARANO, E IL NUMERO DEVE ESSERE QUELLO VERO. I nomi si
    // perdono in DUE punti — il tetto sulla scansione e il budget della riga — e un `…+N` che
    // contasse solo il secondo direbbe «+0» su un documento da 61 tag distinti: chi legge
    // crederebbe di aver visto tutto l'XML e cercherebbe il difetto nel documento sbagliato.
    // Qui i tag distinti sono 61 (`Tag0`…`Tag59` più `Ripetuto`) e se ne mostrano 12.
    expect(r.forma, 'nessuno ha detto quanti nomi sono rimasti fuori').toMatch(/…\+49$/)
  })

  /**
   * ⚠️ NON SI INVENTA. Un allegato che non è né base64 valido né XML non produce nessun
   * motivo, non lancia, e lascia detto PERCHÉ non ha prodotto niente — che è l'informazione
   * che al giro dopo permette di decidere cosa fare.
   */
  it('un allegato che non è né base64 né XML: nessun motivo, nessuna eccezione, e la traccia lo dice', () => {
    for (const spazzatura of ['non-è-base64 né XML: §§§ >>> <<<', '{"json":"ma non xml"}', '@@@@@@@@']) {
      const r = motivoDalleNotificheSdi(involucroMisurato(spazzatura))
      expect(r.motivo, `allegato «${spazzatura}»`).toBeNull()
      expect(r.forma, `allegato «${spazzatura}»`).toContain('non decodificabile')
    }
  })

  /**
   * ⚠️ LA VALIDAZIONE DEL BASE64 VA FATTA PRIMA, E QUESTO TEST È IL SUO UNICO CUSTODE.
   * `Buffer.from(s, 'base64')` non lancia MAI: sui caratteri fuori alfabeto tace e decodifica
   * quel che resta. Senza il controllo, una stringa qualunque del provider diventa dei byte
   * qualunque — e da byte qualunque può uscire qualcosa che somiglia a un tag, cioè un motivo
   * INVENTATO dentro un registro fiscale. Qui l'allegato è base64 vero, sporcato con
   * caratteri illegali: il decodificatore permissivo li salterebbe e leggerebbe la `NS`.
   */
  it('un allegato che NON è base64 pulito non si decodifica «lo stesso»', () => {
    const sporco = b64(NS_XML).replace(/(.{8})/g, '$1!')
    const r = motivoDalleNotificheSdi(involucroMisurato(sporco))

    expect(r.motivo, 'i caratteri fuori alfabeto sono stati saltati e il base64 letto comunque').toBeNull()
    expect(r.forma).toContain('non decodificabile')
  })

  /**
   * ⚠️ LA TRACCIA RACCONTA IL DOCUMENTO CHE STAVAMO LEGGENDO, non il primo che capita.
   * Una `RC` è esclusa dal filtro «NS o tipo assente»: il suo allegato non l'abbiamo nemmeno
   * aperto per cercarci un motivo, e descriverlo nel log significherebbe portarsi dietro un
   * documento estraneo — che è un altro corpo con l'anagrafica di una famiglia dentro, e una
   * diagnosi che manda a cercare il difetto nel posto sbagliato.
   */
  it('la traccia è quella della notifica ammessa, non quella di una RC accanto', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [
        { docType: 'RC', file: b64('<RicevutaConsegna><TagSoloDellaRicevuta/></RicevutaConsegna>') },
        { docType: 'NS' },
      ],
    })
    expect(r.motivo).toBeNull()
    expect(r.forma, 'la traccia racconta un documento che non stavamo leggendo').not.toContain(
      'TagSoloDellaRicevuta',
    )
  })

  /** Base64 valido, ma quello che c'è sotto non è XML: stessa risposta, `null`, altra diagnosi. */
  it('base64 di qualcosa che non è XML → nessun motivo, e si vede che era leggibile', () => {
    const r = motivoDalleNotificheSdi(involucroMisurato(b64('Rossi Costruzioni S.r.l. 01234567890')))
    expect(r.motivo).toBeNull()
    // Le due diagnosi sono diverse perché suggeriscono due mosse diverse: qui il campo si
    // decodifica e non è il documento che credevamo; sopra non è nemmeno base64.
    expect(r.forma).toContain('non è XML')
    expect(r.forma, 'il contenuto decodificato è finito nella traccia').not.toContain('Rossi Costruzioni')
    expect(r.forma).not.toContain('01234567890')
  })

  /**
   * ⚠️ IL TETTO NON È STILE. Questo codice gira dentro il giro di un cron con un tetto di
   * tempo suo, su un campo che arriva DAL PROVIDER: un allegato enorme non deve poter far
   * esplodere né memoria né tempo. Sopra il tetto non si decodifica affatto, e la lunghezza
   * finisce nella traccia — così si alza su una misura, non su un'ipotesi.
   */
  it('un allegato oltre il tetto non si decodifica, e la traccia dice quanto era grande', () => {
    const enorme = b64(`<ListaErrori><Errore><Codice>00400</Codice><Descrizione>${'x'.repeat(ALLEGATO_MAX * 2)}</Descrizione></Errore></ListaErrori>`)
    expect(enorme.length).toBeGreaterThan(ALLEGATO_MAX)

    const r = motivoDalleNotificheSdi(involucroMisurato(enorme))
    expect(r.motivo, 'il tetto non ha fermato niente').toBeNull()
    expect(r.forma).toContain(String(enorme.length))
    expect(r.forma).toContain(String(ALLEGATO_MAX))
  })

  /**
   * ⚠️ IL BUDGET. La traccia viaggia dentro il `msg` di una riga di log, insieme alla forma
   * del JSON, e `sanificaMessaggio` tronca a `MESSAGGIO_MAX` tagliando la CODA — cioè
   * proprio i nomi dei tag, che stanno in fondo. Un budget più largo del canale che lo
   * trasporta è una bugia, e qui sarebbe la bugia che rende inutile la traccia.
   */
  it('forma del JSON + traccia dell\'allegato stanno dentro `FORMA_MAX`, e il logger non le taglia', () => {
    const xml = Array.from({ length: 40 }, (_, i) => `<UnNomeDiTagPiuttostoLungo${i}>v</UnNomeDiTagPiuttostoLungo${i}>`).join('')
    const grande: Record<string, unknown> = { notifications: [{ docType: 'NS', file: b64(xml) }] }
    for (let i = 0; i < 60; i++) grande[`campo_numero_${i}`] = 'x'.repeat(30)

    const r = motivoDalleNotificheSdi(grande)
    expect(r.motivo).toBeNull()
    expect(r.forma.length).toBeLessThanOrEqual(FORMA_MAX)

    const msg = `${'p'.repeat(40)}: ${r.forma}`
    expect(sanificaMessaggio(msg), 'il logger ha tagliato la traccia').toBe(msg)
  })

  /**
   * LA FORMA DEL JSON NON VIENE SACRIFICATA ALLA TRACCIA. Quella misurata il 2026-09-11
   * misura circa 290 caratteri: se la traccia si prendesse metà del budget, la forma
   * arriverebbe monca proprio dove ci sono `errorCode` ed `errorDescription`.
   */
  it('la forma misurata sopravvive INTERA accanto alla traccia', () => {
    const r = motivoDalleNotificheSdi(involucroMisurato(b64('<Vuoto/>')))
    expect(r.motivo).toBeNull()
    for (const nome of ['count', 'notifications', 'filename', 'docType', 'invoiceId', 'file', 'result', 'errorDescription']) {
      expect(r.forma, `il nome «${nome}» è stato troncato via`).toContain(nome)
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 4. NON ROMPERE CIÒ CHE FUNZIONA, E NON LASCIARSI ROMPERE.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('l\'allegato si aggiunge ai campi JSON, non li sostituisce', () => {
  /** Non sappiamo se TUTTE le notifiche di Aruba abbiano l'allegato: il percorso vecchio vale. */
  it('gli errori in campi JSON continuano a valere, allegato o no', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [
        { docType: 'NS', errors: [{ errorCode: '00417', errorDescription: 'Identificativo fiscale non valorizzato' }] },
      ],
    })
    expect(r.motivo).toBe('(00417) Identificativo fiscale non valorizzato')
  })

  /** Se ci sono entrambi, vince l'elenco JSON: è già interpretato, e non va decodificato. */
  it('con elenco JSON E allegato, il motivo viene dall\'elenco', () => {
    const r = motivoDalleNotificheSdi({
      notifications: [{ docType: 'NS', errori: [{ codice: '00417', descrizione: 'Dai campi JSON' }], file: b64(NS_XML) }],
    })
    expect(r.motivo).toBe('(00417) Dai campi JSON')
  })

  /**
   * ⚠️ QUESTA FUNZIONE NON PUÒ LANCIARE. Il chiamante (`fattura/sync`) non la avvolge in un
   * `try`: un'eccezione qui diventerebbe un 500 e farebbe saltare l'INTERO giro del cron,
   * cioè trasformerebbe un dettaglio mancante in una perdita di lavoro.
   */
  it('nessuna forma di allegato la fa lanciare', () => {
    const forme: unknown[] = ['', '   ', '=', '====', 'A', '<', '<<<<', b64(''), '\u0000', '%%%%%%%%']
    for (const file of forme) {
      expect(() => motivoDalleNotificheSdi({ notifications: [{ docType: 'NS', file }] }), `file ${JSON.stringify(file)}`).not.toThrow()
    }
  })

  /**
   * `Buffer` è di Node, e `stato.ts` oggi è importato solo da route Node e da `client.ts`.
   * Se domani finisse in un runtime che non ce l'ha, deve degradare — non far cadere la route.
   */
  it('senza `Buffer` non lancia: rinuncia al base64 e lo dice nella traccia', () => {
    const file = b64(NS_XML)
    vi.stubGlobal('Buffer', undefined)
    try {
      const r = motivoDalleNotificheSdi(involucroMisurato(file))
      expect(r.motivo).toBeNull()
      expect(r.forma).toContain('allegato')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 5. IL COSTO. Espressioni regolari su 6.000 caratteri che arrivano dal provider.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('il lettore XML regge un input avverso senza andare in backtracking', () => {
  afterEach(() => vi.useRealTimers())

  /**
   * ⚠️ IL RISCHIO VERO DI UN LETTORE A ESPRESSIONI REGOLARI: un `<Errore>` aperto e mai
   * chiuso, ripetuto, fa ripartire la scansione fino in fondo a ogni occorrenza. Il costo
   * peggiore resta quadratico: a contenerlo è `ALLEGATO_MAX`, non la forma dell'espressione.
   *
   * MISURATO su questa macchina, allegato portato al tetto (media di 20 giri):
   *
   *     tag aperti e mai chiusi      16.000 car.   6,36 ms   ← il peggiore
   *     tag annidati all'infinito    16.384 car.   0,20 ms
   *     tag distinti a migliaia      16.384 car.   0,15 ms
   *     NS vera ripetuta fino al tetto 16.384 car. 0,03 ms
   *     attributi lunghissimi         6.019 car.   0,01 ms
   *     CDATA mai chiuso              5.030 car.   0,01 ms
   *     solo minori                   8.000 car.   0,01 ms
   *
   * E il tetto è misurato anche lui: sullo stesso input avverso la sola espressione costa
   * 3 ms a 16 KiB, 51 ms a 64 KiB, **2 secondi a 256 KiB** e 37 secondi a 1 MiB.
   */
  const avversi: Record<string, string> = {
    'tag aperti e mai chiusi': '<Errore>'.repeat(2_000),
    'tag annidati all\'infinito': `${'<Errore><Codice>'.repeat(500)}x${'</Codice></Errore>'.repeat(500)}`,
    'attributi lunghissimi': `<Errore ${'a="b" '.repeat(1_000)}>x</Errore>`,
    'CDATA mai chiuso': `<Errore><Descrizione><![CDATA[${'x'.repeat(5_000)}`,
    'solo minori': '<'.repeat(8_000),
  }

  for (const [nome, xml] of Object.entries(avversi)) {
    it(`«${nome}»: risponde in fretta e senza lanciare`, () => {
      const t0 = performance.now()
      const r = motivoDalleNotificheSdi(involucroMisurato(xml.slice(0, ALLEGATO_MAX)))
      const ms = performance.now() - t0
      expect(r).toBeDefined()
      // Generoso di proposito: è una guardia contro il backtracking catastrofico (secondi o
      // minuti), non una misura di prestazione. Il numero vero sta nel commento qui sopra.
      expect(ms, `«${nome}» ha impiegato ${ms.toFixed(1)} ms`).toBeLessThan(2_000)
    })
  }
})

/* ════════════════════════════════════════════════════════════════════════════
 * 6. `descriviForma` non cambia mestiere.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('descriviForma — il tetto si può stringere, il contratto resta', () => {
  it('un tetto esplicito tronca, e non allarga mai oltre `FORMA_MAX`', () => {
    const grande: Record<string, string> = {}
    for (let i = 0; i < 200; i++) grande[`campo_${i}`] = 'x'.repeat(20)
    expect(descriviForma(grande, 8, 80).length).toBeLessThanOrEqual(80)
    expect(descriviForma(grande).length).toBeLessThanOrEqual(FORMA_MAX)
  })
})
