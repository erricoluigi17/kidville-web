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
  FONDO_TABELLA,
  RIGA_SERVIZIO,
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
  piePagina: (n, tot) => `Pagina ${n} di ${tot} — Registro Elettronico Kidville`,
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
})
