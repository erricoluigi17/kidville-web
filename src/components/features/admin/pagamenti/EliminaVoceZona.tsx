'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { useRuoloCockpit } from '@/lib/context/admin-identity';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { BTN_SECONDARY } from './ui';

/**
 * Zona «Elimina voce» della finestra Modifica (2026-10-12, «pagamenti generati per errore»).
 *
 * Solo admin e segreteria (lo impone anche il server). Il verdetto «eliminabile o no, e perché»
 * lo dà `GET /api/pagamenti/[id]/eliminabile`, con le stesse guardie della DELETE: qui non si
 * ricalcola niente. Un verdetto non letto non è mai «eliminabile». Conferma in due passi, nella
 * stessa finestra.
 */

const RUOLI = new Set(['admin', 'segreteria']);
const ROUTE = '/admin/pagamenti';

type Verdetto =
    | { stato: 'attesa' }
    | { stato: 'si'; rate: number; ticket: number }
    | { stato: 'no'; corpo: unknown }
    | { stato: 'ignoto' };

// Funzione di modulo, chiamata dall'effetto con `.then`: lo stato si imposta solo nel
// callback, mai in modo sincrono dentro l'effetto (react-hooks/set-state-in-effect).
async function leggiVerdetto(id: string, userId: string): Promise<Verdetto> {
    try {
        const res = await fetch(`/api/pagamenti/${id}/eliminabile?userId=${userId}`, { headers: { 'x-user-id': userId } });
        const j = (await res.json().catch(() => null)) as { eliminabile?: boolean; rate?: number; ticket?: number } | null;
        if (!res.ok || !j || typeof j.eliminabile !== 'boolean') {
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'elimina-voce-verdetto-non-letto', route: ROUTE, stato: res.status });
            return { stato: 'ignoto' };
        }
        return j.eliminabile ? { stato: 'si', rate: Number(j.rate ?? 0), ticket: Number(j.ticket ?? 0) } : { stato: 'no', corpo: j };
    } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina-voce-verdetto-non-letto: ${nomeErrore(err)}`, route: ROUTE, stato: 0 });
        return { stato: 'ignoto' };
    }
}

interface Props {
    pagamento: { id: string; descrizione: string; importo: number };
    userId: string;
    onEliminata: () => void;
}

export function EliminaVoceZona({ pagamento, userId, onEliminata }: Props) {
    const t = useTranslations('adminContabilita');
    const ammesso = RUOLI.has(useRuoloCockpit());
    const [verdetto, setVerdetto] = useState<Verdetto>({ stato: 'attesa' });
    const [conferma, setConferma] = useState(false);
    const [invio, setInvio] = useState(false);
    const [errore, setErrore] = useState<string | null>(null);

    useEffect(() => {
        if (!ammesso) return;
        let attivo = true;
        leggiVerdetto(pagamento.id, userId).then((v) => { if (attivo) setVerdetto(v); });
        return () => { attivo = false; };
    }, [ammesso, pagamento.id, userId]);

    if (!ammesso) return null;

    const elimina = async () => {
        setInvio(true); setErrore(null);
        try {
            const res = await fetch(`/api/pagamenti/${pagamento.id}?userId=${userId}`, { method: 'DELETE', headers: { 'x-user-id': userId } });
            if (res.ok) { onEliminata(); return; }
            const j = await res.json().catch(() => ({}));
            logClient({ livello: 'warn', evento: 'fetch', messaggio: 'elimina-voce-respinta', route: ROUTE, stato: res.status });
            setErrore(messaggioDaCorpo(j, t('eliminaErrGenerico')));
            setConferma(false);
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina-voce-rete: ${nomeErrore(err)}`, route: ROUTE, stato: 0 });
            setErrore(t('eliminaErrRete'));
            setConferma(false);
        } finally {
            setInvio(false);
        }
    };

    return (
        <section aria-labelledby="elimina-voce-titolo" className="mt-5 rounded-card border-[1.5px] border-kidville-error-soft p-3">
            <h4 id="elimina-voce-titolo" className="mb-2 flex items-center gap-1.5 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-error-strong">
                <Trash2 size={14} aria-hidden="true" /> {t('eliminaTitolo')}
            </h4>
            {verdetto.stato === 'ignoto' && (
                <p className="font-maven text-xs text-kidville-sub">{t('eliminaNonControllabile')}</p>
            )}
            {verdetto.stato === 'no' && (
                <p className="font-maven text-xs text-kidville-sub">{messaggioDaCorpo(verdetto.corpo, t('eliminaNonControllabile'))}</p>
            )}
            {verdetto.stato === 'si' && !conferma && (
                <button type="button" onClick={() => { setErrore(null); setConferma(true); }}
                    className={cx(BTN_SECONDARY, 'w-full border-kidville-error-strong text-kidville-error-strong')}>
                    {t('eliminaPulsante')}
                </button>
            )}
            {verdetto.stato === 'si' && conferma && (
                <div className="space-y-2">
                    <p className="font-maven text-xs text-kidville-ink">
                        {t('eliminaDomanda', { descrizione: pagamento.descrizione, importo: formatEuro(pagamento.importo) })}
                    </p>
                    {verdetto.rate > 0 && <p className="font-maven text-xs text-kidville-ink">{t('eliminaConRate', { n: verdetto.rate })}</p>}
                    {verdetto.ticket > 0 && <p className="font-maven text-xs text-kidville-ink">{t('eliminaConTicket', { n: verdetto.ticket })}</p>}
                    <div className="flex gap-2">
                        <button type="button" onClick={() => setConferma(false)} disabled={invio} className={cx(BTN_SECONDARY, 'flex-1')}>
                            {t('eliminaAnnulla')}
                        </button>
                        {/* `text-kidville-white` e non `text-white`: in alto contrasto il token diventa
                            nero sul rosso chiaro di quel tema (6:1), il bianco fisso resterebbe a 3,2:1. */}
                        <button type="button" onClick={elimina} disabled={invio}
                            className="flex-1 rounded-pill bg-kidville-error-strong px-4 py-2 font-maven text-sm font-bold text-kidville-white disabled:opacity-60">
                            {invio ? t('eliminaInCorso') : t('eliminaConferma')}
                        </button>
                    </div>
                </div>
            )}
            {errore && <p role="alert" className="mt-2 font-maven text-xs text-kidville-error-strong">{errore}</p>}
        </section>
    );
}
