import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA PELLE DEL GENITORE: IL COMANDO NON COMPARE FINCHÉ NON SI SA CHE IL PDF C'È.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── PERCHÉ QUESTO FILE ESISTE, VISTO CHE CE N'È GIÀ UNO SULLA SEGRETERIA ────
 *
 * Perché la guardia delle tre fasi è scritta DUE VOLTE, non una:
 *
 *     FatturaButton.tsx    →  if (caricamento || scaricabili.length === 0) return null
 *     StoricoPagamenti.tsx →  if (caricamento || scaricabili.length === 0) return null
 *
 * Condiviso è il solo MOTORE (`useFattureScaricabili`); la riga che decide se
 * rendere è DUPLICATA, e una riga duplicata si corregge in un posto solo. Fino a
 * questo file la copia del genitore — `FatturaLinks` — non aveva NESSUN test di
 * componente (`StoricoPagamenti-come-pagare.test.tsx` non la tocca). Cioè la pelle
 * su cui il fast-path storico rendeva un link a una FAMIGLIA era l'unica delle due
 * non misurata. La prova che vale è quella sul lato scoperto.
 *
 * ─── IL DIFETTO, CHE ERA UN FAST-PATH ───────────────────────────────────────
 *
 *     if (!fatture || fatture.length <= 1) return <a href={…}>Fattura</a>
 *
 * `fatture` è `null` anche MENTRE STA CARICANDO, e zero è minore di uno: quel ramo
 * rendeva il link sia prima di sapere se il PDF esistesse, sia quando la risposta
 * diceva che non c'è. Il genitore premeva e riceveva un 404 — o, fino a ieri, un
 * foglio disegnato al volo che sembrava una fattura.
 *
 * ─── LE TRE FASI, E LA TRAPPOLA DELLE PRIME DUE ─────────────────────────────
 *
 *  1. IN CARICAMENTO → niente.
 *  2. NESSUN PDF VERIFICATO (o elenco vuoto) → niente.
 *  3. ALMENO UNO → «Apri» (inline) e «Scarica» (`download=1`).
 *
 * ⚠️ LA FASE 1 E LA FASE 2 RENDONO LA STESSA COSA — NIENTE. Una prova che
 * consegnasse la risposta e guardasse subito lo schermo starebbe misurando la fase
 * 1 credendo di misurare la fase 2, e resterebbe verde col fast-path rimesso dopo
 * il caricamento. Come si distinguono davvero sta scritto su `consegnaEAssorbi`.
 */

/** I testi italiani reali: il mock di next-intl risolve sui cataloghi (vedi `test/setup.ts`). */
const CATALOGO = JSON.parse(
    readFileSync(join(process.cwd(), 'messages/it/pagamenti.json'), 'utf8'),
) as Record<string, string>;
const testo = (chiave: string): string => CATALOGO[chiave] ?? `pagamenti.${chiave}`;

// Il realtime di Supabase non deve toccare la rete: canale finto, `removeChannel` no-op.
vi.mock('@/lib/supabase/browser-client', () => {
    const channel = {
        on() { return channel; },
        subscribe() { return channel; },
    };
    return { getSupabase: () => ({ channel: () => channel, removeChannel: () => {} }) };
});

import { StoricoPagamenti } from '@/components/features/parent/pagamenti/StoricoPagamenti';

const UTENTE = 'u-1';
/** Il pagamento IN PROVA. */
const PAG = 'p1';
/** Il pagamento DI CONTROLLO: il suo PDF c'è sempre. Vedi `consegnaEAssorbi`. */
const SENT = 'p2';

const F1 = 'cccccccc-0000-4000-8000-000000000021';
const F2 = 'cccccccc-0000-4000-8000-000000000022';
const FS = 'cccccccc-0000-4000-8000-0000000000ff';

/** Gli indirizzi attesi, SCRITTI A MANO: costruirli con `urlFattura` sarebbe tautologico. */
const APRI_F1 = `/api/pagamenti/fattura?pagamento_id=${PAG}&userId=${UTENTE}&fattura_id=${F1}`;
const SCARICA_F1 = `${APRI_F1}&download=1`;
const APRI_F2 = `/api/pagamenti/fattura?pagamento_id=${PAG}&userId=${UTENTE}&fattura_id=${F2}`;
const SCARICA_F2 = `${APRI_F2}&download=1`;

/**
 * Una voce già FATTURATA: senza `fattura_stato: 'emessa'` la card non monta nemmeno
 * `FatturaLinks`, e la prova misurerebbe il nulla.
 *
 * ⚠️ Dati SINTETICI, repo pubblico: il bambino non esiste e quello non è un codice
 * fiscale. Qui non entra nessun dato reale di un minore.
 */
const VOCE = {
    id: PAG,
    alunno_id: 'a1',
    scuola_id: 'sede-1',
    descrizione: 'Retta Settembre',
    importo: 250,
    importo_pagato: 250,
    sconto: 0,
    scadenza: '2026-09-10',
    stato: 'pagato',
    tipo: 'singolo',
    obbligatorio: true,
    fattura_stato: 'emessa',
    causale_suggerita: null,
    alunni: { nome: 'Mara', cognome: 'Bianchi', codice_fiscale: 'AAAAAA00A00A000A' },
};

/** La voce di CONTROLLO, identica salvo l'identificativo e la descrizione. */
const VOCE_SENT = { ...VOCE, id: SENT, descrizione: 'Mensa Settembre' };

const riga = (id: string, numero: number, disponibile: boolean, etichetta: string | null = null) => ({
    id, numero, anno: 2026, quota_label: etichetta, intestatario: 'Intestatario',
    pdf_disponibile: disponibile, sdi_stato_label: 'Consegnata',
});

/** `fetch` sotto controllo: la risposta dell'ELENCO si consegna QUANDO decido io, e per QUALE pagamento. */
let consegnaPer: Record<string, ((righe: unknown[]) => void) | undefined> = {};
let chiamate: string[] = [];

beforeEach(() => {
    vi.clearAllMocks();
    chiamate = [];
    consegnaPer = {};
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request) => {
        const u = String(url);
        chiamate.push(u);
        // ⚠️ L'ORDINE DEI DUE RAMI CONTA: `/api/pagamenti/fattura/list?…` contiene
        // anche `/api/pagamenti`, e invertirli servirebbe l'elenco delle VOCI al
        // posto dell'elenco delle FATTURE — con la risposta mai sospesa, cioè senza
        // nessuna fase 1 da misurare.
        if (u.includes('/api/pagamenti/fattura/list')) {
            const quale = new URL(u, 'http://localhost').searchParams.get('pagamento_id') ?? '';
            return new Promise<Response>((risolvi) => {
                consegnaPer[quale] = (righe: unknown[]) =>
                    risolvi({ ok: true, status: 200, json: async () => ({ success: true, data: righe }) } as unknown as Response);
            });
        }
        if (u.includes('/api/pagamenti')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({ success: true, data: [VOCE, VOCE_SENT], sedi: [] }),
            } as unknown as Response);
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => null } as unknown as Response);
    }));
});
afterEach(cleanup);

const chiamateElenco = () => chiamate.filter((u) => u.includes('/api/pagamenti/fattura/list'));
/** Le ancore della fattura DI UN pagamento: il controllo e la prova non si confondono. */
const ancoreDi = (pagamento: string) =>
    [...document.querySelectorAll<HTMLAnchorElement>(`a[href*="pagamento_id=${pagamento}"]`)];

/**
 * Monta la pagina e aspetta che entrambe le card siano a schermo E che i due elenchi
 * siano stati CHIESTI: il vuoto misurato dopo è «non lo so ancora», non «non è
 * partito niente».
 */
async function montaEAspettaLaFase1(): Promise<void> {
    render(<StoricoPagamenti userId={UTENTE} />);
    expect(await screen.findByText(VOCE.descrizione)).toBeInTheDocument();
    await waitFor(() => expect(chiamateElenco()).toHaveLength(2));
}

/**
 * Consegna la risposta dell'elenco DEL PAGAMENTO IN PROVA e aspetta che sia stata
 * ASSORBITA — non «che sia stata spedita».
 *
 * ⚠️ QUI STA LA DIFFERENZA FRA MISURARE LA FASE 2 E CREDERE DI FARLO, e la strada
 * ovvia non è percorribile.
 *
 *  • Un `await Promise.resolve()` NON BASTA: fra `risolvi(…)` e lo schermo ci sono
 *    almeno due microtask (`await res.json()`, poi il `setStato` che React deve
 *    applicare). L'asserzione girerebbe con il componente ancora in FASE 1 — che
 *    rende `null` esattamente come la fase 2 — e sarebbe verde per il motivo
 *    sbagliato.
 *  • `await act(async …)` QUI NON SI PUÒ USARE, e non per gusto: il mock di
 *    next-intl (`test/setup.ts`) restituisce una `t` NUOVA a ogni render, quindi
 *    il `useCallback` di `load` cambia identità a ogni render e il suo `useEffect`
 *    rifà la GET delle voci all'infinito. `act` svuota la coda «finché non è
 *    quieta», e questa non lo diventa mai: il test va in timeout invece di
 *    fallire. (Misurato: 20 s di timeout su tutte e cinque le prove.)
 *
 * Perciò l'assorbimento si rende OSSERVABILE. Accanto al pagamento in prova ce n'è
 * uno DI CONTROLLO, il cui PDF esiste sempre: si consegnano le due risposte nello
 * stesso giro — PRIMA quella in prova — e si aspetta che compaiano i comandi del
 * CONTROLLO. Quando quelli sono nel DOM, React ha già renderizzato dopo un
 * `setStato` accodato DOPO quello del pagamento in prova: ciò che si legge sulla
 * card in prova è la sua RISPOSTA, non la sua attesa. È una prova d'ordine, non
 * un'attesa a tempo.
 */
async function consegnaEAssorbi(righe: unknown[]): Promise<void> {
    consegnaPer[PAG]?.(righe);
    consegnaPer[SENT]?.([riga(FS, 9001, true)]);
    await waitFor(() => expect(ancoreDi(SENT)).toHaveLength(2));
}

// ═════════════════════════════════════════════════════════════════════════════
describe('StoricoPagamenti · FatturaLinks — le tre fasi sulla card del genitore', () => {
    it('sospeso → nessun comando; consegnato → «Apri» e «Scarica», e `download=1` SOLO sulla seconda', async () => {
        await montaEAspettaLaFase1();

        // FASE 1 — le risposte sono in volo: niente comando, su nessuna delle due card.
        expect(ancoreDi(PAG)).toHaveLength(0);
        expect(ancoreDi(SENT)).toHaveLength(0);

        // FASE 3 — la risposta arriva e dice che il PDF è nel bucket.
        await consegnaEAssorbi([riga(F1, 1948, true)]);

        const link = ancoreDi(PAG);
        expect(link).toHaveLength(2);
        // L'ORDINE conta: prima si legge, poi si salva.
        expect(link[0]).toHaveAttribute('href', APRI_F1);
        expect(link[1]).toHaveAttribute('href', SCARICA_F1);
        // `download=1` sta su UNA sola delle due, e non è un dettaglio: su entrambe,
        // «Apri» salverebbe un file invece di mostrarlo; su nessuna, «Scarica»
        // aprirebbe il PDF senza salvare niente.
        expect(link[0].getAttribute('href')).not.toContain('download=');
        expect(link[1].getAttribute('href')).toContain('download=1');

        // Due parole diverse, due chiavi diverse del catalogo.
        expect(link[0].textContent).toContain(testo('fatturaApri'));
        expect(link[1].textContent).toContain(testo('fatturaScarica'));
        expect(testo('fatturaApri')).not.toBe(testo('fatturaScarica'));

        // MAI `target="_blank"`: nella WebView `window.open` non apre e non lo dice.
        for (const a of link) expect(a.getAttribute('target')).toBeNull();
    });

    it('FASE 2 · `pdf_disponibile: false` → nessun comando, benché la fattura esista', async () => {
        await montaEAspettaLaFase1();
        await consegnaEAssorbi([riga(F1, 1948, false)]);

        expect(ancoreDi(PAG)).toHaveLength(0);
        expect(document.body.innerHTML).not.toContain(`pagamento_id=${PAG}`);
    });

    it('FASE 2 · elenco vuoto → nessun comando (è il caso in cui viveva il fast-path)', async () => {
        // ⚠️ QUESTO È IL CASO DEL DIFETTO STORICO, non un contorno: il fast-path
        // diceva `fatture.length <= 1`, e zero è minore di uno. Un elenco vuoto
        // ARRIVATO è precisamente ciò che lo faceva scattare a risposta ricevuta.
        await montaEAspettaLaFase1();
        await consegnaEAssorbi([]);

        expect(ancoreDi(PAG)).toHaveLength(0);
    });

    it('FASE 2 · `pdf_disponibile` ASSENTE (server più vecchio) → nessun comando', async () => {
        await montaEAspettaLaFase1();
        // Il filtro è `=== true` e non «un valore vero qualunque»: un campo che non
        // c'è vale «non lo so», e «non lo so» non accende un comando su un documento
        // fiscale di una famiglia.
        await consegnaEAssorbi([{ id: F1, numero: 1948, anno: 2026, quota_label: null, intestatario: 'X' }]);

        expect(ancoreDi(PAG)).toHaveLength(0);
    });

    it('FASE 3 · due quote (genitori separati): solo quelle col PDF verificato, due comandi ciascuna', async () => {
        await montaEAspettaLaFase1();
        await consegnaEAssorbi([
            riga(F1, 1948, true, 'Mamma'),
            riga(F2, 1949, true, 'Papà'),
            // La terza esiste a registro ma il suo PDF non è nel bucket: fuori.
            riga('dddddddd-0000-4000-8000-000000000023', 1950, false, 'Nonna'),
        ]);

        const link = ancoreDi(PAG);
        expect(link).toHaveLength(4);
        expect(link.map((a) => a.getAttribute('href'))).toEqual([APRI_F1, SCARICA_F1, APRI_F2, SCARICA_F2]);
        expect(screen.queryByText(/Nonna/)).toBeNull();
    });
});
