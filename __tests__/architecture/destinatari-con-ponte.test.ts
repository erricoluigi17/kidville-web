import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineCatena, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK DI FORMA — chi lavora in una sede NON si trova con `utenti.scuola_id`.
 *
 * La forma vietata è questa:
 *
 *     const { data: staff } = await supabase
 *       .from('utenti').select('id').eq('scuola_id', scuolaId)     // ← lista muta
 *
 * L'appartenenza a una sede è l'UNIONE fra la colonna `utenti.scuola_id` (la
 * sede primaria) e la tabella ponte `utenti_scuole` — la stessa definizione che
 * usa `scuoleDiUtente` per decidere su quali plessi una persona può operare.
 * Chiedere la sola colonna vuol dire chiedere «chi ha questa sede come
 * PRIMARIA», che non è la domanda: nelle sedi aperte il 2026-07-29 (Aversa,
 * Cesa) all'inizio nessuno ce l'aveva come primaria, e la lista usciva VUOTA.
 *
 * Vuota, non sbagliata: nessun errore, nessun 500, nessun log. Quattro canali di
 * notifica — alert allergie della mensa, pulsante antipanico, richieste
 * armadietto, scarto di una fattura elettronica — hanno spedito a ZERO
 * destinatari continuando a rispondere 200. È lo stesso guasto delle email di
 * credenziali del 2026-07: il codice «funzionava», semplicemente non arrivava
 * niente a nessuno.
 *
 * `staffScuola` (`src/lib/notifiche/destinatari.ts`) fa quell'unione, gestisce il
 * ponte assente sul DB E2E non migrato e LOGGA quando i destinatari sono zero:
 * è l'unico posto del repo autorizzato a quella query.
 *
 * ATTENZIONE ALLA DIFFERENZA, che è tutta la regola:
 *
 *   `.eq('scuola_id', sede)`      «chi lavora NELLA SEDE X»  → serve il ponte. VIETATO.
 *   `.in('scuola_id', plessi)`    «restringi al MIO perimetro» → lecito: il ponte
 *                                 potrebbe solo AGGIUNGERE persone, e una
 *                                 restrizione che sbaglia per difetto non perde
 *                                 dati (è la forma di `admin/staff:GET`).
 */

const SRC = path.join(process.cwd(), 'src')

/** La query che chiede «chi appartiene a QUESTA sede» guardando la sola colonna. */
const SEDE_PUNTUALE = /\.eq\s*\(\s*['"`]scuola_id['"`]|['"`]scuola_id\.eq\./

/**
 * Le uniche funzioni autorizzate a quella query, con la ragione.
 * Non il file: la FUNZIONE. Un helper nuovo nello stesso file non eredita
 * l'esenzione — e `staffScuola` è esente perché quella `.eq()` è METÀ di
 * un'unione che comprende `utenti_scuole`.
 */
const AMMESSE: { file: string; funzione: string; ragione: string }[] = [
  {
    file: 'src/lib/notifiche/destinatari.ts',
    funzione: 'staffScuola',
    ragione:
      'è l\'unione stessa: sede primaria + ponte utenti_scuole, con log su ponte assente e su zero destinatari',
  },
]

export interface DestinatarioSenzaPonte {
  riga: number
  funzione: string | null
}

/** Il corpo (indici) della funzione `nome`, comunque sia dichiarata. */
function corpoFunzione(strut: string, nome: string): { a: number; b: number } | null {
  const dichiarazione =
    new RegExp(`\\bfunction\\s+${nome}\\s*\\(`).exec(strut) ??
    new RegExp(`\\b(?:const|let|var)\\s+${nome}\\s*=`).exec(strut)
  if (!dichiarazione) return null
  const apre = strut.indexOf('{', dichiarazione.index)
  if (apre < 0) return null
  let livello = 0
  for (let k = apre; k < strut.length; k++) {
    if (strut[k] === '{') livello++
    else if (strut[k] === '}') {
      livello--
      if (livello === 0) return { a: apre, b: k + 1 }
    }
  }
  return null
}

/**
 * Le query su `utenti` che risolvono la sede con la sola colonna.
 * `esenti`: nomi di funzione il cui corpo è autorizzato (allowlist del file).
 */
export function destinatariSenzaPonte(src: string, esenti: string[] = []): DestinatarioSenzaPonte[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const zone = esenti
    .map((n) => corpoFunzione(struttura, n))
    .filter((z): z is { a: number; b: number } => z !== null)
  const fuori: DestinatarioSenzaPonte[] = []

  for (const m of senzaCommenti.matchAll(/\.from\(\s*['"]utenti['"]\s*\)/g)) {
    const inizio = m.index
    const fine = fineCatena(struttura, inizio)
    const tratti = [{ a: inizio, b: fine }]

    // Continuazioni condizionali sulla stessa variabile: PostgREST le combina
    // in AND, quindi fanno parte della stessa query.
    const prima = senzaCommenti.slice(Math.max(0, inizio - 200), inizio)
    const senzaRicevitore = prima.replace(/(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*$/, '')
    const variabile =
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(senzaRicevitore)?.[1] ??
      /(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=\s*$/.exec(senzaRicevitore)?.[1] ??
      null
    if (variabile) {
      const riassegna = new RegExp(`\\b${variabile}\\s*=`, 'g')
      riassegna.lastIndex = fine
      for (let r = riassegna.exec(senzaCommenti); r; r = riassegna.exec(senzaCommenti)) {
        const dopo = senzaCommenti.slice(r.index + r[0].length)
        const cont = new RegExp(`^\\s*(?:await\\s+)?${variabile}\\s*\\.`).exec(dopo)
        if (!cont) break
        const punto = r.index + r[0].length + cont[0].length - 1
        tratti.push({ a: punto, b: fineCatena(struttura, punto) })
      }
    }

    const testo = tratti.map((t) => senzaCommenti.slice(t.a, t.b)).join('\n')
    if (!SEDE_PUNTUALE.test(testo)) continue
    if (zone.some((z) => inizio >= z.a && inizio < z.b)) continue
    fuori.push({ riga: riga(src, inizio), funzione: null })
  }
  return fuori
}

const FILES = fileSorgente(SRC)
const esentiDi = (rel: string) => AMMESSE.filter((a) => a.file === rel).map((a) => a.funzione)

describe('lock di forma — i destinatari di una sede passano dal ponte', () => {
  it('ci sono file da controllare (se cade, il test si sta autoingannando)', () => {
    expect(FILES.length).toBeGreaterThan(200)
  })

  it('esiste davvero del codice che legge `utenti` (il lock non gira a vuoto)', () => {
    const conUtenti = FILES.filter((f) => /\.from\(\s*['"]utenti['"]\s*\)/.test(fs.readFileSync(f, 'utf8')))
    expect(conUtenti.length).toBeGreaterThan(20)
  })

  it('nessuno risolve la sede di un utente con la sola colonna `utenti.scuola_id`', () => {
    const colpevoli: string[] = []
    for (const f of FILES) {
      const rel = path.relative(process.cwd(), f)
      for (const p of destinatariSenzaPonte(fs.readFileSync(f, 'utf8'), esentiDi(rel))) {
        colpevoli.push(`${rel}:${p.riga}`)
      }
    }
    expect(colpevoli).toEqual([])
  })

  it("l'allowlist punta a funzioni che esistono e che fanno davvero quella query", () => {
    for (const a of AMMESSE) {
      const full = path.join(process.cwd(), a.file)
      expect(fs.existsSync(full), `${a.file} non esiste`).toBe(true)
      const src = fs.readFileSync(full, 'utf8')
      // Senza l'esenzione la funzione DEVE risultare colpevole: se non lo è più,
      // la voce è morta e va tolta — un'allowlist che protegge il nulla è solo
      // un buco aperto per il prossimo.
      expect(destinatariSenzaPonte(src, []).length, `${a.funzione}: voce morta`).toBeGreaterThan(0)
      expect(destinatariSenzaPonte(src, [a.funzione])).toEqual([])
    }
  })

  it('`src/lib/auth/scope.ts` non fa quella query (non serve esentarlo)', () => {
    // Il piano lo citava fra gli esenti: non lo è, perché il ponte lo legge da
    // `utenti_scuole` e su `utenti` filtra per `id`. Se un domani qualcuno ce la
    // mettesse, questo test lo dice invece di lasciarlo passare in allowlist.
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/auth/scope.ts'), 'utf8')
    expect(destinatariSenzaPonte(src, [])).toEqual([])
  })

  // ── Prova di validità permanente del rilevatore ────────────────────────────
  describe('il rilevatore riconosce la forma vietata', () => {
    it('la lista staff risolta con la sola colonna', () => {
      const src = `
        const { data: staff } = await supabase
          .from('utenti')
          .select('id, nome, cognome')
          .neq('ruolo', 'genitore')
          .eq('scuola_id', scuolaId)
      `
      expect(destinatariSenzaPonte(src)).toHaveLength(1)
    })

    it('anche nella forma PostgREST `.or(\'scuola_id.eq.…\')`', () => {
      const src = "const { data } = await supabase.from('utenti').select('id').or(`scuola_id.eq.${sede}`)"
      expect(destinatariSenzaPonte(src)).toHaveLength(1)
    })

    it('anche se il filtro arriva da una continuazione condizionale', () => {
      const src = `
        let q = supabase.from('utenti').select('id')
        if (sede) q = q.eq('scuola_id', sede)
        const { data } = await q
      `
      expect(destinatariSenzaPonte(src)).toHaveLength(1)
    })

    it('un COMMENTO che descrive il bug corretto non è il bug', () => {
      const src = `
        // Qui c'era una \`.eq('scuola_id', …)\` nuda: la lista usciva vuota.
        const ids = await staffScuola(supabase, scuolaId, RUOLI)
        const { data } = await supabase.from('utenti').select('id, nome').in('id', ids)
      `
      expect(destinatariSenzaPonte(src)).toEqual([])
    })
  })

  describe('il rilevatore NON segnala le forme lecite', () => {
    it('`.in(\'scuola_id\', plessi)`: restringere al proprio perimetro', () => {
      const src = `
        const { data } = await supabase
          .from('utenti').select('id, nome, ruolo').neq('ruolo', 'genitore').in('scuola_id', plessi)
      `
      expect(destinatariSenzaPonte(src)).toEqual([])
    })

    it('`.eq(\'id\', …)`: leggere UN utente e poi la sua sede', () => {
      const src = `
        const { data: u } = await supabase.from('utenti').select('id, scuola_id').eq('id', userId).maybeSingle()
        const { data: s } = await supabase.from('admin_settings').select('x').eq('scuola_id', u.scuola_id)
      `
      expect(destinatariSenzaPonte(src)).toEqual([])
    })

    it('la funzione esentata resta esentata (e solo lei)', () => {
      const src = `
        export async function staffScuola(supabase, scuolaId, ruoli) {
          const { data } = await supabase.from('utenti').select('id').eq('scuola_id', scuolaId)
          const { data: ponte } = await supabase.from('utenti_scuole').select('utente_id').eq('scuola_id', scuolaId)
          return [...(data ?? []), ...(ponte ?? [])]
        }
        export async function altroHelper(supabase, scuolaId) {
          const { data } = await supabase.from('utenti').select('id').eq('scuola_id', scuolaId)
          return data ?? []
        }
      `
      expect(destinatariSenzaPonte(src, ['staffScuola'])).toHaveLength(1)
      expect(destinatariSenzaPonte(src, ['staffScuola', 'altroHelper'])).toEqual([])
    })
  })
})
