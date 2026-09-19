'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Download } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * ─── «ESPORTA ELENCO (CSV)» — IL FILE CONTIENE NOMI DI MINORI ───────────────
 *
 * Il CSV lo compone il SERVER (`GET /api/avvisi/[id]/risposte/esporta`), che è
 * anche l'unico posto in cui il gate vive: `requireStaff(['admin','coordinator',
 * 'segreteria'])`, più la riga di registro immodificabile che risponde a «chi ha
 * scaricato l'elenco dei bambini e quando». Qui non si compone niente: un secondo
 * generatore di CSV lato client sarebbe una seconda verità sulle stesse righe, e
 * soprattutto una strada che non passa da quel registro.
 *
 * ── LA RIGA D'AVVERTENZA È FISSA, NON UN MESSAGGIO D'ERRORE ─────────────────
 *
 * Sta sotto il bottone SEMPRE, anche prima di premerlo: chi sta per scaricare un
 * elenco di nomi di alunni e genitori deve saperlo PRIMA, non dopo. Un avviso che
 * compare solo a scaricamento avvenuto informa quando non serve più.
 *
 * ── LO SCARICAMENTO SEGUE IL PATTERN GIÀ IN USO NEL REPO ───────────────────
 *
 * `fetch` → `blob` → `createObjectURL` → `<a download>` aggiunto al documento →
 * `click()` → rimosso → `revokeObjectURL` ritardato. Le due parti che sembrano
 * superflue e non lo sono (misurate in `MonthlyAttendanceTable`):
 *  · l'ancora va APPESA al documento prima del click, altrimenti in alcune
 *    WebView il gesto non parte;
 *  · la revoca NON va nello stesso giro di eventi: nella WebView di Capacitor lo
 *    scaricamento è asincrono e una revoca immediata lo annulla, lasciando un
 *    bottone che sembra funzionare e non scarica niente.
 * Il nome del file lo decide il server (`Content-Disposition`): è lui a sapere di
 * quale avviso si tratta e a doverlo ripulire dei caratteri che un header non
 * ammette. Qui resta un ripiego per il caso in cui l'header non arrivi.
 */

interface Props {
    avvisoId: string;
    userId?: string | null;
    /** Quante righe di adesione esistono: a zero non si chiama il server. */
    nAdesioni: number;
}

/** Il nome del file dall'header, col ripiego per quando l'header non arriva. */
function nomeFileDaHeader(header: string | null, avvisoId: string): string {
    return header?.match(/filename="([^"]+)"/)?.[1] ?? `adesioni-${avvisoId}.csv`;
}

export function EsportaAdesioni({ avvisoId, userId, nAdesioni }: Props) {
    const t = useTranslations('avvisi');
    const [inCorso, setInCorso] = useState(false);
    const [errore, setErrore] = useState('');
    /** Il caso vuoto NON è un errore: non c'era niente da scaricare, e basta. */
    const [avviso, setAvviso] = useState('');

    const esporta = async () => {
        setErrore('');
        setAvviso('');

        // Niente righe: il server risponderebbe con un file di sole intestazioni,
        // che a chi lo apre sembra un guasto. Si dice invece com'è.
        if (nAdesioni === 0) {
            setAvviso(t('esportaVuoto'));
            return;
        }

        setInCorso(true);
        let url: string | null = null;
        try {
            const res = await fetch(
                `/api/avvisi/${avvisoId}/risposte/esporta${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`,
                { cache: 'no-store' },
            );
            if (!res.ok) {
                // Un ramo d'errore che non logga è un bug: senza questa riga un
                // export che non esce non lascia traccia da nessuna parte e la
                // segretaria ha solo un bottone che non fa niente. Nessun dato
                // personale: rotta e stato HTTP, che è l'unica cosa che distingue
                // «non sei autorizzata» da «il database non risponde».
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: 'avviso-adesioni-export-non-riuscito',
                    route: '/admin/avvisi',
                    stato: res.status,
                });
                setErrore(t('esportaErrore'));
                return;
            }
            const blob = await res.blob();
            url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = nomeFileDaHeader(res.headers.get('Content-Disposition'), avvisoId);
            document.body.appendChild(a);
            a.click();
            a.remove();
        } catch (e) {
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `avviso-adesioni-export-rete: ${nomeErrore(e)}`,
                route: '/admin/avvisi',
            });
            setErrore(t('esportaErrore'));
        } finally {
            if (url) {
                const daRevocare = url;
                setTimeout(() => URL.revokeObjectURL(daRevocare), 60_000);
            }
            setInCorso(false);
        }
    };

    return (
        <div className="space-y-1.5">
            <button
                type="button"
                onClick={esporta}
                disabled={inCorso}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-kidville-line bg-white px-3 py-2 font-maven text-xs font-bold text-kidville-green transition-colors hover:border-kidville-green disabled:text-kidville-sub"
            >
                <Download size={14} strokeWidth={1.8} aria-hidden="true" />
                {inCorso ? t('esportaInCorso') : t('esportaElenco')}
            </button>

            {/* Fissa: si legge PRIMA di premere, non dopo aver scaricato. */}
            <p className="font-maven text-[10px] leading-relaxed text-kidville-sub">{t('esportaAvvertenza')}</p>

            {/* Lo stato dell'operazione (in corso · niente da esportare): non è un
                errore, quindi `status` e non `alert`. */}
            <p role="status" className="font-maven text-[10px] text-kidville-sub">
                {inCorso ? t('esportaInCorso') : avviso}
            </p>

            {errore && (
                <p
                    role="alert"
                    className="flex items-start gap-1.5 rounded-xl bg-kidville-error-soft px-3 py-2 font-maven text-[11px] text-kidville-error-strong"
                >
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                    <span>{errore}</span>
                </p>
            )}
        </div>
    );
}
