'use client'

import { fileConsegnato, scaricaDocumento } from '@/lib/native/scarica'
import type { RisultatoScaricoNativo } from '@/lib/native/scarica'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { conTetto } from '@/lib/logging/tetto'
import type { SignedPdfErrorCode } from './signed-document'

export interface SignedFormDownloadResult {
  ok: boolean
  pdf_unavailable: boolean
  pdf_error?: SignedPdfErrorCode
  delivery?: RisultatoScaricoNativo
  pdf_path?: string
}
export interface SignedFormPreparationResult {
  pdf_ready: boolean
  pdf_error?: SignedPdfErrorCode
  pdf_path?: string
}
/** Due minuti: il POST può generare e caricare un PDF fino a 8 MiB; il GET può
 * trasferirlo su una rete mobile lenta. Allo scadere si recupera la stessa firma. */
const TETTO_DOCUMENTO_MS = 120000
const extensions: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
}
/** Il percorso legacy non è una prova: solo il server verifica i byte in Storage. */
export async function prepareSignedForm(submissionId: string): Promise<SignedFormPreparationResult> {
  try {
    const response = await fetch('/api/forms/signed-pdf', conTetto('/api/forms/signed-pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: submissionId }), cache: 'no-store',
    }, TETTO_DOCUMENTO_MS))
    const body = await response.json()
    if (!response.ok || body.pdf_ready !== true) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: 'modulo-firmato-preparazione-fallita', stato: response.status, route: '/api/forms/signed-pdf' })
      return { pdf_ready: false, pdf_error: body.pdf_error }
    }
    const pdfPath = typeof body.submission?.pdf_path === 'string' && body.submission.pdf_path.trim() ? body.submission.pdf_path : undefined
    // Il canale client accetta warn/error, come il logger dei download nativi.
    logClient({ livello: 'warn', evento: 'fetch', messaggio: 'modulo-firmato-preparazione-riuscita', route: '/api/forms/signed-pdf' })
    return { pdf_ready: true, pdf_path: pdfPath }
  } catch (error) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `modulo-firmato-preparazione-fallita: ${nomeErrore(error)}`, route: '/api/forms/signed-pdf' })
    return { pdf_ready: false }
  }
}
/** Recupero documentale: solo id della compilazione, nessuna nuova firma o risposta. */
export async function downloadSignedForm(submissionId: string, options: { alreadyPrepared?: boolean } = {}): Promise<SignedFormDownloadResult> {
  let pdfPath: string | undefined
  try {
    if (!options.alreadyPrepared) {
      const prepared = await prepareSignedForm(submissionId)
      if (!prepared.pdf_ready) return { ok: false, pdf_unavailable: true, pdf_error: prepared.pdf_error }
      pdfPath = prepared.pdf_path
    }
    const query = new URLSearchParams({ id: submissionId })
    const url = `/api/forms/signed-pdf?${query}`
    const response = await fetch(url, conTetto(url, { cache: 'no-store' }, TETTO_DOCUMENTO_MS))
    if (!response.ok) {
      const body = await response.json()
      logClient({ livello: 'warn', evento: 'fetch', messaggio: 'modulo-firmato-lettura-fallita', stato: response.status, route: '/api/forms/signed-pdf' })
      return { ok: false, pdf_unavailable: true, pdf_error: body.pdf_error, pdf_path: pdfPath }
    }
    const blob = await response.blob()
    const mime = (response.headers.get('Content-Type') ?? blob.type ?? 'application/octet-stream').split(';')[0].trim().toLowerCase() || 'application/octet-stream'
    const delivery = await scaricaDocumento({
      sorgente: blob, nomeFile: `autorizzazione-firmata-${submissionId.slice(0, 8)}.${extensions[mime] ?? 'bin'}`,
      mime, etichetta: 'modulo-firmato',
    })
    return { ok: fileConsegnato(delivery), pdf_unavailable: false, delivery, pdf_path: pdfPath }
  } catch (error) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `modulo-firmato-download-fallito: ${nomeErrore(error)}`, route: '/api/forms/signed-pdf' })
    return { ok: false, pdf_unavailable: true, pdf_path: pdfPath }
  }
}
