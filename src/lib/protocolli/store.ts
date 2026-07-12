/**
 * Storage e persistenza del registro protocolli.
 * - Bucket PRIVATO `protocollo` (lazy-create, 25 MB, solo pdf/jpg/png);
 *   download esclusivamente via signed URL nelle route (mai getPublicUrl).
 * - Path: staging/{uuid}-{nome} → {scuolaId}/{anno}/{numero7}-originale.{ext},
 *   …-timbrato.pdf, …-allegati/{n}-{nome}.
 * - `registraProtocollo`: rpc numero atomico → fascia → upload → INSERT;
 *   in caso di errore dopo l'INSERT il rollback usa protocollo_elimina()
 *   (unica via di DELETE ammessa dal trigger WORM). Il numero "bruciato" da
 *   un fallimento pre-INSERT resta un buco ammesso dal design (rischio #3).
 * Helper puri testati in __tests__/lib/protocolli-store.test.ts.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { annoFiscale } from '@/lib/format/fiscal-date'
import { logoLightBytes } from '@/lib/protocolli/assets'
import {
  formatNumeroProtocollo,
  righeSegnatura,
  type TipoProtocollo,
} from '@/lib/protocolli/segnatura'
import { applicaSegnatura } from '@/lib/protocolli/timbro'

export const PROTOCOLLO_BUCKET = 'protocollo'
export const PROTOCOLLO_MAX_MB = 25
export const PROTOCOLLO_MAX_BYTES = PROTOCOLLO_MAX_MB * 1024 * 1024
export const MIME_AMMESSI = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type MimeAmmesso = (typeof MIME_AMMESSI)[number]

/** Codici Postgres/PostgREST di schema assente (DB E2E CI mai migrato). */
export const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])

const ESTENSIONE_PER_MIME: Record<MimeAmmesso, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

export function estensioneDaMime(mime: string): string {
  return ESTENSIONE_PER_MIME[mime as MimeAmmesso] ?? 'bin'
}

/** Impronta del documento (art. 53), convenzione repo: SHA256-<HEX maiuscolo>. */
export function sha256Impronta(buf: Uint8Array): string {
  return `SHA256-${createHash('sha256').update(buf).digest('hex').toUpperCase()}`
}

/** Nome file sicuro per lo storage: minuscolo, senza accenti/speciali, ≤80 char. */
export function slugNomeFile(nome: string): string {
  const punto = nome.lastIndexOf('.')
  const base = punto > 0 ? nome.slice(0, punto) : nome
  const ext =
    punto > 0
      ? nome
          .slice(punto + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
      : ''
  const slug =
    base
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'file'
  return ext ? `${slug}.${ext}` : slug
}

export function pathStaging(nomeFile: string): string {
  return `staging/${randomUUID()}-${slugNomeFile(nomeFile)}`
}

export function pathDefinitivi(scuolaId: string, anno: number, numero: number) {
  const base = `${scuolaId}/${anno}/${String(numero).padStart(7, '0')}`
  return {
    originale: (ext: string) => `${base}-originale.${ext}`,
    timbrato: `${base}-timbrato.pdf`,
    allegato: (ordine: number, nome: string) => `${base}-allegati/${ordine}-${slugNomeFile(nome)}`,
  }
}

/** Crea il bucket privato se manca (pattern fascicolo). Non lancia mai. */
export async function ensureBucket(supabase: SupabaseClient): Promise<void> {
  try {
    const { data } = await supabase.storage.listBuckets()
    if (data?.some((b) => b.name === PROTOCOLLO_BUCKET)) return
    await supabase.storage.createBucket(PROTOCOLLO_BUCKET, {
      public: false,
      allowedMimeTypes: [...MIME_AMMESSI],
      fileSizeLimit: PROTOCOLLO_MAX_BYTES,
    })
  } catch {
    // corsa fra richieste parallele o bucket già esistente: ignorato
  }
}

export type AllegatoInput = { bytes: Uint8Array; nome: string; mime: string }

export type RegistraInput = {
  scuolaId: string
  /** Denominazione della scuola per la fascia (art. 55). */
  denominazione: string
  tipo: TipoProtocollo
  oggetto: string
  mittente?: string | null
  destinatario?: string | null
  mezzo?: string | null
  rifProtMittente?: string | null
  rifDataMittente?: string | null
  categoriaId?: string | null
  collegatoAId?: string | null
  noteInterne?: string | null
  emergenza?: boolean
  emergenzaDichiarataIl?: string | null
  allegatiDescrizione?: string | null
  createdBy: string
  /** File caricato, conservato INTATTO (decisione #10). */
  originale: { bytes: Uint8Array; nomeFile: string; mime: string }
  /** PDF su cui apporre la fascia: l'originale se è PDF, la conversione se immagine. */
  pdfDaTimbrare: Uint8Array
  allegati?: AllegatoInput[]
}

export type RegistraEsito = {
  record: Record<string, unknown>
  numero: number
  anno: number
  numeroFormattato: string
  pathTimbrato: string
  impronta: string
}

function erroreConCodice(messaggio: string, code?: string): Error & { code?: string } {
  return Object.assign(new Error(messaggio), { code })
}

/**
 * Registra un protocollo: numero atomico → segnatura → upload → INSERT.
 * L'ordine minimizza i numeri bruciati (il numero si prende a PDF già pronto).
 */
export async function registraProtocollo(
  supabase: SupabaseClient,
  input: RegistraInput
): Promise<RegistraEsito> {
  const anno = annoFiscale()
  const { data: numeroGrezzo, error: erroreNumero } = await supabase.rpc(
    'prossimo_numero_protocollo',
    { p_scuola: input.scuolaId, p_anno: anno }
  )
  if (erroreNumero) {
    throw erroreConCodice(
      `Numerazione protocollo non disponibile: ${erroreNumero.message}`,
      (erroreNumero as { code?: string }).code
    )
  }
  const numero = Number(numeroGrezzo)
  if (!Number.isInteger(numero) || numero < 1) {
    throw erroreConCodice('Numerazione protocollo non valida')
  }

  const quando = new Date()
  const righe = righeSegnatura({
    denominazione: input.denominazione,
    numero,
    anno,
    tipo: input.tipo,
    quando,
  })
  const timbrato = await applicaSegnatura(input.pdfDaTimbrare, {
    righe,
    logoPng: logoLightBytes(),
  })

  const impronta = sha256Impronta(input.originale.bytes)
  const percorsi = pathDefinitivi(input.scuolaId, anno, numero)
  const pathOriginale = percorsi.originale(estensioneDaMime(input.originale.mime))
  const storage = supabase.storage.from(PROTOCOLLO_BUCKET)
  const caricati: string[] = []

  const carica = async (path: string, bytes: Uint8Array, contentType: string) => {
    const { error } = await storage.upload(path, bytes, { contentType, upsert: true })
    if (error) throw erroreConCodice(`Archiviazione file non riuscita: ${error.message}`)
    caricati.push(path)
  }

  let idInserito: string | null = null
  try {
    await carica(pathOriginale, input.originale.bytes, input.originale.mime)
    await carica(percorsi.timbrato, timbrato, 'application/pdf')

    const allegati = input.allegati ?? []
    const pathAllegati: string[] = []
    for (let i = 0; i < allegati.length; i++) {
      const path = percorsi.allegato(i + 1, allegati[i].nome)
      await carica(path, allegati[i].bytes, allegati[i].mime)
      pathAllegati.push(path)
    }

    const { data: record, error: erroreInsert } = await supabase
      .from('protocolli')
      .insert({
        scuola_id: input.scuolaId,
        anno,
        numero,
        tipo: input.tipo,
        data_registrazione: quando.toISOString(),
        oggetto: input.oggetto,
        mittente: input.mittente ?? null,
        destinatario: input.destinatario ?? null,
        mezzo: input.mezzo ?? null,
        rif_prot_mittente: input.rifProtMittente ?? null,
        rif_data_mittente: input.rifDataMittente ?? null,
        impronta_sha256: impronta,
        categoria_id: input.categoriaId ?? null,
        collegato_a_id: input.collegatoAId ?? null,
        note_interne: input.noteInterne ?? null,
        emergenza: input.emergenza ?? false,
        emergenza_dichiarata_il: input.emergenzaDichiarataIl ?? null,
        allegati_descrizione: input.allegatiDescrizione ?? null,
        file_originale: pathOriginale,
        file_timbrato: percorsi.timbrato,
        file_nome_originale: input.originale.nomeFile,
        file_mime: input.originale.mime,
        file_size: input.originale.bytes.byteLength,
        created_by: input.createdBy,
      })
      .select()
      .single()
    if (erroreInsert) {
      throw erroreConCodice(
        `Registrazione non riuscita: ${erroreInsert.message}`,
        erroreInsert.code
      )
    }
    idInserito = String((record as { id: string }).id)

    if (allegati.length > 0) {
      const { error: erroreAllegati } = await supabase.from('protocolli_allegati').insert(
        allegati.map((a, i) => ({
          protocollo_id: idInserito,
          path: pathAllegati[i],
          nome: a.nome,
          mime: a.mime,
          size: a.bytes.byteLength,
          sha256: sha256Impronta(a.bytes),
          ordine: i + 1,
        }))
      )
      if (erroreAllegati) {
        throw erroreConCodice(`Salvataggio allegati non riuscito: ${erroreAllegati.message}`)
      }
    }

    return {
      record: record as Record<string, unknown>,
      numero,
      anno,
      numeroFormattato: formatNumeroProtocollo(numero, anno),
      pathTimbrato: percorsi.timbrato,
      impronta,
    }
  } catch (errore) {
    // Rollback best-effort: la riga (se creata) si rimuove SOLO via funzione
    // dedicata (trigger WORM); i file caricati si eliminano dal bucket.
    if (idInserito) {
      await supabase.rpc('protocollo_elimina', { p_id: idInserito }).then(
        () => undefined,
        () => undefined
      )
    }
    if (caricati.length > 0) {
      await storage.remove(caricati).then(
        () => undefined,
        () => undefined
      )
    }
    throw errore
  }
}
