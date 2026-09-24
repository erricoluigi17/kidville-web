// @vitest-environment node
import { describe, it, expect } from 'vitest'

/**
 * Gli avvisi della coda fatture (consegna 2c, §3 e §4.3 del piano): cosa dicono e a chi.
 *
 * Il modulo è puro: riceve i fatti che `fatture_coda_avvisi_prendi` ha appena segnato e
 * compone le notifiche. Sotto prova: le categorie dei codici d'esito, gli orari Europe/Rome
 * («alle», «dopo le», «domani», il giorno della settimana), i testi ESATTI di §3.1, gli errori
 * ripiegati nell'avviso di fine, gli admin che non contano le proprie voci, i destinatari senza
 * doppioni e senza chi ha premuto, e una sonda che nessun testo porti un codice, un uuid o
 * un valore mancante (decisione 21: mai nomi, mai dati di una voce).
 *
 * Gli uuid sono finti: il repository è pubblico.
 */

import {
  LINK_CODA_FATTURE,
  TIPI_AVVISO_CODA,
  CODICI_DA_VERIFICARE,
  CODICI_ANOMALIA,
  categoria,
  quando,
  zFattiCoda,
  componiAvvisi,
  type FattiCoda,
  type AvvisoCoda,
} from '@/lib/fatture-coda/avvisi-testi'
import { CODICI_ESITO_CODA } from '@/lib/fatture-coda/giro'
import { TIPI_NOTIFICA } from '@/lib/notifiche/tipi'
import { CODA_FATTURE_HREF } from '@/components/features/admin/admin-nav-config'

const ADESSO = new Date('2026-09-24T21:30:00Z') // 23:30 a Roma
const ACCODATA = '2026-09-24T08:05:00Z' // «alle 10:05»

const U1 = '00000000-0000-4000-8000-000000000001'
const U2 = '00000000-0000-4000-8000-000000000002'
const A1 = '00000000-0000-4000-8000-0000000000a1'
const A2 = '00000000-0000-4000-8000-0000000000a2'
const ADMIN_A = '00000000-0000-4000-8000-00000000000a'
const ADMIN_B = '00000000-0000-4000-8000-00000000000b'
const G1 = '00000000-0000-4000-8000-000000000b01'
const G2 = '00000000-0000-4000-8000-000000000b02'
const G3 = '00000000-0000-4000-8000-000000000b03'

const vuoti = (): FattiCoda => ({ errori: [], fini: [], pausa: null, sospensione: null, in_attesa: [] })

const fine = (voci: number, emesse: number, errori: Record<string, number> = {}, tolte = 0) => ({
  gruppo_id: G1,
  creato_da: U1,
  accodata_il: ACCODATA,
  voci,
  emesse,
  tolte,
  errori,
})

const soloTipo = (avvisi: AvvisoCoda[], tipo: string) => avvisi.filter((a) => a.tipo === tipo)

const RIMETTI = 'correggi e premi «Rimetti in coda».'

describe('categoria (caso 1)', () => {
  it('«da verificare», «anomalia», e ogni altro codice «da correggere»', () => {
    expect(categoria('esito_incerto')).toBe('da_verificare')
    expect(categoria('trasporto_da_verificare')).toBe('da_verificare')
    expect(categoria('partita_non_registrata')).toBe('anomalia')
    expect(categoria('scarto_aruba')).toBe('da_correggere')
    expect(categoria('non_saldato')).toBe('da_correggere')
    expect(categoria('codice_mai_visto')).toBe('da_correggere')
  })

  it('ogni codice del nucleo ha una categoria, e le due liste ne sono sottoinsiemi A RUNTIME', () => {
    // Lo spread di un Set in `CODICI_ESITO_CODA` rende `string` il tipo degli elementi: il
    // `satisfies` del modulo non controlla niente, lo controlla questo test.
    const codici = CODICI_ESITO_CODA as readonly string[]
    expect(codici.length).toBeGreaterThan(0)
    for (const c of codici) expect(['da_correggere', 'da_verificare', 'anomalia']).toContain(categoria(c))
    for (const c of CODICI_DA_VERIFICARE) expect(codici).toContain(c)
    for (const c of CODICI_ANOMALIA) expect(codici).toContain(c)
  })
})

describe('quando (caso 2)', () => {
  it('«alle», «domani alle», giorno e data; illeggibile → null', () => {
    expect(quando('2026-09-24T21:45:00Z', ADESSO)).toBe('alle 23:45')
    expect(quando('2026-09-24T22:30:00Z', ADESSO)).toBe('domani alle 00:30')
    expect(quando('2026-09-22T08:00:00Z', ADESSO)).toBe('mar 22/09 alle 10:00')
    expect(quando('boh', ADESSO)).toBeNull()
  })

  it('con «dopo le»', () => {
    expect(quando('2026-09-24T21:45:00Z', ADESSO, 'dopo le')).toBe('dopo le 23:45')
    expect(quando('2026-09-24T22:30:00Z', ADESSO, 'dopo le')).toBe('domani dopo le 00:30')
    expect(quando('2026-09-22T08:00:00Z', ADESSO, 'dopo le')).toBe('mar 22/09 dopo le 10:00')
    expect(quando('boh', ADESSO, 'dopo le')).toBeNull()
  })
})

describe('fine di un gruppo di una voce (caso 3)', () => {
  const unica = (g: ReturnType<typeof fine>) => {
    const avvisi = componiAvvisi({ ...vuoti(), fini: [g] }, { adesso: ADESSO, admin: [] })
    expect(avvisi).toHaveLength(1)
    const [a] = avvisi
    expect(a.tipo).toBe('fattura_coda_fine')
    expect(a.destinatari).toEqual([U1])
    expect(a.entitaTipo).toBe('fattura_coda_gruppo')
    expect(a.entitaId).toBe(G1)
    return { titolo: a.titolo, corpo: a.corpo }
  }

  it('emessa', () => {
    expect(unica(fine(1, 1))).toEqual({
      titolo: 'Fattura inviata',
      corpo: 'La fattura messa in coda alle 10:05 è stata inviata.',
    })
  })

  it('da correggere', () => {
    expect(unica(fine(1, 0, { scarto_aruba: 1 }))).toEqual({
      titolo: 'Fattura non inviata',
      corpo: `La fattura messa in coda alle 10:05 non è partita: apri la coda per vedere il motivo, ${RIMETTI}`,
    })
  })

  it('da verificare', () => {
    expect(unica(fine(1, 0, { esito_incerto: 1 }))).toEqual({
      titolo: 'Fattura da verificare',
      corpo:
        'Della fattura messa in coda alle 10:05 non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda.',
    })
  })

  it('anomalia', () => {
    expect(unica(fine(1, 0, { partita_non_registrata: 1 }))).toEqual({
      titolo: 'Fattura da verificare',
      corpo: 'La fattura messa in coda alle 10:05 risulta partita ma non è a registro: va verificata prima di riprovare.',
    })
  })
})

describe('fine di un gruppo di più voci (caso 4)', () => {
  const corpoDi = (g: ReturnType<typeof fine>) => {
    const [a] = componiAvvisi({ ...vuoti(), fini: [g] }, { adesso: ADESSO, admin: [] })
    expect(a.titolo).toBe('Fatture in coda: finito')
    return a.corpo
  }

  it('dieci voci, tre errori di tre categorie: il corpo esatto di §3.1', () => {
    expect(corpoDi(fine(10, 7, { scarto_aruba: 1, esito_incerto: 1, partita_non_registrata: 1 }))).toBe(
      'Il gruppo messo in coda alle 10:05: 7 inviate su 10. ' +
        `1 non è partita: apri la coda per vedere il motivo, ${RIMETTI} ` +
        'Di 1 non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda. ' +
        '1 risulta partita ma non è a registro: va verificata prima di riprovare.',
    )
  })

  it('tre voci, una inviata e due tolte: «inviata» al singolare', () => {
    expect(corpoDi(fine(3, 1, {}, 2))).toBe('Il gruppo messo in coda alle 10:05: 1 inviata su 3. 2 tolte dalla coda.')
  })

  it('dodici voci, errori al plurale e una tolta', () => {
    expect(corpoDi(fine(12, 5, { non_saldato: 3, trasporto_da_verificare: 2, esito_incerto: 1 }, 1))).toBe(
      'Il gruppo messo in coda alle 10:05: 5 inviate su 12. ' +
        `3 non sono partite: apri la coda per vedere i motivi, ${RIMETTI} ` +
        'Di 3 non si sa se sono arrivate ad Aruba: controlla sul pannello Aruba prima di rimetterle in coda. ' +
        '1 tolta dalla coda.',
    )
  })
})

describe('errori ripiegati (caso 5)', () => {
  it('gli errori di un gruppo finito stanno nel suo avviso di fine, non in `fattura_coda_errori`', () => {
    const avvisi = componiAvvisi(
      {
        ...vuoti(),
        fini: [fine(2, 1, { scarto_aruba: 1 })],
        errori: [{ gruppo_id: G1, creato_da: U1, codice: 'scarto_aruba' }],
      },
      { adesso: ADESSO, admin: [] },
    )
    expect(soloTipo(avvisi, 'fattura_coda_errori')).toHaveLength(0)
    expect(soloTipo(avvisi, 'fattura_coda_fine')).toHaveLength(1)
  })

  it('due errori dello stesso accodante in due gruppi aperti: UN avviso con 2', () => {
    const avvisi = componiAvvisi(
      {
        ...vuoti(),
        errori: [
          { gruppo_id: G2, creato_da: U1, codice: 'non_saldato' },
          { gruppo_id: G3, creato_da: U1, codice: 'scarto_aruba' },
        ],
      },
      { adesso: ADESSO, admin: [] },
    )
    const errori = soloTipo(avvisi, 'fattura_coda_errori')
    expect(errori).toHaveLength(1)
    expect(errori[0].destinatari).toEqual([U1])
    expect(errori[0].titolo).toBe('2 fatture non inviate')
    expect(errori[0].corpo).toBe(
      `2 fatture non sono partite: apri la coda per vedere i motivi, ${RIMETTI} Le altre fatture in coda continuano da sole.`,
    )
    expect(errori[0].entitaTipo).toBeNull()
    expect(errori[0].entitaId).toBeNull()
  })
})

describe('titoli di `fattura_coda_errori` (caso 6)', () => {
  const errori = (codici: string[]) =>
    soloTipo(
      componiAvvisi(
        { ...vuoti(), errori: codici.map((codice) => ({ gruppo_id: G2, creato_da: U1, codice })) },
        { adesso: ADESSO, admin: [] },
      ),
      'fattura_coda_errori',
    )

  it('uno da correggere', () => {
    const [a] = errori(['scarto_aruba'])
    expect(a.titolo).toBe('Fattura non inviata')
    expect(a.corpo).toBe(
      `1 fattura non è partita: apri la coda per vedere il motivo, ${RIMETTI} Le altre fatture in coda continuano da sole.`,
    )
  })

  it('tre fra da verificare e anomalia', () => {
    const [a] = errori(['esito_incerto', 'trasporto_da_verificare', 'partita_non_registrata'])
    expect(a.titolo).toBe('3 fatture da verificare')
  })

  it('misti', () => {
    const [a] = errori(['scarto_aruba', 'esito_incerto', 'partita_non_registrata'])
    expect(a.titolo).toBe('3 fatture non inviate')
  })
})

describe('gli admin (caso 7)', () => {
  const erroriMisti: FattiCoda['errori'] = [
    { gruppo_id: G2, creato_da: U1, codice: 'esito_incerto' },
    { gruppo_id: G2, creato_da: ADMIN_A, codice: 'partita_non_registrata' },
    { gruppo_id: G3, creato_da: U2, codice: 'non_saldato' },
  ]

  it('ognuno una volta, senza contare le voci che ha accodato lui', () => {
    const avvisi = componiAvvisi(
      { ...vuoti(), errori: erroriMisti },
      { adesso: ADESSO, admin: [ADMIN_A, ADMIN_B, ADMIN_A] },
    )
    const admin = soloTipo(avvisi, 'fattura_coda_da_verificare')
    const diA = admin.filter((a) => a.destinatari.includes(ADMIN_A))
    const diB = admin.filter((a) => a.destinatari.includes(ADMIN_B))
    expect(diA).toHaveLength(1)
    expect(diA[0].destinatari).toEqual([ADMIN_A])
    expect(diA[0].titolo).toBe('Fattura da verificare')
    expect(diA[0].corpo).toBe(
      'Di 1 fattura non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda.',
    )
    expect(diB).toHaveLength(1)
    expect(diB[0].destinatari).toEqual([ADMIN_B])
    expect(diB[0].titolo).toBe('2 fatture da verificare')
    expect(diB[0].corpo).toBe(
      'Di 1 fattura non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda. ' +
        '1 fattura risulta partita ma non è a registro: va verificata prima di riprovare.',
    )
    expect(admin).toHaveLength(2)
  })

  it('nessun avviso agli admin se gli errori sono tutti da correggere, o se non ci sono admin', () => {
    const daCorreggere = componiAvvisi(
      {
        ...vuoti(),
        errori: [
          { gruppo_id: G2, creato_da: U1, codice: 'scarto_aruba' },
          { gruppo_id: G3, creato_da: U2, codice: 'non_saldato' },
        ],
      },
      { adesso: ADESSO, admin: [ADMIN_A, ADMIN_B] },
    )
    expect(soloTipo(daCorreggere, 'fattura_coda_da_verificare')).toHaveLength(0)

    const senzaAdmin = componiAvvisi({ ...vuoti(), errori: erroriMisti }, { adesso: ADESSO, admin: [] })
    expect(soloTipo(senzaAdmin, 'fattura_coda_da_verificare')).toHaveLength(0)
  })
})

describe('la pausa (caso 8)', () => {
  const PAUSA = { fino_a: '2026-09-24T22:30:00Z' }

  it('a chi ha fatture in attesa e agli admin, senza doppioni, con «dopo le»', () => {
    const avvisi = componiAvvisi(
      { ...vuoti(), pausa: PAUSA, in_attesa: [U1, U1, A1] },
      { adesso: ADESSO, admin: [A1, A2] },
    )
    expect(avvisi).toHaveLength(1)
    const [a] = avvisi
    expect(a.tipo).toBe('fattura_coda_pausa')
    expect(a.destinatari).toEqual([U1, A1, A2])
    expect(a.titolo).toBe('Invio fatture in pausa')
    expect(a.corpo).toBe('Aruba ha chiesto di rallentare: le fatture in coda ripartono da sole domani dopo le 00:30.')
    expect(a.entitaTipo).toBeNull()
    expect(a.entitaId).toBeNull()
  })

  it('nessuno in attesa e nessun admin: nessun avviso', () => {
    expect(componiAvvisi({ ...vuoti(), pausa: PAUSA }, { adesso: ADESSO, admin: [] })).toEqual([])
  })

  it('nessuno in attesa e un admin: l’avviso al solo admin', () => {
    const avvisi = componiAvvisi({ ...vuoti(), pausa: PAUSA }, { adesso: ADESSO, admin: [A2] })
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0].destinatari).toEqual([A2])
  })
})

describe('sospensione e ripresa (caso 9)', () => {
  const SOSPESA_IL = '2026-09-24T19:10:00Z' // «alle 21:10»

  it('la sospesa va a chi attende e agli admin, meno `da` e meno l’attore', () => {
    const avvisi = componiAvvisi(
      { ...vuoti(), sospensione: { evento: 'sospesa', il: SOSPESA_IL, da: A1 }, in_attesa: [U1, A1] },
      { adesso: ADESSO, admin: [A1, A2], attore: A1 },
    )
    expect(avvisi).toHaveLength(1)
    const [a] = avvisi
    expect(a.tipo).toBe('fattura_coda_sospesa')
    expect(a.destinatari).toEqual([U1, A2])
    expect(a.titolo).toBe('Coda fatture sospesa')
    expect(a.corpo).toBe(
      'Un amministratore ha sospeso l’invio alle 21:10: le fatture restano in coda, nello stesso ordine, e ripartono alla ripresa.',
    )
  })

  it('la sospesa vista dal tick (nessun attore): esce comunque chi ha sospeso (`da`)', () => {
    const [a] = componiAvvisi(
      { ...vuoti(), sospensione: { evento: 'sospesa', il: SOSPESA_IL, da: A1 }, in_attesa: [U1, A1] },
      { adesso: ADESSO, admin: [A1, A2] },
    )
    expect(a.destinatari).toEqual([U1, A2])
  })

  it('la ripresa va a chi attende e agli admin, meno l’attore', () => {
    const avvisi = componiAvvisi(
      { ...vuoti(), sospensione: { evento: 'ripresa', il: null, da: null }, in_attesa: [U1] },
      { adesso: ADESSO, admin: [A1, A2], attore: A2 },
    )
    expect(avvisi).toHaveLength(1)
    const [a] = avvisi
    expect(a.tipo).toBe('fattura_coda_ripresa')
    expect(a.destinatari).toEqual([U1, A1])
    expect(a.titolo).toBe('Coda fatture ripresa')
    expect(a.corpo).toBe('L’invio delle fatture è ripreso: partono da sole, nell’ordine della coda.')
  })

  it('nessuno rimasto: nessun avviso', () => {
    expect(
      componiAvvisi(
        { ...vuoti(), sospensione: { evento: 'sospesa', il: SOSPESA_IL, da: A1 }, in_attesa: [A1] },
        { adesso: ADESSO, admin: [A1], attore: A1 },
      ),
    ).toEqual([])
    expect(
      componiAvvisi(
        { ...vuoti(), sospensione: { evento: 'ripresa', il: null, da: null } },
        { adesso: ADESSO, admin: [A2], attore: A2 },
      ),
    ).toEqual([])
  })
})

describe('sonda anti-PII (caso 10)', () => {
  it('nessun testo porta un codice, un uuid o un valore mancante', () => {
    const SONDA = 'SENTINELLA-PII'
    const base: FattiCoda = {
      errori: [
        { gruppo_id: G2, creato_da: U1, codice: SONDA },
        { gruppo_id: G3, creato_da: U2, codice: SONDA },
      ],
      fini: [
        { gruppo_id: G1, creato_da: U1, accodata_il: 'boh', voci: 4, emesse: 1, tolte: 1, errori: { [SONDA]: 2 } },
        { gruppo_id: G2, creato_da: U2, accodata_il: 'boh', voci: 1, emesse: 0, tolte: 0, errori: { [SONDA]: 1 } },
      ],
      pausa: { fino_a: 'boh' },
      sospensione: { evento: 'sospesa', il: 'boh', da: A1 },
      in_attesa: [U1, U2],
    }
    const avvisi = [
      ...componiAvvisi(base, { adesso: ADESSO, admin: [A1, A2] }),
      ...componiAvvisi(
        { ...base, sospensione: { evento: 'ripresa', il: 'boh', da: null } },
        { adesso: ADESSO, admin: [A1, A2], attore: A1 },
      ),
    ]
    const tipi = new Set(avvisi.map((a) => a.tipo))
    for (const t of ['fattura_coda_fine', 'fattura_coda_errori', 'fattura_coda_pausa', 'fattura_coda_sospesa', 'fattura_coda_ripresa']) {
      expect(tipi).toContain(t)
    }
    const testi = avvisi.flatMap((a) => [a.titolo, a.corpo])
    for (const t of testi) {
      expect(t).not.toContain('SENTINELLA')
      expect(t).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
      expect(t).not.toMatch(/undefined|NaN|null/)
    }
    // Gli istanti illeggibili hanno la loro parola, non un buco.
    expect(testi.join(' ')).toContain('di recente')
    expect(testi.join(' ')).toContain('fra poco')
    expect(testi.join(' ')).toContain('poco fa')
  })
})

describe('tipi e collegamento (caso 11)', () => {
  it('ogni avviso ha un tipo della coda, e nessuno di quei tipi sta nel catalogo', () => {
    const avvisi = componiAvvisi(
      {
        errori: [
          { gruppo_id: G2, creato_da: U1, codice: 'esito_incerto' },
          { gruppo_id: G3, creato_da: U2, codice: 'scarto_aruba' },
        ],
        fini: [fine(1, 1)],
        pausa: { fino_a: '2026-09-24T22:30:00Z' },
        sospensione: { evento: 'sospesa', il: '2026-09-24T19:10:00Z', da: A1 },
        in_attesa: [U1],
      },
      { adesso: ADESSO, admin: [A1, A2] },
    )
    expect(avvisi.length).toBeGreaterThan(0)
    for (const a of avvisi) expect(TIPI_AVVISO_CODA as readonly string[]).toContain(a.tipo)
    const catalogo = Object.keys(TIPI_NOTIFICA)
    expect(catalogo.length).toBeGreaterThan(0)
    for (const t of TIPI_AVVISO_CODA) expect(catalogo).not.toContain(t)
  })

  it('il collegamento è quello della voce di menu «Coda fatture»', () => {
    expect(LINK_CODA_FATTURE).toBe(CODA_FATTURE_HREF)
  })
})

describe('zFattiCoda (caso 12)', () => {
  const campione = {
    errori: [{ gruppo_id: G2, creato_da: U1, codice: 'esito_incerto' }],
    fini: [
      {
        gruppo_id: G1,
        creato_da: U1,
        accodata_il: ACCODATA,
        voci: 3,
        emesse: 2,
        tolte: 0,
        errori: { scarto_aruba: 1 },
      },
    ],
    pausa: { fino_a: '2026-09-24T22:30:00Z' },
    sospensione: { evento: 'sospesa', il: '2026-09-24T19:10:00Z', da: A1 },
    in_attesa: [U1, A1],
  }

  it('accetta un campione', () => {
    expect(zFattiCoda.safeParse(campione).success).toBe(true)
  })

  it('rifiuta un conteggio negativo, un evento ignoto, `in_attesa` assente', () => {
    expect(zFattiCoda.safeParse({ ...campione, fini: [{ ...campione.fini[0], voci: -1 }] }).success).toBe(false)
    expect(
      zFattiCoda.safeParse({ ...campione, sospensione: { ...campione.sospensione, evento: 'boh' } }).success,
    ).toBe(false)
    const { in_attesa: _via, ...senzaInAttesa } = campione
    void _via
    expect(zFattiCoda.safeParse(senzaInAttesa).success).toBe(false)
  })
})
