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
import {
  elementiTesto,
  immaginiDisegnate,
  ingombriPercorsi,
  numeroPagine,
  sovrapposti,
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

  it('su qualunque lunghezza del corpo, sul foglio della firma c’è anche il documento', async () => {
    for (let n = 1; n <= 70; n++) {
      const elementi = await elementiTesto(documento({ corpo: corpoDi(n) }))
      const utili = elementi.filter((t) => !eRigaDiServizio(t))
      const ultima = Math.max(...utili.map((t) => t.pagina))
      const suUltima = utili.filter((t) => t.pagina === ultima)
      const corpoSuUltima = suUltima.filter((t) => /^Riga di collaudo numero/.test(t.testo))
      expect(
        `${n} righe → p${ultima}: ${
          corpoSuUltima.length > 0
            ? 'porta anche il documento'
            : `SOLO FIRMA (${suUltima.map((t) => t.testo).join(' | ')})`
        }`
      ).toBe(`${n} righe → p${ultima}: porta anche il documento`)
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
