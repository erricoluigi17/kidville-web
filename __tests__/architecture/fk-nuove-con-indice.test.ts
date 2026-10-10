import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

/**
 * LOCK — UNA FK NUOVA NASCE CON IL SUO INDICE.
 *
 * ─── PERCHÉ (roadmap di robustezza, fase 6, problema D10) ───────────────────
 * Postgres indicizza da solo la chiave a cui una FK punta (il padre), MAI la colonna
 * che punta (la figlia). Ma ogni DELETE di un padre — e ogni UPDATE della sua chiave —
 * cerca le righe figlie per applicare la sua azione ON DELETE (CASCADE, SET NULL,
 * NO ACTION, RESTRICT: tutte), e senza un indice su quella colonna la ricerca legge la
 * tabella figlia per intero. Il 10/10/2026 l'advisor ne contava 95 in produzione, nate
 * una alla volta in tre mesi; la migrazione `20261010221643_indici_fk_initplan_doppioni`
 * le ha chiuse tutte. I freni RESTRICT della fase 7 stanno in piedi solo così.
 *
 * ─── LA REGOLA ───────────────────────────────────────────────────────────────
 * Da quella migrazione in poi (`DA_QUI`), ogni FK dichiarata in un file — dentro un
 * `CREATE TABLE`, con un `ADD COLUMN … REFERENCES` o con un `ADD CONSTRAINT … FOREIGN
 * KEY` — deve avere, NELLO STESSO FILE, un indice la cui PRIMA colonna è la sua:
 *   · un `CREATE [UNIQUE] INDEX … ON <tabella> (<colonna>, …)`, oppure
 *   · una PRIMARY KEY o una UNIQUE della tabella che comincia da quella colonna.
 * Se un indice davvero non serve (tabella di poche righe che non si cancella mai), o se
 * la FK è una chiave GIÀ indicizzata da un'altra migrazione di cui si cambia solo la
 * ON DELETE (ripetere l'indice con un altro nome farebbe un doppione), lo si dice nel
 * file, con il motivo o il nome dell'indice:
 *
 *     -- fk senza indice: <tabella>.<colonna> <motivo, almeno 15 caratteri>
 *     -- fk già indicizzata: <tabella>.<colonna> <nome dell'indice e dove nasce>
 *
 * ─── CONFINE ─────────────────────────────────────────────────────────────────
 * Si guarda lo SQL senza commenti (`senzaCommenti`); i corpi di `CREATE FUNCTION`
 * non contano (lì una FK non si dichiara). Le FK a più colonne contano per la prima
 * colonna: è quella che un indice deve avere in testa.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')

/** La prima migrazione sotto il lucchetto: quella che ha chiuso le 95 FK scoperte. */
const DA_QUI = '20261010221643'

const ECCEZIONE = /^\s*--\s*fk\s+(?:senza\s+indice|gi[aà]\s+indicizzata):\s*([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+(.+)$/gim

type Fk = { tabella: string; colonna: string }

/** Lo SQL senza commenti e senza i corpi di CREATE FUNCTION / PROCEDURE. */
function senzaCorpiDiFunzione(sql: string): string {
  const s = senzaCommenti(sql)
  let fuori = ''
  let inizioIstruzione = 0
  let i = 0
  while (i < s.length) {
    const dollaro = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y
    dollaro.lastIndex = i
    const d = dollaro.exec(s)
    if (d) {
      const tag = d[0]
      const fine = s.indexOf(tag, i + tag.length)
      const corpo = s.slice(i + tag.length, fine === -1 ? s.length : fine)
      const testa = s.slice(inizioIstruzione, i)
      const diFunzione = /^\s*create\s+(or\s+replace\s+)?(function|procedure)\b/i.test(testa)
      fuori += diFunzione ? ' ' : ` ${corpo} `
      i = fine === -1 ? s.length : fine + tag.length
      continue
    }
    if (s[i] === ';') inizioIstruzione = i + 1
    fuori += s[i]
    i++
  }
  return fuori
}

/** Un nome di tabella senza schema e senza virgolette, in minuscolo. */
function nudo(nome: string): string {
  return nome.replace(/^"?public"?\./i, '').replace(/"/g, '').toLowerCase()
}

/** Divide il corpo di un CREATE TABLE sulle virgole al primo livello di parentesi. */
function elementiDelCorpo(corpo: string): string[] {
  const out: string[] = []
  let livello = 0
  let attuale = ''
  for (const c of corpo) {
    if (c === '(') livello++
    if (c === ')') livello--
    if (c === ',' && livello === 0) {
      out.push(attuale.trim())
      attuale = ''
    } else attuale += c
  }
  if (attuale.trim()) out.push(attuale.trim())
  return out
}

function primaColonna(lista: string): string {
  return nudo(lista.split(',')[0].trim())
}

/** Le FK dichiarate e le colonne già in testa a un indice/PK/UNIQUE, per tabella. */
export function analizza(sql: string): { fk: Fk[]; coperte: Set<string> } {
  const s = senzaCorpiDiFunzione(sql)
  const fk: Fk[] = []
  const coperte = new Set<string>()

  // CREATE TABLE … ( … ) — il corpo si trova contando le parentesi.
  const creaTabella = /create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/gi
  for (let m = creaTabella.exec(s); m; m = creaTabella.exec(s)) {
    const tabella = nudo(m[1])
    let livello = 1
    let j = creaTabella.lastIndex
    while (j < s.length && livello > 0) {
      if (s[j] === '(') livello++
      if (s[j] === ')') livello--
      j++
    }
    for (const el of elementiDelCorpo(s.slice(creaTabella.lastIndex, j - 1))) {
      const vincolo = el.replace(/^constraint\s+[\w"]+\s+/i, '')
      const fkTabella = /^foreign\s+key\s*\(([^)]*)\)\s*references\b/i.exec(vincolo)
      const chiave = /^(primary\s+key|unique)\s*(?:nulls\s+(?:not\s+)?distinct\s*)?\(([^)]*)\)/i.exec(vincolo)
      if (fkTabella) {
        fk.push({ tabella, colonna: primaColonna(fkTabella[1]) })
      } else if (chiave) {
        coperte.add(`${tabella}.${primaColonna(chiave[2])}`)
      } else if (!/^(check|exclude|like)\b/i.test(vincolo)) {
        const colonna = nudo(el.split(/\s+/)[0])
        if (/\breferences\b/i.test(el)) fk.push({ tabella, colonna })
        if (/\bprimary\s+key\b|\bunique\b/i.test(el)) coperte.add(`${tabella}.${colonna}`)
      }
    }
  }

  // ALTER TABLE … ADD COLUMN … REFERENCES  /  ADD CONSTRAINT … FOREIGN KEY (…) REFERENCES
  const altera = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)([^;]*)/gi
  for (let m = altera.exec(s); m; m = altera.exec(s)) {
    const tabella = nudo(m[1])
    for (const parte of elementiDelCorpo(m[2])) {
      const col = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\w"]+)\s+[^]*?\breferences\b/i.exec(parte)
      const vin = /^add\s+(?:constraint\s+[\w"]+\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\b/i.exec(parte)
      const chiave = /^add\s+(?:constraint\s+[\w"]+\s+)?(primary\s+key|unique)\s*\(([^)]*)\)/i.exec(parte)
      if (vin) fk.push({ tabella, colonna: primaColonna(vin[1]) })
      else if (col && !/^add\s+constraint\b/i.test(parte)) fk.push({ tabella, colonna: nudo(col[1]) })
      if (chiave) coperte.add(`${tabella}.${primaColonna(chiave[2])}`)
    }
  }

  // CREATE [UNIQUE] INDEX … ON [ONLY] tabella [USING metodo] (prima_colonna, …)
  const indice =
    /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:[\w"]+\s+)?on\s+(?:only\s+)?([\w."]+)\s*(?:using\s+\w+\s*)?\(\s*([\w"]+)/gi
  for (let m = indice.exec(s); m; m = indice.exec(s)) coperte.add(`${nudo(m[1])}.${nudo(m[2])}`)

  return { fk, coperte }
}

/** Le FK del file senza indice e senza eccezione dichiarata. */
export function fkScoperte(sql: string): string[] {
  const { fk, coperte } = analizza(sql)
  const eccezioni = new Set<string>()
  for (const m of sql.matchAll(ECCEZIONE)) {
    if (m[3].trim().length >= 15) eccezioni.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`)
  }
  return [...new Set(fk.map((f) => `${f.tabella}.${f.colonna}`))].filter(
    (k) => !coperte.has(k) && !eccezioni.has(k),
  )
}

const sotto = readdirSync(CARTELLA)
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && f.slice(0, 14) >= DA_QUI)
  .sort()

describe('lock architettura · una FK nuova nasce con il suo indice (D10)', () => {
  it('il punto di partenza esiste (sanity: senza, il lock sarebbe verde sul vuoto)', () => {
    expect(sotto[0]?.slice(0, 14)).toBe(DA_QUI)
  })

  it('ogni FK dichiarata da DA_QUI in poi ha un indice che comincia dalla sua colonna, nello stesso file', () => {
    const rosse: string[] = []
    for (const f of sotto) {
      for (const k of fkScoperte(readFileSync(join(CARTELLA, f), 'utf8'))) rosse.push(`${f}: ${k}`)
    }
    expect(
      rosse,
      'FK senza indice sulla colonna figlia: aggiungi `CREATE INDEX IF NOT EXISTS idx_<tabella>_<colonna> ' +
        'ON public.<tabella> (<colonna>);` nello stesso file, o dichiara `-- fk senza indice: ' +
        '<tabella>.<colonna> <motivo>`',
    ).toEqual([])
  })
})

describe('il riconoscimento (controlli su SQL sintetico: il lock deve saper diventare rosso)', () => {
  it('colonna con REFERENCES in un CREATE TABLE, senza indice → rossa', () => {
    expect(
      fkScoperte(`CREATE TABLE public.foo (id uuid PRIMARY KEY, alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE);`),
    ).toEqual(['foo.alunno_id'])
  })

  it('la stessa con il suo CREATE INDEX → verde; e la PK che comincia dalla colonna basta', () => {
    expect(
      fkScoperte(`CREATE TABLE public.foo (id uuid PRIMARY KEY, alunno_id uuid REFERENCES alunni(id));
                  CREATE INDEX IF NOT EXISTS idx_foo_alunno_id ON public.foo USING btree (alunno_id, creato_il);`),
    ).toEqual([])
    expect(
      fkScoperte(`CREATE TABLE foo (alunno_id uuid REFERENCES alunni(id), giorno date, PRIMARY KEY (alunno_id, giorno));`),
    ).toEqual([])
  })

  it('un indice che ha la colonna in SECONDA posizione non copre → rossa', () => {
    expect(
      fkScoperte(`CREATE TABLE foo (id uuid PRIMARY KEY, scuola_id uuid, alunno_id uuid REFERENCES alunni(id));
                  CREATE INDEX idx_foo ON foo (scuola_id, alunno_id);`),
    ).toEqual(['foo.alunno_id'])
  })

  it('FOREIGN KEY di tabella e ADD CONSTRAINT / ADD COLUMN in un ALTER TABLE → rosse senza indice', () => {
    expect(
      fkScoperte(`CREATE TABLE foo (id uuid PRIMARY KEY, a uuid, CONSTRAINT foo_a_fkey FOREIGN KEY (a) REFERENCES bar(id));`),
    ).toEqual(['foo.a'])
    expect(fkScoperte(`ALTER TABLE public.foo ADD CONSTRAINT foo_b_fkey FOREIGN KEY (b) REFERENCES bar(id) ON DELETE RESTRICT;`)).toEqual(['foo.b'])
    expect(fkScoperte(`ALTER TABLE ONLY public.foo ADD COLUMN IF NOT EXISTS c uuid REFERENCES public.utenti(id);`)).toEqual(['foo.c'])
  })

  it('l\'eccezione dichiarata col motivo spegne la FK; senza motivo vero no', () => {
    const sql = `CREATE TABLE foo (id uuid PRIMARY KEY, a uuid REFERENCES bar(id));`
    expect(fkScoperte(`-- fk senza indice: foo.a tabella di 3 righe che non si cancella mai\n${sql}`)).toEqual([])
    expect(fkScoperte(`-- fk senza indice: foo.a corta\n${sql}`)).toEqual(['foo.a'])
    expect(fkScoperte(`-- fk già indicizzata: foo.a idx_foo_a (migrazione della fase 6)\n${sql}`)).toEqual([])
  })

  it('una FK scritta solo in un commento o nel corpo di una funzione non conta', () => {
    expect(fkScoperte(`-- a uuid REFERENCES bar(id)\nCREATE TABLE foo (id uuid PRIMARY KEY);`)).toEqual([])
    expect(
      fkScoperte(`CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
                  BEGIN CREATE TABLE tmp (a uuid REFERENCES bar(id)); END $$;`),
    ).toEqual([])
  })

  it('cambiare la ON DELETE di una FK esistente (DROP + ADD CONSTRAINT) chiede l\'indice anche lì', () => {
    expect(
      fkScoperte(`ALTER TABLE public.incassi DROP CONSTRAINT incassi_pagamento_id_fkey,
                    ADD CONSTRAINT incassi_pagamento_id_fkey FOREIGN KEY (pagamento_id) REFERENCES public.pagamenti(id) ON DELETE RESTRICT;`),
    ).toEqual(['incassi.pagamento_id'])
    expect(
      fkScoperte(`CREATE INDEX IF NOT EXISTS idx_incassi_pagamento_id ON public.incassi (pagamento_id);
                  ALTER TABLE public.incassi DROP CONSTRAINT incassi_pagamento_id_fkey,
                    ADD CONSTRAINT incassi_pagamento_id_fkey FOREIGN KEY (pagamento_id) REFERENCES public.pagamenti(id) ON DELETE RESTRICT;`),
    ).toEqual([])
  })
})
