import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  ESTENSIONI_ALLEGATO_PUBBLICO,
  MIME_ALLEGATO_PUBBLICO,
  TETTO_UPLOAD_PUBBLICO,
} from '@/lib/upload/allegati-pubblici'

/**
 * LOCK · un handler PUBBLICO che scrive nello Storage ha un tetto per IP e una lista di tipi.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA STORIA (collaudo del 2026-08-02, sicurezza F1). `POST /api/iscrizione/upload` accettava
 * caricamenti ANONIMI nel bucket dei documenti d'iscrizione dei minori senza tetto per IP e
 * senza allowlist di tipo, mentre le tre rotte sorelle dello stesso wizard pubblico ce
 * l'avevano tutte. Misurato dal vivo: dieci POST di fila, dieci risposte dell'handler, mai
 * un 429; la stessa prova su `/api/iscrizione` si ferma al quinto tentativo.
 *
 * PERCHÉ NESSUN LOCK LA VEDEVA. Perché la regola era stata applicata a una LISTA CHIUSA di
 * rotte invece che a tutti gli handler pubblici, e `gate-coverage.test.ts` esentava proprio
 * quella riga dichiarando «tetto di dimensione» — che c'era davvero, mentre il tetto di
 * FREQUENZA e la lista dei tipi non c'erano e nessun test li pretendeva. È la forma di
 * difetto che questo ciclo ha già corretto tre volte: una regola giusta, e una porta accanto.
 *
 * PERCHÉ QUESTO FILE È SCRITTO AL CONTRARIO. Non c'è nessun elenco di rotte da controllare:
 * l'elenco lo RICAVA dal codice — ogni `route.ts` che scrive su Storage e non ha un gate
 * d'identità — così una rotta di upload che nascesse domani entra nel perimetro da sola. Un
 * lock con la lista dentro avrebbe lo stesso difetto delle rotte che sorveglia.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RADICE = process.cwd()
const API = path.join(RADICE, 'src', 'app', 'api')
const MIGRAZIONI = path.join(RADICE, 'supabase', 'migrations')

/** Gli stessi gate primitivi di `gate-coverage.test.ts`: chi stabilisce l'identità. */
const GATE = new RegExp(
  '\\b(?:requireStaff|requireDocente|requireUser|requireKitchenRead|requireParentOfStudent' +
    '|requireFunzione|requireArea|loadAppUser|resolveIdentity|resolveSessionAppId|sealDangerous' +
    '|genitoreHasFiglio)\\s*\\(|CRON_SECRET|\\bauth\\s*\\.\\s*getUser\\s*\\(',
)

/** Commenti via, stringhe intatte: senza, una regola citata in un commento passerebbe per codice. */
function senzaCommenti(sorgente: string): string {
  return sorgente.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

function routeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...routeFiles(full))
    else if (e.name === 'route.ts') out.push(full)
  }
  return out
}

type Rotta = { rel: string; src: string }

const TUTTE: Rotta[] = routeFiles(API).map((f) => ({
  rel: path.relative(RADICE, f).split(path.sep).join('/'),
  src: senzaCommenti(fs.readFileSync(f, 'utf8')),
}))

/** Le rotte che CARICANO un file nello Storage. */
const DI_UPLOAD = TUTTE.filter((r) => /\.\s*storage\b/.test(r.src) && /\.\s*upload\s*\(/.test(r.src))

/** Fra quelle, le PUBBLICHE: nessun gate d'identità in tutto il file. */
const PUBBLICHE = DI_UPLOAD.filter((r) => !GATE.test(r.src))

// ─── la dichiarazione del bucket, letta dalle migrazioni ─────────────────────

function statementDelleMigrazioni(): string[] {
  const out: string[] = []
  for (const file of fs.readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort()) {
    const testo = fs
      .readFileSync(path.join(MIGRAZIONI, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
    for (const sql of testo.split(';')) if (sql.trim()) out.push(sql)
  }
  return out
}

const STATEMENT = statementDelleMigrazioni()

/** L'ULTIMA lista di tipi dichiarata in migrazione per il bucket indicato. */
function mimeDichiarati(bucket: string): string[] {
  let ultimi: string[] = []
  for (const sql of STATEMENT) {
    if (!/storage\.buckets/i.test(sql) || !new RegExp(`'${bucket}'`).test(sql)) continue
    const sorgente = sql.match(/allowed_mime_types\s*=\s*(array\s*\[[\s\S]*?\])/i)?.[1]
    if (!sorgente) continue
    const trovati = [...sorgente.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((m) => m[1])
    if (trovati.length) ultimi = trovati
  }
  return ultimi
}

/** L'ULTIMO limite di dimensione dichiarato in migrazione per il bucket indicato. */
function limiteDichiarato(bucket: string): number | null {
  let ultimo: number | null = null
  for (const sql of STATEMENT) {
    if (!/storage\.buckets/i.test(sql) || !new RegExp(`'${bucket}'`).test(sql)) continue
    const assegnati = [...sql.matchAll(/file_size_limit\s*=\s*(\d+)/gi)]
    if (assegnati.length) ultimo = Number(assegnati[assegnati.length - 1][1])
  }
  return ultimo
}

const ordinati = (v: readonly string[]) => [...new Set(v)].sort()

describe('lock architettura · gli upload da una porta aperta hanno tetto e tipi', () => {
  it('la misura vede davvero le rotte (se cade, tutto il resto è verde su niente)', () => {
    // Un rilevatore rotto — cartella sbagliata, regex che non aggancia più `.upload(` —
    // renderebbe verdi per sempre tutte le prove qui sotto, su un elenco vuoto.
    expect(TUTTE.length).toBeGreaterThan(200)
    expect(DI_UPLOAD.length).toBeGreaterThanOrEqual(10)
    expect(
      PUBBLICHE.map((r) => r.rel).sort(),
      'Le due rotte di upload senza sessione sono queste. Se ne compare una terza va bene: ' +
        'deve solo passare le prove qui sotto. Se ne SPARISCONO, il rilevatore non riconosce ' +
        'più i gate e questo lock ha smesso di controllare qualcosa.',
    ).toEqual([
      'src/app/api/iscrizione/upload/route.ts',
      'src/app/api/public/forms/[token]/upload/route.ts',
    ])
  })

  it('il rilevatore riconosce i gate: una rotta protetta non finisce fra le pubbliche', () => {
    // CONTROLLO POSITIVO all'incontrario: `chat/upload` e `avvisi/upload` hanno un gate, e
    // devono restare fuori dal perimetro. Se ci finissero dentro, le prove sotto sarebbero
    // rosse per un motivo sbagliato — ed è il modo più rapido perché un lock venga spento.
    const protette = DI_UPLOAD.filter((r) => GATE.test(r.src)).map((r) => r.rel)
    expect(protette).toContain('src/app/api/chat/upload/route.ts')
    expect(protette).toContain('src/app/api/avvisi/upload/route.ts')
  })

  it.each(PUBBLICHE.map((r) => r.rel))('`%s` ha un tetto per IP', (rel) => {
    const src = PUBBLICHE.find((r) => r.rel === rel)!.src
    expect(
      /rateLimit\s*\(/.test(src) && /clientIp\s*\(/.test(src),
      `${rel} scrive nello Storage senza sapere chi chiama e senza un tetto per indirizzo: ` +
        'dieci richieste di fila arrivano tutte all\'handler, e nel bucket ci finisce quello ' +
        'che vogliono. È il difetto misurato il 2026-08-02 su `iscrizione/upload`.',
    ).toBe(true)
    expect(
      /TETTO_UPLOAD_PUBBLICO/.test(src),
      `${rel} usa un tetto scritto a mano invece di quello condiviso ` +
        '(`TETTO_UPLOAD_PUBBLICO`, src/lib/upload/allegati-pubblici.ts). Due numeri per la ' +
        'stessa regola divergono: è già successo su `gallery` (50 MB nel bucket, 200 nella ' +
        'route) e nessuno se n\'è accorto per mesi.',
    ).toBe(true)
  })

  it.each(PUBBLICHE.map((r) => r.rel))('`%s` passa dal gate condiviso sui tipi', (rel) => {
    const src = PUBBLICHE.find((r) => r.rel === rel)!.src
    expect(
      /verificaAllegatoPubblico\s*\(/.test(src),
      `${rel} non chiama \`verificaAllegatoPubblico\`: il tipo dichiarato dal client tornerebbe ` +
        "a essere l'unica cosa che decide, su una porta a cui bussa chiunque.",
    ).toBe(true)
    expect(
      /contentType:\s*gate\.contentType/.test(src),
      `${rel} passa allo Storage un contentType che non viene dal gate: con ` +
        '`application/octet-stream` un file valido verrebbe respinto DOPO il caricamento, ' +
        'appena il bucket dichiara i suoi tipi.',
    ).toBe(true)
  })

  it('il tetto può solo SCENDERE, e resta praticabile per una famiglia vera', () => {
    // 961 allegati per 227 domande = 4,2 file a domanda; gli INVII sono 5/10 min per IP.
    // Sotto i 20 si respinge una famiglia con quattro documenti; sopra i 30 il tetto non
    // è più un tetto — ed è il numero della rotta gemella, che non deve crescere in silenzio.
    expect(TETTO_UPLOAD_PUBBLICO).toBeGreaterThanOrEqual(20)
    expect(TETTO_UPLOAD_PUBBLICO).toBeLessThanOrEqual(30)
  })

  it('la lista dei tipi non diventa «passa tutto» (controllo negativo)', () => {
    for (const vietato of [
      'text/html',
      'text/plain',
      'image/svg+xml',
      'application/octet-stream',
      'application/x-msdownload',
    ]) {
      expect(
        (MIME_ALLEGATO_PUBBLICO as readonly string[]).includes(vietato),
        `\`${vietato}\` è entrato fra i tipi ammessi su una porta ANONIMA. Allargare la lista ` +
          'in silenzio è il modo elegante di disattivare questo lock: HTML e SVG portano ' +
          'script, e `octet-stream` è l\'etichetta con cui passa qualunque cosa.',
      ).toBe(false)
    }
    // CONTROLLO POSITIVO: la lista serve ancora a qualcosa.
    expect((MIME_ALLEGATO_PUBBLICO as readonly string[]).includes('application/pdf')).toBe(true)
    expect((ESTENSIONI_ALLEGATO_PUBBLICO as readonly string[]).includes('exe')).toBe(false)
  })

  it('il bucket `form_attachments` dichiara in migrazione gli stessi tipi del gate', () => {
    const dichiarati = mimeDichiarati('form_attachments')
    expect(
      dichiarati.length,
      'Nessuna migrazione dichiara `allowed_mime_types` per `form_attachments`. Con la ' +
        'colonna a NULL il bucket accetta qualunque tipo, e l\'unica difesa torna a essere ' +
        'quella applicativa: basta la prossima rotta che dimentichi il gate.',
    ).toBeGreaterThan(0)
    expect(
      ordinati(dichiarati),
      'I tipi del bucket e quelli di `MIME_ALLEGATO_PUBBLICO` devono COINCIDERE: se il ' +
        'bucket è più stretto il file viene respinto dopo il caricamento (500 opaco), se è ' +
        'più largo la migrazione dichiara una sicurezza che non esiste.',
    ).toEqual(ordinati(MIME_ALLEGATO_PUBBLICO))
  })

  it('il bucket `form_attachments` dichiara un limite di dimensione', () => {
    expect(
      limiteDichiarato('form_attachments'),
      'Il bucket dei documenti d\'iscrizione non ha un `file_size_limit`: il freno vive solo ' +
        'dentro le route, e vale finché ogni route se lo ricorda.',
    ).toBeGreaterThan(0)
  })
})
