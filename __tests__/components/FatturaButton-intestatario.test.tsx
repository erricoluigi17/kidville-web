/**
 * Il modale «Emetti fattura», seconda metà: CHI riceve il documento.
 *
 * ─── PERCHÉ QUESTI TEST ESISTONO ─────────────────────────────────────────────
 * Misurato in produzione il 2026-09-04: su 93 pagamenti saldati, 88 rispondono
 * «Intestatario fattura non impostato sull'anagrafica» e non emettono niente.
 * Il selettore non è un raffinamento — è ciò che sblocca l'emissione — e proprio
 * per questo l'interfaccia deve *far confermare*, mai decidere da sola: una
 * fattura intestata alla persona sbagliata si corregge solo con una nota di
 * variazione.
 *
 * Le tre cose che questi test inchiodano, e che senza di loro nessuno vedrebbe:
 *  1. la proposta è PRESELEZIONE, non invio: finché non si preme «Emetti» non
 *     parte niente;
 *  2. i quattro `motivo` producono quattro frasi DIVERSE. Con una frase sola
 *     l'interfaccia direbbe «è l'intestatario sulla scheda» anche quando la
 *     scheda non c'entra: cioè mentirebbe a chi sta per confermare;
 *  3. la casella «ricorda sulla scheda» scrive DOPO l'emissione riuscita e mai
 *     prima — un documento rifiutato non lascia dietro una modifica permanente.
 *
 * ⚠️ Repo PUBBLICO: nomi e codici fiscali sintetici. Il cast verificato a zero
 * occorrenze su `parents`, `alunni` e sui file veri è `FABBRI` · `BIANCHI` ·
 * `PERLINI` (vedi `REGOLA-NOMI-FINTI`): non se ne inventano altri.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

/**
 * Il finto `next-intl` INTERPOLA i segnaposti, invece di restituire la stringa
 * grezza: senza, «Bonifico di {ordinante}» passerebbe qualunque asserzione sul
 * nome, e i quattro motivi sarebbero indistinguibili proprio nel test che deve
 * distinguerli.
 */
vi.mock('next-intl', async () => {
    const catalogo = (await import('../../messages/it/adminContabilita.json')).default as Record<string, string>
    const useTranslations = () => {
        const t = (key: string, valori?: Record<string, unknown>) => {
            const testo = catalogo[key] ?? key
            if (!valori) return testo
            return testo.replace(/\{(\w+)\}/g, (_m, k: string) => String(valori[k] ?? `{${k}}`))
        }
        return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
    }
    return { useTranslations, useLocale: () => 'it', NextIntlClientProvider: ({ children }: { children: unknown }) => children }
})
vi.mock('framer-motion', async () => {
    const React = await import('react')
    const motion = new Proxy({}, {
        get: (_t, tag: string) => function Mock(props: Record<string, unknown>) {
            const { children, initial, animate, exit, transition, whileHover, whileTap, layout, variants, ...resto } = props as Record<string, unknown>
            void initial; void animate; void exit; void transition; void whileHover; void whileTap; void layout; void variants
            return React.createElement(tag, resto, children as React.ReactNode)
        },
    })
    return { motion, AnimatePresence: ({ children }: { children?: unknown }) => children }
})

import { FatturaButton } from '@/components/features/admin/pagamenti/FatturaButton'
import { INTESTATARIO_ANTEPRIMA_VUOTO } from '@/lib/aruba/intestatario-pagamento'
import type { CandidatoIntestatario, IntestatarioAnteprima } from '@/lib/aruba/intestatario-pagamento'
import type { MotivoAbbinamentoOrdinante } from '@/lib/pagamenti/ordinante-genitore'

const PAG = '85320395-0000-4000-8000-000000000001'
const UTENTE = 'bbbbbbbb-0000-4000-8000-000000000004'
const ALUNNO = 'aaaaaaaa-0000-4000-8000-000000000009'
const P_FABBRI = '11111111-0000-4000-8000-000000000001'
const P_BIANCHI = '22222222-0000-4000-8000-000000000002'
const CAUSALE = 'Pagamento retta del mese di settembre 2026.'

/** Codici fiscali SINTETICI, con la forma che `validaCessionario` accetta. */
const CF_DIGITATO = 'PRLCRL85M41H501Y'

/**
 * ⚠️ IL CONTRATTO SI IMPORTA, NON SI RICOPIA — e questo file l'ha imparato nel
 * modo peggiore.
 *
 * La prima stesura dichiarava qui una `interface BloccoIntestatario` scritta a
 * mano e metteva `alunno` ACCANTO a `intestatario`. Quando il backend ha spostato
 * quel campo DENTRO il blocco, i 21 test sono rimasti verdi: il mock e il
 * componente concordavano fra loro, e il contratto vecchio restava congelato qui
 * dentro. In produzione la casella «ricorda sulla scheda di ⟨bambino⟩" non
 * sarebbe comparsa affatto, e la PATCH non sarebbe mai partita.
 *
 * È la trappola del mock piatto, su un contratto che passa fra due lotti.
 * Tipizzando la fixture con `IntestatarioAnteprima` — il tipo che la route
 * restituisce davvero — spostare o togliere un campo diventa un errore di
 * COMPILAZIONE qui, invece di una funzionalità morta che nessun test vede.
 */
type Candidato = CandidatoIntestatario
type BloccoIntestatario = IntestatarioAnteprima

const FABBRI: Candidato = { adult_id: P_FABBRI, nome: 'Giulia Fabbri', relazione: 'madre', fatturabile: true, errori: {} }
const BIANCHI_INCOMPLETO: Candidato = {
    adult_id: P_BIANCHI, nome: 'Luca Bianchi', relazione: 'padre', fatturabile: false,
    errori: { codice_fiscale: 'mancante', cap: 'formato' },
}

let chiamate: { url: string; init?: RequestInit }[] = []
let anteprima: { ok: boolean; body: unknown } = { ok: true, body: null }
let emissione: { ok: boolean; body: unknown } = { ok: true, body: { success: true, data: { fattura_stato: 'in_attesa' } } }
let patchStudente: { ok: boolean; body: unknown } = { ok: true, body: { success: true } }

function corpoAnteprima(
    intestatario: Omit<BloccoIntestatario, 'alunno'> | null,
    alunno: BloccoIntestatario['alunno'] = { id: ALUNNO, nome: 'Carlo Perlini' },
) {
    return {
        ok: true,
        body: {
            success: true,
            data: {
                causale: CAUSALE, origine: 'categoria', lunghezza: 42, limite: 200, eccede: false,
                // `alunno` sta DENTRO il blocco: è parte della stessa decisione, e
                // con due posti da cui leggerlo domani direbbero due cose diverse.
                //
                // La base è la COSTANTE che la route restituisce davvero nel caso
                // vuoto, non un oggetto scritto a mano: il tipo protegge dai campi
                // spostati o mancanti a compilazione, questo spread porta anche
                // quelli che il server aggiungesse domani. Un mock che si inventa
                // il contratto del server è ciò che ha lasciato passare la casella
                // «ricorda» morta in produzione con ventuno test verdi.
                ...(intestatario
                    ? { intestatario: { ...INTESTATARIO_ANTEPRIMA_VUOTO, ...intestatario, alunno } }
                    : {}),
            },
        },
    }
}

function montaFetch() {
    chiamate = []
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url)
        chiamate.push({ url: u, init })
        if (u.includes('/anteprima')) return { ok: anteprima.ok, json: async () => anteprima.body } as unknown as Response
        if (u.includes('/api/admin/students')) return { ok: patchStudente.ok, json: async () => patchStudente.body } as unknown as Response
        return { ok: emissione.ok, json: async () => emissione.body } as unknown as Response
    }) as unknown as typeof fetch
}

const post = () => chiamate.find((c) => c.init?.method === 'POST')
const patch = () => chiamate.find((c) => c.init?.method === 'PATCH')
const corpoPost = (): Record<string, unknown> => JSON.parse(String(post()?.init?.body ?? '{}'))
const corpoPatch = (): Record<string, unknown> => JSON.parse(String(patch()?.init?.body ?? '{}'))

async function apri() {
    fireEvent.click(screen.getByRole('button', { name: /invia fattura/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^emetti$/i })).toBeTruthy())
    await screen.findByDisplayValue(CAUSALE)
}

const selettore = () => screen.getByLabelText(/intestatario della fattura/i) as HTMLSelectElement
const bottoneEmetti = () => screen.getByRole('button', { name: /^emetti$/i }) as HTMLButtonElement

/** Il `value` dell'opzione che porta quel testo: il test non deve conoscere la costante. */
function valoreOpzione(testo: RegExp): string {
    const opt = screen.getAllByRole('option').find((o) => testo.test(o.textContent ?? ''))
    if (!opt) throw new Error(`nessuna opzione con ${testo}`)
    return (opt as HTMLOptionElement).value
}

beforeEach(() => {
    montaFetch()
    emissione = { ok: true, body: { success: true, data: { fattura_stato: 'in_attesa' } } }
    patchStudente = { ok: true, body: { success: true } }
    anteprima = corpoAnteprima({
        quote: [],
        ripartito: false,
        candidati: [FABBRI, BIANCHI_INCOMPLETO],
        proposta: null,
        ordinante: null,
    })
})
afterEach(cleanup)

describe('FatturaButton — chi riceve la fattura si sceglie, e si conferma', () => {
    it('elenca i candidati con la loro relazione, e NON manda intestatario finché non si sceglie', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()

        expect(selettore()).toBeTruthy()
        expect(screen.getByRole('option', { name: /Giulia Fabbri/ })).toBeTruthy()
        expect(screen.getByRole('option', { name: /madre/ })).toBeTruthy()

        fireEvent.click(bottoneEmetti())
        await waitFor(() => expect(post()).toBeTruthy())
        // Nessuna scelta = comportamento di sempre: la cascata del server decide.
        expect(corpoPost().intestatario).toBeUndefined()
    })

    it('un candidato NON fatturabile resta nell’elenco, col motivo accanto', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        // In 3 casi su 89 nessun candidato è fatturabile: una tendina vuota senza
        // spiegazione manda a cercare un difetto che non c'è.
        const opzione = screen.getByRole('option', { name: /Luca Bianchi/ })
        expect(opzione.textContent).toMatch(/codice fiscale/i)
        expect(opzione.textContent).toMatch(/CAP/i)
    })

    it('scegliendo un candidato NON fatturabile, «Emetti» si blocca e l’avviso nomina i campi', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        fireEvent.change(selettore(), { target: { value: P_BIANCHI } })

        await waitFor(() => expect(bottoneEmetti().disabled).toBe(true))
        const avviso = screen.getByRole('alert')
        expect(avviso.textContent).toMatch(/codice fiscale/i)
        expect(avviso.textContent).toMatch(/anagrafica del genitore/i)

        fireEvent.click(bottoneEmetti())
        expect(post()).toBeUndefined()
    })

    it('scegliendo un candidato fatturabile, la POST porta `intestatario` di tipo adult', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        fireEvent.change(selettore(), { target: { value: P_FABBRI } })
        fireEvent.click(bottoneEmetti())
        await waitFor(() => expect(post()).toBeTruthy())

        expect(corpoPost().intestatario).toEqual({ tipo: 'adult', adult_id: P_FABBRI })
    })
})

describe('FatturaButton — la proposta del bonifico si PRESELEZIONA, non si spedisce', () => {
    beforeEach(() => {
        anteprima = corpoAnteprima({
            quote: [],
            ripartito: false,
            candidati: [FABBRI, BIANCHI_INCOMPLETO],
            proposta: { adult_id: P_FABBRI, motivo: 'bonifico_esatto' },
            ordinante: 'FABBRI GIULIA',
        })
    })

    it('preseleziona il proposto e dice da chi viene il bonifico — senza emettere niente', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()

        expect(selettore().value).toBe(P_FABBRI)
        expect(screen.getByText(/FABBRI GIULIA/)).toBeTruthy()
        // ⚠️ Preselezione ≠ invio: è una decisione esplicita del titolare.
        expect(post()).toBeUndefined()
    })

    const CASI: [MotivoAbbinamentoOrdinante, RegExp, RegExp][] = [
        ['bonifico_esatto', /corrisponde/i, /sulla scheda/i],
        ['sottoinsieme_unico', /l’unico|l'unico/i, /sulla scheda/i],
        ['sottoinsieme_scheda', /sulla scheda/i, /predefinito della famiglia/i],
        ['sottoinsieme_famiglia', /predefinito della famiglia/i, /sulla scheda/i],
    ]

    it.each(CASI)('il motivo «%s» dice la verità, e non la frase di un altro motivo', async (motivo, atteso, nonAtteso) => {
        anteprima = corpoAnteprima({
            quote: [], ripartito: false, candidati: [FABBRI],
            proposta: { adult_id: P_FABBRI, motivo },
            ordinante: 'FABBRI GIULIA',
        })
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()

        const spiegazione = screen.getByTestId('intestatario-proposta').textContent ?? ''
        expect(spiegazione).toMatch(atteso)
        expect(spiegazione).not.toMatch(nonAtteso)
    })
})

describe('FatturaButton — pagamento ripartito: l’intestatario non si sceglie qui', () => {
    beforeEach(() => {
        anteprima = corpoAnteprima({
            quote: [
                { adult_id: P_FABBRI, label: 'Madre', importo: 75, nome: 'Giulia Fabbri', fatturabile: true, errori: {} },
                { adult_id: P_BIANCHI, label: 'Padre', importo: 75, nome: 'Luca Bianchi', fatturabile: true, errori: {} },
            ],
            ripartito: true,
            candidati: [FABBRI, BIANCHI_INCOMPLETO],
            // ⚠️ LA PROPOSTA C'È ANCHE QUI, ed è il punto: il server la calcola per
            // ogni pagamento, ripartito compreso. La prima stesura di questo test la
            // metteva a `null` e restava VERDE anche togliendo la guardia sul
            // ripartito — cioè non misurava niente. Con la proposta, un'interfaccia
            // che spedisse la scelta prenderebbe un 409 e non emetterebbe più nulla.
            proposta: { adult_id: P_FABBRI, motivo: 'bonifico_esatto' },
            ordinante: 'FABBRI GIULIA',
        })
    })

    it('mostra le quote in sola lettura e NON offre nessun controllo di scelta', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()

        expect(screen.queryByLabelText(/intestatario della fattura/i)).toBeNull()
        expect(screen.getByText(/Giulia Fabbri/)).toBeTruthy()
        expect(screen.getByText(/Luca Bianchi/)).toBeTruthy()
        expect(screen.getAllByText(/€\s*75,00/).length).toBe(2)
        // La via d'uscita va NOMINATA: senza, l'operatore non sa dove andare.
        expect(screen.getByText(/quote del pagamento/i)).toBeTruthy()
    })

    it('emette come sempre: la POST non porta nessun intestatario', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        fireEvent.click(bottoneEmetti())
        await waitFor(() => expect(post()).toBeTruthy())
        expect(corpoPost().intestatario).toBeUndefined()
    })
})

describe('FatturaButton — «Altro»: si digita, e si valida con la stessa funzione dell’emissione', () => {
    async function apriAltro() {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        fireEvent.change(selettore(), { target: { value: valoreOpzione(/altro/i) } })
        await screen.findByLabelText(/codice fiscale/i)
    }

    function compila(campi: Record<string, string>) {
        for (const [etichetta, valore] of Object.entries(campi)) {
            fireEvent.change(screen.getByLabelText(new RegExp(etichetta, 'i')), { target: { value: valore } })
        }
    }

    const COMPLETI = {
        '^nome': 'Carlo',
        '^cognome': 'Perlini',
        'codice fiscale': CF_DIGITATO,
        'indirizzo': 'Via delle Prove 1',
        '^CAP': '80014',
        'comune': 'Giugliano in Campania',
    }

    it('chiede nome, cognome, codice fiscale, indirizzo, CAP e comune', async () => {
        await apriAltro()
        for (const etichetta of Object.keys(COMPLETI)) {
            expect(screen.getByLabelText(new RegExp(etichetta, 'i'))).toBeTruthy()
        }
    })

    it('un CAP di quattro cifre blocca «Emetti» e viene nominato', async () => {
        await apriAltro()
        compila({ ...COMPLETI, '^CAP': '8001' })
        await waitFor(() => expect(bottoneEmetti().disabled).toBe(true))
        expect(screen.getByRole('alert').textContent).toMatch(/CAP/)
    })

    it('con i campi completi la POST porta `tipo: persona`, e provincia/civico restano facoltativi', async () => {
        await apriAltro()
        compila(COMPLETI)
        await waitFor(() => expect(bottoneEmetti().disabled).toBe(false))
        fireEvent.click(bottoneEmetti())
        await waitFor(() => expect(post()).toBeTruthy())

        expect(corpoPost().intestatario).toEqual({
            tipo: 'persona',
            codice_fiscale: CF_DIGITATO,
            nome: 'Carlo',
            cognome: 'Perlini',
            indirizzo: 'Via delle Prove 1',
            cap: '80014',
            comune: 'Giugliano in Campania',
        })
    })

    it('la casella «ricorda sulla scheda» nasce SPENTA e nomina il bambino', async () => {
        await apriAltro()
        const casella = screen.getByRole('checkbox', { name: /Carlo Perlini/ }) as HTMLInputElement
        expect(casella.checked).toBe(false)
    })

    it('accesa, scrive sulla scheda DOPO l’emissione riuscita — mai prima', async () => {
        await apriAltro()
        compila(COMPLETI)
        fireEvent.click(screen.getByRole('checkbox', { name: /Carlo Perlini/ }))
        fireEvent.click(bottoneEmetti())

        await waitFor(() => expect(patch()).toBeTruthy())
        // L'ordine è la sostanza: un documento rifiutato non deve lasciare dietro
        // di sé un intestatario nuovo su tutte le rette future del bambino.
        const iPost = chiamate.findIndex((c) => c.init?.method === 'POST')
        const iPatch = chiamate.findIndex((c) => c.init?.method === 'PATCH')
        expect(iPost).toBeGreaterThanOrEqual(0)
        expect(iPatch).toBeGreaterThan(iPost)

        expect(corpoPatch()).toEqual({
            id: ALUNNO,
            intestatario_fatture: {
                tipo: 'altro',
                dati: {
                    nome: 'Carlo', cognome: 'Perlini', cf: CF_DIGITATO,
                    indirizzo: 'Via delle Prove 1', cap: '80014', comune: 'Giugliano in Campania',
                },
            },
        })
    })

    it('se l’emissione FALLISCE, la scheda non viene toccata', async () => {
        emissione = { ok: false, body: { error: 'Aruba ha rifiutato il documento' } }
        await apriAltro()
        compila(COMPLETI)
        fireEvent.click(screen.getByRole('checkbox', { name: /Carlo Perlini/ }))
        fireEvent.click(bottoneEmetti())

        await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Aruba/))
        expect(patch()).toBeUndefined()
    })

    it('il blocco arriva SENZA il bambino → nessuna casella e nessuna PATCH', async () => {
        // Il caso «campo perso», che va tenuto distinto da «campo spostato»: se
        // l'anteprima non sa dire di chi è la retta, la scelta non si può ricordare
        // su nessuna scheda — e offrire una casella che non salverebbe niente è
        // peggio che non offrirla. Senza questa prova, un `alunno` letto dal posto
        // sbagliato e un `alunno` davvero assente sarebbero indistinguibili.
        anteprima = corpoAnteprima(
            { quote: [], ripartito: false, candidati: [FABBRI, BIANCHI_INCOMPLETO], proposta: null, ordinante: null },
            null,
        )
        await apriAltro()
        compila(COMPLETI)
        expect(screen.queryByRole('checkbox')).toBeNull()

        fireEvent.click(bottoneEmetti())
        await waitFor(() => expect(post()).toBeTruthy())
        expect(patch()).toBeUndefined()
    })

    it('se la scheda non si aggiorna, lo dice: la fattura è uscita lo stesso', async () => {
        patchStudente = { ok: false, body: { error: 'Nessun campo da aggiornare' } }
        await apriAltro()
        compila(COMPLETI)
        fireEvent.click(screen.getByRole('checkbox', { name: /Carlo Perlini/ }))
        fireEvent.click(bottoneEmetti())

        await waitFor(() => expect(patch()).toBeTruthy())
        await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/emessa/i))
        // …e non si ripreme «Emetti»: una seconda fattura vera per la stessa retta.
        expect(bottoneEmetti().disabled).toBe(true)
    })
})

describe('FatturaButton — l’errore dell’emissione si legge a schermo, non in un alert() del browser', () => {
    it('un 409 con codice esce tradotto dentro il `role="alert"`, e `alert()` non viene chiamato', async () => {
        const finto = vi.fn()
        const originale = global.alert
        global.alert = finto as unknown as typeof global.alert
        try {
            emissione = {
                ok: false,
                body: {
                    error: 'Questo pagamento ha già una fattura viva (FPR 1947/26)…',
                    codice: 'FATTURA_GIA_EMESSA_ALTRO_INTESTATARIO',
                },
            }
            render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
            await apri()
            fireEvent.click(bottoneEmetti())

            await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/nota di variazione/i))
            expect(finto).not.toHaveBeenCalled()
        } finally {
            global.alert = originale
        }
    })
})

describe('FatturaButton — senza il blocco `intestatario` nella risposta, tutto come prima', () => {
    it('nessun selettore, nessun errore, e la POST resta quella di oggi', async () => {
        anteprima = corpoAnteprima(null, null)
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()

        expect(screen.queryByLabelText(/intestatario della fattura/i)).toBeNull()
        expect(bottoneEmetti().disabled).toBe(false)
        fireEvent.click(bottoneEmetti())
        await waitFor(() => expect(post()).toBeTruthy())
        expect(corpoPost().intestatario).toBeUndefined()
        expect(corpoPost().causale).toBeNull()
    })
})

describe('FatturaButton — una proposta che non si risolve non diventa la persona sbagliata', () => {
    it('l’id proposto non è fra i candidati → nessuna preselezione e nessuna frase', async () => {
        // ⚠️ NESSUN `?? candidati[0]`. Il backend lo vieta per iscritto e la ragione
        // vale identica qui: un ripiego sul primo elemento intesterebbe la fattura a
        // un altro genitore in SILENZIO, e chi conferma non avrebbe modo di
        // accorgersene — l'unico segnale sarebbe un documento fiscale già partito.
        anteprima = corpoAnteprima({
            quote: [], ripartito: false, candidati: [FABBRI, BIANCHI_INCOMPLETO],
            proposta: { adult_id: '99999999-0000-4000-8000-000000000099', motivo: 'bonifico_esatto' },
            ordinante: 'PERLINI CARLO',
        })
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()

        expect(selettore().value).toBe('')
        expect(screen.queryByTestId('intestatario-proposta')).toBeNull()
    })
})
