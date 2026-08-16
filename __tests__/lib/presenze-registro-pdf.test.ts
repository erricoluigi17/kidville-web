// @vitest-environment node
/**
 * Il registro presenze mensile — l'unico foglio ORIZZONTALE dell'app.
 *
 * ⚠️ **SULL'ORIZZONTALE LE FASCE VIETATE NON SONO DUE FASCE: SONO DUE COLONNE.** La carta
 * è un A4 verticale, e su una pagina 297×210 ci sta solo girata di 90° — cioè il marchio
 * della scuola non è più in cima al foglio ma sul bordo SINISTRO (12,5 → 27,05 mm dal
 * bordo), e il piede a quattro colonne sul bordo DESTRO (272,1 → 285,1). Chi leggesse
 * `CARTA.brandFine` come «i primi 27 mm dall'alto» impaginerebbe benissimo un foglio che
 * non esiste: fra le due colonne restano **245 mm**, non 281, ed è per questo che questo
 * motore non legge `CARTA` a mano ma chiede a `fasceVietate(larghezza, altezza)`.
 *
 * Fino al 2026-08-16 questo PDF si generava NEL BROWSER (`jspdf-autotable` dentro un
 * componente client) e la sua testata era una banda verde a tutta larghezza in cima al
 * foglio: sulla carta cadeva sul marchio. La generazione è passata al server perché
 * l'asset della carta pesa 1,1 MB e non può entrare in un bundle client.
 *
 * Nessun dato reale: alunni e sezione sono inventati.
 */
import { describe, it, expect } from 'vitest'
import {
  buildRegistroPresenzePdf,
  COLONNA_GIORNO_MINIMA,
  COLONNA_NOME,
  FONDO_TABELLA,
  larghezzaColonnaGiorno,
  RIGA_SERVIZIO,
  X_DX,
  X_SX,
  Y_TABELLA,
  type EtichetteRegistro,
  type RigaRegistro,
} from '@/lib/presenze/registro-pdf'
import { fasceVietate, ingombroTesto } from '@/lib/carta/geometria'
import {
  dimensioniPagina,
  elementiTesto,
  immaginiDisegnate,
  ingombriPercorsi,
  numeroPagine,
} from '../fixtures/misure-pdf'

const LARGHEZZA = 297
const ALTEZZA = 210
const { marchio, piede } = fasceVietate(LARGHEZZA, ALTEZZA)

const ETICHETTE: EtichetteRegistro = {
  titolo: 'REGISTRO PRESENZE — MAGGIO 2026',
  meta: 'Sezione: 3 ANNI   |   Esportato il 16/08/2026',
  studente: 'Studente',
  abbrevP: 'P',
  abbrevA: 'A',
  abbrevR: 'R',
  simboli: { presente: 'P', assente: 'A', ritardo: 'R', uscita_anticipata: 'U' },
  giorni: ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'],
  // Il piede dell'app dice SOLO a che pagina siamo: ragione sociale, P.IVA e le tre sedi
  // sono già stampate sulla carta, e il nome del prodotto non è il nome della scuola.
  piePagina: (n, tot) => `Pagina ${n} di ${tot}`,
}

/** Trentun giorni: il mese più lungo, cioè il caso peggiore per la larghezza. */
function giorniDi(anno: number, mese: number): string[] {
  const ultimo = new Date(Date.UTC(anno, mese, 0)).getUTCDate()
  return Array.from(
    { length: ultimo },
    (_, i) => `${anno}-${String(mese).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`
  )
}

function righe(quanti: number, giorni: string[]): RigaRegistro[] {
  return Array.from({ length: quanti }, (_, i) => ({
    cognome: `Cognome${String(i + 1).padStart(2, '0')}`,
    nome: `Nome${i + 1}`,
    giorni: Object.fromEntries(
      giorni.map((g, k) => [g, k % 4 === 0 ? 'assente' : k % 7 === 0 ? 'ritardo' : 'presente'])
    ) as RigaRegistro['giorni'],
    riepilogo: { presenze: 18, assenze: 3, ritardi: 1 },
  }))
}

const GIORNI = giorniDi(2026, 5)

const registro = (quantiAlunni = 12) =>
  buildRegistroPresenzePdf({ giorni: GIORNI, righe: righe(quantiAlunni, GIORNI), etichette: ETICHETTE })

describe('buildRegistroPresenzePdf — il foglio', () => {
  it('è un A4 ORIZZONTALE', async () => {
    const { larghezza, altezza } = await dimensioniPagina(registro())
    expect(larghezza).toBeCloseTo(LARGHEZZA, 1)
    expect(altezza).toBeCloseTo(ALTEZZA, 1)
  })

  it('riporta titolo, alunni e riepilogo', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(registro())).replace(/\s+/g, ' ')
    expect(testo).toContain('REGISTRO PRESENZE')
    expect(testo).toContain('Cognome01')
    expect(testo).toContain('Sezione: 3 ANNI')
  })

  it('non disegna nessuna immagine: il logo ce l’ha la carta', async () => {
    expect(await immaginiDisegnate(registro())).toEqual([])
  })
})

describe('buildRegistroPresenzePdf — le due COLONNE vietate della carta girata', () => {
  it('nessun testo entra nella colonna del marchio né in quella del piede', async () => {
    const fuori = (await elementiTesto(registro(30))).filter(
      (t) =>
        t.xMm < marchio.sinistra + marchio.larghezza ||
        t.xMm + t.larghezzaMm > piede.sinistra
    )
    expect(
      fuori.map((t) => `p${t.pagina} «${t.testo}» x=${t.xMm.toFixed(1)}→${(t.xMm + t.larghezzaMm).toFixed(1)}`)
    ).toEqual([])
  })

  it('nessun filetto e nessun fondo di cella ci entra dentro', async () => {
    const fuori = (await ingombriPercorsi(registro(30))).filter(
      (p) =>
        p.xMm < marchio.sinistra + marchio.larghezza - 0.05 ||
        p.xMm + p.larghezzaMm > piede.sinistra + 0.05
    )
    expect(
      fuori.map((p) => `p${p.pagina} x=${p.xMm.toFixed(1)}→${(p.xMm + p.larghezzaMm).toFixed(1)}`)
    ).toEqual([])
  })

  it('non c’è più la banda verde a tutta larghezza in cima al foglio', async () => {
    // `rect(0, 0, 297, 20)`: attraversava ENTRAMBE le colonne vietate, cioè copriva il
    // marchio della scuola e il piede con la P.IVA.
    const bandeATuttaLarghezza = (await ingombriPercorsi(registro())).filter(
      (p) => p.larghezzaMm > 250
    )
    expect(bandeATuttaLarghezza).toEqual([])
  })

  it('resta comunque dentro il foglio, sopra e sotto', async () => {
    const fuori = (await elementiTesto(registro(30))).filter((t) => {
      const { cima, fondo } = ingombroTesto(t.yMm, t.corpoPt)
      return cima < 0 || fondo > ALTEZZA
    })
    expect(fuori.map((t) => `${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])
  })
})

describe('buildRegistroPresenzePdf — le pagine', () => {
  it('con una sezione numerosa impagina su più fogli, tutti dentro le colonne libere', async () => {
    const molti = registro(60)
    const elementi = await elementiTesto(molti)
    expect(Math.max(...elementi.map((t) => t.pagina))).toBeGreaterThan(1)
    const fuori = elementi.filter(
      (t) => t.xMm < marchio.sinistra + marchio.larghezza || t.xMm + t.larghezzaMm > piede.sinistra
    )
    expect(fuori.map((t) => `p${t.pagina} «${t.testo}»`)).toEqual([])

    // E anche i RIEMPIMENTI e i filetti.
    const percorsiFuori = (await ingombriPercorsi(molti)).filter(
      (p) =>
        p.xMm < marchio.sinistra + marchio.larghezza - 0.05 ||
        p.xMm + p.larghezzaMm > piede.sinistra + 0.05
    )
    expect(
      percorsiFuori.map((p) => `p${p.pagina} x=${p.xMm.toFixed(1)}→${(p.xMm + p.larghezzaMm).toFixed(1)}`)
    ).toEqual([])
  })

  it('numera le pagine, e la numerazione dice quante sono davvero', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(registro(60))).replace(/\s+/g, ' ')
    expect(testo).toMatch(/Pagina 1 di [2-9]/)
  })

  it('non perde per strada nessun alunno', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(registro(60))).replace(/\s+/g, ' ')
    expect(testo).toContain('Cognome01')
    expect(testo).toContain('Cognome60')
  })
})

describe('buildRegistroPresenzePdf — il piede di servizio non cancella la carta', () => {
  /**
   * ⚠️ **LA BANDA BIANCA CHE MANGIAVA LA FILIGRANA.**
   *
   * Fino al 2026-08-16 il piede si scriveva DUE volte: una dentro `didDrawPage`, che non
   * può conoscere il totale delle pagine mentre lo stampa, e una alla fine col totale
   * vero. Per non ritrovarsi due testi sovrapposti, la seconda passata copriva la prima
   * con un rettangolo BIANCO OPACO di 237 × 6 mm — e su carta intestata quel rettangolo
   * non copriva una riga di testo: copriva la CARTA. Misurato a 200 dpi sul documento
   * composto, il grigio della filigrana mascotte (#F4F4F4, valore 244) diventava 255 puro
   * fra 196,9 e 202,9 mm, con le sagome del nastro «KIDVILLE» tagliate di netto.
   *
   * Il rimedio è alla causa: il piede si scrive **solo** nella passata finale, quando il
   * totale è noto — e allora non c'è più niente da coprire.
   *
   * **Perché questo lock misura i PERCORSI e non i pixel.** Nel documento composto la
   * carta è lo strato di FONDO e il contenuto dell'app si stampa sopra: l'unico modo che
   * l'app ha di cancellare la filigrana è disegnarci sopra qualcosa di opaco. «Nessun
   * percorso dell'app sotto la tabella» e «la filigrana sopravvive» sono quindi la stessa
   * affermazione — e questa si misura senza rasterizzare, cioè anche in CI, dove nessun
   * rasterizzatore è installato.
   */
  it('sotto la tabella il motore non disegna NIENTE: solo la riga di testo del piede', async () => {
    const sotto = (await ingombriPercorsi(registro(60))).filter(
      (p) => p.yMm + p.altezzaMm > FONDO_TABELLA + 0.05
    )
    expect(
      sotto.map(
        (p) =>
          `p${p.pagina} x=${p.xMm.toFixed(1)}→${(p.xMm + p.larghezzaMm).toFixed(1)} y=${p.yMm.toFixed(1)}→${(p.yMm + p.altezzaMm).toFixed(1)}`
      )
    ).toEqual([])
  })

  it('e la striscia che quel rettangolo cancellava è carta stampata, non foglio bianco', async () => {
    // Senza questa misura il lock qui sopra sarebbe vacuo: proverebbe che l'app non
    // disegna dove non c'è niente da proteggere. Qui si guarda il documento COMPOSTO e si
    // conta l'inchiostro della carta nella striscia 197 → 203 mm — la filigrana mascotte,
    // che è esattamente ciò che la banda bianca stava cancellando.
    const { applicaCartaIntestata } = await import('@/lib/carta')
    const composto = await applicaCartaIntestata(registro(60))
    const nellaStriscia = (await ingombriPercorsi(composto)).filter(
      (p) => p.yMm + p.altezzaMm > FONDO_TABELLA && p.yMm < RIGA_SERVIZIO + 2
    )
    expect(nellaStriscia.length).toBeGreaterThan(0)
  })

  it('su un foglio solo non scrive «Pagina 1 di 1»', async () => {
    // Gli altri quattro motori toccati da questo lavoro tacciono sotto le due pagine
    // (`if (pagine < 2) return`): il numero di pagina di una pagina sola è rumore su un
    // documento di scuola. Qui la regola era diversa senza che nessuno l'avesse decisa —
    // ed è la doppia manutenzione che questo lavoro esiste per finire.
    const unaSola = registro(8)
    expect(await numeroPagine(unaSola)).toBe(1)
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    expect((await estraiTesto(unaSola)).replace(/\s+/g, ' ')).not.toContain('Pagina')
  })

  it("nel piede l'app non scrive il proprio nome: il marchio è già sulla carta", async () => {
    // ⚠️ Il piede stampato era «Pagina 1 di 2 — Registro Elettronico Kidville», su un
    // foglio la cui carta porta GIÀ ragione sociale, P.IVA e le tre sedi. La spec decide il
    // contrario in due punti: «l'app nel piede NON SCRIVE NULLA» e §1.3 elimina
    // `PIEDE_PREDEFINITO` («Documento generato dal registro elettronico Kidville») perché
    // «la carta lo sostituisce». La frase era sopravvissuta in un motore solo — proprio
    // quello riscritto da capo in W9 — senza che una riga la dichiarasse eccezione. Questo
    // lavoro nasce per togliere il nome inventato dal codice sopra la carta vera:
    // lasciarne uno su cinque è la divergenza da cui riparte.
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(registro(60))).replace(/\s+/g, ' ')
    expect(testo).toMatch(/Pagina 1 di \d/)
    expect(testo).not.toContain('Kidville')
    expect(testo).not.toContain('Registro Elettronico')
  })

  it('e il numero di pagina è allineato a destra, come negli altri quattro motori', async () => {
    const servizio = (await elementiTesto(registro(60))).filter(
      (t) => Math.abs(t.yMm - RIGA_SERVIZIO) < 0.1
    )
    expect(servizio.length).toBeGreaterThan(0)
    for (const riga of servizio) {
      // Tre decimi di millimetro: la larghezza che pdf.js riconsegna è quella del testo
      // reso, non quella con cui jsPDF ha allineato, e le due differiscono di un pelo.
      expect(Math.abs(riga.xMm + riga.larghezzaMm - X_DX)).toBeLessThan(0.3)
    }
  })
})

describe('buildRegistroPresenzePdf — il nome del bambino non si taglia', () => {
  /**
   * ⚠️ **W9 AVEVA STRETTO PROPRIO QUESTA COLONNA, E LA STRETTA SI PAGAVA IN NOMI TAGLIATI.**
   *
   * `COLONNA_NOME` era passata da 42 mm (il vecchio `NAME_COL` del componente browser) a
   * 38, con `overflow: 'hidden'`: troncamento netto a metà parola, senza puntini e senza
   * avviso. I 36 mm di foglio che la carta intestata si prende erano stati fatti pagare
   * anche al nome, e il registro serve a una cosa sola — dire quale bambino era presente.
   *
   * Non era nemmeno necessario: con 42 mm la colonna-giorno resta a 5,61 mm su 31 giorni,
   * sopra il `COLONNA_GIORNO_MINIMA` = 5 che il file stesso dichiara. È il conto che il
   * primo test qui sotto rifà invece di ricopiarlo.
   *
   * Nomi inventati: di reale c'è solo la LUNGHEZZA, che è quella dei cognomi composti e dei
   * doppi nomi con cui un registro italiano ha a che fare tutti i giorni.
   */
  const LUNGHI: RigaRegistro[] = [
    { cognome: 'Dellagiovanna', nome: 'Alessandro', giorni: {}, riepilogo: { presenze: 1, assenze: 0, ritardi: 0 } },
    { cognome: 'Di Bartolomeo', nome: 'Maria Giovanna', giorni: {}, riepilogo: { presenze: 1, assenze: 0, ritardi: 0 } },
    { cognome: 'Santangelo Vitiello', nome: 'Massimiliano', giorni: {}, riepilogo: { presenze: 1, assenze: 0, ritardi: 0 } },
  ]
  const conNomiLunghi = () =>
    buildRegistroPresenzePdf({ giorni: GIORNI, righe: LUNGHI, etichette: ETICHETTE })

  it('la colonna-giorno regge lo stesso a 31 giorni, che è il caso peggiore', () => {
    expect(larghezzaColonnaGiorno(31)).toBeGreaterThanOrEqual(COLONNA_GIORNO_MINIMA)
    expect(COLONNA_NOME).toBeGreaterThanOrEqual(42)
  })

  it('nessun nome esce dalla colonna…', async () => {
    // Solo le celle della tabella: il titolo comincia alla stessa ascissa e occupa
    // legittimamente tutta la larghezza del foglio.
    const fuori = (await elementiTesto(conNomiLunghi())).filter(
      (t) =>
        t.yMm > Y_TABELLA &&
        t.xMm >= X_SX - 0.05 &&
        t.xMm < X_SX + COLONNA_NOME &&
        t.larghezzaMm > COLONNA_NOME - 2
    )
    expect(fuori.map((t) => `«${t.testo}» larga ${t.larghezzaMm.toFixed(2)} mm`)).toEqual([])
  })

  it('…e nessun nome viene tagliato in silenzio', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(conNomiLunghi())).replace(/\s+/g, ' ')
    for (const riga of LUNGHI) {
      expect(testo).toContain(`${riga.cognome} ${riga.nome}`)
    }
  })
})

describe('buildRegistroPresenzePdf — la testata regge e si ripete', () => {
  /** Un nome di sezione che nessuno ha vincolato: `z.string().default('')`, nessun `max`. */
  const META_LUNGA =
    'Sezione: PRIMAVERA SPERIMENTALE BILINGUE — GRUPPO DEI GRANDI — PLESSO DI VIA DELLE MIMOSE   |   Esportato il 16/08/2026'

  const conMetaLunga = (quanti = 12) =>
    buildRegistroPresenzePdf({
      giorni: GIORNI,
      righe: righe(quanti, GIORNI),
      etichette: { ...ETICHETTE, meta: META_LUNGA },
    })

  /**
   * L'ingombro d'inchiostro di un pezzo di testo, come rettangolo confrontabile.
   *
   * ⚠️ pdf.js spezza una stessa `doc.text()` in più elementi adiacenti: due pezzi che si
   * toccano al bordo NON sono una sovrapposizione, e senza la tolleranza questo lock
   * fallirebbe su ogni riga scritta. Tre decimi di millimetro è meno del tratto di una
   * lettera e più di qualunque arrotondamento.
   */
  const TOLLERANZA = 0.3
  const riquadro = (t: { xMm: number; larghezzaMm: number; yMm: number; corpoPt: number }) => {
    const { cima, fondo } = ingombroTesto(t.yMm, t.corpoPt)
    return { x1: t.xMm, x2: t.xMm + t.larghezzaMm, y1: cima, y2: fondo }
  }
  const siSovrappongono = (a: ReturnType<typeof riquadro>, b: ReturnType<typeof riquadro>) =>
    Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > TOLLERANZA &&
    Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > TOLLERANZA

  it('la riga di contesto non finisce MAI sopra il titolo', async () => {
    // ⚠️ Il titolo aveva `maxWidth`, la meta no: cresceva verso sinistra senza limite e
    // finiva stampata SOPRA «REGISTRO PRESENZE — MAGGIO 2026», entrambe illeggibili. Coi
    // nomi di sezione brevi restavano 30-63 mm d'aria — cioè era latente, non assente, e
    // il margine si consuma con un nome di sezione che nessuno ha vincolato. Misurato con
    // questa meta: il titolo andava da 31,0 a 132,2 mm e la meta cominciava a **66,7**.
    const testata = (await elementiTesto(conMetaLunga())).filter((t) => t.yMm < 24)
    expect(testata.length).toBeGreaterThan(1)
    const scontri: string[] = []
    for (let i = 0; i < testata.length; i++) {
      for (let k = i + 1; k < testata.length; k++) {
        if (siSovrappongono(riquadro(testata[i]), riquadro(testata[k]))) {
          scontri.push(`«${testata[i].testo}» × «${testata[k].testo}»`)
        }
      }
    }
    expect(scontri).toEqual([])
  })

  it('e nessun elemento della testata scende dentro la tabella', async () => {
    const dentro = (await elementiTesto(conMetaLunga())).filter(
      (t) => t.pagina === 1 && t.yMm < 24 && ingombroTesto(t.yMm, t.corpoPt).fondo > 23.5
    )
    expect(dentro.map((t) => `«${t.testo}» @ ${t.yMm.toFixed(1)}`)).toEqual([])
  })

  it('dalla seconda pagina in poi il registro dice ancora che registro sia', async () => {
    // ⚠️ Titolo e meta si disegnavano UNA volta sola, prima di `autoTable`: vivevano solo
    // sulla pagina 1. Dalla seconda restava una griglia di lettere senza nome, senza mese e
    // senza classe — e non è un caso limite, perché la tabella tiene 23 righe per pagina e
    // la sezione più numerosa in produzione ne ha 33: OGNI registro vero è a due fogli.
    const molti = await elementiTesto(registro(60))
    const pagine = Math.max(...molti.map((t) => t.pagina))
    expect(pagine).toBeGreaterThan(1)
    for (let p = 1; p <= pagine; p++) {
      const suQuesta = molti.filter((t) => t.pagina === p)
      expect(`p${p}: ${suQuesta.some((t) => t.testo.includes('REGISTRO PRESENZE')) ? 'titolo' : 'SENZA titolo'}`).toBe(`p${p}: titolo`)
      expect(`p${p}: ${suQuesta.some((t) => t.testo.includes('Sezione:')) ? 'sezione' : 'SENZA sezione'}`).toBe(`p${p}: sezione`)
    }
  })

  it('e dalla seconda pagina la tabella non risale sotto il titolo', async () => {
    // `margin.top` deve valere quanto `startY`: altrimenti dalla seconda pagina autoTable
    // riparte da ~14 mm e la prima riga finisce addosso alla testata appena ristampata.
    const percorsi = (await ingombriPercorsi(registro(60))).filter((p) => p.pagina > 1)
    const piuAlto = Math.min(...percorsi.map((p) => p.yMm))
    expect(piuAlto).toBeGreaterThanOrEqual(23.5)
  })
})
