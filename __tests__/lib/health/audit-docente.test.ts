// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest } from '../../fixtures/finto-supabase'
import {
    controlloAuditDocente,
    eseguiSalute,
    FINESTRA_AUDIT_MS,
    ESITO_AUDIT_NON_REGISTRATO,
} from '@/lib/health/controlli'

/**
 * T6 — UNA traccia d'audit persa deve bastare.
 *
 * `logScrittura` non blocca la scrittura che racconta, ed è giusto: ma una riga persa sta
 * sotto ogni soglia di `tasso-errore`, e nessuno la vede. Questi test usano numeri letterali:
 * 1 riga, 23 e 25 ore, 3 occorrenze. Ogni caso «degradato» ha il suo gemello «ok».
 */

const MIN = 60_000
const ORA = 60 * MIN
const ADESSO = Date.parse('2026-10-21T10:00:00.000Z')
const fa = (ms: number) => new Date(ADESSO - ms).toISOString()

/** Una riga come la lascia `logScrittura` quando la traccia d'audit non entra. */
function auditPerso(quandoMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: `log-audit-${quandoMs}`,
        evento: 'audit',
        livello: 'error',
        sorgente: 'server',
        ambiente: 'production',
        occorrenze: 1,
        creato_il: fa(quandoMs),
        visto_l_ultima: fa(quandoMs),
        contesto: { campi: { operazione: 'logScrittura', entita_tipo: 'presenze', azione: 'insert', esito: 'audit-non-registrato' } },
        ...extra,
    }
}

async function sonda(app_log: Record<string, unknown>[], errori: Record<string, ErrorePostgrest> = {}) {
    const d: DBFinto = { app_log }
    return controlloAuditDocente(creaFintoSupabase(d, [], { errori }) as unknown as SupabaseClient, ADESSO, 'production')
}

describe('audit-docente — una sola traccia persa basta', () => {
    it('nessuna riga ⇒ ok', async () => {
        const c = await sonda([])
        expect(c).toMatchObject({ nome: 'audit-docente', esito: 'ok' })
    })

    it("UNA riga di un'ora fa ⇒ degradato, e il dettaglio dice 1", async () => {
        const c = await sonda([auditPerso(1 * ORA)])
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toBe("tracce d'audit non registrate nelle ultime 24 h: 1 (1 impronte)")
    })

    it('la stessa impronta con 3 occorrenze ⇒ degradato, e il dettaglio dice 3', async () => {
        const c = await sonda([auditPerso(1 * ORA, { occorrenze: 3 })])
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toBe("tracce d'audit non registrate nelle ultime 24 h: 3 (1 impronte)")
    })

    it('23 ore fa ⇒ degradato; 25 ore fa ⇒ ok (i gemelli sulla finestra)', async () => {
        expect((await sonda([auditPerso(23 * ORA)])).esito).toBe('degradato')
        expect((await sonda([auditPerso(25 * ORA)])).esito).toBe('ok')
    })

    it('una riga del BROWSER non conta: `/api/logs` è anonimo', async () => {
        expect((await sonda([auditPerso(1 * ORA, { sorgente: 'client' })])).esito).toBe('ok')
    })

    it("una riga di un altro ambiente non conta", async () => {
        expect((await sonda([auditPerso(1 * ORA, { ambiente: 'preview' })])).esito).toBe('ok')
    })

    it('un altro esito non conta, nemmeno a livello error', async () => {
        const battito = {
            ...auditPerso(1 * ORA),
            evento: 'cron',
            livello: 'info',
            contesto: { campi: { operazione: 'push-dispatch', esito: 'ok' } },
        }
        const guasto = {
            ...auditPerso(1 * ORA),
            id: 'log-altro-errore',
            evento: 'route',
            contesto: { campi: { operazione: 'admin/students:PATCH', esito: 'lettura-fallita' } },
        }
        expect((await sonda([battito, guasto])).esito).toBe('ok')
    })

    // ── Aggiunti dalla verifica di mutazione (Compito 7): senza questi tre casi, togliere il filtro
    //    sul livello, filtrare su `creato_il` invece che su `visto_l_ultima`, o cablare 'production'
    //    in `eseguiSalute` lasciava verde ogni test.
    it('la stessa riga a livello warn non conta: il controllo guarda solo i `error`', async () => {
        expect((await sonda([auditPerso(1 * ORA, { livello: 'warn' })])).esito).toBe('ok')
    })

    it("conta l'ultima volta che è successo (`visto_l_ultima`), non il giorno in cui l'impronta è nata", async () => {
        // `app_log` deduplica per (impronta, giorno): una riga nata ieri alle 00:30 e rivista ieri
        // alle 23:50 ha `creato_il` di 30 ore fa e `visto_l_ultima` di 10 ore fa. È dentro le 24 ore.
        const c = await sonda([auditPerso(10 * ORA, { creato_il: fa(30 * ORA) })])
        expect(c.esito).toBe('degradato')
    })

    it("`eseguiSalute` passa l'ambiente corrente: in preview contano le righe di preview, non quelle di production", async () => {
        const preview = auditPerso(1 * ORA, { id: 'log-preview', ambiente: 'preview', occorrenze: 2 })
        const produzione = auditPerso(1 * ORA, { id: 'log-production', ambiente: 'production', occorrenze: 5 })
        const d: DBFinto = { app_log: [preview, produzione] }
        const salute = await eseguiSalute(creaFintoSupabase(d, []) as unknown as SupabaseClient, {
            adesso: ADESSO,
            ambiente: 'preview',
        })
        const c = salute.controlli.find((x) => x.nome === 'audit-docente')
        expect(c?.dettaglio).toBe("tracce d'audit non registrate nelle ultime 24 h: 2 (1 impronte)")
    })

    it("conta anche gli altri registri d'audit: l'accesso al fascicolo e la firma elettronica", async () => {
        const fascicolo = auditPerso(1 * ORA, {
            id: 'log-fascicolo-perso',
            evento: 'fascicolo',
            contesto: { campi: { operazione: 'logAccessoFascicolo', azione: 'lettura', esito: 'audit-non-registrato' } },
        })
        const fea = auditPerso(2 * ORA, {
            id: 'log-fea-perso',
            evento: 'fea',
            contesto: { campi: { operazione: 'logFeaEvent', esito: 'audit-non-registrato' } },
        })
        const c = await sonda([fascicolo, fea])
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toBe("tracce d'audit non registrate nelle ultime 24 h: 2 (2 impronte)")
    })

    it('lettura fallita ⇒ degradato con il codice, MAI giu', async () => {
        const c = await sonda([], { app_log: { code: '57014', message: 'canceling statement due to statement timeout' } })
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toContain('57014')
    })

    it("un'eccezione dentro la lettura ⇒ degradato con il solo nome dell'errore, MAI giu", async () => {
        // Aggiunto dalla verifica di mutazione: portare a 'giu' l'esito su guasto di `misura` lasciava
        // verde ogni test, e un'eccezione qui non deve poter spegnere il sito (503).
        const rotto = {
            from: () => {
                throw new Error('boom')
            },
        } as unknown as SupabaseClient
        const c = await controlloAuditDocente(rotto, ADESSO, 'production')
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toBe('eccezione Error')
    })

    it('colonna assente (database non migrato) ⇒ ok con la nota', async () => {
        const c = await sonda([], { app_log: { code: '42703', message: 'column does not exist' } })
        expect(c.esito).toBe('ok')
        expect(c.dettaglio).toContain('42703')
    })

    // Aggiunto dalla verifica di mutazione: i tre codici di «non installato» di `CODICI_NON_INSTALLATO`.
    it.each(['42P01', 'PGRST205'])('tabella assente (%s, database non migrato) ⇒ ok con la nota', async (codice) => {
        const c = await sonda([], { app_log: { code: codice, message: 'relation does not exist' } })
        expect(c.esito).toBe('ok')
        expect(c.dettaglio).toContain(codice)
    })

    it("le costanti: 24 ore, e l'esito è proprio quello che scrivono i tre registri d'audit", () => {
        expect(FINESTRA_AUDIT_MS).toBe(24 * ORA)
        expect(ESITO_AUDIT_NON_REGISTRATO).toBe('audit-non-registrato')
        const leggi = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
        const conta = (f: string) => (leggi(f).match(/esito:\s*'audit-non-registrato'/g) ?? []).length
        expect(conta('src/lib/audit/scrittura.ts')).toBe(2)
        expect(conta('src/lib/primaria/fascicolo-rbac.ts')).toBe(1)
        expect(conta('src/lib/fea/audit.ts')).toBe(1)
    })

    it("chi scrive 'audit-non-registrato' in src/ è uno dei tre registri noti, e lo scrive a livello error", () => {
        // Un registro nuovo che usa lo stesso esito entra nel controllo da solo (il filtro non
        // guarda l'evento), ma solo se lo scrive a livello `error`. Questo test lo fa sapere a
        // chi lo aggiunge: rosso finché il file non è in questo elenco, dopo averlo verificato.
        const NOTI = ['src/lib/audit/scrittura.ts', 'src/lib/fea/audit.ts', 'src/lib/primaria/fascicolo-rbac.ts']
        const trovati: string[] = []
        const visita = (cartella: string) => {
            for (const voce of readdirSync(join(process.cwd(), cartella), { withFileTypes: true })) {
                const rel = `${cartella}/${voce.name}`
                if (voce.isDirectory()) visita(rel)
                else if (/\.(ts|tsx)$/.test(voce.name) && /'audit-non-registrato'/.test(readFileSync(join(process.cwd(), rel), 'utf8'))) {
                    trovati.push(rel)
                }
            }
        }
        visita('src')
        expect(trovati.filter((f) => f !== 'src/lib/health/controlli.ts').sort()).toEqual(NOTI)
    })
})
