import { describe, it, expect } from 'vitest'
import { numeroSezionaleDaEtichetta as parserDiClient } from '@/lib/aruba/client'
import {
  PERCORSI_NUMERAZIONE,
  numeroSezionaleDaEtichetta,
  leggiEtichetta,
  formaEtichetta,
  classifica,
  intervalli,
  buchi,
  doppioni,
  allocazioniConContatore,
  attribuisciSalti,
  obiettivoContatore,
  componiAllineamento,
  verificaConfrontoEScambio,
  prospetto,
  argomentiGit,
  deployAttivoAl,
  verdettoP7,
  provaP7,
} from '../../scripts/lib/numerazione-serie.mjs'

/**
 * Le funzioni pure dell'indagine sul salto FPR 2154 → 2516 (D1 §3.3-§4, test 9: parte
 * numerazione e P7). Tutti i dati sono SINTETICI: numeri e istanti ricalcano la
 * cronologia del D1 §2.3, i nomi file sono inventati (`IT00000000000_…`), nessun dato
 * personale. Gli sha e gli istanti dei deploy sono quelli pubblici del repository (§2.6).
 */

type Voce = { serie: string; numero: number; istante: string }

/** Numeri consecutivi `da..a`, a un minuto l'uno dall'altro a partire da `inizio`. */
function sequenza(serie: string, da: number, a: number, inizio: string): Voce[] {
  const t0 = Date.parse(inizio)
  return Array.from({ length: a - da + 1 }, (_, i) => ({
    serie,
    numero: da + i,
    istante: new Date(t0 + i * 60_000).toISOString(),
  }))
}
const una = (serie: string, numero: number, istante: string): Voce => ({ serie, numero, istante })

const fileDi = (serie: string, numero: number) => `IT00000000000_${serie}_${numero}.xml.p7m`
/** Asilo scrive l'anno a 4 cifre, FPR a 2: è così sui documenti trasmessi. */
const etichettaDi = (serie: string, numero: number) => (serie === 'Asilo' ? `Asilo ${numero}/2026` : `FPR ${numero}/26`)

// ─── Cronologia sintetica (D1 §2.3) ─────────────────────────────────────────
const REGISTRO_APP: Voce[] = [
  ...sequenza('FPR', 1940, 1952, '2026-09-07T08:00:00Z'),
  ...sequenza('FPR', 1956, 2153, '2026-09-08T09:00:00Z'), // J0: 1956 alle 09:00
  una('FPR', 2154, '2026-09-17T10:35:00Z'),
  una('FPR', 2516, '2026-09-18T07:45:16Z'), // J1
  ...sequenza('FPR', 2517, 2521, '2026-09-18T08:00:00Z'),
  ...sequenza('FPR', 2526, 2540, '2026-09-21T09:00:00Z'),
  ...sequenza('Asilo', 2500, 2515, '2026-09-17T09:00:00Z'),
  ...sequenza('Asilo', 2516, 2518, '2026-09-18T08:30:00Z'),
  una('Asilo', 2523, '2026-09-18T11:31:00Z'), // J2
  ...sequenza('Asilo', 2524, 2525, '2026-09-18T11:32:00Z'),
  ...sequenza('Asilo', 2528, 2529, '2026-09-21T09:30:00Z'),
  una('Asilo', 2541, '2026-09-21T13:22:00Z'), // J4
  una('Asilo', 2542, '2026-09-22T11:00:00Z'),
  una('Asilo', 2543, '2026-09-22T12:02:13Z'),
]
const ORFANE_APP: Voce[] = [
  una('FPR', 2524, '2026-09-21T08:50:00Z'), // J3
  una('FPR', 2525, '2026-09-21T08:51:00Z'),
  una('FPR', 2541, '2026-09-22T12:10:00Z'),
  una('FPR', 2542, '2026-09-22T12:11:52Z'),
  una('Asilo', 2526, '2026-09-19T09:00:00Z'),
  una('Asilo', 2527, '2026-09-19T09:01:00Z'),
]
/** Documenti nati sul pannello di Aruba, fuori dall'app. 1939 e 2499: lo storico manuale. */
const FUORI_APP: Voce[] = [
  una('FPR', 1939, '2026-09-01T08:00:00Z'),
  una('FPR', 1955, '2026-09-08T08:30:00Z'),
  una('FPR', 2515, '2026-09-17T15:00:00Z'), // in F1
  una('FPR', 2523, '2026-09-20T10:00:00Z'), // in F3
  una('Asilo', 2499, '2026-09-01T08:00:00Z'),
  una('Asilo', 2522, '2026-09-18T10:00:00Z'), // in F2
  una('Asilo', 2540, '2026-09-21T10:00:00Z'), // in F4
]

const aDocumento = (v: Voce) => ({ filename: fileDi(v.serie, v.numero), creato: v.istante, etichetta: etichettaDi(v.serie, v.numero) })

function scenario(fuoriApp: Voce[] = FUORI_APP) {
  const documenti = [...REGISTRO_APP, ...ORFANE_APP, ...fuoriApp].map(aDocumento)
  const registro = REGISTRO_APP.map((v) => ({
    aruba_filename: fileDi(v.serie, v.numero),
    sezionale: v.serie,
    numero: v.numero,
    creato_il: v.istante,
  }))
  const orfane = ORFANE_APP.map((v, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    fattura_aruba_id: fileDi(v.serie, v.numero),
    fattura_emessa_il: v.istante,
  }))
  const esito = classifica({ documenti, registro, giornale: null, orfane, anno: 2026 })
  const allocazioni = allocazioniConContatore([...REGISTRO_APP, ...ORFANE_APP])
  const salti = attribuisciSalti({
    allocazioni,
    fuoriApp: esito.classificati.filter((d) => d.origine === 'fuori-app'),
    anno: 2026,
  })
  return { esito, allocazioni, salti }
}

// ─── Parser ────────────────────────────────────────────────────────────────
describe('parser delle etichette — copia con parità contro client.ts', () => {
  const ETICHETTE: unknown[] = [
    'Asilo 2327/2026', 'FPR 1946/26', 'asilo 12/2026', 'fpr 7/26', 'FPR  1946 / 26', 'FPR 1946 /26',
    'FPR 1946/ 26', ' Asilo\t2327/2026 ', 'FPR 1946/2026', 'Asilo 2327/26', 'FPR 1946/25', 'Asilo 2327/2025',
    'FPR 0/26', 'FPR 000012/26', 'Asilo 1234567890/2026', 'Asilo 123456789/2026', 'Asilo2327/2026',
    'NC 5/2026', 'Asilo 2327-2026', 'Asilo 2327/026', '', '   ', null, undefined, 2327, 'FPR 00/00', 'FPR 5/00',
  ]
  const SERIE_ANNI: [string, number][] = [['Asilo', 2026], ['FPR', 2026], ['Asilo', 2025], ['FPR', 2100], ['NC', 2026], ['FPR', 2005]]

  it('dà lo STESSO risultato di numeroSezionaleDaEtichetta su ogni etichetta, serie e anno', () => {
    let confronti = 0
    for (const e of ETICHETTE) {
      for (const [serie, anno] of SERIE_ANNI) {
        // `client.ts` tipizza la serie come 'Asilo' | 'FPR'; qui si prova anche una serie estranea.
        expect(numeroSezionaleDaEtichetta(e, serie, anno), `${String(e)} · ${serie} · ${anno}`).toBe(
          parserDiClient(e, serie as 'Asilo' | 'FPR', anno),
        )
        confronti++
      }
    }
    expect(confronti).toBe(ETICHETTE.length * SERIE_ANNI.length)
    // Controllo positivo: la batteria contiene sia letture valide sia rifiuti.
    expect(numeroSezionaleDaEtichetta('FPR 1946/26', 'FPR', 2026)).toBe(1946)
    expect(numeroSezionaleDaEtichetta('FPR 1946/26', 'Asilo', 2026)).toBeNull()
  })

  it('leggiEtichetta distingue serie nota, altra serie e illeggibile, e della forma non tiene il contenuto', () => {
    expect(leggiEtichetta('FPR 2515/26')).toEqual({ tipo: 'serie', serie: 'FPR', numero: 2515, anno: 2026 })
    expect(leggiEtichetta('Asilo 2540/2026')).toEqual({ tipo: 'serie', serie: 'Asilo', numero: 2540, anno: 2026 })
    expect(leggiEtichetta('NC 5/2026')).toEqual({ tipo: 'altra-serie', forma: 'XX 9/9999' })
    expect(leggiEtichetta('Nota 12')).toEqual({ tipo: 'illeggibile', forma: 'XXXX 99' })
    expect(leggiEtichetta('FPR 0/26').tipo).toBe('illeggibile')
    expect(formaEtichetta(null)).toBe('(vuota)')
  })
})

// ─── Classificazione, buchi, doppioni ─────────────────────────────────────
describe('classifica', () => {
  it('app (registro), orfana, fuori-app; conta illeggibili, altra serie e altro anno; un filename ripetuto conta una volta', () => {
    const documenti = [
      { filename: 'a.p7m', creato: '2026-09-18T08:00:00Z', etichetta: 'FPR 2517/26' },
      { filename: 'a.p7m', creato: '2026-09-18T08:00:00Z', etichetta: 'FPR 2517/26' }, // sovrapposizione fra pagine
      { filename: 'o.p7m', creato: '2026-09-21T08:50:00Z', etichetta: 'FPR 2524/26' },
      { filename: 'x.p7m', creato: '2026-09-17T15:00:00Z', etichetta: 'FPR 2515/26' },
      { filename: 'i.p7m', creato: '2026-09-17T15:00:00Z', etichetta: 'Nota 12' },
      { filename: 'j.p7m', creato: '2026-09-17T15:00:00Z', etichetta: 'Nota 13' },
      { filename: 'n.p7m', creato: '2026-09-17T15:00:00Z', etichetta: 'NC 5/2026' },
      { filename: 'v.p7m', creato: '2025-12-30T15:00:00Z', etichetta: 'FPR 3000/25' },
    ]
    const registro = [{ aruba_filename: 'a.p7m' }, { aruba_filename: null }]
    const orfane = [{ fattura_aruba_id: 'o.p7m' }, { fattura_aruba_id: null }]
    const r = classifica({ documenti, registro, giornale: null, orfane, anno: 2026 })
    expect(r.classificati.map((d) => [d.filename, d.origine, d.fonte, d.serie, d.numero])).toEqual([
      ['a.p7m', 'app', 'registro', 'FPR', 2517],
      ['o.p7m', 'orfana', null, 'FPR', 2524],
      ['x.p7m', 'fuori-app', null, 'FPR', 2515],
    ])
    expect(r.illeggibili).toBe(2)
    expect(r.formeIllegibili).toEqual([{ forma: 'XXXX 99', casi: 2 }])
    expect(r.altraSerie).toBe(1)
    expect(r.altroAnno).toBe(1)
  })

  it('compreso il giornale della coda: se la tabella esiste un file del giornale è «app»; se manca è fuori-app', () => {
    const documenti = [{ filename: 'g.p7m', creato: '2026-10-01T08:00:00Z', etichetta: 'Asilo 2600/2026' }]
    const giornale = [{ aruba_filename: 'g.p7m' }]
    const con = classifica({ documenti, registro: [], giornale, orfane: [], anno: 2026 })
    expect(con.classificati[0]).toMatchObject({ origine: 'app', fonte: 'giornale' })
    const senza = classifica({ documenti, registro: [], giornale: null, orfane: [], anno: 2026 })
    expect(senza.classificati[0]).toMatchObject({ origine: 'fuori-app', fonte: null })
  })
})

describe('intervalli e buchi', () => {
  it('i numeri assenti dal registro (più orfane) sono quelli del D1 §2.3', () => {
    const fpr = [...REGISTRO_APP, ...ORFANE_APP].filter((v) => v.serie === 'FPR').map((v) => v.numero)
    const asilo = [...REGISTRO_APP, ...ORFANE_APP].filter((v) => v.serie === 'Asilo').map((v) => v.numero)
    expect(buchi(fpr)).toEqual([{ da: 1953, a: 1955 }, { da: 2155, a: 2515 }, { da: 2522, a: 2523 }])
    expect(buchi(asilo)).toEqual([{ da: 2519, a: 2522 }, { da: 2530, a: 2540 }])
  })

  it('con i documenti fuori app i buchi si restringono; `da` parte da un numero dato; insieme vuoto = nessun buco', () => {
    const tutti = [...REGISTRO_APP, ...ORFANE_APP, ...FUORI_APP].filter((v) => v.serie === 'FPR').map((v) => v.numero)
    expect(buchi(tutti)).toEqual([{ da: 1953, a: 1954 }, { da: 2155, a: 2514 }, { da: 2522, a: 2522 }])
    expect(buchi([3, 5], { da: 1 })).toEqual([{ da: 1, a: 2 }, { da: 4, a: 4 }])
    expect(buchi([])).toEqual([])
    expect(intervalli([5, 1, 2, 2, 3, 9])).toEqual([{ da: 1, a: 3 }, { da: 5, a: 5 }, { da: 9, a: 9 }])
  })
})

describe('doppioni (H3)', () => {
  it('nessuno nella cronologia; la stessa serie e numero su due file diversi sì; lo stesso file due volte no', () => {
    const { esito } = scenario()
    expect(doppioni(esito.classificati)).toEqual([])
    const conDoppione = [
      ...esito.classificati,
      { filename: 'IT00000000000_altro.xml.p7m', serie: 'FPR', numero: 2530 },
      { filename: fileDi('Asilo', 2541), serie: 'Asilo', numero: 2541 },
    ]
    expect(doppioni(conDoppione)).toEqual([
      { serie: 'FPR', numero: 2530, filenames: ['IT00000000000_FPR_2530.xml.p7m', 'IT00000000000_altro.xml.p7m'] },
    ])
  })
})

// ─── Attribuzione dei salti ───────────────────────────────────────────────
describe('attribuisciSalti — J0-J4', () => {
  it('ogni salto è SPIEGATO dal documento fuori app n−1, della stessa serie, creato prima', () => {
    const { salti, allocazioni } = scenario()
    // Il contatore di un'allocazione è il massimo dato dall'app prima (orfane comprese).
    expect(allocazioni.find((a) => a.serie === 'FPR' && a.numero === 2526)?.contatore_prima).toBe(2525)
    expect(salti.map((s) => [s.serie, s.contatore_prima, s.numero, s.esito])).toEqual([
      ['FPR', 0, 1940, 'SPIEGATO da FPR 1939/2026'], // primo numero dell'app: pavimento dallo storico
      ['FPR', 1952, 1956, 'SPIEGATO da FPR 1955/2026'], // J0, controllo positivo (P0)
      ['Asilo', 0, 2500, 'SPIEGATO da Asilo 2499/2026'],
      ['FPR', 2154, 2516, 'SPIEGATO da FPR 2515/2026'], // J1 (P1)
      ['Asilo', 2518, 2523, 'SPIEGATO da Asilo 2522/2026'], // J2
      ['FPR', 2521, 2524, 'SPIEGATO da FPR 2523/2026'], // J3
      ['Asilo', 2529, 2541, 'SPIEGATO da Asilo 2540/2026'], // J4
    ])
    expect(salti.every((s) => s.spiegato)).toBe(true)
  })

  it('senza FPR 2515 fuori app, J1 è «SALTO NON SPIEGATO»', () => {
    const { salti } = scenario(FUORI_APP.filter((v) => !(v.serie === 'FPR' && v.numero === 2515)))
    const j1 = salti.find((s) => s.serie === 'FPR' && s.numero === 2516)
    expect(j1).toMatchObject({ spiegato: false, spiegatoDa: null, esito: 'SALTO NON SPIEGATO' })
    expect(salti.filter((s) => !s.spiegato)).toHaveLength(1)
  })

  it('un documento n−1 creato DOPO il salto non lo spiega, e nemmeno uno dell\'altra serie', () => {
    const tardi = FUORI_APP.map((v) => (v.serie === 'FPR' && v.numero === 2515 ? { ...v, istante: '2026-09-18T07:46:00Z' } : v))
    expect(scenario(tardi).salti.find((s) => s.numero === 2516 && s.serie === 'FPR')?.esito).toBe('SALTO NON SPIEGATO')
    const { allocazioni } = scenario()
    const soloAsilo = attribuisciSalti({
      allocazioni,
      fuoriApp: [{ filename: 'IT00000000000_altro.xml.p7m', creato: '2026-09-17T15:00:00Z', serie: 'Asilo', numero: 2515 }],
      anno: 2026,
    })
    expect(soloAsilo.find((s) => s.numero === 2516 && s.serie === 'FPR')?.esito).toBe('SALTO NON SPIEGATO')
  })
})

// ─── Contatore ────────────────────────────────────────────────────────────
describe('obiettivoContatore', () => {
  it('P6 vero: FPR con contatore 2542 = massimo di Aruba → nessuna scrittura', () => {
    expect(obiettivoContatore({ massimoAruba: 2542, massimoRegistro: 2540, massimoGiornale: null, contatore: 2542 })).toEqual({
      obiettivo: 2542, rifiuti: [], scrivere: false, scende: false,
    })
  })

  it('è il massimo dei TRE, giornale compreso (anche un numero bruciato è consumato)', () => {
    const r = obiettivoContatore({ massimoAruba: 2543, massimoRegistro: 2543, massimoGiornale: 2545, contatore: 2543, richiesto: 2545 })
    expect(r).toEqual({ obiettivo: 2545, rifiuti: [], scrivere: true, scende: false })
    // Senza giornale (tabella assente) conta il massimo degli altri due.
    expect(obiettivoContatore({ massimoAruba: 2541, massimoRegistro: 2543, massimoGiornale: null, contatore: 2540 }).obiettivo).toBe(2543)
  })

  it('rifiuta di scendere sotto il giornale, e un --a diverso dall\'obiettivo', () => {
    const sotto = obiettivoContatore({ massimoAruba: 2543, massimoRegistro: 2543, massimoGiornale: 2545, contatore: 2545, richiesto: 2543 })
    expect(sotto.rifiuti).toEqual(['sotto-il-giornale', 'diverso-dall-obiettivo'])
    expect(sotto.scrivere).toBe(false)
    const diverso = obiettivoContatore({ massimoAruba: 2543, massimoRegistro: 2543, massimoGiornale: null, contatore: 2540, richiesto: 2544 })
    expect(diverso.rifiuti).toEqual(['diverso-dall-obiettivo'])
    expect(diverso.scrivere).toBe(false)
    const sottoAruba = obiettivoContatore({ massimoAruba: 2543, massimoRegistro: 2540, massimoGiornale: null, contatore: 2545, richiesto: 2541 })
    expect(sottoAruba.rifiuti).toEqual(['sotto-aruba', 'diverso-dall-obiettivo'])
  })

  it('rifiuta con salti non spiegati, doppioni o dati mancanti (fail-closed)', () => {
    const base = { massimoAruba: 2543, massimoRegistro: 2543, massimoGiornale: null, contatore: 2540, richiesto: 2543 }
    expect(obiettivoContatore({ ...base, saltiNonSpiegati: 1 }).rifiuti).toEqual(['salti-non-spiegati'])
    expect(obiettivoContatore({ ...base, doppioni: 2 }).rifiuti).toEqual(['doppioni'])
    expect(obiettivoContatore({ ...base, massimoAruba: Number.NaN })).toEqual({ obiettivo: null, rifiuti: ['dati-mancanti'], scrivere: false, scende: false })
    // Controllo positivo: gli stessi dati senza ostacoli portano a scrivere.
    expect(obiettivoContatore(base)).toEqual({ obiettivo: 2543, rifiuti: [], scrivere: true, scende: false })
  })

  it('segnala quando l\'obiettivo SCENDE sotto il contatore (numeri consumati senza documento)', () => {
    expect(obiettivoContatore({ massimoAruba: 2543, massimoRegistro: 2543, massimoGiornale: null, contatore: 2545 }).scende).toBe(true)
  })
})

describe('componiAllineamento — confronto-e-scambio (D1 §4.3)', () => {
  const dati = { serie: 'FPR', anno: 2026, letto: 2542, obiettivo: 2545, massimoAruba: 2545, massimoRegistro: 2540 }

  it('l\'UPDATE vale solo col contatore LETTO e senza righe sopra l\'obiettivo; audit di sistema', () => {
    const sql = componiAllineamento({ ...dati, massimoGiornale: 2544, giornaleEsiste: true })
    const piatto = sql.replace(/\s+/g, ' ')
    expect(piatto).toContain("WHERE sezionale = 'FPR' AND anno = 2026 AND ultimo_numero = 2542")
    expect(piatto).toContain('SET ultimo_numero = 2545, aggiornato_il = now()')
    expect(piatto).toContain("NOT EXISTS (SELECT 1 FROM public.fatture_emesse f WHERE f.sezionale = 'FPR' AND f.anno = 2026 AND f.numero > 2545)")
    expect(piatto).toContain("NOT EXISTS (SELECT 1 FROM public.fatture_coda_invii i WHERE i.sezionale = 'FPR' AND i.anno = 2026 AND i.numero > 2545)")
    expect(piatto).toContain("SELECT NULL, 'allineamento_contatore_fatture'")
    expect(piatto).toContain("'massimo_giornale',2544")
    expect(piatto).toContain("'strumento','scripts/numerazione-serie.mjs'")
    expect(verificaConfrontoEScambio(sql, { ...dati, giornaleEsiste: true })).toEqual([])
  })

  it('senza giornale la clausola della coda non c\'è e massimo_giornale è null', () => {
    const sql = componiAllineamento({ ...dati, massimoGiornale: null, giornaleEsiste: false })
    expect(sql).not.toContain('fatture_coda_invii')
    expect(sql).toContain("'massimo_giornale',null")
    expect(verificaConfrontoEScambio(sql, { ...dati, giornaleEsiste: false })).toEqual([])
  })

  it('NEGATIVO: un\'istruzione senza «ultimo_numero = letto» non è a confronto-e-scambio', () => {
    const sql = componiAllineamento({ ...dati, massimoGiornale: null, giornaleEsiste: false })
    const senzaConfronto = sql.replace(' AND ultimo_numero = 2542', '')
    expect(senzaConfronto).not.toBe(sql)
    expect(verificaConfrontoEScambio(senzaConfronto, { ...dati, giornaleEsiste: false })).toEqual(['confronto-letto'])
    const senzaGiornale = componiAllineamento({ ...dati, massimoGiornale: null, giornaleEsiste: false })
    expect(verificaConfrontoEScambio(senzaGiornale, { ...dati, giornaleEsiste: true })).toEqual(['giornale-sopra'])
  })

  it('rifiuta serie fuori lista, numeri non interi e giornale incoerente', () => {
    expect(() => componiAllineamento({ ...dati, serie: "FPR'; drop table x; --", massimoGiornale: null, giornaleEsiste: false })).toThrow(/serie/)
    expect(() => componiAllineamento({ ...dati, letto: 2542.5, massimoGiornale: null, giornaleEsiste: false })).toThrow(/letto/)
    expect(() => componiAllineamento({ ...dati, massimoGiornale: null, giornaleEsiste: true })).toThrow(/incoerente/)
  })
})

describe('prospetto per il commercialista', () => {
  it('per serie: intervalli dell\'app, fuori app con la data, mai usati con l\'istante del salto; niente nomi file', () => {
    const { esito, salti } = scenario()
    const testo = prospetto({ anno: 2026, classificati: esito.classificati, salti })
    expect(testo).toContain('Serie FPR')
    expect(testo).toContain("numeri emessi dall'app: 1940-1952, 1956-2154, 2516-2521, 2524-2542")
    expect(testo).toContain('    2515 del 2026-09-17')
    expect(testo).toContain('    2155-2514 (salto del 2026-09-18T07:45:16Z)')
    expect(testo).toContain('    1953-1954 (salto del 2026-09-08T09:00:00.000Z)')
    expect(testo).toContain('Serie Asilo')
    expect(testo).toContain('    2530-2539 (salto del 2026-09-21T13:22:00Z)')
    expect(testo).not.toMatch(/IT00000000000|p7m|xml/i)
  })
})

// ─── P7 ────────────────────────────────────────────────────────────────────
/** Deploy reali (`gh api …/deployments`, D1 §2.6): production, Production e qualche Preview. */
const DEPLOY_REALI = [
  { sha: '29bb04c7', istante: '2026-09-20T20:56:22Z', ambiente: 'production' },
  { sha: '3078d6f8', istante: '2026-09-20T20:40:50Z', ambiente: 'Preview' },
  { sha: '1aa953f9', istante: '2026-09-20T02:17:23Z', ambiente: 'production' },
  { sha: 'c43d8cf1', istante: '2026-09-19T23:20:23Z', ambiente: 'Production' },
  { sha: '69ee801a', istante: '2026-09-19T22:37:18Z', ambiente: 'Production' },
  { sha: 'f971a966', istante: '2026-09-19T21:55:02Z', ambiente: 'Production' },
  { sha: '905bde8e', istante: '2026-09-19T21:16:05Z', ambiente: 'production' },
  { sha: '18513c4d', istante: '2026-09-19T10:28:58Z', ambiente: 'Production' },
  { sha: 'c6ea0e4e', istante: '2026-09-19T00:27:17Z', ambiente: 'Production' },
  { sha: 'fb5cb389', istante: '2026-09-18T13:52:24Z', ambiente: 'Production' },
  { sha: 'cf5de73b', istante: '2026-09-18T12:31:38Z', ambiente: 'production' },
  { sha: 'e2172fcc', istante: '2026-09-18T11:00:10Z', ambiente: 'Preview' },
  { sha: '500db59b', istante: '2026-09-18T08:26:03Z', ambiente: 'Preview' },
  { sha: '9a30ff67', istante: '2026-09-16T13:42:17Z', ambiente: 'production' },
]
const SALTI_J1_J4 = [
  { istante: '2026-09-18T07:45:16Z' },
  { istante: '2026-09-18T11:31:00Z' },
  { istante: '2026-09-21T08:50:00Z' },
  { istante: '2026-09-21T13:22:00Z' },
]
const ADESSO = '2026-09-23T06:00:00Z'

describe('deployAttivoAl — sui deploy reali del §2.6', () => {
  it('J1 e J2 → 9a30ff67; J3, J4 e «adesso» → 29bb04c7', () => {
    expect(SALTI_J1_J4.map((s) => deployAttivoAl(DEPLOY_REALI, s.istante))).toEqual(['9a30ff67', '9a30ff67', '29bb04c7', '29bb04c7'])
    expect(deployAttivoAl(DEPLOY_REALI, ADESSO)).toBe('29bb04c7')
  })

  it('un deploy vale dal suo istante compreso; le Preview e i deploy senza success non contano; prima di tutti → null', () => {
    expect(deployAttivoAl(DEPLOY_REALI, '2026-09-18T12:31:38Z')).toBe('cf5de73b')
    expect(deployAttivoAl(DEPLOY_REALI, '2026-09-18T12:31:37Z')).toBe('9a30ff67')
    expect(deployAttivoAl(DEPLOY_REALI, '2026-09-20T20:50:00Z')).toBe('1aa953f9') // non la Preview delle 20:40
    expect(deployAttivoAl([...DEPLOY_REALI, { sha: 'deadbeef', istante: null }], ADESSO)).toBe('29bb04c7')
    expect(deployAttivoAl(DEPLOY_REALI, '2026-09-01T00:00:00Z')).toBeNull()
    // L'ordine d'ingresso non conta.
    expect(deployAttivoAl([...DEPLOY_REALI].reverse(), '2026-09-21T08:50:00Z')).toBe('29bb04c7')
  })
})

describe('argomentiGit', () => {
  it('restituisce sempre un ARRAY, coi percorsi come voci separate e rif come riferimento', () => {
    const diff = argomentiGit('diff', { rif: '29bb04c7', da: '9a30ff67' })
    expect(Array.isArray(diff)).toBe(true)
    expect(diff).toEqual(['diff', '--quiet', '9a30ff67', '29bb04c7', '--', ...PERCORSI_NUMERAZIONE])
    expect(argomentiGit('controlloPositivo', { rif: '29bb04c7', ultimoCommit: '9a30ff67' }).slice(0, 4)).toEqual(['diff', '--quiet', '9a30ff67~1', '29bb04c7'])
    expect(argomentiGit('ultimoCommit', { rif: '29bb04c7' }).slice(0, 5)).toEqual(['log', '-1', '--format=%h %cI', '29bb04c7', '--'])
    expect(argomentiGit('esiste', { rif: '29bb04c7' })).toEqual(['cat-file', '-e', '29bb04c7^{commit}'])
    expect(argomentiGit('antenato', { rif: '29bb04c7' })).toEqual(['merge-base', '--is-ancestor', '29bb04c7', 'HEAD'])
  })

  it('HEAD non entra mai in un confronto; riferimenti e percorsi non validi sono rifiutati', () => {
    expect(() => argomentiGit('diff', { rif: 'HEAD', da: '9a30ff67' })).toThrow(/HEAD/)
    expect(() => argomentiGit('diff', { rif: '29bb04c7', da: 'HEAD' })).toThrow(/HEAD/)
    expect(() => argomentiGit('esiste', { rif: '--output=/tmp/x' })).toThrow(/sha/)
    expect(() => argomentiGit('diff', { rif: '29bb04c7', da: '9a30ff67', percorsi: [] })).toThrow(/percorsi/)
    expect(() => argomentiGit('diff', { rif: '29bb04c7', da: '9a30ff67', percorsi: ['--no-index'] })).toThrow(/percorsi/)
  })
})

describe('verdettoP7', () => {
  const base = {
    salti: SALTI_J1_J4,
    deploys: DEPLOY_REALI,
    rif: '29bb04c7',
    antenato: 0,
    diff: { '9a30ff67': 0, '29bb04c7': 0 },
    controlloPositivo: 1,
    ultimoCommit: '9a30ff67 2026-09-16T15:42:11+02:00',
  }

  it('diff a 0 contro rif, controllo positivo a 1, rif antenato → vero, uscita 0', () => {
    const v = verdettoP7(base)
    expect(v).toMatchObject({ vero: true, uscita: 0, motivi: [] })
    expect(v.perSalto.map((s) => s.deploy)).toEqual(['9a30ff67', '9a30ff67', '29bb04c7', '29bb04c7'])
  })

  it('NEGATIVO: controllo positivo a 0 → «prova cieca», falso; e il controllo è obbligatorio', () => {
    expect(verdettoP7({ ...base, controlloPositivo: 0 })).toMatchObject({ vero: false, uscita: 2, motivi: ['prova-cieca'] })
    expect(verdettoP7({ ...base, controlloPositivo: undefined })).toMatchObject({ vero: false, motivi: ['prova-cieca'] })
  })

  it('git log -1 rif vuoto → falso', () => {
    expect(verdettoP7({ ...base, ultimoCommit: '' })).toMatchObject({ vero: false, uscita: 2, motivi: ['ultimo-commit-vuoto'] })
  })

  it('rif non antenato di HEAD → uscita 1', () => {
    expect(verdettoP7({ ...base, antenato: 1 })).toMatchObject({ vero: false, uscita: 1, motivi: ['rif-non-antenato'] })
  })

  it('diff diverso, diff mancante o deploy sconosciuto → falso', () => {
    expect(verdettoP7({ ...base, diff: { '9a30ff67': 1, '29bb04c7': 0 } })).toMatchObject({ vero: false, motivi: ['diff-diverso'] })
    expect(verdettoP7({ ...base, diff: { '29bb04c7': 0 } })).toMatchObject({ vero: false, motivi: ['diff-mancante'] })
    expect(verdettoP7({ ...base, salti: [{ istante: '2026-09-01T00:00:00Z' }] })).toMatchObject({ vero: false, motivi: ['deploy-sconosciuto'] })
    expect(verdettoP7({ ...base, salti: [] })).toMatchObject({ vero: false, motivi: ['nessun-salto'] })
  })

  it('NEGATIVO di §0.2 a: con rif = HEAD il verdetto è falso, qualunque cosa dicano i diff', () => {
    expect(verdettoP7({ ...base, rif: 'HEAD' })).toMatchObject({ vero: false, uscita: 2, motivi: ['confronto-con-head'] })
  })
})

// ─── P7 con un git finto che si comporta come quello vero ─────────────────
type Commit = { sha: string; data: string; file: string[] }

/**
 * Una storia lineare minima. `9a30ff67` è l'ultimo commit che tocca i percorsi P prima
 * di `rif = 29bb04c7`; sul branch (`HEAD`) la PR-D1 modifica di nuovo `emissione.ts`.
 * Il finto risponde come git: `diff --quiet` esce 1 se un file cambiato sta sotto uno
 * dei percorsi, 0 altrimenti — anche quando il «percorso» è una stringa unica che non
 * esiste, ed è esattamente la prova cieca da scoprire.
 */
const STORIA: Commit[] = [
  { sha: '11111111', data: '2026-09-10T10:00:00+02:00', file: ['src/lib/aruba/client.ts'] },
  { sha: '9a30ff67', data: '2026-09-16T15:42:11+02:00', file: ['src/lib/aruba/emissione.ts'] },
  { sha: 'cf5de73b', data: '2026-09-18T14:31:00+02:00', file: ['src/app/admin/page.tsx'] },
  { sha: '1aa953f9', data: '2026-09-20T04:17:00+02:00', file: ['src/lib/pagamenti/riconciliazione.ts'] },
  { sha: '29bb04c7', data: '2026-09-20T22:56:00+02:00', file: ['messages/it/shared.json'] },
  { sha: 'a6a90d9e', data: '2026-09-23T08:00:00+02:00', file: ['docs/superpowers/specs/x.md'] },
  { sha: 'beefcafe', data: '2026-09-23T09:00:00+02:00', file: ['src/lib/aruba/emissione.ts'] }, // PR-D1
]

function gitFinto(storia: Commit[], head: string) {
  const chiamate: string[][] = []
  const indice = (ref: string): number => {
    const m = /^(.*?)(?:~(\d+))?$/.exec(ref)!
    const base = m[1] === 'HEAD' ? head : m[1]
    const i = storia.findIndex((c) => c.sha === base)
    if (i < 0) throw new Error(`riferimento sconosciuto al finto: ${ref}`)
    return i - Number(m[2] ?? 0)
  }
  const tocca = (file: string[], percorsi: string[]) => file.some((f) => percorsi.some((p) => f === p || f.startsWith(`${p}/`)))
  const git = (args: string[]): { codice: number; stdout: string } => {
    chiamate.push(args)
    const trattino = args.indexOf('--')
    const percorsi = trattino >= 0 ? args.slice(trattino + 1) : []
    switch (args[0]) {
      case 'cat-file': {
        const ref = args[2].replace('^{commit}', '')
        return { codice: storia.some((c) => c.sha === ref) ? 0 : 128, stdout: '' }
      }
      case 'merge-base':
        return { codice: indice(args[2]) <= indice(args[3]) ? 0 : 1, stdout: '' }
      case 'log': {
        for (let i = indice(args[trattino - 1]); i >= 0; i--) {
          if (tocca(storia[i].file, percorsi)) return { codice: 0, stdout: `${storia[i].sha} ${storia[i].data}\n` }
        }
        return { codice: 0, stdout: '' }
      }
      case 'diff': {
        const [a, b] = [indice(args[2]), indice(args[3])]
        const cambiati = storia.slice(Math.min(a, b) + 1, Math.max(a, b) + 1).flatMap((c) => c.file)
        return { codice: tocca(cambiati, percorsi) ? 1 : 0, stdout: '' }
      }
      default:
        throw new Error(`comando git inatteso: ${args[0]}`)
    }
  }
  return { git, chiamate }
}

describe('provaP7 — i passi 2-5 con git iniettato', () => {
  it('sul branch della PR-D1: vero, rif = 29bb04c7, ultimo commit 9a30ff67; HEAD solo in merge-base', () => {
    const { git, chiamate } = gitFinto(STORIA, 'beefcafe')
    const esito = provaP7({ git, deploys: DEPLOY_REALI, salti: SALTI_J1_J4, adesso: ADESSO })
    expect(esito).toMatchObject({ vero: true, uscita: 0, motivi: [], rif: '29bb04c7', ultimoCommit: '9a30ff67 2026-09-16T15:42:11+02:00' })
    for (const args of chiamate) {
      expect(Array.isArray(args)).toBe(true)
      if (args[0] !== 'merge-base') expect(args).not.toContain('HEAD')
      const trattino = args.indexOf('--')
      if (trattino >= 0) expect(args.slice(trattino + 1)).toEqual([...PERCORSI_NUMERAZIONE])
    }
    // Il controllo positivo è stato davvero eseguito, e contro rif.
    expect(chiamate).toContainEqual(['diff', '--quiet', '9a30ff67~1', '29bb04c7', '--', ...PERCORSI_NUMERAZIONE])
  })

  it('NEGATIVO: con gli argomenti uniti in una stringa il controllo positivo cade a 0 e la P7 è falsa', () => {
    const { git } = gitFinto(STORIA, 'beefcafe')
    // Com'è in zsh `$P` senza virgolette: i percorsi diventano UN percorso che non esiste.
    const unitiInStringa = (args: string[]) => {
      const t = args.indexOf('--')
      return git(t < 0 ? args : [...args.slice(0, t + 1), args.slice(t + 1).join(' ')])
    }
    const controllo = ['diff', '--quiet', '9a30ff67~1', '29bb04c7', '--']
    expect(git([...controllo, ...PERCORSI_NUMERAZIONE]).codice).toBe(1)
    expect(unitiInStringa([...controllo, ...PERCORSI_NUMERAZIONE]).codice).toBe(0)
    const esito = provaP7({ git: unitiInStringa, deploys: DEPLOY_REALI, salti: SALTI_J1_J4, adesso: ADESSO })
    expect(esito.vero).toBe(false)
    expect(esito.uscita).toBe(2)
    expect(esito.motivi).toContain('prova-cieca')
  })

  it('NEGATIVO di §0.2 a: confrontato con HEAD, con emissione.ts modificato dalla PR-D1, il codice risulta diverso', () => {
    // È il motivo per cui il riferimento è rif: sul branch HEAD contiene la correzione stessa.
    const { git } = gitFinto(STORIA, 'beefcafe')
    const controHead = {
      '9a30ff67': git(['diff', '--quiet', '9a30ff67', 'HEAD', '--', ...PERCORSI_NUMERAZIONE]).codice,
      '29bb04c7': git(['diff', '--quiet', '29bb04c7', 'HEAD', '--', ...PERCORSI_NUMERAZIONE]).codice,
    }
    expect(controHead).toEqual({ '9a30ff67': 1, '29bb04c7': 1 })
    const v = verdettoP7({
      salti: SALTI_J1_J4, deploys: DEPLOY_REALI, rif: '29bb04c7', antenato: 0,
      diff: controHead, controlloPositivo: 1, ultimoCommit: '9a30ff67 2026-09-16T15:42:11+02:00',
    })
    expect(v).toMatchObject({ vero: false, motivi: ['diff-diverso'] })
    // Contro rif, gli stessi deploy hanno i file di P identici.
    expect(git(argomentiGit('diff', { rif: '29bb04c7', da: '9a30ff67' })).codice).toBe(0)
  })

  it('rif non antenato di HEAD (branch vecchio) → uscita 1; rif assente dal clone → uscita 1', () => {
    const vecchio = gitFinto(STORIA, 'cf5de73b')
    expect(provaP7({ git: vecchio.git, deploys: DEPLOY_REALI, salti: SALTI_J1_J4, adesso: ADESSO })).toMatchObject({
      vero: false, uscita: 1, motivi: ['rif-non-antenato'],
    })
    const senzaRif = gitFinto(STORIA.filter((c) => c.sha !== '29bb04c7'), 'beefcafe')
    expect(provaP7({ git: senzaRif.git, deploys: DEPLOY_REALI, salti: SALTI_J1_J4, adesso: ADESSO })).toMatchObject({
      vero: false, uscita: 1, motivi: ['rif-assente'],
    })
    expect(senzaRif.chiamate).toHaveLength(1)
  })
})
