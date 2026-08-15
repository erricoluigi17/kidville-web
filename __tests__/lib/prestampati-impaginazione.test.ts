// @vitest-environment node
/**
 * Lock sull'impaginazione dei prestampati (`docs/prestampati/00-impaginazione.md`, §5).
 *
 * Non si ispezionano i pixel di un PDF, e qui non si finge di poterlo fare: si misura ciò
 * che il formato espone davvero — i byte, il numero di pagine, per ogni pezzo di testo la
 * stringa e le coordinate del suo punto d'inizio, e per ogni percorso disegnato il suo
 * rettangolo d'ingombro. Con quelle si prova ciò che la specifica chiede: il corpo che
 * comincia a x=22 e non esce dai 166 mm, il blocco firma fra y=150 e y=240, il piede su
 * ogni pagina, e due cornici che non si accavallano.
 *
 * ⚠️ **DAL 2026-08-15 QUESTO MOTORE STAMPA SOPRA LA CARTA INTESTATA REALE.** Non disegna
 * più né la banda verde né il logo: ce li ha già la carta, e ridisegnarli significava
 * coprirli. Le due fasce che l'asset si tiene — il marchio fino a 26,8 mm e il piede a
 * quattro colonne da 272,1 — sono territorio vietato: `CARTA` le dichiara, e i test qui
 * sotto verificano che nessun elemento ci finisca dentro. Un'asserzione che pretendesse
 * di nuovo la banda o il logo non sarebbe un test più severo, sarebbe il difetto.
 *
 * Nessun dato reale: nomi inventati, sede inventata, protocolli inventati.
 */
import { describe, it, expect } from 'vitest'
import { buildPrestampatoPdf } from '@/lib/prestampati/impaginazione'
import type { BloccoPrestampato, DocumentoPrestampato } from '@/lib/prestampati/tipi'
import { CARTA } from '@/lib/carta/geometria'
import { estraiTesto } from '@/lib/protocolli/estrai'

const MM_PER_PUNTO = 25.4 / 72
const ALTEZZA_A4_MM = 297

/**
 * Le coordinate viaggiano nel PDF in punti e con pochi decimali: 150 mm tornano indietro
 * come 149,99992. Un confronto esatto qui non misurerebbe l'impaginazione, misurerebbe
 * l'arrotondamento del formato.
 */
const TOLLERANZA_MM = 0.05

/**
 * Il riquadro di verifica (§4.3) non ha più un bordo ALTO fisso: si àncora col bordo
 * BASSO a `CARTA.contenutoFine` e cresce verso l'alto quanto gli servono le sue righe.
 * Con un bordo alto fisso a 262 e tre righe il fondo cadeva a 278,8 mm — dentro il piede
 * a quattro colonne stampato sulla carta.
 */
const FONDO_RIQUADRO_VERIFICA_MM = CARTA.contenutoFine

interface ElementoTesto {
  pagina: number
  testo: string
  xMm: number
  larghezzaMm: number
  /** Millimetri dal bordo ALTO, come nella specifica (il PDF li conta dal basso). */
  yMm: number
}

/** Ogni pezzo di testo del PDF con la sua posizione, pagina per pagina. */
async function elementiTesto(pdf: Uint8Array): Promise<ElementoTesto[]> {
  const { getDocumentProxy } = await import('unpdf')
  // `slice()` difensivo: PDF.js detacha l'ArrayBuffer che riceve (stessa trappola
  // documentata in `src/lib/protocolli/estrai.ts`).
  const doc = await getDocumentProxy(pdf.slice())
  const elementi: ElementoTesto[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const pagina = await doc.getPage(p)
    const contenuto = await pagina.getTextContent()
    for (const item of contenuto.items as Array<{ str?: string; width?: number; transform?: number[] }>) {
      if (typeof item.str !== 'string' || !item.str.trim()) continue
      const t = item.transform ?? [0, 0, 0, 0, 0, 0]
      elementi.push({
        pagina: p,
        testo: item.str,
        xMm: t[4] * MM_PER_PUNTO,
        larghezzaMm: (item.width ?? 0) * MM_PER_PUNTO,
        yMm: ALTEZZA_A4_MM - t[5] * MM_PER_PUNTO,
      })
    }
  }
  return elementi
}

async function numeroPagine(pdf: Uint8Array): Promise<number> {
  const { getDocumentProxy } = await import('unpdf')
  const doc = await getDocumentProxy(pdf.slice())
  return doc.numPages
}

/** Un rettangolo sul foglio: `yMm` è il bordo ALTO, come le misure della specifica. */
interface Ingombro {
  pagina: number
  xMm: number
  yMm: number
  larghezzaMm: number
  altezzaMm: number
}

/**
 * L'ingombro di ogni percorso disegnato — banda verde, filetti, cornici, caselle.
 *
 * PDF.js consegna per ogni `constructPath` il riquadro di delimitazione già calcolato:
 * è il modo di misurare una CORNICE, che il testo estratto non racconta. Serve proprio
 * lì dove due riquadri potrebbero accavallarsi senza che nessuna riga di testo si
 * sovrapponga all'altra.
 */
async function ingombriPercorsi(pdf: Uint8Array): Promise<Ingombro[]> {
  const { getDocumentProxy, getResolvedPDFJS } = await import('unpdf')
  const { OPS } = await getResolvedPDFJS()
  const doc = await getDocumentProxy(pdf.slice())
  const ingombri: Ingombro[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const ops = await (await doc.getPage(p)).getOperatorList()
    const fnArray = ops.fnArray as number[]
    const argsArray = ops.argsArray as unknown[]
    for (let i = 0; i < fnArray.length; i++) {
      if (fnArray[i] !== OPS.constructPath) continue
      const limiti = (argsArray[i] as unknown[])[2] as ArrayLike<number> | undefined
      if (!limiti || limiti.length < 4) continue
      ingombri.push({
        pagina: p,
        xMm: limiti[0] * MM_PER_PUNTO,
        yMm: ALTEZZA_A4_MM - limiti[3] * MM_PER_PUNTO,
        larghezzaMm: (limiti[2] - limiti[0]) * MM_PER_PUNTO,
        altezzaMm: (limiti[3] - limiti[1]) * MM_PER_PUNTO,
      })
    }
  }
  return ingombri
}

/**
 * Dove finisce ogni immagine disegnata.
 *
 * Il motore non ne disegna più NESSUNA: il logo lo porta la carta intestata. Contare i
 * DISEGNI (e non le risorse della pagina, che jsPDF tiene in un dizionario solo e
 * condiviso) è ciò che rende misurabile quel «nessuna».
 */
async function immaginiDisegnate(pdf: Uint8Array): Promise<Ingombro[]> {
  const { getDocumentProxy, getResolvedPDFJS } = await import('unpdf')
  const { OPS } = await getResolvedPDFJS()
  const doc = await getDocumentProxy(pdf.slice())
  const immagini: Ingombro[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const ops = await (await doc.getPage(p)).getOperatorList()
    const fnArray = ops.fnArray as number[]
    const argsArray = ops.argsArray as unknown[]
    for (let i = 0; i < fnArray.length; i++) {
      if (fnArray[i] !== OPS.paintImageXObject) continue
      // La posizione non sta negli argomenti del disegno ma nella matrice che lo precede.
      let matrice: number[] | null = null
      for (let j = i - 1; j >= 0 && j > i - 8; j--) {
        if (fnArray[j] === OPS.transform) {
          matrice = argsArray[j] as number[]
          break
        }
      }
      if (!matrice) continue
      const [larghezza, , , altezza, x, yBasso] = matrice
      immagini.push({
        pagina: p,
        xMm: x * MM_PER_PUNTO,
        yMm: ALTEZZA_A4_MM - (yBasso + altezza) * MM_PER_PUNTO,
        larghezzaMm: larghezza * MM_PER_PUNTO,
        altezzaMm: altezza * MM_PER_PUNTO,
      })
    }
  }
  return immagini
}

const occorrenze = (testo: string, ago: string) => testo.split(ago).length - 1

const INTESTAZIONE = [
  'Scuola dell’Infanzia di Prova Soc. Coop.',
  'Via delle Betulle 1 — 80000 Cittanova (XX)',
  'Cod. Mecc. XX0X00000X',
]

function documento(modifiche: Partial<DocumentoPrestampato> = {}): DocumentoPrestampato {
  return {
    intestazione: INTESTAZIONE,
    titolo: 'MODULO DI PROVA',
    blocchi: [{ tipo: 'paragrafo', testo: 'Il presente modulo serve a collaudare il motore.' }],
    luogoData: 'Cittanova, 13 agosto 2026',
    firma: { tipo: 'nessuna' },
    ...modifiche,
  }
}

/** Capoversi di riempimento: servono a spingere la quota, non dicono niente. */
const riempimento = (quanti: number): BloccoPrestampato[] =>
  Array.from({ length: quanti }, (_, i) => ({
    tipo: 'paragrafo',
    testo: `Capoverso numero ${i + 1} del modulo di collaudo, scritto per occupare la pagina.`,
  }))

/**
 * Un blocco per ogni tipo. È un `Record` sulla chiave dell'unione di proposito: aggiungere
 * un tipo di blocco in `tipi.ts` senza aggiungerlo qui NON compila, quindi la copertura
 * dei tipi è verificata dal compilatore e non da una lista che si dimentica di crescere.
 */
const UNO_PER_TIPO: Record<BloccoPrestampato['tipo'], BloccoPrestampato> = {
  paragrafo: { tipo: 'paragrafo', testo: 'Paragrafo di collaudo del corpo del testo.' },
  sezione: { tipo: 'sezione', titolo: "Dati dell'alunno/a" },
  campi: {
    tipo: 'campi',
    colonne: 2,
    campi: [
      { etichetta: 'Cognome', valore: 'Bianchi' },
      { etichetta: 'Nome', valore: 'Giulia' },
      { etichetta: 'Data di nascita', valore: '01/09/2021' },
      { etichetta: 'Sezione' },
    ],
  },
  caselle: {
    tipo: 'caselle',
    caselle: [
      { testo: 'Kidville Uno', spuntata: true },
      { testo: 'Kidville Due' },
      { testo: 'Kidville Tre' },
    ],
  },
  elenco: { tipo: 'elenco', voci: ['Prima voce di elenco', 'Seconda voce di elenco'] },
  tabella: {
    tipo: 'tabella',
    intestazioni: ['Cognome e nome', 'Relazione', 'Documento'],
    righe: [['Verdi Anna', 'Nonna', 'CI AB0000000']],
    righeVuote: 3,
  },
  riquadro: {
    tipo: 'riquadro',
    titolo: 'Riservato a segreteria',
    campi: [{ etichetta: 'Preso in carico il' }, { etichetta: 'Da' }],
  },
  spazio: { tipo: 'spazio', mm: 6 },
}

describe('buildPrestampatoPdf — carta e ritmo (§1 e §2)', () => {
  it('produce byte PDF con testata, corpo e luogo/data', async () => {
    const pdf = buildPrestampatoPdf(documento())

    expect(new TextDecoder('latin1').decode(pdf.slice(0, 5))).toBe('%PDF-')

    const testo = await estraiTesto(pdf)
    expect(testo).toContain('Via delle Betulle 1')
    expect(testo).toContain('MODULO DI PROVA')
    expect(testo).toContain('Il presente modulo serve a collaudare il motore.')
    expect(testo).toContain('Cittanova, 13 agosto 2026')
  })

  it('non disegna più né banda né logo: la carta ce li ha già', async () => {
    // L'asserzione che stava qui prima pretendeva la banda verde alta 30 mm e il logo a
    // 14 / 7,5. Era giusta finché il foglio nasceva bianco; sulla carta vera quella banda
    // COPRE il marchio della scuola e quel logo ne stampa un secondo sopra il primo.
    const pdf = buildPrestampatoPdf(documento())

    expect(await immaginiDisegnate(pdf)).toHaveLength(0)

    const bande = (await ingombriPercorsi(pdf)).filter(
      (i) => i.altezzaMm > 25 && i.larghezzaMm > 200
    )
    expect(bande).toHaveLength(0)
  })

  it('il piede predefinito non esiste più: lo scrive la carta', async () => {
    // «Documento generato dal registro elettronico Kidville» cadeva a y=287, cioè dentro
    // il piede a quattro colonne stampato sull'asset (272,1→285,0). La carta porta la
    // ragione sociale e le tre sedi: l'app lì sotto non ha più niente da aggiungere.
    const testo = await estraiTesto(buildPrestampatoPdf(documento()))
    expect(testo).not.toContain('Documento generato dal registro elettronico')
  })

  it('nessun elemento entra nella fascia del marchio né in quella del piede', async () => {
    // Il lock vero di tutto questo lavoro, e vale su OGNI pagina: sopra 26,8 mm c'è il
    // marchio della scuola, sotto 272,1 il piede a quattro colonne. Sono territorio
    // dell'asset, e ciò che ci finisce sopra non «sta stretto»: ci si stampa sopra.
    const pdf = buildPrestampatoPdf(
      documento({
        titolo: 'RICHIESTA DI PERMESSO — ENTRATA POSTICIPATA / USCITA ANTICIPATA',
        protocollo: 'Prot. n. 0000123/2026 del 13/08/2026',
        piePagina: 'Riservato — dati di minori · 13/08/2026 · Nome Cognome Inventato',
        blocchi: [...Object.values(UNO_PER_TIPO), ...riempimento(40)],
        firma: { tipo: 'legaleRappresentante', nome: 'Nome Cognome Inventato' },
        verifica: {
          numeroProtocollo: '0000123/2026',
          dataProtocollo: '13/08/2026',
          indirizzoVerifica: 'esempio.invalid/verifica',
        },
      })
    )

    const elementi = await elementiTesto(pdf)
    expect(await numeroPagine(pdf)).toBeGreaterThan(2)
    for (const el of elementi) {
      expect(el.yMm, `«${el.testo}» a y=${el.yMm.toFixed(1)}`).toBeGreaterThan(CARTA.brandFine)
      expect(el.yMm, `«${el.testo}» a y=${el.yMm.toFixed(1)}`).toBeLessThan(CARTA.piedeInizio)
    }

    // E nemmeno le CORNICI, che il testo estratto non racconta: riquadri, filetti, caselle.
    for (const i of await ingombriPercorsi(pdf)) {
      expect(i.yMm, `cornice a y=${i.yMm.toFixed(1)}`).toBeGreaterThan(CARTA.brandFine)
      expect(
        i.yMm + i.altezzaMm,
        `cornice fino a y=${(i.yMm + i.altezzaMm).toFixed(1)}`
      ).toBeLessThan(CARTA.piedeInizio)
    }
  })

  it('degrada senza intestazione di sede, e non stampa mai «undefined» al posto di un dato', async () => {
    const pdf = buildPrestampatoPdf(
      documento({
        intestazione: [],
        blocchi: [
          { tipo: 'campi', campi: [{ etichetta: 'Pediatra' }, { etichetta: 'ASL', valore: null }] },
        ],
      })
    )
    const testo = await estraiTesto(pdf)
    expect(testo).toContain('MODULO DI PROVA')
    expect(testo).toContain('Pediatra:')
    expect(testo).toContain('ASL:')
    expect(testo).not.toContain('undefined')
    expect(testo).not.toContain('null')
  })

  it('il corpo comincia a x=22 mm e nessun testo esce dalla larghezza utile', async () => {
    const pdf = buildPrestampatoPdf(
      documento({
        titolo: 'RICHIESTA DI PERMESSO — ENTRATA POSTICIPATA / USCITA ANTICIPATA',
        protocollo: 'Prot. n. 0000123/2026 del 13/08/2026',
        blocchi: Object.values(UNO_PER_TIPO),
        firma: { tipo: 'legaleRappresentante', nome: 'Nome Cognome Inventato' },
      })
    )

    const elementi = await elementiTesto(pdf)
    expect(elementi.length).toBeGreaterThan(10)
    for (const el of elementi) {
      expect(el.xMm).toBeGreaterThan(21)
      expect(el.xMm + el.larghezzaMm).toBeLessThan(189)
    }

    const paragrafo = elementi.find((el) => el.testo.startsWith('Paragrafo di collaudo'))
    expect(paragrafo?.xMm).toBeCloseTo(22, 1)
  })

  it('impagina ogni tipo di blocco previsto dai modelli', async () => {
    const pdf = buildPrestampatoPdf(documento({ blocchi: Object.values(UNO_PER_TIPO) }))
    const testo = await estraiTesto(pdf)

    expect(testo).toContain('Paragrafo di collaudo del corpo del testo.')
    expect(testo).toContain("DATI DELL'ALUNNO/A") // il maiuscolo lo mette il motore
    expect(testo).toContain('Bianchi')
    expect(testo).toContain('Kidville Due')
    expect(testo).toContain('Seconda voce di elenco')
    expect(testo).toContain('RELAZIONE') // intestazione di tabella
    expect(testo).toContain('Verdi Anna')
    expect(testo).toContain('RISERVATO A SEGRETERIA')
    expect(testo).toContain('Preso in carico il:')
  })

  it('una tabella senza intestazioni stampa lo stesso le sue righe', async () => {
    // Una guardia che uscisse perché manca la testata butterebbe via i dati in silenzio:
    // sul foglio non resterebbe nemmeno il bianco a dire che mancano.
    const pdf = buildPrestampatoPdf(
      documento({
        blocchi: [
          { tipo: 'tabella', intestazioni: [], righe: [['Dato che non deve sparire', 'X']] },
        ],
      })
    )
    const elementi = await elementiTesto(pdf)
    const dato = elementi.find((el) => el.testo.includes('Dato che non deve sparire'))
    const seconda = elementi.find((el) => el.testo === 'X')

    expect(dato).toBeDefined()
    // Il numero di colonne viene dai dati: la seconda cella cade oltre metà larghezza utile.
    expect(seconda).toBeDefined()
    expect(seconda!.xMm).toBeGreaterThan(22 + 166 / 2)
  })
})

describe('buildPrestampatoPdf — più pagine (§2)', () => {
  it('sta su una pagina sola quando il contenuto ci sta, e non numera', async () => {
    const pdf = buildPrestampatoPdf(documento())
    expect(await numeroPagine(pdf)).toBe(1)
    expect(await estraiTesto(pdf)).not.toContain('Pagina 1 di')
  })

  it('cresce di pagine col contenuto, e il piede sta su ognuna', async () => {
    // Il piede lo porta il MODELLO, non più una costante del motore: quello predefinito
    // cadeva dentro il piede stampato sulla carta ed è sparito con esso.
    const PIEDE = 'Riservato — dati di minori · 13/08/2026 · Nome Cognome Inventato'
    const pdf = buildPrestampatoPdf(documento({ blocchi: riempimento(60), piePagina: PIEDE }))

    const pagine = await numeroPagine(pdf)
    expect(pagine).toBeGreaterThan(1)

    const testo = await estraiTesto(pdf)
    expect(occorrenze(testo, PIEDE)).toBe(pagine)
    expect(testo).toContain(`Pagina 1 di ${pagine}`)
    expect(testo).toContain(`Pagina ${pagine} di ${pagine}`)

    // Dalla seconda pagina in poi resta la testata compatta: §2 chiede «l'intestazione
    // della sede in 8 pt e il titolo in corsivo», e l'intestazione è il BLOCCO — indirizzo
    // e codice meccanografico compresi, che sono ciò che dice da quale delle tre sedi
    // arriva il foglio che si sta sfogliando.
    const elementi = await elementiTesto(pdf)
    const secondaPagina = elementi.filter((el) => el.pagina === 2)
    expect(secondaPagina.some((el) => el.testo.includes('MODULO DI PROVA'))).toBe(true)
    for (const riga of INTESTAZIONE) {
      expect(secondaPagina.some((el) => el.testo.includes(riga))).toBe(true)
    }

    // …e non c'è nessuna immagine da nessuna parte: il marchio sta sulla carta, e ci sta
    // su ogni pagina senza che il motore lo ridisegni.
    expect(await immaginiDisegnate(pdf)).toHaveLength(0)
  })

  it('il documento composto regge il timbro di segnatura, che passa dopo', async () => {
    const { applicaSegnatura } = await import('@/lib/protocolli/timbro')
    const pdf = buildPrestampatoPdf(documento({ blocchi: riempimento(60) }))
    const pagine = await numeroPagine(pdf)

    const timbrato = await applicaSegnatura(pdf, {
      righe: ['Scuola dell’Infanzia di Prova', 'Prot. n. 0000123/2026', 'del 13/08/2026'],
    })

    expect(await numeroPagine(timbrato)).toBe(pagine)
    const testo = await estraiTesto(timbrato)
    expect(testo).toContain('Prot. n. 0000123/2026')
    expect(testo).toContain('Capoverso numero 1 ')
    expect(testo).toContain('Capoverso numero 60 ')
  })

  it('una tabella lunga si spezza ripetendo le intestazioni', async () => {
    const righe = Array.from({ length: 45 }, (_, i) => [`Riga ${i + 1}`, 'Nonna', 'CI AB0000000'])
    const pdf = buildPrestampatoPdf(
      documento({
        blocchi: [
          { tipo: 'tabella', intestazioni: ['Cognome e nome', 'Relazione', 'Documento'], righe },
        ],
      })
    )

    expect(await numeroPagine(pdf)).toBeGreaterThan(1)
    const testo = await estraiTesto(pdf)
    expect(occorrenze(testo, 'RELAZIONE')).toBeGreaterThan(1)
    expect(testo).toContain('Riga 45')
  })

  it.each([
    ['dall’inizio della pagina', 0],
    // 185 mm di stacco portano la quota a un passo dal limite del corpo: è l'unica
    // finestra in cui il riquadro comincia in fondo alla pagina, perché un blocco più alto
    // di una pagina intera `preferisciBloccoIntero` non lo sposta — si arrende e lascia la
    // quota dov'è.
    ['quando comincia già in fondo alla pagina', 185],
  ])(
    'un riquadro più lungo di una pagina si spezza invece di uscire dal foglio — %s',
    async (_caso, stacco) => {
      // Trentasei campi sono fuori dall'inviluppo dei diciassette modelli, ma il motore è
      // pubblico: prima di questo lock gli ultimi quattro campi non comparivano AFFATTO nel
      // PDF, e i due precedenti finivano a cavallo del piè di pagina.
      const campi = Array.from({ length: 36 }, (_, i) => ({ etichetta: `Campo ${i + 1}` }))
      const pdf = buildPrestampatoPdf(
        documento({
          blocchi: [
            { tipo: 'spazio', mm: stacco },
            { tipo: 'riquadro', titolo: 'Riservato a segreteria', campi },
          ],
        })
      )

      const testo = await estraiTesto(pdf)
      for (let i = 1; i <= 36; i++) expect(testo).toContain(`Campo ${i}:`)
      // La cornice si chiude e si riapre: il titoletto si ripete come le testate di tabella.
      expect(occorrenze(testo, 'RISERVATO A SEGRETERIA')).toBeGreaterThan(1)

      // Nessun campo e nessuna cornice scendono nell'area riservata alla carta.
      const elementi = await elementiTesto(pdf)
      for (const el of elementi.filter((e) => e.testo.startsWith('Campo '))) {
        expect(el.yMm).toBeLessThan(CARTA.contenutoFine)
      }
      const cornici = (await ingombriPercorsi(pdf)).filter((i) => i.larghezzaMm > 160 && i.altezzaMm > 10)
      expect(cornici.length).toBeGreaterThan(1)
      for (const cornice of cornici) {
        expect(cornice.yMm + cornice.altezzaMm).toBeLessThanOrEqual(
          CARTA.contenutoFine + TOLLERANZA_MM
        )
      }
    }
  )

  it('un’intestazione di tabella che va a capo non finisce sopra il primo dato', async () => {
    // Le sette colonne del certificato di servizio (n. 47) su 166 mm: 23 mm l'una, e
    // «ORDINE DI SCUOLA» a 9 pt non ci sta su una riga sola.
    const pdf = buildPrestampatoPdf(
      documento({
        blocchi: [
          {
            tipo: 'tabella',
            intestazioni: ['Dal', 'Al', 'Qualifica', 'Ordine di scuola', 'Sede', 'Tipo di rapporto', 'Ore settimanali'],
            righe: [['01/09/2024', '30/06/2025', 'Insegnante', 'Infanzia', 'Sede Uno', 'Tempo determinato', '25']],
          },
        ],
      })
    )

    const elementi = await elementiTesto(pdf)
    const testata = elementi.filter((el) => /^[A-Z ]{2,}$/.test(el.testo))
    const ultimaRigaTestata = Math.max(...testata.map((el) => el.yMm))
    const primoDato = elementi.find((el) => el.testo === '01/09/2024')

    // Il titolo va davvero a capo, altrimenti questo test non misura niente.
    expect(testata.some((el) => el.testo === 'ORDINE DI')).toBe(true)
    expect(testata.some((el) => el.testo === 'SCUOLA')).toBe(true)

    // Fra l'ultima riga del titolo e il primo dato ci vuole almeno un'interlinea di
    // tabella: con l'intestazione ad altezza fissa il gap scende a 2,7 mm, cioè la
    // seconda riga del titolo è caduta DENTRO la prima riga di dati.
    const INTERLINEA_TABELLA_MM = 4.2
    expect(primoDato).toBeDefined()
    expect(primoDato!.yMm - ultimaRigaTestata).toBeGreaterThan(INTERLINEA_TABELLA_MM)
  })
})

/**
 * Gli elementi di testo della colonna di firma compresi fra la qualifica e la prima riga
 * della dicitura di legge: è la fascia in cui cade il nome del legale rappresentante, e
 * solo lui. Si filtra sulla colonna destra perché a sinistra, alla stessa quota, c'è il
 * luogo e data.
 */
function nellaFasciaDelNome(elementi: ElementoTesto[]): ElementoTesto[] {
  const qualifica = elementi.find((el) => el.testo.includes('IL LEGALE RAPPRESENTANTE'))
  const dicitura = elementi.find((el) => el.testo.includes('Firma autografa sostituita'))
  if (!qualifica || !dicitura) throw new Error('blocco firma del legale rappresentante non trovato')
  return elementi.filter(
    (el) =>
      el.pagina === qualifica.pagina &&
      el.xMm > 100 &&
      el.yMm > qualifica.yMm + TOLLERANZA_MM &&
      el.yMm < dicitura.yMm - TOLLERANZA_MM
  )
}

describe('buildPrestampatoPdf — blocchi firma (§3)', () => {
  it('il legale rappresentante porta il nome ricevuto e le due righe di legge', async () => {
    const pdf = buildPrestampatoPdf(
      documento({
        titolo: 'CERTIFICATO DI ISCRIZIONE E FREQUENZA',
        firma: { tipo: 'legaleRappresentante', nome: 'Nome Cognome Inventato' },
      })
    )
    const testo = await estraiTesto(pdf)

    expect(testo).toContain('IL LEGALE RAPPRESENTANTE')
    expect(testo).toContain('Nome Cognome Inventato')
    expect(testo).toContain('Firma autografa sostituita a mezzo stampa')
    expect(testo).toContain("ai sensi dell'art. 3, c. 2 D.Lgs n. 39/93")
    // §4.4: le due formule si escludono. Finché non esiste una firma qualificata, questa
    // stringa su un foglio diretto a un ente sarebbe un'affermazione non vera.
    expect(testo.toLowerCase()).not.toContain('firmato digitalmente')

    // Il nome sta fra la qualifica e la dicitura: è la riga che il test qui sotto pretende
    // NON ci sia quando la configurazione non lo porta, e senza questa metà quello non
    // misurerebbe niente.
    const elementi = await elementiTesto(pdf)
    expect(nellaFasciaDelNome(elementi).map((el) => el.testo)).toEqual(['Nome Cognome Inventato'])
  })

  it('senza nome in configurazione non stampa una riga vuota che sembri un nome', async () => {
    const pdf = buildPrestampatoPdf(documento({ firma: { tipo: 'legaleRappresentante', nome: '   ' } }))
    const testo = await estraiTesto(pdf)
    expect(testo).toContain('IL LEGALE RAPPRESENTANTE')
    expect(testo).toContain('Firma autografa sostituita a mezzo stampa')

    // Fra la qualifica e la dicitura non c'è NIENTE: né il nome, né uno spazio, né un
    // filetto da riempire a penna che farebbe sembrare mancante ciò che manca davvero.
    expect(nellaFasciaDelNome(await elementiTesto(pdf))).toEqual([])
  })

  it('la firma del genitore attesta e non chiede una firma a penna', async () => {
    const pdf = buildPrestampatoPdf(
      documento({
        firma: {
          tipo: 'genitore',
          firmatario: 'Maria Bianchi',
          istante: '13/08/2026 alle 10:24:33',
          metodo: 'Firma elettronica avanzata con OTP',
          riferimento: 'FEA-0000-1111',
        },
      })
    )
    const testo = await estraiTesto(pdf)

    expect(testo).toContain('Firmato da Maria Bianchi')
    expect(testo).toContain('Firma elettronica avanzata con OTP')
    expect(testo).toContain('Riferimento firma: FEA-0000-1111')
    // L'orario ha tre gruppi: non è un IPv6 e non deve essere ripulito.
    expect(testo).toContain('10:24:33')
    expect(testo.toLowerCase()).not.toContain('firmato digitalmente')
  })

  it('nel riquadro del genitore non finiscono MAI email né indirizzo IP', async () => {
    // Il chiamante sbaglia come sbaglierebbe davvero: `buildReceiptPdf` formatta il
    // firmatario come «Nome <email>», e quella stringa è a portata di copia-incolla.
    const pdf = buildPrestampatoPdf(
      documento({
        firma: {
          tipo: 'genitore',
          firmatario: 'Maria Bianchi <maria.bianchi@example.invalid>',
          istante: '13/08/2026 alle 10:24',
          metodo: 'OTP verificato da 203.0.113.42',
          riferimento: 'FEA-0000-1111',
        },
      })
    )
    const testo = await estraiTesto(pdf)

    expect(testo).toContain('Maria Bianchi')
    expect(testo).not.toContain('@')
    expect(testo).not.toContain('example.invalid')
    expect(testo).not.toContain('203.0.113.42')
    expect(testo).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
  })

  it.each([
    ['contenuto corto (la firma viene spinta in giù)', 1],
    ['contenuto medio (la firma sta dove è arrivata)', 12],
    ['contenuto che trabocca di pagina', 40],
  ])('il blocco firma cade fra y=150 e y=240 — %s', async (_caso, capoversi) => {
    const pdf = buildPrestampatoPdf(
      documento({
        blocchi: riempimento(capoversi),
        firma: { tipo: 'legaleRappresentante', nome: 'Nome Cognome Inventato' },
      })
    )
    const elementi = await elementiTesto(pdf)
    const qualifica = elementi.find((el) => el.testo.includes('IL LEGALE RAPPRESENTANTE'))

    expect(qualifica).toBeDefined()
    expect(qualifica!.yMm).toBeGreaterThanOrEqual(150 - TOLLERANZA_MM)
    expect(qualifica!.yMm).toBeLessThanOrEqual(240 + TOLLERANZA_MM)
  })

  it('quando il contenuto trabocca, la firma va sulla pagina nuova invece di scendere sotto il piede', async () => {
    const pdf = buildPrestampatoPdf(
      documento({
        blocchi: riempimento(40),
        firma: { tipo: 'legaleRappresentante', nome: 'Nome Cognome Inventato' },
      })
    )
    const elementi = await elementiTesto(pdf)
    const qualifica = elementi.find((el) => el.testo.includes('IL LEGALE RAPPRESENTANTE'))

    expect(qualifica!.pagina).toBeGreaterThan(1)
    expect(qualifica!.pagina).toBe(await numeroPagine(pdf))
  })
})

describe('buildPrestampatoPdf — protocollo e verifica (§4)', () => {
  it('stampa la riga di protocollo solo quando c’è', async () => {
    const conProtocollo = buildPrestampatoPdf(
      documento({ protocollo: 'Prot. n. 0000123/2026 del 13/08/2026' })
    )
    expect(await estraiTesto(conProtocollo)).toContain('Prot. n. 0000123/2026 del 13/08/2026')

    const senza = buildPrestampatoPdf(documento())
    expect(await estraiTesto(senza)).not.toContain('Prot. n.')
  })

  it('la copia self-service dichiara di non essere protocollata', async () => {
    const pdf = buildPrestampatoPdf(
      documento({ protocollo: 'Copia a uso della famiglia — non protocollata' })
    )
    const testo = await estraiTesto(pdf)
    expect(testo).toContain('Copia a uso della famiglia')
    expect(testo).not.toContain('Prot. n.')
  })

  it('il riquadro di verifica rimanda al protocollo e NON stampa l’impronta', async () => {
    const pdf = buildPrestampatoPdf(
      documento({
        titolo: 'CERTIFICATO DI ISCRIZIONE E FREQUENZA',
        protocollo: 'Prot. n. 0000123/2026 del 13/08/2026',
        firma: { tipo: 'legaleRappresentante', nome: 'Nome Cognome Inventato' },
        verifica: {
          numeroProtocollo: '0000123/2026',
          dataProtocollo: '13/08/2026',
          indirizzoVerifica: 'esempio.invalid/verifica',
        },
      })
    )
    const testo = await estraiTesto(pdf)

    expect(testo).toContain('registrato al protocollo n. 0000123/2026')
    expect(testo).toContain('registrata nel registro di protocollo')
    expect(testo).toContain('esempio.invalid/verifica')
    // Un'impronta scritta dentro il PDF cambierebbe i byte di cui è l'impronta: nessuna
    // sequenza esadecimale da 64 caratteri deve comparire sul foglio.
    expect(testo).not.toMatch(/[0-9a-f]{64}/i)
  })

  it('col riquadro di verifica la firma non ci finisce sopra', async () => {
    const pdf = buildPrestampatoPdf(
      documento({
        firma: {
          tipo: 'genitore',
          firmatario: 'Maria Bianchi',
          istante: '13/08/2026 alle 10:24',
          metodo: 'Firma elettronica avanzata con OTP',
          riferimento: 'FEA-0000-1111',
        },
        verifica: {
          numeroProtocollo: '0000124/2026',
          dataProtocollo: '13/08/2026',
          indirizzoVerifica: 'esempio.invalid/verifica',
        },
      })
    )
    const elementi = await elementiTesto(pdf)
    const ultimaRigaFirma = elementi.find((el) => el.testo.includes('Riferimento firma'))
    const primaRigaVerifica = elementi.find((el) => el.testo.includes('registrato al protocollo'))

    expect(ultimaRigaFirma).toBeDefined()
    expect(primaRigaVerifica).toBeDefined()
    expect(ultimaRigaFirma!.pagina).toBe(primaRigaVerifica!.pagina)
    expect(ultimaRigaFirma!.yMm).toBeLessThan(primaRigaVerifica!.yMm)
  })

  it('le CORNICI di firma e verifica non si toccano mai, per quanto lunga sia l’attestazione', async () => {
    // Il difetto vero non stava fra due righe di testo ma fra due cornici: la guardia
    // decideva la quota su un'altezza STIMATA (30 mm) mentre il riquadro veniva disegnato
    // alto quanto le sue righe — e con un firmatario e un metodo scritti per esteso (come
    // li formatta `buildReceiptPdf`) le righe diventano otto. Si spazza la quota di
    // partenza millimetro per millimetro perché la finestra in cui il difetto compariva
    // era stretta: un millimetro in più faceva scattare la pagina nuova e sparire tutto.
    for (let spazio = 120; spazio <= 140; spazio++) {
      const pdf = buildPrestampatoPdf(
        documento({
          blocchi: [{ tipo: 'paragrafo', testo: 'Corpo breve.' }, { tipo: 'spazio', mm: spazio }],
          firma: {
            tipo: 'genitore',
            firmatario: 'Maria Alessandra Carolina Bianchi Di Prova Con Nome Assai Lungo',
            istante: 'in data 13 agosto 2026 alle ore 10:24:33 (fuso orario Europe/Rome)',
            metodo:
              'Firma elettronica avanzata con codice OTP inviato via SMS al numero registrato e verificato',
            riferimento: 'FEA-0000-1111-2222-3333-4444-5555-6666',
          },
          verifica: {
            numeroProtocollo: '0000124/2026',
            dataProtocollo: '13/08/2026',
            indirizzoVerifica: 'esempio.invalid/verifica',
          },
        })
      )

      const ingombri = await ingombriPercorsi(pdf)
      const ultima = await numeroPagine(pdf)
      const cornice = ingombri.find(
        (i) => i.pagina === ultima && Math.abs(i.xMm - 118) < 1 && i.altezzaMm > 5
      )
      const verifica = ingombri.find(
        (i) =>
          i.pagina === ultima &&
          i.larghezzaMm > 160 &&
          Math.abs(i.yMm + i.altezzaMm - FONDO_RIQUADRO_VERIFICA_MM) < 1
      )

      expect(cornice, `riquadro di firma assente a spazio=${spazio}`).toBeDefined()
      expect(verifica, `riquadro di verifica assente a spazio=${spazio}`).toBeDefined()
      // Le cornici, non le righe: il bordo BASSO della firma sta sopra il bordo ALTO
      // della verifica, e sopra davvero — non «di un pelo».
      expect(
        cornice!.yMm + cornice!.altezzaMm,
        `cornici accavallate a spazio=${spazio}`
      ).toBeLessThan(verifica!.yMm)

      // E il riquadro resta nella pagina: sopra il piede STAMPATO sulla carta.
      expect(cornice!.yMm + cornice!.altezzaMm).toBeLessThan(CARTA.piedeInizio)
    }
  })
})
