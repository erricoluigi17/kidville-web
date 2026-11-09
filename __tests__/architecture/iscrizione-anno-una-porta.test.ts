import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi, fileSorgente, riga, type SorgenteMascherato } from '../fixtures/sorgente'

/**
 * COMPITO 4.5.12 · L'ISCRIZIONE ALL'ANNO PROSSIMO HA UNA PORTA SOLA.
 *
 * Una frequenza dell'anno aperto, la voce della sua quota, la conferma e il «non rinnova» nascono in funzioni SQL che
 * fanno più cose insieme (la riga, la voce, i moduli, il contatore dei posti, il log). Se un pezzo di `src/` le aggira
 * scrivendo `frequenze` da solo, o chiamando la RPC con argomenti suoi, la frequenza nasce senza la quota, o la quota senza
 * la frequenza: due righe che dovevano nascere insieme e non lo fanno, e nessun test di route se ne accorge.
 *
 * Questo lock tiene ferme tre regole:
 *
 *  1. le RPC dell'iscrizione all'anno (`PORTE`) compaiono come stringa SOLO nel file che è la loro porta. Si cerca il NOME
 *     fra virgolette in tutto `src/` (commenti spenti), non la sola forma `.rpc('…')`: `rpc(NOME)` con `const NOME =
 *     'anno_conferma'` sarebbe una porta aperta;
 *  2. `frequenze` non si scrive con `.insert`/`.upsert` fuori da `src/lib/anno/` (l'UPDATE di un campo lo regola
 *     `anno-scrittura-coverage`);
 *  3. `alunni` non nasce `in_arrivo` fuori dai due punti che hanno una domanda per l'anno prossimo
 *     (`admin/iscrizioni/route.ts` e `import/esegui.ts`); e la scrittura `stato: in_arrivo` non sta in nessun altro file
 *     oltre a quei due e a `domanda-anno-prossimo.ts`, che ne definisce la patch.
 *
 * ─── PERCHÉ IL LOCK NON È CIECO ───────────────────────────────────────────────
 * Dichiara quanti file ha letto e quante occorrenze ha trovato, con un MINIMO ATTESO (un lock che scansiona zero file è
 * verde: è già successo tre volte in questo repo), e ha il suo controllo positivo su sorgenti finti. Legge `src/` mascherato
 * (`fixtures/sorgente.ts`): un commento che nomina una RPC non conta, e questo file non è in `src/`.
 *
 * ─── CHE COSA NON VEDE ────────────────────────────────────────────────────────
 *  - `.from(variabile).insert(…)`: la tabella non si legge (lo dichiara già `anno-scrittura-coverage`, che ha il tetto);
 *  - un nome di RPC costruito a pezzi (`'anno_' + 'conferma'`);
 *  - le scritture dentro il database: ci pensano le prove PGlite di `__tests__/db/`.
 */

const CWD = process.cwd()
const RADICE_SRC = path.join(CWD, 'src')
const rel = (f: string) => path.relative(CWD, f).split(path.sep).join('/')

// ───────────────────────── regola 1: le porte delle RPC ─────────────────────────

const PORTA_ISCRIZIONE = 'src/lib/anno/iscrizione-anno.ts'
const ROUTE_CONFERME = 'src/app/api/admin/anni/[annoSedeId]/conferme/route.ts'

/**
 * Per ogni RPC: i soli file di `src/` in cui il suo nome può comparire fra virgolette, e il minimo di occorrenze atteso
 * (misurato il 2026-11-09 sul ramo della PR 4.5).
 *  - le quattro dell'iscrizione stanno in `iscrizione-anno.ts` (`anno_quota_voce` la chiama SOLO il database, da
 *    `anno_registra_frequenza` e da `anno_conferma`: in `src/` non compare, e ci deve restare così);
 *  - `anno_conta_posti` è una LETTURA (i posti occupati per fascia) e la chiama una route sola, quella delle conferme;
 *  - `anno_quota_collega` la chiamano il database (`anno_conferma`) e il trigger del CRM: in `src/` non compare.
 */
const PORTE: Record<string, { file: readonly string[]; minimo: number; nota: string }> = {
  anno_registra_frequenza: { file: [PORTA_ISCRIZIONE], minimo: 1, nota: 'registra la frequenza e la quota' },
  anno_quota_voce: { file: [], minimo: 0, nota: 'la chiama solo il database (anno_registra_frequenza, anno_conferma)' },
  anno_conferma: { file: [PORTA_ISCRIZIONE], minimo: 1, nota: 'conferma il bambino per l’anno prossimo' },
  anno_non_rinnova: { file: [PORTA_ISCRIZIONE], minimo: 1, nota: 'segna il bambino che non rinnova' },
  anno_conta_posti: { file: [ROUTE_CONFERME], minimo: 1, nota: 'lettura dei posti occupati: una route sola' },
  anno_quota_collega: { file: [], minimo: 0, nota: 'la chiamano il database (anno_conferma) e il trigger del CRM' },
}

/** I nomi fra virgolette (', ", `) nel testo senza commenti: la forma `.rpc('nome')` e anche `const NOME = 'nome'`. */
function occorrenzeRpc(m: SorgenteMascherato, nome: string): number[] {
  const re = new RegExp(`(['"\`])${nome}\\1`, 'g')
  const out: number[] = []
  let h: RegExpExecArray | null
  while ((h = re.exec(m.senzaCommenti)) !== null) out.push(riga(m.originale, h.index))
  return out
}

interface Sorgente { percorso: string; m: SorgenteMascherato }

function violazioniPorte(files: Sorgente[], porte = PORTE): string[] {
  const out: string[] = []
  for (const f of files) {
    for (const [nome, p] of Object.entries(porte)) {
      if (p.file.includes(f.percorso)) continue
      for (const r of occorrenzeRpc(f.m, nome)) {
        out.push(`${f.percorso}:${r} — la RPC \`${nome}\` si chiama solo da ${p.file.length ? p.file.join(' | ') : 'nessun file di src/ (la chiama il database)'}`)
      }
    }
  }
  return out
}

// ───────────────────────── regola 2 e 3: le scritture ─────────────────────────

type Op = 'insert' | 'upsert' | 'update' | 'delete'
interface Scrittura { tabella: string | null; op: Op; riga: number }

const RE_FROM = /\.\s*from\s*\(/g
const RE_OP = /^(?:\s*as\s+[\w$.<>[\]|, ]+?\))?\s*\.\s*(insert|upsert|update|delete)\s*\(/

/** Ogni `.from(<x>)` seguito subito da `.insert|upsert|update|delete(`; la tabella è il letterale, o `null` se è una variabile. */
function scritture(m: SorgenteMascherato): Scrittura[] {
  const out: Scrittura[] = []
  RE_FROM.lastIndex = 0
  let hit: RegExpExecArray | null
  while ((hit = RE_FROM.exec(m.struttura)) !== null) {
    const apertura = hit.index + hit[0].length - 1
    const fine = fineParentesi(m.struttura, apertura)
    let dopo = fine
    while (dopo < m.struttura.length && /\s/.test(m.struttura[dopo])) dopo++
    const op = RE_OP.exec(m.struttura.slice(dopo, dopo + 80))
    if (!op) continue
    const arg = m.senzaCommenti.slice(apertura + 1, fine - 1).trim()
    const lett = /^(['"`])([A-Za-z_][A-Za-z0-9_]*)\1$/.exec(arg)
    out.push({ tabella: lett ? lett[2] : null, op: op[1] as Op, riga: riga(m.originale, hit.index) })
  }
  return out
}

/** Quante `.from('frequenze')` di QUALSIASI tipo (anche select): serve a dire che il lock ha visto la tabella. */
function usiDiTabella(m: SorgenteMascherato, tabella: string): number {
  return (m.senzaCommenti.match(new RegExp(`\\.\\s*from\\s*\\(\\s*(['"\`])${tabella}\\1\\s*\\)`, 'g')) ?? []).length
}

const DENTRO_ANNO = (p: string) => p.startsWith('src/lib/anno/')

function violazioniFrequenze(files: Sorgente[]): string[] {
  const out: string[] = []
  for (const f of files) {
    if (DENTRO_ANNO(f.percorso)) continue
    for (const s of scritture(f.m)) {
      if (s.tabella === 'frequenze' && (s.op === 'insert' || s.op === 'upsert')) {
        out.push(`${f.percorso}:${s.riga} — \`.from('frequenze').${s.op}\` fuori da src/lib/anno/: la frequenza nasce da anno_registra_frequenza / anno_conferma`)
      }
    }
  }
  return out
}

/** I due soli punti che possono far nascere un `alunni` in_arrivo: una domanda per l'anno prossimo (a mano, o da import). */
const NASCITA_IN_ARRIVO: Record<string, string> = {
  'src/app/api/admin/iscrizioni/route.ts': 'approvazione di una domanda per l’anno prossimo: il bambino nuovo nasce in_arrivo',
  'src/lib/iscrizioni/import/esegui.ts': 'import di una domanda per l’anno prossimo: stesso ramo dell’approvazione a mano',
}
/** Dove `stato: in_arrivo` può comparire come proprietà: i due sopra e il file che definisce la patch di ritorno. */
const SCRIVE_IN_ARRIVO: Record<string, string> = {
  ...NASCITA_IN_ARRIVO,
  'src/lib/anno/domanda-anno-prossimo.ts': 'definisce PATCH_RITORNO_IN_ARRIVO, lo stato di chi torna da fuori',
}
const RE_STATO_IN_ARRIVO = /\bstato\s*:\s*(?:STATO_IN_ARRIVO\b|(['"`])in_arrivo\1)/g

function violazioniInArrivo(files: Sorgente[]): string[] {
  const out: string[] = []
  for (const f of files) {
    RE_STATO_IN_ARRIVO.lastIndex = 0
    const scrive: number[] = []
    let h: RegExpExecArray | null
    while ((h = RE_STATO_IN_ARRIVO.exec(f.m.senzaCommenti)) !== null) scrive.push(riga(f.m.originale, h.index))
    if (scrive.length === 0) continue
    if (!(f.percorso in SCRIVE_IN_ARRIVO)) {
      out.push(`${f.percorso}:${scrive[0]} — scrive \`stato: in_arrivo\` e non è fra i punti ammessi (${Object.keys(SCRIVE_IN_ARRIVO).join(', ')})`)
    }
  }
  // un INSERT su alunni in un file che scrive in_arrivo: lo stato lo porta il record, quindi il controllo è per FILE
  for (const f of files) {
    const nasce = scritture(f.m).filter((s) => s.tabella === 'alunni' && (s.op === 'insert' || s.op === 'upsert'))
    if (nasce.length === 0) continue
    RE_STATO_IN_ARRIVO.lastIndex = 0
    if (RE_STATO_IN_ARRIVO.test(f.m.senzaCommenti) && !(f.percorso in NASCITA_IN_ARRIVO)) {
      out.push(`${f.percorso}:${nasce[0].riga} — \`.from('alunni').${nasce[0].op}\` in un file che scrive \`stato: in_arrivo\`, fuori da ${Object.keys(NASCITA_IN_ARRIVO).join(', ')}`)
    }
  }
  return out
}

// ───────────────────────── i minimi ─────────────────────────

interface Misure {
  fileLetti: number
  occorrenzeRpc: number
  rpcDelleQuattro: number
  usiFrequenze: number
  scrittureAlunniInsert: number
  fileCheScrivonoInArrivo: number
}

function misura(files: Sorgente[]): Misure {
  const quattro = ['anno_registra_frequenza', 'anno_quota_voce', 'anno_conferma', 'anno_non_rinnova']
  let occ = 0
  let q = 0
  let freq = 0
  let alunni = 0
  let inArrivo = 0
  for (const f of files) {
    for (const nome of Object.keys(PORTE)) {
      const n = occorrenzeRpc(f.m, nome).length
      occ += n
      if (quattro.includes(nome)) q += n
    }
    freq += usiDiTabella(f.m, 'frequenze')
    alunni += scritture(f.m).filter((s) => s.tabella === 'alunni' && (s.op === 'insert' || s.op === 'upsert')).length
    RE_STATO_IN_ARRIVO.lastIndex = 0
    if (RE_STATO_IN_ARRIVO.test(f.m.senzaCommenti)) inArrivo++
  }
  return { fileLetti: files.length, occorrenzeRpc: occ, rpcDelleQuattro: q, usiFrequenze: freq, scrittureAlunniInsert: alunni, fileCheScrivonoInArrivo: inArrivo }
}

/**
 * Ogni minimo ha il MISURATO e la DATA. Un minimo che scende si abbassa SCRIVENDO perché sulla stessa riga.
 * Misurato il 2026-11-09 sul ramo della PR 4.5 (1.715 file in src/).
 */
const MINIMI: { chiave: keyof Misure; minimo: number; nota: string }[] = [
  { chiave: 'fileLetti', minimo: 1600, nota: 'misurati 1.715 il 2026-11-09; minimo sotto il misurato apposta (esclude solo la cartella vuota)' },
  { chiave: 'occorrenzeRpc', minimo: 4, nota: 'misurate 4 il 2026-11-09: registra, conferma, non_rinnova nella porta; conta_posti nella route delle conferme' },
  { chiave: 'rpcDelleQuattro', minimo: 3, nota: 'misurate 3 il 2026-11-09 (anno_quota_voce non compare in src/, per costruzione)' },
  { chiave: 'usiFrequenze', minimo: 17, nota: 'misurati 17 il 2026-11-09 (select, update e il resto: il lock ha visto la tabella, anche se oggi nessuno la inserisce)' },
  { chiave: 'scrittureAlunniInsert', minimo: 7, nota: 'misurate 7 il 2026-11-09 (insert e upsert su alunni: iscrizioni/route.ts, students/route.ts, import/esegui.ts, sidi/import-apply.ts e altri)' },
  { chiave: 'fileCheScrivonoInArrivo', minimo: 3, nota: 'misurati 3 il 2026-11-09: iscrizioni/route.ts, import/esegui.ts, domanda-anno-prossimo.ts' },
]

function violazioniMinimi(m: Misure, minimi = MINIMI): string[] {
  return minimi.filter((x) => m[x.chiave] < x.minimo).map((x) => `${x.chiave}: ${m[x.chiave]} < minimo ${x.minimo} (${x.nota})`)
}

// ───────────────────────── la scansione, una volta ─────────────────────────

const FILES: Sorgente[] = fileSorgente(RADICE_SRC).map((f) => ({ percorso: rel(f), m: mascheraSorgente(fs.readFileSync(f, 'utf8')) }))
const finto = (percorso: string, codice: string): Sorgente => ({ percorso, m: mascheraSorgente(codice) })
const elenco = (v: string[]) => (v.length ? '\n  - ' + v.join('\n  - ') : '')

// ───────────────────────── i test ─────────────────────────

describe('iscrizione-anno-una-porta — il controllo positivo, su sorgenti finti', () => {
  it('una RPC chiamata fuori dalla sua porta è segnalata; dentro la porta no; in un commento no', () => {
    expect(violazioniPorte([finto('src/app/api/x/route.ts', "await supabase.rpc('anno_conferma', { p_alunno: 1 })")])).toHaveLength(1)
    expect(violazioniPorte([finto(PORTA_ISCRIZIONE, "await supabase.rpc('anno_conferma', {})")])).toEqual([])
    expect(violazioniPorte([finto('src/app/api/x/route.ts', "// await supabase.rpc('anno_conferma', {})\n/* 'anno_non_rinnova' */")])).toEqual([])
  })

  it('il nome in una costante e poi `rpc(NOME)` è una porta aperta lo stesso', () => {
    const v = violazioniPorte([finto('src/lib/x.ts', "const NOME = 'anno_registra_frequenza'\nawait s.rpc(NOME, {})")])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('anno_registra_frequenza')
  })

  it('anno_quota_voce e anno_quota_collega non si chiamano da src/ in nessun file; anno_conta_posti solo dalla route delle conferme', () => {
    expect(violazioniPorte([finto(PORTA_ISCRIZIONE, "await s.rpc('anno_quota_voce', {})")])).toHaveLength(1)
    expect(violazioniPorte([finto('src/lib/x.ts', 'await s.rpc("anno_quota_collega", {})')])).toHaveLength(1)
    expect(violazioniPorte([finto(ROUTE_CONFERME, "await s.rpc('anno_conta_posti', {})")])).toEqual([])
    expect(violazioniPorte([finto('src/lib/x.ts', "await s.rpc('anno_conta_posti', {})")])).toHaveLength(1)
  })

  it('un nome che ne contiene un altro non scatta (`anno_conferma_x` non è `anno_conferma`)', () => {
    expect(violazioniPorte([finto('src/lib/x.ts', "await s.rpc('anno_conferma_massa', {})")])).toEqual([])
  })

  it('un `.from("frequenze").insert|upsert` fuori da src/lib/anno/ è segnalato; dentro no; un select no', () => {
    expect(violazioniFrequenze([finto('src/app/api/x/route.ts', "await s.from('frequenze').insert({ alunno_id })")])).toHaveLength(1)
    expect(violazioniFrequenze([finto('src/app/api/x/route.ts', "await s\n  .from('frequenze')\n  // un commento in mezzo\n  .upsert({ alunno_id })")])).toHaveLength(1)
    expect(violazioniFrequenze([finto('src/lib/anno/nuovo.ts', "await s.from('frequenze').insert({ alunno_id })")])).toEqual([])
    expect(violazioniFrequenze([finto('src/app/api/x/route.ts', "await s.from('frequenze').select('id').eq('alunno_id', 1)")])).toEqual([])
    expect(violazioniFrequenze([finto('src/app/api/x/route.ts', "// await s.from('frequenze').insert({})")])).toEqual([])
  })

  it('un `alunni` che nasce in_arrivo fuori dai due punti è segnalato (anche con la costante), dentro no', () => {
    const fuori = finto('src/app/api/admin/students/route.ts', "const rec = { nome: 'x', stato: 'in_arrivo' }\nawait s.from('alunni').insert(rec)")
    expect(violazioniInArrivo([fuori]).length).toBeGreaterThanOrEqual(1)
    const conCostante = finto('src/lib/x.ts', "const rec = { stato: STATO_IN_ARRIVO }\nawait s.from('alunni').insert(rec)")
    expect(violazioniInArrivo([conCostante]).length).toBeGreaterThanOrEqual(1)
    const dentro = finto('src/lib/iscrizioni/import/esegui.ts', "const rec = { stato: STATO_IN_ARRIVO }\nawait s.from('alunni').insert(rec)")
    expect(violazioniInArrivo([dentro])).toEqual([])
    const filtro = finto('src/lib/x.ts', "await s.from('alunni').select('id').neq('stato', 'in_arrivo')")
    expect(violazioniInArrivo([filtro])).toEqual([])
    const commento = finto('src/lib/x.ts', "// stato: 'in_arrivo'\nawait s.from('alunni').insert(rec)")
    expect(violazioniInArrivo([commento])).toEqual([])
  })

  it('zero file letti fanno rosso i minimi (la cecità)', () => {
    const v = violazioniMinimi(misura([]))
    expect(v.length).toBe(MINIMI.length)
  })
})

describe('iscrizione-anno-una-porta — il codice di src/', () => {
  it('ogni RPC dell’iscrizione all’anno compare solo nel file che è la sua porta', () => {
    const v = violazioniPorte(FILES)
    expect(
      v,
      `RPC dell'iscrizione all'anno chiamate fuori dalla loro porta (${v.length}). Passa da src/lib/anno/iscrizione-anno.ts: ` +
        `lì il risultato è tipizzato, l'errore è tradotto in un codice e l'evento è loggato.` + elenco(v),
    ).toEqual([])
  })

  it('le porte sono vive: ogni file dichiarato esiste e nomina davvero le sue RPC', () => {
    const per = new Map(FILES.map((f) => [f.percorso, f]))
    for (const [nome, p] of Object.entries(PORTE)) {
      for (const file of p.file) {
        const f = per.get(file)
        expect(f, `${file}: la porta di ${nome} non esiste più`).toBeDefined()
        expect(occorrenzeRpc(f!.m, nome).length, `${file} non chiama più ${nome}: togli la voce da PORTE`).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('nessun `.from("frequenze").insert|upsert` in src/ fuori da src/lib/anno/', () => {
    const v = violazioniFrequenze(FILES)
    expect(v, `Frequenze scritte a mano fuori dal modulo dell'anno (${v.length}).` + elenco(v)).toEqual([])
  })

  it('un `alunni` nasce in_arrivo solo da admin/iscrizioni/route.ts e import/esegui.ts', () => {
    const v = violazioniInArrivo(FILES)
    expect(v, `Il bambino in arrivo nasce da una domanda per l'anno prossimo, in due punti (${v.length}).` + elenco(v)).toEqual([])
  })

  it('i due punti di nascita esistono e scrivono davvero alunni (nessuna eccezione morta)', () => {
    const per = new Map(FILES.map((f) => [f.percorso, f]))
    for (const file of Object.keys(NASCITA_IN_ARRIVO)) {
      const f = per.get(file)
      expect(f, `${file} non esiste più: togli la voce`).toBeDefined()
      expect(scritture(f!.m).some((s) => s.tabella === 'alunni' && s.op === 'insert'), `${file} non inserisce più in alunni`).toBe(true)
      RE_STATO_IN_ARRIVO.lastIndex = 0
      expect(RE_STATO_IN_ARRIVO.test(f!.m.senzaCommenti), `${file} non scrive più stato: in_arrivo`).toBe(true)
    }
  })

  it('MINIMI: il lock ha letto abbastanza (file, RPC, usi di frequenze, insert su alunni)', () => {
    const m = misura(FILES)
    const v = violazioniMinimi(m)
    expect(v, `Il lock ha letto troppo poco (${JSON.stringify(m)}): è cieco, o è sparita una chiamata legittima.` + elenco(v)).toEqual([])
  })

  it('ogni minimo porta accanto il misurato e la data', () => {
    for (const x of MINIMI) expect(x.nota, x.chiave).toMatch(/2026-11-09/)
  })
})
