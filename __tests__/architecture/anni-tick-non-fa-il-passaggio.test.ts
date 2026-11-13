import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * COMPITO 4.9.1 (riscrive il lock del 4.5.12) · IL TICK PORTA L'ANNO A `in_chiusura` E A `chiuso`; NON FA IL PASSAGGIO.
 *
 * `anni_tick` gira ogni ora da solo. Il passo 1 crea l'anno successivo; il passo 2 (`anno_stati_aggiorna`, dalla PR 4.9) porta il
 * vecchio anno a `in_chiusura` il giorno dopo l'ultimo giorno aperto e a `chiuso` il giorno dopo la fine. NON fa il PASSAGGIO:
 * non promuove MAI un anno a `corrente`, non muove frequenze e non scrive in `passaggi_anno`. Il passaggio cambia migliaia di righe
 * di minori e lo lancia una persona, con i controlli del caso (PR 4.8). Se un giorno il tick lo facesse da solo, il 1° settembre di
 * un anno qualunque l'anno scolastico di tre scuole cambierebbe alle 00:10 senza che nessuno l'abbia deciso.
 *
 * Il lock legge l'ULTIMA definizione delle funzioni del tick (il file con la version più alta che la contiene, l'ultima del file),
 * non la prima che capita, e nel suo testo, scritto senza commenti, vieta due cose:
 *  - un `UPDATE … anni_sede SET … stato = X` dove X non sia un letterale `'in_chiusura'` o `'chiuso'` (in particolare `'corrente'`, ma
 *    anche una variabile o un'espressione: il lock non saprebbe dire dove porta);
 *  - il nome `passaggi_anno` (la tabella dove il passaggio registra ciò che ha fatto).
 * Valgono per le funzioni del tick: `anni_tick`, `anno_stati_aggiorna`, `anno_stati_log`, `anni_sede_crea_successivo` e
 * `anno_copia_configurazione`.
 *
 * ⚠️ QUANDO QUESTO LOCK DEVE DIVENTARE ROSSO PER BUONE RAGIONI: il giorno in cui il titolare decide che il tick fa anche il passaggio.
 * Quel giorno il lock si riscrive di proposito, con la decisione accanto; non si aggira con un'eccezione.
 *
 * ─── PERCHÉ NON È CIECO ───────────────────────────────────────────────────────
 * Dichiara quante migrazioni ha letto, quante definizioni ha trovato e quanto è lungo il testo che ha esaminato (un corpo
 * vuoto è verde per costruzione), conta gli `UPDATE … stato` che ha visto nel passo 2 (devono essere almeno due: se ne vedesse zero
 * sarebbe cieco), e ha il suo controllo positivo su SQL finto. Non vede: un passaggio fatto da una funzione chiamata da una funzione
 * chiamata dal tick, o un nome di tabella costruito a pezzi.
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

/**
 * Ogni `UPDATE … anni_sede …` il cui SET (prima del WHERE) assegna `stato`, con il valore assegnato: il letterale (anche fra due
 * apici raddoppiati, dentro una stringa di `EXECUTE`) oppure `null` se non è un letterale.
 */
function aggiornamentiDelloStato(corpo: string): Array<string | null> {
  const out: Array<string | null> = []
  const re = /\bupdate\s+(?:only\s+)?(?:public\.)?anni_sede\b([^;]*)/gi
  let h: RegExpExecArray | null
  while ((h = re.exec(corpo)) !== null) {
    const set = h[1].split(/\bwhere\b/i)[0]
    const assegna = /\bstato\s*=\s*([\s\S]*)$/i.exec(set)
    if (!assegna) continue
    const lett = /^('{1,2})([a-z_]+)\1\s*(?:,|$)/i.exec(assegna[1].trim())
    out.push(lett ? lett[2].toLowerCase() : null)
  }
  return out
}

/** I due soli stati a cui il tick può portare un anno. `corrente` è del passaggio. */
const STATI_DEL_TICK = ['in_chiusura', 'chiuso']

const nominaPassaggi = (corpo: string) => /\bpassaggi_anno\b/i.test(corpo)

function violazioni(nome: string, migrazioni: Migrazione[]): string[] {
  const d = ultimaDefinizione(nome, migrazioni)
  if (!d) return [`${nome} — nessuna definizione trovata nelle migrazioni`]
  const out: string[] = []
  for (const valore of aggiornamentiDelloStato(d.corpo)) {
    if (valore === null) {
      out.push(`${nome} (ultima definizione: ${d.migrazione}) — un \`UPDATE anni_sede SET stato\` con un valore che non è un letterale: il lock non sa dove porta l'anno`)
    } else if (!STATI_DEL_TICK.includes(valore)) {
      out.push(`${nome} (ultima definizione: ${d.migrazione}) — porta un anno a \`${valore}\`: il tick può solo chiudere (\`in_chiusura\`, \`chiuso\`), il passaggio è di una persona`)
    }
  }
  if (nominaPassaggi(d.corpo)) out.push(`${nome} (ultima definizione: ${d.migrazione}) — nomina \`passaggi_anno\`: il passaggio non è del tick`)
  return out
}

const FUNZIONI = ['anni_tick', 'anno_stati_aggiorna', 'anno_stati_log', 'anni_sede_crea_successivo', 'anno_copia_configurazione'] as const
const MIGRAZIONI = leggiMigrazioni()
const elenco = (v: string[]) => (v.length ? '\n  - ' + v.join('\n  - ') : '')

const fn = (nome: string, corpo: string): Migrazione => ({
  nome: '29990101000000_finta.sql',
  testo: `CREATE OR REPLACE FUNCTION public.${nome}() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${corpo} END $$;`,
})

describe('anni-tick-non-fa-il-passaggio — il controllo positivo, su SQL finto', () => {
  it('portare un anno a `corrente` nel tick fa rosso, in tutte le forme di scrittura', () => {
    expect(violazioni('anni_tick', [fn('anni_tick', "UPDATE public.anni_sede SET stato = 'corrente' WHERE id = v_id;")])).toHaveLength(1)
    expect(violazioni('anni_tick', [fn('anni_tick', "UPDATE anni_sede\n   SET inizio = inizio, stato = 'corrente'\n WHERE id = v_id;")])).toHaveLength(1)
    expect(violazioni('anni_tick', [fn('anni_tick', "EXECUTE 'UPDATE public.anni_sede SET stato = ''corrente''';")])).toHaveLength(1)
    expect(violazioni('anni_tick', [fn('anni_tick', "UPDATE public.anni_sede SET domande_aperte = false, stato = 'corrente';")])).toHaveLength(1)
  })

  it('un valore dello stato che non è un letterale (variabile, espressione, CASE) fa rosso: il lock non sa dove porta l’anno', () => {
    expect(violazioni('anni_tick', [fn('anni_tick', 'UPDATE public.anni_sede SET stato = v_nuovo WHERE id = v_id;')])).toHaveLength(1)
    expect(violazioni('anni_tick', [fn('anni_tick', "UPDATE public.anni_sede SET stato = CASE WHEN x THEN 'chiuso' ELSE 'corrente' END;")])).toHaveLength(1)
  })

  it('il nome della tabella dei passaggi nel tick fa rosso', () => {
    expect(violazioni('anni_tick', [fn('anni_tick', 'INSERT INTO public.passaggi_anno (a) VALUES (1);')])).toHaveLength(1)
  })

  it('`UPDATE … SET stato = \'in_chiusura\'` e `\'chiuso\'` passano, come un UPDATE che non tocca lo stato; un commento non conta', () => {
    expect(violazioni('anni_tick', [fn('anni_tick', "UPDATE public.anni_sede SET stato = 'in_chiusura', domande_aperte = false WHERE id = v_id AND stato = 'corrente';")])).toEqual([])
    expect(violazioni('anni_tick', [fn('anni_tick', "UPDATE public.anni_sede SET stato = 'chiuso' WHERE id = v_id;")])).toEqual([])
    expect(violazioni('anni_tick', [fn('anni_tick', "UPDATE public.anni_sede SET prepara_successivo_dal = d WHERE stato = 'corrente';")])).toEqual([])
    expect(violazioni('anni_tick', [fn('anni_tick', "-- UPDATE public.anni_sede SET stato = 'corrente'\n/* passaggi_anno */ PERFORM 1;")])).toEqual([])
  })

  it('vale l’ULTIMA definizione: una ridefinizione più recente che promuove a `corrente` fa rosso, anche se la prima era pulita', () => {
    const pulita: Migrazione = { nome: '20260101000000_a.sql', testo: fn('anni_tick', 'PERFORM 1;').testo }
    expect(violazioni('anni_tick', [pulita])).toEqual([])
    const v = violazioni('anni_tick', [pulita, fn('anni_tick', "UPDATE public.anni_sede SET stato = 'corrente';")])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('29990101000000_finta.sql')
  })

  it('un corpo che non si trova non passa per verde', () => {
    expect(violazioni('anni_tick', [])).toHaveLength(1)
  })

  it('conta gli UPDATE dello stato che vede: due letterali, e un letterale su due righe diverse', () => {
    expect(aggiornamentiDelloStato("UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = a; UPDATE public.anni_sede SET stato = 'chiuso' WHERE id = b;"))
      .toEqual(['in_chiusura', 'chiuso'])
    expect(aggiornamentiDelloStato('UPDATE public.anni_sede SET stato = v WHERE id = a;')).toEqual([null])
    expect(aggiornamentiDelloStato('UPDATE public.anni_sede SET inizio = d WHERE id = a;')).toEqual([])
  })
})

describe('anni-tick-non-fa-il-passaggio — le migrazioni vere', () => {
  it('ha letto abbastanza: almeno 274 migrazioni (misurate 274 il 2026-11-09), e le funzioni del tick hanno una definizione con un corpo vero', () => {
    expect(MIGRAZIONI.length, `migrazioni lette: ${MIGRAZIONI.length}`).toBeGreaterThanOrEqual(274)
    for (const nome of FUNZIONI) {
      const d = ultimaDefinizione(nome, MIGRAZIONI)
      expect(d, `${nome}: nessuna definizione`).not.toBeNull()
      // `anno_stati_log` è la più corta: un INSERT e un blocco di eccezione
      expect(d!.corpo.trim().length, `${nome}: corpo vuoto in ${d!.migrazione}: il lock sarebbe cieco`).toBeGreaterThan(150)
    }
  })

  it('vede gli UPDATE dello stato del passo 2 (almeno due: `in_chiusura` e `chiuso`) e nessuno che porti a `corrente`', () => {
    const visti = FUNZIONI.flatMap((nome) => aggiornamentiDelloStato(ultimaDefinizione(nome, MIGRAZIONI)!.corpo))
    expect(visti.length, `UPDATE dello stato visti nel tick: ${visti.length} — se fossero zero il lock sarebbe cieco`).toBeGreaterThanOrEqual(2)
    expect(visti).toContain('in_chiusura')
    expect(visti).toContain('chiuso')
    expect(visti).not.toContain('corrente')
  })

  it('il testo del tick, e delle funzioni che chiama, non fa il passaggio', () => {
    const v = FUNZIONI.flatMap((nome) => violazioni(nome, MIGRAZIONI))
    expect(
      v,
      `Il tick ha un pezzo del passaggio (${v.length}). Il passaggio è della PR 4.8 e lo lancia una persona: ` +
        `se il titolare ha deciso che il tick lo fa da solo, riscrivi questo lock con la decisione accanto.` + elenco(v),
    ).toEqual([])
  })
})
