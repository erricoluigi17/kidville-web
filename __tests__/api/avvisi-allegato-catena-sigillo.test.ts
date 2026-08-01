import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// S35 · IL SIGILLO EMESSO DALL'UPLOAD DEVE VALERE PER LA RIMOZIONE.
//
// Le due route sono provate ciascuna per conto suo, e ciascuna con la sua idea di
// che cosa venga firmato. È esattamente la condizione in cui un difetto resta
// invisibile: basta che l'upload firmi su un bucket diverso, su un utente diverso
// o su un campo in più perché in produzione NESSUNA rimozione riesca mai — con
// tutti i test verdi, un 403 silenzioso e gli allegati abbandonati che tornano ad
// accumularsi come prima. Non ci sarebbe nemmeno un guasto da vedere: il modulo
// si chiude lo stesso.
//
// Qui la catena si percorre per intero, con le route VERE: si carica un file, si
// prende il sigillo dalla risposta e lo si spende sulla rimozione. Il controllo
// negativo sta accanto e usa la stessa coppia (percorso, sigillo) con un altro
// utente: se passasse, il sigillo non starebbe legando l'identità a niente.
// =============================================================================

const UTENTE = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALTRO_UTENTE = 'bbbbbbbb-0000-4000-8000-00000000000c'

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    rimozioni: [] as { bucket: string; percorsi: string[] }[],
    /** Avvisi che referenziano il percorso cercato: nessuno, è una bozza abbandonata. */
    altriRiferimenti: [] as { id: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: (...a: unknown[]) => h.requireDocente(...a) }))
vi.mock('@/lib/logging/logger', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/logger')>()),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from() {
            const b: Record<string, unknown> = {}
            b.select = () => b
            b.eq = () => b
            b.neq = () => b
            b.ilike = () => b
            b.limit = () => b
            b.then = (onF: (v: unknown) => unknown) =>
                Promise.resolve({ data: h.altriRiferimenti, error: null }).then(onF)
            return b
        },
        storage: {
            from: (bucket: string) => ({
                upload: async () => ({ error: null }),
                createSignedUrl: async () => ({ data: { signedUrl: 'https://x/sign?token=T' }, error: null }),
                remove: async (percorsi: string[]) => {
                    h.rimozioni.push({ bucket, percorsi })
                    return { data: percorsi.map((p) => ({ name: p })), error: null }
                },
            }),
        },
    }),
}))

vi.stubEnv('OTP_TICKET_SECRET', 'sigillo-finto-per-i-test')

import { POST as UPLOAD } from '@/app/api/avvisi/upload/route'
import { POST as RIMUOVI } from '@/app/api/avvisi/upload/rimuovi/route'

const reqUpload = (): Request =>
    ({
        headers: new Headers(),
        url: 'http://test/api/avvisi/upload',
        formData: async () => ({
            get: (k: string) =>
                k === 'file'
                    ? new File([new Uint8Array(4) as unknown as BlobPart], 'circolare.pdf', { type: 'application/pdf' })
                    : null,
        }),
    }) as unknown as Request

const reqRimuovi = (body: unknown) => ({
    url: 'http://test/api/avvisi/upload/rimuovi',
    method: 'POST',
    headers: new Headers(),
    nextUrl: { searchParams: new URLSearchParams() },
    cookies: { get: () => undefined },
    json: async () => body,
}) as never

/** Carica un file come `utente` e restituisce quello che il client riceverebbe. */
async function carica(utente: string): Promise<{ path: string; sigillo: string | null }> {
    h.requireDocente.mockResolvedValue({ user: { id: utente, role: 'segreteria' } })
    const res = await UPLOAD(reqUpload())
    expect(res.status).toBe(200)
    return (await res.json()) as { path: string; sigillo: string | null }
}

beforeEach(() => {
    vi.clearAllMocks()
    h.rimozioni = []
    h.altriRiferimenti = []
})

describe('avvisi/upload → avvisi/upload/rimuovi · la catena del sigillo', () => {
    it('il sigillo restituito dall’upload apre la rimozione DELLO STESSO file', async () => {
        const caricato = await carica(UTENTE)

        expect(caricato.sigillo, 'senza sigillo il client non può nemmeno provare a rimuovere').toBeTruthy()

        const res = await RIMUOVI(reqRimuovi({ percorso: caricato.path, sigillo: caricato.sigillo }))

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ rimosso: true })
        expect(h.rimozioni).toEqual([{ bucket: 'avvisi_allegati', percorsi: [caricato.path] }])
    })

    it('CONTROLLO NEGATIVO · lo stesso sigillo speso da un ALTRO utente non apre niente', async () => {
        const caricato = await carica(UTENTE)
        h.requireDocente.mockResolvedValue({ user: { id: ALTRO_UTENTE, role: 'segreteria' } })

        const res = await RIMUOVI(reqRimuovi({ percorso: caricato.path, sigillo: caricato.sigillo }))

        expect(res.status).toBe(403)
        expect(h.rimozioni, 'il sigillo non lega l’identità a niente').toHaveLength(0)
    })

    it('CONTROLLO NEGATIVO · il sigillo di un caricamento non vale per il file di un altro caricamento', async () => {
        const primo = await carica(UTENTE)
        // Il secondo upload dello stesso utente: percorso diverso, sigillo diverso.
        const secondo = await carica(UTENTE)
        expect(secondo.path).not.toBe(primo.path)

        const res = await RIMUOVI(reqRimuovi({ percorso: secondo.path, sigillo: primo.sigillo }))

        expect(res.status).toBe(403)
        expect(h.rimozioni).toHaveLength(0)
    })
})
