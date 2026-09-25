'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Download } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { fileConsegnato, scaricaDocumento } from '@/lib/native/scarica';

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
 * ── LO SCARICAMENTO PASSA DALL'HELPER UNICO (`scaricaDocumento`) ─────────
 *
 * Qui si fa `fetch` → controllo di `res.ok` → `blob`, e il Blob va a
 * `scaricaDocumento` (`src/lib/native/scarica.ts`). Sul web l'helper fa ciò che
 * faceva questo file — ancora `download` appesa al documento, revoca ritardata —
 * e nell'app scrive il file in Cache e apre il foglio «Salva su File»: nella
 * WebView l'ancora su un `blob:` non scarica niente e non lancia. La `fetch` resta
 * QUI, e non nell'helper, perché il nome del file sta in un header della risposta.
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
            // Il Blob passa all'helper unico: sul web lo scarica con l'ancora come prima,
            // nell'app lo mette in Cache e apre il foglio «Salva su File». L'esito lo logga
            // l'helper (successo compreso); qui resta solo da dirlo a schermo se il file non
            // è arrivato — sul binario 1.0, per esempio, dove il plugin non c'è.
            const esito = await scaricaDocumento({
                sorgente: blob,
                nomeFile: nomeFileDaHeader(res.headers.get('Content-Disposition'), avvisoId),
                mime: 'text/csv',
                etichetta: 'avviso-adesioni',
            });
            if (!fileConsegnato(esito)) setErrore(t('esportaErrore'));
        } catch (e) {
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `avviso-adesioni-export-rete: ${nomeErrore(e)}`,
                route: '/admin/avvisi',
            });
            setErrore(t('esportaErrore'));
        } finally {
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
