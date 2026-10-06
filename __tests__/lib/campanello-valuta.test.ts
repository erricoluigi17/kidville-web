import { describe, it, expect } from 'vitest'
import {
    ORE_ALLARME_BACKUP,
    PROMEMORIA_DOPO_MS,
    REGIONE_ATTESA,
    chiaveDaTitolo,
    riconcilia,
    valutaBackup,
    valutaDopoDeploy,
    valutaSalute,
    valutaVivo,
} from '../../scripts/campanello/valuta.mjs'
import { REGIONE_ATTESA as REGIONE_APP } from '@/lib/health/controlli'

/**
 * LA LOGICA DEL CAMPANELLO, con numeri letterali. Ogni caso FORZA un guasto e pretende il verdetto
 * giusto: un campanello che dice «ok» a tutto supererebbe un test scritto come «risponde 200».
 */

const ORA = 3_600_000
const ADESSO = Date.parse('2026-10-07T08:00:00Z')

const ok = (extra: Record<string, unknown> = {}) => ({
    http: 200,
    corpo: {
        stato: 'ok',
        controlli: [
            { nome: 'db-lettura', esito: 'ok', ms: 5 },
            { nome: 'auth', esito: 'ok', ms: 7 },
        ],
        regione: 'dub1',
        versione: 'abcdef012345',
        ...extra,
    },
})

describe('valutaVivo', () => {
    it('200 con stato ok → nessun incidente', () => {
        expect(valutaVivo(ok())).toBeNull()
    })

    it('503 con un controllo caduto → app-giu, e il dettaglio dice QUALE', () => {
        const inc = valutaVivo({
            http: 503,
            corpo: { stato: 'down', controlli: [{ nome: 'auth', esito: 'giu', dettaglio: 'auth 500 unexpected_failure' }] },
        })

        expect(inc?.chiave).toBe('app-giu')
        expect(inc?.dettaglio).toContain('auth(giu)')
        expect(inc?.dettaglio).toContain('500')
    })

    it('nessuna risposta (rete/timeout) → app-giu', () => {
        const inc = valutaVivo({ http: null, corpo: null })

        expect(inc?.chiave).toBe('app-giu')
        expect(inc?.dettaglio).toContain('nessuna risposta')
    })

    it('un 200 con stato diverso da ok non passa per vivo', () => {
        expect(valutaVivo({ http: 200, corpo: { stato: 'degraded', controlli: [] } })?.chiave).toBe('app-giu')
    })

    it('un HTML d\'errore di Vercel (corpo non JSON) è comunque un incidente', () => {
        expect(valutaVivo({ http: 502, corpo: null })?.chiave).toBe('app-giu')
    })

    it('il dettaglio è tagliato: una segnalazione pubblica non porta pagine di testo', () => {
        const inc = valutaVivo({
            http: 503,
            corpo: { stato: 'down', controlli: [{ nome: 'db-lettura', esito: 'giu', dettaglio: 'x'.repeat(5000) }] },
        })

        expect(inc!.dettaglio.length).toBeLessThanOrEqual(300)
    })
})

describe('valutaSalute', () => {
    const corpo = (controlli: unknown[]) => ({ http: 200, corpo: { stato: 'degraded', controlli } })

    it('tutto ok → nessun incidente', () => {
        expect(valutaSalute(corpo([{ nome: 'config', esito: 'ok' }]))).toEqual([])
    })

    it('un incidente per controllo non ok, con chiave salute:<nome>', () => {
        const inc = valutaSalute(
            corpo([
                { nome: 'config', esito: 'degradato', dettaglio: 'variabili assenti: ARUBA_PASSWORD' },
                { nome: 'cron-battito', esito: 'degradato', dettaglio: 'job senza battito: push-dispatch' },
                { nome: 'auth', esito: 'ok' },
            ]),
        )

        expect(inc.map((i) => i.chiave)).toEqual(['salute:config', 'salute:cron-battito'])
        expect(inc[0].dettaglio).toContain('ARUBA_PASSWORD')
    })

    it('un corpo illeggibile è un incidente (un campanello che non capisce non può tacere)', () => {
        expect(valutaSalute({ http: 502, corpo: null }).map((i) => i.chiave)).toEqual(['salute:illeggibile'])
        expect(valutaSalute({ http: null, corpo: null }).map((i) => i.chiave)).toEqual(['salute:illeggibile'])
    })

    it('un nome di controllo con caratteri strani non diventa una chiave (niente iniezione nel titolo)', () => {
        const inc = valutaSalute(corpo([{ nome: 'x] [app-giu', esito: 'degradato' }]))

        expect(inc).toEqual([])
    })
})

describe('valutaBackup', () => {
    const giro = (oreFa: number) => ({ conclusion: 'success', updated_at: new Date(ADESSO - oreFa * ORA).toISOString() })

    it('un giro automatico riuscito 20 ore fa → nessun incidente', () => {
        expect(valutaBackup({ giri: [giro(20)], adesso: ADESSO })).toBeNull()
    })

    // NUMERI LETTERALI: 30 e 31 inchiodano il confine (con `ORE_ALLARME_BACKUP + 1` il test
    // crescerebbe insieme alla soglia e proverebbe solo che il confronto esiste).
    it('esattamente 30 ore fa non è ancora un incidente; 31 sì', () => {
        expect(valutaBackup({ giri: [giro(30)], adesso: ADESSO })).toBeNull()
        const inc = valutaBackup({ giri: [giro(31)], adesso: ADESSO })
        expect(inc?.chiave).toBe('backup-vecchio')
        expect(inc?.titolo).toContain('31 ore')
    })

    it('nessun giro automatico riuscito → incidente (è la situazione del 2026-10-06)', () => {
        const inc = valutaBackup({ giri: [], adesso: ADESSO })

        expect(inc?.chiave).toBe('backup-vecchio')
        expect(inc?.dettaglio).toContain('Un giro manuale non basta')
    })

    it('un giro non riuscito non conta come backup', () => {
        const inc = valutaBackup({ giri: [{ conclusion: 'failure', updated_at: new Date(ADESSO - 2 * ORA).toISOString() }], adesso: ADESSO })

        expect(inc?.chiave).toBe('backup-vecchio')
    })

    it('una data illeggibile non conta come «adesso»', () => {
        expect(valutaBackup({ giri: [{ conclusion: 'success', updated_at: 'boh' }], adesso: ADESSO })?.chiave).toBe('backup-vecchio')
    })

    it('la soglia sta sopra il ritardo massimo osservato (6 h 45 min sulle 02:23 UTC) e sotto i due giorni', () => {
        // Il primo giro programmato (2026-10-06) è partito alle 09:08 UTC invece che alle 02:23.
        // 24 h di cadenza + 6,75 h di ritardo = 30,75 h: la soglia deve stare vicina a quel numero
        // (se fosse 26 suonerebbe per un ritardo di due ore) e lontana dai due giorni (se fosse 48
        // una notte saltata resterebbe invisibile fino al giorno dopo).
        expect(ORE_ALLARME_BACKUP).toBeGreaterThanOrEqual(28)
        expect(ORE_ALLARME_BACKUP).toBeLessThanOrEqual(36)
    })
})

describe('valutaDopoDeploy', () => {
    const vivoOk = ok()
    const saluteOk = { http: 200, corpo: { stato: 'ok', controlli: [] } }

    it('tutto a posto → nessun guasto', () => {
        const { guasti } = valutaDopoDeploy({ vivo: vivoOk, salute: saluteOk, intestazioneVercelId: 'fra1::dub1::abc-123' })

        expect(guasti).toEqual([])
    })

    it('la funzione in iad1 FERMA il rilascio (la regione di Washington è la regressione della fase 1)', () => {
        const { guasti } = valutaDopoDeploy({
            vivo: ok({ regione: 'iad1' }),
            salute: saluteOk,
            intestazioneVercelId: 'fra1::iad1::abc-123',
        })

        expect(guasti.some((g) => g.includes('iad1'))).toBe(true)
        expect(guasti.length).toBe(2) // corpo E intestazione: due prove indipendenti
    })

    it('l\'intestazione x-vercel-id senza ::dub1:: ferma anche se il corpo non dichiara la regione', () => {
        const { guasti } = valutaDopoDeploy({
            vivo: { http: 200, corpo: { stato: 'ok', controlli: [] } },
            salute: saluteOk,
            intestazioneVercelId: 'fra1::iad1::abc-123',
        })

        expect(guasti).toHaveLength(1)
    })

    it('il vivo giù ferma', () => {
        const { guasti } = valutaDopoDeploy({
            vivo: { http: 503, corpo: { stato: 'down', controlli: [{ nome: 'db-lettura', esito: 'giu', dettaglio: 'utenti:PGRST205' }] } },
            salute: { http: 503, corpo: { stato: 'down', controlli: [{ nome: 'db-lettura', esito: 'giu' }] } },
            intestazioneVercelId: 'fra1::dub1::abc',
        })

        expect(guasti.some((g) => g.startsWith('vivo:'))).toBe(true)
    })

    it('la salute DEGRADED non ferma il rilascio: è una nota (non l\'ha causato il deploy)', () => {
        const { guasti, note } = valutaDopoDeploy({
            vivo: vivoOk,
            salute: { http: 200, corpo: { stato: 'degraded', controlli: [{ nome: 'cron-battito', esito: 'degradato', dettaglio: 'job senza battito: x' }] } },
            intestazioneVercelId: 'fra1::dub1::abc',
        })

        expect(guasti).toEqual([])
        expect(note[0]).toContain('cron-battito')
    })

    it('la salute DOWN con vivo ok ferma (qualcosa di più del vivo è caduto davvero)', () => {
        const { guasti } = valutaDopoDeploy({
            vivo: vivoOk,
            salute: { http: 503, corpo: { stato: 'down', controlli: [{ nome: 'schema-atteso', esito: 'giu', dettaglio: 'tabelle assenti: pagamenti' }] } },
            intestazioneVercelId: 'fra1::dub1::abc',
        })

        expect(guasti[0]).toContain('schema-atteso')
    })

    it('la regione attesa è la stessa dell\'app e di vercel.json', () => {
        expect(REGIONE_ATTESA).toBe(REGIONE_APP)
    })
})

describe('chiaveDaTitolo', () => {
    it('legge la chiave fra parentesi quadre in testa', () => {
        expect(chiaveDaTitolo('[salute:config] Salute: config degradato')).toBe('salute:config')
        expect(chiaveDaTitolo('[app-giu] Il sito non risponde')).toBe('app-giu')
    })

    it('un titolo senza chiave in testa non è del campanello', () => {
        expect(chiaveDaTitolo('Backup notturno FALLITO')).toBeNull()
        expect(chiaveDaTitolo('qualcosa [app-giu] in mezzo')).toBeNull()
    })
})

describe('riconcilia', () => {
    const inc = (chiave: string) => ({ chiave, titolo: `titolo ${chiave}`, dettaglio: 'd' })
    const aperta = (numero: number, chiave: string, oreFa = 1) => ({
        numero,
        titolo: `[${chiave}] titolo`,
        ultimoAggiornamento: new Date(ADESSO - oreFa * ORA).toISOString(),
    })

    it('un incidente nuovo apre una segnalazione; uno già aperto no (niente raffica di email)', () => {
        const r = riconcilia({ aperte: [aperta(7, 'app-giu')], attuali: [inc('app-giu'), inc('salute:config')], adesso: ADESSO })

        expect(r.apri.map((i) => i.chiave)).toEqual(['salute:config'])
        expect(r.ricorda).toEqual([])
        expect(r.chiudi).toEqual([])
    })

    it('un incidente rientrato chiude la sua segnalazione', () => {
        const r = riconcilia({ aperte: [aperta(7, 'app-giu'), aperta(8, 'salute:config')], attuali: [inc('salute:config')], adesso: ADESSO })

        expect(r.chiudi).toEqual([{ chiave: 'app-giu', numero: 7 }])
    })

    it('una chiave NON verificata in questo giro non si chiude (il sito è giù: la salute non si è letta)', () => {
        const r = riconcilia({
            aperte: [aperta(8, 'salute:config'), aperta(9, 'backup-vecchio')],
            attuali: [inc('app-giu')],
            adesso: ADESSO,
            verificate: (k) => k === 'app-giu',
        })

        expect(r.chiudi).toEqual([])
        expect(r.apri.map((i) => i.chiave)).toEqual(['app-giu'])
    })

    it('un incidente ancora presente dopo 24 ore riceve un promemoria; prima no', () => {
        const prima = riconcilia({ aperte: [aperta(7, 'app-giu', 23)], attuali: [inc('app-giu')], adesso: ADESSO })
        const dopo = riconcilia({ aperte: [aperta(7, 'app-giu', 25)], attuali: [inc('app-giu')], adesso: ADESSO })

        expect(prima.ricorda).toEqual([])
        expect(dopo.ricorda.map((x) => x.numero)).toEqual([7])
        expect(PROMEMORIA_DOPO_MS).toBe(24 * ORA)
    })

    it('una segnalazione senza chiave (di un altro processo) non si tocca', () => {
        const r = riconcilia({
            aperte: [{ numero: 3, titolo: 'Backup notturno FALLITO', ultimoAggiornamento: new Date(ADESSO - 99 * ORA).toISOString() }],
            attuali: [],
            adesso: ADESSO,
        })

        expect(r).toEqual({ apri: [], ricorda: [], chiudi: [] })
    })

    it('senza incidenti e senza segnalazioni non succede niente', () => {
        expect(riconcilia({ aperte: [], attuali: [], adesso: ADESSO })).toEqual({ apri: [], ricorda: [], chiudi: [] })
    })

})
