import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto, type Riga } from './finto-supabase'

// =============================================================================
// Finto Supabase che APPLICA DAVVERO la proiezione di `select()`.
//
// PERCHÉ ESISTE. `finto-supabase` dichiara in testa ciò che NON emula, e la
// prima voce dell'elenco è proprio questa: «la proiezione delle colonne di
// `select()`: le righe tornano INTERE, quindi un test non può provare "quel
// campo non è stato selezionato"». È una limitazione onesta, ma rende
// IMPOSSIBILE provare un difetto di privacy: `expect(corpo).not.toContain(
// 'NOTA-MEDICA')` sarebbe rosso anche dopo la correzione, perché la riga finta
// porta comunque il campo. E il contrario — un test che passa la spia sulle
// sole colonne CHIESTE — prova che la query è cambiata, non che la RISPOSTA sia
// cambiata: se domani la route rimettesse il campo in risposta partendo da
// un'altra query, la spia resterebbe verde.
//
// Qui si emula ciò che in produzione decide davvero: PostgREST restituisce solo
// le colonne chieste. Così il test può asserire la FORMA ESATTA del corpo HTTP —
// quali chiavi ci sono e, soprattutto, quali NON ci sono.
//
// COSA EMULA, e con quali confini dichiarati:
//  · elenco di colonne di primo livello, con alias `alias:colonna`;
//  · `*` (da solo o dentro un elenco) ⇒ riga intera, come PostgREST;
//  · risorse EMBEDDED (`tab ( … )`, `tab!inner ( … )`, `alias:tab ( … )`): la
//    CHIAVE viene conservata così com'è nel fixture. Il contenuto dell'embed
//    NON viene proiettato: lo costruisce il fixture, non la stringa di select
//    (stessa scelta di `finto-supabase`).
//  · una colonna chiesta e assente dalla riga finta NON viene inventata: se il
//    fixture non ce l'ha, la chiave non compare (come una colonna NULL che il
//    test non ha valorizzato).
// =============================================================================

export interface Proiezione {
  tabella: string
  /** La stringa passata a `select()`, `'*'` quando la chiamata è nuda. */
  colonne: string
}

/** Divide sulle virgole di primo livello, rispettando le parentesi tonde. */
function dividiLivello(testo: string): string[] {
  const pezzi: string[] = []
  let profondita = 0
  let corrente = ''
  for (const c of testo) {
    if (c === '(') profondita++
    if (c === ')') profondita--
    if (c === ',' && profondita === 0) {
      pezzi.push(corrente)
      corrente = ''
      continue
    }
    corrente += c
  }
  pezzi.push(corrente)
  return pezzi.map((p) => p.trim()).filter((p) => p !== '')
}

/**
 * Le CHIAVI che PostgREST restituirebbe per questa stringa di select.
 * `null` significa «tutto» (`*` presente): la riga torna intera.
 */
export function chiaviDiSelect(select: string | undefined): string[] | null {
  const testo = String(select ?? '*').trim()
  if (testo === '' ) return null
  const chiavi: string[] = []
  for (const pezzo of dividiLivello(testo)) {
    if (pezzo === '*') return null
    const apertura = pezzo.indexOf('(')
    if (apertura >= 0) {
      // Embed: `alias:tabella!inner ( … )` → la chiave è l'alias, altrimenti la tabella.
      const testa = pezzo.slice(0, apertura).trim()
      const [sinistra, destra] = testa.includes(':') ? testa.split(':') : [null, testa]
      const nome = (sinistra ?? destra).replace(/!\s*inner/i, '').trim()
      if (nome) chiavi.push(nome)
      continue
    }
    // Colonna semplice, eventualmente con alias `alias:colonna`.
    const nome = pezzo.includes(':') ? pezzo.split(':')[0].trim() : pezzo.trim()
    if (nome) chiavi.push(nome)
  }
  return chiavi
}

/**
 * Proietta una riga come farebbe PostgREST data la stringa di `select()`.
 * Utile ai test che montano un finto client a mano invece di `finto-supabase`.
 */
export function proiettaConSelect(riga: Riga, select: string | undefined): Riga {
  return proiettaRiga(riga, chiaviDiSelect(select))
}

/** Applica la proiezione a una riga. `chiavi === null` ⇒ riga intera. */
function proiettaRiga(riga: Riga, chiavi: string[] | null): Riga {
  if (chiavi === null) return riga
  const out: Riga = {}
  for (const k of chiavi) {
    if (k in riga) out[k] = riga[k]
  }
  return out
}

function proiettaDati(dati: unknown, chiavi: string[] | null): unknown {
  if (chiavi === null || dati == null) return dati
  if (Array.isArray(dati)) return (dati as Riga[]).map((r) => proiettaRiga(r, chiavi))
  if (typeof dati === 'object') return proiettaRiga(dati as Riga, chiavi)
  return dati
}

/**
 * Crea un finto client che, oltre a tutto ciò che fa `creaFintoSupabase`,
 * PROIETTA le colonne come PostgREST e annota ogni `select()` in `proiezioni`.
 *
 * @param proiezioni accumulatore delle stringhe di select osservate.
 */
export function creaFintoSupabaseConProiezione(
  db: DBFinto,
  tabelleLette: string[] = [],
  opzioni: OpzioniFinto = {},
  proiezioni: Proiezione[] = [],
): SupabaseClient {
  const client = creaFintoSupabase(db, tabelleLette, opzioni)
  const originale = (client as unknown as { from: (t: string) => unknown }).from.bind(client)

  ;(client as unknown as { from: (t: string) => unknown }).from = (tabella: string) => {
    const b = originale(tabella) as Record<string, unknown>
    // `finto-supabase` restituisce un Proxy con la sola trappola `get`: la
    // SCRITTURA di una proprietà arriva al bersaglio, quindi si possono
    // sostituire `select` e i terminatori senza toccare il fixture condiviso.
    let chiavi: string[] | null = null

    const selOriginale = (b.select as (c?: string, o?: unknown) => unknown).bind(b)
    b.select = (colonne?: string, opts?: unknown) => {
      proiezioni.push({ tabella, colonne: String(colonne ?? '*') })
      chiavi = chiaviDiSelect(colonne)
      return selOriginale(colonne, opts)
    }

    type Esito = { data: unknown; error: unknown }
    const conProiezione = <T extends Esito>(r: T): T => ({ ...r, data: proiettaDati(r.data, chiavi) })

    const singleOriginale = (b.single as () => Promise<Esito>).bind(b)
    b.single = async () => conProiezione(await singleOriginale())

    const maybeOriginale = (b.maybeSingle as () => Promise<Esito>).bind(b)
    b.maybeSingle = async () => conProiezione(await maybeOriginale())

    const thenOriginale = (b.then as (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => unknown).bind(b)
    b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      thenOriginale((r) => ok(conProiezione(r as Esito)), ko)

    return b
  }

  return client
}
