import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../../fixtures/finto-supabase'
import { creaFintoSupabase } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../../fixtures/sedi'

// =============================================================================
// W4-A / R90 — «Kidville» non è il nome di una scuola: è il nome di tre.
//
// ─── DA DOVE VIENE QUESTO FILE ──────────────────────────────────────────────
// Sostituisce `__tests__/lib/email-credenziali-sede.test.ts`, che misurava la
// stessa cosa su `credentialsEmailBody` — la funzione che scriveva l'email delle
// credenziali in testo semplice, e che il 2026-08-15 è stata sostituita dal
// generatore comune.
//
// Le FRASI che quel test cercava («la tua iscrizione a …», «Lo staff di …») non
// esistono più, e non per una revisione di stile: l'email nuova è una sola per
// genitori e personale insieme, quindi non può dare del «tu» né del «lei», e non
// può dire «la tua iscrizione» a chi si è candidata per lavorare.
//
// L'INTENTO invece è identico, e sopravvive parola per parola nei tre `it` qui
// sotto — sono gli stessi nomi del test vecchio, di proposito:
//
//   · con la sede: la frase la nomina, e la firma anche
//   · senza la sede: nessuna sede inventata, la frase resta quella generica
//   · due sedi diverse ⇒ due corpi diversi (è il punto di tutto)
//
// Il difetto che difendono è quello vero: con Giugliano, Aversa e Cesa, un
// genitore che legge solo «Kidville» non sa a quale plesso è stato iscritto suo
// figlio, e non ha modo di accorgersi se lo hanno registrato in quello sbagliato.
// =============================================================================

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...actual, logEvento: h.logEvento }
})

import { messaggioCredenziali } from '@/lib/email/messaggi/credenziali'
import { risolviContestoSede, contestoSenzaSede } from '@/lib/email/contesto'
import { piedeTesto } from '@/lib/email/componenti'
import { buildIntestazioneSede } from '@/lib/certificati/self-service'
import { nomeSede } from '@/lib/scuole/reali'

beforeEach(() => vi.clearAllMocks())

const CREDENZIALI = {
    nome: 'Maria',
    email: 'mamma@example.test',
    password: 'Segreta-finta-2026',
    occasione: 'iscrizione-approvata', emessaIl: '4 settembre 2026 alle 14:32',
} as const

const sedeDi = (nome: string) => ({ ...contestoSenzaSede(nome), indirizzo: 'Via di Prova 1', email: 'prova@example.test' })

describe('messaggioCredenziali — la sede compare nel corpo', () => {
    it('con la sede: la frase la nomina, e la firma anche', () => {
        const m = messaggioCredenziali(CREDENZIALI, sedeDi(NOME_SEDE_A))
        // La frase d'apertura la nomina…
        expect(m.testo).toContain(`area riservata di ${NOME_SEDE_A}`)
        // …e il piè di pagina la firma, con l'indirizzo del plesso.
        expect(m.testo).toContain(NOME_SEDE_A)
        expect(m.html).toContain(NOME_SEDE_A)
        // Ciò che serviva prima serve ancora.
        expect(m.testo).toContain('mamma@example.test')
        expect(m.testo).toContain('Segreta-finta-2026')
        expect(m.html).toContain('Segreta-finta-2026')
    })

    it('senza la sede: nessuna sede inventata, la frase resta quella generica', () => {
        const m = messaggioCredenziali(CREDENZIALI, contestoSenzaSede())
        expect(m.testo).toContain('area riservata di Kidville')
        // Meglio vaga che falsa: nessun plesso viene nominato a caso.
        for (const plesso of ['Giugliano', 'Aversa', 'Cesa']) {
            expect(m.testo).not.toContain(plesso)
            expect(m.html).not.toContain(plesso)
        }
    })

    it('due sedi diverse ⇒ due corpi diversi (è il punto di tutto)', () => {
        const a = messaggioCredenziali(CREDENZIALI, sedeDi(NOME_SEDE_A))
        const b = messaggioCredenziali(CREDENZIALI, sedeDi(NOME_SEDE_B))
        expect(a.testo).not.toEqual(b.testo)
        expect(a.html).not.toEqual(b.html)
        expect(a.testo).not.toContain(NOME_SEDE_B)
        expect(b.testo).not.toContain(NOME_SEDE_A)
    })
})

describe('nomeSede — il nome si legge, non si deduce', () => {
    const db = (): DBFinto => ({
        schools: [
            { id: SEDE_A, nome: NOME_SEDE_A },
            { id: SEDE_B, nome: NOME_SEDE_B },
        ],
    })

    it('legge il nome della sede richiesta e SOLO di quella', async () => {
        const d = db()
        const tabelle: string[] = []
        expect(await nomeSede(creaFintoSupabase(d, tabelle), SEDE_B, 'test')).toBe(NOME_SEDE_B)
        expect(tabelle).toEqual(['schools'])
    })

    it('sede nulla o sconosciuta ⇒ null, senza chiedere niente al database', async () => {
        const tabelle: string[] = []
        expect(await nomeSede(creaFintoSupabase(db(), tabelle), null, 'test')).toBeNull()
        expect(tabelle).toEqual([])
        expect(await nomeSede(creaFintoSupabase(db(), tabelle), 'sede-che-non-esiste', 'test')).toBeNull()
    })

    it('lettura in errore ⇒ null E una riga di log: un catch muto è un bug', async () => {
        const client = creaFintoSupabase(db(), [], {
            errori: { schools: { code: '08006', message: 'connection failure' } },
        })
        expect(await nomeSede(client, SEDE_A, 'test')).toBeNull()
        expect(h.logEvento).toHaveBeenCalledWith(
            'multi_sede',
            'info',
            expect.objectContaining({ operazione: 'test', esito: 'nome-sede-non-letto' }),
            expect.anything(),
        )
    })
})

describe('risolviContestoSede — l\'identità del plesso, e cosa fa quando manca', () => {
    it('sede nota ⇒ nome dal database, recapiti dall\'anagrafica', async () => {
        const client = creaFintoSupabase({
            schools: [{ id: SEDE_A, nome: NOME_SEDE_A }],
            // `scuole.indirizzo` è la SOLA VIA dal 2026-08-16 (spec §2.2): CAP,
            // città e provincia stanno nei propri campi e vanno ricomposti.
            scuole: [{
                id: SEDE_A,
                indirizzo: 'Via di Prova 1',
                citta: 'Prova',
                config: { anagrafica: { email: 'prova@example.test', telefono: null, cap: '00000', provincia: 'PR' } },
            }],
        } as DBFinto)
        const c = await risolviContestoSede(client, SEDE_A, 'test')
        expect(c.nome).toBe(NOME_SEDE_A)
        expect(c.indirizzo).toBe('Via di Prova 1 — 00000 Prova (PR)')
        expect(c.email).toBe('prova@example.test')
        expect(c.telefono).toBeNull()
    })

    // =========================================================================
    // LA REGRESSIONE CHE LA RIDUZIONE DEL CAMPO HA CAUSATO
    //
    // Il Task 3.1 (spec §2.2) chiedeva di censire OGNI lettore di
    // `scuole.indirizzo` prima di ridurlo alla sola via. Il censimento la vittima
    // l'aveva trovata — questo file — e l'aveva lasciata rotta: `piede()` stampa
    // `ContestoSede.indirizzo` come riga unica in fondo a TUTTE le email (undici
    // generatori), e la colonna grezza da quel giorno non contiene più il luogo.
    //
    // Concretamente, prima della riduzione il piede di Cesa firmava
    //     Via Filippo Turati 2, 81030 Cesa (CE)
    // e dopo avrebbe firmato
    //     Via Filippo Turati 2
    //
    // Il difetto non si vedeva nella suite perché il test del piè di pagina
    // (`pie-di-pagina-senza-buchi.test.ts`) imbocca un `ContestoSede` a mano
    // invece di costruirlo dal database: la regressione stava a monte, in
    // `risolviContestoSede`, che è l'UNICO punto in cui quel campo nasce da una
    // riga vera. Per questo il test sta qui.
    // =========================================================================
    it('il piè di pagina porta il luogo, non la sola via: CAP, città e provincia ricomposti', async () => {
        const client = creaFintoSupabase({
            schools: [{ id: SEDE_A, nome: NOME_SEDE_A }],
            scuole: [{
                id: SEDE_A,
                indirizzo: 'Via Filippo Turati 2',
                citta: 'Cesa',
                config: { anagrafica: { cap: '81030', provincia: 'CE', email: 'cesa@example.test' } },
            }],
        } as DBFinto)
        const c = await risolviContestoSede(client, SEDE_A, 'test')
        expect(c.indirizzo).toBe('Via Filippo Turati 2 — 81030 Cesa (CE)')
        // La riga che va in fondo all'email la porta per intero.
        expect(piedeTesto(c, 'Motivo di prova')).toContain('Via Filippo Turati 2 — 81030 Cesa (CE)')
    })

    it('la stessa riga che stampa il certificato: le due testate non divergono', async () => {
        // Il certificato compone `via — CAP CITTÀ (PROV)` con `buildIntestazioneSede`.
        // Se un giorno l'email e il certificato scrivessero l'indirizzo in due modi
        // diversi, la scuola avrebbe due indirizzi — e nessuno saprebbe quale.
        const client = creaFintoSupabase({
            schools: [{ id: SEDE_A, nome: NOME_SEDE_A }],
            scuole: [{
                id: SEDE_A,
                indirizzo: 'Via Prima Traversa Antica Giardini 5',
                citta: 'Giugliano in Campania',
                config: { anagrafica: { cap: '80014', provincia: 'NA' } },
            }],
        } as DBFinto)
        const c = await risolviContestoSede(client, SEDE_A, 'test')
        const testataCertificato = buildIntestazioneSede({
            scuola_nome: NOME_SEDE_A,
            scuola_indirizzo: 'Via Prima Traversa Antica Giardini 5',
            scuola_cap: '80014',
            scuola_citta: 'Giugliano in Campania',
            scuola_provincia: 'NA',
        })
        expect(c.indirizzo).toBe(testataCertificato[1])
    })

    it('senza il luogo resta la sola via, e senza nulla la riga non esiste', async () => {
        // Degrado dichiarato: un'anagrafica a metà non produce «Via X — » con il
        // trattino sospeso, e una sede senza indirizzo non produce una riga vuota.
        const client = creaFintoSupabase({
            schools: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }],
            scuole: [
                { id: SEDE_A, indirizzo: 'Via Solitaria 1', citta: null, config: {} },
                { id: SEDE_B, indirizzo: null, citta: null, config: {} },
            ],
        } as DBFinto)
        expect((await risolviContestoSede(client, SEDE_A, 'test')).indirizzo).toBe('Via Solitaria 1')
        expect((await risolviContestoSede(client, SEDE_B, 'test')).indirizzo).toBeNull()
    })

    it('sede nulla ⇒ contesto generico, senza toccare il database', async () => {
        const tabelle: string[] = []
        const c = await risolviContestoSede(creaFintoSupabase({} as DBFinto, tabelle), null, 'test')
        expect(c.nome).toBe('Kidville')
        expect(tabelle).toEqual([])
    })

    it('anagrafica non leggibile ⇒ il nome resta, i recapiti si omettono, e c\'è una riga', async () => {
        // PostgREST non lancia: ritorna `{ error }`. Senza il controllo questo
        // ramo sarebbe muto, e «nessun recapito nelle email» sarebbe
        // indistinguibile da «anagrafica mai compilata».
        const client = creaFintoSupabase(
            // `scuole` va dichiarata anche vuota: il finto database valida le
            // chiavi di `errori` contro le tabelle che conosce, così un nome
            // sbagliato non produce un test verde su un errore mai iniettato.
            { schools: [{ id: SEDE_A, nome: NOME_SEDE_A }], scuole: [] } as DBFinto,
            [],
            { errori: { scuole: { code: '08006', message: 'connection failure' } } },
        )
        const c = await risolviContestoSede(client, SEDE_A, 'test')
        expect(c.nome).toBe(NOME_SEDE_A)
        expect(c.indirizzo).toBeNull()
        expect(c.email).toBeNull()
        expect(h.logEvento).toHaveBeenCalledWith(
            'multi_sede',
            'info',
            expect.objectContaining({ esito: 'anagrafica-sede-non-letta' }),
            expect.anything(),
        )
    })
})
