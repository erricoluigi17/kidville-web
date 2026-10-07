'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { scriviServizi, importoNumero, type EsitoScrittura, type VociDaDecidere } from './servizi-client';

/**
 * Una modifica o un'eliminazione di iscrizione. Il secondo tempo ripete ESATTAMENTE la stessa
 * richiesta e aggiunge `voci_future` (e `voci_ids`): per questo la richiesta si tiene intera.
 */
export type Richiesta =
    | { metodo: 'PATCH'; evento: string; ok: 'servAggiornata'; body: Record<string, unknown> }
    | { metodo: 'DELETE'; evento: string; ok: 'servEliminata'; query: Record<string, string> };

export interface EsitoMostrato { tipo: 'ok' | 'errore'; testo: string }

interface Decisione { richiesta: Richiesta; voci: VociDaDecidere }

interface Opzioni {
    /** Esito finale (successo o errore del secondo tempo), da scrivere nelle regioni di stato. */
    onEsito: (e: EsitoMostrato) => void;
    /** Qualcosa è stato scritto (o potrebbe esserlo): ricarica l'elenco. */
    onScritto: () => void;
    /** L'operazione è chiusa: si chiude anche la finestra che l'ha lanciata. */
    onChiuso: () => void;
}

/**
 * Le scritture delle iscrizioni, con i DUE TEMPI della route: se l'operazione lascia fuori periodo
 * delle voci già generate, la route non scrive niente e risponde con le voci fra cui scegliere.
 * Qui si tiene la richiesta, si apre la scelta, e si ripete la richiesta con la decisione.
 */
export function useScritturaServizi({ onEsito, onScritto, onChiuso }: Opzioni, userId: string) {
    const t = useTranslations('adminContabilita');
    const [invio, setInvio] = useState(false);
    const [errore, setErrore] = useState('');
    const [decisione, setDecisione] = useState<Decisione | null>(null);

    const testoErrore = useCallback((e: { testo: string; vociEliminate: number }) => (
        e.vociEliminate > 0 ? `${e.testo} ${t('servVociGiaEliminate', { n: e.vociEliminate })}` : e.testo
    ), [t]);

    const testoOk = useCallback((r: Richiesta, dati: Record<string, unknown>) => {
        const parti = [t(r.ok)];
        const eliminate = importoNumero(dati.voci_eliminate as number | undefined);
        const mantenute = importoNumero(dati.voci_mantenute as number | undefined);
        if (eliminate > 0) parti.push(t('servVociEliminate', { n: eliminate }));
        if (mantenute > 0) parti.push(t('servVociMantenute', { n: mantenute }));
        return parti.join(' · ');
    }, [t]);

    const manda = useCallback((r: Richiesta, voci?: { voci_future: 'elimina' | 'mantieni'; voci_ids?: string[] }): Promise<EsitoScrittura> => {
        if (r.metodo === 'PATCH') {
            return scriviServizi(userId, 'PATCH', r.evento, t('servErrGenerico'), { body: { ...r.body, ...(voci ?? {}) } });
        }
        const q = new URLSearchParams(r.query);
        if (voci) {
            q.set('voci_future', voci.voci_future);
            if (voci.voci_ids) q.set('voci_ids', voci.voci_ids.join(','));
        }
        return scriviServizi(userId, 'DELETE', r.evento, t('servErrGenerico'), { query: q });
    }, [userId, t]);

    /** Primo tempo (o unico). */
    const esegui = useCallback(async (r: Richiesta) => {
        setInvio(true);
        setErrore('');
        const e = await manda(r);
        setInvio(false);
        if (e.tipo === 'da_decidere') { setDecisione({ richiesta: r, voci: e.voci }); return; }
        if (e.tipo === 'errore') {
            setErrore(testoErrore(e));
            if (e.vociEliminate > 0) onScritto();
            return;
        }
        onEsito({ tipo: 'ok', testo: testoOk(r, e.dati) });
        onScritto();
        onChiuso();
    }, [manda, testoErrore, testoOk, onEsito, onScritto, onChiuso]);

    /** Secondo tempo: la stessa richiesta più la decisione. «elimina» porta SOLO gli id mostrati. */
    const decidi = useCallback(async (scelta: 'elimina' | 'mantieni') => {
        if (!decisione) return;
        const { richiesta, voci } = decisione;
        const ids = voci.eliminabili.map((v) => v.id);
        // Mai una lista vuota: `voci_ids` vuoto varrebbe «tutte». Senza eliminabili non si elimina.
        if (scelta === 'elimina' && ids.length === 0) return;
        setInvio(true);
        const e = await manda(richiesta, scelta === 'elimina' ? { voci_future: 'elimina', voci_ids: ids } : { voci_future: 'mantieni' });
        setInvio(false);
        setDecisione(null);
        if (e.tipo === 'ok') {
            onEsito({ tipo: 'ok', testo: testoOk(richiesta, e.dati) });
        } else if (e.tipo === 'errore') {
            onEsito({ tipo: 'errore', testo: testoErrore(e) });
        } else {
            onEsito({ tipo: 'errore', testo: t('servErrGenerico') });
        }
        // Anche dopo un errore: parte delle voci può essere già stata cancellata.
        onScritto();
        onChiuso();
    }, [decisione, manda, testoOk, testoErrore, onEsito, onScritto, onChiuso, t]);

    /** Nuove iscrizioni (POST): un solo tempo. */
    const iscrivi = useCallback(async (body: Record<string, unknown>) => {
        setInvio(true);
        setErrore('');
        const e = await scriviServizi(userId, 'POST', 'servizi-iscrizione-respinta', t('servErrGenerico'), { body });
        setInvio(false);
        if (e.tipo === 'ok') {
            onEsito({ tipo: 'ok', testo: t('servIscrittiOk', { n: importoNumero(e.dati.creati as number | undefined) }) });
            onScritto();
            onChiuso();
            return;
        }
        setErrore(e.tipo === 'errore' ? e.testo : t('servErrGenerico'));
    }, [userId, t, onEsito, onScritto, onChiuso]);

    /** Annulla: chiude e non invia niente. */
    const annulla = useCallback(() => {
        setDecisione(null);
        setErrore('');
        onChiuso();
    }, [onChiuso]);

    return { invio, errore, decisione, esegui, iscrivi, decidi, annulla, azzeraErrore: () => setErrore('') };
}
