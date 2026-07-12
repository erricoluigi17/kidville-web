import { describe, it, expect } from 'vitest';
import {
    conContesto, contesto, impostaUtente, impostaPayload,
    inLogger, entraNelLogger,
} from '@/lib/logging/context';

/** Cede il controllo al loop degli eventi: senza, la "concorrenza" dei test è finta. */
const cedi = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('contesto di richiesta', () => {
    it('fuori da una richiesta è undefined (non lancia)', () => {
        expect(contesto()).toBeUndefined();
    });

    it('dentro conContesto espone requestId e path', async () => {
        await conContesto({ requestId: 'r1', path: '/api/x' }, async () => {
            expect(contesto()?.requestId).toBe('r1');
            expect(contesto()?.path).toBe('/api/x');
        });
    });

    it('impostaUtente arricchisce il contesto DELLA richiesta corrente', async () => {
        await conContesto({ requestId: 'r2', path: '/api/y' }, async () => {
            impostaUtente({ userId: 'u1', ruolo: 'educator', scuolaId: 's1' });
            expect(contesto()?.userId).toBe('u1');
            expect(contesto()?.ruolo).toBe('educator');
            expect(contesto()?.scuolaId).toBe('s1');
        });
    });

    it('impostaPayload conserva l\'ultimo payload validato', async () => {
        await conContesto({ requestId: 'r3', path: '/api/z' }, async () => {
            impostaPayload('body', { tipo: 'assenza' });
            expect(contesto()?.payload).toEqual({ body: { tipo: 'assenza' } });
        });
    });

    it('due richieste concorrenti NON si contaminano', async () => {
        const visto: string[] = [];
        const richiesta = (id: string, attesa: number) =>
            conContesto({ requestId: id, path: '/api/c' }, async () => {
                await cedi(attesa);
                visto.push(contesto()!.requestId);
            });
        await Promise.all([richiesta('A', 20), richiesta('B', 5), richiesta('C', 10)]);
        expect(visto.sort()).toEqual(['A', 'B', 'C']);
    });

    it('la guardia di rientranza impedisce la ricorsione del logger', async () => {
        await conContesto({ requestId: 'r4', path: '/api/w' }, async () => {
            expect(inLogger()).toBe(false);
            await entraNelLogger(async () => {
                expect(inLogger()).toBe(true);
            });
            expect(inLogger()).toBe(false);
        });
    });
});

/**
 * Il path NON è un dato innocuo: in questo repo il token del modulo pubblico è un
 * SEGMENTO di path (`/m/[token]`) e la query string trasporta `?userId=`, `?email=`.
 * La normalizzazione sta in `conContesto`, non nel chiamante: un chiamante che se ne
 * dimentica scriverebbe una credenziale nei log di ogni riga della richiesta.
 */
describe('contesto — il path è sempre ridotto a pattern', () => {
    it('taglia la query string e maschera il token del modulo pubblico', async () => {
        await conContesto(
            { requestId: 'x', path: '/m/tok_live_9f8e7d6c5b4a3210?userId=123' },
            async () => {
                expect(contesto()?.path).toBe('/m/[tok]');
                expect(contesto()?.path).not.toContain('tok_live');
                expect(contesto()?.path).not.toContain('userId');
            },
        );
    });

    it('maschera gli uuid nel path (il token pubblico è un randomUUID)', async () => {
        const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
        await conContesto(
            { requestId: 'x', path: `/api/public/forms/${uuid}/submit` },
            async () => {
                expect(contesto()?.path).toBe('/api/public/forms/[id]/submit');
            },
        );
    });

    it('non mutila le route vere (segmenti lunghi ma senza cifre)', async () => {
        await conContesto({ requestId: 'x', path: '/api/medical-certificates' }, async () => {
            expect(contesto()?.path).toBe('/api/medical-certificates');
        });
    });

    it('non tiene un riferimento all\'oggetto del chiamante', async () => {
        const iniziale = { requestId: 'r5', path: '/api/x' };
        await conContesto(iniziale, async () => {
            impostaUtente({ userId: 'u9' });
            expect(contesto()?.userId).toBe('u9');
        });
        // Se lo store fosse l'oggetto del chiamante, `iniziale` sarebbe stato mutato.
        expect(iniziale).toEqual({ requestId: 'r5', path: '/api/x' });
    });
});

/**
 * L'isolamento sotto concorrenza è il perno di tutto il sistema su Fluid Compute: più
 * richieste condividono lo stesso processo Node. Qui ogni richiesta SCRIVE nel proprio
 * contesto mentre le altre sono sospese, e verifica di non vedere i dati delle altre.
 */
describe('contesto — isolamento sotto scrittura concorrente', () => {
    it('tre richieste che scrivono a turno non si contaminano', async () => {
        const esito: Record<string, unknown> = {};

        const richiesta = (id: string, ritardo: number) =>
            conContesto({ requestId: id, path: `/api/${id}` }, async () => {
                await cedi(ritardo);
                impostaUtente({ userId: `utente-${id}`, ruolo: id, scuolaId: `scuola-${id}` });
                await cedi(ritardo);
                impostaPayload('body', { tipo: id });
                await cedi(ritardo);
                const c = contesto()!;
                esito[id] = {
                    requestId: c.requestId,
                    path: c.path,
                    userId: c.userId,
                    ruolo: c.ruolo,
                    scuolaId: c.scuolaId,
                    payload: c.payload,
                };
            });

        await Promise.all([richiesta('a', 15), richiesta('b', 1), richiesta('c', 7)]);

        for (const id of ['a', 'b', 'c']) {
            expect(esito[id]).toEqual({
                requestId: id,
                path: `/api/${id}`,
                userId: `utente-${id}`,
                ruolo: id,
                scuolaId: `scuola-${id}`,
                payload: { body: { tipo: id } },
            });
        }
    });

    it('non lascia residui sulla catena del chiamante (regola: mai enterWith)', async () => {
        await conContesto({ requestId: 'r-cola', path: '/api/x' }, async () => {
            expect(contesto()?.requestId).toBe('r-cola');
        });
        // Con `als.enterWith` il contesto resterebbe attaccato alla catena corrente e
        // colerebbe sulla richiesta successiva servita dallo stesso processo.
        expect(contesto()).toBeUndefined();
    });

    it('una richiesta non vede il contesto di una richiesta annidata conclusa', async () => {
        await conContesto({ requestId: 'esterna', path: '/api/e' }, async () => {
            impostaUtente({ userId: 'u-esterna' });
            await conContesto({ requestId: 'interna', path: '/api/i' }, async () => {
                impostaUtente({ userId: 'u-interna' });
                expect(contesto()?.requestId).toBe('interna');
            });
            expect(contesto()?.requestId).toBe('esterna');
            expect(contesto()?.userId).toBe('u-esterna');
        });
    });
});

describe('contesto — impostaUtente e impostaPayload non lanciano mai', () => {
    it('fuori da una richiesta sono no-op silenziosi', () => {
        expect(() => impostaUtente({ userId: 'u1' })).not.toThrow();
        expect(() => impostaPayload('body', { a: 1 })).not.toThrow();
        expect(contesto()).toBeUndefined();
    });

    it('scuolaId null non sporca il contesto', async () => {
        await conContesto({ requestId: 'r6', path: '/api/x' }, async () => {
            impostaUtente({ userId: 'u1', scuolaId: null });
            expect(contesto()?.scuolaId).toBeUndefined();
            expect(contesto()?.userId).toBe('u1');
        });
    });

    it('regge un payload ostile (getter che lancia, ciclo)', async () => {
        await conContesto({ requestId: 'r7', path: '/api/x' }, async () => {
            const ciclico: Record<string, unknown> = { a: 1 };
            ciclico.self = ciclico;
            expect(() => impostaPayload('body', ciclico)).not.toThrow();
            expect(() => impostaPayload('query', { get boom() { throw new Error('no'); } })).not.toThrow();
            expect(contesto()?.payload).toBeDefined();
        });
    });
});

/**
 * Il payload resta in RAM per tutta la richiesta: un import da 5.000 record non può
 * restarci intero, e una route che chiama parseData dieci volte non può accumulare
 * dieci slot.
 */
describe('contesto — il payload è limitato', () => {
    it('redige il payload al deposito: nessun dato personale grezzo nel contesto', async () => {
        await conContesto({ requestId: 'r8', path: '/api/x' }, async () => {
            impostaPayload('body', { email: 'mario.rossi@example.com', descrizione: 'crisi epilettica' });
            const p = contesto()?.payload as { body: Record<string, unknown> };
            expect(JSON.stringify(p)).not.toContain('mario.rossi@example.com');
            expect(JSON.stringify(p)).not.toContain('crisi epilettica');
            expect(p.body.descrizione).toBe('[redatto:str/16]');
        });
    });

    it('non conserva più di 4 slot, e segnala lo scarto', async () => {
        await conContesto({ requestId: 'r9', path: '/api/x' }, async () => {
            impostaPayload('body', { tipo: 'a' });
            impostaPayload('query', { tipo: 'b' });
            impostaPayload('params', { tipo: 'c' });
            impostaPayload('extra1', { tipo: 'd' });
            impostaPayload('extra2', { tipo: 'e' });
            impostaPayload('extra3', { tipo: 'f' });
            const p = contesto()!.payload!;
            const reali = Object.keys(p).filter((k) => !k.startsWith('['));
            expect(reali).toEqual(['body', 'query', 'params', 'extra1']);
            expect(Object.keys(p).length).toBeLessThanOrEqual(5);
            expect(JSON.stringify(p)).toContain('scartat');
        });
    });

    it('uno slot già presente si può sempre aggiornare (l\'ultimo vince)', async () => {
        await conContesto({ requestId: 'r10', path: '/api/x' }, async () => {
            impostaPayload('body', { tipo: 'primo' });
            impostaPayload('body', { tipo: 'secondo' });
            expect(contesto()?.payload).toEqual({ body: { tipo: 'secondo' } });
        });
    });

    it('un payload enorme non viene tenuto in RAM', async () => {
        await conContesto({ requestId: 'r11', path: '/api/x' }, async () => {
            // 5.000 record, ognuno con un campo che la lista bianca lascia in chiaro.
            const record = { tipo: 'x'.repeat(100), anno: 2026 };
            impostaPayload('body', { righe: Array.from({ length: 5_000 }, () => record) });
            const p = contesto()!.payload!;
            expect(JSON.stringify(p).length).toBeLessThan(3_000);
        });
    });
});

describe('guardia di rientranza', () => {
    it('scarta l\'emissione annidata (senza guardia sarebbe ricorsione infinita)', async () => {
        let emissioni = 0;
        const emetti = async (): Promise<string | undefined> =>
            entraNelLogger(async () => {
                emissioni++;
                // Il logger fallisce e prova a loggare il proprio errore: deve essere scartato.
                const annidata = await emetti();
                expect(annidata).toBeUndefined();
                return 'ok';
            });

        await conContesto({ requestId: 'r12', path: '/api/x' }, async () => {
            expect(await emetti()).toBe('ok');
            expect(emissioni).toBe(1);
        });
    });

    it('protegge ANCHE fuori da una richiesta (cron, boot)', async () => {
        let emissioni = 0;
        const emetti = async (): Promise<string | undefined> =>
            entraNelLogger(async () => {
                emissioni++;
                expect(inLogger()).toBe(true);
                expect(await emetti()).toBeUndefined();
                return 'ok';
            });

        expect(contesto()).toBeUndefined();
        expect(await emetti()).toBe('ok');
        expect(emissioni).toBe(1);
        expect(inLogger()).toBe(false);
    });

    it('NON scarta due emissioni sorelle della stessa richiesta', async () => {
        // Regressione: con una guardia a flag sullo store condiviso, la seconda `logga()`
        // di un `Promise.all` vedrebbe il flag della prima e verrebbe scartata in silenzio.
        // La rientranza è una relazione ANTENATO→DISCENDENTE, non "due log nello stesso istante".
        await conContesto({ requestId: 'r13', path: '/api/x' }, async () => {
            const emetti = (id: string) =>
                entraNelLogger(async () => {
                    await cedi(5);
                    return id;
                });
            const out = await Promise.all([emetti('uno'), emetti('due')]);
            expect(out).toEqual(['uno', 'due']);
        });
    });

    it('la guardia si richiude anche se l\'emissione lancia', async () => {
        await conContesto({ requestId: 'r14', path: '/api/x' }, async () => {
            await expect(
                entraNelLogger(async () => { throw new Error('insert su app_log fallito'); }),
            ).rejects.toThrow('insert su app_log fallito');
            expect(inLogger()).toBe(false);
        });
    });

    it('non lancia MAI in modo sincrono, nemmeno se fn lancia sincrono', async () => {
        // `() => { throw … }` ha tipo `() => never`: passa il typecheck di `() => Promise<T>`.
        // Se il throw uscisse sincrono, un `entraNelLogger(…).catch(…)` fire-and-forget non lo
        // prenderebbe e l'eccezione finirebbe nella route.
        const esplode = (): Promise<string> => { throw new Error('boom sincrono'); };
        let promessa: Promise<string | undefined> | undefined;
        expect(() => { promessa = entraNelLogger(esplode); }).not.toThrow();
        await expect(promessa).rejects.toThrow('boom sincrono');
        expect(inLogger()).toBe(false);
    });

    it('due richieste concorrenti non si bloccano la guardia a vicenda', async () => {
        const emesse: string[] = [];
        const richiesta = (id: string, ritardo: number) =>
            conContesto({ requestId: id, path: '/api/x' }, async () => {
                await entraNelLogger(async () => {
                    await cedi(ritardo);
                    emesse.push(id);
                });
            });
        await Promise.all([richiesta('A', 20), richiesta('B', 1), richiesta('C', 10)]);
        expect(emesse.sort()).toEqual(['A', 'B', 'C']);
    });
});
