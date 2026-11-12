import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * COMPITO 4.9.3 · OGNI SCRITTURA DELLO STAFF CHE CHIAMA `resolveAnnoScrittura` SA CHIEDERE LA CORREZIONE, O DICE PERCHÉ NO.
 *
 * Su un anno `chiuso` la Direzione e la segreteria scrivono solo registrando una correzione (un gettone con un motivo). Perché il
 * dialogo «Registra come correzione» funzioni, la route deve (1) accettare `correzione` nel corpo (`zCorrezione`) e (2) passarla a
 * `resolveAnnoScrittura({ correzione })`: la CHIAVE `correzione` nelle opzioni è anche il segnale con cui il 409 `ANNO_CHIUSO` dice
 * `correzione_possibile: true`. Una route che chiama `resolveAnnoScrittura` senza saper correggere, a guardia accesa, lascia lo
 * staff davanti a un 409 che non può superare: va bene SOLO se è scritto qui, con la ragione.
 *
 * Il lock esamina ogni file di `src/` che CHIAMA `resolveAnnoScrittura(` (commenti tolti) e, per ciascuno:
 *  - se è fra le eccezioni (`SENZA_CORREZIONE`): la ragione c'è, e il file NON passa `correzione` (un'eccezione che il codice ha
 *    superato va tolta dall'elenco, non lasciata a coprire un file cambiato);
 *  - altrimenti: OGNI chiamata passa `correzione` nelle opzioni, e il file nomina `zCorrezione` (lo schema del corpo).
 *
 * ─── PERCHÉ NON È CIECO ───────────────────────────────────────────────────────
 * Dichiara un minimo di file esaminati e un minimo di file collegati (se `src/` cambiasse forma e lo scan vedesse zero route, sarebbe
 * verde per costruzione), e ha il suo controllo positivo su sorgenti finte. NON vede: una route che costruisce le opzioni in una
 * variabile e le passa per nome (`resolveAnnoScrittura(…, opzioni)`): lì il lock chiede che la chiamata contenga `correzione`, e una
 * variabile non la contiene. Si scrive la chiave nel punto della chiamata.
 */

const CWD = process.cwd()
const SRC = path.join(CWD, 'src')

/** I file che chiamano `resolveAnnoScrittura` senza saper correggere, e perché. */
const SENZA_CORREZIONE: Record<string, string> = {
  'src/app/api/admin/sections/route.ts':
    'Crea una classe nell’anno dichiarato. Una classe non si crea in un anno chiuso: si crea nell’anno che comincia. Nessuna correzione da registrare.',
  'src/app/api/admin/iscrizioni/elenco/route.ts':
    'Il caricamento dell’elenco degli iscritti vale per l’anno che si sta aprendo; su un anno chiuso non c’è niente da caricare e un gettone non lo renderebbe sensato.',
  'src/lib/crm/anno-bambini.ts':
    'Scrive sempre nell’anno `corrente` della sede (`dichiarato: corrente.annoId`): non arriva mai a un anno chiuso.',
  'src/lib/crm/anno-scheda.ts':
    'Scrive nell’anno della scheda del CRM, che è l’anno in cui la famiglia si sta iscrivendo (corrente o in preparazione), mai un anno chiuso.',
}

/** Dove sta lo schema del corpo, quando non è nel file della route (le votazioni hanno i loro schemi in `lib/votazioni/schemi.ts`). */
const SCHEMA_ALTROVE: Record<string, string> = {
  'src/app/api/admin/votazioni/route.ts': 'src/lib/votazioni/schemi.ts',
  'src/app/api/admin/votazioni/[id]/route.ts': 'src/lib/votazioni/schemi.ts',
}

const MIN_FILE_ESAMINATI = 7
const MIN_FILE_COLLEGATI = 4

function togliCommentiTs(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

function filesTs(dir: string, fuori: string[] = []): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...filesTs(p, fuori))
    else if (/\.(ts|tsx)$/.test(e.name) && !fuori.includes(p)) out.push(p)
  }
  return out
}

/** Gli argomenti (testo) di ogni CHIAMATA a `resolveAnnoScrittura(` nel sorgente, con le parentesi bilanciate. */
function chiamate(sorgente: string): string[] {
  const t = togliCommentiTs(sorgente)
  const out: string[] = []
  const re = /resolveAnnoScrittura\s*\(/g
  let h: RegExpExecArray | null
  while ((h = re.exec(t)) !== null) {
    const prima = t.slice(Math.max(0, h.index - 24), h.index)
    if (/function\s+$/.test(prima) || /import[^;]*$/.test(prima)) continue
    let livello = 1
    let i = h.index + h[0].length
    const inizio = i
    while (i < t.length && livello > 0) {
      const c = t[i++]
      if (c === '(') livello++
      else if (c === ')') livello--
    }
    out.push(t.slice(inizio, i - 1))
  }
  return out
}

interface Esame {
  file: string
  chiamate: number
  tutteConCorrezione: boolean
  nominaSchema: boolean
}

function esamina(file: string, sorgente: string, sorgenteSchema = ''): Esame | null {
  const c = chiamate(sorgente)
  if (c.length === 0) return null
  return {
    file,
    chiamate: c.length,
    tutteConCorrezione: c.every((a) => /\bcorrezione\b/.test(a)),
    // Fuori dalle righe `import`: importarlo e non usarlo non è avere lo schema.
    nominaSchema: /\bzCorrezione\b/.test(togliCommentiTs(sorgente + '\n' + sorgenteSchema).replace(/^\s*import[^\n]*$/gm, ' ')),
  }
}

function problemi(esami: Esame[]): string[] {
  const out: string[] = []
  for (const e of esami) {
    const eccezione = SENZA_CORREZIONE[e.file]
    if (eccezione !== undefined) {
      if (eccezione.trim().length < 20) out.push(`${e.file}: eccezione senza ragione`)
      if (e.tutteConCorrezione) out.push(`${e.file}: ora passa \`correzione\`, toglilo da SENZA_CORREZIONE`)
      continue
    }
    if (!e.tutteConCorrezione) out.push(`${e.file}: una chiamata a resolveAnnoScrittura non passa \`correzione\``)
    if (!e.nominaSchema) out.push(`${e.file}: non nomina zCorrezione (lo schema del corpo)`)
  }
  return out
}

function esamiDelRepo(): Esame[] {
  const scope = path.join(SRC, 'lib', 'auth', 'scope.ts')
  const out: Esame[] = []
  for (const p of filesTs(SRC, [scope])) {
    const rel = path.relative(CWD, p).split(path.sep).join('/')
    const altrove = SCHEMA_ALTROVE[rel]
    const e = esamina(rel, fs.readFileSync(p, 'utf8'), altrove ? fs.readFileSync(path.join(CWD, altrove), 'utf8') : '')
    if (e) out.push(e)
  }
  return out
}

describe('anno · ogni scrittura dello staff sa chiedere la correzione, o dice perché no', () => {
  const esami = esamiDelRepo()

  it('non è cieco: ha esaminato abbastanza file e ne ha trovati abbastanza collegati', () => {
    expect(esami.length).toBeGreaterThanOrEqual(MIN_FILE_ESAMINATI)
    expect(esami.filter((e) => e.tutteConCorrezione).length).toBeGreaterThanOrEqual(MIN_FILE_COLLEGATI)
  })

  it('le route collegate sono quelle del piano (POST, PATCH e DELETE dei periodi; creazione, chiusura, proroga ed eliminazione delle votazioni)', () => {
    const collegati = esami.filter((e) => e.tutteConCorrezione).map((e) => e.file).sort()
    expect(collegati).toEqual([
      'src/app/api/admin/competenze/route.ts',
      'src/app/api/admin/primaria/scrutinio-periodi/route.ts',
      'src/app/api/admin/votazioni/[id]/route.ts',
      'src/app/api/admin/votazioni/route.ts',
    ])
  })

  it('PATCH e DELETE passano dal gancio che dichiara l’anno della riga (non solo il POST)', () => {
    // La chiamata a `resolveAnnoScrittura` sta nel gancio; qui si controlla che ogni handler di modifica/eliminazione lo chiami.
    const gancio: Record<string, [string, number]> = {
      'src/app/api/admin/primaria/scrutinio-periodi/route.ts': ['clientPerPeriodo', 2], // PATCH e DELETE
      'src/app/api/admin/votazioni/[id]/route.ts': ['clientPerVotazione', 2], // PATCH (chiudi, proroga) e DELETE
    }
    for (const [file, [nome, minimo]] of Object.entries(gancio)) {
      const t = togliCommentiTs(fs.readFileSync(path.join(CWD, file), 'utf8'))
      const usi = (t.match(new RegExp(`await\\s+${nome}\\s*\\(`, 'g')) ?? []).length
      expect(usi, `${file}: ${nome} chiamato ${usi} volte`).toBeGreaterThanOrEqual(minimo)
    }
  })

  it('nessun problema nel repo', () => {
    expect(problemi(esami)).toEqual([])
  })

  it('ogni eccezione elencata esiste ancora (una ragione per un file sparito è un lock che non guarda più niente)', () => {
    const visti = new Set(esami.map((e) => e.file))
    for (const f of Object.keys(SENZA_CORREZIONE)) expect(visti.has(f), f).toBe(true)
  })
})

describe('anno-correzione-wiring · il controllo positivo, su sorgenti finte', () => {
  const buona = `
    import { zCorrezione } from '@/lib/anno/correzione'
    const s = z.object({ correzione: zCorrezione.optional() })
    const esito = await resolveAnnoScrittura(request, supabase, user, sede, { dichiarato, correzione: b.data.correzione })
  `
  it('una route che passa `correzione` e nomina lo schema non dà problemi', () => {
    const e = esamina('src/finta/route.ts', buona)!
    expect(problemi([e])).toEqual([])
  })

  it('importare `zCorrezione` senza usarlo non è avere lo schema', () => {
    const senzaUso = buona.replace('const s = z.object({ correzione: zCorrezione.optional() })', '')
    expect(problemi([esamina('src/finta/route.ts', senzaUso)!])).toEqual(['src/finta/route.ts: non nomina zCorrezione (lo schema del corpo)'])
  })

  it('togliere `zCorrezione` dal corpo è rosso', () => {
    const senza = buona.replace(/zCorrezione/g, 'z.unknown()')
    expect(problemi([esamina('src/finta/route.ts', senza)!])).toEqual(['src/finta/route.ts: non nomina zCorrezione (lo schema del corpo)'])
  })

  it('togliere `correzione` dalla chiamata è rosso', () => {
    const senza = buona.replace(', correzione: b.data.correzione', '')
    expect(problemi([esamina('src/finta/route.ts', senza)!])).toEqual(['src/finta/route.ts: una chiamata a resolveAnnoScrittura non passa `correzione`'])
  })

  it('una sola chiamata senza `correzione` su due è rossa', () => {
    const due = buona + `\n const e2 = await resolveAnnoScrittura(request, supabase, user, sede, { usi: 1 })\n`
    expect(problemi([esamina('src/finta/route.ts', due)!])).toEqual(['src/finta/route.ts: una chiamata a resolveAnnoScrittura non passa `correzione`'])
  })

  it('`correzione` solo in un commento non vale', () => {
    const solo = `import { zCorrezione } from 'x'\nconst c = zCorrezione.optional()\n// correzione\nawait resolveAnnoScrittura(r, s, u, sede, { usi: 1 /* correzione */ })`
    expect(problemi([esamina('src/finta/route.ts', solo)!])).toEqual(['src/finta/route.ts: una chiamata a resolveAnnoScrittura non passa `correzione`'])
  })

  it('la definizione della funzione e l’import non sono chiamate', () => {
    expect(chiamate(`import { resolveAnnoScrittura } from '@/lib/auth/scope'\nexport async function resolveAnnoScrittura(a, b) {}`)).toEqual([])
  })

  it('un file che non chiama la funzione non è esaminato', () => {
    expect(esamina('src/finta/altro.ts', 'export const x = 1')).toBeNull()
  })
})
