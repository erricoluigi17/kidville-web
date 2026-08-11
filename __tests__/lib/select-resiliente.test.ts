import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// `selectResiliente` — la SELECT che sopravvive a una colonna che questo
// database non ha.
//
// ⚠️ QUESTO FILE ESISTE PER TENERE FERMA LA FORMA DELL'ESITO, non solo il
// comportamento. Il nome della colonna caduta viaggia DENTRO `esito`
// (`colonna-assente:<colonna>`) e non in un campo `campo`, e la ragione è una
// misura, non un gusto: `redact()` è a lista bianca PER CHIAVE, quindi un
// `campo: 'codice_belfiore_nascita'` finisce in `app_log` come `[redatto:str/23]`
// — cioè la riga dice che una colonna è caduta e NON dice quale, che è l'unica
// cosa che serviva sapere. Era la forma della copia scritta a mano in
// `admin/parents:GET` fino al 2026-08-10.
//
// Nel repo convivono oggi quattro grafie della stessa nozione
// (`colonna-assente-rimossa`, `colonna-assente`, `colonna-assente-<col>`,
// `colonna-assente:<col>`), ognuna in una corsia diversa. Questo test non le
// unifica — non è la sua corsia — ma inchioda quella di QUESTO modulo, così la
// prossima variazione di grafia diventa rossa invece di aggiungersi alle altre.
// =============================================================================

const h = vi.hoisted(() => ({
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
    return {
        ...vero,
        logEvento: (evento: string, livello: string, campi: Record<string, unknown>, err?: unknown) => {
            h.eventi.push({ evento, livello, campi })
            return vero.logEvento(evento, livello as never, campi as never, err)
        },
    }
})

import { selectResiliente, nomeColonnaAssente } from '@/lib/supabase/select-resiliente'
import { redact } from '@/lib/logging/redact'

const OPERAZIONE = 'collaudo/select-resiliente:GET'

/** Un finto database che «non ha» le colonne indicate, e le nomina come PostgREST. */
function databaseSenza(mancanti: string[], codice = '42703') {
    const chiamate: string[][] = []
    const esegui = async (colonne: string[]) => {
        chiamate.push([...colonne])
        const caduta = colonne.find((c) => mancanti.includes(c))
        if (caduta !== undefined) {
            return {
                data: null,
                error: {
                    code: codice,
                    message: codice === 'PGRST204'
                        ? `Could not find the '${caduta}' column of 'alunni' in the schema cache`
                        : `column alunni.${caduta} does not exist`,
                },
            }
        }
        return { data: [{ ok: true }], error: null }
    }
    return { esegui, chiamate }
}

beforeEach(() => {
    h.eventi = []
})

describe('il nome della colonna, letto dal messaggio del fornitore', () => {
    it('legge la forma di Postgres (42703)', () => {
        expect(nomeColonnaAssente('column alunni.codice_belfiore_nascita does not exist'))
            .toBe('codice_belfiore_nascita')
        expect(nomeColonnaAssente('column "intestatario_default" does not exist')).toBe('intestatario_default')
    })

    it('legge la forma di PostgREST (PGRST204), che parla un’altra lingua', () => {
        expect(nomeColonnaAssente("Could not find the 'codice_belfiore_nascita' column of 'alunni' in the schema cache"))
            .toBe('codice_belfiore_nascita')
    })

    it('su un messaggio che non nomina nessuna colonna dice `null`, invece di indovinare', () => {
        expect(nomeColonnaAssente('connection failure')).toBeNull()
    })
})

describe('il degrado: si toglie la colonna NOMINATA, e si riprova', () => {
    it('toglie solo quella, e la seconda esecuzione riesce', async () => {
        const { esegui, chiamate } = databaseSenza(['codice_belfiore_nascita'])

        const esito = await selectResiliente(['id', 'nome', 'codice_belfiore_nascita'], esegui, OPERAZIONE)

        expect(esito.error).toBeNull()
        expect(chiamate).toEqual([
            ['id', 'nome', 'codice_belfiore_nascita'],
            ['id', 'nome'],
        ])
    })

    it('due colonne assenti, due giri: si tolgono una alla volta', async () => {
        const { esegui, chiamate } = databaseSenza(['a', 'b'])

        const esito = await selectResiliente(['id', 'a', 'b'], esegui, OPERAZIONE)

        expect(esito.error).toBeNull()
        expect(chiamate).toHaveLength(3)
        expect(chiamate[2]).toEqual(['id'])
    })

    it('una colonna che NON avevamo chiesto ferma il ciclo: il giro dopo sarebbe identico', async () => {
        const esegui = vi.fn(async () => ({
            data: null,
            error: { code: '42703', message: 'column alunni.mai_chiesta does not exist' },
        }))

        const esito = await selectResiliente(['id'], esegui, OPERAZIONE)

        expect(esito.error).not.toBeNull()
        expect(esegui, 'un ciclo che non termina è peggio di un 500: quello almeno si vede').toHaveBeenCalledTimes(1)
        expect(h.eventi, 'niente da togliere ⇒ niente da dichiarare').toHaveLength(0)
    })

    it('una TABELLA assente non è una colonna da togliere: non si riprova', async () => {
        const esegui = vi.fn(async () => ({
            data: null,
            error: { code: '42P01', message: 'relation "candidature_insegnanti" does not exist' },
        }))

        const esito = await selectResiliente(['id'], esegui, OPERAZIONE)

        expect((esito.error as { code?: string }).code).toBe('42P01')
        expect(esegui).toHaveBeenCalledTimes(1)
    })

    it('il tetto dei tentativi si rispetta, e l’errore esce invece di girare all’infinito', async () => {
        const { esegui } = databaseSenza(['a', 'b', 'c'])

        const esito = await selectResiliente(['id', 'a', 'b', 'c'], esegui, OPERAZIONE, { tentativiMassimi: 2 })

        expect(esito.error, 'oltre il tetto si consegna l’errore, non un `data` a metà').not.toBeNull()
    })

    /**
     * ⚠️ IL TEST QUI SOPRA NON INCHIODA IL DEFAULT: passa `tentativiMassimi: 2`
     * esplicito, quindi il numero scritto nel modulo resta libero. Misurato il
     * 2026-08-10: portando il default da 6 a 100 la suite restava tutta verde —
     * cioè il commento «il tetto di sei giri esiste perché un ciclo che non termina
     * è peggio di un 500» era una frase, non una proprietà.
     *
     * I due casi qui sotto lo chiudono da entrambi i lati: sei colonne assenti
     * devono ancora RIUSCIRE (un default più basso le taglierebbe fuori) e sette
     * devono FALLIRE (un default più alto le farebbe passare).
     */
    it('SENZA `tentativiMassimi`: sei colonne assenti si tolgono ancora tutte', async () => {
        const { esegui, chiamate } = databaseSenza(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'])

        const esito = await selectResiliente(
            ['id', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
            esegui,
            OPERAZIONE,
        )

        expect(esito.error, 'sei giri sono dentro il tetto').toBeNull()
        expect(chiamate, 'la prima esecuzione più sei ritentativi').toHaveLength(7)
        expect(h.eventi, 'ogni colonna caduta si dichiara').toHaveLength(6)
    })

    it('SENZA `tentativiMassimi`: alla SETTIMA colonna l’errore esce — il default è 6, non «quante ne servono»', async () => {
        const { esegui, chiamate } = databaseSenza(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])

        const esito = await selectResiliente(
            ['id', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'],
            esegui,
            OPERAZIONE,
        )

        expect(esito.error, 'oltre il tetto si consegna l’errore, non un `data` a metà').not.toBeNull()
        expect(chiamate, 'il ciclo si ferma al settimo giro, non prosegue finché non riesce').toHaveLength(7)
    })
})

describe('LA FORMA DELL’ESITO — il nome della colonna deve sopravvivere alla redazione', () => {
    it('`esito` vale esattamente `colonna-assente:<colonna>`', async () => {
        const { esegui } = databaseSenza(['codice_belfiore_nascita'])

        await selectResiliente(['id', 'codice_belfiore_nascita'], esegui, OPERAZIONE)

        expect(h.eventi).toHaveLength(1)
        expect(h.eventi[0].evento).toBe('db')
        expect(h.eventi[0].campi).toEqual({
            operazione: OPERAZIONE,
            esito: 'colonna-assente:codice_belfiore_nascita',
        })
        // La copia scritta a mano metteva il nome in `campo`. Non deve tornarci:
        // `campo` non è in lista bianca, quindi lì il nome si perde.
        expect(h.eventi[0].campi.campo, 'il nome NON va in un campo fuori lista bianca').toBeUndefined()
    })

    it('e dopo `redact()` il nome della colonna si legge ancora — che è tutto il punto', async () => {
        const { esegui } = databaseSenza(['codice_belfiore_nascita'])

        await selectResiliente(['id', 'codice_belfiore_nascita'], esegui, OPERAZIONE)

        const redatto = redact(h.eventi[0].campi) as Record<string, unknown>
        expect(redatto.esito).toBe('colonna-assente:codice_belfiore_nascita')

        // Il controllo negativo, senza il quale il test sopra non prova niente:
        // la stessa informazione sotto la chiave `campo` USCIREBBE REDATTA.
        const conCampo = redact({ esito: 'colonna-assente-rimossa', campo: 'codice_belfiore_nascita' }) as Record<string, unknown>
        expect(conCampo.campo, 'ecco perché il nome non può viaggiare lì')
            .not.toBe('codice_belfiore_nascita')
    })

    it('il livello è `info` di default e `warn` quando lo si chiede', async () => {
        const primo = databaseSenza(['x'])
        await selectResiliente(['id', 'x'], primo.esegui, OPERAZIONE)
        expect(h.eventi[0].livello).toBe('info')

        h.eventi = []
        const secondo = databaseSenza(['x'])
        await selectResiliente(['id', 'x'], secondo.esegui, OPERAZIONE, { livello: 'warn' })
        expect(h.eventi[0].livello, 'una colonna appena migrata deve restare in `app_log`').toBe('warn')
    })

    it('`PGRST204` produce la stessa riga di `42703`: una nozione, una grafia', async () => {
        const { esegui } = databaseSenza(['intestatario_default'], 'PGRST204')

        await selectResiliente(['id', 'intestatario_default'], esegui, OPERAZIONE)

        expect(h.eventi[0].campi.esito).toBe('colonna-assente:intestatario_default')
    })

    it('nessun degrado ⇒ nessuna riga: un log di degrado che non è degrado è rumore', async () => {
        const { esegui } = databaseSenza([])

        const esito = await selectResiliente(['id'], esegui, OPERAZIONE)

        expect(esito.error).toBeNull()
        expect(h.eventi).toHaveLength(0)
    })
})
