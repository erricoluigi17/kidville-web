import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK DI FORMA — «scope vuoto ⇒ NEGA», mai «scope vuoto ⇒ nessun filtro».
 *
 * La forma vietata è questa:
 *
 *     const plessi = await resolveScuoleAttive(request, supabase, user)
 *     let q = supabase.from('alunni').select('id, nome, cognome')
 *     if (plessi.length > 0) q = q.in('scuola_id', plessi)      // ← fail-open
 *
 * Letta da sinistra sembra una difesa. Fa l'opposto: quando lo scope è VUOTO —
 * cookie `sedi_attive` su una sede non più accessibile, utente senza plessi,
 * lettura del ponte `utenti_scuole` fallita — il filtro non viene applicato per
 * niente e la query esce SENZA perimetro, cioè su TUTTE le sedi. Il caso in cui
 * l'utente ha meno diritti è esattamente quello in cui vede di più.
 *
 * Non è teoria: il 2026-07-31 questa riga era viva in `gallery`, `admin/audit`,
 * `admin/segnalazioni`, `admin/protocolli/analizza`, `admin/sidi/import`. Nessun
 * test era rosso, nessun log si accendeva: un filtro che non c'è non lancia,
 * restituisce solo più righe. La regola del progetto è quella opposta e non ha
 * eccezioni: `.in('scuola_id', plessi)` si applica SEMPRE — con `plessi` vuoto
 * PostgREST risponde giustamente niente — oppure lo scope vuoto ha il suo ramo
 * esplicito che nega.
 *
 * COSA GUARDA (e cosa no). Il lock non segnala ogni `length > 0` del repo: ne
 * cerca uno che governa un filtro su `scuola_id` costruito con LA STESSA lista
 * della guardia. `if (ids.length > 0) { … .in('id', ids).in('scuola_id', plessi) }`
 * non è la forma vietata — lì il perimetro c'è ed è incondizionato, e la guardia
 * parla di un'altra lista. Ternario col ramo negativo VERO (`: 'scuola_id.is.null'`,
 * che restringe ai soli modelli globali) è anch'esso lecito: c'è un `else`, e
 * nega.
 *
 * ALLOWLIST: NON ESISTE, di proposito. Un punto ancora vivo si corregge; se
 * davvero esistesse un caso legittimo, andrebbe scritto con il ramo `else`
 * esplicito — che è comunque la forma leggibile.
 */

const PERIMETRO = [
  path.join(process.cwd(), 'src', 'app', 'api'),
  path.join(process.cwd(), 'src', 'lib'),
]

/** `plessi.length > 0`, `sedi.length >= 1`, `plessi.length !== 0`. */
const GUARDIA = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.length\s*(?:>\s*0|>=\s*1|!==?\s*0)/g

/** Un filtro sulla colonna di tenancy, in tutte le forme usate nel repo. */
const FILTRO_SEDE =
  /\.(?:eq|in|neq|not|filter|is)\s*\(\s*['"`]scuola_id['"`]|['"`]scuola_id\.(?:eq|in|is|not)\.|\.match\s*\(\s*\{[^}]*\bscuola_id\b/g

/** Rami «negativi» che di fatto non negano nulla. */
const RAMO_VUOTO = new Set(['', "''", '""', '``', 'null', 'undefined', '[]', '{}', 'true'])

export interface PuntoFailOpen {
  riga: number
  guardia: string
  forma: 'if' | 'ternario' | 'and'
}

function saltaSpazi(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++
  return i
}

/** Indice DOPO la graffa che chiude quella aperta in `apertura`. */
function fineGraffa(strut: string, apertura: number): number {
  let livello = 0
  for (let k = apertura; k < strut.length; k++) {
    if (strut[k] === '{') livello++
    else if (strut[k] === '}') {
      livello--
      if (livello === 0) return k + 1
    }
  }
  return strut.length
}

/**
 * Fine di un'istruzione/espressione a partire da `da`: si ferma al `;` di
 * chiusura, a una virgola di livello 0, alla parentesi che chiude il blocco
 * ospite, o al fine riga di livello 0 (nel repo metà dei file non usa il `;`).
 */
function fineIstruzione(strut: string, da: number, fermaSuVirgola = false): number {
  let tondo = 0
  let quadro = 0
  let graffo = 0
  for (let k = da; k < strut.length; k++) {
    const c = strut[k]
    if (c === '(') tondo++
    else if (c === ')') { if (tondo === 0) return k; tondo-- }
    else if (c === '[') quadro++
    else if (c === ']') { if (quadro === 0) return k; quadro-- }
    else if (c === '{') graffo++
    else if (c === '}') { if (graffo === 0) return k; graffo-- }
    else if (tondo === 0 && quadro === 0 && graffo === 0) {
      if (c === ';') return k
      if (fermaSuVirgola && c === ',') return k
      if (c === '\n') return k
    }
  }
  return strut.length
}

/** Il `:` che chiude il `?` in `qIdx` (saltando i ternari annidati). */
function chiusuraTernario(strut: string, qIdx: number): number {
  let tondo = 0
  let quadro = 0
  let graffo = 0
  let annidati = 0
  for (let k = qIdx + 1; k < strut.length; k++) {
    const c = strut[k]
    if (c === '(') tondo++
    else if (c === ')') { if (tondo === 0) return -1; tondo-- }
    else if (c === '[') quadro++
    else if (c === ']') { if (quadro === 0) return -1; quadro-- }
    else if (c === '{') graffo++
    else if (c === '}') { if (graffo === 0) return -1; graffo-- }
    else if (tondo === 0 && quadro === 0 && graffo === 0) {
      if (c === '?') annidati++
      else if (c === ':') {
        if (annidati === 0) return k
        annidati--
      }
    }
  }
  return -1
}

/**
 * Gli argomenti del filtro di sede trovato in `idx`:
 * `.in('scuola_id', plessi)` ⇒ `'scuola_id', plessi`;
 * `` `scuola_id.in.(${plessi.join(',')})` `` ⇒ l'intera stringa.
 */
function argomentiDelFiltro(
  regione: { strut: string; senza: string },
  idx: number,
  testo: string,
): string | null {
  const primo = testo[0]
  if (primo === "'" || primo === '"' || primo === '`') {
    const chiusura = regione.strut.indexOf(primo, idx + 1)
    return chiusura < 0 ? null : regione.senza.slice(idx, chiusura + 1)
  }
  const apre = regione.strut.indexOf('(', idx)
  if (apre < 0) return null
  const chiude = fineParentesi(regione.strut, apre)
  return regione.senza.slice(apre + 1, chiude - 1)
}

/**
 * I punti fail-open di un sorgente. Funzione pura sul TESTO: è testata qui sotto
 * su frammenti sintetici, così il lock non può ingannarsi da solo.
 */
export function puntiFailOpen(src: string): PuntoFailOpen[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const fuori: PuntoFailOpen[] = []

  // Tutti gli `if (…)` del file, con l'estensione della loro condizione.
  const condizioni: { apre: number; chiude: number }[] = []
  for (const m of struttura.matchAll(/\bif\s*\(/g)) {
    const apre = struttura.indexOf('(', m.index)
    condizioni.push({ apre, chiude: fineParentesi(struttura, apre) })
  }

  GUARDIA.lastIndex = 0
  for (const g of senzaCommenti.matchAll(GUARDIA)) {
    const inizio = g.index
    const fine = inizio + g[0].length
    const base = g[1].split('.').pop() as string

    // La guardia è dentro la condizione di un `if`? Vince la più interna.
    let ospite: { apre: number; chiude: number } | null = null
    for (const c of condizioni) {
      if (c.apre < inizio && fine <= c.chiude && (!ospite || c.apre > ospite.apre)) ospite = c
    }

    // La regione è la stessa fetta letta in due modi: `strut` per contare le
    // parentesi, `senza` per leggere i contenuti.
    let regione: { strut: string; senza: string } | null = null
    let haElse = false
    let forma: PuntoFailOpen['forma'] = 'if'
    const taglia = (a: number, b: number) => ({
      strut: struttura.slice(a, b),
      senza: senzaCommenti.slice(a, b),
    })

    if (ospite) {
      const k = saltaSpazi(struttura, ospite.chiude)
      const fineCorpo = struttura[k] === '{' ? fineGraffa(struttura, k) : fineIstruzione(struttura, k)
      regione = taglia(k, fineCorpo)
      haElse = /^else\b/.test(struttura.slice(saltaSpazi(struttura, fineCorpo)))
    } else {
      const k = saltaSpazi(struttura, fine)
      if (struttura[k] === '?') {
        forma = 'ternario'
        const colon = chiusuraTernario(struttura, k)
        if (colon < 0) continue
        regione = taglia(k + 1, colon)
        const inizioElse = saltaSpazi(struttura, colon + 1)
        const fineElse = fineIstruzione(struttura, inizioElse, true)
        haElse = !RAMO_VUOTO.has(senzaCommenti.slice(inizioElse, fineElse).trim())
      } else if (struttura.startsWith('&&', k)) {
        forma = 'and'
        regione = taglia(k, fineIstruzione(struttura, k))
        haElse = false
      }
    }

    if (regione === null || haElse) continue

    // Il filtro di sede dev'essere costruito CON la lista della guardia: è
    // quello che rende la guardia un interruttore del perimetro. Si guardano
    // SOLO gli argomenti del filtro, non la catena intorno: in
    // `.eq('scuola_id', sede).in('classe', uniche)` la guardia `uniche.length`
    // governa l'elenco delle classi, non il perimetro — e non è un difetto.
    const parola = new RegExp(`\\b${base}\\b`)
    FILTRO_SEDE.lastIndex = 0
    for (const f of regione.senza.matchAll(FILTRO_SEDE)) {
      const argomenti = argomentiDelFiltro(regione, f.index, f[0])
      if (argomenti !== null && parola.test(argomenti)) {
        fuori.push({ riga: riga(src, inizio), guardia: g[0].trim(), forma })
        break
      }
    }
  }
  return fuori
}

const FILES = PERIMETRO.flatMap((d) => fileSorgente(d))

describe('lock di forma — scope vuoto NEGA (niente filtro condizionato allo scope)', () => {
  it('ci sono file da controllare (se cade, il test si sta autoingannando)', () => {
    expect(FILES.length).toBeGreaterThan(250)
  })

  it('nessun filtro su scuola_id è condizionato alla non-vuotezza dello scope', () => {
    const colpevoli: string[] = []
    for (const f of FILES) {
      const src = fs.readFileSync(f, 'utf8')
      for (const p of puntiFailOpen(src)) {
        colpevoli.push(`${path.relative(process.cwd(), f)}:${p.riga} — ${p.forma}: ${p.guardia}`)
      }
    }
    expect(colpevoli).toEqual([])
  })

  // ── Prova di validità permanente del rilevatore ────────────────────────────
  // Un lock che non sa più riconoscere il difetto è peggio di nessun lock: resta
  // verde e rassicura. Questi frammenti sono il difetto vero e le sue forme
  // lecite: se domani qualcuno «semplifica» il rilevatore, sono loro a cadere.
  describe('il rilevatore riconosce la forma vietata', () => {
    it('`if` senza else che condiziona il filtro alla lista della guardia', () => {
      const src = `
        const plessi = await resolveScuoleAttive(request, supabase, auth.user)
        let q = supabase.from('alunni').select('id')
        if (plessi.length > 0) q = q.in('scuola_id', plessi)
        const { data } = await q
      `
      expect(puntiFailOpen(src).map((p) => p.forma)).toEqual(['if'])
    })

    it('`if` a blocco, su più righe, con commenti in mezzo', () => {
      const src = `
        if (plessi.length > 0) {
          // filtro per sede
          query = query
            .in('scuola_id', plessi)
        }
      `
      expect(puntiFailOpen(src)).toHaveLength(1)
    })

    it('ternario col ramo negativo vuoto', () => {
      const src = 'const filtro = plessi.length > 0 ? `scuola_id.in.(${plessi.join(\',\')})` : \'\''
      expect(puntiFailOpen(src).map((p) => p.forma)).toEqual(['ternario'])
    })

    it('cortocircuito `&&`', () => {
      const src = "sedi.length > 0 && (q = q.in('scuola_id', sedi))"
      expect(puntiFailOpen(src).map((p) => p.forma)).toEqual(['and'])
    })
  })

  describe('il rilevatore NON segnala le forme lecite', () => {
    it('`if` con ramo `else` che nega', () => {
      const src = `
        if (plessi.length > 0) q = q.in('scuola_id', plessi)
        else return NextResponse.json([], { status: 200 })
      `
      expect(puntiFailOpen(src)).toEqual([])
    })

    it('ternario col ramo negativo che restringe davvero', () => {
      const src =
        "const filtroSede = plessi.length > 0\n" +
        '  ? `scuola_id.is.null,scuola_id.in.(${plessi.join(\',\')})`\n' +
        "  : 'scuola_id.is.null'"
      expect(puntiFailOpen(src)).toEqual([])
    })

    it('guardia su un\'ALTRA lista, con il perimetro incondizionato', () => {
      const src = `
        if (ids.length > 0) {
          const { data } = await supabase.from('alunni').select('id').in('id', ids).in('scuola_id', plessi)
        }
      `
      expect(puntiFailOpen(src)).toEqual([])
    })

    it('guardia su un\'altra lista NELLA STESSA catena del filtro di sede', () => {
      // `mensa/class-assignments:PUT`: la sede è già risolta e fissa
      // (`resolveScuolaScrittura`), la guardia governa l'elenco delle classi.
      const src = `
        if (uniche.length > 0) {
          const { data } = await supabase
            .from('mensa_class_menu_assignment')
            .select('id, classe')
            .eq('scuola_id', sede)
            .in('classe', uniche)
        }
      `
      expect(puntiFailOpen(src)).toEqual([])
    })

    it('filtro incondizionato con la guardia che NEGA (la forma giusta)', () => {
      const src = `
        const plessi = await resolveScuoleAttive(request, supabase, auth.user)
        if (plessi.length === 0) return NextResponse.json([])
        const { data } = await supabase.from('alunni').select('id').in('scuola_id', plessi)
      `
      expect(puntiFailOpen(src)).toEqual([])
    })

    it('un COMMENTO che cita la forma vietata non è la forma vietata', () => {
      const src = `
        // La guardia \`if (plessi.length > 0)\` che stava qui faceva l'opposto:
        // scope vuoto ⇒ nessun filtro ⇒ tutte le sedi. Ora q.in('scuola_id', plessi)
        // è incondizionato.
        const { data } = await supabase.from('alunni').select('id').in('scuola_id', plessi)
      `
      expect(puntiFailOpen(src)).toEqual([])
    })
  })
})
