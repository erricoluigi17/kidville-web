// @vitest-environment node
/**
 * La ricevuta di firma FEA (DL-001) sulla carta intestata reale.
 *
 * La ricevuta non ha un pulsante nel prodotto — non è stata chiesta (spec §4.4) — e
 * proprio per questo la carta le si applica lo stesso: un generatore che nessuno guarda è
 * quello che diverge per primo, e il giorno in cui qualcuno gli mette un pulsante davanti
 * scopre di avere in mano l'unico PDF dell'app con una banda verde inventata dal codice.
 *
 * ⚠️ **METÀ DI QUESTO FILE MISURA CIÒ CHE NEL FOGLIO NON DEVE ESSERCI.** Fino al
 * 2026-08-16 questi stessi test PRETENDEVANO l'email del firmatario e il suo indirizzo IP
 * dentro il PDF (`expect(testo).toContain('maria@esempio.invalid')`), cioè blindavano il
 * difetto invece del rimedio: la ricevuta è un foglio che esce dall'app, si scarica, si
 * allega e si stampa, e ci finivano due identificativi personali più l'impronta del
 * dispositivo (`Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 …)`). Le asserzioni sono invertite,
 * e non è una perdita di valore probatorio: `computeContentHash()` impasta email e metadati
 * firma DENTRO l'hash stampato sul foglio, e l'audit immutabile resta la fonte.
 *
 * Nessun dato reale: firmatario, hash e indirizzi sono inventati.
 */
import { describe, it, expect } from 'vitest'
import { buildReceiptPdf, buildReceiptPdfSuCarta, computeContentHash } from '@/lib/fea/receipt-pdf'
import type { ReceiptPayload } from '@/lib/fea/types'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'
import { RIGHE_MINIME_IN_CODA } from '@/lib/carta/blocco-finale'
import {
  elementiTesto,
  immaginiDisegnate,
  ingombriPercorsi,
  sovrapposti,
  type ElementoTesto,
} from '../fixtures/misure-pdf'

describe('computeContentHash', () => {
  it('deterministico e indipendente dall\'ordine delle chiavi', () => {
    const a = computeContentHash({ b: 2, a: 1, nested: { y: 2, x: 1 } }, { m: 'OTP_EMAIL' })
    const b = computeContentHash({ a: 1, b: 2, nested: { x: 1, y: 2 } }, { m: 'OTP_EMAIL' })
    expect(a).toBe(b)
    expect(a).toMatch(/^SHA256-[A-F0-9]+$/)
  })

  it('cambia se il documento muta (prova di inattaccabilità)', () => {
    const a = computeContentHash({ voto: 'ottimo' }, {})
    const b = computeContentHash({ voto: 'distinto' }, {})
    expect(a).not.toBe(b)
  })

  it('cambia se i metadati di firma mutano', () => {
    const a = computeContentHash({ x: 1 }, { signed_at: '2026-06-25T10:00:00Z' })
    const b = computeContentHash({ x: 1 }, { signed_at: '2026-06-26T10:00:00Z' })
    expect(a).not.toBe(b)
  })
})

const payload: ReceiptPayload = {
  title: 'Ricevuta di firma — Pagella',
  entitaTipo: 'pagella',
  entitaId: 'e-1',
  schoolName: 'Kidville di Prova',
  signer: { name: 'Maria Bianchi', email: 'maria@esempio.invalid' },
  signature: {
    method: 'OTP_EMAIL',
    provider: 'Firma OTP via email (FES)',
    email: 'maria@esempio.invalid',
    ip: '203.0.113.7',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
    signed_at: '2026-06-25T10:00:00.000Z',
    timestamp: '2026-06-25T10:00:00.000Z',
    hash: 'SHA256-ABC',
    compliance: 'CAD Art. 20 / DPR 445/2000',
  },
  documentPayload: { scrutinio: 's-1', alunno: 'a-1' },
}

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
const eRigaDiServizio = (t: { yMm: number }) => Math.abs(t.yMm - CARTA.rigaServizio) < 0.1

/**
 * Quante righe di contenuto devono scendere sull'ultimo foglio insieme alla nota.
 *
 * ⚠️ **Numero LETTERALE di proposito, e non `RIGHE_MINIME_IN_CODA`.** Un lock che legge la
 * costante che sorveglia diventa verde nel momento in cui qualcuno la abbassa.
 */
const CODA_MINIMA_ATTESA = 3

describe('buildReceiptPdf — il contenuto', () => {
  it('produce un Buffer PDF non vuoto che inizia con %PDF', () => {
    const buf = buildReceiptPdf(payload)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(200)
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF')
  })

  it('riporta firmatario, metodo, hash e conformità', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(new Uint8Array(buildReceiptPdf(payload)))).replace(/\s+/g, ' ')
    expect(testo).toContain('Maria Bianchi')
    expect(testo).toContain('OTP_EMAIL')
    expect(testo).toContain('SHA256-')
    expect(testo).toContain('CAD Art. 20')
  })
})

describe('buildReceiptPdf — quello che sul foglio NON ci finisce', () => {
  const testoDi = async (p: ReceiptPayload) => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    return (await estraiTesto(new Uint8Array(buildReceiptPdf(p)))).replace(/\s+/g, ' ')
  }

  it("non stampa l'email del firmatario, né l'IP, né il dispositivo da cui ha firmato", async () => {
    const testo = await testoDi(payload)
    expect(testo).not.toContain('@')
    expect(testo).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
    expect(testo).not.toContain('Mozilla/')
    expect(testo.toLowerCase()).not.toContain('user-agent')
    expect(testo.toLowerCase()).not.toContain('indirizzo ip')
  })

  it('un nome che si porti dietro un recapito viene ripulito lo stesso', async () => {
    // Rete di sicurezza, non teoria: la rotta `fea/receipt:GET` costruiva `signer` con la
    // SOLA email e nessun nome, quindi un chiamante che riempia `name` con ciò che ha in
    // mano è lo scenario probabile, non quello improbabile.
    const testo = await testoDi({
      ...payload,
      signer: { name: 'Maria Bianchi <maria@esempio.invalid> 203.0.113.7', email: 'maria@esempio.invalid' },
    })
    expect(testo).toContain('Maria Bianchi')
    expect(testo).not.toContain('@')
    expect(testo).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
  })

  it("l'email resta però DENTRO l'hash documentale: il valore probatorio non si perde", () => {
    const conUna = computeContentHash(payload.documentPayload, {
      method: 'OTP_EMAIL',
      email: 'maria@esempio.invalid',
      signed_at: payload.signature.signed_at,
      hash: payload.signature.hash,
    })
    const conUnAltra = computeContentHash(payload.documentPayload, {
      method: 'OTP_EMAIL',
      email: 'altro@esempio.invalid',
      signed_at: payload.signature.signed_at,
      hash: payload.signature.hash,
    })
    expect(conUna).not.toBe(conUnAltra)
  })
})

describe('buildReceiptPdf — le date', () => {
  it("scrive l'istante della firma all'italiana e nel fuso della scuola, non in ISO UTC", async () => {
    // È l'unico dato che la ricevuta esiste per certificare: QUANDO si è firmato. In ISO
    // UTC («2026-06-25T10:00:00.000Z») chi legge il foglio in mano legge un'ora che non è
    // quella in cui ha firmato — d'estate sono due ore di scarto.
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(new Uint8Array(buildReceiptPdf(payload)))).replace(/\s+/g, ' ')
    expect(testo).toContain('25/06/2026, 12:00')
    expect(testo).not.toContain('2026-06-25T10:00:00.000Z')
    expect(testo).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('anche le firme congiunte portano data e ora leggibili, non il campo grezzo', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const conSlot: ReceiptPayload = {
      ...payload,
      slots: [0, 1].map((i) => ({
        entita_tipo: 'pagella',
        entita_id: 'e-1',
        slot_index: i,
        signer_user_id: null,
        stato: 'signed' as const,
        completion_policy: 'all-required' as const,
        signature_log: null,
        firmato_il: '2026-06-25T10:00:00.000Z',
      })),
    }
    const testo = (await estraiTesto(new Uint8Array(buildReceiptPdf(conSlot)))).replace(/\s+/g, ' ')
    expect(testo).toContain('25/06/2026, 12:00')
    expect(testo).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })
})

describe('buildReceiptPdf — la testata la porta la carta', () => {
  it('non disegna più la banda verde né la barra gialla', async () => {
    const dentro = (await ingombriPercorsi(new Uint8Array(buildReceiptPdf(payload)))).filter((p) =>
      sovrapposti(p, MARCHIO)
    )
    expect(dentro).toEqual([])
  })

  it('non disegna nessuna immagine', async () => {
    expect(await immaginiDisegnate(new Uint8Array(buildReceiptPdf(payload)))).toEqual([])
  })

  it('niente inchiostro dentro il piede stampato sulla carta', async () => {
    const pdf = new Uint8Array(buildReceiptPdf(payload))
    expect((await ingombriPercorsi(pdf)).filter((p) => sovrapposti(p, PIEDE_STAMPATO))).toEqual([])
    const testi = (await elementiTesto(pdf)).filter(
      (t) => ingombroTesto(t.yMm, t.corpoPt).fondo > CARTA.piedeInizio
    )
    expect(testi.map((t) => `${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])
  })

  it('scrive tutto dentro la finestra della carta, margini compresi', async () => {
    const elementi = await elementiTesto(new Uint8Array(buildReceiptPdf(payload)))
    const fuori = elementi
      .filter((t) => !eRigaDiServizio(t))
      .filter((t) => {
        const { cima, fondo } = ingombroTesto(t.yMm, t.corpoPt)
        return (
          cima < CARTA.brandFine ||
          fondo > CARTA.contenutoFine ||
          t.xMm < CARTA.margineSx - 0.05 ||
          t.xMm + t.larghezzaMm > CARTA.margineDx + 0.05
        )
      })
    expect(fuori.map((t) => `${t.testo} @ ${t.yMm.toFixed(1)}/${t.xMm.toFixed(1)}`)).toEqual([])
  })

  it('con molte firme congiunte va a pagina nuova invece di sfondare il piede', async () => {
    const conSlot: ReceiptPayload = {
      ...payload,
      slots: Array.from({ length: 40 }, (_, i) => ({
        entita_tipo: 'pagella',
        entita_id: 'e-1',
        slot_index: i,
        signer_user_id: null,
        stato: i % 2 === 0 ? ('signed' as const) : ('pending' as const),
        completion_policy: 'all-required' as const,
        signature_log: null,
        firmato_il: i % 2 === 0 ? '2026-06-25T10:00:00.000Z' : null,
      })),
    }
    const pdf = new Uint8Array(buildReceiptPdf(conSlot))
    const elementi = await elementiTesto(pdf)
    expect(Math.max(...elementi.map((t) => t.pagina))).toBeGreaterThan(1)
    const fuori = elementi
      .filter((t) => !eRigaDiServizio(t))
      .filter((t) => ingombroTesto(t.yMm, t.corpoPt).fondo > CARTA.contenutoFine)
    expect(fuori.map((t) => `p${t.pagina} ${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])
  })
})

describe('buildReceiptPdf — la testata che va a capo', () => {
  /**
   * ⚠️ **LO STESSO DIFETTO DEL DOCUMENTO PROTOCOLLATO, NELLO STESSO LOTTO.**
   *
   * Denominazione e titolo si stampavano con `maxWidth`, quindi jsPDF li mandava a capo da
   * solo; ma lo stacco fra i due era `y += 9` FISSO, il filetto cadeva a `y + 4` FISSO e il
   * corpo ripartiva con `y += 16` FISSO — tre numeri che valgono solo per una riga a testa.
   * Non è teoria: `schoolName` è la denominazione della sede, e la ragione sociale estesa
   * della cooperativa a 15 pt supera i 166 mm della finestra.
   */
  const DENOMINAZIONE_LUNGA =
    'Kidville Giugliano — Scuola dell’infanzia La Favola società cooperativa sociale a r.l.'
  const TITOLO_LUNGO =
    'Ricevuta di firma elettronica avanzata — Autorizzazione all’uscita didattica e al trasporto'

  const lungo: ReceiptPayload = {
    ...payload,
    schoolName: DENOMINAZIONE_LUNGA,
    title: TITOLO_LUNGO,
  }
  const rigaComeFascia = (t: ElementoTesto) => ({
    xMm: t.xMm,
    yMm: ingombroTesto(t.yMm, t.corpoPt).cima,
    larghezzaMm: t.larghezzaMm,
    altezzaMm: ingombroTesto(t.yMm, t.corpoPt).fondo - ingombroTesto(t.yMm, t.corpoPt).cima,
  })

  it('la testata va a capo davvero (altrimenti il lock non misura niente)', async () => {
    const elementi = await elementiTesto(new Uint8Array(buildReceiptPdf(lungo)))
    expect(elementi.filter((t) => t.corpoPt === 15).length).toBeGreaterThan(1)
    expect(elementi.filter((t) => t.corpoPt === 13).length).toBeGreaterThan(1)
  })

  it('nessuna riga della testata si stampa sopra un’altra', async () => {
    // Solo le righe di testata (15 pt e 13 pt): il corpo ha due celle sulla STESSA quota —
    // etichetta a sinistra e valore a destra — e confrontarle fra loro misurerebbe una
    // sovrapposizione che non esiste. Lo stacco fra testata e corpo è il test dopo.
    const elementi = (await elementiTesto(new Uint8Array(buildReceiptPdf(lungo))))
      .filter((t) => t.corpoPt === 15 || t.corpoPt === 13)
      .sort((a, b) => a.yMm - b.yMm)
    expect(elementi.length).toBeGreaterThan(2)
    for (let k = 1; k < elementi.length; k++) {
      const sopra = ingombroTesto(elementi[k - 1].yMm, elementi[k - 1].corpoPt).fondo
      const sotto = ingombroTesto(elementi[k].yMm, elementi[k].corpoPt).cima
      expect(`«${elementi[k].testo.slice(0, 28)}» comincia a ${sotto.toFixed(2)}`).toBe(
        `«${elementi[k].testo.slice(0, 28)}» comincia a ${Math.max(sotto, sopra).toFixed(2)}`
      )
    }
  })

  it('il corpo non si stampa addosso all’ultima riga di titolo', async () => {
    for (const p of [payload, lungo]) {
      const elementi = await elementiTesto(new Uint8Array(buildReceiptPdf(p)))
      const ultimoTitolo = elementi.filter((t) => t.corpoPt === 13).at(-1)!
      const primaCorpo = elementi.filter((t) => t.corpoPt === 11)[0]
      const fondo = ingombroTesto(ultimoTitolo.yMm, ultimoTitolo.corpoPt).fondo
      const cima = ingombroTesto(primaCorpo.yMm, primaCorpo.corpoPt).cima
      expect(`titolo finisce a ${fondo.toFixed(2)}, corpo comincia a ${cima.toFixed(2)}`).toBe(
        `titolo finisce a ${fondo.toFixed(2)}, corpo comincia a ${Math.max(cima, fondo).toFixed(2)}`
      )
      expect(cima - fondo).toBeGreaterThan(3)
    }
  })

  it('nessun filetto cade dentro l’inchiostro di una riga di testata', async () => {
    for (const p of [payload, lungo]) {
      const pdf = new Uint8Array(buildReceiptPdf(p))
      const percorsi = await ingombriPercorsi(pdf)
      const testata = (await elementiTesto(pdf)).filter((t) => t.corpoPt === 15 || t.corpoPt === 13)
      const barre: string[] = []
      for (const riga of testata) {
        for (const q of percorsi) {
          if (sovrapposti(q, rigaComeFascia(riga))) {
            barre.push(`filetto y=${q.yMm.toFixed(2)} dentro «${riga.testo.slice(0, 28)}»`)
          }
        }
      }
      expect(barre).toEqual([])
    }
  })
})

describe('buildReceiptPdf — nessuna pagina porta la sola nota di chiusura', () => {
  /**
   * ⚠️ **LO STESSO DIFETTO RIPARATO LO STESSO GIORNO SUGLI ALTRI DUE MOTORI.**
   *
   * Il salto di pagina si chiedeva riga per riga, quindi l'ultima riga di contenuto entrava
   * sull'ultimo foglio e la nota «Ricevuta generata automaticamente…» ne apriva un altro:
   * misurato su questo stesso documento, capitava a **16, 17, 48 e 49 firme congiunte**. Un
   * foglio di carta intestata della scuola — marchio, filigrana, le tre sedi — con sopra due
   * righe di boilerplate.
   *
   * La regola non è «la nota non si spezza», è **una pagina non può portare solo la
   * chiusura**: sull'ultima riga di contenuto il conto diventa «ci stanno la riga E la sua
   * nota». Si scandisce un intervallo perché il confine si sposta al primo millimetro che
   * qualcuno tocca.
   */
  const conSlot = (quanti: number): ReceiptPayload => ({
    ...payload,
    slots: Array.from({ length: quanti }, (_, k) => ({
      slot_index: k,
      stato: 'signed',
      firmato_il: '2026-06-25T10:00:00.000Z',
    })) as ReceiptPayload['slots'],
  })

  it('la politica condivisa è ancora quella che questo motore pretende', () => {
    expect(RIGHE_MINIME_IN_CODA).toBe(CODA_MINIMA_ATTESA)
  })

  it('con qualunque numero di firme congiunte, sull’ultimo foglio c’è anche il contenuto', async () => {
    for (let n = 2; n <= 52; n++) {
      const elementi = (await elementiTesto(new Uint8Array(buildReceiptPdf(conSlot(n))))).filter(
        (t) => !/^Pagina \d+ di \d+$/.test(t.testo)
      )
      const ultima = Math.max(...elementi.map((t) => t.pagina))
      const suUltima = elementi.filter((t) => t.pagina === ultima)
      const contenuto = suUltima.filter((t) => !/^Ricevuta generata|^documentale|^immutabile/.test(t.testo))
      // ⚠️ E «almeno una riga» non basta: una riga di slot più due di boilerplate è lo
      // stesso foglio quasi vuoto. La soglia è `RIGHE_MINIME_IN_CODA`, condivisa coi due
      // motori gemelli in `carta/blocco-finale.ts`.
      const attese = Math.min(CODA_MINIMA_ATTESA, n)
      expect(
        `${n} slot → p${ultima}: ${contenuto.length} righe di contenuto` +
          (contenuto.length >= attese ? '' : ` (${suUltima.map((t) => t.testo).join(' | ')})`)
      ).toBe(`${n} slot → p${ultima}: ${Math.max(contenuto.length, attese)} righe di contenuto`)
    }
  })

  it('e la nota non sfonda comunque il limite del contenuto', async () => {
    for (const n of [16, 17, 48, 49]) {
      const fuori = (await elementiTesto(new Uint8Array(buildReceiptPdf(conSlot(n)))))
        .filter((t) => !/^Pagina \d+ di \d+$/.test(t.testo))
        .filter((t) => ingombroTesto(t.yMm, t.corpoPt).fondo > CARTA.contenutoFine)
      expect(fuori.map((t) => `${n} slot: ${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])
    }
  })
})

describe('buildReceiptPdfSuCarta — il foglio consegnato', () => {
  it('porta la carta intestata reale, non un foglio bianco', async () => {
    const pdf = await buildReceiptPdfSuCarta(payload)
    expect(pdf.byteLength).toBeGreaterThan(500_000)
    expect((await ingombriPercorsi(pdf)).length).toBeGreaterThan(50)
  })

  it('non perde il contenuto della ricevuta per strada', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(await buildReceiptPdfSuCarta(payload))).replace(/\s+/g, ' ')
    expect(testo).toContain('Maria Bianchi')
    expect(testo).toContain('CAD Art. 20')
    expect(testo).toContain('25/06/2026, 12:00')
  })

  it('e non porta sulla carta della scuola ciò che dal contenuto è stato tolto', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(await buildReceiptPdfSuCarta(payload))).replace(/\s+/g, ' ')
    expect(testo).not.toContain('@')
    expect(testo).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
    expect(testo).not.toContain('Mozilla/')
  })
})
