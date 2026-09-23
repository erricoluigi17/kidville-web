/**
 * Il contatore accanto alla voce di menu «Coda fatture» (nucleo §4: «con contatore delle voci
 * attive, da GET /coda, campo conteggi»).
 *
 * Si monta la SIDEBAR VERA, non il solo contatore: un contatore perfetto che nessun menu monta
 * è esattamente lo stato in cui la voce era prima di questa correzione.
 *
 * Cosa si misura:
 *   - la lettura è quella leggera (`?solo=conteggi`), non la coda intera;
 *   - il numero è in_coda + in_invio + errore (le voci ATTIVE), non le emesse/tolte;
 *   - una lettura per pagina, niente polling: il tempo che passa non genera richieste;
 *   - errore, DB non migrato, coda vuota ⇒ nessun numero (mai uno «0» inventato);
 *   - un ruolo che la GET rifiuterebbe (cuoca) non vede la voce e non chiede niente.
 *
 * Il mock di next-intl è LOCALE per la stessa ragione di `CodaFatturePanel.test.tsx`: le chiavi
 * sono nidificate, e il mock globale le risolverebbe col proprio nome.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, renderHook } from '@testing-library/react'

vi.mock('next-intl', async () => {
    const cataloghi: Record<string, Record<string, unknown>> = {
        adminContabilita: (await import('../../../messages/it/adminContabilita.json')).default as Record<string, unknown>,
        etichette: (await import('../../../messages/it/etichette.json')).default as Record<string, unknown>,
        shared: (await import('../../../messages/it/shared.json')).default as Record<string, unknown>,
    }
    const { IntlMessageFormat } = await import('intl-messageformat')
    const foglia = (catalogo: Record<string, unknown> | undefined, chiave: string): string | undefined => {
        let corrente: unknown = catalogo
        for (const pezzo of chiave.split('.')) {
            if (typeof corrente !== 'object' || corrente === null) return undefined
            corrente = (corrente as Record<string, unknown>)[pezzo]
        }
        return typeof corrente === 'string' ? corrente : undefined
    }
    const useTranslations = (ns: string) => {
        const catalogo = cataloghi[ns]
        const t = (chiave: string, valori?: Record<string, unknown>) => {
            const grezzo = foglia(catalogo, chiave) ?? chiave
            if (!valori) return grezzo
            return String(new IntlMessageFormat(grezzo, 'it').format(valori))
        }
        return Object.assign(t, { rich: t, markup: t, raw: t, has: (chiave: string) => foglia(catalogo, chiave) !== undefined })
    }
    return { useTranslations, useLocale: () => 'it' }
})

const stub = vi.hoisted(() => ({
    pathname: '/admin',
    identita: { userId: 'aaaaaaaa-0000-4000-8000-000000000001' as string | null, ruolo: 'segreteria' },
}))

vi.mock('next/navigation', () => ({ usePathname: () => stub.pathname }))
vi.mock('next/link', async () => {
    const React = await import('react')
    return {
        default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
            React.createElement('a', { href, ...rest }, children),
    }
})
vi.mock('framer-motion', async () => {
    const React = await import('react')
    const motion = new Proxy({} as Record<string, unknown>, {
        get: (_t, tag: string) => (props: Record<string, unknown>) => {
            const { layoutId, transition, ...rest } = props
            void layoutId; void transition
            return React.createElement(tag, rest, (props as { children?: React.ReactNode }).children)
        },
    })
    return { motion }
})
vi.mock('@/lib/context/admin-identity', () => ({
    useAdminIdentity: () => ({
        userId: stub.identita.userId,
        ruolo: stub.identita.ruolo,
        withUser: (h: string) => h,
    }),
}))
vi.mock('@/lib/auth/logout', () => ({ doLogout: vi.fn() }))

import { AdminSidebar } from '@/components/features/admin/AdminSidebar'
import { useConteggioCodaFatture } from '@/components/features/admin/use-conteggio-coda-fatture'

const URL_CONTEGGI = '/api/pagamenti/fattura/coda?solo=conteggi'

let risposta: { ok: boolean; status: number; body: unknown }
let chiamate: string[]

function conteggi(extra: Partial<Record<string, number>> = {}) {
    return { in_coda: 0, in_invio: 0, errore: 0, emesse_7g: 0, tolte_7g: 0, ...extra }
}

beforeEach(() => {
    stub.pathname = '/admin'
    stub.identita = { userId: 'aaaaaaaa-0000-4000-8000-000000000001', ruolo: 'segreteria' }
    chiamate = []
    risposta = { ok: true, status: 200, body: { disponibile: true, conteggi: conteggi() } }
    global.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = String(url)
        chiamate.push(u)
        if (u.startsWith('/api/logs')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
        return { ok: risposta.ok, status: risposta.status, json: async () => risposta.body } as unknown as Response
    }) as unknown as typeof fetch
})
afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

const lettureCoda = () => chiamate.filter((u) => u.includes('/api/pagamenti/fattura/coda'))

describe('Sidebar — il contatore di «Coda fatture»', () => {
    it('mostra le voci ATTIVE (in coda + in invio + errore) con la lettura leggera, e lo dice allo screen reader', async () => {
        risposta.body = { disponibile: true, conteggi: conteggi({ in_coda: 3, in_invio: 1, errore: 2, emesse_7g: 40, tolte_7g: 7 }) }
        render(<AdminSidebar />)

        const contatore = await screen.findByTestId('contatore-coda-fatture')
        expect(contatore.textContent).toContain('6')
        expect(screen.getByText('6 voci attive in coda')).toBeTruthy()
        // Dentro il link della voce, non altrove nel menu.
        expect(contatore.closest('a')?.getAttribute('href')).toBe('/admin/coda-fatture')
        expect(lettureCoda()).toEqual([URL_CONTEGGI])
    })

    it('una lettura per pagina: il tempo che passa non chiede niente, il cambio di pagina sì', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        risposta.body = { disponibile: true, conteggi: conteggi({ in_coda: 2 }) }
        const { rerender } = render(<AdminSidebar />)
        await screen.findByTestId('contatore-coda-fatture')
        expect(lettureCoda()).toHaveLength(1)

        await act(async () => { vi.advanceTimersByTime(5 * 60_000) })
        expect(lettureCoda()).toHaveLength(1)

        stub.pathname = '/admin/pagamenti'
        rerender(<AdminSidebar />)
        await waitFor(() => expect(lettureCoda()).toHaveLength(2))
    })

    it('coda vuota ⇒ nessun numero accanto alla voce', async () => {
        risposta.body = { disponibile: true, conteggi: conteggi({ emesse_7g: 12 }) }
        render(<AdminSidebar />)
        await waitFor(() => expect(lettureCoda()).toHaveLength(1))
        await screen.findByText('Coda fatture')
        expect(screen.queryByTestId('contatore-coda-fatture')).toBeNull()
    })

    it('DB non migrato ({disponibile:false}) ⇒ nessun numero', async () => {
        risposta.body = { disponibile: false }
        render(<AdminSidebar />)
        await waitFor(() => expect(lettureCoda()).toHaveLength(1))
        expect(screen.queryByTestId('contatore-coda-fatture')).toBeNull()
    })

    it('lettura fallita (500) ⇒ nessun numero, e la voce resta', async () => {
        risposta = { ok: false, status: 500, body: { error: 'guasto', codice: 'LETTURA_FALLITA' } }
        render(<AdminSidebar />)
        await waitFor(() => expect(lettureCoda()).toHaveLength(1))
        expect(screen.getByText('Coda fatture')).toBeTruthy()
        expect(screen.queryByTestId('contatore-coda-fatture')).toBeNull()
    })

    it('la cuoca (che la GET rifiuterebbe con 403) non vede la voce e non chiede il contatore', async () => {
        stub.identita.ruolo = 'cuoca'
        render(<AdminSidebar />)
        await screen.findByText('Contabilità')
        expect(screen.queryByText('Coda fatture')).toBeNull()
        expect(lettureCoda()).toHaveLength(0)
    })
})

describe('useConteggioCodaFatture — il menu mobile legge solo quando si apre', () => {
    it('chiuso: nessuna richiesta; aperto: una; riaperto: un’altra', async () => {
        risposta.body = { disponibile: true, conteggi: conteggi({ errore: 4 }) }
        const utente = 'aaaaaaaa-0000-4000-8000-000000000001'
        const { result, rerender } = renderHook(
            ({ open }: { open: boolean }) =>
                useConteggioCodaFatture({ attivo: open, userId: utente, chiave: open ? 'aperto' : 'chiuso' }),
            { initialProps: { open: false } },
        )
        expect(result.current).toBeNull()
        expect(lettureCoda()).toHaveLength(0)

        rerender({ open: true })
        await waitFor(() => expect(result.current).toBe(4))
        expect(lettureCoda()).toHaveLength(1)

        rerender({ open: false })
        expect(result.current).toBeNull()
        rerender({ open: true })
        await waitFor(() => expect(lettureCoda()).toHaveLength(2))
    })

    it('senza utente risolto non chiede niente', () => {
        const { result } = renderHook(() => useConteggioCodaFatture({ attivo: true, userId: null, chiave: 'x' }))
        expect(result.current).toBeNull()
        expect(lettureCoda()).toHaveLength(0)
    })
})
