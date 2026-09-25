import { db, type LocalGalleryMedia } from '@/lib/offline/db'
import { caricaMediaGalleria } from '@/lib/gallery/carica-media'
import { mimeBase } from '@/lib/gallery/limiti'
import { logClient } from '@/lib/logging/client'
import { conTetto } from '@/lib/logging/tetto'

const TETTO_PUBBLICAZIONE_MS = 30_000
const pubblicazioniInCorso = new Set<string>()
const scartiInCorso = new Set<string>()

export interface AmbitoCodaFoto { ownerId: string; schoolId: string; isCurrent?: () => boolean }

function attivo(scope: AmbitoCodaFoto): boolean {
    return scope.isCurrent?.() !== false
}
export interface StatoCodaFoto {
    inAttesa: number
    inErrore: number
    sospese: number
    senzaSede: number
}

/** Millisecondi fino alla prima sospensione in scadenza, per risvegliare la coda. */
export function prossimaRipresaCodaFoto(rows: LocalGalleryMedia[], now: number): number | null {
    const scadenze = rows.map(row => row.next_attempt_at).filter((at): at is number => typeof at === 'number' && at > now)
    return scadenze.length > 0 ? Math.min(...scadenze) - now : null
}

function stessoAmbito(row: LocalGalleryMedia, scope: AmbitoCodaFoto): boolean {
    return row.uploaded_by === scope.ownerId && row.scuola_id === scope.schoolId && row.file_type === 'foto'
}

function prossimoTentativo(response: Response, defaultSeconds = 60): number {
    const header = response.headers?.get('Retry-After')
    const seconds = header && /^\d+$/.test(header) ? Number(header) : defaultSeconds
    return Date.now() + Math.min(Math.max(seconds, 1), 3600) * 1000
}

function registra(messaggio: string, stato?: number): void {
    logClient({ livello: 'error', evento: 'offline', messaggio, route: '/teacher/gallery', ...(stato ? { stato } : {}) })
}

export async function listaFotoInCoda(scope: AmbitoCodaFoto): Promise<LocalGalleryMedia[]> {
    if (!scope.ownerId || !scope.schoolId) return []
    const rows = await db.galleria.toArray()
    return rows.filter(row => row.uploaded_by === scope.ownerId && row.file_type === 'foto'
        && (row.scuola_id === scope.schoolId || !row.scuola_id))
}

export async function statoCodaFoto(scope: AmbitoCodaFoto): Promise<StatoCodaFoto> {
    const rows = await listaFotoInCoda(scope)
    const now = Date.now()
    return {
        inAttesa: rows.filter(row => row.scuola_id && row.sync_status === 'pending' && !(row.next_attempt_at && row.next_attempt_at > now)).length,
        inErrore: rows.filter(row => row.scuola_id && row.sync_status === 'error' && !(row.next_attempt_at && row.next_attempt_at > now)).length,
        sospese: rows.filter(row => row.scuola_id && row.next_attempt_at && row.next_attempt_at > now).length,
        senzaSede: rows.filter(row => !row.scuola_id).length,
    }
}

/** Il batch viene prima scritto tutto in IndexedDB; solo dopo parte la rete. */
export async function accodaFotoGalleria(data: Omit<LocalGalleryMedia, 'sync_status' | 'file_type' | 'phase' | 'upload_id'> & { id: string; scuola_id: string; phase?: 'preparing' | 'upload' }): Promise<void> {
    if (!data.uploaded_by || !data.scuola_id) throw new Error('ambito_coda_foto_mancante')
    try {
        await db.galleria.put({
            ...data,
            upload_id: data.id,
            file_type: 'foto',
            phase: data.phase ?? 'upload',
            sync_status: data.phase === 'preparing' ? 'error' : 'pending',
            storage_path: null,
            next_attempt_at: null,
            last_error: data.phase === 'preparing' ? 'processing' : null,
        })
    } catch (error) {
        registra('gallery-coda-salvataggio-fallito')
        throw error
    }
}

export async function assegnaSedeFotoLegacy(scope: AmbitoCodaFoto, id: string): Promise<boolean> {
    if (!scope.ownerId || !scope.schoolId) return false
    const row = await db.galleria.get(id)
    if (!row || row.uploaded_by !== scope.ownerId || row.scuola_id || row.file_type !== 'foto') return false
    await db.galleria.update(id, { scuola_id: scope.schoolId, sync_status: 'pending' })
    logClient({ livello: 'warn', evento: 'offline', messaggio: 'gallery-coda-legacy-sede-assegnata' })
    return true
}

export async function scartaFotoInCoda(scope: AmbitoCodaFoto, id: string): Promise<boolean> {
    if (pubblicazioniInCorso.has(id) || scartiInCorso.has(id)) return false
    scartiInCorso.add(id)
    try {
        const row = await db.galleria.get(id)
        if (!row || !stessoAmbito(row, scope)) return false
        if (row.phase === 'publishing') {
            logClient({ livello: 'warn', evento: 'offline', messaggio: 'gallery-coda-scarto-in-attesa-riconciliazione' })
            return false
        }
        await db.galleria.delete(id)
        logClient({ livello: 'warn', evento: 'offline', messaggio: 'gallery-coda-foto-scartata' })
        return true
    } finally {
        scartiInCorso.delete(id)
    }
}

export async function riprovaFotoInCoda(scope: AmbitoCodaFoto, id: string): Promise<boolean> {
    const row = await db.galleria.get(id)
    if (!row || !stessoAmbito(row, scope) || (row.next_attempt_at && row.next_attempt_at > Date.now())) return false
    if (row.phase === 'preparing') {
        try {
            const { processImageWithWatermark } = await import('@/lib/media/processing')
            const originale = new File([row.file_blob], row.file_name, { type: row.file_blob.type })
            const processed = await processImageWithWatermark(originale, '/watermark.png')
            await db.galleria.update(id, {
                file_blob: processed, file_name: processed.name,
                phase: 'upload', sync_status: 'pending', last_error: null,
            })
            return true
        } catch {
            registra('gallery-coda-foto-elaborazione-fallita')
            await db.galleria.update(id, { phase: 'preparing', sync_status: 'error', last_error: 'processing' })
            return false
        }
    }
    await db.galleria.update(id, { sync_status: 'pending', last_error: null })
    return true
}

async function sospendiAutore(ownerId: string, until: number, motivo: 'rate-limit' | 'servizio-indisponibile' = 'rate-limit'): Promise<void> {
    const rows = await db.galleria.toArray()
    for (const row of rows) {
        if (row.uploaded_by !== ownerId || row.file_type !== 'foto') continue
        if (row.next_attempt_at && row.next_attempt_at >= until) continue
        await db.galleria.update(row.id, { next_attempt_at: until })
    }
    logClient({ livello: 'warn', evento: 'offline', messaggio: motivo === 'rate-limit' ? 'gallery-coda-rate-limit' : 'gallery-coda-servizio-indisponibile', campi: { ms: until - Date.now() } })
}

async function drain(scope: AmbitoCodaFoto): Promise<void> {
    if (!scope.ownerId || !scope.schoolId || !attivo(scope) || (typeof navigator !== 'undefined' && !navigator.onLine)) return
    const rows = (await db.galleria.toArray())
        .filter(row => stessoAmbito(row, scope) && row.sync_status !== 'synced')
        .sort((a, b) => a.creato_il.localeCompare(b.creato_il) || a.id.localeCompare(b.id))
    for (const original of rows) {
        if (!attivo(scope)) return
        const row = await db.galleria.get(original.id)
        if (!attivo(scope)) return
        if (!row || !stessoAmbito(row, scope)) continue
        if (row.next_attempt_at && row.next_attempt_at > Date.now()) return
        if (row.phase === 'preparing' || ['processing', 'conflict', 'deleted', 'privacy'].includes(row.last_error ?? '')) continue
        const uploadId = row.upload_id ?? crypto.randomUUID()
        if (!row.upload_id) await db.galleria.update(row.id, { upload_id: uploadId })
        let path = row.storage_path ?? null
        if (row.phase !== 'publish' && row.phase !== 'publishing') {
            const mime = mimeBase(row.file_blob.type) || 'image/jpeg'
            const file = new File([row.file_blob], row.file_name, { type: mime })
            const esito = await caricaMediaGalleria(file, mime, {
                canContinue: () => attivo(scope),
                resumePath: path ?? undefined,
                onPath: async signedPath => {
                    if (!attivo(scope)) throw new Error('ambito_cambiato')
                    await db.galleria.update(row.id, { storage_path: signedPath, phase: 'upload' })
                    path = signedPath
                },
            })
            if (!attivo(scope)) return
            if (!esito.ok) {
                await db.galleria.update(row.id, { sync_status: 'error', last_error: 'upload' })
                registra('gallery-coda-upload-fallito', esito.stato ?? undefined)
                if (esito.stato === 401 || esito.stato === 403) return
                if (esito.stato === 429) {
                    await sospendiAutore(scope.ownerId, Date.now() + ('retryAfterMs' in esito ? (esito.retryAfterMs ?? 60_000) : 60_000))
                    return
                }
                continue
            }
            path = esito.path
            await db.galleria.update(row.id, { storage_path: path, phase: 'publish', sync_status: 'pending', last_error: null })
        }
        if (!attivo(scope)) return
        if (!path) {
            await db.galleria.update(row.id, { sync_status: 'error', last_error: 'upload' })
            registra('gallery-coda-path-mancante')
            continue
        }
        // La persona può scartare la foto mentre lo Storage sta completando la PUT.
        // Una riga eliminata non deve diventare una pubblicazione con dati in memoria.
        const ancoraInCoda = await db.galleria.get(row.id)
        if (!attivo(scope)) return
        if (!ancoraInCoda || !stessoAmbito(ancoraInCoda, scope)
            || ancoraInCoda.storage_path !== path
            || (ancoraInCoda.phase !== 'publish' && ancoraInCoda.phase !== 'publishing')
            || scartiInCorso.has(row.id)) continue
        const esitoIncertoPrecedente = ancoraInCoda.phase === 'publishing'
        pubblicazioniInCorso.add(row.id)
        try {
            // Da qui il server può completare il POST anche se il client perde la risposta.
            // Lo stato sopravvive al reload: lo scarto resta bloccato fino alla riconciliazione.
            await db.galleria.update(row.id, { phase: 'publishing' })
            if (!attivo(scope)) return
            let response: Response
            try {
                const endpoint = '/api/gallery'
                response = await fetch(endpoint, conTetto(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': scope.ownerId },
                    body: JSON.stringify({
                        uploaded_by: scope.ownerId, scuola_id: scope.schoolId,
                        upload_id: uploadId, file_url: path, file_type: 'foto', caption: row.caption,
                        tag_students: row.tag_students, is_broadcast: row.is_broadcast,
                        target_classes: row.target_classes,
                    }),
                }, TETTO_PUBBLICAZIONE_MS))
            } catch {
                if (!attivo(scope)) return
                await db.galleria.update(row.id, { sync_status: 'error', last_error: 'publish' })
                registra('gallery-coda-pubblicazione-rete')
                continue
            }
            if (!attivo(scope)) return
            if (response.ok) {
                await db.galleria.delete(row.id)
                continue
            }
            const last_error = response.status === 409 ? 'conflict' : response.status === 410 ? 'deleted'
                : response.status === 422 ? 'privacy' : 'publish'
            await db.galleria.update(row.id, {
                // Un 4xx del replay non dimostra che il POST precedente, con risposta persa,
                // non abbia già pubblicato la foto: solo il primo rifiuto è definitivo.
                phase: esitoIncertoPrecedente || response.status >= 500 ? 'publishing' : 'publish',
                sync_status: 'error', last_error,
            })
            registra('gallery-coda-pubblicazione-rifiutata', response.status)
            if (response.status === 429) {
                await sospendiAutore(scope.ownerId, prossimoTentativo(response))
                return
            }
            if (response.status === 503) {
                await sospendiAutore(scope.ownerId, prossimoTentativo(response), 'servizio-indisponibile')
                return
            }
            if (response.status === 401 || response.status === 403) return
        } finally {
            pubblicazioniInCorso.delete(row.id)
        }
    }
}

const drains = new Map<string, { schoolId: string; promise: Promise<void> }>()
/** Un solo drain per autore: anche click ripetuti e evento online si serializzano. */
export function drainGalleryPhotoQueue(scope: AmbitoCodaFoto): Promise<void> {
    if (!scope.ownerId || !scope.schoolId) return Promise.resolve()
    const active = drains.get(scope.ownerId)
    if (active?.schoolId === scope.schoolId) return active.promise
    const promise = (active ? active.promise.catch(() => undefined) : Promise.resolve())
        .then(() => drain(scope))
        .finally(() => { if (drains.get(scope.ownerId)?.promise === promise) drains.delete(scope.ownerId) })
    drains.set(scope.ownerId, { schoolId: scope.schoolId, promise })
    return promise
}
