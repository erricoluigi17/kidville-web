import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { bloccanti, rimuoviEVerifica } from '@/lib/storage/rimozione-verificata'
import { oggettoAssente } from '@/lib/storage/copia-verificata'

/**
 * IL CESTINO DEI FILE: OGGI SI SPOSTA, IL GIRO NOTTURNO DISTRUGGE.
 *
 * Una cancellazione a più passi che toglie i file per PRIMI li perde quando un passo dopo
 * fallisce: la riga resta, il documento no. Qui il passo sui file diventa l'ULTIMO e diventa
 * reversibile: il file va in `cestino/<giorno UTC>/<percorso di prima>` dello stesso bucket, e
 * `cestino-registro-retention` lo distrugge passato il termine del cestino.
 *
 * Se lo spostamento non riesce, il file si cancella subito (il comportamento di prima): le righe
 * che lo nominavano sono già andate, e un file che nessuna riga nomina è peggio di un file
 * cancellato. Se non si riesce nemmeno a cancellarlo è un ORFANO, e si grida.
 *
 * Nei log mai i percorsi: solo conteggi.
 */

export const PREFISSO_CESTINO = 'cestino'
/** Quanti file al massimo un giro toglie dal cestino: il resto lo prende il giro dopo. */
export const TETTO_FILE_CESTINO = 500
const PAGINA_ELENCO = 1000
/** Un elenco senza tetto è un ciclo che può non finire: cento pagine bastano e avanzano. */
const PAGINE_MASSIME = 100
const GIORNO_CARTELLA = /^\d{4}-\d{2}-\d{2}$/

type Archivio = ReturnType<SupabaseClient['storage']['from']>

export function giornoCestino(adesso: Date): string {
  return adesso.toISOString().slice(0, 10)
}

export function percorsoNelCestino(percorso: string, adesso: Date): string {
  return `${PREFISSO_CESTINO}/${giornoCestino(adesso)}/${percorso}`
}

export type EsitoCestino = {
  /** Spostati nel cestino: si possono ancora recuperare. */
  nelCestino: number
  /** Non c'erano più: esito già raggiunto. */
  giaAssenti: number
  /** Lo spostamento non è riuscito e sono stati cancellati subito. */
  rimossiSenzaCestino: number
  /** Né spostati né cancellati: restano al loro posto senza una riga che li nomini. */
  orfani: number
}

function normalizza(percorsi: (string | null | undefined)[]): string[] {
  const out = new Set<string>()
  for (const p of percorsi) {
    if (typeof p !== 'string') continue
    const pulito = p.trim().replace(/^\/+/, '')
    if (!pulito || pulito === PREFISSO_CESTINO || pulito.startsWith(`${PREFISSO_CESTINO}/`)) continue
    out.add(pulito)
  }
  return [...out]
}

export async function spostaNelCestino(
  supabase: SupabaseClient,
  bucket: string,
  percorsi: (string | null | undefined)[],
  op: string,
  adesso: Date = new Date(),
): Promise<EsitoCestino> {
  const esito: EsitoCestino = { nelCestino: 0, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 0 }
  const unici = normalizza(percorsi)
  if (unici.length === 0) return esito

  const archivio = supabase.storage.from(bucket)
  const daRimuovere: string[] = []
  let primoErrore: unknown = null
  for (const p of unici) {
    try {
      const { error } = await archivio.move(p, percorsoNelCestino(p, adesso))
      if (!error) esito.nelCestino++
      else if (oggettoAssente(error)) esito.giaAssenti++
      else {
        daRimuovere.push(p)
        primoErrore ??= error
      }
    } catch (e) {
      daRimuovere.push(p)
      primoErrore ??= e
    }
  }

  if (daRimuovere.length > 0) {
    logEvento(
      'storage',
      'warn',
      { operazione: op, esito: 'cestino-non-raggiunto', tipo: 'cestino-file', bucket, n_file: daRimuovere.length },
      primoErrore,
    )
    const r = await rimuoviEVerifica(supabase, bucket, daRimuovere, op)
    if (r.erroreRimozione) {
      esito.orfani += daRimuovere.length
    } else {
      esito.rimossiSenzaCestino += r.rimossi.length
      esito.giaAssenti += r.giaAssenti.length
      esito.orfani += bloccanti(r).length
    }
  }

  if (esito.orfani > 0) {
    logEvento('storage', 'error', {
      operazione: op,
      esito: 'file-orfani-fuori-cestino',
      tipo: 'cestino-file',
      bucket,
      n_file: esito.orfani,
    })
  }
  logEvento('storage', 'info', {
    operazione: op,
    esito: 'file-nel-cestino',
    tipo: 'cestino-file',
    bucket,
    n_file: unici.length,
    n_nel_cestino: esito.nelCestino,
    n_gia_assenti: esito.giaAssenti,
    n_rimossi_senza_cestino: esito.rimossiSenzaCestino,
    n_orfani: esito.orfani,
  })
  return esito
}

// ─── Lo svuotamento, chiamato dal giro notturno ──────────────────────────────

export type EsitoSvuotamento = {
  esito: 'ok' | 'elenco-fallito' | 'file-non-rimossi'
  giorniScaduti: number
  fileRimossi: number
  fileGiaAssenti: number
  fileBloccanti: number
  lottoPieno: boolean
}

export const SVUOTAMENTO_VUOTO: EsitoSvuotamento = {
  esito: 'ok',
  giorniScaduti: 0,
  fileRimossi: 0,
  fileGiaAssenti: 0,
  fileBloccanti: 0,
  lottoPieno: false,
}

type Voce = { name: string; id: string | null }
type Elenco = { ok: true; voci: Voce[] } | { ok: false; errore: unknown }

async function elenca(archivio: Archivio, cartella: string, offset: number): Promise<Elenco> {
  try {
    const { data, error } = await archivio.list(cartella, {
      limit: PAGINA_ELENCO,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    })
    if (error) return { ok: false, errore: error }
    const voci = (Array.isArray(data) ? data : []).map((o) => ({
      name: typeof o?.name === 'string' ? o.name : '',
      id: typeof o?.id === 'string' ? o.id : null,
    }))
    return { ok: true, voci }
  } catch (e) {
    return { ok: false, errore: e }
  }
}

async function tutteLeVoci(archivio: Archivio, cartella: string): Promise<Elenco> {
  const voci: Voce[] = []
  for (let pagina = 0; pagina < PAGINE_MASSIME; pagina++) {
    const r = await elenca(archivio, cartella, pagina * PAGINA_ELENCO)
    if (!r.ok) return r
    voci.push(...r.voci)
    if (r.voci.length < PAGINA_ELENCO) break
  }
  return { ok: true, voci }
}

/** I file sotto `cartella`, a qualunque profondità, fino a `tetto`. `id === null` è una cartella. */
async function fileSotto(
  archivio: Archivio,
  cartella: string,
  tetto: number,
  out: string[],
): Promise<{ ok: true } | { ok: false; errore: unknown }> {
  for (let pagina = 0; pagina < PAGINE_MASSIME && out.length < tetto; pagina++) {
    const r = await elenca(archivio, cartella, pagina * PAGINA_ELENCO)
    if (!r.ok) return r
    for (const v of r.voci) {
      if (out.length >= tetto) break
      if (!v.name) continue
      const percorso = `${cartella}/${v.name}`
      if (v.id === null) {
        const sotto = await fileSotto(archivio, percorso, tetto, out)
        if (!sotto.ok) return sotto
      } else {
        out.push(percorso)
      }
    }
    if (r.voci.length < PAGINA_ELENCO) break
  }
  return { ok: true }
}

/**
 * Distrugge i file entrati nel cestino in un giorno PRECEDENTE a `sogliaGiorno` (AAAA-MM-GG).
 * Il termine non si decide qui: lo passa il giro notturno, che è il solo a conoscerlo.
 */
export async function svuotaCestinoScaduto(
  supabase: SupabaseClient,
  bucket: string,
  sogliaGiorno: string,
  op: string,
): Promise<EsitoSvuotamento> {
  const archivio = supabase.storage.from(bucket)
  const esito: EsitoSvuotamento = { ...SVUOTAMENTO_VUOTO }

  const radice = await tutteLeVoci(archivio, PREFISSO_CESTINO)
  if (!radice.ok) {
    logEvento('storage', 'error', { operazione: op, esito: 'cestino-non-letto', tipo: 'cestino-file', bucket }, radice.errore)
    return { ...esito, esito: 'elenco-fallito' }
  }
  const giorni = radice.voci
    .filter((v) => v.id === null && GIORNO_CARTELLA.test(v.name) && v.name < sogliaGiorno)
    .map((v) => v.name)
    .sort()
  esito.giorniScaduti = giorni.length

  const raccolti: string[] = []
  for (const g of giorni) {
    if (raccolti.length > TETTO_FILE_CESTINO) break
    const r = await fileSotto(archivio, `${PREFISSO_CESTINO}/${g}`, TETTO_FILE_CESTINO + 1, raccolti)
    if (!r.ok) {
      logEvento('storage', 'error', { operazione: op, esito: 'cestino-non-letto', tipo: 'cestino-file', bucket }, r.errore)
      return { ...esito, esito: 'elenco-fallito' }
    }
  }
  esito.lottoPieno = raccolti.length > TETTO_FILE_CESTINO
  const lotto = raccolti.slice(0, TETTO_FILE_CESTINO)

  if (lotto.length > 0) {
    const r = await rimuoviEVerifica(supabase, bucket, lotto, op)
    if (r.erroreRimozione) {
      esito.fileBloccanti = lotto.length
    } else {
      esito.fileRimossi = r.rimossi.length
      esito.fileGiaAssenti = r.giaAssenti.length
      esito.fileBloccanti = bloccanti(r).length
    }
  }
  if (esito.fileBloccanti > 0) esito.esito = 'file-non-rimossi'

  logEvento('gdpr', esito.esito === 'ok' ? 'info' : 'error', {
    operazione: op,
    esito: 'cestino-file-svuotato',
    tipo: 'cestino-file',
    bucket,
    n_giorni: esito.giorniScaduti,
    n_file: esito.fileRimossi,
    n_gia_assenti: esito.fileGiaAssenti,
    n_bloccanti: esito.fileBloccanti,
    lotto_pieno: esito.lottoPieno,
  })
  return esito
}
