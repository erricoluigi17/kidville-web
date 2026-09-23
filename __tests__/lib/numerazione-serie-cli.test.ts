// @vitest-environment node
/**
 * La CLI dell'indagine sulla numerazione (`scripts/numerazione-serie.mjs`, D1 §3.3-§4),
 * provata con dipendenze FINTE che registrano l'ordine delle chiamate (rilievo 10).
 *
 * Che cosa si prova, e perché conta l'ORDINE:
 *   · senza `--allinea` la CLI non scrive mai (zero chiamate a `scrivi`);
 *   · con `--allinea` stampa «SCRIVO:» con l'istruzione intera PRIMA dell'unica scrittura,
 *     e rilegge DOPO; con 0 righe aggiornate esce 1 e chiede di rilanciare;
 *   · `--out` dentro il repository (pubblico) → uscita 1 prima di qualunque chiamata;
 *   · la guardia di D1 §10 prima di OGNI chiamata ad Aruba; se nega, uscita 1 e più nulla;
 *   · al primo 429 si ferma e i parziali restano in `--out`;
 *   · git riceve `rif` (il deploy di produzione) e mai `HEAD` in un confronto (D1 §0.2 a);
 *   · la lettura del giornale della coda (Q6) parte solo se la tabella esiste;
 *   · il predicato delle orfane arriva dal modulo TS, mai copiato nel file.
 *
 * Tutti i dati sono SINTETICI (nomi file `IT01234567890_…`, uuid di zeri), nessun dato
 * personale. `fetch` è sostituita da un finto che LANCIA su qualunque URL (C0-12): le
 * dipendenze sono finte, quindi nessuna richiesta vera deve partire; se parte, il test fallisce.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREDICATO_SQL_PARTITA_NON_REGISTRATA } from '@/lib/pagamenti/fattura-partita-non-registrata'
import { FermoAruba, RADICE_REPO, messaggio429 } from '../../scripts/lib/aruba-lettura.mjs'
import { verificaConfrontoEScambio } from '../../scripts/lib/numerazione-serie.mjs'
import { main } from '../../scripts/numerazione-serie.mjs'

const FILE_CLI = resolve(__dirname, '../../scripts/numerazione-serie.mjs')

// ─── Cronologia sintetica ───────────────────────────────────────────────────
const ANNO = 2026
const ADESSO = new Date('2026-09-23T06:00:00Z')

/** Sha di 40 cifre esadecimali: i prefissi ricalcano i deploy pubblici di D1 §2.6. */
const SHA_VECCHIO = `aaaaaaa1${'0'.repeat(32)}`
const SHA_9A = `9a30ff67${'0'.repeat(32)}`
const SHA_RIF = `29bb04c7${'0'.repeat(32)}`
const SHA_PREVIEW = `bbbbbbb2${'0'.repeat(32)}`
/** L'ultimo commit sui percorsi della numerazione raggiungibile da rif (D1 §2.6). */
const ULTIMO_COMMIT = '9a30ff67 2026-09-16T15:42:11+02:00'

type Serie = 'Asilo' | 'FPR'
type Voce = { serie: Serie; numero: number; istante: string }

const fileDi = (serie: Serie, numero: number) =>
  `IT01234567890_${serie === 'FPR' ? 'F' : 'A'}${String(numero).padStart(4, '0')}.xml.p7m`
const etichettaDi = (serie: Serie, numero: number) => (serie === 'Asilo' ? `Asilo ${numero}/2026` : `FPR ${numero}/26`)
const voce = (serie: Serie, numero: number, istante: string): Voce => ({ serie, numero, istante })

/**
 * Registro dell'app. Due salti:
 *   · FPR 3 → 5 il 06/09, PRIMA dell'ultimo commit sui percorsi: il deploy attivo allora
 *     (SHA_VECCHIO) ha codice diverso da rif, e la P7 non lo deve confrontare;
 *   · FPR 6 → 10 il 18/09 (come J1), spiegato da FPR 9 fuori app, deploy attivo 9a30ff67.
 */
const REGISTRO: Voce[] = [
  voce('FPR', 1, '2026-09-05T08:00:00Z'),
  voce('FPR', 2, '2026-09-05T08:01:00Z'),
  voce('FPR', 3, '2026-09-05T08:02:00Z'),
  voce('FPR', 5, '2026-09-06T08:00:00Z'),
  voce('FPR', 6, '2026-09-17T09:00:00Z'),
  voce('FPR', 10, '2026-09-18T07:45:16Z'),
  voce('FPR', 11, '2026-09-21T09:00:00Z'),
  voce('Asilo', 1, '2026-09-10T08:00:00Z'),
  voce('Asilo', 2, '2026-09-10T08:01:00Z'),
  voce('Asilo', 3, '2026-09-10T08:02:00Z'),
]
/** Un'orfana: partita verso Aruba, mai scritta a registro. */
const ORFANA = voce('FPR', 12, '2026-09-22T12:00:00Z')
/** Nati sul pannello di Aruba. FPR 9 sta nella finestra F1 (17/09 10:31 → 18/09 07:45). */
const FUORI_APP: Voce[] = [voce('FPR', 4, '2026-09-05T12:00:00Z'), voce('FPR', 9, '2026-09-17T15:00:00Z')]
/** Un invio della coda, per lo scenario col giornale. */
const DEL_GIORNALE = voce('FPR', 13, '2026-09-22T13:00:00Z')

type Chiamata = { tipo: string; dettaglio: string }

interface Opzioni {
  giornale?: boolean
  contatoreFpr?: number
  aggiornateAllaScrittura?: number
  guardiaNegaAllaChiamata?: number
  arubaAl429?: 'scorriDocumenti'
}

/**
 * Le dipendenze finte. Ognuna registra la propria chiamata in `chiamate`, nell'ordine: è
 * su quell'elenco che si provano le regole d'ordine. Il DB finto è a stato: la scrittura di
 * `--allinea` aggiorna il contatore, e la rilettura lo vede.
 */
function creaFinti(opzioni: Opzioni = {}) {
  const chiamate: Chiamata[] = []
  const stato = { contatoreFpr: opzioni.contatoreFpr ?? (opzioni.giornale ? 13 : 12), contatoreAsilo: 3 }
  const segna = (tipo: string, dettaglio = '') => chiamate.push({ tipo, dettaglio })

  const documentiAruba = [...REGISTRO, ORFANA, ...FUORI_APP, ...(opzioni.giornale ? [DEL_GIORNALE] : [])].map((v) => ({
    filename: fileDi(v.serie, v.numero),
    creationDate: v.istante,
    lastUpdate: v.istante,
    signed: true,
    unsignedFile: false,
    // Un campo che la CLI NON deve mai salvare: nel documento vero porta nomi e codici fiscali.
    sender: { description: 'DENOMINAZIONE FINTA DA NON SALVARE' },
    receiver: { description: 'DESTINATARIO FINTO DA NON SALVARE' },
    fatture: [{ numero: etichettaDi(v.serie, v.numero), stato: 'Consegnata', data: v.istante.slice(0, 10) }],
  }))

  async function sql(testo: string) {
    segna('sql', testo)
    if (testo.includes("to_regclass('public.fatture_coda_invii')")) return [{ giornale: Boolean(opzioni.giornale) }]
    if (/select count\(\*\)::int as n from public\.fatture_numerazione_sezionale/i.test(testo)) {
      const letto = Number(/ultimo_numero = (\d+)/.exec(testo)?.[1])
      return [{ n: letto === stato.contatoreFpr ? 1 : 0 }]
    }
    if (testo.includes('from public.fatture_numerazione_sezionale')) {
      return [
        { sezionale: 'Asilo', anno: ANNO, ultimo_numero: stato.contatoreAsilo, aggiornato_il: '2026-09-10T08:02:00Z' },
        { sezionale: 'FPR', anno: ANNO, ultimo_numero: stato.contatoreFpr, aggiornato_il: '2026-09-22T12:00:00Z' },
      ]
    }
    if (testo.includes('from public.fatture_emesse')) {
      return REGISTRO.map((v) => ({
        sezionale: v.serie,
        numero: v.numero,
        sdi_stato: 3,
        aruba_filename: fileDi(v.serie, v.numero),
        creato_il: v.istante,
      }))
    }
    if (testo.includes('from public.pagamenti p')) {
      return [{ id: '00000000-0000-4000-8000-000000000001', fattura_aruba_id: fileDi('FPR', 12), fattura_emessa_il: ORFANA.istante }]
    }
    if (testo.includes('from public.fatture_coda_invii')) {
      if (!opzioni.giornale) throw new Error('42P01: relation "public.fatture_coda_invii" does not exist')
      return [{ sezionale: 'FPR', anno: ANNO, numero: 13, aruba_filename: fileDi('FPR', 13), creato_il: DEL_GIORNALE.istante }]
    }
    if (testo.includes("'scorrimento-concluso'")) return [{ creato_il: '2026-09-22T08:25:00Z', ricevuti: '2', totale_dichiarato: '40' }]
    if (testo.includes('from public.app_log')) return [{ creato_il: '2026-09-22T12:02:00Z', esito: 'inviata', livello: 'info' }]
    throw new Error(`query non prevista dal finto: ${testo.slice(0, 80)}`)
  }

  async function scrivi(testo: string) {
    segna('scrivi', testo)
    const aggiornate = opzioni.aggiornateAllaScrittura ?? 1
    if (aggiornate > 0) {
      const obiettivo = Number(/SET ultimo_numero = (\d+)/.exec(testo)?.[1])
      stato.contatoreFpr = obiettivo
    }
    return [{ aggiornate, audit_id: aggiornate > 0 ? '00000000-0000-4000-8000-00000000a0d1' : null }]
  }

  let guardie = 0
  async function guardia({ sql: s }: { sql: unknown }) {
    guardie++
    segna('guardia', String(guardie))
    expect(typeof s).toBe('function')
    if (opzioni.guardiaNegaAllaChiamata === guardie) {
      return { ok: false, codice: 'finestra-sync', messaggio: 'La sync delle fatture può essere in corso: riprova dopo le 08:36.' }
    }
    return { ok: true, adesso: ADESSO }
  }

  const aruba = {
    async signin() {
      segna('aruba', 'signin')
    },
    async scorriDocumenti({ anno }: { anno: number }) {
      segna('aruba', `scorriDocumenti ${anno}`)
      if (opzioni.arubaAl429 === 'scorriDocumenti') {
        // Come il lettore vero al primo 429 (`creaLettoreAruba`), senza toccare la rete.
        throw new FermoAruba('aruba-429', messaggio429(ADESSO))
      }
      return { documenti: documentiAruba, totale: documentiAruba.length, pagine: 1 }
    },
    async getByFilename(filename: string) {
      segna('aruba', `getByFilename ${filename}`)
      return { contenuto: Buffer.from('p7m-finto'), fatture: [] }
    },
    estraiXml(_contenuto: Buffer, { cartella }: { cartella: string }) {
      segna('xml', cartella)
      return (
        '<?xml version="1.0"?><p:FatturaElettronica><FatturaElettronicaHeader><DatiTrasmissione>' +
        '<ProgressivoInvio>F0009</ProgressivoInvio></DatiTrasmissione><SoggettoEmittente>CC</SoggettoEmittente>' +
        '</FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento>' +
        '<TipoDocumento>TD01</TipoDocumento><Data>2026-09-17</Data><Numero>FPR 9/26</Numero>' +
        '</DatiGeneraliDocumento></DatiGenerali></FatturaElettronicaBody></p:FatturaElettronica>'
      )
    },
  }

  function git(args: string[]) {
    segna('git', JSON.stringify(args))
    const [comando] = args
    if (comando === 'cat-file' || comando === 'merge-base') return { codice: 0, stdout: '' }
    if (comando === 'log') return { codice: 0, stdout: `${ULTIMO_COMMIT}\n` }
    if (comando === 'diff') {
      const da = args[2]
      // Controllo positivo: il commit PRIMA dell'ultimo cambio dei percorsi differisce da rif.
      if (da === '9a30ff67~1') return { codice: 1, stdout: '' }
      // Il codice del 06/09 non è quello di rif.
      if (da === SHA_VECCHIO) return { codice: 1, stdout: '' }
      return { codice: 0, stdout: '' }
    }
    throw new Error(`git: comando non previsto ${comando}`)
  }

  const DEPLOY = [
    { id: 4, sha: SHA_PREVIEW, environment: 'Preview', created_at: '2026-09-22T09:00:00Z' },
    { id: 3, sha: SHA_RIF, environment: 'production', created_at: '2026-09-20T20:55:00Z' },
    { id: 2, sha: SHA_9A, environment: 'Production', created_at: '2026-09-16T13:41:00Z' },
    { id: 1, sha: SHA_VECCHIO, environment: 'production', created_at: '2026-09-01T00:00:00Z' },
  ]
  const SUCCESSO: Record<number, string> = {
    4: '2026-09-22T09:02:00Z',
    3: '2026-09-20T20:56:22Z',
    2: '2026-09-16T13:42:17Z',
    1: '2026-09-01T00:02:00Z',
  }
  function gh(args: string[]) {
    segna('gh', JSON.stringify(args))
    const percorso = args[1] ?? ''
    const stati = /deployments\/(\d+)\/statuses/.exec(percorso)
    if (stati) {
      const id = Number(stati[1])
      return JSON.stringify([
        { state: 'success', created_at: SUCCESSO[id] },
        { state: 'in_progress', created_at: '2026-01-01T00:00:00Z' },
      ])
    }
    if (/deployments\?/.test(percorso)) return JSON.stringify(DEPLOY)
    throw new Error(`gh: percorso non previsto ${percorso}`)
  }

  const stampate: string[] = []
  function stampa(testo: string) {
    stampate.push(testo)
    segna('stampa', testo)
  }

  return {
    chiamate,
    stampate,
    stato,
    deps: { sql, scrivi, aruba, git, gh, guardia, stampa, adesso: () => new Date(ADESSO.getTime()) },
  }
}

// ─── Attrezzi ───────────────────────────────────────────────────────────────
let base = ''
let out = ''
const fetchFinto = vi.fn(async (url: unknown) => {
  throw new Error(`fetch non prevista verso ${String(url)}: la CLI usa solo dipendenze iniettate`)
})

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'numerazione-cli-'))
  out = join(base, 'indagine')
  fetchFinto.mockClear()
  vi.stubGlobal('fetch', fetchFinto)
})

afterEach(() => {
  // Nessuna richiesta di rete: se una fetch è partita, il test fallisce qui.
  expect(fetchFinto).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  rmSync(base, { recursive: true, force: true })
})

const tipi = (c: Chiamata[]) => c.map((x) => x.tipo)
const indici = (c: Chiamata[], prova: (x: Chiamata) => boolean) =>
  c.map((x, i) => (prova(x) ? i : -1)).filter((i) => i >= 0)
const primo = (c: Chiamata[], prova: (x: Chiamata) => boolean) => c.findIndex(prova)
const ultimo = (c: Chiamata[], prova: (x: Chiamata) => boolean) => c.map(prova).lastIndexOf(true)
const eAruba = (x: Chiamata) => x.tipo === 'aruba'
const leggiUscita = (nome: RegExp) => {
  const f = readdirSync(out).find((n) => nome.test(n))
  expect(f, `manca in --out un file ${nome}`).toBeTruthy()
  return readFileSync(join(out, f as string), 'utf8')
}

// ─── I casi ─────────────────────────────────────────────────────────────────
describe('il finto di fetch', () => {
  it('lancia su qualunque URL, Aruba compreso', async () => {
    await expect(fetch('https://ws.fatturazioneelettronica.aruba.it/services/invoice/out/findByUsername')).rejects.toThrow(
      /fetch non prevista/,
    )
    fetchFinto.mockClear()
  })
})

describe('senza --allinea: indagine in sola lettura', () => {
  it('uscita 0, zero chiamate a scrivi, file 0600 in --out senza sender né receiver', async () => {
    const f = creaFinti()
    const uscita = await main(['--out', out], f.deps)

    expect(f.stampate.join('\n')).not.toMatch(/errore/i)
    expect(uscita).toBe(0)
    expect(tipi(f.chiamate)).not.toContain('scrivi')
    expect(tipi(f.chiamate)).toContain('aruba')

    const prospetto = join(out, `prospetto-numerazione-${ANNO}.txt`)
    expect(existsSync(prospetto)).toBe(true)
    for (const nome of readdirSync(out)) {
      const p = join(out, nome)
      expect(statSync(p).mode & 0o777, nome).toBe(0o600)
      const testo = readFileSync(p, 'utf8')
      expect(testo, nome).not.toMatch(/DENOMINAZIONE FINTA|DESTINATARIO FINTO|"sender"|"receiver"/)
    }
    // Il salto J1 sintetico è spiegato, e la P7 è vera contro rif.
    const dettaglio = JSON.parse(leggiUscita(/^numerazione-2026-.*\.json$/))
    expect(dettaglio.salti.map((s: { numero: number; esito: string }) => [s.numero, s.esito])).toEqual([
      [5, 'SPIEGATO da FPR 4/2026'],
      [10, 'SPIEGATO da FPR 9/2026'],
    ])
    expect(dettaglio.p7).toMatchObject({ vero: true, uscita: 0 })
    expect(leggiUscita(/^prova-codice-deploy\.txt$/)).toMatch(/29bb04c7/)
    // A terminale: il pavimento meno il contatore, per serie (D1 §3.4, verifica ≤ 50).
    expect(f.stampate.join('\n')).toMatch(/FPR.*pavimento − contatore 0\b/)
  })

  it('un salto non spiegato porta l’uscita a 2, ancora senza scritture', async () => {
    const f = creaFinti()
    const originale = f.deps.aruba.scorriDocumenti
    f.deps.aruba.scorriDocumenti = async (p: { anno: number }) => {
      const r = await originale(p)
      return { ...r, documenti: r.documenti.filter((d) => d.filename !== fileDi('FPR', 9)) }
    }
    expect(await main(['--out', out], f.deps)).toBe(2)
    expect(tipi(f.chiamate)).not.toContain('scrivi')
    expect(f.stampate.join('\n')).toMatch(/SALTO NON SPIEGATO/)
  })
})

describe('--out dentro il repository', () => {
  it('uscita 1 prima di qualunque chiamata, e nessuna cartella creata', async () => {
    const f = creaFinti()
    const dentro = join(RADICE_REPO, '.prova-out-cli-numerazione')
    expect(await main(['--out', dentro], f.deps)).toBe(1)
    expect(tipi(f.chiamate).filter((t) => t !== 'stampa')).toEqual([])
    expect(existsSync(dentro)).toBe(false)
    expect(f.stampate.join('\n')).toMatch(/dentro il repository/)
  })

  it('anche con --allinea, e senza --out del tutto', async () => {
    const f = creaFinti()
    expect(await main(['--out', RADICE_REPO, '--allinea', '--serie', 'FPR', '--a', '13'], f.deps)).toBe(1)
    expect(await main([], f.deps)).toBe(1)
    expect(tipi(f.chiamate).filter((t) => t !== 'stampa')).toEqual([])
  })
})

describe('la guardia di D1 §10 prima di OGNI chiamata ad Aruba', () => {
  it('ogni chiamata ad Aruba ha una guardia fresca davanti (anche i getByFilename di --xml-fuori-app)', async () => {
    const f = creaFinti()
    expect(await main(['--out', out, '--xml-fuori-app'], f.deps)).toBe(0)
    const aruba = f.chiamate.filter(eAruba).map((c) => c.dettaglio)
    expect(aruba).toEqual(['signin', 'scorriDocumenti 2026', `getByFilename ${fileDi('FPR', 9)}`])
    let fresca = false
    for (const c of f.chiamate) {
      if (c.tipo === 'guardia') fresca = true
      if (c.tipo === 'aruba') {
        expect(fresca, `chiamata ad Aruba senza guardia: ${c.dettaglio}`).toBe(true)
        fresca = false
      }
    }
    // L'XML fuori app si estrae nella cartella --out, e ne escono solo codici e numeri.
    expect(f.chiamate.find((c) => c.tipo === 'xml')?.dettaglio).toBe(realpathSync(out))
    expect(leggiUscita(/^xml-fuori-app-.*\.json$/)).toMatch(/"numero": "FPR 9\/26"/)
  })

  it.each([1, 2, 3])('se la guardia nega alla chiamata %i: uscita 1 e nessun’altra chiamata dopo', async (n) => {
    const f = creaFinti({ guardiaNegaAllaChiamata: n })
    expect(await main(['--out', out, '--xml-fuori-app'], f.deps)).toBe(1)
    const negata = primo(f.chiamate, (c) => c.tipo === 'guardia' && c.dettaglio === String(n))
    expect(negata).toBeGreaterThanOrEqual(0)
    expect(f.chiamate.slice(negata + 1).filter((c) => c.tipo !== 'stampa')).toEqual([])
    expect(f.chiamate.filter(eAruba)).toHaveLength(n - 1)
    expect(tipi(f.chiamate)).not.toContain('scrivi')
    expect(f.stampate.join('\n')).toMatch(/riprova dopo le 08:36/)
  })

  it('con --allinea la guardia che nega ferma tutto prima della scrittura', async () => {
    const f = creaFinti({ contatoreFpr: 10, guardiaNegaAllaChiamata: 2 })
    expect(await main(['--out', out, '--allinea', '--serie', 'FPR', '--a', '12'], f.deps)).toBe(1)
    expect(tipi(f.chiamate)).not.toContain('scrivi')
  })
})

describe('il primo 429', () => {
  it('ferma la CLI con uscita 1, il messaggio porta l’orario +60′, e i parziali restano in --out', async () => {
    const f = creaFinti({ arubaAl429: 'scorriDocumenti' })
    expect(await main(['--out', out], f.deps)).toBe(1)
    const alLimite = primo(f.chiamate, (c) => c.tipo === 'aruba' && c.dettaglio.startsWith('scorriDocumenti'))
    expect(f.chiamate.slice(alLimite + 1).filter((c) => c.tipo !== 'stampa')).toEqual([])
    expect(f.stampate.join('\n')).toMatch(/429 alle 08:00.*prima delle 09:00/)
    // Le letture dal DB fatte prima del 429 sono salvate, e l'interruzione è annotata.
    expect(JSON.parse(leggiUscita(/^estrazione-db-2026-.*\.json$/)).registro).toHaveLength(REGISTRO.length)
    expect(JSON.parse(leggiUscita(/^interrotto-.*\.json$/))).toMatchObject({ codice: 'aruba-429' })
    expect(tipi(f.chiamate)).not.toContain('scrivi')
  })
})

describe('P7: git riceve rif, mai HEAD in un confronto', () => {
  it('rif è il deploy di produzione attivo adesso; HEAD compare solo come secondo termine di merge-base', async () => {
    const f = creaFinti()
    expect(await main(['--out', out], f.deps)).toBe(0)
    const chiamateGit = f.chiamate.filter((c) => c.tipo === 'git').map((c) => JSON.parse(c.dettaglio) as string[])
    expect(chiamateGit.length).toBeGreaterThan(0)
    for (const args of chiamateGit) {
      expect(Array.isArray(args)).toBe(true)
      if (args.includes('HEAD')) expect(args).toEqual(['merge-base', '--is-ancestor', SHA_RIF, 'HEAD'])
      else expect(args.some((a) => a.includes(SHA_RIF))).toBe(true)
    }
    const confronti = chiamateGit.filter((a) => a[0] === 'diff')
    expect(confronti.map((a) => a[2])).toEqual(expect.arrayContaining(['9a30ff67~1', SHA_9A]))
    for (const a of confronti) expect(a.slice(3, 5)).toEqual([SHA_RIF, '--'])
    // Il salto del 06/09 è di prima dell'ultimo commit sui percorsi: il suo deploy non si confronta.
    expect(confronti.map((a) => a[2])).not.toContain(SHA_VECCHIO)
    // Il Preview non conta come produzione.
    expect(JSON.stringify(chiamateGit)).not.toContain(SHA_PREVIEW)
  })

  it('rif non antenato di HEAD → uscita 1 PRIMA di chiamare Aruba', async () => {
    const f = creaFinti()
    const gitVero = f.deps.git
    f.deps.git = (args: string[]) => (args[0] === 'merge-base' ? (gitVero(args), { codice: 1, stdout: '' }) : gitVero(args))
    expect(await main(['--out', out], f.deps)).toBe(1)
    expect(f.chiamate.filter(eAruba)).toEqual([])
    expect(f.stampate.join('\n')).toMatch(/aggiorna il branch o fai fetch/)
  })

  it('con --allinea non si chiamano né git né gh', async () => {
    const f = creaFinti({ contatoreFpr: 10 })
    expect(await main(['--out', out, '--allinea', '--serie', 'FPR', '--a', '12'], f.deps)).toBe(0)
    expect(tipi(f.chiamate)).not.toContain('git')
    expect(tipi(f.chiamate)).not.toContain('gh')
  })
})

describe('Q6: il giornale della coda si legge solo se la tabella esiste', () => {
  const leggeIlGiornale = (c: Chiamata) => c.tipo === 'sql' && /from public\.fatture_coda_invii/.test(c.dettaglio)

  it('tabella assente: nessuna query sul giornale, e nessuna clausola sul giornale', async () => {
    const f = creaFinti({ giornale: false })
    expect(await main(['--out', out], f.deps)).toBe(0)
    expect(f.chiamate.some((c) => c.tipo === 'sql' && c.dettaglio.includes("to_regclass('public.fatture_coda_invii')"))).toBe(true)
    expect(f.chiamate.filter(leggeIlGiornale)).toEqual([])
  })

  it('tabella presente: Q6 legge l’anno, e un file del giornale è «app», non fuori app', async () => {
    const f = creaFinti({ giornale: true })
    expect(await main(['--out', out], f.deps)).toBe(0)
    const q6 = f.chiamate.filter(leggeIlGiornale)
    expect(q6).toHaveLength(1)
    expect(q6[0].dettaglio).toMatch(/where anno = 2026/)
    const dettaglio = JSON.parse(leggiUscita(/^numerazione-2026-.*\.json$/))
    const fpr = dettaglio.serie.find((s: { serie: string }) => s.serie === 'FPR')
    expect(fpr).toMatchObject({ massimoGiornale: 13, ultimoNumeroVero: 13, fuoriApp: 2 })
  })

  it('con --allinea e il giornale, l’istruzione porta la clausola sul giornale', async () => {
    const f = creaFinti({ giornale: true, contatoreFpr: 10 })
    expect(await main(['--out', out, '--allinea', '--serie', 'FPR', '--a', '13'], f.deps)).toBe(0)
    const scritta = f.chiamate.find((c) => c.tipo === 'scrivi')?.dettaglio ?? ''
    expect(verificaConfrontoEScambio(scritta, { serie: 'FPR', anno: ANNO, letto: 10, obiettivo: 13, giornaleEsiste: true })).toEqual([])
  })
})

describe('--allinea: una scrittura sola, mostrata prima e riletta dopo', () => {
  it('«SCRIVO:» con l’istruzione intera PRIMA dell’unica scrittura, rilettura DOPO, uscita 0', async () => {
    const f = creaFinti({ contatoreFpr: 10 })
    expect(await main(['--out', out, '--allinea', '--serie', 'FPR', '--a', '12'], f.deps)).toBe(0)

    const scritture = indici(f.chiamate, (c) => c.tipo === 'scrivi')
    expect(scritture).toHaveLength(1)
    const iScrivi = scritture[0]
    const istruzione = f.chiamate[iScrivi].dettaglio
    expect(verificaConfrontoEScambio(istruzione, { serie: 'FPR', anno: ANNO, letto: 10, obiettivo: 12, giornaleEsiste: false })).toEqual([])

    const iMostra = primo(f.chiamate, (c) => c.tipo === 'stampa' && c.dettaglio.startsWith('SCRIVO:'))
    expect(iMostra).toBeGreaterThanOrEqual(0)
    expect(iMostra).toBeLessThan(iScrivi)
    expect(f.chiamate[iMostra].dettaglio).toContain(istruzione)

    // Tutte le letture (DB e Aruba) stanno PRIMA della scrittura; il conteggio anche.
    expect(ultimo(f.chiamate, eAruba)).toBeLessThan(iScrivi)
    const iConteggio = primo(f.chiamate, (c) => c.tipo === 'sql' && c.dettaglio.startsWith('select count(*)::int as n'))
    expect(iConteggio).toBeGreaterThanOrEqual(0)
    expect(iConteggio).toBeLessThan(iMostra)
    // La rilettura del contatore viene DOPO la scrittura, e vede il valore nuovo.
    const iRilettura = ultimo(
      f.chiamate,
      (c) => c.tipo === 'sql' && c.dettaglio.startsWith('select sezionale, anno, ultimo_numero'),
    )
    expect(iRilettura).toBeGreaterThan(iScrivi)
    expect(f.stato.contatoreFpr).toBe(12)
    expect(f.stampate.join('\n')).toMatch(/riletto.*FPR.*12/i)
  })

  it('0 righe aggiornate → uscita 1 con «rilancia»', async () => {
    const f = creaFinti({ contatoreFpr: 10, aggiornateAllaScrittura: 0 })
    expect(await main(['--out', out, '--allinea', '--serie', 'FPR', '--a', '12'], f.deps)).toBe(1)
    expect(indici(f.chiamate, (c) => c.tipo === 'scrivi')).toHaveLength(1)
    expect(f.stampate.join('\n')).toMatch(/rilancia/)
  })

  it('--a diverso dall’obiettivo → uscita 1, zero scritture; contatore già giusto → «nessuna scrittura», uscita 0', async () => {
    const sbagliato = creaFinti({ contatoreFpr: 10 })
    expect(await main(['--out', out, '--allinea', '--serie', 'FPR', '--a', '11'], sbagliato.deps)).toBe(1)
    expect(tipi(sbagliato.chiamate)).not.toContain('scrivi')
    expect(sbagliato.stampate.join('\n')).toMatch(/diverso-dall-obiettivo/)

    const giusto = creaFinti({ contatoreFpr: 12 })
    expect(await main(['--out', out, '--allinea', '--serie', 'FPR', '--a', '12'], giusto.deps)).toBe(0)
    expect(tipi(giusto.chiamate)).not.toContain('scrivi')
    expect(giusto.stampate.join('\n')).toMatch(/nessuna scrittura/)
  })

  it('--serie e --a senza --allinea, o --allinea senza --a: uscita 1 senza chiamate', async () => {
    const f = creaFinti()
    expect(await main(['--out', out, '--serie', 'FPR', '--a', '12'], f.deps)).toBe(1)
    expect(await main(['--out', out, '--allinea', '--serie', 'FPR'], f.deps)).toBe(1)
    expect(await main(['--out', out, '--allinea', '--serie', 'NC', '--a', '3'], f.deps)).toBe(1)
    expect(tipi(f.chiamate).filter((t) => t !== 'stampa')).toEqual([])
  })
})

describe('il predicato delle orfane viene dal modulo TS, mai copiato', () => {
  it('Q3 usa esattamente PREDICATO_SQL_PARTITA_NON_REGISTRATA', async () => {
    const f = creaFinti()
    await main(['--out', out], f.deps)
    const q3 = f.chiamate.filter((c) => c.tipo === 'sql' && c.dettaglio.includes('from public.pagamenti p'))
    expect(q3).toHaveLength(1)
    expect(q3[0].dettaglio).toContain(`where ${PREDICATO_SQL_PARTITA_NON_REGISTRATA}`)
  })

  it('il file importa il modulo con risolvi-ts e non contiene il letterale del predicato', () => {
    const testo = readFileSync(FILE_CLI, 'utf8')
    expect(testo).not.toMatch(/fattura_stato\s*=\s*'in_attesa'/)
    expect(testo).not.toMatch(/NOT EXISTS \(SELECT 1 FROM public\.fatture_emesse f\s+WHERE f\.pagamento_id/)
    expect(testo).toMatch(/await import\('\.\/lib\/risolvi-ts\.mjs'\)/)
    expect(testo).toMatch(/await import\('\.\.\/src\/lib\/pagamenti\/fattura-partita-non-registrata\.ts'\)/)
    // Controllo positivo: il riconoscitore vede il letterale quando c'è.
    expect(PREDICATO_SQL_PARTITA_NON_REGISTRATA).toMatch(/fattura_stato\s*=\s*'in_attesa'/)
  })

  it('nessuna shell: i processi figli partono con execFileSync e argomenti in array', () => {
    const testo = readFileSync(FILE_CLI, 'utf8')
    expect(testo).not.toMatch(/\bexecSync\b|\bspawnSync\b|shell:\s*true/)
    expect(testo).toMatch(/execFileSync\('git', args/)
    expect(testo).toMatch(/execFileSync\('gh', args/)
  })
})
