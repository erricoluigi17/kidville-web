import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itSettings from '../../messages/it/adminSettings.json'
import { SEDE_A } from '../fixtures/sedi'
import { CEDENTE_COOPERATIVA, LUNGHEZZE_CEDENTE } from '@/lib/fatturazione/cedente'

// =============================================================================
// L'ANAGRAFICA DEL CEDENTE SI RACCOGLIE IN CAMPI SEPARATI — dal pannello in giù.
//
// Il difetto nasceva QUI: il pannello Aruba chiedeva la sede legale come UNA
// stringa libera («Via Silvio Pellico 7, 81030 Cesa (CE)») mentre il generatore
// dell'XML leggeva `cap` e `comune` come campi separati, che quel pannello non
// scriveva. L'operatore compilava, il campo si salvava, e la fattura usciva con
// `<CAP></CAP><Comune></Comune>`: scarto SDI, con l'interfaccia che diceva che
// era tutto a posto.
//
// Questi casi tengono ferme le tre cose che lo impediscono: i campi separati
// esistono, il pannello Aruba non li raccoglie più, e una configurazione che lo
// SDI rifiuterebbe non parte nemmeno dal browser.
// =============================================================================

const USER = 'aaaabbbb-1111-4111-8111-dddddddddddd'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))

import { SettingsPanel } from '@/components/features/admin/settings/SettingsPanel'

/** Cosa risponde il GET delle impostazioni: `fiscale_config` come sta in produzione. */
let fiscaleSalvata: Record<string, unknown> = {}
/** Cosa risponde il server al salvataggio (per il caso «respinto»). */
let rispostaPatch: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { success: true, data: {} } }
const fetchMock = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    fiscaleSalvata = {}
    rispostaPatch = { ok: true, status: 200, body: { success: true, data: {} } }
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url)
        if (init?.method === 'PATCH') {
            return Promise.resolve({ ok: rispostaPatch.ok, status: rispostaPatch.status, json: async () => rispostaPatch.body })
        }
        if (u.includes('/api/admin/settings/aruba')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({
                    success: true,
                    data: { username: 'utente-aruba', password_ref: '', has_password: false, abilitato: false, ambiente: 'sandbox', fiscal: { sede: 'Via Silvio Pellico 7, 81030 Cesa (CE)' }, iva: [] },
                }),
            })
        }
        if (u.includes('/api/admin/settings/categorie')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
        }
        return Promise.resolve({
            ok: true, status: 200,
            json: async () => ({
                success: true,
                data: {
                    retta_default_importo: 180, retta_giorno_scadenza: 5, retta_giorno_visibilita: 25,
                    retta_auto_enabled: true, insoluto_tolleranza_giorni: 10, ticket_pacchetti: [],
                    fattura_causale_template: '{descrizione} - {alunno}',
                    solleciti_config: {}, fiscale_config: fiscaleSalvata,
                },
            }),
        })
    })
    vi.stubGlobal('fetch', fetchMock)
})

/** Il pannello dei dati fiscali, individuato da un campo che esiste solo lì. */
async function pannelloFiscale(): Promise<HTMLElement> {
    const cap = await screen.findByLabelText(itSettings.spFiscaleCap)
    const sezione = cap.closest('section')
    expect(sezione).not.toBeNull()
    return sezione as HTMLElement
}

/** L'ultimo corpo inviato in PATCH a `/api/admin/settings`. */
function ultimoPatchImpostazioni(): Record<string, unknown> | null {
    const chiamate = fetchMock.mock.calls.filter(
        ([u, init]) => String(u).includes('/api/admin/settings') && !String(u).includes('/aruba') && init?.method === 'PATCH',
    )
    const ultima = chiamate[chiamate.length - 1]
    return ultima ? JSON.parse(String(ultima[1].body)) : null
}

describe('Impostazioni → Dati fiscali: la sede legale è in campi separati', () => {
    it('i campi che il tracciato pretende esistono uno per uno', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        for (const etichetta of [
            itSettings.spFiscaleDenominazione, itSettings.spFiscalePiva, itSettings.spFiscaleCf,
            itSettings.spFiscaleRegime, itSettings.spFiscaleIndirizzo, itSettings.spFiscaleNumeroCivico,
            itSettings.spFiscaleCap, itSettings.spFiscaleComune, itSettings.spFiscaleProvincia,
            // L'email finisce in `<Contatti><Email>` del cedente: c'è su tutte le
            // fatture scritte a mano (misurato il 2026-08-10 sui tracciati veri) e
            // finché questo campo non è esistito nessuna fattura del software poteva
            // averla — il pannello è l'unico posto da cui la si può configurare.
            itSettings.spFiscaleEmail,
        ]) {
            expect(within(sezione).getByLabelText(etichetta)).toBeInTheDocument()
        }
    })

    it('l\'email della scuola si precompila con quella delle fatture già emesse', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        expect((within(sezione).getByLabelText(itSettings.spFiscaleEmail) as HTMLInputElement).value)
            .toBe(CEDENTE_COOPERATIVA.email)
    })

    it('anagrafica mai compilata: si precompila con i dati della cooperativa e si DICE che non è salvata', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        expect((within(sezione).getByLabelText(itSettings.spFiscaleCap) as HTMLInputElement).value).toBe(CEDENTE_COOPERATIVA.cap)
        expect((within(sezione).getByLabelText(itSettings.spFiscaleComune) as HTMLInputElement).value).toBe(CEDENTE_COOPERATIVA.comune)
        expect((within(sezione).getByLabelText(itSettings.spFiscaleProvincia) as HTMLInputElement).value).toBe(CEDENTE_COOPERATIVA.provincia)
        expect((within(sezione).getByLabelText(itSettings.spFiscaleNumeroCivico) as HTMLInputElement).value).toBe(CEDENTE_COOPERATIVA.numero_civico)
        // Precompilare non è configurare: finché non si salva, in `admin_settings`
        // non c'è niente e la fattura non parte. Il pannello lo scrive.
        expect(within(sezione).getByText(itSettings.spFiscalePrecompilato)).toBeInTheDocument()
    })

    it('un\'anagrafica già salvata NON viene sovrascritta dal precompilato', async () => {
        fiscaleSalvata = {
            denominazione: 'ALTRA COOPERATIVA', piva: '11111111111',
            indirizzo: 'Via Altra', numero_civico: '9', cap: '80100', comune: 'Napoli', provincia: 'NA',
        }
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        expect((within(sezione).getByLabelText(itSettings.spFiscaleCap) as HTMLInputElement).value).toBe('80100')
        expect(within(sezione).queryByText(itSettings.spFiscalePrecompilato)).not.toBeInTheDocument()
    })

    it('salvando, CAP e Comune partono davvero verso `fiscale_config` — con la sede dichiarata', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        fireEvent.click(within(sezione).getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))

        await waitFor(() => expect(ultimoPatchImpostazioni()).not.toBeNull())
        const body = ultimoPatchImpostazioni() as Record<string, unknown>
        const fiscale = body.fiscale_config as Record<string, unknown>
        expect(fiscale.cap).toBe(CEDENTE_COOPERATIVA.cap)
        expect(fiscale.comune).toBe(CEDENTE_COOPERATIVA.comune)
        expect(fiscale.provincia).toBe(CEDENTE_COOPERATIVA.provincia)
        expect(fiscale.numero_civico).toBe(CEDENTE_COOPERATIVA.numero_civico)
        expect(fiscale.regime_fiscale).toBe(CEDENTE_COOPERATIVA.regime_fiscale)
        // Tre sedi in produzione: una scrittura che non dichiara la sua sede
        // archivia nel plesso sbagliato in silenzio (AGENTS.md).
        expect(body.scuola_id).toBe(SEDE_A)
    })

    it('salvataggio respinto dal server: l\'avviso «non è ancora salvato» RESTA', async () => {
        // Se sparisse, il pannello direbbe «configurato» dopo un 403 di sede: è la
        // stessa cecità del difetto, spostata di un passo.
        rispostaPatch = { ok: false, status: 403, body: { error: 'Impostazioni di un altro plesso' } }
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        fireEvent.click(within(sezione).getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))

        await waitFor(() => expect(within(sezione).getByText(/Impostazioni di un altro plesso/)).toBeInTheDocument())
        expect(within(sezione).getByText(itSettings.spFiscalePrecompilato)).toBeInTheDocument()
    })

    it('un CAP di 4 cifre non parte: nessun salvataggio, e si vede quale campo è', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        fireEvent.change(within(sezione).getByLabelText(itSettings.spFiscaleCap), { target: { value: '8103' } })
        fireEvent.click(within(sezione).getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))

        await waitFor(() => expect(within(sezione).getByText(itSettings.spFiscaleCorreggi)).toBeInTheDocument())
        expect(within(sezione).getByText(itSettings.spFiscaleErrCap)).toBeInTheDocument()
        expect(ultimoPatchImpostazioni()).toBeNull()
    })

    // ─────────────────────────────────────────────────────────────────────────
    // IL CAMPO INVITAVA A SCRIVERE DIECI CARATTERI SU UN ELEMENTO DI OTTO.
    //
    // `maxLength: 10` sul numero civico, mentre `<NumeroCivico>` è di 8
    // (`LIMITI.numeroCivico`, `NumeroCivicoType` dello XSD) e il generatore
    // chiude con `.slice(0, max)`: `27/B int.3` usciva nell'XML come `27/B int`,
    // senza un errore, senza un log e senza nessun controllo che lo dicesse.
    // ─────────────────────────────────────────────────────────────────────────
    it('il numero civico non invita più a superare il limite del tracciato', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        const civico = within(sezione).getByLabelText(itSettings.spFiscaleNumeroCivico) as HTMLInputElement
        expect(civico.maxLength).toBe(LUNGHEZZE_CEDENTE.numero_civico)
        expect(civico.maxLength).toBe(8)
    })

    it('un civico troppo lungo che arriva dal database si VEDE, invece di essere tagliato', async () => {
        // Il `maxLength` ferma chi digita; questo valore arriva già salvato, ed è
        // il caso in cui prima il taglio avveniva in silenzio dentro l'XML.
        fiscaleSalvata = { ...CEDENTE_COOPERATIVA, numero_civico: '27/B int.3' }
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        fireEvent.click(within(sezione).getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))

        await waitFor(() => expect(within(sezione).getByText(itSettings.spFiscaleCorreggi)).toBeInTheDocument())
        expect(within(sezione).getByLabelText(itSettings.spFiscaleNumeroCivico)).toHaveAttribute('aria-invalid', 'true')
        // ⚠️ IL MESSAGGIO DICE IL NUMERO, E ORA LO SI PUÒ PROVARE. Questo blocco
        // diceva: «in questo banco `t` non interpola, quindi a schermo resta il
        // segnaposto», e si accontentava di verificare che la CHIAVE contenesse
        // `{max, plural,`. Era vero del banco, non del prodotto — e lasciava
        // scoperto proprio ciò che serve a chi legge l'errore: senza il numero,
        // si accorcia a caso.
        expect(itSettings.spFiscaleErrTroppoLungo).toContain('{max, plural,')
        expect(
          within(sezione).getByText(/^Massimo \d+ caratteri?: il tracciato della fattura taglia il resto\.$/),
        ).toBeInTheDocument()
        expect(ultimoPatchImpostazioni()).toBeNull()
    })

    it('una P.IVA con il carattere di controllo sbagliato non parte', async () => {
        // `03394870615` è la P.IVA vera con l'ultima cifra storta: undici cifre,
        // XSD superato, numero del sezionale allocato e scarto SDI giorni dopo.
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        fireEvent.change(within(sezione).getByLabelText(itSettings.spFiscalePiva), { target: { value: '03394870615' } })
        fireEvent.click(within(sezione).getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))

        await waitFor(() => expect(within(sezione).getByText(itSettings.spFiscaleCorreggi)).toBeInTheDocument())
        expect(within(sezione).getByText(itSettings.spFiscaleErrPiva)).toBeInTheDocument()
        expect(ultimoPatchImpostazioni()).toBeNull()
    })

    it('svuotare il Comune segnala il campo obbligatorio e blocca il salvataggio', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        fireEvent.change(within(sezione).getByLabelText(itSettings.spFiscaleComune), { target: { value: '' } })
        fireEvent.click(within(sezione).getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))

        await waitFor(() => expect(within(sezione).getByText(itSettings.spFiscaleCorreggi)).toBeInTheDocument())
        expect(ultimoPatchImpostazioni()).toBeNull()
        expect(within(sezione).getByLabelText(itSettings.spFiscaleComune)).toHaveAttribute('aria-invalid', 'true')
    })
})

describe('Impostazioni → il bollo si comanda dall\'interfaccia, e nasce spento', () => {
    it('spento per default: nessun campo del bollo a schermo', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        const interruttore = within(sezione).getByLabelText(itSettings.spBolloAttiva) as HTMLInputElement
        expect(interruttore.checked).toBe(false)
        expect(within(sezione).queryByLabelText(itSettings.spBolloSoglia)).not.toBeInTheDocument()
    })

    it('acceso: soglia 77,47 · importo 2 € · dicitura — e NIENTE altro', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        fireEvent.click(within(sezione).getByLabelText(itSettings.spBolloAttiva))

        expect((within(sezione).getByLabelText(itSettings.spBolloSoglia) as HTMLInputElement).value).toBe('77.47')
        expect((within(sezione).getByLabelText(itSettings.spBolloImporto) as HTMLInputElement).value).toBe('2')
        expect(within(sezione).getByLabelText(itSettings.spBolloDicitura)).toBeInTheDocument()

        // A bollo acceso l'UNICA casella del riquadro resta quella che l'ha acceso:
        // il riquadro non offre altri interruttori.
        const caselle = within(sezione).getAllByRole('checkbox')
        expect(caselle).toHaveLength(1)
        expect(caselle[0]).toBe(within(sezione).getByLabelText(itSettings.spBolloAttiva))

        fireEvent.click(within(sezione).getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))
        await waitFor(() => expect(ultimoPatchImpostazioni()).not.toBeNull())
        const fiscale = (ultimoPatchImpostazioni() as Record<string, unknown>).fiscale_config as Record<string, unknown>
        expect(fiscale.bollo_enabled).toBe(true)
        // La chiave del riaddebito non parte più verso il database, perché nessuno
        // la legge: vedi il caso qui sotto.
        expect(fiscale).not.toHaveProperty('bollo_riaddebito')
    })

    // ─────────────────────────────────────────────────────────────────────────
    // IL COMANDO CHE PROMETTEVA UN TOTALE DIVERSO E NON LO PRODUCEVA.
    //
    // La casella «Riaddebita il bollo al cliente» diceva, testualmente: «il bollo
    // è una riga in più in fattura e il totale cresce di 2 €». Non succedeva
    // niente di tutto ciò — `bolloRiaddebitato()` non aveva chiamanti, l'XML
    // usciva con una riga sola e `<ImportoTotaleDocumento>` pari all'imponibile —
    // e il test che stava qui certificava solo che l'impostazione «si salva».
    // Casella e chiavi i18n sono state tolte: qui si misura che non tornino.
    // ─────────────────────────────────────────────────────────────────────────
    it('la casella «riaddebita il bollo» non c\'è più, e nemmeno le sue chiavi i18n', async () => {
        const catalogo = itSettings as Record<string, string>
        expect(catalogo).not.toHaveProperty('spBolloRiaddebito')
        expect(catalogo).not.toHaveProperty('spBolloRiaddebitoHint')

        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const sezione = await pannelloFiscale()
        fireEvent.click(within(sezione).getByLabelText(itSettings.spBolloAttiva))
        // Nessun testo a schermo promette un totale diverso, sotto nessun nome.
        expect(within(sezione).queryByText(/riaddebit/i)).not.toBeInTheDocument()
        expect(within(sezione).queryByText(/il totale cresce/i)).not.toBeInTheDocument()
    })
})

describe('Impostazioni → Aruba: credenziali e ambiente, non anagrafica', () => {
    it('la sede legale come stringa libera non si può più scrivere da nessuna parte', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        await pannelloFiscale()
        // Il campo unico è sparito insieme alla sua chiave i18n: qui si misura che
        // non sia tornato sotto un altro nome.
        expect(screen.queryByLabelText(/sede legale/i)).not.toBeInTheDocument()
        expect(screen.queryByDisplayValue('Via Silvio Pellico 7, 81030 Cesa (CE)')).not.toBeInTheDocument()
        // E l'anagrafica non è nemmeno duplicata: un solo campo «Partita IVA» in pagina.
        expect(screen.getAllByLabelText(itSettings.spFiscalePiva)).toHaveLength(1)
    })

    it('il pannello Aruba tiene credenziali e ambiente, e rimanda ai dati fiscali', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const username = await screen.findByLabelText(itSettings.spArubaUsername)
        const sezione = username.closest('section') as HTMLElement
        expect(within(sezione).getByLabelText(itSettings.spArubaAmbiente)).toHaveValue('sandbox')
        expect(within(sezione).getByText(itSettings.spArubaRimandoDatiFiscali)).toBeInTheDocument()
    })

    it('salvando Aruba non si tocca `fiscal`: ciò che una sede aveva configurato resta a fare da ripiego', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const username = await screen.findByLabelText(itSettings.spArubaUsername)
        const sezione = username.closest('section') as HTMLElement
        fireEvent.click(within(sezione).getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))

        await waitFor(() => expect(
            fetchMock.mock.calls.some(([u, init]) => String(u).includes('/api/admin/settings/aruba') && init?.method === 'PATCH'),
        ).toBe(true))
        const chiamata = fetchMock.mock.calls.find(([u, init]) => String(u).includes('/api/admin/settings/aruba') && init?.method === 'PATCH')
        const body = JSON.parse(String(chiamata?.[1].body)) as Record<string, unknown>
        expect(body).not.toHaveProperty('fiscal')
        expect(body.scuola_id).toBe(SEDE_A)
        expect(body.ambiente).toBe('sandbox')
    })
})
