import { describe, it, expect } from 'vitest';
import {
    conContesto, contesto, impostaUtente, impostaPayload,
    inLogger, entraNelLogger,
} from '@/lib/logging/context';

/** Cede il controllo al loop degli eventi: senza, la "concorrenza" dei test è finta. */
const cedi = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ⚠️ `entraNelLogger` INGHIOTTE i rigetti (vedi la sua doc: una unhandled rejection abbatte
 * il processo Node). Quindi un `expect` che fallisce DENTRO la sua callback verrebbe ingoiato
 * e il test resterebbe verde a torto: là dentro si CATTURA, e si asserisce FUORI.
 */

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

    it('la guardia di rientranza impedisce la ricorsione del logger', async () => {
        await conContesto({ requestId: 'r4', path: '/api/w' }, async () => {
            expect(inLogger()).toBe(false);
            await entraNelLogger(async () => {
                expect(inLogger()).toBe(true);
            });
            expect(inLogger()).toBe(false);
        });
    });

    it('restituisce il valore di ritorno di fn', async () => {
        // Lock: `als.run(store, () => { fn(); })` passerebbe tutto il resto della suite e
        // romperebbe tutte le 239 route (ogni handler restituirebbe undefined).
        const out = await conContesto({ requestId: 'r-out', path: '/api/x' }, async () => 42);
        expect(out).toBe(42);
    });

    it('NON ingoia gli errori di fn (il contesto osserva, non interferisce)', async () => {
        await expect(
            conContesto({ requestId: 'r-err', path: '/api/x' }, async () => {
                throw new Error('errore della route');
            }),
        ).rejects.toThrow('errore della route');
    });
});

/**
 * Il path NON è un dato innocuo: in questo repo il token del modulo pubblico è un
 * SEGMENTO di path (`/m/[token]`) e la query string trasporta `?userId=`, `?email=`.
 * La normalizzazione sta in `conContesto`, non nel chiamante: un chiamante che se ne
 * dimentica scriverebbe una credenziale in ogni riga di log della richiesta.
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
 * Il requestId arriva da un header (`x-request-id`, `x-vercel-id`): è input del CLIENT.
 * Finisce in ogni riga di un formato A RIGHE, quindi un `\n` nel valore non è un carattere
 * strano: è una riga di log FALSA, scritta da chi fa la richiesta.
 */
describe('contesto — il requestId non è fidato', () => {
    it('un id con a capo non forgia righe di log: viene sostituito', async () => {
        const forgiato = 'r1\nlivello=error rid=admin messaggio=fuga di dati';
        await conContesto({ requestId: forgiato, path: '/api/x' }, async () => {
            const rid = contesto()!.requestId;
            expect(rid).not.toContain('\n');
            expect(rid).not.toContain('livello=error');
            expect(rid).toMatch(UUID);
        });
    });

    it('sostituisce anche gli id lunghissimi e quelli vuoti', async () => {
        await conContesto({ requestId: 'x'.repeat(5_000), path: '/api/x' }, async () => {
            expect(contesto()!.requestId).toMatch(UUID);
        });
        await conContesto({ requestId: '', path: '/api/x' }, async () => {
            expect(contesto()!.requestId).toMatch(UUID);
        });
    });

    it('conserva un id plausibile (x-vercel-id ha `:` e `-`)', async () => {
        const vercel = 'fra1::iad1-1752345678901-abcdef123456';
        await conContesto({ requestId: vercel, path: '/api/x' }, async () => {
            expect(contesto()!.requestId).toBe(vercel);
        });
    });
});

/**
 * L'isolamento sotto concorrenza è il perno di tutto il sistema su Fluid Compute: più
 * richieste condividono lo stesso processo Node. Non basta verificare l'INSIEME degli id
 * visti (resterebbe verde con implementazioni rotte): ogni catena deve vedere IL PROPRIO.
 */
describe('contesto — isolamento sotto scrittura concorrente', () => {
    it('due richieste concorrenti NON si contaminano: ognuna vede il PROPRIO id', async () => {
        const visto: Record<string, string> = {};
        const richiesta = (id: string, attesa: number) =>
            conContesto({ requestId: id, path: '/api/c' }, async () => {
                await cedi(attesa);
                visto[id] = contesto()!.requestId;
            });
        await Promise.all([richiesta('A', 20), richiesta('B', 5), richiesta('C', 10)]);
        expect(visto).toEqual({ A: 'A', B: 'B', C: 'C' });
    });

    it('tre richieste che SCRIVONO a turno non si contaminano', async () => {
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
 * Lo store consegnato da `contesto()` è di sola lettura: se un call-site potesse scrivere
 * `contesto()!.payload = { body: await req.json() }` aggirerebbe redazione, cap e slot — e
 * l'emittente ha l'ordine di NON ri-redigere quel campo. La rete è il TIPO (costo a runtime
 * zero): il gate è `npx tsc --noEmit`, che fallisce se questi `@ts-expect-error` diventano
 * inutili — cioè se qualcuno toglie `Readonly`.
 */
describe('contesto — lo store consegnato è di sola lettura (lock di tipo)', () => {
    it('non si può scrivere né l\'identità né il payload dall\'esterno', async () => {
        await conContesto({ requestId: 'r-ro', path: '/api/x' }, async () => {
            const c = contesto()!;
            const scrittureVietate = () => {
                // @ts-expect-error — readonly: l'identità si scrive solo con impostaUtente
                c.userId = 'utente-sbagliato';
                // @ts-expect-error — readonly: il payload si scrive solo con impostaPayload
                c.payload = { body: { email: 'mario.rossi@example.com' } };
                // @ts-expect-error — readonly anche nello slot: niente PII grezza a valle
                c.payload!.body = { email: 'mario.rossi@example.com' };
            };
            // Non si esegue: il gate è il typecheck, non il runtime (lo store NON è congelato).
            expect(typeof scrittureVietate).toBe('function');
            expect(c.userId).toBeUndefined();
        });
    });
});

/**
 * Il payload resta in RAM per tutta la richiesta: un import da 5.000 record non può restarci
 * intero, e una route che chiama parseData dieci volte non può accumulare dieci slot.
 */
describe('contesto — il payload è redatto e limitato', () => {
    it('redige il payload al deposito: nessun dato personale grezzo nel contesto', async () => {
        await conContesto({ requestId: 'r8', path: '/api/x' }, async () => {
            impostaPayload('body', { email: 'mario.rossi@example.com', descrizione: 'crisi epilettica' });
            const p = contesto()?.payload as { body: Record<string, unknown> };
            expect(JSON.stringify(p)).not.toContain('mario.rossi@example.com');
            expect(JSON.stringify(p)).not.toContain('crisi epilettica');
            expect(p.body.descrizione).toBe('[redatto:str/16]');
        });
    });

    it('SOSTITUISCE lo slot che sfora il tetto (non lo tiene in RAM)', async () => {
        await conContesto({ requestId: 'r11', path: '/api/x' }, async () => {
            // 5.000 record: `redact` da solo ne terrebbe comunque 20 (≈2.500 caratteri), che è
            // già più di quanto serva a capire cosa si stava tentando. Il tetto li butta.
            const record = { tipo: 'x'.repeat(100), anno: 2026 };
            impostaPayload('body', { righe: Array.from({ length: 5_000 }, () => record) });
            expect(contesto()!.payload!.body).toBe('[payload-troppo-grande]');
        });
    });

    it('CONSERVA lo slot che sta sotto il tetto (il cap non è incondizionato)', async () => {
        await conContesto({ requestId: 'r11b', path: '/api/x' }, async () => {
            const record = { tipo: 'x'.repeat(100), anno: 2026 };
            impostaPayload('body', { righe: Array.from({ length: 10 }, () => record) });
            const body = contesto()!.payload!.body as { righe: unknown[] };
            expect(Array.isArray(body.righe)).toBe(true);
            expect(body.righe).toHaveLength(10);
            expect(body.righe[0]).toEqual({ tipo: 'x'.repeat(100), anno: 2026 });
        });
    });

    it('non conserva più di 4 slot, e dice QUANTI ne ha scartati', async () => {
        await conContesto({ requestId: 'r9', path: '/api/x' }, async () => {
            impostaPayload('body', { tipo: 'a' });
            impostaPayload('query', { tipo: 'b' });
            impostaPayload('params', { tipo: 'c' });
            impostaPayload('multipart', { tipo: 'd' });
            impostaPayload('quinto', { tipo: 'e' });
            impostaPayload('sesto', { tipo: 'f' });
            const p = contesto()!.payload!;
            const slot = Object.keys(p).filter((k) => k !== '[…]');
            expect(slot).toEqual(['body', 'query', 'params', 'multipart']);
            expect(p['[…]']).toBe('[+2 slot scartati]');
        });
    });

    it('uno slot già presente si può sempre aggiornare (l\'ultimo vince)', async () => {
        await conContesto({ requestId: 'r10', path: '/api/x' }, async () => {
            impostaPayload('body', { tipo: 'primo' });
            impostaPayload('body', { tipo: 'secondo' });
            expect(contesto()?.payload).toEqual({ body: { tipo: 'secondo' } });
        });
    });

    it('il payload ha prototipo nullo: `__proto__` è uno slot, non il prototipo', async () => {
        await conContesto({ requestId: 'r-proto', path: '/api/x' }, async () => {
            impostaPayload('__proto__', { tipo: 'ostile' });
            const p = contesto()!.payload!;
            // Su un oggetto letterale `p['__proto__'] = …` invocherebbe il SETTER del
            // prototipo: nessuna chiave propria, e lo slot sparirebbe in silenzio.
            expect(Object.hasOwn(p, '__proto__')).toBe(true);
            expect(({} as Record<string, unknown>).tipo).toBeUndefined();
        });
    });

    it('una chiave ereditata (`toString`) non aggira il conteggio degli slot', async () => {
        await conContesto({ requestId: 'r-eredita', path: '/api/x' }, async () => {
            impostaPayload('body', { tipo: 'a' });
            impostaPayload('query', { tipo: 'b' });
            impostaPayload('params', { tipo: 'c' });
            impostaPayload('multipart', { tipo: 'd' });
            // Con `dove in payload` su un oggetto letterale, `'toString' in payload` è true:
            // lo slot verrebbe scritto come se esistesse già, sforando il tetto.
            impostaPayload('toString', { tipo: 'e' });
            const p = contesto()!.payload!;
            expect(Object.hasOwn(p, 'toString')).toBe(false);
            expect(p['[…]']).toBe('[+1 slot scartati]');
        });
    });
});

describe('guardia di rientranza', () => {
    it('scarta l\'emissione annidata (senza guardia sarebbe ricorsione infinita)', async () => {
        let emissioni = 0;
        const annidate: unknown[] = [];
        const emetti = async (): Promise<string | undefined> =>
            entraNelLogger(async () => {
                emissioni++;
                // Il logger fallisce e prova a loggare il proprio errore: va scartato.
                annidate.push(await emetti());
                return 'ok';
            });

        await conContesto({ requestId: 'r12', path: '/api/x' }, async () => {
            expect(await emetti()).toBe('ok');
        });
        expect(emissioni).toBe(1);
        expect(annidate).toEqual([undefined]);
    });

    it('protegge ANCHE fuori da una richiesta (cron, boot)', async () => {
        let emissioni = 0;
        const dentro: boolean[] = [];
        const annidate: unknown[] = [];
        const emetti = async (): Promise<string | undefined> =>
            entraNelLogger(async () => {
                emissioni++;
                dentro.push(inLogger());
                annidate.push(await emetti());
                return 'ok';
            });

        expect(contesto()).toBeUndefined();
        expect(await emetti()).toBe('ok');
        expect(emissioni).toBe(1);
        expect(dentro).toEqual([true]);
        expect(annidate).toEqual([undefined]);
        expect(inLogger()).toBe(false);
    });

    it('NON scarta due emissioni sorelle della stessa richiesta', async () => {
        // Regressione: con una guardia a flag sullo store condiviso, la seconda `logga()` di un
        // `Promise.all` vedrebbe il flag della prima e verrebbe scartata in silenzio. La
        // rientranza è ANTENATO→DISCENDENTE, non "due log nello stesso istante".
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

    it('NON rigetta mai: una unhandled rejection abbatterebbe il processo', async () => {
        // Il chiamante naturale è `void entraNelLogger(…)`: una promise rifiutata senza `.catch`
        // termina il processo Node — peggio del 500 che questo modulo esiste per evitare.
        await conContesto({ requestId: 'r14', path: '/api/x' }, async () => {
            const esito = await entraNelLogger(async () => {
                throw new Error('insert su app_log fallito');
            });
            expect(esito).toBeUndefined();
            // …e la guardia si è comunque richiusa.
            expect(inLogger()).toBe(false);
        });
    });

    it('non lancia MAI in modo sincrono, nemmeno se fn lancia sincrono', async () => {
        // `() => { throw … }` ha tipo `() => never`: passa il typecheck di `() => Promise<T>`.
        // Se il throw uscisse sincrono, un `void entraNelLogger(…)` lo scaricherebbe nella route.
        const esplode = (): Promise<string> => { throw new Error('boom sincrono'); };
        let promessa: Promise<string | undefined> | undefined;
        expect(() => { promessa = entraNelLogger(esplode); }).not.toThrow();
        await expect(promessa).resolves.toBeUndefined();
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
