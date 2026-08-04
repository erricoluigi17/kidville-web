import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    migrazioniPosteriori,
    posterioriCheContengono,
    sogliaFotografia,
    toccaLaRls,
    versioneDelFile,
} from './soglia-fotografia'

/**
 * I test del GUARD che copre il punto cieco delle fotografie.
 *
 * Girano su una cartella finta di migrazioni, non su `supabase/migrations`: un test
 * che chiedesse alla cartella vera di contenere un certo file sarebbe verde o rosso a
 * seconda di che cosa qualcun altro ha appena scritto — cioè non misurerebbe questo
 * codice. Qui i file li scrive il test, e quindi la risposta attesa è nota.
 *
 * Le prove sono di COMPORTAMENTO: nessuna cerca il nome di una funzione dentro un
 * sorgente. Il primo blocco descrive esattamente il difetto del 2026-08-04 — soglia
 * al giorno invece che al secondo — e resta rosso se qualcuno lo rimette.
 */

let CARTELLA: string

const scrivi = (nome: string, sql: string) => writeFileSync(join(CARTELLA, nome), sql, 'utf8')

beforeAll(() => {
    CARTELLA = mkdtempSync(join(tmpdir(), 'kv-soglia-'))
    // Tre file NELLO STESSO GIORNO della fotografia: uno prima dello scatto, uno dopo,
    // uno molto dopo. È il caso che il vecchio confronto per data non poteva distinguere.
    scrivi('20260801081633_prima_dello_scatto.sql', 'CREATE POLICY "p" ON public.t FOR SELECT USING (true);')
    scrivi('20260801120000_dopo_lo_scatto.sql', 'CREATE POLICY "q" ON public.t FOR SELECT USING (true);')
    scrivi('20260801235959_molto_dopo.sql', 'ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;')
    // Un file del giorno prima: non deve mai risultare posteriore.
    scrivi('20260731235959_il_giorno_prima.sql', 'CREATE POLICY "r" ON public.t FOR SELECT USING (true);')
    // Un file fuori forma: lo sorveglia un altro lock, qui non deve entrare.
    scrivi('note.sql', 'select 1;')
})

afterAll(() => {
    rmSync(CARTELLA, { recursive: true, force: true })
})

describe('soglia di una fotografia · «più recente» si misura al secondo', () => {
    it('con `generato_alle` la soglia porta ore, minuti e secondi', () => {
        expect(sogliaFotografia({ generato_il: '2026-08-01', generato_alle: '2026-08-01T10:30:25Z' })).toBe(
            '20260801103025',
        )
    })

    it('una migrazione dello STESSO GIORNO ma successiva allo scatto è posteriore', () => {
        // ⟵ È LA PROVA DEL DIFETTO. Il vecchio guard confrontava `f.slice(0, 8)` con la
        // data della fotografia: per lui nessuno di questi tre file era mai posteriore,
        // perché nessuno di loro ha una DATA maggiore del 1° agosto. Cioè il giorno in
        // cui si applica una migrazione e si rigenera la fotografia — l'unico giorno in
        // cui il guard serve — era il giorno in cui taceva.
        const soglia = sogliaFotografia({ generato_il: '2026-08-01', generato_alle: '2026-08-01T10:00:00Z' })
        expect(migrazioniPosteriori(CARTELLA, soglia)).toEqual([
            '20260801120000_dopo_lo_scatto.sql',
            '20260801235959_molto_dopo.sql',
        ])
    })

    it('una migrazione dello stesso giorno ma ANTERIORE allo scatto non è posteriore', () => {
        const soglia = sogliaFotografia({ generato_il: '2026-08-01', generato_alle: '2026-08-01T23:59:59Z' })
        expect(migrazioniPosteriori(CARTELLA, soglia)).toEqual(['20260801235959_molto_dopo.sql'])
    })

    it('senza `generato_alle` la soglia ripiega su mezzanotte: prudente, mai muta', () => {
        // Il ripiego deve sbagliare per eccesso. Con la sola data, tutte le migrazioni
        // di quel giorno risultano posteriori: si può gridare al lupo, non si può tacere.
        const soglia = sogliaFotografia({ generato_il: '2026-08-01' })
        expect(soglia).toBe('20260801000000')
        expect(migrazioniPosteriori(CARTELLA, soglia)).toEqual([
            '20260801081633_prima_dello_scatto.sql',
            '20260801120000_dopo_lo_scatto.sql',
            '20260801235959_molto_dopo.sql',
        ])
    })

    it('i file del giorno prima e quelli fuori forma restano fuori', () => {
        const soglia = sogliaFotografia({ generato_il: '2026-08-01', generato_alle: '2026-08-01T00:00:00Z' })
        const posteriori = migrazioniPosteriori(CARTELLA, soglia)
        expect(posteriori).not.toContain('20260731235959_il_giorno_prima.sql')
        expect(posteriori).not.toContain('note.sql')
    })

    it('una fotografia con un `generato_alle` illeggibile fa rumore invece di ripiegare in silenzio', () => {
        // Se ripiegasse sulla data, un campo storto diventerebbe una perdita di
        // precisione invisibile — cioè il difetto di partenza, rientrato dalla finestra.
        expect(() => sogliaFotografia({ generato_il: '2026-08-01', generato_alle: 'ieri' })).toThrow(/generato_alle/)
        expect(() => sogliaFotografia({ generato_il: 'boh' })).toThrow(/generato_il/)
    })

    it('`versioneDelFile` legge le quattordici cifre, e nient\'altro', () => {
        expect(versioneDelFile('20260704120000_baseline.sql')).toBe('20260704120000')
        expect(versioneDelFile('20260704_baseline.sql')).toBeNull()
        expect(versioneDelFile('baseline.sql')).toBeNull()
        expect(versioneDelFile('20260704120000_baseline.txt')).toBeNull()
    })

    it('`posterioriCheContengono` filtra sul contenuto, non sul nome', () => {
        const soglia = sogliaFotografia({ generato_il: '2026-08-01', generato_alle: '2026-08-01T10:00:00Z' })
        expect(posterioriCheContengono(CARTELLA, soglia, (sql) => /ENABLE ROW LEVEL SECURITY/i.test(sql))).toEqual([
            '20260801235959_molto_dopo.sql',
        ])
    })
})

describe('riconoscitore · una migrazione che cambia ciò che la fotografia della RLS contiene', () => {
    it('vede una tabella nuova che nasce protetta, senza nessun CREATE POLICY', () => {
        // ⟵ IL SECONDO PUNTO CIECO. `tabelle_rls_attiva` fa parte della fotografia:
        // accendere la RLS su una tabella la cambia, e il vecchio filtro
        // `/(CREATE|DROP|ALTER)\s+POLICY/` non ci arrivava nemmeno vicino.
        const sql = `CREATE TABLE public.nuova (id uuid primary key);
                     ALTER TABLE public.nuova ENABLE ROW LEVEL SECURITY;`
        expect(toccaLaRls(sql)).toBe(true)
    })

    it('vede una policy creata in SQL dinamico dentro un DO $$', () => {
        const sql = `DO $$ BEGIN
                       EXECUTE format('create policy %I on public.t for select using (true)', 'p');
                     END $$;`
        expect(toccaLaRls(sql)).toBe(true)
    })

    it('vede il DROP di una tabella, che porta via con sé le sue policy', () => {
        expect(toccaLaRls('DROP TABLE IF EXISTS public.vecchia;')).toBe(true)
    })

    it('vede la NASCITA di una colonna `scuola_id`', () => {
        expect(toccaLaRls('ALTER TABLE public.t ADD COLUMN IF NOT EXISTS scuola_id uuid;')).toBe(true)
        expect(toccaLaRls('CREATE TABLE public.t (\n  id uuid,\n  scuola_id uuid NOT NULL\n);')).toBe(true)
    })

    it('NON si accende per una migrazione che nomina `scuola_id` solo per usarla', () => {
        // Il confine serve: `scuola_id` compare in quasi tutte le migrazioni di questo
        // repo, e un guard rosso su tutto sarebbe rosso anche dove non si può spegnere
        // (una migrazione scritta e non ancora applicata non entra in una fotografia
        // della produzione). Un lock che non si può far tornare verde insegna il `.skip`.
        const sql = `CREATE INDEX idx_t_scuola ON public.t (scuola_id);
                     UPDATE public.t SET x = 1 WHERE scuola_id = '00000000-0000-0000-0000-000000000000';`
        expect(toccaLaRls(sql)).toBe(false)
    })

    it('NON si accende per una migrazione che non c\'entra niente', () => {
        expect(toccaLaRls('CREATE INDEX idx_a ON public.a (b);\nANALYZE public.a;')).toBe(false)
    })
})
