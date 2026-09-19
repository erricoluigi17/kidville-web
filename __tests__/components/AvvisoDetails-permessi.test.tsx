import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itAvvisi from '../../messages/it/avvisi.json'
import itShared from '../../messages/it/shared.json'
import { AvvisoDetailsContent } from '@/components/features/avvisi/AvvisoDetailsContent'
import { AvvisoDetailsDrawer } from '@/components/features/avvisi/AvvisoDetailsDrawer'
import type { Avviso } from '@/components/features/avvisi/AvvisoCard'

expect.extend(toHaveNoViolations)

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL RIEPILOGO DELLA SEGRETERIA SU UN AVVISO DI ADESIONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Questo file misura cinque cose che, sbagliate, non fanno rumore:
 *
 *  1. **I comandi di scrittura NON ESISTONO senza il permesso.** Non «sono
 *     nascosti»: un comando reso e coperto con una classe resta raggiungibile da
 *     tastiera e viene letto da uno screen reader. L'asserzione è `queryBy…` che
 *     torna `null`, e accanto ha sempre la sua positiva — senza, passerebbe anche
 *     su un componente che non rende più niente.
 *
 *  2. **Il totale in persone è la somma delle righe a schermo.** Un totale
 *     calcolato altrove è il modo in cui la capienza mente: la schermata direbbe
 *     «22 su 50» mentre il database rifiuta la ventitreesima adesione, e nessuno
 *     dei due numeri sarebbe sbagliato preso da solo. Qui la somma si rifà
 *     leggendo i chip accanto ai nomi.
 *
 *  3. **`RISPOSTA_CONTRARIA` è una domanda, non un errore.** Se esce come errore
 *     la funzione è inutilizzabile: chi legge «operazione fallita» riprova, e
 *     riproverà all'infinito una cosa che non può riuscire finché non risponde.
 *
 *  4. **Le due «attese» restano due.** «Senza risposta» (non ha ancora risposto) e
 *     «In lista d'attesa» (ha risposto sì, i posti erano finiti) sono due gruppi
 *     diversi: confonderli significa telefonare alla famiglia sbagliata.
 *
 *  5. **`occupati: null` non diventa `0`.** `null` vuol dire «non misurato»; zero
 *     vuol dire «non c'è più nessuno dentro». Sono l'opposto.
 *
 * I testi attesi sono scritti IN CHIARO e non come `t('chiave')`: confrontare il
 * catalogo con se stesso sarebbe verde anche con la chiave sbagliata.
 */

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    nomeErrore: () => 'Error',
}))

// Dati inventati: mai nomi veri di bambini o famiglie nei test (repo pubblico).
const AVVISO_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const USER = 'bbbbbbbb-2222-4222-8222-222222222222'

const S = {
    ammessoTre: 'cccc0001-0000-4000-8000-000000000001',
    inCodaDue: 'cccc0002-0000-4000-8000-000000000002',
    haDettoNo: 'cccc0003-0000-4000-8000-000000000003',
    senzaRisposta: 'cccc0004-0000-4000-8000-000000000004',
    ammessoQuattro: 'cccc0005-0000-4000-8000-000000000005',
    /** Un alunno che NON è fra i destinatari: la sua riga non si incrocia con nessuno. */
    fuoriSezione: 'cccc0006-0000-4000-8000-000000000006',
}

const R = {
    ammessoTre: 'dddd0001-0000-4000-8000-000000000001',
    inCodaDue: 'dddd0002-0000-4000-8000-000000000002',
    haDettoNo: 'dddd0003-0000-4000-8000-000000000003',
    /** La riga aggiuntiva di `senzaRisposta`: ha risposto, ma non ha (ancora) letto. */
    senzaRisposta: 'dddd0004-0000-4000-8000-000000000004',
    ammessoQuattro: 'dddd0005-0000-4000-8000-000000000005',
    fuoriSezione: 'dddd0006-0000-4000-8000-000000000006',
}

const CLASSE = 'TEST 1A'

const ALUNNI = [
    { id: S.ammessoTre, nome: 'TEST', cognome: 'Ammesso3', classe_sezione: CLASSE },
    { id: S.inCodaDue, nome: 'TEST', cognome: 'InCoda2', classe_sezione: CLASSE },
    { id: S.haDettoNo, nome: 'TEST', cognome: 'HaDettoNo', classe_sezione: CLASSE },
    { id: S.senzaRisposta, nome: 'TEST', cognome: 'SenzaRisposta', classe_sezione: CLASSE },
    { id: S.ammessoQuattro, nome: 'TEST', cognome: 'Ammesso4', classe_sezione: CLASSE },
]

/**
 * Le risposte come le manda `GET /api/avvisi/[id]/risposte`.
 *
 * Due famiglie ammesse (3 + 4 = 7 persone) su due genitori distinti, una in coda
 * con 2 persone, una che ha risposto NO. Il quinto alunno non ha nessuna riga: è
 * il «senza risposta», che con la lista d'attesa non c'entra niente.
 */
const RISPOSTE = [
    {
        id: R.ammessoTre, parent_id: 'p1', student_id: S.ammessoTre,
        letto_il: '2026-09-18T08:00:00Z', risposta: 'si', risposto_il: '2026-09-18T08:05:00Z',
        parent_name: 'TEST Genitore1', student_name: 'TEST Ammesso3',
        numero_partecipanti: 3, stato_adesione: 'ammessa',
    },
    {
        id: R.ammessoQuattro, parent_id: 'p5', student_id: S.ammessoQuattro,
        letto_il: '2026-09-18T08:10:00Z', risposta: 'si', risposto_il: '2026-09-18T08:11:00Z',
        parent_name: 'TEST Genitore5', student_name: 'TEST Ammesso4',
        numero_partecipanti: 4, stato_adesione: 'ammessa',
    },
    {
        id: R.inCodaDue, parent_id: 'p2', student_id: S.inCodaDue,
        letto_il: '2026-09-18T09:00:00Z', risposta: 'si', risposto_il: '2026-09-18T09:01:00Z',
        parent_name: 'TEST Genitore2', student_name: 'TEST InCoda2',
        numero_partecipanti: 2, stato_adesione: 'in_attesa',
    },
    {
        id: R.haDettoNo, parent_id: 'p3', student_id: S.haDettoNo,
        letto_il: '2026-09-18T10:00:00Z', risposta: 'no', risposto_il: '2026-09-18T10:01:00Z',
        parent_name: 'TEST Genitore3', student_name: 'TEST HaDettoNo',
        numero_partecipanti: null, stato_adesione: null,
    },
]

/**
 * UNA SESTA RIGA, PER UN ALUNNO CHE NON È FRA I DESTINATARI.
 *
 * Succede: un bambino cambia sezione, o l'avviso viene ripuntato dopo che qualcuno
 * ha già risposto. Il server la restituisce lo stesso — ed è giusto, perché è una
 * riga che OCCUPA un posto e che `avviso_posti_occupati` conta — ma l'elenco non
 * riesce ad accostarla a nessun nome. Da qui nascono due difetti misurati:
 * un totale che non si può più sommare a mano, e tre contatori che mescolavano
 * questa base con quella degli alunni incrociati.
 */
const RISPOSTA_FUORI_SEZIONE = {
    id: R.fuoriSezione, parent_id: 'p9', student_id: S.fuoriSezione,
    letto_il: '2026-09-18T11:00:00Z', risposta: 'si', risposto_il: '2026-09-18T11:01:00Z',
    parent_name: 'TEST Genitore9', student_name: 'TEST FuoriSezione',
    numero_partecipanti: 5, stato_adesione: 'ammessa',
}

const RISPOSTE_CON_FUORI_SEZIONE = [...RISPOSTE, RISPOSTA_FUORI_SEZIONE]

/**
 * LE STESSE RIGHE COME LE MANDA UN DATABASE NON MIGRATO.
 *
 * I due campi del cantiere non ci sono AFFATTO: è il ripiego dichiarato dalla
 * rotta, ed è la strada sempre percorsa dal DB E2E della CI. `undefined` vale
 * «non misurato» e non deve poter diventare uno zero a schermo — uno zero è
 * l'unico valore capace di far sembrare vuoto un pullman pieno.
 */
const RISPOSTE_NON_MISURATE = RISPOSTE.map((r) => {
    const copia: Record<string, unknown> = { ...r }
    delete copia.numero_partecipanti
    delete copia.stato_adesione
    return copia
})

/**
 * UNA RISPOSTA VERA, MA SENZA `letto_il`.
 *
 * È il caso che la testata di `StatoLettura.tsx` nomina esplicitamente: «un
 * genitore può aver risposto senza che la riga porti un `letto_il`». Senza
 * questa riga nessuna prova lo eserciterebbe mai, perché in `RISPOSTE` le
 * quattro righe che esistono hanno TUTTE `letto_il` valorizzato — l'unico modo
 * in cui «TEST SenzaRisposta» finisce fra i non letti è che per lui non esista
 * proprio nessuna riga, e quello è indistinguibile (per `letture()`) da «la riga
 * c'è ma non è stata letta». Qui gliene si dà una, apposta.
 */
const RISPOSTA_LETTA_SENZA_DATA = {
    id: R.senzaRisposta, parent_id: 'p4', student_id: S.senzaRisposta,
    letto_il: null, risposta: 'si', risposto_il: '2026-09-18T12:00:00Z',
    parent_name: 'TEST Genitore4', student_name: 'TEST SenzaRisposta',
    numero_partecipanti: 1, stato_adesione: 'ammessa',
}

const RISPOSTE_CON_LETTURA_MANCANTE = [...RISPOSTE, RISPOSTA_LETTA_SENZA_DATA]

function avviso(extra: Partial<Avviso> & { posti_totali?: number | null } = {}): Avviso {
    return {
        id: AVVISO_ID,
        author_id: USER,
        titolo: 'TEST Uscita didattica',
        contenuto: 'TEST corpo.',
        tipo: 'adesione',
        target_scope: 'classe',
        target_classes: [CLASSE],
        scadenza: null,
        attachment_url: null,
        created_at: '2026-09-17T08:00:00Z',
        author: { first_name: 'TEST', last_name: 'Segreteria', role: 'segreteria' },
        stats: { letti: 4, adesioni_si: 3, adesioni_no: 1 },
        numero_min: 1,
        numero_max: 20,
        // `posti_totali` non è (ancora) nel tipo condiviso: il componente lo legge
        // in modo difensivo, e qui si passa come lo manda la rotta staff.
        ...({ posti_totali: 10 } as Record<string, unknown>),
        ...extra,
    } as Avviso
}

/** Il PATCH più recente: url, metodo e corpo, per provare che cosa è stato mandato. */
let ultimaPatch: { url: string; corpo: Record<string, unknown> } | null = null

/**
 * La rete finta. `patch` decide come risponde il PATCH: di default 200.
 * ⚠️ Non è un mock piatto: ogni prova che conta cambia questa risposta e verifica
 * che la schermata cambi di conseguenza.
 */
function reteFinta(patch?: { status: number; corpo: unknown }, righe: unknown[] = RISPOSTE) {
    ultimaPatch = null
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
        const u = String(url)
        if (init?.method === 'PATCH') {
            ultimaPatch = { url: u, corpo: JSON.parse(String(init.body)) }
            const risposta = patch ?? { status: 200, corpo: { stato: 'ammessa', numero: 2, occupati: 9, posti_totali: 10 } }
            return Promise.resolve({
                ok: risposta.status < 400,
                status: risposta.status,
                json: async () => risposta.corpo,
            } as unknown as Response)
        }
        if (u.includes('/risposte')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => righe } as unknown as Response)
        }
        if (u.includes('/api/diary/students')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ALUNNI } as unknown as Response)
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] } as unknown as Response)
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

/** Monta il contenuto e apre la linguetta «Adesioni», che è dove vive tutto. */
async function apriAdesioni(props: { permessiScrittura?: boolean; avvisoDaUsare?: Avviso } = {}) {
    const risultato = render(
        <AvvisoDetailsContent
            avviso={props.avvisoDaUsare ?? avviso()}
            availableClasses={[CLASSE]}
            userId={USER}
            layout="page"
            {...(props.permessiScrittura ? { permessiScrittura: true } : {})}
        />,
    )
    // Si aspetta la PRESENZA di qualcosa: un `waitFor` su un'assenza passerebbe
    // mentre le fetch sono ancora in volo.
    await waitFor(() => expect(screen.getByText(itAvvisi.tabAdesioni)).toBeInTheDocument())
    fireEvent.click(screen.getByText(itAvvisi.tabAdesioni))
    return risultato
}

/** Sceglie un valore nella tendina «Risposta». */
function filtraRisposta(valore: string) {
    const tendina = screen.getByLabelText(itAvvisi.risposta) as HTMLSelectElement
    fireEvent.change(tendina, { target: { value: valore } })
}

/** La riga (li) di un alunno, per nome. */
function rigaDi(cognome: string): HTMLElement {
    return screen.getByText(`TEST ${cognome}`).closest('li') as HTMLElement
}

/**
 * Il riquadro dei posti.
 *
 * Si cerca fra TUTTE le regioni `role="status"` quella che porta l'etichetta
 * «Posti»: sulla schermata della segreteria ce n'è anche una seconda, quella
 * dell'esportazione. Un `getByRole('status')` secco passerebbe in sola lettura e
 * cadrebbe col permesso — cioè proprio dove serve.
 */
function riepilogoPosti(): HTMLElement {
    const trovato = screen
        .getAllByRole('status')
        .find((el) => el.textContent?.includes(itAvvisi.postiRiepilogoEtichetta))
    expect(trovato, 'il riquadro dei posti deve esistere').toBeDefined()
    return trovato as HTMLElement
}

/** Il riquadro dei tre contatori (Sì · No · Senza risposta). */
function dettaglioAdesioni(): HTMLElement {
    return screen.getByText(itAvvisi.dettaglioAdesioni).closest('div') as HTMLElement
}

/**
 * Il NUMERO accanto a un'etichetta dei tre contatori.
 *
 * Si cerca dentro il riquadro e non su tutta la pagina: «No» è anche il chip di
 * ogni riga che ha declinato, e un `getByText` secco pescherebbe il sosia.
 */
function contatore(etichetta: string): number {
    const cella = within(dettaglioAdesioni()).getByText(etichetta).closest('div')?.parentElement
    expect(cella, `il contatore «${etichetta}» deve esistere`).not.toBeNull()
    const trovato = (cella as HTMLElement).textContent?.match(/(\d+)\s*$/)?.[1]
    expect(trovato, `il contatore «${etichetta}» non porta un numero: «${(cella as HTMLElement).textContent}»`).toBeDefined()
    return Number(trovato)
}

/** Quante volte l'elenco delle risposte è stato chiesto al server. */
function letturaRisposte(): number {
    const chiamate = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    return chiamate.filter((c) => String(c[0]).includes('/risposte') && (c[1] as RequestInit | undefined)?.method !== 'PATCH').length
}

// ═════════════════════════════════════════════════════════════════════════════

describe('AvvisoDetailsContent — ogni etichetta etichetta davvero un controllo', () => {
    beforeEach(() => reteFinta())

    /**
     * ⚠️ UN DIFETTO DI FORMA SI CERCA SU TUTTI I CAMPI CON QUELLA FORMA.
     *
     * Le due `<label>` dei filtri c'erano da sempre e non erano associate a
     * niente: un `<label>` senza `for` è un titoletto muto, e il controllo accanto
     * resta senza nome — axe lo chiama `select-name`, e chi usa uno screen reader
     * sente «menu a discesa» due volte senza sapere quale sia quale. È lo stesso
     * difetto già documentato sul campo data del modulo avvisi.
     *
     * Qui si risale dal CONTROLLO alla sua etichetta (`element.labels`), che è la
     * direzione in cui guarda la tecnologia assistiva: un `getByText` sull'etichetta
     * sarebbe verde anche con l'associazione rotta.
     */
    const etichettaDi = (controllo: HTMLSelectElement | HTMLInputElement): string =>
        [...(controllo.labels ?? [])].map((l) => l.textContent?.trim() ?? '').join(' ');

    it('i due filtri della linguetta Adesioni hanno il loro nome', async () => {
        await apriAdesioni()
        expect(etichettaDi(screen.getByLabelText(itAvvisi.classe) as HTMLSelectElement)).toBe(itAvvisi.classe)
        expect(etichettaDi(screen.getByLabelText(itAvvisi.risposta) as HTMLSelectElement)).toBe(itAvvisi.risposta)
    })

    it('anche il filtro della linguetta Stato Lettura, che è un secondo `<select>`', async () => {
        render(
            <AvvisoDetailsContent avviso={avviso()} availableClasses={[CLASSE]} userId={USER} layout="page" />,
        )
        await waitFor(() => expect(screen.getByText(itAvvisi.filtri)).toBeInTheDocument())
        expect(etichettaDi(screen.getByLabelText(itAvvisi.classe) as HTMLSelectElement)).toBe(itAvvisi.classe)
    })

    it('e il contatore del dialogo «Correggi il numero»', async () => {
        await apriAdesioni({ permessiScrittura: true })
        fireEvent.click(
            within(rigaDi('Ammesso3')).getByRole('button', { name: /Correggi il numero di persone/ }),
        )
        const dialogo = await screen.findByRole('dialog')
        const campo = within(dialogo).getByLabelText(itAvvisi.adesioneQuantePersone) as HTMLInputElement
        expect(etichettaDi(campo)).toBe(itAvvisi.adesioneQuantePersone)
        // E il valore di partenza è quello della famiglia, non uno inventato.
        expect(campo).toHaveValue(3)
    })
})

describe('AvvisoDetailsContent — lo «Stato Lettura» è un’altra cosa dalle adesioni', () => {
    beforeEach(() => reteFinta())

    /**
     * La linguetta delle LETTURE vive in `./dettaglio/StatoLettura` e conta su una
     * base sua: `letto_il`, sugli alunni destinatari. Un genitore può aver letto
     * senza rispondere e aver risposto senza che la riga porti una lettura —
     * contare le une per le altre darebbe numeri plausibili e falsi.
     */
    it('conta chi ha letto sugli alunni destinatari, non sulle risposte', async () => {
        // ⚠️ QUESTA RIGA E LA SUA ASSENZA SONO INDISTINGUIBILI PER `letture()` SE NON
        // SI GUARDA `letto_il`. `RISPOSTE_CON_LETTURA_MANCANTE` aggiunge, sul quinto
        // alunno, una riga VERA (risposta valorizzata) ma senza data di lettura: se il
        // filtro `.filter(r => r.letto_il)` sparisse da `letture()`, questa riga
        // diventerebbe un «letto» in più (con `lettoIl: '-'`) e i numeri qui sotto — 4,
        // non 5, e «Non letti (1)» invece di «(0)» — cadrebbero. Senza questa riga il
        // test resterebbe verde in entrambi i casi, perché l'unica alternativa a «letto»
        // sarebbe già «nessuna riga affatto», che il filtro non tocca.
        reteFinta(undefined, RISPOSTE_CON_LETTURA_MANCANTE)
        render(
            <AvvisoDetailsContent avviso={avviso()} availableClasses={[CLASSE]} userId={USER} layout="page" />,
        )
        await waitFor(() => expect(screen.getByText(itAvvisi.filtri)).toBeInTheDocument())

        // Quattro righe portano `letto_il`, gli alunni destinatari sono cinque: la
        // quinta riga (risposta valorizzata, `letto_il: null`) non sposta questi
        // numeri — è proprio la controprova che il filtro guarda `letto_il` e non la
        // sola presenza della riga.
        const cartaLetti = screen.getByText(itAvvisi.statLetti).closest('div')?.parentElement as HTMLElement
        expect(cartaLetti.textContent).toContain('4')
        expect(cartaLetti.textContent).toContain('su 5 (80%)')

        // Le due sottolinguette portano i conteggi dei rispettivi elenchi.
        expect(screen.getByRole('button', { name: 'Letti (4)' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Non letti (1)' })).toBeInTheDocument()

        // L'elenco dei letti mostra il genitore accanto all'alunno…
        expect(screen.getByText('TEST Ammesso3')).toBeInTheDocument()
        expect(screen.queryByText('TEST SenzaRisposta')).not.toBeInTheDocument()

        // …e chi non ha letto sta nell'altro elenco, col suo badge — ANCHE avendo
        // risposto: la sua riga esiste (`RISPOSTA_LETTA_SENZA_DATA`), ma senza
        // `letto_il` resta fra i non letti.
        fireEvent.click(screen.getByRole('button', { name: 'Non letti (1)' }))
        expect(screen.getByText('TEST SenzaRisposta')).toBeInTheDocument()
        expect(screen.getByText(itAvvisi.badgeDaLeggere)).toBeInTheDocument()
        expect(screen.queryByText('TEST Ammesso3')).not.toBeInTheDocument()
    })

    it('la ricerca dei letti prende anche il nome del GENITORE, che è a schermo', async () => {
        render(
            <AvvisoDetailsContent avviso={avviso()} availableClasses={[CLASSE]} userId={USER} layout="page" />,
        )
        await waitFor(() => expect(screen.getByText(itAvvisi.filtri)).toBeInTheDocument())

        fireEvent.change(screen.getByPlaceholderText(itAvvisi.cercaPlaceholder), {
            target: { value: 'Genitore2' },
        })

        // Resta la riga di quel genitore (positiva) e spariscono le altre.
        expect(screen.getByText('TEST InCoda2')).toBeInTheDocument()
        expect(screen.queryByText('TEST Ammesso3')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Letti (1)' })).toBeInTheDocument()
    })
})

describe('AvvisoDetailsContent — i comandi di scrittura esistono solo col permesso', () => {
    beforeEach(() => reteFinta())

    it('SENZA `permessiScrittura` i comandi NON sono nell\'albero (non «nascosti»)', async () => {
        await apriAdesioni()

        // Positiva, che regge tutte le negative sotto: l'elenco c'è davvero ed è
        // pieno. Senza, «non c'è il bottone» passerebbe su una schermata vuota.
        expect(screen.getByText('TEST Ammesso3')).toBeInTheDocument()
        expect(screen.getByText('TEST InCoda2')).toBeInTheDocument()

        // Negative: nessun comando di scrittura, per NOME accessibile — che è il
        // modo in cui li trova chi naviga a elenco di controlli.
        expect(
            screen.queryByRole('button', { name: /Correggi il numero di persone/i }),
        ).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /dalla lista d’attesa/i })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: itAvvisi.esportaElenco })).not.toBeInTheDocument()
    })

    it('CON `permessiScrittura` ci sono, e portano il nome dell\'alunno', async () => {
        await apriAdesioni({ permessiScrittura: true })

        // Il nome nell'`aria-label`: trenta «Modifica» nudi sono trenta bottoni
        // indistinguibili per chi non vede lo schermo.
        expect(
            screen.getByRole('button', { name: `Correggi il numero di persone di «TEST Ammesso3»` }),
        ).toBeInTheDocument()
        expect(
            screen.getByRole('button', { name: `Ammetti «TEST InCoda2» dalla lista d’attesa` }),
        ).toBeInTheDocument()
        expect(screen.getByRole('button', { name: itAvvisi.esportaElenco })).toBeInTheDocument()
    })

    it('«Ammetti» compare su chi è in coda e su chi aveva detto NO, mai su chi è già dentro', async () => {
        await apriAdesioni({ permessiScrittura: true })

        // ⚠️ IL NOME PER INTERO, SU ENTRAMBE LE RIGHE. Fino al 2026-09-19 qui c'era
        // `/^Ammetti/` sulla riga «no» e il nome intero solo su quella in coda: il
        // prefisso è esattamente lo spazio in cui la bugia ci stava, e infatti
        // quella riga si chiamava «Ammetti … dalla lista d'attesa» pur non essendo
        // in nessuna coda.

        // In coda: il caso principale, e il nome dice da dove.
        expect(
            within(rigaDi('InCoda2')).getByRole('button', { name: 'Ammetti «TEST InCoda2» dalla lista d’attesa' }),
        ).toBeInTheDocument()
        // Aveva risposto NO: senza questo comando `RISPOSTA_CONTRARIA` non si
        // potrebbe mai innescare dall'interfaccia, e la funzione resterebbe morta.
        // Il suo nome dice l'altra cosa, perché è un'altra cosa.
        const ammettiNo = within(rigaDi('HaDettoNo')).getByRole('button', {
            name: 'Ammetti «TEST HaDettoNo», che aveva risposto no',
        })
        expect(ammettiNo).toBeInTheDocument()
        // E su quella riga la lista d'attesa non si nomina: è l'unico nome che
        // sente chi usa uno screen reader, e sarebbe falso.
        expect(ammettiNo.getAttribute('aria-label')).not.toContain('lista d’attesa')
        // Già ammesso: non si ammette due volte.
        expect(
            within(rigaDi('Ammesso3')).queryByRole('button', { name: /^Ammetti/ }),
        ).not.toBeInTheDocument()
    })
})

describe('AvvisoDetailsContent — il totale in persone è la somma delle righe', () => {
    beforeEach(() => reteFinta())

    it('il riepilogo dice 7 persone, e 3 + 4 sono i chip delle due righe ammesse', async () => {
        await apriAdesioni()

        const riepilogo = riepilogoPosti()
        // La frase composta dalle tre chiavi con plurale ICU proprio, unite da «·».
        expect(riepilogo).toHaveTextContent('7 persone · su 10 posti · 2 persone in lista d’attesa')
        // Le famiglie accanto: il totale in persone è volutamente largo (due
        // fratelli dichiarano lo stesso accompagnatore due volte) e senza questo
        // numero non c'è modo di sapere quanto sia gonfio.
        expect(riepilogo).toHaveTextContent('2 famiglie')

        // La somma si rifà a mano dalle righe che occupano un posto: se il totale
        // venisse da un'altra fonte, questo confronto cadrebbe.
        const sommaRighe = [rigaDi('Ammesso3'), rigaDi('Ammesso4')]
            .map((riga) => Number(riga.textContent?.match(/(\d+) person[ae]/)?.[1] ?? 0))
            .reduce((a, b) => a + b, 0)
        expect(sommaRighe).toBe(7)
        expect(riepilogo.textContent).toContain(`${sommaRighe} persone`)
    })

    it('chi si è RITIRATO non porta più il suo numero (il database lo conserva, lo schermo no)', async () => {
        await apriAdesioni()
        filtraRisposta('no')
        // La riga c'è (positiva)…
        expect(screen.getByText('TEST HaDettoNo')).toBeInTheDocument()
        // …e non dichiara persone: `numero_partecipanti` resta salvato dopo un
        // ritiro, e mostrarlo direbbe che quella famiglia partecipa.
        expect(rigaDi('HaDettoNo').textContent).not.toMatch(/person[ae]/)
    })

    it('sopra capienza: il badge compare e la riga spiega che nessuno è stato escluso', async () => {
        await apriAdesioni({ avvisoDaUsare: avviso({ ...({ posti_totali: 5 } as Record<string, unknown>) }) })

        const riepilogo = riepilogoPosti()
        expect(riepilogo).toHaveTextContent('7 persone · su 5 posti')
        expect(riepilogo).toHaveTextContent(itAvvisi.postiSopraCapienza)
        expect(riepilogo).toHaveTextContent(itAvvisi.postiSopraCapienzaAiuto)
    })

    it('senza tetto la frase non inventa un «su N posti»', async () => {
        await apriAdesioni({ avvisoDaUsare: avviso({ ...({ posti_totali: null } as Record<string, unknown>) }) })

        const riepilogo = riepilogoPosti()
        expect(riepilogo).toHaveTextContent('7 persone · 2 persone in lista d’attesa')
        expect(riepilogo.textContent).not.toMatch(/su \d+ post/)
        expect(riepilogo.textContent).not.toContain(itAvvisi.postiSopraCapienza)
    })
})

describe('AvvisoDetailsContent — su un database non migrato il riquadro dice «non misurato», mai zero', () => {
    /**
     * 🔴 IL DIFETTO, misurato: con le righe PRIVE dei due campi — il ripiego che la
     * rotta dichiara, e la strada sempre percorsa dal DB E2E della CI — la
     * schermata scriveva «0 persone · su 10 posti · 0 persone in lista d'attesa»
     * accanto a «Sì 3». Uno zero non è «non lo so»: è l'unico valore capace di far
     * sembrare vuoto un pullman pieno, ed è la stessa famiglia del `?? 0` che in
     * questo repo ha congelato per sempre lo stato SDI di una fattura.
     */
    it('le righe senza i due campi non diventano MAI «0 persone»', async () => {
        reteFinta(undefined, RISPOSTE_NON_MISURATE)
        await apriAdesioni()

        // Positive: la schermata è viva, l'elenco è pieno e i tre contatori — che
        // NON dipendono dalle due colonne mancanti — dicono ancora il vero.
        expect(screen.getByText('TEST Ammesso3')).toBeInTheDocument()
        expect(contatore(itAvvisi.si)).toBe(3)
        expect(contatore(itAvvisi.attesa)).toBe(1)

        // E il riquadro dei posti dichiara di non sapere, invece di dire zero.
        const riepilogo = riepilogoPosti()
        expect(riepilogo.textContent).toContain('Non misurato')
        expect(riepilogo.textContent).not.toContain('0 person')
        expect(riepilogo.textContent).not.toContain('0 famiglie')
        expect(riepilogo.textContent).not.toMatch(/su \d+ post/)
        // Nessun badge: «sopra capienza» su un conteggio mai avvenuto è un'accusa
        // inventata, e il tetto non c'entra con ciò che non si è potuto contare.
        expect(riepilogo.textContent).not.toContain(itAvvisi.postiSopraCapienza)

        // E su TUTTA la schermata, non solo dentro il riquadro: nessuna riga può
        // dichiarare persone che nessuno ha contato.
        expect(document.body.textContent).not.toContain('0 person')
    })

    it('con i campi al loro posto il riquadro torna a contare (controllo opposto)', async () => {
        // Senza questa prova, «non c'è lo zero» sopra sarebbe verde anche su un
        // componente che ha smesso di mostrare qualunque numero.
        reteFinta()
        await apriAdesioni()
        const riepilogo = riepilogoPosti()
        expect(riepilogo).toHaveTextContent('7 persone · su 10 posti · 2 persone in lista d’attesa')
        expect(riepilogo.textContent).not.toContain('Non misurato')
    })
})

describe('AvvisoDetailsContent — una base sola per tutti i numeri della schermata', () => {
    // Le stesse righe di sempre PIÙ una per un alunno fuori dalle sezioni
    // destinatarie: è l'unica differenza, ed è quella che faceva divergere le due
    // basi di conteggio.
    beforeEach(() => reteFinta(undefined, RISPOSTE_CON_FUORI_SEZIONE))

    /**
     * 🔴 IL DIFETTO, misurato: `pendingAnswers = Math.max(0, totalTarget - (si + no))`
     * mescolava gli alunni INCROCIATI (5) con le risposte di TUTTO il server (4 sì +
     * 1 no), e dava `5 − 5 = 0` mentre «TEST SenzaRisposta» era a schermo e il
     * filtro lo restituiva. Il `Math.max(0, …)` ingoiava il negativo in silenzio.
     */
    it('«Senza risposta» conta 1 mentre quel bambino è nell’elenco', async () => {
        await apriAdesioni()

        // Positiva: il bambino senza risposta c'è davvero, e il filtro lo trova.
        filtraRisposta('attesa')
        expect(screen.getByText('TEST SenzaRisposta')).toBeInTheDocument()

        expect(contatore(itAvvisi.attesa)).toBe(1)
        // E gli altri due contano le righe dell'ELENCO, non quelle del server: la
        // riga fuori sezione non è un «sì» che qualcuno possa ritrovare fra i nomi.
        expect(contatore(itAvvisi.si)).toBe(3)
        expect(contatore(itAvvisi.no)).toBe(1)
        // I tre si sommano agli alunni destinatari: una base sola, e si vede.
        expect(contatore(itAvvisi.si) + contatore(itAvvisi.no) + contatore(itAvvisi.attesa)).toBe(ALUNNI.length)
    })

    /**
     * 🔴 IL DIFETTO, misurato: «12 persone» con i chip a schermo che sommavano 7.
     * La base è giusta — è quella di `avviso_posti_occupati`, e una base più bassa
     * farebbe credere che il pullman abbia posto — ma dello scarto non si rendeva
     * conto: la segreteria leggeva uno sforamento con 5 persone invisibili.
     */
    it('lo scarto fra il totale e le righe a schermo è DICHIARATO, non nascosto', async () => {
        await apriAdesioni()

        const riepilogo = riepilogoPosti()
        expect(riepilogo).toHaveTextContent('12 persone · su 10 posti · 2 persone in lista d’attesa')
        expect(riepilogo).toHaveTextContent('3 famiglie')

        // La somma rifatta a mano sui chip delle righe AMMESSE fa 7, non 12 (quelli
        // di chi è in coda stanno nel pezzo «2 persone in lista d'attesa»)…
        const sommaRighe = [rigaDi('Ammesso3'), rigaDi('Ammesso4')]
            .map((riga) => Number(riga.textContent?.match(/(\d+) person[ae]/)?.[1] ?? 0))
            .reduce((a, b) => a + b, 0)
        expect(sommaRighe).toBe(7)
        // …e la differenza è scritta, invece di restare un mistero di 5 persone.
        expect(riepilogo).toHaveTextContent('1 adesione non associata a un alunno di queste sezioni')
    })

    it('«Sopra capienza» non dà la colpa a un tetto che nessuno ha abbassato', async () => {
        await apriAdesioni()

        const riepilogo = riepilogoPosti()
        expect(riepilogo).toHaveTextContent(itAvvisi.postiSopraCapienza)
        // La causa non è nota alla schermata: qui il tetto è sempre stato 10 e le
        // adesioni lo hanno superato da sole.
        expect(riepilogo.textContent).not.toContain('abbassato')
        // Ma ciò che il badge deve dire resta detto: nessuno è stato escluso.
        expect(riepilogo.textContent).toContain('Nessuno è stato escluso')
    })
})

describe('AvvisoDetailsContent — le due «attese» restano due cose diverse', () => {
    beforeEach(() => reteFinta())

    it('il filtro «Senza risposta» mostra chi non ha risposto, NON chi è in coda', async () => {
        await apriAdesioni()
        filtraRisposta('attesa')

        expect(screen.getByText('TEST SenzaRisposta')).toBeInTheDocument()
        expect(screen.queryByText('TEST InCoda2')).not.toBeInTheDocument()

        // Il chip della riga dice la parola giusta…
        expect(rigaDi('SenzaRisposta').textContent).toContain('Senza risposta')
        // …e da nessuna parte compare la vecchia dicitura ambigua «Nessuna
        // Risposta (In attesa)», che è precisamente la confusione da evitare.
        // ⚠️ IN CHIARO e non `itAvvisi.<chiave>`: quella chiave non esiste più in
        // nessuna delle due lingue — smettere di usarla non bastava, restava
        // pronta per chi sarebbe venuto dopo. Se qualcuno la riscrivesse, questa
        // riga tornerebbe rossa lo stesso.
        expect(document.body.textContent).not.toContain('Nessuna Risposta (In attesa)')
    })

    it('il filtro «In lista d’attesa» mostra chi aspetta un posto, NON chi non ha risposto', async () => {
        await apriAdesioni()
        filtraRisposta('lista_attesa')

        expect(screen.getByText('TEST InCoda2')).toBeInTheDocument()
        expect(screen.queryByText('TEST SenzaRisposta')).not.toBeInTheDocument()

        // Il chip porta LA PAROLA SCRITTA, non il solo colore: due gialli accanto
        // non distinguono niente, e per chi non distingue i colori nemmeno.
        expect(rigaDi('InCoda2').textContent).toContain(itAvvisi.badgeInAttesa)
    })

    it('le due voci del filtro esistono entrambe e non dicono la stessa cosa', async () => {
        await apriAdesioni()
        const tendina = screen.getByLabelText(itAvvisi.risposta) as HTMLSelectElement
        const voci = [...tendina.options].map((o) => o.textContent)
        expect(voci).toContain('Senza risposta')
        expect(voci).toContain('In lista d’attesa')
    })
})

describe('AvvisoDetailsContent — i tre gesti mandano tre corpi diversi', () => {
    beforeEach(() => reteFinta())

    it('«Correggi il numero» manda `numero_partecipanti`, e nient\'altro', async () => {
        await apriAdesioni({ permessiScrittura: true })
        fireEvent.click(
            within(rigaDi('Ammesso3')).getByRole('button', { name: /Correggi il numero di persone/ }),
        )
        const dialogo = await screen.findByRole('dialog')
        fireEvent.click(within(dialogo).getByRole('button', { name: itAvvisi.partecipantiAumenta }))
        fireEvent.click(within(dialogo).getByRole('button', { name: itAvvisi.correggiSalva }))

        await waitFor(() => expect(ultimaPatch?.corpo).toEqual({ numero_partecipanti: 4 }))
        // L'id nell'indirizzo è quello della RIGA DI RISPOSTA, non dell'alunno: il
        // server rifiuta (404) una risposta che non appartiene a quell'avviso.
        expect(ultimaPatch?.url).toContain(`/api/avvisi/${AVVISO_ID}/risposte/${R.ammessoTre}`)
    })

    it('«Ammetti» manda `stato: ammessa`', async () => {
        await apriAdesioni({ permessiScrittura: true })
        fireEvent.click(within(rigaDi('InCoda2')).getByRole('button', { name: /^Ammetti/ }))
        const dialogo = await screen.findByRole('dialog')
        fireEvent.click(within(dialogo).getByRole('button', { name: itAvvisi.ammettiDallaAttesa }))

        await waitFor(() => expect(ultimaPatch?.corpo).toEqual({ stato: 'ammessa' }))
    })

    it('«Togli» manda `stato: nessuna`, e solo DOPO una conferma', async () => {
        await apriAdesioni({ permessiScrittura: true })
        fireEvent.click(
            within(rigaDi('Ammesso3')).getByRole('button', { name: /Correggi il numero di persone/ }),
        )
        const dialogo = await screen.findByRole('dialog')

        fireEvent.click(within(dialogo).getByRole('button', { name: itAvvisi.ritiraAdesione }))
        // La conferma c'è: togliere un'adesione non si fa per sbaglio mentre si
        // correggeva un numero. E fino a qui NON è partito niente.
        expect(within(dialogo).getByText(itAvvisi.ritiraConfermaSegreteria)).toBeInTheDocument()
        // ⚠️ E NON è la conferma del genitore: qui a premere è la segreteria, che
        // sta togliendo l'adesione di un altro — col nome di quell'alunno due righe
        // più su. «la tua adesione» è la frase della card di famiglia.
        expect(dialogo.textContent).not.toContain('la tua adesione')
        expect(dialogo.textContent).toContain('TEST Ammesso3')
        expect(ultimaPatch).toBeNull()

        fireEvent.click(within(dialogo).getByRole('button', { name: itAvvisi.ritiraSi }))
        await waitFor(() => expect(ultimaPatch?.corpo).toEqual({ stato: 'nessuna' }))
    })
})

describe('AvvisoDetailsContent — `RISPOSTA_CONTRARIA` è una domanda, non un errore', () => {
    it('chiede conferma, e solo dopo rimanda la richiesta con `ignora_rifiuto`', async () => {
        // Primo giro: il server si ferma e restituisce il codice. Non è un guasto:
        // è il rifiuto di sovrascrivere il «no» di una famiglia senza che qualcuno
        // lo abbia deciso.
        reteFinta({
            status: 409,
            corpo: { error: 'Questa famiglia aveva risposto NO.', codice: 'RISPOSTA_CONTRARIA', risposta_precedente: 'no' },
        })
        await apriAdesioni({ permessiScrittura: true })
        filtraRisposta('no')

        fireEvent.click(within(rigaDi('HaDettoNo')).getByRole('button', { name: /^Ammetti/ }))
        const dialogo = await screen.findByRole('dialog')

        // 🔴 LA CONFERMA NON PROMETTE CIÒ CHE IL PRIMO CLIC NON PUÒ MANTENERE.
        // Questa riga aveva risposto NO: il server risponde 409 e non scrive
        // niente, apposta. Fino al 2026-09-19 qui si leggeva «Il posto verrà
        // assegnato … e la famiglia riceverà una notifica», e questo stesso test
        // ASSERIVA quella promessa falsa.
        expect(dialogo.textContent).toContain(itAvvisi.ammettiRispostaNoCorpo)
        expect(dialogo.textContent).not.toContain('riceverà una notifica')
        expect(dialogo.textContent).not.toContain('verrà assegnato')
        // E nemmeno il titolo parla di una coda in cui questa famiglia non è mai stata.
        expect(dialogo.textContent).toContain(itAvvisi.ammettiRispostaNoTitolo)
        expect(dialogo.textContent).not.toContain(itAvvisi.ammettiConfermaTitolo)

        fireEvent.click(within(dialogo).getByRole('button', { name: itAvvisi.ammettiDallaAttesa }))

        // LA DOMANDA: il testo di catalogo, che è scritto per essere una domanda.
        await waitFor(() =>
            expect(within(dialogo).getByText(itShared.erroreRispostaContraria)).toBeInTheDocument(),
        )
        // E NON un errore: niente `role="alert"` addosso a quel testo.
        expect(within(dialogo).queryByRole('alert')).not.toBeInTheDocument()

        // La prima chiamata NON portava `ignora_rifiuto`: la domanda nasce proprio
        // perché nessuno aveva ancora risposto.
        expect(ultimaPatch?.corpo).toEqual({ stato: 'ammessa' })

        // Solo la conferma rimanda, e stavolta con la spunta.
        fireEvent.click(within(dialogo).getByRole('button', { name: itAvvisi.ammettiDallaAttesa }))
        await waitFor(() => expect(ultimaPatch?.corpo).toEqual({ stato: 'ammessa', ignora_rifiuto: true }))
    })

    it('un rifiuto VERO resta un errore, con `role="alert"` (controllo opposto)', async () => {
        // Senza questa prova, «non c'è role=alert» sopra sarebbe verde anche su un
        // componente che non segnala più nessun errore.
        reteFinta({
            status: 409,
            corpo: { error: 'Non ci sono abbastanza posti liberi.', codice: 'POSTI_ESAURITI', occupati: 9, posti_totali: 10, richiesti: 2 },
        })
        await apriAdesioni({ permessiScrittura: true })

        fireEvent.click(within(rigaDi('InCoda2')).getByRole('button', { name: /^Ammetti/ }))
        const dialogo = await screen.findByRole('dialog')
        fireEvent.click(within(dialogo).getByRole('button', { name: itAvvisi.ammettiDallaAttesa }))

        const errore = await within(dialogo).findByRole('alert')
        expect(errore.textContent).toContain(itShared.errorePostiEsauriti)
        // I numeri MISURATI si mostrano: sono quelli con cui la segreteria decide
        // quante telefonate fare.
        expect(errore.textContent).toContain('9 persone')
        expect(errore.textContent).toContain('su 10 posti')
        // E c'è un PASSO SUCCESSIVO. Senza, ci si sbatte contro il rifiuto e basta:
        // «forza» non si espone di proposito, quindi la strada va detta a parole.
        expect(errore.textContent).toContain(itAvvisi.postiEsauritiViaUscita)
    })

    it('dalla CODA, invece, la conferma promette il posto — perché quel clic lo mantiene', async () => {
        // Controllo opposto del riquadro «RISPOSTA_CONTRARIA»: se la promessa
        // sparisse da TUTTE e due le strade, l'asserzione negativa lassù resterebbe
        // verde su un dialogo che non dice più niente a nessuno.
        reteFinta()
        await apriAdesioni({ permessiScrittura: true })

        fireEvent.click(within(rigaDi('InCoda2')).getByRole('button', { name: /^Ammetti/ }))
        const dialogo = await screen.findByRole('dialog')
        expect(dialogo.textContent).toContain(itAvvisi.ammettiConfermaTitolo)
        expect(dialogo.textContent).toContain('riceverà una notifica')
    })

    it('il dialogo è annunciato UNA volta sola, e il nome è il titolo che si vede', async () => {
        // `aria-label` + un `h2` con lo stesso testo = due annunci. La primitiva
        // accetta `labelledBy` proprio per questo: il nome accessibile diventa il
        // titolo visibile, e resta uno solo.
        reteFinta()
        await apriAdesioni({ permessiScrittura: true })
        fireEvent.click(
            within(rigaDi('Ammesso3')).getByRole('button', { name: /Correggi il numero di persone/ }),
        )
        const dialogo = await screen.findByRole('dialog')

        expect(dialogo.getAttribute('aria-label')).toBeNull()
        const etichetta = dialogo.getAttribute('aria-labelledby')
        expect(etichetta, 'il dialogo deve prendere il nome dal proprio titolo').toBeTruthy()
        const titolo = document.getElementById(String(etichetta))
        expect(titolo?.textContent).toBe(itAvvisi.correggiModaleTitolo)
        // Il nome accessibile resta quello, e uno solo.
        expect(dialogo).toHaveAccessibleName(itAvvisi.correggiModaleTitolo)
    })
})

describe('AvvisoDetailsContent — `occupati: null` vuol dire «non misurato», mai zero', () => {
    it('un rifiuto senza numeri misurati non stampa «0 persone»', async () => {
        reteFinta({
            status: 409,
            corpo: { error: 'Non ci sono abbastanza posti liberi.', codice: 'POSTI_ESAURITI', occupati: null, posti_totali: null, richiesti: null },
        })
        await apriAdesioni({ permessiScrittura: true })

        fireEvent.click(within(rigaDi('InCoda2')).getByRole('button', { name: /^Ammetti/ }))
        const dialogo = await screen.findByRole('dialog')
        fireEvent.click(within(dialogo).getByRole('button', { name: itAvvisi.ammettiDallaAttesa }))

        const errore = await within(dialogo).findByRole('alert')
        // Positiva: il messaggio c'è (senza, la negativa sotto non varrebbe nulla).
        expect(errore.textContent).toContain(itShared.errorePostiEsauriti)
        // Negativa: nessuno zero inventato al posto di «non l'ho contato».
        expect(errore.textContent).not.toContain('0 person')
        expect(errore.textContent).not.toMatch(/su 0 post/)
    })

    it('dopo un gesto riuscito con `occupati: null` il riepilogo resta quello delle righe', async () => {
        reteFinta({ status: 200, corpo: { stato: null, numero: null, occupati: null, posti_totali: null, sopra_capienza: false } })
        await apriAdesioni({ permessiScrittura: true })

        fireEvent.click(within(rigaDi('InCoda2')).getByRole('button', { name: /^Ammetti/ }))
        const dialogo = await screen.findByRole('dialog')
        fireEvent.click(within(dialogo).getByRole('button', { name: itAvvisi.ammettiDallaAttesa }))

        // ⚠️ SI ASPETTA UNA PRESENZA, NON UN'ASSENZA. Fino al 2026-09-19 qui c'era
        // `waitFor(… queryByRole('dialog') …not.toBeInTheDocument())`: «il dialogo
        // non c'è» è vero anche PRIMA che il gesto parta, e infatti quella riga è
        // stata vista cadere una volta su dieci. Ciò che segna il punto d'arrivo è
        // la RILETTURA dell'elenco: la prima è quella del montaggio, la seconda
        // arriva solo da `onFatto`.
        await waitFor(() => expect(letturaRisposte()).toBe(2))
        // …e solo a quel punto il dialogo è chiuso (stessa gestione del click).
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(riepilogoPosti()).toHaveTextContent('7 persone')
        expect(riepilogoPosti().textContent).not.toContain('0 persone')
    })
})

describe('AvvisoDetailsContent — l\'esportazione dice che cosa contiene il file', () => {
    beforeEach(() => reteFinta())

    it('l\'avvertenza sui nomi si legge PRIMA di premere, non dopo', async () => {
        await apriAdesioni({ permessiScrittura: true })
        expect(screen.getByText(itAvvisi.esportaAvvertenza)).toBeInTheDocument()
    })

    it('senza righe non si chiama il server: lo dice e basta', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn((url: unknown) => {
                const u = String(url)
                if (u.includes('/risposte')) return Promise.resolve({ ok: true, status: 200, json: async () => [] } as unknown as Response)
                if (u.includes('/api/diary/students')) return Promise.resolve({ ok: true, status: 200, json: async () => ALUNNI } as unknown as Response)
                return Promise.resolve({ ok: true, status: 200, json: async () => [] } as unknown as Response)
            }),
        )
        await apriAdesioni({ permessiScrittura: true })

        fireEvent.click(screen.getByRole('button', { name: itAvvisi.esportaElenco }))
        await waitFor(() => expect(screen.getByText(itAvvisi.esportaVuoto)).toBeInTheDocument())
        // La chiamata di esportazione non è mai partita.
        const chiamate = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
        expect(chiamate.some((c) => String(c[0]).includes('/esporta'))).toBe(false)
    })
})

describe('Accessibilità — l\'elenco delle adesioni e il drawer a max-w-md', () => {
    beforeEach(() => reteFinta())

    it('nessuna violazione axe sull\'elenco con i comandi della segreteria', async () => {
        const { container } = await apriAdesioni({ permessiScrittura: true })
        await waitFor(() => expect(screen.getByText('TEST Ammesso3')).toBeInTheDocument())
        expect(await axe(container)).toHaveNoViolations()
    })

    it('nessuna violazione axe nel drawer del docente (448 px), che resta in sola lettura', async () => {
        const { container } = render(
            <AvvisoDetailsDrawer open avviso={avviso()} onClose={() => {}} availableClasses={[CLASSE]} />,
        )
        await waitFor(() => expect(screen.getByText(itAvvisi.tabAdesioni)).toBeInTheDocument())
        fireEvent.click(screen.getByText(itAvvisi.tabAdesioni))
        await waitFor(() => expect(screen.getByText('TEST Ammesso3')).toBeInTheDocument())

        // Il guscio è davvero quello stretto (positiva: senza, l'axe qui sotto
        // misurerebbe una schermata che nel prodotto non esiste).
        expect(container.querySelector('.max-w-md')).not.toBeNull()
        // E il docente non ha nessun comando di scrittura: il drawer non passa la prop.
        expect(screen.queryByRole('button', { name: /Correggi il numero di persone/i })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: itAvvisi.esportaElenco })).not.toBeInTheDocument()

        expect(await axe(container)).toHaveNoViolations()
    })
})
