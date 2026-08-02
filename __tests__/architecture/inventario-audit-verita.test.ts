import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * LOCK — l'inventario dell'audit non può più mentire.
 *
 * ─── Perché esiste ───────────────────────────────────────────────────────────
 * Il 30 luglio 2026 `docs/audit/2026-07-30-isolamento-fra-sedi.md` ha dichiarato
 * **CHIUSE dodici voci che nessuna delle PR d'isolamento aveva toccato**, e una
 * (il vincolo del registro orario) APERTA quando era già risolta. Non per
 * malafede: l'inventario è stato compilato *per intenzione* — l'elenco delle
 * route da correggere è diventato l'elenco delle route corrette, e nessuno l'ha
 * mai confrontato con `git show --name-only`.
 *
 * Un documento che dice il falso su dati di minori è peggio di nessun documento:
 * chi lo legge dopo NON riguarda quelle route, perché risultano fatte. Ed è
 * esattamente quello che è successo — `admin/audit` ha continuato a restituire
 * alla segreteria di un plesso le scritture di tutti gli altri per due giorni,
 * con la sua riga «CHIUSA» accanto.
 *
 * ─── Cosa controlla ──────────────────────────────────────────────────────────
 *  1. Ogni voce dell'inventario nomina una route che **esiste**.
 *  2. Ogni voce **CHIUSA** supera il criterio del lock di copertura
 *     (`isolamento-sede-coverage.test.ts`): nessuna scoperta, oppure una
 *     scoperta ammessa nella SUA allowlist **con la ragione scritta**. Il
 *     criterio non è riscritto qui — è importato — perché due criteri
 *     divergono, e quello scritto dopo è sempre il più debole. Stessa
 *     delimitazione dell'originale: si guardano i file che usano il client
 *     service-role, dove la RLS è scavalcata per costruzione.
 *  3. Ogni voce CHIUSA **cita un commit** (sha + data) che ha **davvero toccato
 *     quel file**. È l'unico controllo che avrebbe visto il difetto del 30/07:
 *     oggi il codice di tutte quelle route è a posto — l'hanno corretto le
 *     ondate del 31 — quindi il criterio del punto 2, da solo, le promuoverebbe
 *     tutte. Solo il commit distingue «corretta» da «dichiarata corretta».
 *  4. Nessuna route è dichiarata chiusa **fuori** dall'inventario: altrimenti
 *     basterebbe spostare la riga in un paragrafo di prosa per non essere letti.
 *
 * ─── Quello che questo lock NON può dire ─────────────────────────────────────
 * Il criterio del punto 2 vede solo ciò che il lock di copertura vede: query su
 * tabelle sensibili, nei file service-role. Una route che non nomina nessuna
 * tabella — è il caso di `admin/credentials-pdf`, che autorizza un download di
 * storage — lo supera qualunque cosa faccia. Per quelle resta il punto 3:
 * qualcuno ha toccato quel file, e si sa quando. È poco, ma è verificabile, e
 * il documento lo dichiara riga per riga invece di lasciarlo intendere.
 *
 * ─── Il formato ──────────────────────────────────────────────────────────────
 * L'inventario sta fra i marcatori `<!-- INVENTARIO:INIZIO -->` e
 * `<!-- INVENTARIO:FINE -->`, ed è fatto di righe di tabella:
 *
 *   | `admin/audit` | CHIUSA | `fb20145` 2026-07-31 | cosa perdeva |
 *
 * prima cella = la route (in backtick), seconda = lo stato, terza = la prova.
 * Una riga per route, di proposito: una citazione che vale «per una delle tre
 * route della riga» non è una citazione.
 */

const DOC = path.join(process.cwd(), 'docs', 'audit', '2026-07-30-isolamento-fra-sedi.md')
const LOCK_COPERTURA = path.join(process.cwd(), '__tests__', 'architecture', 'isolamento-sede-coverage.test.ts')
const API = path.join(process.cwd(), 'src', 'app', 'api')

const INIZIO = '<!-- INVENTARIO:INIZIO'
const FINE = '<!-- INVENTARIO:FINE -->'

/** La stessa delimitazione del lock di copertura: solo chi scavalca la RLS. */
const USA_SERVICE_ROLE = /createAdminClient\s*\(|SUPABASE_SERVICE_ROLE_KEY/

/** Una ragione di allowlist più corta di così non è una ragione. */
const RAGIONE_MINIMA = 20

// ─────────────────────────────────────────────────────────────────────────────
// Lettura del documento
// ─────────────────────────────────────────────────────────────────────────────

export interface Voce {
    route: string
    stato: 'CHIUSA' | 'APERTA' | 'N/A'
    prova: string
    riga: number
}

/** Le celle di una riga di tabella markdown, senza le pipe di bordo. */
function celle(riga: string): string[] {
    const t = riga.trim()
    if (!t.startsWith('|')) return []
    return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

/** I nomi di route citati in backtick in una cella: `admin/students/[id]`. */
function routeInBacktick(cella: string): string[] {
    return [...cella.matchAll(/`([A-Za-z0-9._[\]-]+(?:\/[A-Za-z0-9._[\]-]+)*)`/g)].map((m) => m[1])
}

const STATI = /\b(CHIUSA|CHIUSE|APERTA|APERTE|N\/A)\b/

/** Le voci dell'inventario, una per riga di tabella. */
export function vociInventario(markdown: string): Voce[] {
    const righe = markdown.split('\n')
    const da = righe.findIndex((r) => r.includes(INIZIO))
    const a = righe.findIndex((r) => r.includes(FINE))
    if (da < 0 || a < 0) return []
    const out: Voce[] = []
    for (let i = da + 1; i < a; i++) {
        const c = celle(righe[i])
        if (c.length < 3) continue
        // Riga separatrice `|---|---|` e intestazione.
        if (/^-{2,}$/.test(c[0].replace(/:/g, ''))) continue
        const stato = STATI.exec(c[1])?.[1]
        if (!stato) continue
        const normale = (stato === 'CHIUSE' ? 'CHIUSA' : stato === 'APERTE' ? 'APERTA' : stato) as Voce['stato']
        for (const route of routeInBacktick(c[0])) {
            out.push({ route, stato: normale, prova: c[2], riga: i + 1 })
        }
    }
    return out
}

/**
 * L'allowlist del lock di copertura, letta dal suo SORGENTE.
 *
 * Non è esportata da quel file, e va bene così: leggerla come testo è anche il
 * solo modo di verificare che la ragione ci sia **scritta**, e non sia una
 * stringa vuota messa lì per far tacere il test.
 */
export function allowlistDiCopertura(sorgente: string): Record<string, string> {
    const blocco = /const AMMESSE: Record<string, string> = \{([\s\S]*?)\n\}/.exec(sorgente)
    if (!blocco) return {}
    const out: Record<string, string> = {}
    for (const m of blocco[1].matchAll(/^\s*'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gm)) {
        out[m[1]] = m[2] ?? m[3] ?? ''
    }
    return out
}

// ─────────────────────────────────────────────────────────────────────────────
// I due criteri, come funzioni pure — così i loro rami ROSSI si dimostrano
// (in fondo al file) invece di essere solo dichiarati.
// ─────────────────────────────────────────────────────────────────────────────

export type Rilevatore = (src: string) => { handler: string; riga: number; tabella: string; motivo: string }[]

/**
 * Le voci CHIUSA che il criterio del lock di copertura NON considera coperte.
 * `leggi` restituisce il sorgente della route, o `null` se il file non c'è.
 */
export function bugieDiCopertura(
    voci: Voce[],
    leggi: (route: string) => string | null,
    ammesse: Record<string, string>,
    rileva: Rilevatore,
): string[] {
    const out: string[] = []
    for (const v of voci) {
        if (v.stato !== 'CHIUSA') continue
        const src = leggi(v.route)
        if (src === null) continue // segnalato dal test sull'esistenza
        if (!USA_SERVICE_ROLE.test(src)) continue // fuori dal perimetro del criterio originale
        for (const s of rileva(src)) {
            const chiave = `${v.route}:${s.handler}`
            const ragione = ammesse[chiave]
            if (ragione === undefined) {
                out.push(
                    `riga ${v.riga}: \`${v.route}\` è marcata CHIUSA ma ${s.handler} non dichiara la sede ` +
                    `(${s.motivo} su \`${s.tabella}\`, riga ${s.riga} del file)`,
                )
            } else if (ragione.trim().length < RAGIONE_MINIMA) {
                out.push(
                    `riga ${v.riga}: \`${v.route}\` è CHIUSA solo grazie a un'esenzione senza ragione scritta ` +
                    `(AMMESSE['${chiave}'] = «${ragione}»)`,
                )
            }
        }
    }
    return out
}

const SHA = /`([0-9a-f]{7,40})`/g
const DATA = /\b20\d{2}-\d{2}-\d{2}\b/

export interface EsitoCitazioni {
    senzaProva: string[]
    commitCheNonTocca: string[]
    shaVerificati: number
}

/**
 * Le voci CHIUSA la cui citazione non regge. `fileDi(sha)` restituisce i file
 * toccati da quel commit, oppure `null` quando la storia non è disponibile
 * (repo shallow): in quel caso resta il controllo di FORMA, che è deterministico.
 */
export function bugieDiCitazione(voci: Voce[], fileDi: (sha: string) => string[] | null): EsitoCitazioni {
    const senzaProva: string[] = []
    const commitCheNonTocca: string[] = []
    let shaVerificati = 0
    for (const v of voci) {
        if (v.stato !== 'CHIUSA') continue
        const sha = [...v.prova.matchAll(SHA)].map((m) => m[1])
        if (sha.length === 0 || !DATA.test(v.prova)) {
            senzaProva.push(
                `riga ${v.riga}: \`${v.route}\` — la prova è «${v.prova}». Serve almeno uno sha fra backtick e ` +
                'la data (AAAA-MM-GG). «PR #60» non è una prova: è stato esattamente il modo in cui dodici voci ' +
                'false sono passate.',
            )
            continue
        }
        const atteso = `src/app/api/${v.route}/route.ts`
        for (const s of sha) {
            const toccati = fileDi(s)
            if (toccati === null) continue // storia non disponibile: non è colpa del documento
            shaVerificati++
            if (!toccati.includes(atteso)) {
                commitCheNonTocca.push(`riga ${v.riga}: \`${v.route}\` cita ${s}, che NON ha toccato ${atteso}`)
            }
        }
    }
    return { senzaProva, commitCheNonTocca, shaVerificati }
}

// ─────────────────────────────────────────────────────────────────────────────
// Git: quali file ha toccato un commit
// ─────────────────────────────────────────────────────────────────────────────

const cacheCommit = new Map<string, string[] | null>()

/**
 * I file toccati da un commit — `null` se non è possibile saperlo (repo shallow,
 * commit non raggiungibile, git assente). La CI fa il checkout con la profondità
 * predefinita (1 commit): lì la storia NON c'è, e un lock che pretendesse di
 * leggerla sarebbe rosso per un motivo che non riguarda nessuno.
 */
export function fileDelCommit(sha: string): string[] | null {
    if (cacheCommit.has(sha)) return cacheCommit.get(sha)!
    let esito: string[] | null = null
    try {
        const out = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', sha], {
            cwd: process.cwd(),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        })
        esito = out.split('\n').map((r) => r.trim()).filter(Boolean)
    } catch {
        esito = null
    }
    cacheCommit.set(sha, esito)
    return esito
}

function storiaCompleta(): boolean {
    try {
        return execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() === 'false'
    } catch {
        return false
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// I TEST
// ─────────────────────────────────────────────────────────────────────────────

const markdown = fs.readFileSync(DOC, 'utf8')
const AMMESSE = allowlistDiCopertura(fs.readFileSync(LOCK_COPERTURA, 'utf8'))
const VOCI = vociInventario(markdown)
const CHIUSE = VOCI.filter((v) => v.stato === 'CHIUSA')

const fileRoute = (route: string) => path.join(API, route, 'route.ts')
const leggiRoute = (route: string) => (fs.existsSync(fileRoute(route)) ? fs.readFileSync(fileRoute(route), 'utf8') : null)

/**
 * Il rilevatore del lock di copertura, caricato DOPO la fase di raccolta: un
 * import statico registrerebbe qui anche i venti test di quel file, che
 * girerebbero due volte e renderebbero questo lock rosso per colpa d'altri.
 */
let scoperte: Rilevatore

beforeAll(async () => {
    const mod = await import('./isolamento-sede-coverage.test')
    scoperte = mod.scoperte as never
})

describe('inventario dell audit — le voci CHIUSA dicono la verità', () => {
    it('il criterio riusato è QUELLO del lock di copertura, ed è vivo', () => {
        // Se l'import fallisse, i test qui sotto diventerebbero verdi senza
        // controllare niente: è il modo più silenzioso di disattivare un lock.
        // Perciò si prova il rilevatore su una forma vietata nota.
        expect(typeof scoperte, 'il rilevatore di `isolamento-sede-coverage.test.ts` non si è caricato').toBe('function')
        const nudo = `
      export const GET = withRoute('admin/audit:GET', async (request) => {
        const supabase = await createAdminClient()
        const { data } = await supabase.from('audit_scritture_docente').select('id')
      })
    `
        expect(scoperte(nudo).map((s) => s.motivo)).toEqual(['elenco-senza-sede'])
        // E l'allowlist dev'essere quella vera, non un oggetto vuoto letto male.
        expect(Object.keys(AMMESSE).length).toBeGreaterThan(90)
    })

    it("l'inventario esiste, è delimitato e ha dentro delle voci (se cade, il lock non guarda niente)", () => {
        expect(
            markdown.includes(INIZIO) && markdown.includes(FINE),
            `L'inventario deve stare fra ${INIZIO} … --> e ${FINE}: è la parte del documento che questo lock legge.`,
        ).toBe(true)
        expect(VOCI.length, "Nessuna voce riconosciuta: formato dell'inventario cambiato?").toBeGreaterThan(60)
        expect(CHIUSE.length).toBeGreaterThan(55)
        expect(
            VOCI.filter((v) => !fs.existsSync(fileRoute(v.route))).map((v) => `riga ${v.riga}: ${v.route}`),
            "Voci che nominano una route inesistente: il file è stato spostato o cancellato e l'inventario è rimasto indietro.",
        ).toEqual([])
    })

    it('ogni voce CHIUSA supera il criterio del lock di copertura (o è ammessa CON la ragione scritta)', () => {
        expect(
            bugieDiCopertura(VOCI, leggiRoute, AMMESSE, scoperte),
            "Voci dichiarate CHIUSA nel documento d'audit che il lock di copertura NON considera coperte. " +
            'O si corregge il codice, o la voce torna APERTA: «per intenzione» non è uno stato.',
        ).toEqual([])
    })

    it('ogni voce CHIUSA cita un commit che ha davvero toccato quel file', () => {
        const completa = storiaCompleta()
        const esito = bugieDiCitazione(VOCI, (sha) => (completa ? fileDelCommit(sha) : null))
        expect(esito.senzaProva, 'Voci CHIUSA senza commit citato.').toEqual([])
        expect(
            esito.commitCheNonTocca,
            'Voci CHIUSA il cui commit non ha mai toccato quel file. È il difetto del 30/07 alla lettera: ' +
            "l'inventario scritto per intenzione e non per diff.",
        ).toEqual([])
        if (completa) {
            expect(esito.shaVerificati, 'Nessuno sha verificato contro git: il controllo si sta autoingannando.')
                .toBeGreaterThan(50)
        }
    })

    it('nessuna route è dichiarata chiusa FUORI dall inventario', () => {
        const righe = markdown.split('\n')
        const da = righe.findIndex((r) => r.includes(INIZIO))
        const a = righe.findIndex((r) => r.includes(FINE))
        const fuori: string[] = []
        for (let i = 0; i < righe.length; i++) {
            if (i > da && i < a) continue
            // Tutte le desinenze, non solo il femminile: «`admin/audit` è chiuso»
            // aggirerebbe un controllo scritto sulla sola parola «CHIUSA».
            if (!/\bCHIUS[AEIO]\b/.test(righe[i])) continue
            const route = routeInBacktick(righe[i]).filter((n) => fs.existsSync(fileRoute(n)))
            if (route.length > 0) fuori.push(`riga ${i + 1}: ${route.join(', ')}`)
        }
        expect(
            fuori,
            "Route dichiarate chiuse in prosa, fuori dall'inventario: lì nessun lock le controlla, ed è la " +
            'scorciatoia più naturale per rimettere in circolo una riga falsa. Spostale nella tabella.',
        ).toEqual([])
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROVA DI VALIDITÀ PERMANENTE
//
// I due criteri qui sopra oggi sono verdi perché il documento è stato
// riallineato. Un lock verde perché tutto è a posto e un lock verde perché non
// guarda più niente, dall'esterno, sono identici: questi test tengono ferme le
// forme che DEVE segnalare. Sono le due bugie del 30/07, scritte in piccolo.
// ─────────────────────────────────────────────────────────────────────────────

const VOCE = (over: Partial<Voce> = {}): Voce =>
    ({ route: 'admin/audit', stato: 'CHIUSA', prova: '`fb20145` 2026-07-31', riga: 1, ...over })

const NUDA = `
  export const GET = withRoute('admin/audit:GET', async (request) => {
    const supabase = await createAdminClient()
    const { data } = await supabase.from('audit_scritture_docente').select('id')
  })
`
const CON_SEDE = `
  export const GET = withRoute('admin/audit:GET', async (request) => {
    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)
    const { data } = await supabase.from('audit_scritture_docente').select('id').in('scuola_id', sedi)
  })
`

describe('il lock riconosce la voce falsa', () => {
    it('CHIUSA su una route che non dichiara la sede', () => {
        const bugie = bugieDiCopertura([VOCE()], () => NUDA, {}, scoperte)
        expect(bugie).toHaveLength(1)
        expect(bugie[0]).toContain('admin/audit')
        expect(bugie[0]).toContain('elenco-senza-sede')
    })

    it("CHIUSA grazie a un'esenzione senza ragione scritta", () => {
        expect(bugieDiCopertura([VOCE()], () => NUDA, { 'admin/audit:GET': 'ok' }, scoperte)).toHaveLength(1)
        expect(bugieDiCopertura([VOCE()], () => NUDA, { 'admin/audit:GET': '' }, scoperte)).toHaveLength(1)
    })

    it('CHIUSA che cita un commit il quale non ha mai toccato quel file (il difetto del 30/07)', () => {
        const esito = bugieDiCitazione([VOCE()], () => ['src/app/api/notes/route.ts'])
        expect(esito.commitCheNonTocca).toHaveLength(1)
        expect(esito.commitCheNonTocca[0]).toContain('admin/audit')
        expect(esito.commitCheNonTocca[0]).toContain('fb20145')
    })

    it('CHIUSA con «PR #60» al posto dello sha', () => {
        const esito = bugieDiCitazione([VOCE({ prova: 'PR #60' })], () => ['src/app/api/admin/audit/route.ts'])
        expect(esito.senzaProva).toHaveLength(1)
        expect(esito.senzaProva[0]).toContain('admin/audit')
    })

    it('CHIUSA con lo sha ma senza data', () => {
        const esito = bugieDiCitazione([VOCE({ prova: '`fb20145` (PR #60)' })], () => ['src/app/api/admin/audit/route.ts'])
        expect(esito.senzaProva).toHaveLength(1)
    })
})

describe('il lock NON segnala le voci vere', () => {
    it('CHIUSA su una route che filtra per sede', () => {
        expect(bugieDiCopertura([VOCE()], () => CON_SEDE, {}, scoperte)).toEqual([])
    })

    it("CHIUSA su una route scoperta ma ammessa CON la ragione per esteso", () => {
        const ammesse = { 'admin/audit:GET': 'estratto conto unico: le righe bancarie non hanno sede finché non sono abbinate' }
        expect(bugieDiCopertura([VOCE()], () => NUDA, ammesse, scoperte)).toEqual([])
    })

    it('CHIUSA con commit e data corretti', () => {
        const esito = bugieDiCitazione([VOCE()], () => ['src/app/api/admin/audit/route.ts'])
        expect(esito).toEqual({ senzaProva: [], commitCheNonTocca: [], shaVerificati: 1 })
    })

    it('APERTA e N/A non pretendono nessuna prova', () => {
        const voci = [VOCE({ stato: 'APERTA', prova: '—' }), VOCE({ stato: 'N/A', prova: '—' })]
        expect(bugieDiCopertura(voci, () => NUDA, {}, scoperte)).toEqual([])
        expect(bugieDiCitazione(voci, () => []).senzaProva).toEqual([])
    })

    it('storia git non disponibile (CI shallow): resta il controllo di forma, e non fallisce', () => {
        const esito = bugieDiCitazione([VOCE(), VOCE({ prova: 'PR #60' })], () => null)
        expect(esito.shaVerificati).toBe(0)
        expect(esito.commitCheNonTocca).toEqual([])
        expect(esito.senzaProva).toHaveLength(1) // la forma si controlla comunque
    })

    it('una route che non usa il service-role è fuori dal criterio (come nel lock di copertura)', () => {
        const conRls = `
      export const GET = withRoute('parent/qualcosa:GET', async (request) => {
        const supabase = await createClient()
        const { data } = await supabase.from('audit_scritture_docente').select('id')
      })
    `
        expect(bugieDiCopertura([VOCE()], () => conRls, {}, scoperte)).toEqual([])
    })
})
