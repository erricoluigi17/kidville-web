import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK · nessuna coppia di policy RLS si legge a vicenda (Postgres 42P17)
//
// IL DIFETTO, misurato sul database di produzione il 2026-07-31:
//
//   public.pagamenti       · «parent read pagamenti figli»
//        USING (… EXISTS (SELECT 1 FROM pagamenti_quote q WHERE q.pagamento_id = pagamenti.id …))
//   public.pagamenti_quote · «parent read quote figli (parents space)»
//        USING (pagamento_id IN (SELECT pg.id FROM pagamenti pg WHERE …))
//
// Leggere `pagamenti` obbliga Postgres a valutare la policy di `pagamenti_quote`,
// che per essere valutata deve leggere `pagamenti`: cerchio chiuso. Il motore se
// ne accorge e ABORTISCE la query —
//     ERROR: 42P17: infinite recursion detected in policy for relation "pagamenti"
// — per il genitore e per QUALUNQUE lettura che passi dalla RLS (le sottoscrizioni
// realtime su pagamenti/incassi, per esempio). Non è una fuga di dati: nega tutto.
// Ma nega anche in silenzio, perché nessun test guardava le policy.
//
// PERCHÉ UN LOCK STATICO. La ricorsione non si vede leggendo una policy sola: le due
// metà del cerchio stanno su due tabelle diverse, spesso scritte in momenti diversi
// da mani diverse (qui: una nel baseline, l'altra nello «spazio parents»). Serve
// qualcosa che guardi la coppia. Questo test ricostruisce dalle migrazioni lo stato
// finale delle policy — l'ultima `CREATE POLICY` vince, `DROP POLICY` cancella — e
// costruisce il grafo «la policy sulla tabella A nomina la tabella B». Un ciclo su
// quel grafo è un 42P17 che aspetta solo la prima lettura.
//
// COSA NON GUARDA. Le funzioni `SECURITY DEFINER` (`current_parent_student_ids()`)
// saltano la RLS della tabella che interrogano: passare da lì è la via d'uscita
// legittima da un cerchio, e infatti una policy che nomina solo funzioni non crea
// archi. E non guarda i riferimenti a tabelle SENZA policy: se B non ha policy, la
// sua RLS non ha niente da valutare e il cerchio non si chiude.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

/** `"nome con spazi"` → `nome con spazi`; `nome` → `nome`. */
function senzaVirgolette(id: string): string {
  return id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id
}

/** `public.pagamenti` → `pagamenti`. */
function senzaSchema(t: string): string {
  return t.includes('.') ? t.split('.').pop()! : t
}

type Policy = { tabella: string; nome: string; corpo: string; file: string }

/**
 * Stato finale delle policy secondo le migrazioni, applicate in ordine di timestamp
 * (il nome del file È l'ordine) e, dentro un file, in ordine di apparizione.
 */
function policyAttive(): Map<string, Policy> {
  const attive = new Map<string, Policy>()
  const files = readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort()
  const re =
    /(CREATE|DROP)\s+POLICY\s+(?:IF\s+EXISTS\s+)?("(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s+ON\s+((?:[A-Za-z_][\w$]*\.)?[A-Za-z_][\w$]*)([\s\S]*?);/gi

  for (const file of files) {
    const sql = readFileSync(join(MIGRAZIONI, file), 'utf8')
    // Via i commenti di riga: un `-- CREATE POLICY …` in una spiegazione non è SQL.
    const pulito = sql.replace(/--[^\n]*/g, '')
    for (const m of pulito.matchAll(re)) {
      const [, verbo, nomeGrezzo, tabellaGrezza, corpo] = m
      const tabella = senzaSchema(tabellaGrezza)
      const chiave = `${tabella} · ${senzaVirgolette(nomeGrezzo)}`
      if (verbo.toUpperCase() === 'DROP') attive.delete(chiave)
      else attive.set(chiave, { tabella, nome: senzaVirgolette(nomeGrezzo), corpo, file })
    }
  }
  return attive
}

const ATTIVE = policyAttive()
/** Solo le tabelle con almeno una policy possono chiudere un cerchio. */
const TABELLE_CON_POLICY = new Set([...ATTIVE.values()].map((p) => p.tabella))

/** Le tabelle-con-policy nominate dal corpo di una policy, esclusa la sua. */
function tabelleNominate(p: Policy): string[] {
  const out: string[] = []
  for (const t of TABELLE_CON_POLICY) {
    if (t === p.tabella) continue
    if (new RegExp(`\\b${t}\\b`).test(p.corpo)) out.push(t)
  }
  return out
}

/** Grafo «tabella → tabelle lette dalle sue policy» + chi ha creato ogni arco. */
function grafo(): { archi: Map<string, Set<string>>; perche: Map<string, Policy[]> } {
  const archi = new Map<string, Set<string>>()
  const perche = new Map<string, Policy[]>()
  for (const p of ATTIVE.values()) {
    for (const t of tabelleNominate(p)) {
      if (!archi.has(p.tabella)) archi.set(p.tabella, new Set())
      archi.get(p.tabella)!.add(t)
      const k = `${p.tabella}→${t}`
      perche.set(k, [...(perche.get(k) ?? []), p])
    }
  }
  return { archi, perche }
}

/** Tutti i cicli del grafo, come percorsi `a → b → a`. */
function cicli(archi: Map<string, Set<string>>): string[][] {
  const trovati: string[][] = []
  const visti = new Set<string>()
  const inPila = new Set<string>()
  const pila: string[] = []

  const scendi = (nodo: string) => {
    visti.add(nodo)
    inPila.add(nodo)
    pila.push(nodo)
    for (const succ of archi.get(nodo) ?? []) {
      if (inPila.has(succ)) {
        trovati.push([...pila.slice(pila.indexOf(succ)), succ])
      } else if (!visti.has(succ)) {
        scendi(succ)
      }
    }
    pila.pop()
    inPila.delete(nodo)
  }

  for (const nodo of [...archi.keys()].sort()) if (!visti.has(nodo)) scendi(nodo)
  return trovati
}

describe('lock architettura · policy RLS che si leggono a vicenda (42P17)', () => {
  it('il parser vede davvero le policy delle migrazioni (sanity)', () => {
    // Se il parser si rompesse, il lock passerebbe su un grafo vuoto: cioè non
    // controllerebbe niente, sempre, in silenzio.
    expect(ATTIVE.size).toBeGreaterThan(80)
    expect(TABELLE_CON_POLICY.has('pagamenti')).toBe(true)
    expect(TABELLE_CON_POLICY.has('pagamenti_quote')).toBe(true)
  })

  it('nessun cerchio fra le policy di due tabelle diverse', () => {
    const { archi, perche } = grafo()
    const trovati = cicli(archi)
    const descritti = trovati.map((c) => {
      const passi: string[] = []
      for (let i = 0; i < c.length - 1; i++) {
        const responsabili = (perche.get(`${c[i]}→${c[i + 1]}`) ?? [])
          .map((p) => `«${p.nome}» (${p.file})`)
          .join(', ')
        passi.push(`${c[i]} → ${c[i + 1]} per ${responsabili}`)
      }
      return `${c.join(' → ')}  [${passi.join(' | ')}]`
    })
    expect(
      descritti,
      'Queste policy si leggono a vicenda: alla prima lettura Postgres risponde ' +
        '«42P17: infinite recursion detected in policy for relation …» e NEGA tutto, ' +
        'senza un log applicativo. Rompi il cerchio: togli la policy se è morta, oppure ' +
        'fai passare il riferimento da una funzione SECURITY DEFINER che salta la RLS ' +
        'dell\'altra tabella (schema di `current_parent_student_ids()`).',
    ).toEqual([])
  })
})
