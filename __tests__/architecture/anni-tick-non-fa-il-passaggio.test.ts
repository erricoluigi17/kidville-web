import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * COMPITO 4.5.12 · IL TICK CREA L'ANNO SUCCESSIVO; NON FA IL PASSAGGIO.
 *
 * `anni_tick` gira ogni ora da solo. Crea l'anno successivo di una sede quando arriva il suo giorno e ne copia listino, moduli
 * e posti: è il PASSO 1, e non cambia lo stato di nessun anno. Il PASSAGGIO (l'anno corrente si chiude, il successivo diventa
 * corrente, i bambini passano alla classe dopo, le frequenze si chiudono) cambia migliaia di righe di minori, e per scelta del
 * titolare non è in questa PR né in un cron: lo lancia una persona, con i controlli del caso (PR 3-B). Se un giorno il tick lo
 * facesse da solo, il 1° settembre di un anno qualunque l'anno scolastico di tre scuole cambierebbe alle 00:10 senza che
 * nessuno l'abbia deciso.
 *
 * Il lock legge l'ULTIMA definizione di `anni_tick` (il file con la version più alta che la contiene, l'ultima del file), non
 * la prima che capita, e vieta due cose nel suo testo, scritto senza commenti:
 *  - un `UPDATE … anni_sede SET … stato =` (il cambio di stato di un anno);
 *  - il nome `passaggi_anno` (la tabella dove il passaggio registra ciò che ha fatto).
 * Le stesse due cose valgono per le funzioni che il tick chiama, `anni_sede_crea_successivo` e `anno_copia_configurazione`.
 *
 * ⚠️ QUANDO QUESTO LOCK DEVE DIVENTARE ROSSO PER BUONE RAGIONI: la PR 3-B (il passaggio) aggiungerà il passo 2 al tick, con un
 * `CREATE OR REPLACE`. Quel giorno il lock si toglie o si riscrive di proposito, con la decisione del titolare scritta accanto;
 * non si aggira con un'eccezione.
 *
 * ─── PERCHÉ NON È CIECO ───────────────────────────────────────────────────────
 * Dichiara quante migrazioni ha letto, quante definizioni ha trovato e quanto è lungo il testo che ha esaminato (un corpo
 * vuoto è verde per costruzione), e ha il suo controllo positivo su SQL finto. Non vede: un passaggio fatto da una funzione
 * chiamata da una funzione chiamata dal tick, o un nome di tabella costruito a pezzi.
 */

const CWD = process.cwd()
const DIR_MIGRAZIONI = path.join(CWD, 'supabase', 'migrations')

interface Migrazione { nome: string; testo: string }

const togliCommentiSql = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

function leggiMigrazioni(): Migrazione[] {
  return fs
    .readdirSync(DIR_MIGRAZIONI)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((nome) => ({ nome, testo: fs.readFileSync(path.join(DIR_MIGRAZIONI, nome), 'utf8') }))
}

/** L'ULTIMA definizione di `nome`: nel file con la version più alta che la contiene, l'ultima del file. Il corpo è fra `AS $tag$` e `$tag$`. */
function ultimaDefinizione(nome: string, migrazioni: Migrazione[]): { migrazione: string; corpo: string } | null {
  const ordinate = [...migrazioni].sort((x, y) => (x.nome < y.nome ? 1 : x.nome > y.nome ? -1 : 0))
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+(?:public\\.)?${nome}\\s*\\(`, 'ig')
  for (const mig of ordinate) {
    const t = togliCommentiSql(mig.testo)
    let ultimo: RegExpExecArray | null = null
    let h: RegExpExecArray | null
    re.lastIndex = 0
    while ((h = re.exec(t)) !== null) ultimo = h
    if (!ultimo) continue
    const dopo = t.slice(ultimo.index + ultimo[0].length)
    const as = /\bas\s+(\$[A-Za-z_0-9]*\$)/i.exec(dopo)
    if (!as) return { migrazione: mig.nome, corpo: '' }
    const inizio = as.index + as[0].length
    const fine = dopo.indexOf(as[1], inizio)
    return { migrazione: mig.nome, corpo: dopo.slice(inizio, fine < 0 ? undefined : fine) }
  }
  return null
}

/** Ogni `UPDATE … anni_sede …` il cui SET (prima del WHERE) assegna `stato`. */
function updateDelloStato(corpo: string): number {
  let n = 0
  const re = /\bupdate\s+(?:only\s+)?(?:public\.)?anni_sede\b([^;]*)/gi
  let h: RegExpExecArray | null
  while ((h = re.exec(corpo)) !== null) {
    const set = h[1].split(/\bwhere\b/i)[0]
    if (/\bstato\s*=/i.test(set)) n++
  }
  return n
}

const nominaPassaggi = (corpo: string) => /\bpassaggi_anno\b/i.test(corpo)

function violazioni(nome: string, migrazioni: Migrazione[]): string[] {
  const d = ultimaDefinizione(nome, migrazioni)
  if (!d) return [`${nome} — nessuna definizione trovata nelle migrazioni`]
  const out: string[] = []
  const u = updateDelloStato(d.corpo)
  if (u > 0) out.push(`${nome} (ultima definizione: ${d.migrazione}) — ${u} \`UPDATE anni_sede SET stato\`: il cambio di stato di un anno è il passaggio, e non è del tick`)
  if (nominaPassaggi(d.corpo)) out.push(`${nome} (ultima definizione: ${d.migrazione}) — nomina \`passaggi_anno\`: il passaggio non è del tick`)
  return out
}

const FUNZIONI = ['anni_tick', 'anni_sede_crea_successivo', 'anno_copia_configurazione'] as const
const MIGRAZIONI = leggiMigrazioni()
const elenco = (v: string[]) => (v.length ? '\n  - ' + v.join('\n  - ') : '')

const fn = (nome: string, corpo: string): Migrazione => ({
  nome: '29990101000000_finta.sql',
  testo: `CREATE OR REPLACE FUNCTION public.${nome}() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${corpo} END $$;`,
})

describe('anni-tick-non-fa-il-passaggio — il controllo positivo, su SQL finto', () => {
  it('un UPDATE dello stato di un anno nel tick fa rosso, in tutte le forme di scrittura', () => {
    expect(violazioni('anni_tick', [fn('anni_tick', "UPDATE public.anni_sede SET stato = 'chiuso' WHERE id = v_id;")])).toHaveLength(1)
    expect(violazioni('anni_tick', [fn('anni_tick', "UPDATE anni_sede\n   SET inizio = inizio, stato = 'corrente'\n WHERE id = v_id;")])).toHaveLength(1)
    expect(violazioni('anni_tick', [fn('anni_tick', "EXECUTE 'UPDATE public.anni_sede SET stato = ''corrente''';")])).toHaveLength(1)
  })

  it('il nome della tabella dei passaggi nel tick fa rosso', () => {
    expect(violazioni('anni_tick', [fn('anni_tick', 'INSERT INTO public.passaggi_anno (a) VALUES (1);')])).toHaveLength(1)
  })

  it('un UPDATE di anni_sede che non tocca lo stato, o una condizione sullo stato, non fa rosso; un commento neppure', () => {
    expect(violazioni('anni_tick', [fn('anni_tick', "UPDATE public.anni_sede SET prepara_successivo_dal = d WHERE stato = 'corrente';")])).toEqual([])
    expect(violazioni('anni_tick', [fn('anni_tick', "-- UPDATE public.anni_sede SET stato = 'chiuso'\n/* passaggi_anno */ PERFORM 1;")])).toEqual([])
  })

  it('vale l’ULTIMA definizione: una ridefinizione più recente con il passaggio fa rosso, anche se la prima era pulita', () => {
    const pulita: Migrazione = { nome: '20260101000000_a.sql', testo: fn('anni_tick', 'PERFORM 1;').testo }
    expect(violazioni('anni_tick', [pulita])).toEqual([])
    const v = violazioni('anni_tick', [pulita, fn('anni_tick', "UPDATE public.anni_sede SET stato = 'corrente';")])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('29990101000000_finta.sql')
  })

  it('un corpo che non si trova non passa per verde', () => {
    expect(violazioni('anni_tick', [])).toHaveLength(1)
  })
})

describe('anni-tick-non-fa-il-passaggio — le migrazioni vere', () => {
  it('ha letto abbastanza: almeno 269 migrazioni (misurate 269 il 2026-11-09), e le tre funzioni hanno una definizione con un corpo vero', () => {
    expect(MIGRAZIONI.length, `migrazioni lette: ${MIGRAZIONI.length}`).toBeGreaterThanOrEqual(269)
    for (const nome of FUNZIONI) {
      const d = ultimaDefinizione(nome, MIGRAZIONI)
      expect(d, `${nome}: nessuna definizione`).not.toBeNull()
      expect(d!.corpo.trim().length, `${nome}: corpo vuoto in ${d!.migrazione}: il lock sarebbe cieco`).toBeGreaterThan(200)
    }
  })

  it('il testo di anni_tick, e delle funzioni che chiama, non fa il passaggio', () => {
    const v = FUNZIONI.flatMap((nome) => violazioni(nome, MIGRAZIONI))
    expect(
      v,
      `Il tick ha un pezzo del passaggio (${v.length}). Il passaggio è della PR 3-B e lo lancia una persona: ` +
        `se il titolare ha deciso che il tick lo fa da solo, riscrivi questo lock con la decisione accanto.` + elenco(v),
    ).toEqual([])
  })
})
