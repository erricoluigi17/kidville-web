import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import catItShared from '../../messages/it/shared.json'
import catEnShared from '../../messages/en/shared.json'

/**
 * LE DUE SCHERMATE CHE L'UTENTE VEDE QUANDO QUALCOSA È GIÀ ANDATO STORTO
 * PARLANO LA SUA LINGUA.
 *
 * ─── IL DIFETTO (collaudo del 2026-08-08, localizzazione Q14 e Q15) ─────────
 * Sono due rilievi diversi con la stessa causa: le schermate di SERVIZIO non
 * sono passate dalla campagna di estrazione delle stringhe.
 *
 *  Q14 · la 404 non esisteva affatto. Senza `src/app/not-found.tsx`, Next serve
 *        il proprio componente interno — «404 This page could not be found.» —
 *        che è una stringa inglese cablata nel framework. Misurato su
 *        `/parent/menu` con sessione italiana: testo inglese dentro un documento
 *        `lang="it"`, quindi uno screen reader lo pronuncia con fonetica
 *        italiana. Identico con il cookie `KV_LOCALE=en`: la pagina non
 *        cambiava, perché non passava da nessun catalogo.
 *
 *  Q15 · `src/app/error.tsx` aveva le sue tre frasi come letterali nel TSX
 *        (`grep -c useTranslations` → 0), pur essendo discendente del
 *        `NextIntlClientProvider` montato nel root layout: non era un limite
 *        tecnico, era una svista.
 *
 * Il momento in cui l'app parla la lingua sbagliata è il peggiore possibile:
 * è già successo un guasto, e l'unica cosa che resta all'utente è capire il
 * testo. Nessuno dei due difetti faceva rumore — la parità dei cataloghi
 * confronta chiavi ESISTENTI e non sa niente di ciò che nei cataloghi non è mai
 * entrato, e il mock di next-intl in `test/setup.ts` risolve i soli messaggi
 * italiani, quindi nessun unit test legge mai una schermata come la legge un
 * utente inglese. Qui il mock è sostituito e la lingua è una variabile.
 *
 * ─── `global-error.tsx` NON È QUI, ED È UNA DECISIONE ───────────────────────
 * Sostituisce il ROOT LAYOUT, cioè il componente che monta il provider: quando
 * viene reso, `useTranslations` non ha più nessun contesto da cui leggere. Porta
 * quindi entrambe le lingue nel documento e sceglie dal cookie `KV_LOCALE`,
 * esattamente come `ChunkErrorBoundary` e la pagina `/offline`. La regola che lo
 * riguarda sta in `__tests__/i18n/skip-link-nel-catalogo.test.ts`, insieme alle
 * altre regole di forma sulle schermate di servizio.
 */

// Il logger client non deve partire davvero: `error.tsx` logga nel `useEffect`,
// e qui interessa il TESTO, non l'osservabilità (che ha i suoi test).
vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    flush: vi.fn(),
    nomeErrore: (e: unknown) => String(e),
}))

/** La lingua dell'interfaccia in questo test: la stessa variabile che legge il mock. */
let lingua: 'it' | 'en' = 'it'

// Sostituisce il mock globale di `test/setup.ts`, che risolve SOLO l'italiano:
// con quello, un test in inglese sarebbe verde su un testo italiano.
vi.mock('next-intl', () => {
    const cataloghi: Record<string, Record<string, Record<string, string>>> = {
        it: { shared: catItShared as unknown as Record<string, string> },
        en: { shared: catEnShared as unknown as Record<string, string> },
    }
    const useTranslations = (ns?: string) => {
        const t = (chiave: string): string =>
            (ns ? cataloghi[lingua][ns]?.[chiave] : undefined) ?? `${ns}.${chiave}`
        return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
    }
    return {
        useTranslations,
        useLocale: () => lingua,
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
    }
})

beforeEach(() => {
    cleanup()
    lingua = 'it'
})

describe('404 · la pagina non trovata legge il catalogo della lingua attiva', () => {
    it('in italiano mostra il testo italiano del catalogo, non il fallback di Next', async () => {
        const NonTrovata = (await import('@/app/not-found')).default
        render(<NonTrovata />)
        expect(screen.getByText(catItShared.paginaNonTrovataTitolo)).toBeInTheDocument()
        expect(screen.getByText(catItShared.paginaNonTrovataCorpo)).toBeInTheDocument()
        // La stringa cablata nel framework, che è il difetto misurato.
        expect(document.body.textContent).not.toContain('This page could not be found')
    })

    it('in inglese mostra il testo inglese (ed è DIVERSO dall’italiano)', async () => {
        lingua = 'en'
        const NonTrovata = (await import('@/app/not-found')).default
        render(<NonTrovata />)
        expect(screen.getByText(catEnShared.paginaNonTrovataTitolo)).toBeInTheDocument()
        expect(document.body.textContent).not.toContain(catItShared.paginaNonTrovataTitolo)
    })

    it('offre la via d’uscita: un collegamento alla home, che instrada sul ruolo', async () => {
        const NonTrovata = (await import('@/app/not-found')).default
        render(<NonTrovata />)
        const link = screen.getByRole('link', { name: catItShared.paginaNonTrovataTornaHome })
        // `/` non è una landing pubblica: è l'instradatore che porta ognuno alla
        // home del proprio ruolo (src/app/page.tsx).
        expect(link).toHaveAttribute('href', '/')
    })
})

describe('errore di segmento · le tre frasi vengono dal catalogo', () => {
    const errore = Object.assign(new Error('boom'), { digest: 'abc123' })

    it('in italiano rende il testo italiano', async () => {
        const Errore = (await import('@/app/error')).default
        render(<Errore error={errore} reset={() => {}} />)
        expect(screen.getByText(catItShared.paginaErroreTitolo)).toBeInTheDocument()
        expect(screen.getByText(catItShared.paginaErroreCorpo)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: catItShared.paginaErroreRiprova })).toBeInTheDocument()
    })

    it('in inglese rende il testo inglese', async () => {
        lingua = 'en'
        const Errore = (await import('@/app/error')).default
        render(<Errore error={errore} reset={() => {}} />)
        expect(screen.getByText(catEnShared.paginaErroreTitolo)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: catEnShared.paginaErroreRiprova })).toBeInTheDocument()
        expect(document.body.textContent).not.toContain(catItShared.paginaErroreTitolo)
    })

    it('il digest resta a schermo: è il codice che l’utente dà alla segreteria', async () => {
        // Non è un dettaglio grafico. In produzione il messaggio vero di un errore
        // di Server Component resta sul server: il digest è l'UNICA chiave che lega
        // la schermata dell'utente alla riga con lo stack. Tradurre le frasi non
        // deve averlo portato via.
        const Errore = (await import('@/app/error')).default
        render(<Errore error={errore} reset={() => {}} />)
        expect(screen.getByText('abc123')).toBeInTheDocument()
    })
})

describe('errore globale · porta le due lingue con sé e sceglie dal cookie', () => {
    // `global-error.tsx` sostituisce il ROOT LAYOUT, cioè il componente che monta
    // il provider di next-intl: lì il catalogo non esiste più, e le due lingue
    // devono viaggiare dentro il documento (come in `ChunkErrorBoundary` e in
    // `/offline`). Qui si prova che la scelta avvenga davvero, e che l'attributo
    // `lang` la segua — un testo inglese dentro un documento `lang="it"` è il
    // difetto, non il rimedio.
    const errore = Object.assign(new Error('boom'), { digest: 'zzz999' })

    const rendi = async () => {
        const ErroreGlobale = (await import('@/app/global-error')).default
        return render(<ErroreGlobale error={errore} reset={() => {}} />)
    }

    beforeEach(() => {
        document.cookie = 'KV_LOCALE=; Max-Age=0; path=/'
        document.documentElement.removeAttribute('lang')
    })

    /**
     * `lang` NON si legge dal container di React Testing Library: React 19 issa
     * `<html>`, `<head>` e `<body>` sul documento vero invece di annidarli nel
     * `<div>` di prova. È lo stesso comportamento che avrà in produzione — è
     * proprio così che questo componente sostituisce il documento — quindi
     * l'attributo va cercato dove finisce davvero.
     */
    it('senza cookie resta in italiano, e lo dichiara', async () => {
        const { container } = await rendi()
        expect(container.textContent).toContain('Kidville non è riuscita ad avviarsi')
        expect(document.documentElement.getAttribute('lang')).toBe('it')
    })

    it('con KV_LOCALE=en passa all’inglese, `lang` compreso', async () => {
        document.cookie = 'KV_LOCALE=en; path=/'
        const { container } = await rendi()
        expect(container.textContent).toContain('Kidville could not start')
        expect(container.textContent).not.toContain('Kidville non è riuscita ad avviarsi')
        expect(document.documentElement.getAttribute('lang')).toBe('en')
    })
})

describe('le chiavi nuove esistono in tutte e due le lingue, e non sono la stessa parola', () => {
    // La parità dei cataloghi verifica che la chiave CI SIA da entrambe le parti;
    // una traduzione copiata identica la supera e a schermo lascia la lingua
    // sbagliata. Qui si pretende che siano davvero due testi.
    const CHIAVI = [
        'paginaNonTrovataTitolo',
        'paginaNonTrovataCorpo',
        'paginaNonTrovataTornaHome',
        'paginaErroreTitolo',
        'paginaErroreCorpo',
        'paginaErroreRiprova',
    ] as const

    for (const chiave of CHIAVI) {
        it(`shared.${chiave} è tradotta`, () => {
            const it = (catItShared as unknown as Record<string, string>)[chiave]
            const en = (catEnShared as unknown as Record<string, string>)[chiave]
            expect(typeof it, `manca messages/it/shared.json → ${chiave}`).toBe('string')
            expect(typeof en, `manca messages/en/shared.json → ${chiave}`).toBe('string')
            expect(en, `messages/en/shared.json → ${chiave} è identica all’italiano`).not.toBe(it)
        })
    }
})
