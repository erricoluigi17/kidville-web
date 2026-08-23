import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EventoClient } from '@/lib/logging/client'

/**
 * LA RIGA CHE NON DEVE SPARIRE PER STRADA — e il modo esatto in cui sarebbe sparita.
 *
 * Il 2026-08-23 la schermata di accesso ha cominciato a registrare anche i fallimenti
 * di credenziali. La ragione è misurata: il giorno prima il cron aveva spedito 67
 * credenziali a famiglie vere, 30 non sono mai entrate, e in trenta giorni di
 * `app_log` non esisteva **una sola riga** di accesso fallito a spiegare perché.
 *
 * ⚠️ IL DIFETTO CHE QUESTO FILE ESISTE PER IMPEDIRE È CAPACE DI SUPERARE OGNI ALTRO
 * TEST DEL REPO. `logClient` applica `livelloEvento`, che a qualunque evento con uno
 * `stato` fra 400 e 599 applica `livelloFetch`: 400 non è fra le `ANOMALIE_4XX` e non
 * è ≥ 500, quindi torna `null` e `accoda` esce senza mettere niente in coda.
 *
 * Passare a `logClient` lo status 400 di GoTrue — il gesto più naturale del mondo,
 * «completiamo la riga con lo stato» — sarebbe quindi bastato a spegnere il canale
 * **in silenzio**. E i test della schermata di accesso non se ne sarebbero accorti,
 * perché spiano `logClient` A MONTE: vedrebbero la chiamata, direbbero verde, e in
 * produzione `app_log` resterebbe vuota esattamente come prima.
 *
 * Il punto di osservazione qui è perciò A VALLE della politica: la coda persistita,
 * cioè ciò che il dispositivo ha davvero accettato di spedire.
 */

type Client = typeof import('@/lib/logging/client')

/** La chiave della coda persistita (privata nel modulo: qui si cabla, ed è il contratto). */
const CHIAVE_CODA = 'kv_log_coda'

async function carica(): Promise<Client> {
    vi.resetModules()
    const mod = await import('@/lib/logging/client')
    mod.installaLoggerClient()
    return mod
}

function codaPersistita(): EventoClient[] {
    const raw = localStorage.getItem(CHIAVE_CODA)
    return raw === null ? [] : JSON.parse(raw)
}

const MESSAGGIO =
    'credenziali rifiutate — esito=credenzialiNonValide http=400 pwd=temporanea spazi=nessuno riprova=non-serviva'

beforeEach(() => {
    localStorage.clear()
    window.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch
    window.history.pushState({}, '', '/auth/login')
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('il fallimento di credenziali arriva davvero fino alla coda', () => {
    it('con `stato: undefined` la riga viene accodata', async () => {
        const { logClient } = await carica()
        logClient({ livello: 'warn', evento: 'accesso', messaggio: MESSAGGIO, route: '/auth/login', stato: undefined })

        const coda = codaPersistita()
        expect(coda).toHaveLength(1)
        expect(coda[0].evento).toBe('accesso')
        expect(coda[0].livello).toBe('warn')
        expect(String(coda[0].messaggio)).toContain('esito=credenzialiNonValide')
        // Lo status vive DENTRO il messaggio, che è l'unico posto dove nessun filtro
        // lo tocca — ed è anche l'unico che entra nell'impronta di deduplicazione.
        expect(String(coda[0].messaggio)).toContain('http=400')
    })

    it('con `stato: 400` la riga NON viene accodata: la trappola, dimostrata', async () => {
        // Questo caso NON difende un comportamento desiderato: documenta la trappola,
        // e la tiene visibile. Se un giorno qualcuno «completasse» la riga aggiungendo
        // lo status, questo resterebbe verde e quello sopra diventerebbe rosso — che è
        // il modo in cui ci si accorge di aver spento il canale credendo di arricchirlo.
        const { logClient } = await carica()
        logClient({ livello: 'warn', evento: 'accesso', messaggio: MESSAGGIO, route: '/auth/login', stato: 400 })

        expect(codaPersistita()).toHaveLength(0)
    })

    it('un 500 passa lo stesso: la politica non sopprime i guasti veri', async () => {
        const { logClient } = await carica()
        logClient({ livello: 'warn', evento: 'accesso', messaggio: MESSAGGIO, route: '/auth/login', stato: 500 })

        expect(codaPersistita()).toHaveLength(1)
    })
})
