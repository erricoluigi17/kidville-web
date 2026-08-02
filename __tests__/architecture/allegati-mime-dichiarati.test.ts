import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIME_ALLEGATI_AMMESSI, DIMENSIONE_MAX_ALLEGATO_BYTE } from '@/lib/allegati/mime'

/**
 * LOCK · i bucket degli allegati dichiarano cosa accettano, e lo dicono come il codice.
 *
 * LA STORIA (collaudo del 2026-07-31, sicurezza W7 + backend). `task_allegati` era l'UNICO
 * bucket con `allowed_mime_types = null`: prendeva qualunque tipo il browser dichiarasse. Il
 * tester ci ha caricato un finto `.html` e lo Storage l'ha memorizzato come `text/html`. Che
 * poi lo SERVA `text/plain` + `nosniff` è una difesa del provider — non nostra, non versionata,
 * e non ce lo verrebbe a dire nessuno il giorno in cui cambia. Sull'altro bucket il difetto era
 * gemello e opposto: `avvisi_allegati` aveva la lista, ma la route no, quindi un `.txt` usciva
 * come `500 {"error":"mime type text/plain is not supported"}` invece che come 415.
 *
 * PERCHÉ LE DUE DICHIARAZIONI DEVONO COINCIDERE, non «assomigliarsi»:
 *  · bucket più STRETTO del gate → il file passa il controllo e viene respinto DOPO il
 *    caricamento, come un 500 opaco: è esattamente il difetto di partenza;
 *  · bucket più LARGO del gate → l'unica difesa resta quella applicativa, e la riga della
 *    migrazione racconta una sicurezza che non c'è.
 * È lo stesso disallineamento che su `gallery` è vissuto per mesi (50 MB nel bucket, 200 nella
 * route) senza che niente diventasse rosso.
 *
 * Il gemello di questo lock, per il bucket pubblico `news`, sta in
 * `bucket-storage-dichiarati.test.ts`. Qui si guardano i due bucket privati degli allegati e
 * il modulo che li presidia, `src/lib/allegati/mime.ts`.
 */

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')

/** Gli statement di tutte le migrazioni, in ordine, senza commenti. */
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

const statementDelBucket = (bucket: string) =>
  STATEMENT.filter((s) => /storage\.buckets/i.test(s.sql) && new RegExp(`'${bucket}'`).test(s.sql))

/**
 * Divide per virgole, ma solo a profondità zero: `ARRAY['a','b']` è UN valore, non due.
 * (Stessa lettura di `bucket-storage-dichiarati.test.ts`: un bucket si può dichiarare con un
 * INSERT posizionale o con un UPDATE, e un lock che ne legge una sola forma legge una lista
 * vecchia senza accorgersene.)
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

/** `INSERT INTO storage.buckets (a, b) VALUES (1, 2)` → `{ a: '1', b: '2' }`, per POSIZIONE. */
function valoriInsert(sql: string): Record<string, string> | null {
  const m = sql.match(/insert\s+into\s+storage\.buckets\s*\(([^)]*)\)\s*values\s*\(([\s\S]*)/i)
  if (!m) return null
  const colonne = pezziAProfonditaZero(m[1]).map((c) => c.trim().toLowerCase())
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

/** L'ULTIMA lista di tipi dichiarata in migrazione per quel bucket (`[]` se nessuna). */
function mimeDichiarati(bucket: string): string[] {
  let ultimi: string[] = []
  for (const s of statementDelBucket(bucket)) {
    const assegnato = s.sql.match(/allowed_mime_types\s*=\s*(ARRAY\s*\[[\s\S]*?\])/i)?.[1]
    const sorgenteMime = assegnato ?? valoriInsert(s.sql)?.allowed_mime_types
    if (!sorgenteMime) continue
    const trovati = [...sorgenteMime.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((x) => x[1])
    if (trovati.length) ultimi = trovati
  }
  return ultimi
}

/** L'ULTIMO limite di dimensione dichiarato in migrazione per quel bucket. */
function limiteDichiarato(bucket: string): number | null {
  let ultimo: number | null = null
  for (const s of statementDelBucket(bucket)) {
    const inserito = valoriInsert(s.sql)?.file_size_limit
    if (inserito && /^\d+$/.test(inserito)) ultimo = Number(inserito)
    const assegnati = [...s.sql.matchAll(/file_size_limit\s*=\s*(\d+)/gi)]
    if (assegnati.length) ultimo = Number(assegnati[assegnati.length - 1][1])
  }
  return ultimo
}

const ordinati = (v: readonly string[]) => [...new Set(v)].sort()
const sorgente = (rel: string) => readFileSync(join(RADICE, rel), 'utf8')

const BUCKET_ALLEGATI = ['avvisi_allegati', 'task_allegati'] as const

/** Le due route che caricano un allegato: nessuna delle due può saltare il gate. */
const ROUTE_DI_UPLOAD = [
  'src/app/api/avvisi/upload/route.ts',
  'src/app/api/tasks/upload/route.ts',
] as const

describe('lock architettura · i bucket degli allegati dichiarano gli stessi tipi del codice', () => {
  it('le migrazioni si leggono davvero (controllo positivo del parser)', () => {
    // Un parser rotto renderebbe verdi per sempre tutte le prove qui sotto, su niente.
    expect(STATEMENT.length).toBeGreaterThan(100)
    expect(
      mimeDichiarati('news'),
      'Il parser non trova più i tipi del bucket `news`, che sono dichiarati da mesi in ' +
        '`20260731192048_bucket_news.sql`: se questa prova è rossa non è cambiata la ' +
        'configurazione, è rotta la lettura — e allora TUTTO questo file è verde per finta.',
    ).toContain('image/png')
  })

  it.each(BUCKET_ALLEGATI)('`%s` dichiara in migrazione ESATTAMENTE i tipi del gate', (bucket) => {
    const dichiarati = mimeDichiarati(bucket)
    expect(
      dichiarati.length,
      `Nessuna migrazione dichiara \`allowed_mime_types\` per \`${bucket}\`. Con la colonna a ` +
        'NULL il bucket accetta qualunque tipo il client si inventi: la sola difesa resterebbe ' +
        'quella applicativa, e basta una route nuova che dimentichi il gate per riaprire tutto.',
    ).toBeGreaterThan(0)
    expect(
      ordinati(dichiarati),
      `I tipi ammessi dal bucket \`${bucket}\` e quelli di \`MIME_ALLEGATI_AMMESSI\` ` +
        '(src/lib/allegati/mime.ts) devono coincidere: se il bucket è più stretto il file viene ' +
        'respinto DOPO il caricamento, come un 500 opaco; se è più largo la migrazione dichiara ' +
        'una sicurezza che non esiste.',
    ).toEqual(ordinati(MIME_ALLEGATI_AMMESSI))
  })

  it.each(BUCKET_ALLEGATI)('`%s` dichiara lo stesso limite di dimensione del gate', (bucket) => {
    expect(
      limiteDichiarato(bucket),
      `Il limite di \`${bucket}\` non è dichiarato in migrazione, oppure non è quello che la ` +
        'route fa rispettare. Due dichiarazioni dello stesso limite divergono: su `gallery` è ' +
        'successo per mesi (50 MB nel bucket, 200 MB nella route) e il file nel mezzo veniva ' +
        'respinto in silenzio.',
    ).toBe(DIMENSIONE_MAX_ALLEGATO_BYTE)
  })

  it.each(ROUTE_DI_UPLOAD)('`%s` passa dal gate condiviso', (rel) => {
    const codice = sorgente(rel)
    expect(
      /verificaAllegato\s*\(/.test(codice),
      `${rel} non chiama \`verificaAllegato\`: il tipo dichiarato dal client tornerebbe a ` +
        'essere l\'unica cosa che decide, e il rifiuto tornerebbe a essere il messaggio grezzo ' +
        'dello Storage (500) invece di un 415 comprensibile.',
    ).toBe(true)
    // E il tipo che arriva allo Storage è quello NORMALIZZATO dal gate, non `file.type` grezzo:
    // con `image/jpeg; charset=binary` il bucket rifiuterebbe la stringa intera.
    expect(
      /contentType:\s*gate\.contentType/.test(codice),
      `${rel} passa allo Storage un contentType che non viene dal gate.`,
    ).toBe(true)
  })

  it('il gate non è diventato «passa tutto» (controllo negativo)', () => {
    // Una lista che si allarga in silenzio è il modo elegante di disattivare questo lock:
    // qui restano fuori i tipi che hanno causato il rilievo.
    for (const vietato of ['text/html', 'text/plain', 'application/octet-stream', 'image/svg+xml']) {
      expect(
        (MIME_ALLEGATI_AMMESSI as readonly string[]).includes(vietato),
        `\`${vietato}\` è tornato fra i tipi ammessi per gli allegati. L'HTML e l'SVG portano ` +
          'script: oggi lo Storage li serve `text/plain` + `nosniff`, ma quella è una difesa ' +
          'del provider, e non è la nostra.',
      ).toBe(false)
    }
    // CONTROLLO POSITIVO: la lista serve ancora a qualcosa.
    expect((MIME_ALLEGATI_AMMESSI as readonly string[]).includes('application/pdf')).toBe(true)
  })
})
