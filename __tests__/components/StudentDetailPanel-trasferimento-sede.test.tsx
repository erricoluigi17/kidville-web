import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  T6-A · SPOSTARE UN BAMBINO DI SEDE, DA UNO SCHERMO                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Il backend sa spostare un bambino da un plesso all'altro dal 2026-09-04
 * (`PATCH /api/admin/students` con `{ id, scuola_id }`). Fino a questo lavoro
 * **non esisteva nessun punto sullo schermo da cui farlo**: l'unica strada era
 * una `UPDATE` a mano sul database che contiene le anagrafiche di oltre
 * seicento minori. Un potere che esiste solo in SQL è un potere che si esercita
 * senza log applicativo, senza validazione della destinazione e senza che
 * nessuno azzeri la classe del plesso lasciato.
 *
 * Le sei cose che questo file sorveglia, e perché ognuna è qui:
 *
 *  1. L'ELENCO ARRIVA DA `admin/sedi/destinazioni`, non da `admin/sedi`. La
 *     seconda risponde «le sedi in cui LAVORI»: per una direttrice di Giugliano
 *     sarebbero due sedi su tre, e la terza — l'unica che serve davvero, perché
 *     il trasferimento è esattamente il caso in cui la destinazione NON è ancora
 *     fra le tue — non comparirebbe, senza nessun errore da nessuna parte.
 *
 *  2. LA CONFERMA DICE COSA SI PERDE. Classe/sezione e gruppo mensa vengono
 *     AZZERATI dal server (di proposito: una sezione omonima nel plesso nuovo
 *     riaggancerebbe il bambino a una classe scelta da nessuno), e vanno
 *     riassegnati a mano. Chi preme deve saperlo PRIMA, come già accade per
 *     l'archiviazione: il criterio è «l'operatore sa prima che cosa perde».
 *
 *  3. UNA SOLA DESTINAZIONE SI SPIEGA, non si mostra come menù vuoto. Misurato
 *     il 2026-09-03: nessuna segreteria è associata a più di una sede, quindi
 *     per lei l'elenco contiene UNA voce — la sua, cioè il plesso in cui il
 *     bambino già sta. Un menù con dentro solo la sede attuale è un comando che
 *     non può fare niente, ed è il tipo di controllo che si preme tre volte
 *     prima di concludere che l'applicazione è rotta.
 *
 *  4. ⚠️ IL GUASTO DI LETTURA NON È «NON CI SONO SEDI». La rotta distingue i due
 *     casi apposta (`motivo: 'nessuna-destinazione'` contro `500` +
 *     `codice: 'LETTURA_FALLITA'`), e la testata di
 *     `src/lib/sedi/trasferimento.ts` lo dice in una riga: senza quella
 *     distinzione l'interfaccia scrive «nessuna sede disponibile» davanti a un
 *     permesso negato dal database — «una bugia con l'aria di un fatto». Qui si
 *     misura che le due frasi restino DUE.
 *
 *  5. IL CORPO DEL PATCH È MINIMO: `{ id, scuola_id }`. Chi ha scritto la rotta
 *     segnala che il form intero funzionerebbe lo stesso, ma il form intero
 *     rimanda anche `classe_sezione` — cioè il nome della classe del plesso di
 *     PARTENZA — e affidare a un ordine di scritture ciò che si può
 *     semplicemente non mandare è un rischio gratuito.
 *
 *  6. `SEDE_NON_ACCESSIBILE` SI LEGGE IN ITALIANO (e in inglese). Il codice è
 *     già dichiarato in `CODICI_ERRORE`: il rifiuto deve passare dal catalogo,
 *     non essere la prosa che il server scrive per i log.
 */

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => null }))
vi.mock('@/components/features/admin/StudentEconomicSection', () => ({
  StudentEconomicSection: () => null,
}))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

/** Le tre sedi reali, come le restituisce `GET /api/admin/sedi/destinazioni`. */
const TRE_SEDI = [
  { id: SEDE_A, nome: NOME_SEDE_A },
  { id: SEDE_B, nome: NOME_SEDE_B },
  { id: SEDE_C, nome: NOME_SEDE_C },
]

/** Come risponde `admin/sedi/destinazioni` in questo giro di test. */
let destinazioni: { stato: number; corpo: unknown } = {
  stato: 200,
  corpo: { success: true, data: TRE_SEDI, motivo: 'ok' },
}

/** Come risponde `PATCH /api/admin/students` in questo giro di test. */
let esitoPatch: { stato: number; corpo: unknown } = { stato: 200, corpo: { success: true } }

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  destinazioni = { stato: 200, corpo: { success: true, data: TRE_SEDI, motivo: 'ok' } }
  esitoPatch = { stato: 200, corpo: { success: true } }
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname === '/api/admin/sedi/destinazioni') {
      return Promise.resolve({
        ok: destinazioni.stato < 400,
        status: destinazioni.stato,
        json: async () => destinazioni.corpo,
      })
    }
    if (u.pathname === '/api/admin/students' && init?.method === 'PATCH') {
      return Promise.resolve({
        ok: esitoPatch.stato < 400,
        status: esitoPatch.stato,
        json: async () => esitoPatch.corpo,
      })
    }
    if (u.pathname === '/api/admin/sections') return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => cleanup())

import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel'

const ALUNNO = {
  id: 'al-b1',
  nome: 'Bea',
  cognome: 'Bianchi',
  scuola_id: SEDE_B,
  classe_sezione: 'LEONI',
}

function apri(student: Record<string, unknown> = ALUNNO) {
  return render(
    <StudentDetailPanel
      student={student as never}
      onClose={() => {}}
      onSave={vi.fn()}
      onArchive={async () => ({ ok: true })}
      onRiattiva={async () => ({ ok: true })}
    />,
  )
}

/** Il blocco intero: esiste solo se la scheda offre lo spostamento. */
const blocco = () => screen.queryByTestId('trasferimento-sede')
/** La tendina delle destinazioni. `name` stabile: non è un campo del form dell'anagrafica. */
const tendina = () => document.querySelector('select[name="trasferimento_sede"]') as HTMLSelectElement | null
const vociTendina = () => Array.from(tendina()?.options ?? []).map((o) => o.textContent ?? '')
const valoriTendina = () => Array.from(tendina()?.options ?? []).map((o) => o.value)
const comando = () => screen.queryByTestId('trasferimento-sede-comando') as HTMLButtonElement | null
const patchInviati = () =>
  fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/admin/students') && (c[1] as { method?: string })?.method === 'PATCH')
    .map((c) => JSON.parse(String((c[1] as { body?: string }).body)))

describe('StudentDetailPanel — «Sposta di sede»', () => {
  it('le destinazioni arrivano da /api/admin/sedi/destinazioni, e la sede ATTUALE non è fra le scelte', async () => {
    apri()

    await waitFor(() => expect(tendina()).not.toBeNull())
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/api/admin/sedi/destinazioni')

    // Le altre due sedi sì; la propria no: «spostare dove già sei» non è un'operazione.
    expect(vociTendina()).toContain(NOME_SEDE_A)
    expect(vociTendina()).toContain(NOME_SEDE_C)
    expect(valoriTendina()).not.toContain(SEDE_B)
  })

  it('la conferma dice cosa si perde: classe, gruppo mensa, e lo storico che RESTA', async () => {
    apri()
    await waitFor(() => expect(tendina()).not.toBeNull())

    fireEvent.change(tendina() as HTMLSelectElement, { target: { value: SEDE_A } })
    fireEvent.click(comando() as HTMLButtonElement)

    const avviso = await screen.findByTestId('trasferimento-sede-conseguenze')
    expect(avviso.textContent).toMatch(/class/i)
    expect(avviso.textContent).toMatch(/mensa/i)
    // Lo storico NON segue il bambino: la numerazione fiscale è per sede.
    expect(avviso.textContent).toMatch(/fattur|present|storic/i)
    // La sede scelta è NOMINATA nella conferma: confermare alla cieca è il difetto.
    expect(avviso.textContent).toContain(NOME_SEDE_A)
  })

  it('una sola destinazione, ed è quella attuale: lo SPIEGA e non offre un menù vuoto', async () => {
    // È il caso della Segreteria, misurato: nessuna è associata a più di una sede.
    destinazioni = { stato: 200, corpo: { success: true, data: [{ id: SEDE_B, nome: NOME_SEDE_B }], motivo: 'ok' } }
    apri()

    const spiegazione = await screen.findByTestId('trasferimento-sede-spiegazione')
    expect(spiegazione.textContent?.trim().length ?? 0).toBeGreaterThan(20)
    // Nessuna tendina con dentro niente, e nessun comando che non può fare niente.
    expect(tendina()).toBeNull()
    expect(comando()).toBeNull()
  })

  it('⚠️ il GUASTO DI LETTURA non si mostra come «non ci sono sedi»', async () => {
    destinazioni = { stato: 500, corpo: { error: 'boom', codice: 'LETTURA_FALLITA' } }
    apri()

    const guasto = await screen.findByTestId('trasferimento-sede-guasto')
    expect(guasto.textContent?.trim().length ?? 0).toBeGreaterThan(10)

    // E il testo del guasto NON è il testo del divieto: sono due fatti diversi.
    destinazioni = { stato: 200, corpo: { success: true, data: [], motivo: 'nessuna-destinazione' } }
    cleanup()
    apri()
    const divieto = await screen.findByTestId('trasferimento-sede-spiegazione')
    expect(divieto.textContent).not.toBe(guasto.textContent)
    // Il guasto offre di RIPROVARE; il divieto no, perché riprovare non cambierebbe niente.
    expect(screen.queryByTestId('trasferimento-sede-riprova')).toBeNull()
  })

  it('il PATCH parte con {id, scuola_id} e basta — niente form intero', async () => {
    apri()
    await waitFor(() => expect(tendina()).not.toBeNull())

    fireEvent.change(tendina() as HTMLSelectElement, { target: { value: SEDE_C } })
    fireEvent.click(comando() as HTMLButtonElement) // apre la conferma
    fireEvent.click(await screen.findByTestId('trasferimento-sede-conferma'))

    await waitFor(() => expect(patchInviati()).toHaveLength(1))
    expect(patchInviati()[0]).toEqual({ id: 'al-b1', scuola_id: SEDE_C })
  })

  it('SEDE_NON_ACCESSIBILE si legge dal catalogo, non è la prosa del server', async () => {
    esitoPatch = { stato: 403, corpo: { error: 'Sede non accessibile per questa operazione', codice: 'SEDE_NON_ACCESSIBILE' } }
    apri()
    await waitFor(() => expect(tendina()).not.toBeNull())

    fireEvent.change(tendina() as HTMLSelectElement, { target: { value: SEDE_A } })
    fireEvent.click(comando() as HTMLButtonElement)
    fireEvent.click(await screen.findByTestId('trasferimento-sede-conferma'))

    const errore = await screen.findByTestId('trasferimento-sede-errore')
    expect(errore.textContent).toContain('Sede non accessibile')
    expect(errore.getAttribute('role')).toBe('alert')
  })

  it('⚠️ la prosa del database NON arriva a schermo: senza codice si legge la frase del catalogo', async () => {
    // È la lezione già pagata sulla scheda del personale: `{ error: error.message }`
    // è il testo di PostgREST — documentazione interna, italiana per costruzione,
    // e può nominare una colonna. Un ripiego sulla prosa la porterebbe a schermo.
    esitoPatch = { stato: 500, corpo: { error: 'null value in column "scuola_id" violates not-null constraint' } }
    apri()
    await waitFor(() => expect(tendina()).not.toBeNull())

    fireEvent.change(tendina() as HTMLSelectElement, { target: { value: SEDE_A } })
    fireEvent.click(comando() as HTMLButtonElement)
    fireEvent.click(await screen.findByTestId('trasferimento-sede-conferma'))

    const errore = await screen.findByTestId('trasferimento-sede-errore')
    expect(errore.textContent).not.toContain('not-null constraint')
    expect(document.body.textContent).not.toContain('not-null constraint')
    expect(errore.textContent?.trim().length ?? 0).toBeGreaterThan(10)
  })

  it('bambino ARCHIVIATO: nessun comando che finirebbe in 409, ma la ragione scritta', async () => {
    apri({ ...ALUNNO, archiviato_il: '2026-06-30T10:00:00Z' })

    await waitFor(() => expect(blocco()).not.toBeNull())
    expect(comando()).toBeNull()
    expect(tendina()).toBeNull()
    const spiegazione = await screen.findByTestId('trasferimento-sede-spiegazione')
    expect(spiegazione.textContent?.trim().length ?? 0).toBeGreaterThan(20)
  })
})

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  T6-A/bis · «NESSUNA SEDE IN ARCHIVIO» È UN FATTO, NON UN RIPIEGO       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * La riga «Sede attuale» ripiegava su «Nessuna sede in archivio» ogni volta che
 * il NOME non si risolveva — e il nome non si risolve in quattro stati che con
 * l'archivio non c'entrano niente:
 *
 *  1. bambino ARCHIVIATO con `scuola_id` valorizzato: la scheda spegneva la
 *     lettura dell'elenco (`abilitato: archiviato_il == null`), quindi l'elenco
 *     restava vuoto **per sempre** e la frase restava lì per sempre;
 *  2. durante il CARICAMENTO dell'elenco: un lampeggio che afferma un fatto;
 *  3. su GUASTO di lettura: la frase compariva ACCANTO a «non siamo riusciti a
 *     leggere l'elenco delle sedi» — due righe che si contraddicono;
 *  4. sede fuori dalle destinazioni di chi guarda: il nome non si risolve, ma
 *     l'archivio la sede ce l'ha.
 *
 * È «una bugia con l'aria di un fatto», la stessa che la testata di
 * `src/lib/sedi/trasferimento.ts` esiste per non far dire sull'elenco vuoto. Il
 * pannello del GENITORE, nella stessa consegna, l'aveva già risolta bene:
 * `parentSedeFiglioSconosciuta` = «Sede non risolta».
 *
 * Qui si misura la distinzione: `scuola_id` assente ⇒ il fatto; `scuola_id`
 * presente e nome irrisolto ⇒ si dice che non si è risolto, non che manca.
 */
describe('StudentDetailPanel — la riga «Sede attuale» non inventa fatti sull\'archivio', () => {
    /**
     * Il testo della riga «Sede attuale», ancorato a QUALCOSA DI UNIVOCO: la
     * riga dentro la sezione dello spostamento che comincia con l'etichetta, e
     * si pretende che ce ne sia esattamente UNA (`getByText` pesca i sosia:
     * «Sede attuale» è due parole che possono ricomparire altrove domani).
     */
    const sedeAttuale = () => {
        const sezione = screen.getByTestId('trasferimento-sede')
        const righe = Array.from(sezione.querySelectorAll('p')).filter((el) =>
            (el.textContent ?? '').trim().startsWith('Sede attuale'),
        )
        expect(righe, 'la riga «Sede attuale» è una e una sola').toHaveLength(1)
        return (righe[0].textContent ?? '').replace(/^Sede attuale:\s*/, '').trim()
    }

    it('CONTROLLO POSITIVO: senza `scuola_id` la frase è VERA e resta', async () => {
        apri({ ...ALUNNO, scuola_id: null })
        await waitFor(() => expect(blocco()).not.toBeNull())
        await waitFor(() => expect(sedeAttuale()).toBe('Nessuna sede in archivio'))
    })

    it('bambino ARCHIVIATO con una sede: si legge il NOME del plesso, non «Nessuna sede in archivio»', async () => {
        apri({ ...ALUNNO, archiviato_il: '2026-06-30T10:00:00Z' })
        await waitFor(() => expect(blocco()).not.toBeNull())
        await waitFor(() => expect(sedeAttuale()).toBe(NOME_SEDE_B))
    })

    it('GUASTO di lettura: la riga NON afferma che l\'archivio è vuoto (si contraddirebbe col riquadro accanto)', async () => {
        destinazioni = { stato: 500, corpo: { error: 'boom', codice: 'LETTURA_FALLITA' } }
        apri()

        // Il riquadro del guasto c'è: è l'altra metà della contraddizione.
        await screen.findByTestId('trasferimento-sede-guasto')
        await waitFor(() => expect(sedeAttuale()).not.toBe('Nessuna sede in archivio'))
        expect(sedeAttuale()).toBe('Sede non risolta')
    })

    it('mentre l\'elenco si legge, la riga dice che sta leggendo — non che la sede non c\'è', async () => {
        // Una lettura che non risponde mai: è il lampeggio, fermato a metà.
        fetchMock.mockImplementation((url: string) => {
            const u = new URL(String(url), 'http://t.test')
            if (u.pathname === '/api/admin/sedi/destinazioni') return new Promise(() => {})
            if (u.pathname === '/api/admin/sections') return Promise.resolve({ ok: true, status: 200, json: async () => [] })
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
        })
        apri()

        await waitFor(() => expect(blocco()).not.toBeNull())
        expect(sedeAttuale()).toBe('Sto leggendo le sedi…')
    })
})

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  T6-A/ter · UN ESITO ALLA VOLTA                                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `handleTrasferisci` azzerava `erroreTrasferimento` ma NON `sedeRaggiunta`:
 * dopo uno spostamento riuscito, un secondo tentativo rifiutato lasciava a
 * schermo «Spostato in …» E «Sede non accessibile» insieme — due righe che si
 * contraddicono, sull'esito dello spostamento di un minore.
 */
describe('StudentDetailPanel — successo ed errore non convivono', () => {
    /** L'annuncio di successo, ancorato al suo `role="status"` dentro la sezione. */
    const successo = () => {
        const sezione = screen.getByTestId('trasferimento-sede')
        return Array.from(sezione.querySelectorAll('[role="status"]')).find((el) =>
            (el.textContent ?? '').includes('Spostato in'),
        ) ?? null
    }

    const spostaIn = async (sede: string) => {
        fireEvent.change(tendina() as HTMLSelectElement, { target: { value: sede } })
        fireEvent.click(comando() as HTMLButtonElement)
        fireEvent.click(await screen.findByTestId('trasferimento-sede-conferma'))
    }

    it('LA SEQUENZA MISURATA: riuscito, poi rifiutato — a schermo resta UN esito solo', async () => {
        apri()
        await waitFor(() => expect(tendina()).not.toBeNull())

        await spostaIn(SEDE_A)
        await waitFor(() => expect(successo()).not.toBeNull())

        esitoPatch = { stato: 403, corpo: { error: 'boom', codice: 'SEDE_NON_ACCESSIBILE' } }
        await spostaIn(SEDE_C)

        const errore = await screen.findByTestId('trasferimento-sede-errore')
        expect(errore.textContent).toContain('Sede non accessibile')
        expect(successo(), '«Spostato in Kidville Alfa» è ancora a schermo accanto al rifiuto').toBeNull()
    })

    it('cambiare destinazione cancella l\'annuncio del giro precedente', async () => {
        apri()
        await waitFor(() => expect(tendina()).not.toBeNull())

        await spostaIn(SEDE_A)
        await waitFor(() => expect(successo()).not.toBeNull())

        fireEvent.change(tendina() as HTMLSelectElement, { target: { value: SEDE_C } })
        await waitFor(() => expect(successo()).toBeNull())
    })
})
