import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * LE DUE CODE OFFLINE DELLA PRIMARIA — registro (firme, argomenti, compiti) e appello
 * (presenze e assenze di minori).
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * Fino al 2026-09-09 `saveLocalRegistro` non compariva in `__tests__` da nessuna parte, e
 * `syncPendingAppello` non ci compare tuttora: il percorso che il docente usa quando la
 * scuola non ha campo — cioè quello che non si può riprovare guardando lo schermo — non era
 * misurato da niente.
 *
 *  (a) LA SEZIONE. In supplenza la firma è per un'ALTRA classe. La coda deve trasportare la
 *      sezione che le è stata data, senza reinterpretarla.
 *
 *  (b) LA DATA DI CONSEGNA DEI COMPITI. Il tipo della riga in coda non aveva il campo, e la
 *      POST non lo spediva. Misurato in produzione: 13 righe su 14 la valorizzano.
 *
 *  (c) IL RITENTATIVO INFINITO. Una riga rifiutata tornava `error`, ed `error` veniva
 *      ripescato insieme a `pending` a ogni riconnessione: un 400 di validazione veniva
 *      rispedito per sempre, senza che nessuno lo dicesse al docente.
 *
 *  (d) IL RIMEDIO OPPOSTO, che è il difetto di chi ha corretto (c). Buttare via TUTTO ciò che
 *      non è 5xx significa buttare via anche il 423 del registro chiuso — che esiste per
 *      essere sbloccato dal dirigente (`/api/primaria/sblocca`) — il 401 della sessione
 *      scaduta e il 403 del docente non ancora abilitato al grado. Sono rifiuti che un essere
 *      umano toglie di mezzo in minuti, e `scartato` è irreversibile e invisibile: nessun
 *      componente in `src/` legge questi due store.
 *
 *  (e) IL LOG. Una riga per firma, deduplicata a 60 secondi sul messaggio, vuol dire che
 *      trenta firme perse e una firma persa scrivono la stessa identica riga.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

type Riga = Record<string, unknown> & { id: string; sync_status: string };

/**
 * Un finto store Dexie che si comporta come quello vero nelle due cose che contano qui:
 * `anyOf` FILTRA davvero per stato, e `update` APPLICA davvero le modifiche. Senza queste due
 * un test sul ritentativo sarebbe teatro — misurerebbe le proprie asserzioni invece del ciclo.
 */
function creaStore() {
    const righe: Riga[] = [];
    return {
        righe,
        put: vi.fn(async (r: Riga) => {
            const i = righe.findIndex((x) => x.id === r.id);
            if (i >= 0) righe[i] = r; else righe.push(r);
        }),
        where: vi.fn((campo: string) => ({
            anyOf: (...stati: string[]) => ({
                toArray: async () => righe.filter((r) => stati.includes(String(r[campo]))),
            }),
        })),
        update: vi.fn(async (id: string, modifiche: Record<string, unknown>) => {
            const r = righe.find((x) => x.id === id);
            if (r) Object.assign(r, modifiche);
        }),
    };
}

const h = vi.hoisted(() => ({ logClient: vi.fn() }));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));
vi.mock('@supabase/ssr', () => ({ createBrowserClient: vi.fn() }));
vi.mock('@/lib/gallery/carica-media', () => ({ caricaMediaGalleria: vi.fn() }));

const store = vi.hoisted(() => ({
    registro: null as unknown as ReturnType<typeof creaStore>,
    appello: null as unknown as ReturnType<typeof creaStore>,
}));
vi.mock('@/lib/offline/db', () => ({
    db: {
        get primaria_registro() { return store.registro; },
        get primaria_appello() { return store.appello; },
    },
}));

import {
    saveLocalRegistro, syncPendingRegistro, saveLocalAppello, syncPendingAppello,
} from '@/lib/offline/syncEngine';

/** La classe della PAGINA e la classe davvero COPERTA: in supplenza non coincidono. */
const SEZIONE_PAGINA = 'aaaaaaaa-0000-4000-8000-000000000001';
const SEZIONE_COPERTA = 'bbbbbbbb-0000-4000-8000-000000000002';
const DOCENTE = 'cccccccc-0000-4000-8000-000000000003';
const ALUNNO = 'dddddddd-0000-4000-8000-000000000004';

let risposte: Array<{ ok: boolean; status: number } | Error> = [];
let corpiInviati: Array<Record<string, unknown>> = [];

/** Il corpo JSON della n-esima POST partita. */
const corpo = (n = 0) => corpiInviati[n];

/** I messaggi passati a `logClient`, uno per riga, nell'ordine in cui sono partiti. */
const messaggi = () => h.logClient.mock.calls.map((c) => String(c[0].messaggio));

function firmaInCoda(over: Record<string, unknown> = {}) {
    return {
        id: 'firma-1',
        section_id: SEZIONE_COPERTA,
        data: '2026-09-09',
        ora_lezione: 3,
        materia_id: null,
        argomento: 'Le frazioni',
        compiti: 'Esercizi 4 e 5',
        data_consegna_compiti: '2026-09-15',
        tipo_compresenza: 'principale',
        creato_il: '2026-09-09T08:00:00.000Z',
        ...over,
    };
}

function presenzaInCoda(over: Record<string, unknown> = {}) {
    return {
        id: `${ALUNNO}|2026-09-09`,
        section_id: SEZIONE_COPERTA,
        alunno_id: ALUNNO,
        data: '2026-09-09',
        stato: 'presente',
        aggiornato_il: '2026-09-09T08:00:00.000Z',
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    store.registro = creaStore();
    store.appello = creaStore();
    risposte = [];
    corpiInviati = [];
    window.localStorage.setItem('kv_teacher_id', DOCENTE);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        corpiInviati.push(JSON.parse(String(init.body)));
        const r = risposte.shift() ?? { ok: true, status: 200 };
        if (r instanceof Error) throw r;
        return r as Response;
    }));
});

/** Accoda SENZA che parta la sincronizzazione automatica, così i test restano deterministici. */
async function accoda(over: Record<string, unknown> = {}) {
    vi.stubGlobal('navigator', { onLine: false });
    await saveLocalRegistro(firmaInCoda(over) as never);
    vi.stubGlobal('navigator', { onLine: true });
}

async function accodaPresenza(over: Record<string, unknown> = {}) {
    vi.stubGlobal('navigator', { onLine: false });
    await saveLocalAppello(presenzaInCoda(over) as never);
    vi.stubGlobal('navigator', { onLine: true });
}

describe('(a) la coda trasporta la sezione RICEVUTA, non quella della pagina', () => {
    it('la firma di una supplenza resta agganciata alla classe coperta, dalla coda alla POST', async () => {
        await accoda({ section_id: SEZIONE_COPERTA });

        // 1. la riga accodata porta la sezione che le è stata data
        expect(store.registro.righe[0].section_id).toBe(SEZIONE_COPERTA);

        // 2. e la POST la rispedisce identica — nessuna reinterpretazione per strada
        await syncPendingRegistro();
        expect(corpo().sectionId).toBe(SEZIONE_COPERTA);
        expect(corpo().sectionId).not.toBe(SEZIONE_PAGINA);
    });
});

describe('(b) la data di consegna dei compiti arriva fino al server', () => {
    it('il campo che il docente digita è nel corpo della POST', async () => {
        await accoda({ data_consegna_compiti: '2026-09-15' });
        await syncPendingRegistro();
        expect(corpo().dataConsegnaCompiti).toBe('2026-09-15');
    });

    it('una riga accodata da una build precedente, che il campo non ce l\'ha, manda `null` e non `undefined`', async () => {
        // `undefined` sparisce da `JSON.stringify`: la chiave non esisterebbe affatto nel corpo.
        // Il ramo online per «vuoto» manda `null`, e la coda deve dire la stessa cosa.
        store.registro.righe.push(
            { ...firmaInCoda(), data_consegna_compiti: undefined, sync_status: 'pending' } as unknown as Riga,
        );
        await syncPendingRegistro();
        expect(corpo()).toHaveProperty('dataConsegnaCompiti', null);
    });
});

describe('(c) si butta via SOLO ciò che il server rifiuterà per sempre', () => {
    it('un 400 di validazione non torna MAI più in coda', async () => {
        await accoda();
        risposte = [{ ok: false, status: 400 }];
        await syncPendingRegistro();

        expect(store.registro.righe[0].sync_status).toBe('scartato');

        // La prova che «scartato» vale davvero: un secondo giro non lo ripesca nemmeno.
        corpiInviati = [];
        await syncPendingRegistro();
        expect(corpiInviati).toHaveLength(0);
    });

    it('404, 409, 413 e 422 sono definitivi quanto il 400: è il CORPO a essere sbagliato', async () => {
        for (const stato of [404, 409, 413, 422]) {
            store.registro = creaStore();
            await accoda();
            risposte = [{ ok: false, status: stato }];
            await syncPendingRegistro();
            expect(store.registro.righe[0].sync_status, `stato ${stato}`).toBe('scartato');
        }
    });

    it('uno stato che non sappiamo leggere si RITENTA, non si butta: buttare è irreversibile', async () => {
        // 418 non lo produce nessuna nostra route. È qui apposta: la politica predefinita per
        // ciò che non è classificato dev'essere quella RECUPERABILE, perché un ritentativo di
        // troppo è rumore e uno scarto di troppo è la firma di un docente persa per sempre.
        await accoda();
        risposte = [{ ok: false, status: 418 }];
        await syncPendingRegistro();

        expect(store.registro.righe[0].sync_status).toBe('error');
        expect(store.registro.righe[0].tentativi).toBe(1);
    });

    it('un 503 resta ritentabile: il corpo è valido, è il server che non può adesso', async () => {
        await accoda();
        risposte = [{ ok: false, status: 503 }];
        await syncPendingRegistro();

        expect(store.registro.righe[0].sync_status).toBe('error');
        expect(store.registro.righe[0].tentativi).toBe(1);

        // e infatti il giro dopo ci riprova
        corpiInviati = [];
        risposte = [{ ok: true, status: 200 }];
        await syncPendingRegistro();
        expect(corpiInviati).toHaveLength(1);
        expect(store.registro.righe[0].sync_status).toBe('synced');
    });

    it('anche il ritentabile ha una fine: al quinto «no» del server la riga si ferma', async () => {
        await accoda();
        for (let giro = 1; giro <= 5; giro++) {
            risposte = [{ ok: false, status: 500 }];
            await syncPendingRegistro();
        }
        expect(store.registro.righe[0].tentativi).toBe(5);
        expect(store.registro.righe[0].sync_status).toBe('scartato');

        // Il sesto giro non parte più: è questa la differenza fra «ritenta» e «per sempre».
        corpiInviati = [];
        await syncPendingRegistro();
        expect(corpiInviati).toHaveLength(0);
    });

    it('la rete che cade NON consuma un tentativo: il server non ha detto niente', async () => {
        await accoda();
        risposte = [Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' })];
        await syncPendingRegistro();

        expect(store.registro.righe[0].sync_status).toBe('pending');
        expect(store.registro.righe[0].tentativi).toBe(0);
    });

    it('una fetch che lancia sulla prima riga non lascia le altre non tentate', async () => {
        await accoda({ id: 'firma-1' });
        await accoda({ id: 'firma-2' });
        risposte = [new TypeError('Failed to fetch'), { ok: true, status: 200 }];

        await syncPendingRegistro();

        expect(corpiInviati).toHaveLength(2);
        expect(store.registro.righe[1].sync_status).toBe('synced');
    });
});

describe('(d) il rifiuto che un essere umano toglie di mezzo NON si butta via', () => {
    it('il 423 del registro chiuso aspetta il dirigente, e quando sblocca la firma arriva', async () => {
        // Il registro si chiude dopo due giorni (`timelock.ts`, DEFAULT_CLASSE_ORALE = 2) e una
        // riga può attraversare la scadenza MENTRE STA IN CODA — è offline che la coda si
        // riempie. `/api/primaria/sblocca` esiste letteralmente perché quel 423 diventi un 200.
        await accoda();
        risposte = [{ ok: false, status: 423 }];
        await syncPendingRegistro();

        expect(store.registro.righe[0].sync_status).toBe('error');

        // il dirigente sblocca lo slot: il giro dopo la firma passa
        corpiInviati = [];
        risposte = [{ ok: true, status: 200 }];
        await syncPendingRegistro();
        expect(corpiInviati).toHaveLength(1);
        expect(store.registro.righe[0].sync_status).toBe('synced');
    });

    it('il 423 ripetuto non consuma il tetto: dopo sei giri la firma è ancora lì', async () => {
        // Il tetto esiste per i «no» che NON sappiamo spiegare (un 500 da CHECK violato risponde
        // 500 per sempre). Un 423 lo sappiamo spiegare, e sappiamo chi lo toglie: attendere non
        // è scommettere. Se consumasse il tetto, sei riconnessioni in un minuto brucerebbero
        // l'attesa di un dirigente che risponde in giornata.
        await accoda();
        for (let giro = 1; giro <= 6; giro++) {
            risposte = [{ ok: false, status: 423 }];
            await syncPendingRegistro();
        }
        expect(store.registro.righe[0].tentativi).toBe(0);
        expect(store.registro.righe[0].sync_status).toBe('error');
    });

    it('il 403 del docente non abilitato al grado aspetta l\'amministratore', async () => {
        await accoda();
        risposte = [{ ok: false, status: 403 }];
        await syncPendingRegistro();

        expect(store.registro.righe[0].sync_status).toBe('error');
        expect(store.registro.righe[0].tentativi).toBe(0);
    });

    it('il 401 della sessione scaduta ferma il flush invece di bruciare tutta la coda', async () => {
        // `kv_teacher_id` sopravvive alla sessione scaduta, e con `ALLOW_HEADER_IDENTITY=false`
        // l'header `x-user-id` è ignorato: al ritorno della rete OGNI riga prende 401. Se
        // ognuna consumasse una POST sarebbe la tempesta; se ognuna finisse `scartato` sarebbe
        // la mattinata di una scuola buttata via. Si spedisce una volta e ci si ferma.
        await accoda({ id: 'firma-1' });
        await accoda({ id: 'firma-2' });
        risposte = [{ ok: false, status: 401 }];

        await syncPendingRegistro();

        expect(corpiInviati).toHaveLength(1);
        expect(store.registro.righe[0].sync_status).toBe('pending');
        expect(store.registro.righe[1].sync_status).toBe('pending');
    });
});

describe('(e) il log conta, invece di ripetersi', () => {
    it('tre firme rifiutate scrivono UNA riga col conteggio, non tre righe identiche', async () => {
        // Il throttle di `logClient` deduplica su `evento|messaggio|stato` per 60 secondi: tre
        // righe identiche sarebbero UNA riga in `app_log`, e «tre firme perse» sarebbe
        // indistinguibile da «una firma persa». Il numero è struttura, non contenuto.
        await accoda({ id: 'firma-1' });
        await accoda({ id: 'firma-2' });
        await accoda({ id: 'firma-3' });
        risposte = [{ ok: false, status: 400 }, { ok: false, status: 400 }, { ok: false, status: 400 }];

        await syncPendingRegistro();

        expect(h.logClient).toHaveBeenCalledTimes(1);
        expect(messaggi()[0]).toMatch(/sync-registro-primaria-flush: /);
        expect(messaggi()[0]).toMatch(/scartate=3/);
        expect(messaggi()[0]).toMatch(/stati=400x3/);
    });

    it('il flush che consegna lo dice: «nessun log» non è più ambiguo', async () => {
        // AGENTS.md §5 — con i soli errori, «nessun log» non distingue «tutto ok» da «non è mai
        // partito niente». Una riga per flush che ha lavorato, zero righe quando la coda è vuota.
        await accoda({ id: 'firma-1' });
        await accoda({ id: 'firma-2' });

        await syncPendingRegistro();

        expect(h.logClient).toHaveBeenCalledTimes(1);
        expect(messaggi()[0]).toMatch(/consegnate=2/);
        expect(messaggi()[0]).toMatch(/scartate=0/);
    });

    it('la coda vuota non scrive niente: un flush a vuoto parte a ogni evento `online`', async () => {
        await syncPendingRegistro();
        expect(h.logClient).not.toHaveBeenCalled();
    });

    it('la perdita è `error`, l\'attesa è `warn`', async () => {
        await accoda();
        risposte = [{ ok: false, status: 400 }];
        await syncPendingRegistro();
        expect(h.logClient.mock.calls[0][0].livello).toBe('error');

        vi.clearAllMocks();
        store.registro = creaStore();
        await accoda();
        risposte = [{ ok: false, status: 423 }];
        await syncPendingRegistro();
        expect(h.logClient.mock.calls[0][0].livello).toBe('warn');
    });

    it('lo STATO non viaggia nel campo `stato`, o la politica dei livelli lo sopprimerebbe', async () => {
        // `livelloEvento` (client.ts) scarta gli eventi con uno `stato` 4xx ordinario, perché
        // quelli il server li ha già registrati. Ma qui l'evento non è «il server ha detto
        // 400»: è «una firma è stata buttata via», e quello il server non lo sa. Se finisse
        // nel campo `stato`, l'unica riga che racconta la perdita non partirebbe mai.
        await accoda();
        risposte = [{ ok: false, status: 400 }];
        await syncPendingRegistro();

        for (const [evento] of h.logClient.mock.calls) {
            expect(evento).not.toHaveProperty('stato', 400);
        }
    });

    it('la rete caduta è distinguibile da un rifiuto del server', async () => {
        await accoda();
        risposte = [Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' })];
        await syncPendingRegistro();

        expect(messaggi().join(' | ')).toMatch(/rete-caduta=1/);
        expect(messaggi().join(' | ')).toMatch(/errori=TypeError/);
    });
});

describe('(f) la coda dell\'APPELLO: presenze e assenze, stessa politica', () => {
    it('la presenza accodata arriva al server com\'era', async () => {
        await accodaPresenza();
        await syncPendingAppello();

        expect(corpo().sectionId).toBe(SEZIONE_COPERTA);
        expect(corpo().alunnoId).toBe(ALUNNO);
        expect(corpo().stato).toBe('presente');
        expect(store.appello.righe[0].sync_status).toBe('synced');
    });

    it('un 400 la scarta, e non torna più', async () => {
        await accodaPresenza();
        risposte = [{ ok: false, status: 400 }];
        await syncPendingAppello();

        expect(store.appello.righe[0].sync_status).toBe('scartato');
        corpiInviati = [];
        await syncPendingAppello();
        expect(corpiInviati).toHaveLength(0);
    });

    it('un 403 la TIENE: l\'abilitazione al grado si sistema lato server in minuti', async () => {
        // `saveLocalAppello` è chiamata anche dal ramo ONLINE della pagina, nel `catch` di un
        // `!res.ok`: un 403 arriva in coda e — se `scartato` fosse la risposta — verrebbe
        // distrutto al flush immediato che `saveLocalAppello` stessa fa partire.
        await accodaPresenza();
        risposte = [{ ok: false, status: 403 }];
        await syncPendingAppello();

        expect(store.appello.righe[0].sync_status).toBe('error');
        expect(store.appello.righe[0].tentativi).toBe(0);
    });

    it('un 503 la ritenta, e il tetto vale anche qui', async () => {
        await accodaPresenza();
        for (let giro = 1; giro <= 4; giro++) {
            risposte = [{ ok: false, status: 503 }];
            await syncPendingAppello();
        }
        expect(store.appello.righe[0].sync_status).toBe('error');
        expect(store.appello.righe[0].tentativi).toBe(4);

        risposte = [{ ok: false, status: 503 }];
        await syncPendingAppello();
        expect(store.appello.righe[0].sync_status).toBe('scartato');
        expect(store.appello.righe[0].tentativi).toBe(5);
    });

    it('la rete che cade non consuma un tentativo nemmeno qui', async () => {
        await accodaPresenza();
        risposte = [Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' })];
        await syncPendingAppello();

        expect(store.appello.righe[0].sync_status).toBe('pending');
        expect(store.appello.righe[0].tentativi).toBe(0);
    });

    it('il 401 ferma anche il flush dell\'appello', async () => {
        await accodaPresenza({ id: 'p-1' });
        await accodaPresenza({ id: 'p-2' });
        risposte = [{ ok: false, status: 401 }];

        await syncPendingAppello();

        expect(corpiInviati).toHaveLength(1);
        expect(store.appello.righe[1].sync_status).toBe('pending');
    });

    it('il conteggio dell\'appello è suo, distinto da quello del registro', async () => {
        await accodaPresenza();
        risposte = [{ ok: false, status: 400 }];
        await syncPendingAppello();

        expect(h.logClient).toHaveBeenCalledTimes(1);
        expect(messaggi()[0]).toMatch(/sync-appello-primaria-flush: /);
        expect(messaggi()[0]).toMatch(/scartate=1/);
    });
});
