import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Il motivo di un sollecito non partito, nella LINGUA DELL'INTERFACCIA (seconda revisione del
 * lotto 4).
 *
 * La route manda `motivo` in italiano: è prosa del server, dove il locale non esiste. Il pannello
 * la mostrava così com'era — anche alla segreteria con l'interfaccia in inglese. Per il motivo
 * «un altro giro ha appena preso in carico questa voce» la route manda ora anche un CODICE
 * (`motivoCodice: 'altro_giro'`), e il pannello lo traduce dal catalogo: codice dichiarato ⇒
 * catalogo, altrimenti la prosa, come fa `messaggioDaCorpo` con gli errori.
 *
 * Il mock globale di `next-intl` (test/setup.ts) monta SOLO il catalogo italiano: qui ne serve
 * uno che sappia anche l'inglese, quindi il mock è di questo file, e la lingua si sceglie per
 * test. Nomi convenzionali, nessun dato reale.
 */

const lingua = vi.hoisted(() => ({ valore: 'it' as 'it' | 'en' }));

vi.mock('next-intl', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { IntlMessageFormat } = await import('intl-messageformat');
    const catalogo = (ns: string): Record<string, string> => {
        const file = join(process.cwd(), `messages/${lingua.valore}/${ns}.json`);
        return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
    };
    const useTranslations = (ns: string) => {
        const t = (chiave: string, valori?: Record<string, unknown>) => {
            const v = catalogo(ns)[chiave];
            if (typeof v !== 'string') return `${ns}.${chiave}`;
            return valori === undefined ? v : String(new IntlMessageFormat(v, lingua.valore).format(valori));
        };
        return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true });
    };
    return { useTranslations, useLocale: () => lingua.valore };
});

import { SollecitiPanel } from '@/components/features/admin/pagamenti/SollecitiPanel';
import itContabilita from '../../messages/it/adminContabilita.json';
import enContabilita from '../../messages/en/adminContabilita.json';

const SEDE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** La prosa che la route manda (italiana per costruzione). */
const PROSA_ALTRO_GIRO = 'un altro giro ha appena preso in carico questa voce: riprova più tardi';
const NESSUN_INDIRIZZO = 'nessun destinatario con un indirizzo email';

const righe = [
    { id: 'p1', alunno_id: 'a1', scuola_id: SEDE, descrizione: 'Retta ottobre', importo: 150, importo_pagato: 0, stato: 'scaduto', tipo: 'singolo', scadenza: '2026-01-10', ultimo_sollecito_il: null, alunni: { nome: 'Mario', cognome: 'Rossi' } },
    { id: 'p2', alunno_id: 'a2', scuola_id: SEDE, descrizione: 'Mensa ottobre', importo: 60, importo_pagato: 0, stato: 'scaduto', tipo: 'singolo', scadenza: '2026-01-12', ultimo_sollecito_il: null, alunni: { nome: 'Anna', cognome: 'Bianchi' } },
];

function stubFetch(esitiAnteprima: Record<string, unknown>[], esitiInvio: Record<string, unknown>[]) {
    return vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith('/api/pagamenti/solleciti')) {
            const anteprima = JSON.parse(String(init?.body)).anteprima === true;
            return { ok: true, status: 200, json: async () => ({ success: true, data: anteprima ? esitiAnteprima : esitiInvio }) };
        }
        if (u.startsWith('/api/pagamenti?')) {
            return { ok: true, status: 200, json: async () => ({ success: true, data: righe }) };
        }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
}

const tutteE = righe.map((r) => ({ pagamento_id: r.id, ok: true, livello: 1, oggetto: `Promemoria ${r.descrizione}`, corpo: 'Testo' }));

/** Le etichette dei bottoni, prese dal catalogo della lingua del test. */
type Etichette = Pick<typeof itContabilita, 'soll_seleziona_tutti' | 'soll_anteprima' | 'soll_conferma_invia'>;

/** Seleziona tutto e chiede l'anteprima, con le etichette della lingua del test. */
async function anteprima(cat: Etichette) {
    render(<SollecitiPanel userId="u1" scuolaId={SEDE} />);
    await screen.findByText(/Retta ottobre/);
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(cat.soll_seleziona_tutti) }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${cat.soll_anteprima} \\(2\\)`) }));
}

async function inviaTutti(cat: Etichette) {
    await anteprima(cat);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`${cat.soll_conferma_invia} \\(2\\)`) }));
}

const esitiInvio = [
    { pagamento_id: 'p1', ok: false, motivo: PROSA_ALTRO_GIRO, motivoCodice: 'altro_giro' },
    { pagamento_id: 'p2', ok: false, motivo: NESSUN_INDIRIZZO },
];

describe('SollecitiPanel — il motivo di un sollecito non partito, tradotto', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); lingua.valore = 'it'; });

    it('le due chiavi esistono, in fondo a tutti e due i cataloghi, e dicono la stessa cosa', () => {
        expect(Object.keys(itContabilita).at(-1)).toBe('soll_motivo_altro_giro');
        expect(Object.keys(enContabilita).at(-1)).toBe('soll_motivo_altro_giro');
        expect(itContabilita.soll_motivo_altro_giro).toBe(PROSA_ALTRO_GIRO);
        expect(enContabilita.soll_motivo_altro_giro).not.toBe(PROSA_ALTRO_GIRO);
    });

    it('interfaccia ITALIANA: il motivo col codice esce dal catalogo italiano, accanto alla sua voce', async () => {
        vi.stubGlobal('fetch', stubFetch(tutteE, esitiInvio));
        await inviaTutti(itContabilita);
        const voce = await screen.findByText(new RegExp(itContabilita.soll_motivo_altro_giro));
        expect(voce.textContent).toContain('Mario Rossi · Retta ottobre');
    });

    it('🔴 interfaccia INGLESE: il motivo col codice esce in inglese, non nella prosa italiana del server', async () => {
        lingua.valore = 'en';
        vi.stubGlobal('fetch', stubFetch(tutteE, esitiInvio));
        await inviaTutti(enContabilita);
        const voce = await screen.findByText(new RegExp(enContabilita.soll_motivo_altro_giro));
        expect(voce.textContent).toContain('Mario Rossi · Retta ottobre');
        expect(screen.queryByText(new RegExp(PROSA_ALTRO_GIRO))).toBeNull();
        // Senza codice resta la prosa del server: è il limite dichiarato, non un difetto nascosto.
        expect(screen.getByText(new RegExp(NESSUN_INDIRIZZO)).textContent).toContain('Anna Bianchi · Mensa ottobre');
    });

    it('un codice che il pannello non conosce ⇒ la prosa del server, mai il nome di una chiave', async () => {
        lingua.valore = 'en';
        vi.stubGlobal('fetch', stubFetch(tutteE, [
            { pagamento_id: 'p1', ok: false, motivo: PROSA_ALTRO_GIRO, motivoCodice: 'codice_sconosciuto' },
            { pagamento_id: 'p2', ok: true, livello: 1 },
        ]));
        await inviaTutti(enContabilita);
        expect(await screen.findByText(new RegExp(PROSA_ALTRO_GIRO))).toBeTruthy();
        expect(screen.queryByText(/adminContabilita\./)).toBeNull();
    });

    it('🔴 anteprima: anche il motivo dell’anteprima passa dallo stesso meccanismo', async () => {
        lingua.valore = 'en';
        vi.stubGlobal('fetch', stubFetch([
            { pagamento_id: 'p1', ok: false, motivo: PROSA_ALTRO_GIRO, motivoCodice: 'altro_giro' },
            tutteE[1],
        ], []));
        await anteprima(enContabilita);
        const riga = await screen.findByText(new RegExp(enContabilita.soll_motivo_altro_giro));
        expect(riga.textContent).toContain(enContabilita.soll_saltato);
        expect(screen.queryByText(new RegExp(PROSA_ALTRO_GIRO))).toBeNull();
    });
});
