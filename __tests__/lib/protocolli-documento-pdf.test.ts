// @vitest-environment node
/**
 * Il documento su richiesta (decisione #22) sulla carta intestata REALE.
 *
 * ⚠️ **DAL 2026-08-16 QUESTO MOTORE NON DISEGNA PIÙ LA TESTATA.** Fino a ieri ripeteva —
 * riga per riga, misura per misura — la stessa testata di `prestampati/impaginazione.ts`:
 * banda verde `rect(0, 0, 210, 30)`, logo bianco a 14/7,5, intestazione a 38, titolo a 58,
 * piede «Documento generato dal registro elettronico Kidville» a 287. Due copie della
 * stessa testata divergono sempre, e questa aveva già cominciato: 38 contro 40, 58 contro
 * 60.
 *
 * Adesso la testata è una sola, e non è disegnata da nessuno dei due: è **stampata sulla
 * carta**. Qui si impagina il solo contenuto, dentro la finestra che `CARTA` dichiara. I
 * test misurano l'INCHIOSTRO — non la linea di scrittura — perché una guardia sulla
 * baseline ha le maglie larghe quanto l'altezza del carattere.
 *
 * Nessun dato reale: nomi inventati, sede inventata.
 */
import { describe, it, expect } from 'vitest'
import { buildDocumentoRichiestaPdf } from '@/lib/protocolli/documento-pdf'
import { estraiTesto } from '@/lib/protocolli/estrai'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'
import { RIGHE_MINIME_IN_CODA } from '@/lib/carta/blocco-finale'
import {
  elementiTesto,
  immaginiDisegnate,
  ingombriPercorsi,
  numeroPagine,
  sovrapposti,
  type ElementoTesto,
} from '../fixtures/misure-pdf'

const INTESTAZIONE = ['Kidville Giugliano', 'Via Roma 1 — 80014 Giugliano (NA)']

function documento(modifiche: Partial<Parameters<typeof buildDocumentoRichiestaPdf>[0]> = {}) {
  return buildDocumentoRichiestaPdf({
    intestazione: INTESTAZIONE,
    titolo: 'NULLA OSTA AL TRASFERIMENTO',
    corpo:
      "Vista la richiesta presentata dalla famiglia, si concede il nulla osta al trasferimento dell'alunno/a Rossi Mario.",
    luogoData: 'Giugliano, lì 12/07/2026',
    ...modifiche,
  })
}

/**
 * La riga di servizio — «Pagina n di m» — sta di proposito SOTTO `contenutoFine`: è
 * l'unica cosa che l'app scrive nell'aria fra il contenuto e il piede stampato sulla
 * carta. Va riconosciuta e misurata contro l'altro limite, quello del piede, altrimenti o
 * il lock la conta come sconfinamento o si allarga la finestra e ci si perde dentro tutto
 * il resto.
 */
const eRigaDiServizio = (t: { yMm: number }) => Math.abs(t.yMm - CARTA.rigaServizio) < 0.1

/**
 * Quante righe di documento devono scendere sull'ultimo foglio insieme alla firma.
 *
 * ⚠️ **È un numero LETTERALE di proposito, e non `RIGHE_MINIME_IN_CODA`.** Scritto come
 * lettura della costante, questo lock diventa verde nell'istante in cui qualcuno abbassa la
 * costante — cioè smette di sorvegliare proprio la cosa per cui esiste. La riga qui sotto è
 * il ponte fra i due: se la politica condivisa cambia, si accorge questo file, e chi la
 * cambia deve venire a scrivere perché.
 */
const CODA_MINIMA_ATTESA = 3

/** Le due fasce che la carta si tiene: il marchio in cima, il piede a quattro colonne. */
const MARCHIO = {
  xMm: 0,
  yMm: CARTA.brandInizio,
  larghezzaMm: CARTA.larghezzaPagina,
  altezzaMm: CARTA.brandFine - CARTA.brandInizio,
}
const PIEDE_STAMPATO = {
  xMm: 0,
  yMm: CARTA.piedeInizio,
  larghezzaMm: CARTA.larghezzaPagina,
  altezzaMm: CARTA.piedeFine - CARTA.piedeInizio,
}

describe('buildDocumentoRichiestaPdf — contenuto', () => {
  it('produce un PDF con intestazione, titolo, corpo e luogo/data', async () => {
    const pdf = documento()
    expect(new TextDecoder('latin1').decode(pdf.slice(0, 5))).toBe('%PDF-')

    const testo = await estraiTesto(pdf)
    expect(testo).toContain('Kidville Giugliano')
    expect(testo).toContain('NULLA OSTA AL TRASFERIMENTO')
    expect(testo).toContain('Rossi Mario')
    expect(testo).toContain('Giugliano, lì 12/07/2026')
    expect(testo).toContain('La Direzione')
  })

  it('degrada senza intestazione (righe assenti, mai inventate)', async () => {
    const testo = await estraiTesto(
      documento({ intestazione: [], titolo: 'CERTIFICATO DI FREQUENZA', corpo: 'Testo del certificato.', luogoData: 'Lì 12/07/2026' })
    )
    expect(testo).toContain('CERTIFICATO DI FREQUENZA')
    expect(testo).toContain('Lì 12/07/2026')
  })
})

describe('buildDocumentoRichiestaPdf — la testata la porta la carta', () => {
  it('non disegna più la banda verde in cima al foglio', async () => {
    const dentroIlMarchio = (await ingombriPercorsi(documento())).filter((p) =>
      sovrapposti(p, MARCHIO)
    )
    expect(
      dentroIlMarchio,
      'la banda verde cadeva ESATTAMENTE sopra il marchio della scuola (12,5 → 27,05 mm): ' +
        'ridisegnarla significa coprirlo, che è il difetto n. 1 della specifica'
    ).toEqual([])
  })

  it('non disegna più nessun logo: quello vero è già stampato sulla carta', async () => {
    expect(await immaginiDisegnate(documento())).toEqual([])
  })

  it('non stampa più il proprio piede: la carta ne ha uno con la P.IVA e le tre sedi', async () => {
    const testo = await estraiTesto(documento())
    expect(testo).not.toContain('Documento generato dal registro elettronico')
  })

  it('niente inchiostro dentro il piede stampato sulla carta', async () => {
    const percorsi = (await ingombriPercorsi(documento())).filter((p) =>
      sovrapposti(p, PIEDE_STAMPATO)
    )
    expect(percorsi).toEqual([])

    const testi = (await elementiTesto(documento())).filter(
      (t) => ingombroTesto(t.yMm, t.corpoPt).fondo > CARTA.piedeInizio
    )
    expect(testi.map((t) => `${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])
  })
})

describe('buildDocumentoRichiestaPdf — la finestra di scrittura', () => {
  it('nessun testo sale sopra il marchio né scende sotto il limite del contenuto', async () => {
    const fuori = (await elementiTesto(documento())).filter((t) => {
      const { cima, fondo } = ingombroTesto(t.yMm, t.corpoPt)
      return cima < CARTA.brandFine || fondo > CARTA.contenutoFine
    })
    expect(fuori.map((t) => `${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])
  })

  it('su una pagina sola non scrive nemmeno la riga di servizio', async () => {
    // «Pagina 1 di 1» è rumore su un atto che va a una famiglia o a un ente.
    expect((await elementiTesto(documento())).filter(eRigaDiServizio)).toEqual([])
  })

  it('nessun testo esce dai margini laterali della carta', async () => {
    const fuori = (await elementiTesto(documento())).filter(
      (t) => t.xMm < CARTA.margineSx - 0.05 || t.xMm + t.larghezzaMm > CARTA.margineDx + 0.05
    )
    expect(fuori.map((t) => `${t.testo} @ x=${t.xMm.toFixed(1)}`)).toEqual([])
  })

  it('nessun filetto esce dai margini laterali della carta', async () => {
    const fuori = (await ingombriPercorsi(documento())).filter(
      (p) => p.xMm < CARTA.margineSx - 0.05 || p.xMm + p.larghezzaMm > CARTA.margineDx + 0.05
    )
    expect(fuori.map((p) => `x=${p.xMm.toFixed(1)}+${p.larghezzaMm.toFixed(1)}`)).toEqual([])
  })

  it('il filetto del titolo rientra dai margini, e resta centrato sulla pagina', async () => {
    // ⚠️ Questo lock esiste perché fino al 2026-08-16 il codice PROMETTEVA una riparazione
    // che non aveva fatto: un commento diceva «prima andava da 40 a 170, cioè scentrato di
    // 6 mm rispetto ai margini 22/188», e la riga sotto disegnava `margineSx + 18` →
    // `margineDx - 18`, cioè ancora 40 → 170. La riparazione non aveva cambiato un
    // millimetro, e la diagnosi era falsa pure lei: 40 e 170 sono simmetrici su 105, che è
    // il centro pagina. Il filetto RIENTRA di proposito, per staccare il titolo dal corpo:
    // qui si misura l'intenzione vera, così un commento non può più raccontarne un'altra.
    const filetti = (await ingombriPercorsi(documento())).filter((p) => p.altezzaMm < 0.5)
    const titolo = filetti.find((p) => p.yMm < 100)
    expect(titolo).toBeDefined()
    const sinistra = titolo!.xMm
    const destra = titolo!.xMm + titolo!.larghezzaMm
    // Dentro i margini del contenuto, e più corto di essi da entrambe le parti.
    expect(sinistra).toBeGreaterThan(CARTA.margineSx)
    expect(destra).toBeLessThan(CARTA.margineDx)
    // Centrato: i due rientri sono uguali, e il centro del filetto è il centro del foglio.
    expect(sinistra - CARTA.margineSx).toBeCloseTo(CARTA.margineDx - destra, 3)
    expect((sinistra + destra) / 2).toBeCloseTo(CARTA.larghezzaPagina / 2, 3)
  })
})

describe('buildDocumentoRichiestaPdf — il titolo che va a capo', () => {
  /**
   * ⚠️ **IL FILETTO VERDE BARRAVA LA SECONDA RIGA DEL TITOLO, E IL CORPO CI FINIVA SOPRA.**
   *
   * Il titolo si stampava con `maxWidth: LARGHEZZA_UTILE`, quindi jsPDF lo mandava a capo;
   * ma il filetto si disegnava a `y + 4` FISSO e il corpo ripartiva con `y += 16` FISSO,
   * due numeri che valgono solo per un titolo di una riga. Misurato:
   *
   * | titolo | righe | 2ª/3ª riga (inchiostro) | filetto | 1ª riga di corpo |
   * |---|---|---|---|---|
   * | 27 car. | 1 | — | 65,00 | 73,06 → 77,95 |
   * | **73 car.** | 2 | 62,24 → 68,76 | **65,00 — dentro l'inchiostro** | 73,06 |
   * | **117 car.** | 3 | 68,73 → **75,25** | 65,00 | **73,06 — sopra il titolo** |
   *
   * Non è un caso di scuola: lo schema zod della rotta è `titolo: z.string().max(120)`
   * (`src/app/api/admin/protocolli/genera-documento/route.ts:36`), il difetto comincia già a
   * 73 caratteri, e a 120 il titolo va su TRE righe — dove il corpo del documento si stampa
   * ADDOSSO all'ultima riga del titolo. È il motore dei CERTIFICATI PROTOCOLLATI: il foglio
   * che va alla famiglia e all'INPS per il Bonus Asilo Nido. Un titolo sbarrato da una riga
   * verde non è una sfumatura tipografica, è un atto che sembra annullato.
   *
   * Il lock che c'era (`nessun filetto esce dai margini laterali`) guardava l'asse
   * sbagliato — la x — e usava titoli corti come «NULLA OSTA AL TRASFERIMENTO».
   */
  const TITOLO_2_RIGHE = 'CERTIFICATO DI ISCRIZIONE E FREQUENZA PER BONUS ASILO NIDO INPS ANNO 2026'
  /** I 120 caratteri esatti che lo zod della rotta ammette: l'estremo, non un caso comodo. */
  const TITOLO_3_RIGHE =
    'CERTIFICATO DI ISCRIZIONE E FREQUENZA PER BONUS ASILO NIDO INPS ANNO SCOLASTICO 2026 2027 SEZIONE PRIMAVERA GIUGLIANO NA'

  const CORPO_TITOLO = 16
  const CORPO_TESTO = 12
  const righeTitolo = (elementi: ElementoTesto[]) => elementi.filter((t) => t.corpoPt === CORPO_TITOLO)
  const righeCorpo = (elementi: ElementoTesto[]) => elementi.filter((t) => t.corpoPt === CORPO_TESTO)
  /** L'ingombro d'inchiostro di una riga, come rettangolo a tutta larghezza utile. */
  const rigaComeFascia = (t: ElementoTesto) => ({
    xMm: t.xMm,
    yMm: ingombroTesto(t.yMm, t.corpoPt).cima,
    larghezzaMm: t.larghezzaMm,
    altezzaMm: ingombroTesto(t.yMm, t.corpoPt).fondo - ingombroTesto(t.yMm, t.corpoPt).cima,
  })

  it('il titolo va a capo davvero (altrimenti il lock non misura niente)', async () => {
    expect(TITOLO_3_RIGHE.length).toBe(120)
    expect(righeTitolo(await elementiTesto(documento({ titolo: TITOLO_2_RIGHE })))).toHaveLength(2)
    expect(righeTitolo(await elementiTesto(documento({ titolo: TITOLO_3_RIGHE })))).toHaveLength(3)
  })

  it('nessun filetto cade dentro l’inchiostro di una riga di titolo', async () => {
    for (const titolo of ['NULLA OSTA AL TRASFERIMENTO', TITOLO_2_RIGHE, TITOLO_3_RIGHE]) {
      const pdf = documento({ titolo })
      const percorsi = await ingombriPercorsi(pdf)
      const barre: string[] = []
      for (const riga of righeTitolo(await elementiTesto(pdf))) {
        for (const p of percorsi) {
          if (sovrapposti(p, rigaComeFascia(riga))) {
            barre.push(
              `${titolo.length} car.: filetto y=${p.yMm.toFixed(2)} dentro «${riga.testo.slice(0, 28)}»`
            )
          }
        }
      }
      expect(barre).toEqual([])
    }
  })

  it('il corpo non si stampa addosso all’ultima riga del titolo', async () => {
    for (const titolo of ['NULLA OSTA AL TRASFERIMENTO', TITOLO_2_RIGHE, TITOLO_3_RIGHE]) {
      const elementi = await elementiTesto(documento({ titolo }))
      const ultimaTitolo = righeTitolo(elementi).at(-1)!
      const primaCorpo = righeCorpo(elementi)[0]
      const fondoTitolo = ingombroTesto(ultimaTitolo.yMm, ultimaTitolo.corpoPt).fondo
      const cimaCorpo = ingombroTesto(primaCorpo.yMm, primaCorpo.corpoPt).cima
      expect(
        `${titolo.length} car.: titolo finisce a ${fondoTitolo.toFixed(2)}, corpo comincia a ${cimaCorpo.toFixed(2)}`
      ).toBe(
        `${titolo.length} car.: titolo finisce a ${fondoTitolo.toFixed(2)}, corpo comincia a ${Math.max(cimaCorpo, fondoTitolo).toFixed(2)}`
      )
      // E non solo «non si tocca»: fra i due ci vuole aria che si veda.
      expect(cimaCorpo - fondoTitolo).toBeGreaterThan(3)
    }
  })

  it('le righe del titolo non si accavallano fra loro', async () => {
    const righe = righeTitolo(await elementiTesto(documento({ titolo: TITOLO_3_RIGHE })))
    for (let k = 1; k < righe.length; k++) {
      const sopra = ingombroTesto(righe[k - 1].yMm, righe[k - 1].corpoPt).fondo
      const sotto = ingombroTesto(righe[k].yMm, righe[k].corpoPt).cima
      expect(`riga ${k + 1} comincia a ${sotto.toFixed(2)}, la precedente finisce a ${sopra.toFixed(2)}`).toBe(
        `riga ${k + 1} comincia a ${Math.max(sotto, sopra).toFixed(2)}, la precedente finisce a ${sopra.toFixed(2)}`
      )
    }
  })

  it('e l’intestazione di sede non si accavalla quando una riga va a capo', async () => {
    // Stesso difetto, stesso file, tre righe più su: l'intestazione si stampava con
    // `maxWidth` e un passo fisso di 4,5 mm. Una riga mandata a capo da jsPDF avanza di
    // ~3,65 mm a 9 pt, quindi finiva SOTTO la riga successiva, che sta a 4,5.
    const elementi = await elementiTesto(
      documento({
        intestazione: [
          'Kidville Giugliano — Scuola dell’infanzia La Favola società cooperativa sociale a responsabilità limitata, sede di Giugliano in Campania',
          'Via Prima Traversa Antica Giardini 5 — 80014 Giugliano in Campania (NA) — NA1A079004 · NA1E094004',
        ],
      })
    )
    const righe = elementi.filter((t) => t.corpoPt === 9)
    expect(righe.length).toBeGreaterThan(2)
    for (let k = 1; k < righe.length; k++) {
      const sopra = ingombroTesto(righe[k - 1].yMm, righe[k - 1].corpoPt).fondo
      const sotto = ingombroTesto(righe[k].yMm, righe[k].corpoPt).cima
      expect(`intestazione riga ${k + 1} @ ${sotto.toFixed(2)} dopo ${sopra.toFixed(2)}`).toBe(
        `intestazione riga ${k + 1} @ ${Math.max(sotto, sopra).toFixed(2)} dopo ${sopra.toFixed(2)}`
      )
    }
  })
})

describe('buildDocumentoRichiestaPdf — il testo lungo non finisce nel piede', () => {
  // 4.000 caratteri sono il massimo che lo schema zod della rotta accetta per il
  // documento «libero». Prima di questa riparazione ci finivano tutti su UNA pagina:
  // ~45 righe da 6,2 mm partendo da 74 fanno 353 mm su un foglio alto 297 — cioè le
  // ultime dieci righe erano stampate FUORI dal foglio, e nessuno le ha mai lette.
  const CORPO_LUNGO = 'Frase di collaudo del documento libero, lunga quanto basta. '.repeat(68)

  it('va a pagina nuova invece di stampare oltre il bordo', async () => {
    const pdf = documento({ corpo: CORPO_LUNGO })
    expect(await numeroPagine(pdf)).toBeGreaterThan(1)

    const elementi = await elementiTesto(pdf)
    const fuori = elementi
      .filter((t) => !eRigaDiServizio(t))
      .filter((t) => {
        const { cima, fondo } = ingombroTesto(t.yMm, t.corpoPt)
        return cima < CARTA.brandFine || fondo > CARTA.contenutoFine
      })
    expect(fuori.map((t) => `p${t.pagina} ${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])

    // E la riga di servizio, che sotto `contenutoFine` ci sta di proposito, non arriva
    // comunque a toccare il piede stampato sulla carta.
    const servizio = elementi.filter(eRigaDiServizio)
    expect(servizio.length).toBeGreaterThan(0)
    for (const riga of servizio) {
      expect(ingombroTesto(riga.yMm, riga.corpoPt).fondo).toBeLessThan(CARTA.piedeInizio)
    }
  })

  it('non perde per strada nemmeno una riga', async () => {
    const testo = (await estraiTesto(documento({ corpo: CORPO_LUNGO }))).replace(/\s+/g, ' ')
    // L'ultima parola del corpo deve esserci: un contenuto che «non ci sta» e sparisce è
    // la classe di difetto che questo progetto chiama incidente.
    expect(testo).toContain('lunga quanto basta.')
    expect(testo).toContain('La Direzione')
  })

  it("«La Direzione» e il luogo restano sullo stesso foglio, e sull'ultimo", async () => {
    const elementi = await elementiTesto(documento({ corpo: CORPO_LUNGO }))
    const pagine = await numeroPagine(documento({ corpo: CORPO_LUNGO }))
    const firma = elementi.find((t) => t.testo.includes('La Direzione'))
    const luogo = elementi.find((t) => t.testo.includes('Giugliano, lì'))
    expect(firma?.pagina).toBe(pagine)
    expect(luogo?.pagina).toBe(pagine)
  })
})

describe('buildDocumentoRichiestaPdf — la firma non finisce mai su un foglio da sola', () => {
  /**
   * ⚠️ **IL DIFETTO CHE QUESTO SCANDAGLIO HA TROVATO (riparato il 2026-08-16).**
   *
   * Lo stacco fra il corpo e il blocco firma era un `+18` fisso: se la firma non ci
   * stava, si apriva una pagina nuova, punto. **Scandagliato da 1 a 70 righe di corpo, il
   * difetto cadeva a 25-30 e 61-66**: dodici lunghezze su settanta, una finestra di sei
   * righe ogni trentasei. Il conto sulla prima: il corpo chiudeva a 244,4 → `max(250,6 +
   * 18, 150) = 268,6`, e il tetto della firma è `263,5 − 14 = 249,5` → pagina nuova.
   *
   * Il risultato era un secondo foglio di carta intestata — marchio, filigrana, le tre
   * sedi — con sopra soltanto «Giugliano, lì … — La Direzione — ______». È un CERTIFICATO
   * PROTOCOLLATO che va a una famiglia o all'INPS: la pagina della firma non portava una
   * sola parola del documento che firma, e chi la separa dal fascicolo ha in mano una firma
   * senza atto.
   *
   * E `carta/geometria.ts` lo prometteva per iscritto: «i millimetri per far stare la firma
   * nella pagina si trovano nel motore — che stringe lo stacco prima di aprire un foglio
   * nuovo». `impaginazione.ts` lo faceva davvero; questo motore no. Un commento che promette
   * un'aria che il codice non lascia è la classe di difetto che questo progetto chiama
   * incidente — e adesso la scelta la fa una funzione sola, `quotaBloccoFinale()`.
   *
   * ⚠️ **Stringere l'aria da solo non bastava**, ed è la parte che il conto qui sopra non
   * dice: a 28 righe il corpo chiude così in basso che nemmeno lo stacco minimo entra
   * (250,6 + 5 = 255,6 > 249,5). Serviva anche il «tieni insieme» sull'ULTIMA RIGA di
   * corpo, come nell'ordine al fornitore: quando è lei a riempire la pagina, scende sul
   * foglio nuovo insieme alla firma.
   */
  const corpoDi = (righe: number) =>
    Array.from({ length: righe }, (_, k) => `Riga di collaudo numero ${k + 1} del documento.`).join(
      '\n'
    )

  /**
   * ⚠️ **E «ALMENO UNA RIGA» NON BASTAVA: UNA RIGA PUÒ ESSERE DUE PAROLE.**
   *
   * La regola implementata era «l'ultima pagina non porta solo la chiusura», e formalmente
   * teneva: scandagliate 1→70 righe di corpo, non c'era un solo caso in cui l'ultimo foglio
   * avesse la sola firma. Ma **a 21 righe di corpo** l'ultima pagina conteneva esattamente
   * questo: «larghezza utile.» (la coda spezzata dell'ultima frase), «Giugliano in Campania,
   * lì 16/08/2026», «La Direzione», il tratto e «Pagina 2 di 2». Un foglio intero di carta
   * intestata della scuola — marchio, filigrana mascotte, ragione sociale, P.IVA e le tre
   * sedi — con sopra due parole e una firma. Succedeva anche a 22, 50 e 53 righe.
   *
   * La motivazione scritta nel codice non è «almeno una riga», è: *«chi la separa dal
   * fascicolo ha in mano una firma senza documento»* — e con «larghezza utile.» sul foglio
   * ce l'ha ancora. La soglia scelta soddisfaceva la lettera della regola e mancava lo scopo
   * per cui era stata scritta. Ora è `RIGHE_MINIME_IN_CODA`, e sta in `carta/blocco-finale.ts`
   * perché i tre motori del lotto la ereditino invece di riscoprirla ciascuno a modo suo.
   */
  it('la politica condivisa è ancora quella che questo motore pretende', () => {
    // Il ponte fra il numero letterale qui sopra e `carta/blocco-finale.ts`: se qualcuno
    // abbassa la soglia comune, questo file diventa rosso e chi la abbassa deve venire a
    // scrivere perché — invece di trovarsi i lock che si adeguano da soli.
    expect(RIGHE_MINIME_IN_CODA).toBe(CODA_MINIMA_ATTESA)
  })

  it('su qualunque lunghezza del corpo, sul foglio della firma c’è anche il documento', async () => {
    for (let n = 1; n <= 70; n++) {
      const elementi = await elementiTesto(documento({ corpo: corpoDi(n) }))
      const utili = elementi.filter((t) => !eRigaDiServizio(t))
      const ultima = Math.max(...utili.map((t) => t.pagina))
      const suUltima = utili.filter((t) => t.pagina === ultima)
      const corpoSuUltima = suUltima.filter((t) => /^Riga di collaudo numero/.test(t.testo))
      // Non «almeno una»: almeno `RIGHE_MINIME_IN_CODA`, o tutte se il documento è più corto.
      const attese = Math.min(CODA_MINIMA_ATTESA, n)
      expect(
        `${n} righe → p${ultima}: ${corpoSuUltima.length} righe di documento` +
          (corpoSuUltima.length >= attese
            ? ''
            : ` (${suUltima.map((t) => t.testo).join(' | ')})`)
      ).toBe(
        `${n} righe → p${ultima}: ${Math.max(corpoSuUltima.length, attese)} righe di documento`
      )
    }
  })

  /**
   * Lo scandaglio qui sopra usa righe che NON vanno a capo, una frase per riga. Questo usa
   * righe lunghe che jsPDF spezza — ed è la forma in cui il difetto si è visto: a 21 righe
   * l'ultima pagina portava «larghezza utile.», cioè la CODA SPEZZATA dell'ultima frase,
   * più la data e la firma. Due parole su un foglio di carta intestata: la lettera della
   * regola era rispettata e lo scopo no.
   */
  const corpoLungoDi = (righe: number) =>
    Array.from(
      { length: righe },
      (_, k) => `Riga ${k + 1} del certificato, lunga quanto basta per riempire la larghezza utile.`
    ).join('\n')

  it('vale anche quando l’ultima riga è la coda spezzata di una frase', async () => {
    for (let n = 1; n <= 70; n++) {
      const utili = (await elementiTesto(documento({ corpo: corpoLungoDi(n) }))).filter(
        (t) => !eRigaDiServizio(t)
      )
      const ultima = Math.max(...utili.map((t) => t.pagina))
      const suUltima = utili.filter((t) => t.pagina === ultima)
      const corpoSuUltima = suUltima.filter((t) => t.corpoPt === 12)
      // Il corpo si spezza, quindi le righe stampate sono più di `n`: la coda minima resta
      // `RIGHE_MINIME_IN_CODA`, e su un documento cortissimo tutte quelle che esistono.
      const attese = Math.min(CODA_MINIMA_ATTESA, n)
      expect(
        `${n} frasi → p${ultima}: ${corpoSuUltima.length} righe di documento` +
          (corpoSuUltima.length >= attese
            ? ''
            : ` (${suUltima.map((t) => t.testo).join(' | ')})`)
      ).toBe(
        `${n} frasi → p${ultima}: ${Math.max(corpoSuUltima.length, attese)} righe di documento`
      )
    }
  })

  it('e la firma non sfonda comunque il limite del contenuto', async () => {
    // Le sei lunghezze su cui il difetto si vedeva a occhio, più i due estremi delle due
    // finestre: se qualcuno «recupera» millimetri stringendo ancora, qui si accorge.
    for (const n of [24, 25, 28, 30, 31, 60, 61, 66, 67]) {
      const pdf = documento({ corpo: corpoDi(n) })
      const fuori = (await elementiTesto(pdf))
        .filter((t) => !eRigaDiServizio(t))
        .filter((t) => ingombroTesto(t.yMm, t.corpoPt).fondo > CARTA.contenutoFine)
      expect(fuori.map((t) => `${n} righe: ${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])

      const filetti = (await ingombriPercorsi(pdf)).filter((p) => sovrapposti(p, PIEDE_STAMPATO))
      expect(filetti.map((p) => `${n} righe: filetto @ y=${p.yMm.toFixed(1)}`)).toEqual([])
    }
  })
})
