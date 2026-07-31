import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK · un bucket si dichiara in migrazione, e dice le stesse cose del codice
//
// IL DIFETTO, misurato in produzione il 2026-07-31:
//   · `storage.buckets` → gallery.file_size_limit = 52428800 (50 MB)
//   · `src/app/api/gallery/upload/route.ts` → fileSizeLimit: 209715200 (200 MB)
// Due dichiarazioni della stessa regola, in due posti, divergenti da mesi. Un video
// da 120 MB passava tutti i controlli dell'applicazione e veniva rifiutato dallo
// Storage: l'esito di `updateBucket` non lo guardava nessuno, quindi lo scarto non
// lasciava traccia da nessuna parte.
//
// E il bucket «news» non esisteva affatto: `api/news/upload` lo avrebbe creato al
// volo, e pubblico, come effetto collaterale del primo caricamento. La
// configurazione di uno spazio destinato all'esterno non può nascere così: non è
// versionata, non è rivedibile, e cambia da sola il giorno in cui qualcuno modifica
// la route.
//
// COSA PRETENDE QUESTO LOCK.
//  1. Ogni bucket qui sotto è dichiarato in una migrazione.
//  2. I valori che il codice ripete devono coincidere con quelli della migrazione.
//     Non «essere simili»: coincidere. È l'unico modo perché la divergenza si veda
//     PRIMA, invece che come un caricamento respinto in silenzio.
//
// PERCHÉ SU `gallery` SI CONFRONTA SOLO IL LIMITE. La lista dei tipi ammessi del
// bucket in produzione (che contiene `video/quicktime` e non contiene `image/gif`)
// diverge da quella della route: è un secondo disallineamento, REALE, che però
// cambierebbe cosa si può caricare e non è stato deciso. Sta nel rapporto, non qui
// dentro: un lock non è il posto dove prendere decisioni di prodotto di nascosto.
// ─────────────────────────────────────────────────────────────────────────────

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')

/** Gli statement SQL di tutte le migrazioni, in ordine, senza commenti. */
function statementDelleMigrazioni(): { file: string; sql: string }[] {
  const out: { file: string; sql: string }[] = []
  for (const file of readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort()) {
    const testo = readFileSync(join(MIGRAZIONI, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
    for (const sql of testo.split(';')) if (sql.trim()) out.push({ file, sql })
  }
  return out
}

const STATEMENT = statementDelleMigrazioni()

/** Gli statement che configurano il bucket indicato. */
function statementDelBucket(bucket: string): { file: string; sql: string }[] {
  return STATEMENT.filter(
    (s) => /storage\.buckets/i.test(s.sql) && new RegExp(`'${bucket}'`).test(s.sql),
  )
}

/**
 * Divide per virgole, ma solo a profondità zero: `ARRAY['a','b']` è UN valore, non due.
 * Senza questo, la colonna dei tipi MIME sfalserebbe tutte quelle dopo di lei.
 */
function pezziAProfonditaZero(testo: string): string[] {
  const pezzi: string[] = []
  let corrente = ''
  let profondita = 0
  let inStringa = false
  for (const ch of testo) {
    if (ch === "'") inStringa = !inStringa
    if (!inStringa && (ch === '(' || ch === '[')) profondita++
    if (!inStringa && (ch === ')' || ch === ']')) profondita--
    if (ch === ',' && profondita === 0 && !inStringa) {
      pezzi.push(corrente.trim())
      corrente = ''
    } else corrente += ch
  }
  if (corrente.trim()) pezzi.push(corrente.trim())
  return pezzi
}

/**
 * `INSERT INTO storage.buckets (a, b, c) VALUES (1, 2, 3)` → { a: '1', b: '2', c: '3' }.
 *
 * Si legge la posizione, non la vicinanza fra la parola e un numero: in un INSERT il
 * valore di una colonna può stare venti righe più in basso, e un parser «a distanza»
 * leggerebbe il numero della colonna sbagliata senza accorgersene.
 */
function valoriInsert(sql: string): Record<string, string> | null {
  const m = sql.match(/insert\s+into\s+storage\.buckets\s*\(([^)]*)\)\s*values\s*\(([\s\S]*)/i)
  if (!m) return null
  const colonne = pezziAProfonditaZero(m[1]).map((c) => c.trim().toLowerCase())
  // Il corpo dei VALUES finisce con la parentesi che li chiude.
  let profondita = 1
  let corpo = ''
  let inStringa = false
  for (const ch of m[2]) {
    if (ch === "'") inStringa = !inStringa
    if (!inStringa && (ch === '(' || ch === '[')) profondita++
    if (!inStringa && (ch === ')' || ch === ']')) profondita--
    if (profondita === 0) break
    corpo += ch
  }
  const valori = pezziAProfonditaZero(corpo)
  if (valori.length !== colonne.length) return null
  return Object.fromEntries(colonne.map((c, i) => [c, valori[i]]))
}

/** L'ULTIMO limite di dimensione dichiarato in migrazione per quel bucket. */
function limiteDichiarato(bucket: string): number | null {
  let ultimo: number | null = null
  for (const s of statementDelBucket(bucket)) {
    const inserito = valoriInsert(s.sql)?.file_size_limit
    if (inserito && /^\d+$/.test(inserito)) ultimo = Number(inserito)
    const assegnato = [...s.sql.matchAll(/file_size_limit\s*=\s*(\d+)/gi)]
    if (assegnato.length) ultimo = Number(assegnato[assegnato.length - 1][1])
  }
  return ultimo
}

/** I tipi MIME dichiarati in migrazione per quel bucket (ultimo statement che ne elenca). */
function mimeDichiarati(bucket: string): string[] {
  let ultimi: string[] = []
  for (const s of statementDelBucket(bucket)) {
    const inserito = valoriInsert(s.sql)?.allowed_mime_types
    const assegnato = s.sql.match(/allowed_mime_types\s*=\s*(ARRAY\s*\[[\s\S]*?\])/i)?.[1]
    const sorgenteMime = assegnato ?? inserito
    if (!sorgenteMime) continue
    const trovati = [...sorgenteMime.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((m) => m[1])
    if (trovati.length) ultimi = trovati
  }
  return ultimi
}

const sorgente = (rel: string) => readFileSync(join(RADICE, rel), 'utf8')

/** `fileSizeLimit: 209715200` nel sorgente di una route. */
function limiteNelCodice(rel: string): number | null {
  const m = sorgente(rel).match(/fileSizeLimit:\s*(\d+)/)
  return m ? Number(m[1]) : null
}

/** I letterali MIME dentro `const <NOME> = [ … ]`. */
function mimeNelCodice(rel: string, costante: string): string[] {
  const m = sorgente(rel).match(new RegExp(`const\\s+${costante}\\s*=\\s*\\[([\\s\\S]*?)\\]`))
  if (!m) return []
  return [...m[1].matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((x) => x[1])
}

const ordinati = (v: string[]) => [...new Set(v)].sort()

describe('lock architettura · i bucket dello storage sono dichiarati in migrazione', () => {
  it('le migrazioni si leggono davvero (sanity)', () => {
    // Un parser rotto renderebbe questo lock verde per sempre, su niente.
    expect(STATEMENT.length).toBeGreaterThan(100)
  })

  describe('gallery — foto e video dei bambini, bucket privato', () => {
    it('ha un limite di dimensione dichiarato in migrazione', () => {
      expect(
        limiteDichiarato('gallery'),
        'Nessuna migrazione imposta `file_size_limit` sul bucket `gallery`: il limite vive ' +
          'solo dentro la route, che lo riscrive a ogni upload sperando che vada a buon fine.',
      ).not.toBeNull()
    })

    it('il limite della migrazione è lo stesso che dichiara la route', () => {
      const codice = limiteNelCodice('src/app/api/gallery/upload/route.ts')
      expect(codice, 'La route deve dichiarare `fileSizeLimit`.').not.toBeNull()
      expect(
        limiteDichiarato('gallery'),
        `La route accetta ${codice} byte, la migrazione ne dichiara altri: il file che sta ` +
          'nel mezzo passa i controlli dell\'applicazione e viene respinto dallo Storage.',
      ).toBe(codice)
    })
  })

  describe('news — media del blog pubblico', () => {
    it('il bucket è creato da una migrazione (non dall’upload)', () => {
      const creazione = statementDelBucket('news').filter((s) => /insert\s+into/i.test(s.sql))
      expect(
        creazione.map((s) => s.file),
        'Il bucket `news` non è dichiarato in nessuna migrazione. Senza, la prima chiamata a ' +
          '`api/news/upload` lo creerebbe al volo con le opzioni scritte nella route.',
      ).not.toEqual([])
    })

    it('ha un limite di dimensione dichiarato', () => {
      expect(limiteDichiarato('news')).not.toBeNull()
    })

    it('i tipi ammessi dal bucket sono ESATTAMENTE quelli che accetta la route', () => {
      const codice = ordinati(mimeNelCodice('src/app/api/news/upload/route.ts', 'MIME_AMMESSI'))
      expect(codice.length, 'La route deve elencare i MIME ammessi in `MIME_AMMESSI`.').toBeGreaterThan(0)
      expect(
        ordinati(mimeDichiarati('news')),
        'Il gate della route e il bucket devono dire la stessa cosa: se il bucket è più ' +
          'stretto il file viene respinto dopo il caricamento (500 opaco), se è più largo ' +
          'l\'unico controllo che resta è quello applicativo.',
      ).toEqual(codice)
    })
  })
})
