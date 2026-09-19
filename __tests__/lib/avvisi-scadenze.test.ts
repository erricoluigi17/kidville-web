import { describe, it, expect, afterEach, vi } from 'vitest'
import { risolviScadenze, avvisoScaduto, adesioniChiuse } from '@/lib/avvisi/scadenze'
import { istanteDaLocale } from '@/lib/format/confini-giorno'

/**
 * ─── LE DUE SCADENZE DI UN AVVISO ────────────────────────────────────────────
 *
 * Gli istanti attesi non sono dedotti a mente: vengono dagli stessi offset di
 * Roma già fissati in `__tests__/lib/confini-giorno.test.ts` (+02:00 d'estate,
 * +01:00 d'inverno, con i due giorni di cambio ora provati lì una volta sola).
 *
 * Il caso che questo file esiste per tenere rosso è l'ULTIMO giorno di un avviso:
 * `AvvisoCard.tsx:91` fa `new Date('2026-09-19') < new Date()`, cioè mezzanotte
 * **UTC**, cioè le 02:00 italiane. Dalle due del mattino in poi l'avviso risulta
 * già morto il giorno in cui doveva essere ancora vivo.
 */

afterEach(() => {
  vi.useRealTimers()
})

/** Le 18:00 del 1° giugno a Roma, d'estate: `2026-06-01T16:00:00.000Z`. */
const GIUGNO_18 = '2026-06-01T16:00:00.000Z'

describe('avvisoScaduto — l\'estremo è INCLUSO e il fuso è Roma', () => {
  it('nessuna scadenza = non scade mai', () => {
    // Non è tolleranza: è il significato della colonna vuota, ed è il caso della
    // gran parte dei record storici.
    expect(avvisoScaduto(null, GIUGNO_18)).toBe(false)
  })

  it('🔴 IL BORDO: la scadenza è l\'ULTIMO istante valido, `adesso <= scadenza` è la finestra viva', () => {
    // Un millisecondo prima: c'è ancora.
    expect(avvisoScaduto(GIUGNO_18, '2026-06-01T15:59:59.999Z')).toBe(false)

    // ⚠️ SULL'ISTANTE ESATTO: C'È ANCORA. Questa asserzione diceva `true` fino al
    // 2026-09-19, ed è la riga che rendeva visibile una divergenza altrimenti
    // invisibile: il ramo «data pura» qui sotto usa `>` («alle 23:59:59.999
    // l'avviso è ancora vivo») mentre questo ramo usava `>=`. Due metà ciascuna
    // coerente con sé stessa, e nessun test che confrontasse le due.
    // La regola arbitrata è una sola, per tutti e tre i posti in cui vive
    // (questa funzione, il `v_ora > v_termine` della RPC, il `.gte` del feed):
    // LA SCADENZA È L'ULTIMO ISTANTE VALIDO, INCLUSO. Ed è il bordo che database
    // e interfaccia devono vedere allo stesso modo, o il bottone «Aderisci»
    // compare mentre la RPC rifiuta — per un millisecondo, una volta ogni tanto.
    expect(avvisoScaduto(GIUGNO_18, GIUGNO_18)).toBe(false)

    // Un millisecondo dopo: non c'è più. È QUI che il confine morde.
    expect(avvisoScaduto(GIUGNO_18, '2026-06-01T16:00:00.001Z')).toBe(true)
  })

  it('ORA LEGALE: 23:30 romane viste alle 22:00Z — che a Roma sono già le 00:00 del giorno dopo', () => {
    // La scadenza è digitata come «19 settembre, 23:30». D'estate Roma è +02:00,
    // quindi quell'istante è 21:30Z. Alle 22:00Z l'orologio italiano segna le
    // 00:00 del 20: l'avviso è scaduto da mezz'ora.
    const scadenza = istanteDaLocale('2026-09-19T23:30') as string
    expect(scadenza).toBe('2026-09-19T21:30:00.000Z')
    expect(avvisoScaduto(scadenza, '2026-09-19T22:00:00.000Z')).toBe(true)
    // …e alle 21:29:59.999Z (23:29:59.999 a Roma) era ancora vivo.
    expect(avvisoScaduto(scadenza, '2026-09-19T21:29:59.999Z')).toBe(false)
  })

  it('ORA SOLARE: le stesse cifre a gennaio sono un istante diverso', () => {
    // +01:00: le 23:30 romane sono le 22:30Z, non le 21:30Z. Un offset cablato a
    // mano sbaglierebbe di un'ora per metà anno.
    const scadenza = istanteDaLocale('2026-01-15T23:30') as string
    expect(scadenza).toBe('2026-01-15T22:30:00.000Z')
    expect(avvisoScaduto(scadenza, '2026-01-15T22:00:00.000Z')).toBe(false)
    expect(avvisoScaduto(scadenza, '2026-01-15T23:00:00.000Z')).toBe(true)
  })

  it('🔴 IL DIFETTO DI `AvvisoCard.tsx:91`: una DATA PURA vale fino a SERA, non fino alle 02:00', () => {
    // Un record storico con la vecchia colonna `scadenza date`. Alle 00:30Z sono
    // le 02:30 italiane del 19 settembre: l'avviso deve essere VIVO per tutto il
    // giorno, perché è ciò che chiunque abbia scritto «scadenza: 19 settembre» ha
    // sempre inteso.
    expect(avvisoScaduto('2026-09-19', '2026-09-19T00:30:00.000Z')).toBe(false)

    // Il codice che sta in produzione oggi dice l'opposto sullo stesso istante, e
    // qui lo si misura invece di raccontarlo: `new Date('2026-09-19')` è mezzanotte
    // UTC, quindi dalle 02:00 italiane in poi la card si mostra scaduta. Ventidue
    // ore su ventiquattro dell'ultimo giorno utile.
    const comeFaLaCardOggi = new Date('2026-09-19') < new Date('2026-09-19T00:30:00.000Z')
    expect(comeFaLaCardOggi).toBe(true)

    // L'ultimo millisecondo del giorno civile italiano: ancora vivo.
    expect(avvisoScaduto('2026-09-19', '2026-09-19T21:59:59.999Z')).toBe(false)
    // Il primo del giorno dopo: scaduto.
    expect(avvisoScaduto('2026-09-19', '2026-09-19T22:00:00.000Z')).toBe(true)
  })

  it('la data pura segue il fuso anche d\'inverno (+01:00, non +02:00)', () => {
    expect(avvisoScaduto('2026-01-15', '2026-01-15T22:59:59.999Z')).toBe(false)
    expect(avvisoScaduto('2026-01-15', '2026-01-15T23:00:00.000Z')).toBe(true)
  })

  it('🔴 una stringa malformata LANCIA: non vale «non scaduto»', () => {
    // Un parse fallito che scivola via come `false` significa adesioni riaperte a
    // tutti e un avviso che non sparisce più dalla bacheca. Qui il valore arriva
    // dal DATABASE: se non è una data, il difetto è nostro e va visto.
    expect(() => avvisoScaduto('non una data', GIUGNO_18)).toThrow()
    expect(() => avvisoScaduto('2026-02-30', GIUGNO_18)).toThrow() // il calendario, non il formato
    expect(() => avvisoScaduto('19/09/2026', GIUGNO_18)).toThrow()
    // Anche l'istante «adesso» illeggibile: un `NaN` in un confronto risponde
    // sempre `false`, cioè «non scaduto», che è la risposta pericolosa.
    expect(() => avvisoScaduto(GIUGNO_18, 'adesso')).toThrow()
  })

  it('non guarda l\'orologio di sistema: l\'istante lo passa il chiamante', () => {
    // È ciò che permette a una rotta di usare lo STESSO istante per tutti i
    // controlli di una richiesta. Con l'orologio congelato un anno dopo la
    // scadenza, la risposta resta quella dell'istante passato.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-06-01T12:00:00.000Z'))
    expect(avvisoScaduto(GIUGNO_18, '2026-06-01T15:00:00.000Z')).toBe(false)
  })
})

describe('adesioniChiuse — il ripiego su scadenza_avviso, gemello del COALESCE', () => {
  it('con `scadenza_adesione` decide quella, anche se l\'avviso resta visibile più a lungo', () => {
    // È il caso per cui le due scadenze esistono: «le adesioni si chiudono
    // venerdì, ma l'avviso resta leggibile fino alla gita».
    const row = {
      scadenza_adesione: '2026-06-01T16:00:00.000Z',
      scadenza_avviso: '2026-06-10T16:00:00.000Z',
    }
    expect(adesioniChiuse(row, '2026-06-01T15:00:00.000Z')).toBe(false)
    expect(adesioniChiuse(row, '2026-06-02T10:00:00.000Z')).toBe(true)
    // …mentre l'avviso è ancora vivo, e si vede.
    expect(avvisoScaduto(row.scadenza_avviso, '2026-06-02T10:00:00.000Z')).toBe(false)
  })

  it('senza `scadenza_adesione` ripiega su `scadenza_avviso` — i record storici', () => {
    // ⚠️ Gemello del `COALESCE(scadenza_adesione, scadenza_avviso)` della RPC. Senza
    // il ripiego, ogni avviso pubblicato prima della migrazione avrebbe le
    // adesioni aperte per sempre, anche quello sparito dalla bacheca sei mesi fa.
    const row = { scadenza_adesione: null, scadenza_avviso: GIUGNO_18 }
    expect(adesioniChiuse(row, '2026-06-01T15:59:59.999Z')).toBe(false)
    // Sull'istante esatto si aderisce ANCORA: `adesioniChiuse` delega a
    // `avvisoScaduto`, quindi eredita lo stesso bordo incluso — e deve ereditarlo,
    // perché è la metà TypeScript del `v_ora > v_termine` della RPC.
    expect(adesioniChiuse(row, GIUGNO_18)).toBe(false)
    // Un millisecondo dopo, no.
    expect(adesioniChiuse(row, '2026-06-01T16:00:00.001Z')).toBe(true)
  })

  it('il ripiego porta con sé anche la lettura della DATA PURA', () => {
    // Un record storico ha `scadenza` a grana giorno: «19 settembre» significa
    // tutto il 19, anche per le adesioni.
    const row = { scadenza_adesione: null, scadenza_avviso: '2026-09-19' }
    expect(adesioniChiuse(row, '2026-09-19T00:30:00.000Z')).toBe(false)
    expect(adesioniChiuse(row, '2026-09-19T22:00:00.000Z')).toBe(true)
  })

  it('entrambe vuote = adesioni sempre aperte', () => {
    expect(adesioniChiuse({ scadenza_adesione: null, scadenza_avviso: null }, GIUGNO_18)).toBe(false)
  })
})

describe('risolviScadenze — i quattro rifiuti e il caso buono', () => {
  const ADESSO = '2026-06-01T10:00:00.000Z' // le 12:00 a Roma

  it('presa visione: basta la scadenza dell\'avviso, l\'adesione resta `null`', () => {
    const esito = risolviScadenze({
      tipo: 'presa_visione',
      scadenzaAvvisoLocale: '2026-06-10T18:00',
      scadenzaAdesioneLocale: null,
      vietaPassato: true,
      adessoISO: ADESSO,
    })
    expect(esito).toEqual({
      ok: true,
      scadenzaAvviso: '2026-06-10T16:00:00.000Z',
      scadenzaAdesione: null,
    })
  })

  it('SCADENZA_AVVISO_MANCANTE: è obbligatoria su OGNI avviso', () => {
    for (const mancante of [null, undefined, '', '   ']) {
      const esito = risolviScadenze({
        tipo: 'presa_visione',
        scadenzaAvvisoLocale: mancante,
        scadenzaAdesioneLocale: null,
        vietaPassato: true,
        adessoISO: ADESSO,
      })
      expect(esito).toEqual({ ok: false, codice: 'SCADENZA_AVVISO_MANCANTE' })
    }
  })

  it('SCADENZA_AVVISO_MANCANTE anche per una forma illeggibile — e NON lancia', () => {
    // Qui il valore arriva dal CLIENT: un'eccezione lo trasformerebbe in un 500,
    // cioè «è colpa mia» detto di uno sbaglio di chi manda la richiesta. È
    // l'opposto di `avvisoScaduto`, che legge dal database e deve lanciare.
    const esito = risolviScadenze({
      tipo: 'presa_visione',
      scadenzaAvvisoLocale: '2026-02-30T10:00',
      scadenzaAdesioneLocale: null,
      vietaPassato: false,
      adessoISO: ADESSO,
    })
    expect(esito).toEqual({ ok: false, codice: 'SCADENZA_AVVISO_MANCANTE' })
  })

  it('SCADENZA_ADESIONE_MANCANTE: obbligatoria sul tipo `adesione`, e solo su quello', () => {
    const base = {
      scadenzaAvvisoLocale: '2026-06-10T18:00',
      scadenzaAdesioneLocale: null,
      vietaPassato: true,
      adessoISO: ADESSO,
    }
    // Un avviso di adesione senza termine è un modulo che non si chiude mai: le
    // risposte arrivano dopo la gita e il conteggio dei posti non si ferma.
    expect(risolviScadenze({ ...base, tipo: 'adesione' })).toEqual({
      ok: false,
      codice: 'SCADENZA_ADESIONE_MANCANTE',
    })
    // Sugli altri tipi la stessa assenza è legittima.
    expect(risolviScadenze({ ...base, tipo: 'presa_visione' }).ok).toBe(true)
    expect(risolviScadenze({ ...base, tipo: null }).ok).toBe(true)
  })

  it('SCADENZE_INCOERENTI: aderire dopo che l\'avviso è sparito non ha senso', () => {
    const esito = risolviScadenze({
      tipo: 'adesione',
      scadenzaAvvisoLocale: '2026-06-10T18:00',
      scadenzaAdesioneLocale: '2026-06-10T18:01', // un minuto oltre
      vietaPassato: true,
      adessoISO: ADESSO,
    })
    expect(esito).toEqual({ ok: false, codice: 'SCADENZE_INCOERENTI' })
  })

  it('🔑 L\'UGUAGLIANZA È AMMESSA: `<=`, non `<`', () => {
    // È la configurazione più naturale che esista — «le adesioni si chiudono
    // quando l'avviso sparisce» — ed è quella che la segreteria ottiene copiando
    // la stessa data nei due campi. Un confronto stretto la rifiuterebbe con un
    // messaggio incomprensibile su due date identiche.
    const esito = risolviScadenze({
      tipo: 'adesione',
      scadenzaAvvisoLocale: '2026-06-10T18:00',
      scadenzaAdesioneLocale: '2026-06-10T18:00',
      vietaPassato: true,
      adessoISO: ADESSO,
    })
    expect(esito).toEqual({
      ok: true,
      scadenzaAvviso: '2026-06-10T16:00:00.000Z',
      scadenzaAdesione: '2026-06-10T16:00:00.000Z',
    })
  })

  it('il confronto fra le due scadenze è fra ISTANTI, non fra stringhe', () => {
    // Due cifre locali diverse possono essere lo stesso istante — è il 25 ottobre,
    // dove le 02:30 e le 02:30 (la seconda volta) esistono davvero. Un confronto
    // lessicale su `YYYY-MM-DDTHH:MM` sbaglierebbe ogni volta che l'offset cambia
    // fra i due estremi.
    const esito = risolviScadenze({
      tipo: 'adesione',
      scadenzaAvvisoLocale: '2026-10-25T03:30', // 02:30Z
      scadenzaAdesioneLocale: '2026-10-25T02:30', // 01:30Z — un'ora PRIMA
      vietaPassato: false,
      adessoISO: ADESSO,
    })
    expect(esito).toEqual({
      ok: true,
      scadenzaAvviso: '2026-10-25T02:30:00.000Z',
      scadenzaAdesione: '2026-10-25T01:30:00.000Z',
    })
  })

  it('SCADENZA_NEL_PASSATO solo con `vietaPassato: true` (il POST)', () => {
    const nascePassato = {
      tipo: 'presa_visione',
      scadenzaAvvisoLocale: '2026-06-01T09:00', // le 07:00Z, tre ore fa
      scadenzaAdesioneLocale: null,
      adessoISO: ADESSO,
    }
    // Sul POST è sempre uno sbaglio di digitazione: nessuno pubblica qualcosa
    // perché nessuno lo veda.
    expect(risolviScadenze({ ...nascePassato, vietaPassato: true })).toEqual({
      ok: false,
      codice: 'SCADENZA_NEL_PASSATO',
    })
    // ⚠️ Sul PUT è IL GESTO: è così che la segreteria chiude subito un avviso (la
    // gita è annullata). Senza, l'unica alternativa sarebbe cancellarlo, cioè
    // buttare via anche le adesioni già raccolte.
    expect(risolviScadenze({ ...nascePassato, vietaPassato: false })).toEqual({
      ok: true,
      scadenzaAvviso: '2026-06-01T07:00:00.000Z',
      scadenzaAdesione: null,
    })
  })

  it('🔑 IL GESTO: un\'adesione si CHIUDE SUBITO mettendo entrambe le scadenze nel passato', () => {
    // È il caso che il commento di `risolviScadenze` dichiara essere il motivo per
    // cui `vietaPassato` esiste, e fino al 2026-09-19 nessun test lo esercitava: il
    // caso qui sopra passa `scadenzaAdesioneLocale: null`, quindi il ramo della
    // scadenza d'adesione nel passato non veniva mai percorso sul PUT.
    //
    // La gita è annullata alle 12:00: la segreteria mette le due scadenze a
    // stamattina e l'avviso sparisce dalla bacheca con dentro tutte le adesioni
    // già raccolte e le prese visione. L'alternativa — cancellare l'avviso — le
    // butterebbe via.
    const chiusuraImmediata = {
      tipo: 'adesione',
      scadenzaAvvisoLocale: '2026-06-01T09:00', // le 07:00Z, tre ore fa
      scadenzaAdesioneLocale: '2026-06-01T08:30', // le 06:30Z, e PRIMA dell'altra
      adessoISO: ADESSO,
    }
    // Sul PUT (`vietaPassato: false`) passa, ed è il punto di tutta la funzione.
    expect(risolviScadenze({ ...chiusuraImmediata, vietaPassato: false })).toEqual({
      ok: true,
      scadenzaAvviso: '2026-06-01T07:00:00.000Z',
      scadenzaAdesione: '2026-06-01T06:30:00.000Z',
    })
    // Sullo STESSO input il POST rifiuta: un avviso che nasce già chiuso è sempre
    // uno sbaglio di digitazione. Il gemello non è un di più — senza, `vietaPassato`
    // potrebbe essere ignorato del tutto e i due test resterebbero verdi lo stesso.
    expect(risolviScadenze({ ...chiusuraImmediata, vietaPassato: true })).toEqual({
      ok: false,
      codice: 'SCADENZA_NEL_PASSATO',
    })
  })

  it('`vietaPassato` guarda ANCHE la scadenza dell\'adesione', () => {
    // Un avviso che nasce visibile ma con le adesioni già chiuse lascia i genitori
    // davanti a un modulo che non accetta risposte: lo stesso sbaglio, dall'altra
    // parte.
    const esito = risolviScadenze({
      tipo: 'adesione',
      scadenzaAvvisoLocale: '2026-06-10T18:00', // futura
      scadenzaAdesioneLocale: '2026-06-01T09:00', // passata
      vietaPassato: true,
      adessoISO: ADESSO,
    })
    expect(esito).toEqual({ ok: false, codice: 'SCADENZA_NEL_PASSATO' })
  })

  it('l\'ordine dei controlli: l\'esistenza prima del rapporto con l\'adesso', () => {
    // Chi sbaglia due cose insieme deve ricevere il messaggio più utile per primo:
    // «manca la scadenza dell'adesione», non «la scadenza è nel passato» detto di
    // un campo che non ha ancora compilato.
    const esito = risolviScadenze({
      tipo: 'adesione',
      scadenzaAvvisoLocale: '2026-06-01T09:00', // già passata
      scadenzaAdesioneLocale: null, // e obbligatoria
      vietaPassato: true,
      adessoISO: ADESSO,
    })
    expect(esito).toEqual({ ok: false, codice: 'SCADENZA_ADESIONE_MANCANTE' })
  })

  it('una scadenza esattamente uguale all\'adesso è ANCORA VALIDA (l\'estremo è incluso)', () => {
    // Coerente con `avvisoScaduto`, che questa funzione chiama: la scadenza è
    // l'ultimo istante valido, non il primo morto. Salvare un avviso che scade
    // «adesso» al minuto esatto è un caso di bordo legittimo — la segreteria che
    // chiude una gita alle 12:00 in punto alle 12:00 in punto — e non è lo
    // sbaglio di digitazione che `vietaPassato` esiste per intercettare.
    const esito = risolviScadenze({
      tipo: 'presa_visione',
      scadenzaAvvisoLocale: '2026-06-01T12:00', // = ADESSO, le 10:00Z
      scadenzaAdesioneLocale: null,
      vietaPassato: true,
      adessoISO: ADESSO,
    })
    expect(esito).toEqual({
      ok: true,
      scadenzaAvviso: '2026-06-01T10:00:00.000Z',
      scadenzaAdesione: null,
    })

    // …e un millisecondo dopo quel bordo morde davvero: senza questa seconda
    // metà, il test resterebbe verde anche se `vietaPassato` smettesse di
    // guardare il passato.
    const unMsDopo = risolviScadenze({
      tipo: 'presa_visione',
      scadenzaAvvisoLocale: '2026-06-01T12:00',
      scadenzaAdesioneLocale: null,
      vietaPassato: true,
      adessoISO: '2026-06-01T10:00:00.001Z',
    })
    expect(unMsDopo).toEqual({ ok: false, codice: 'SCADENZA_NEL_PASSATO' })
  })
})
