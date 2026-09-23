// @vitest-environment node

/**
 * La CLI delle orfane (`scripts/fatture-orfane.mjs`, D1 §9.1) con dipendenze FINTE che
 * registrano l'ordine delle chiamate: letture DB, guardia, Aruba, scritture, stampe.
 *
 * Lo script scrive righe WORM in produzione. Quello che qui si prova è l'ORDINE:
 *   · tutte le letture da Aruba chiuse prima della prima scrittura;
 *   · «SCRIVO i/N:» stampato, coi dati mascherati, prima di ogni scrittura;
 *   · `--solo` = una scrittura sola, di quel pagamento;
 *   · le guardie (cartella fuori dal repo, vincolo per sede, guardia Aruba, parità dei
 *     predicati, invio della coda) che fermano PRIMA di scrivere.
 *
 * Dati SINTETICI: uuid finti, nomi file finti, codice fiscale palesemente finto. La partita
 * IVA del cedente è quella pubblica della cooperativa (controllo b), non un dato personale.
 *
 * Nessuna rete: `fetch` è un finto che lancia su QUALUNQUE URL (C0-12). Le dipendenze sono
 * finte, quindi nessuna fetch deve partire; se parte, il test fallisce.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFatturaElettronicaXml, type FatturaPAInput } from '@/lib/aruba/fatturapa-xml'
import { formattaNumeroFattura } from '@/lib/fatturazione/sezionale'
import { codiceStatoAruba, mapStatoAruba } from '@/lib/aruba/stato'
import { progressivoInvioFattura } from '@/lib/aruba/emissione'
import {
  PREDICATO_SQL_PARTITA_NON_REGISTRATA,
  fatturaPartitaNonRegistrata,
} from '@/lib/pagamenti/fattura-partita-non-registrata'
import { DA_DECIDERE, PARTITA_IVA_CEDENTE, mascheraCf } from '../../scripts/lib/fatture-orfane.mjs'
import { FermoAruba } from '../../scripts/lib/aruba-lettura.mjs'
import {
  NOME_RAPPORTO,
  USCITA,
  improntaCf,
  leggiArgomenti,
  main,
  progressivoAtteso,
} from '../../scripts/fatture-orfane.mjs'

const RADICE = process.cwd()
const FILE_CLI = join(RADICE, 'scripts/fatture-orfane.mjs')

/* ────────────────────────────────────────────────────────────────────────────
 * Dati finti
 * ──────────────────────────────────────────────────────────────────────────── */

const SEDE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAG = '11111111-1111-4111-8111-111111111111'
const PAG_2 = '22222222-2222-4222-8222-222222222222'
const LOG_ID = '44444444-4444-4444-8444-444444444444'
const LOG_ID_2 = '55555555-5555-4555-8555-555555555555'
const UTENTE = '66666666-6666-4666-8666-666666666666'
const GENITORE = '88888888-8888-4888-8888-888888888888'

const FILE = 'IT03394870616_f1a2b.xml.p7m'
const FILE_2 = 'IT03394870616_c3d4e.xml.p7m'
const CF_FINTO = 'FINTOCODICE00001'
const NOME = 'Nomefinto'
const COGNOME = 'Cognomefinto'

interface Orfana {
  id: string
  file: string
  numero: number
  istante: string
  logId: string
}

const ORFANE: Orfana[] = [
  { id: PAG, file: FILE, numero: 2541, istante: '2026-09-22T12:11:52.000000Z', logId: LOG_ID },
  { id: PAG_2, file: FILE_2, numero: 2542, istante: '2026-09-22T12:15:03.000000Z', logId: LOG_ID_2 },
]

function xmlDi(o: Orfana, sovrascrivi: Partial<FatturaPAInput> = {}): string {
  return buildFatturaElettronicaXml({
    progressivoInvio: progressivoAtteso({ sezionale: 'FPR', numero: o.numero, anno: 2026 }),
    numero: formattaNumeroFattura('FPR', o.numero, 2026),
    data: '2026-09-22',
    cedente: {
      piva: PARTITA_IVA_CEDENTE,
      codiceFiscale: PARTITA_IVA_CEDENTE,
      denominazione: 'Cooperativa di prova',
      regimeFiscale: 'RF01',
      sede: { indirizzo: 'Via Finta 1', cap: '00000', comune: 'Paese Finto', provincia: 'XX', nazione: 'IT' },
    },
    cessionario: {
      codiceFiscale: CF_FINTO,
      nome: NOME,
      cognome: COGNOME,
      sede: { indirizzo: 'Via Inventata 2', cap: '00000', comune: 'Paese Finto', provincia: 'XX', nazione: 'IT' },
    },
    righe: [{ descrizione: 'Retta di prova', prezzoUnitario: 150 }],
    bollo: { importo: 2 },
    pagamento: { dataScadenza: '2026-09-30' },
    ...sovrascrivi,
  })
}

const pagamentoDi = (o: Orfana) => ({
  id: o.id,
  scuola_id: SEDE,
  fattura_stato: 'in_attesa',
  fattura_aruba_id: o.file,
  fattura_emessa_il: o.istante,
  importo: '152.00',
})

const logDi = (o: Orfana) => ({
  id: o.logId,
  messaggio: `Documento ${o.file} partito, riga a registro non scritta (FPR ${o.numero}/26)`,
  utente_id: UTENTE,
  scuola_id: SEDE,
  contesto: {
    campi: { esito: 'registro-vincolo-per-sede' },
    causa: { messaggio: 'duplicate key value violates unique constraint "fatture_emesse_scuola_id_anno_numero_key"' },
  },
})

/* ────────────────────────────────────────────────────────────────────────────
 * Dipendenze finte che registrano l'ordine
 * ──────────────────────────────────────────────────────────────────────────── */

interface Scenario {
  vincoloN?: number
  giornaleEsiste?: boolean
  invii?: string[]
  /** righe di `fatture_emesse` per pagamento (serve alla parità SQL/TS). */
  righe?: Array<{ pagamento_id: string; sdi_stato: number | null; aruba_filename: string | null }>
  /** la guardia nega a questa chiamata (1 = la prima). */
  guardiaNegaAllaChiamata?: number
  xml?: Record<string, string>
}

function crea(scenario: Scenario = {}) {
  const eventi: string[] = []
  const stampe: string[] = []
  const scritture: string[] = []
  const sqlEseguite: string[] = []
  let chiamateGuardia = 0
  const xmlPer: Record<string, string> = {
    [FILE]: xmlDi(ORFANE[0]),
    [FILE_2]: xmlDi(ORFANE[1]),
    ...scenario.xml,
  }

  const risposte: Record<string, () => object[]> = {
    'select-1': () => [{ uno: 1 }],
    vincolo: () => [{ n: scenario.vincoloN ?? 0 }],
    giornale: () => [{ esiste: scenario.giornaleEsiste ?? false }],
    candidati: () => ORFANE.map(pagamentoDi),
    log: () => ORFANE.map(logDi),
    'pagamenti-dei-log': () => ORFANE.map(pagamentoDi),
    righe: () => scenario.righe ?? [],
    invii: () => (scenario.invii ?? []).map((pagamento_id) => ({ pagamento_id })),
    'registro-numeri': () => [],
    origine: () => ORFANE.map((o) => ({ pagamento_id: o.id, origine: null })),
    adulti: () => ORFANE.map((o) => ({
      pagamento_id: o.id,
      adult_id: GENITORE,
      parent_id: GENITORE,
      cf_impronta: improntaCf(CF_FINTO),
      nome: NOME,
      cognome: COGNOME,
    })),
    'genitori-cf': () => [{ id: GENITORE, cf_impronta: improntaCf(CF_FINTO), nome: NOME, cognome: COGNOME }],
    conteggio: () => [{ n: 2 }],
    riconteggio: () => [{ n: 0 }],
  }

  const deps = {
    sql: vi.fn(async (testo: string) => {
      const nome = /^\/\* orfane:([a-z0-9-]+) \*\//.exec(testo)?.[1]
      if (!nome || !risposte[nome]) throw new Error(`lettura non prevista dal finto: ${testo.slice(0, 60)}`)
      eventi.push(`sql:${nome}`)
      sqlEseguite.push(testo)
      return risposte[nome]()
    }),
    scrivi: vi.fn(async (fileSql: string): Promise<object[]> => {
      eventi.push(`scrivi:${basename(fileSql)}`)
      const testo = readFileSync(fileSql, 'utf8')
      expect(statSync(fileSql).mode & 0o777).toBe(0o600)
      scritture.push(testo)
      return [{ registrate: 1, audit: 1, fattura_id: '99999999-0000-4000-8000-000000000001', audit_id: '99999999-0000-4000-8000-000000000002' }]
    }),
    guardia: vi.fn(async () => {
      chiamateGuardia += 1
      eventi.push('guardia')
      if (scenario.guardiaNegaAllaChiamata === chiamateGuardia) {
        return { ok: false, codice: 'attivita-app', messaggio: "L'app ha parlato con Aruba: riprova dopo." }
      }
      return { ok: true, adesso: new Date('2026-09-23T19:10:00Z') }
    }),
    apriAruba: vi.fn(() => ({
      signin: vi.fn(async () => { eventi.push('aruba:signin') }),
      getByFilename: vi.fn(async (f: string) => {
        eventi.push(`aruba:getByFilename:${f}`)
        return { contenuto: Buffer.from(xmlPer[f], 'utf8'), fatture: [{ numero: null, stato: 'Presa in carico', data: null }] }
      }),
      scorriDocumenti: vi.fn(async ({ anno }: { anno: number }) => {
        eventi.push(`aruba:scorri:${anno}`)
        return {
          documenti: ORFANE.map((o) => ({ filename: o.file, fatture: [{ numero: `FPR ${o.numero}/26`, stato: 'Presa in carico', data: '2026-09-22' }] })),
          totale: ORFANE.length,
          pagine: 1,
        }
      }),
    })),
    openssl: vi.fn(() => 'OpenSSL 3.0.0 (finto)'),
    estraiXml: vi.fn((contenuto: Buffer) => contenuto.toString('utf8')),
    validaXsd: vi.fn(async () => ({ valido: true, errori: [], grezzo: '' })),
    moduli: {
      PREDICATO_SQL_PARTITA_NON_REGISTRATA,
      fatturaPartitaNonRegistrata,
      formattaNumeroFattura,
      codiceStatoAruba,
      mapStatoAruba,
    },
    stampa: vi.fn((riga: string) => {
      eventi.push(`stampa:${riga.split('\n')[0]}`)
      stampe.push(riga)
    }),
  }
  return { deps, eventi, stampe, scritture, sqlEseguite }
}

const indici = (eventi: string[], prefisso: string) =>
  eventi.map((e, i) => (e.startsWith(prefisso) ? i : -1)).filter((i) => i >= 0)

const chiamateAruba = (eventi: string[]) => indici(eventi, 'aruba:')
const scrittureDi = (eventi: string[]) => indici(eventi, 'scrivi:')

/* ────────────────────────────────────────────────────────────────────────────
 * Ambiente: cartella fuori dal repo, fetch che lancia
 * ──────────────────────────────────────────────────────────────────────────── */

let out: string

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'orfane-cli-'))
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    throw new Error(`fetch NON PREVISTA nei test della CLI: ${String(url)}`)
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(out, { recursive: true, force: true })
})

/* ────────────────────────────────────────────────────────────────────────────
 * Test
 * ──────────────────────────────────────────────────────────────────────────── */

describe('fetch finto (C0-12)', () => {
  it('lancia su qualunque URL: una rete vera non può partire di nascosto', async () => {
    await expect(fetch('https://ws.fatturazioneelettronica.aruba.it/services/invoice/out/getByFilename')).rejects.toThrow(/NON PREVISTA/)
    await expect(fetch('https://example.test/')).rejects.toThrow(/NON PREVISTA/)
  })
})

describe('ordine: letture Aruba → scritture', () => {
  it('con --applica, l\'ultima chiamata ad Aruba viene prima della prima scrittura', async () => {
    const { deps, eventi, scritture } = crea()
    const uscita = await main(['--out', out, '--applica'], deps)

    const aruba = chiamateAruba(eventi)
    const scritte = scrittureDi(eventi)
    // Prima l'ordine, poi i conteggi: una CLI che scrive in mezzo alle letture deve
    // cadere QUI, col messaggio giusto.
    expect(aruba.length).toBeGreaterThan(0)
    expect(scritte.length).toBeGreaterThan(0)
    expect(Math.max(...aruba), 'ultima chiamata Aruba dopo la prima scrittura').toBeLessThan(Math.min(...scritte))
    expect(uscita).toBe(USCITA.ok)
    expect(aruba.length).toBe(4) // signin, due getByFilename, uno scorrimento
    expect(scritte.length).toBe(2)
    // una guardia prima di OGNI chiamata ad Aruba
    for (const i of aruba) expect(eventi[i - 1]).toBe('guardia')
    // in ordine di fattura_emessa_il, ciascuna col suo pagamento
    expect(scritture[0]).toContain(`'${PAG}'::uuid`)
    expect(scritture[1]).toContain(`'${PAG_2}'::uuid`)
    // l'istruzione usa il predicato del modulo, alla lettera
    expect(scritture[0]).toContain(PREDICATO_SQL_PARTITA_NON_REGISTRATA)
  })

  it('a secco: letture complete, zero scritture, uscita 0', async () => {
    const { deps, eventi } = crea()
    const uscita = await main(['--out', out], deps)
    expect(uscita).toBe(USCITA.ok)
    expect(chiamateAruba(eventi).length).toBe(4)
    expect(deps.scrivi).not.toHaveBeenCalled()
    expect(eventi).not.toContain('sql:conteggio')
  })

  it('la scoperta usa il testo del predicato importato dal modulo, e il riconteggio pure', async () => {
    const { deps, sqlEseguite } = crea()
    await main(['--out', out, '--applica'], deps)
    const candidati = sqlEseguite.find((s) => s.startsWith('/* orfane:candidati */'))
    const riconteggio = sqlEseguite.find((s) => s.startsWith('/* orfane:riconteggio */'))
    expect(candidati).toContain(`(${PREDICATO_SQL_PARTITA_NON_REGISTRATA})`)
    expect(candidati).toContain("not like 'e2e00000-%'")
    expect(riconteggio).toContain(`(${PREDICATO_SQL_PARTITA_NON_REGISTRATA})`)
  })
})

describe('«SCRIVO i/N:» prima di ogni scrittura, coi dati mascherati', () => {
  it('ogni scrittura è preceduta dalla sua stampa, e nessuna stampa porta CF o nomi in chiaro', async () => {
    const { deps, eventi, stampe } = crea()
    await main(['--out', out, '--applica'], deps)

    const scritte = scrittureDi(eventi)
    expect(scritte.length).toBe(2)
    scritte.forEach((iScrittura, k) => {
      const iStampa = eventi.findIndex((e) => e.startsWith(`stampa:SCRIVO ${k + 1}/2:`))
      expect(iStampa).toBeGreaterThanOrEqual(0)
      expect(iStampa).toBeLessThan(iScrittura)
      // fra la stampa e la sua scrittura non c'è un'altra scrittura
      expect(scrittureDi(eventi.slice(iStampa, iScrittura)).length).toBe(0)
    })
    const scrivo = stampe.filter((s) => s.startsWith('SCRIVO '))
    expect(scrivo.length).toBe(2)
    for (const s of scrivo) {
      expect(s).toContain(mascheraCf(CF_FINTO))
      expect(s).toContain('WITH pre AS') // l'istruzione intera, mascherata
    }
    const tutto = stampe.join('\n')
    expect(tutto).not.toContain(CF_FINTO)
    expect(tutto).not.toContain(NOME)
    expect(tutto).not.toContain(COGNOME)
    expect(tutto).not.toContain('Retta di prova')
  })

  it('il file .sql (0600) e gli XML spariscono in uscita; restano con --conserva; il rapporto resta sempre', async () => {
    const primo = crea()
    await main(['--out', out, '--applica'], primo.deps)
    expect(readdirSync(out).sort()).toEqual([NOME_RAPPORTO])
    const rapporto = readFileSync(join(out, NOME_RAPPORTO), 'utf8')
    expect(rapporto).not.toContain(CF_FINTO)
    expect(rapporto).not.toContain(NOME)

    const altra = mkdtempSync(join(tmpdir(), 'orfane-cli-conserva-'))
    try {
      const secondo = crea()
      await main(['--out', altra, '--applica', '--conserva'], secondo.deps)
      const file = readdirSync(altra)
      expect(file).toContain(`${PAG}.sql`)
      expect(file).toContain(`${PAG}.xml`)
      expect(file).toContain(`${PAG}.p7m`)
      for (const f of file) expect(statSync(join(altra, f)).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(altra, { recursive: true, force: true })
    }
  })
})

describe('--solo', () => {
  it('--solo <uuid> → esattamente una scrittura, di quel pagamento', async () => {
    const { deps, eventi, scritture } = crea()
    const uscita = await main(['--out', out, '--applica', '--solo', PAG_2], deps)
    expect(uscita).toBe(USCITA.ok)
    expect(scritture.length).toBe(1)
    expect(scritture[0]).toContain(`'${PAG_2}'::uuid`)
    expect(scritture[0]).not.toContain(PAG)
    expect(eventi).toContain(`scrivi:${PAG_2}.sql`)
    // Aruba legge solo quel documento
    expect(eventi).toContain(`aruba:getByFilename:${FILE_2}`)
    expect(eventi).not.toContain(`aruba:getByFilename:${FILE}`)
    expect(eventi.some((e) => e.startsWith('stampa:SCRIVO 1/1:'))).toBe(true)
  })

  it('--solo di un pagamento che non è un\'orfana → uscita 1, zero chiamate ad Aruba e zero scritture', async () => {
    const { deps, eventi } = crea()
    const uscita = await main(['--out', out, '--applica', '--solo', '12345678-1234-4234-8234-123456789012'], deps)
    expect(uscita).toBe(USCITA.guardia)
    expect(chiamateAruba(eventi).length).toBe(0)
    expect(deps.scrivi).not.toHaveBeenCalled()
  })

  it('leggiArgomenti rifiuta un --solo che non è un uuid e gli argomenti sconosciuti', () => {
    expect(leggiArgomenti(['--solo', 'x'])).toHaveProperty('errore')
    expect(leggiArgomenti(['--out', out, '--forza'])).toHaveProperty('errore')
    expect(leggiArgomenti(['--out', out, '--solo', PAG])).toEqual({
      opzioni: { out, solo: PAG, conserva: false, applica: false },
    })
  })
})

describe('la coda: una voce con un invio non si scrive mai', () => {
  it('tabella del giornale presente e invio del pagamento → DA DECIDERE, mai scritta, uscita 2', async () => {
    const { deps, eventi, scritture, sqlEseguite } = crea({ giornaleEsiste: true, invii: [PAG] })
    const uscita = await main(['--out', out, '--applica'], deps)
    expect(uscita).toBe(USCITA.daDecidere)
    expect(eventi).toContain('sql:invii')
    expect(scritture.length).toBe(1)
    expect(scritture[0]).toContain(`'${PAG_2}'::uuid`)
    expect(scritture.join('\n')).not.toContain(`'${PAG}'::uuid`)
    // la voce della coda non va nemmeno ad Aruba
    expect(eventi).not.toContain(`aruba:getByFilename:${FILE}`)
    // la clausola sul giornale c'è, perché la tabella esiste
    expect(scritture[0]).toContain('public.fatture_coda_invii')
    expect(sqlEseguite.some((s) => s.startsWith('/* orfane:invii */'))).toBe(true)
    const rapporto = JSON.parse(readFileSync(join(out, NOME_RAPPORTO), 'utf8'))
    const voce = rapporto.voci.find((v: { pagamento_id: string }) => v.pagamento_id === PAG)
    expect(voce.stato).toBe('da_decidere')
    expect(voce.motivi).toContain(DA_DECIDERE.laRegistraLaCoda)
  })

  it('controllo negativo: senza la tabella del giornale non si legge fatture_coda_invii', async () => {
    const { deps, eventi, scritture } = crea({ giornaleEsiste: false, invii: [PAG] })
    const uscita = await main(['--out', out, '--applica'], deps)
    expect(uscita).toBe(USCITA.ok)
    expect(eventi).not.toContain('sql:invii')
    expect(scritture.length).toBe(2)
    expect(scritture[0]).not.toContain('public.fatture_coda_invii')
  })
})

describe('le guardie fermano prima di scrivere', () => {
  it('disaccordo SQL/TS → uscita 2, zero chiamate ad Aruba, zero scritture', async () => {
    // L'SQL dà PAG come orfana, ma a registro c'è la riga col suo file: il TS dice falso.
    const { deps, eventi, stampe } = crea({ righe: [{ pagamento_id: PAG, sdi_stato: 1, aruba_filename: FILE }] })
    const uscita = await main(['--out', out, '--applica'], deps)
    expect(uscita).toBe(USCITA.daDecidere)
    expect(deps.scrivi).not.toHaveBeenCalled()
    expect(chiamateAruba(eventi).length).toBe(0)
    expect(stampe.join('\n')).toContain(DA_DECIDERE.predicatiDiscordi)
  })

  it('vincolo per sede ancora presente → uscita 1, zero scritture, nessuna scoperta', async () => {
    const { deps, eventi } = crea({ vincoloN: 1 })
    const uscita = await main(['--out', out, '--applica'], deps)
    expect(uscita).toBe(USCITA.guardia)
    expect(deps.scrivi).not.toHaveBeenCalled()
    expect(eventi).not.toContain('sql:candidati')
    expect(chiamateAruba(eventi).length).toBe(0)
  })

  it('--out dentro il repository → uscita 1 prima di qualunque chiamata', async () => {
    const dentro = join(RADICE, 'orfane-dentro-il-repo')
    const { deps, eventi } = crea()
    const uscita = await main(['--out', dentro, '--applica'], deps)
    expect(uscita).toBe(USCITA.guardia)
    expect(eventi.filter((e) => !e.startsWith('stampa:'))).toEqual([])
    expect(deps.openssl).not.toHaveBeenCalled()
    expect(deps.sql).not.toHaveBeenCalled()
    expect(deps.apriAruba).not.toHaveBeenCalled()
    expect(existsSync(dentro)).toBe(false)
  })

  it('--out assente → uscita 1 prima di qualunque chiamata', async () => {
    const { deps, eventi } = crea()
    expect(await main(['--applica'], deps)).toBe(USCITA.guardia)
    expect(eventi.filter((e) => !e.startsWith('stampa:'))).toEqual([])
  })

  it('guardia negata → uscita 1, parziali conservati, zero scritture', async () => {
    // La prima guardia (signin) passa, la seconda (primo getByFilename) nega.
    const { deps, eventi, stampe } = crea({ guardiaNegaAllaChiamata: 2 })
    const uscita = await main(['--out', out, '--applica'], deps)
    expect(uscita).toBe(USCITA.guardia)
    expect(deps.scrivi).not.toHaveBeenCalled()
    expect(eventi.filter((e) => e.startsWith('aruba:'))).toEqual(['aruba:signin'])
    expect(stampe.join('\n')).toMatch(/attivita-app/)
    // i parziali: il rapporto con la scoperta e il punto d'arresto
    const rapporto = JSON.parse(readFileSync(join(out, NOME_RAPPORTO), 'utf8'))
    expect(rapporto.fase).toBe('aruba')
    expect(rapporto.fermo.codice).toBe('attivita-app')
    expect(rapporto.uscita).toBe(USCITA.guardia)
    expect(rapporto.voci.map((v: { pagamento_id: string }) => v.pagamento_id)).toEqual([PAG, PAG_2])
  })

  it('un 429 di Aruba ferma tutto con 1: nessuna chiamata dopo, nessuna scrittura', async () => {
    const { deps, eventi } = crea()
    const aprire = deps.apriAruba
    deps.apriAruba = vi.fn(() => {
      const lettore = aprire()
      lettore.getByFilename = vi.fn(async (f: string) => {
        eventi.push(`aruba:getByFilename:${f}`)
        throw new FermoAruba('aruba-429', 'Aruba ha risposto 429 alle 19:10.')
      })
      return lettore
    })
    const uscita = await main(['--out', out, '--applica'], deps)
    expect(uscita).toBe(USCITA.guardia)
    expect(deps.scrivi).not.toHaveBeenCalled()
    expect(eventi.filter((e) => e.startsWith('aruba:'))).toEqual(['aruba:signin', `aruba:getByFilename:${FILE}`])
  })

  it('un documento che non passa un controllo (numero nel log diverso) è DA DECIDERE e non si scrive', async () => {
    const altroNumero = xmlDi({ ...ORFANE[0], numero: 2600 })
    const { deps, scritture } = crea({ xml: { [FILE]: altroNumero } })
    const uscita = await main(['--out', out, '--applica'], deps)
    expect(uscita).toBe(USCITA.daDecidere)
    expect(scritture.length).toBe(1)
    expect(scritture[0]).toContain(`'${PAG_2}'::uuid`)
  })

  it('una scrittura che non registra niente → uscita 3, e non si prosegue con le altre', async () => {
    const { deps, eventi } = crea()
    deps.scrivi = vi.fn(async (fileSql: string) => {
      eventi.push(`scrivi:${basename(fileSql)}`)
      return [{ registrate: 0, audit: 0, fattura_id: null, audit_id: null }]
    })
    const uscita = await main(['--out', out, '--applica'], deps)
    expect(uscita).toBe(USCITA.scrittura)
    expect(deps.scrivi).toHaveBeenCalledTimes(1)
  })
})

describe('controllo c: il ProgressivoInvio atteso', () => {
  it('coincide con progressivoInvioFattura dell\'app (la CLI non può importare emissione.ts sotto Node)', () => {
    const casi: Array<['Asilo' | 'FPR', number, number]> = [['FPR', 2541, 2026], ['Asilo', 1, 2026], ['FPR', 999999, 2031], ['Asilo', 42, 2100]]
    for (const [sezionale, numero, anno] of casi) {
      expect(progressivoAtteso({ sezionale, numero, anno })).toBe(progressivoInvioFattura(sezionale, numero, anno))
    }
  })
})

describe('il file della CLI', () => {
  const testo = readFileSync(FILE_CLI, 'utf8')

  it('importa il modulo del predicato e non ne contiene una copia', () => {
    expect(testo).toContain("import('@/lib/pagamenti/fattura-partita-non-registrata')")
    expect(testo).not.toContain("fattura_stato = 'in_attesa'")
    expect(testo).not.toMatch(/fatture_emesse f\s+WHERE f\.pagamento_id = p\.id AND f\.aruba_filename/i)
    expect(testo).not.toContain('PREDICATO_SQL_PARTITA_NON_REGISTRATA =')
  })

  it('i processi figli partono solo con execFileSync e argomenti in array', () => {
    expect(testo).not.toMatch(/\bexecSync\b|\bspawnSync?\s*\(|shell:\s*true/)
  })
})
