'use client';

/**
 * «IN ARRIVO» — la linguetta di /admin/students con i bambini la cui domanda è per l'anno DOPO.
 *
 * Un bambino `in_arrivo` esiste in anagrafica (la scheda è una sola) ma non frequenta ancora: non ha sezione né frequenza
 * dell'anno attivo. Per questo non sta in «Alunni» (esige la sezione) né in «Non iscritti» (che è fatta di chi è uscito, e dove
 * comparirebbe con «Elimina definitivamente»). Senza una linguetta sua restava raggiungibile solo dall'indirizzo scritto a mano, e la
 * scheda è l'unica strada per correggere un dato, un'allergia, o archiviare (4.5.15, C2).
 *
 * Legge `?elenco=in_arrivo` con lo stesso hook di «Non iscritti» (`useElencoAlunni`): il conteggio va sulla pillola prima che
 * qualcuno apra la linguetta. È un elenco per RICONOSCERE un bambino e aprirne la scheda: cognome e nome, data di nascita e, con più
 * sedi attive, il plesso. Niente codice fiscale né note mediche a schermo; l'unico comando è «Apri la scheda».
 */

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CalendarClock, CheckCircle2, RotateCcw, Search } from 'lucide-react';
import { SectionTitle, TABLE, TABLE_WRAP, TD, TH, TROW } from '@/components/ui/cockpit';
import { btnClass } from '@/components/ui/Btn';
import { useSediAttive } from '@/lib/context/sede-context';
import { useDateFormat } from '@/lib/i18n/date';
import { cx } from '@/lib/ui/cx';
import { useElencoAlunni, type AlunnoArchiviato, type EsitoAlunniArchiviati } from '@/components/features/admin/AlunniArchiviatiView';

/** L'elenco «In arrivo», una volta sola per pagina (lo invoca `page.tsx`, come per «Non iscritti»). */
export function useAlunniInArrivo(): EsitoAlunniArchiviati {
    return useElencoAlunni('in_arrivo', 'alunni-in-arrivo');
}

export interface AlunniInArrivoViewProps {
    esito: EsitoAlunniArchiviati;
    /** Passa avanti l'identità nell'URL della scheda, come fa il resto del cockpit. */
    userId?: string | null;
}

export function AlunniInArrivoView({ esito, userId }: AlunniInArrivoViewProps) {
    const t = useTranslations('adminStudents');
    const router = useRouter();
    const { sedi } = useSediAttive();
    const { dataBreve } = useDateFormat();
    const [cerca, setCerca] = useState('');

    const nominativo = useCallback(
        (r: AlunnoArchiviato) =>
            [r.cognome, r.nome].filter((v) => typeof v === 'string' && v !== '').join(' ') || t('arcSenzaNome'),
        [t],
    );
    // La colonna «Sede» compare solo con più sedi attive: con un plesso solo ripeterebbe la stessa parola su ogni riga.
    const mostraSede = sedi.length > 1;
    const nomeSede = useCallback(
        (id: string | null | undefined) =>
            (typeof id === 'string' ? sedi.find((s) => s.id === id)?.nome : undefined) ?? t('arcSedeSconosciuta'),
        [sedi, t],
    );

    const visibili = useMemo(() => {
        const testo = cerca.trim().toLowerCase();
        const filtrate =
            testo === ''
                ? [...esito.righe]
                : esito.righe.filter((r) => [r.cognome, r.nome].some((c) => typeof c === 'string' && c.toLowerCase().includes(testo)));
        return filtrate.sort((a, b) => {
            const cognomi = (a.cognome ?? '').localeCompare(b.cognome ?? '', 'it');
            if (cognomi !== 0) return cognomi;
            const nomi = (a.nome ?? '').localeCompare(b.nome ?? '', 'it');
            return nomi !== 0 ? nomi : a.id.localeCompare(b.id);
        });
    }, [esito.righe, cerca]);

    const apriScheda = useCallback(
        (r: AlunnoArchiviato) => {
            const qs = new URLSearchParams({ kind: 'child' });
            if (userId) qs.set('userId', userId);
            router.push(`/admin/students/${r.id}?${qs.toString()}`);
        },
        [router, userId],
    );

    if (esito.fase === 'caricamento') {
        return (
            <div role="status" className="flex min-h-[40vh] flex-1 flex-col items-center justify-center gap-4">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-kidville-green/30 border-t-kidville-green" />
                <p className="font-maven text-kidville-sub">{t('inArrivoCaricamento')}</p>
            </div>
        );
    }

    if (esito.fase === 'errore') {
        return (
            <div role="alert" className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-error-soft text-kidville-error-strong">
                    <AlertTriangle size={34} strokeWidth={1.8} />
                </div>
                <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('arcErroreTitolo')}</h2>
                <p className="font-maven mt-1 max-w-md text-sm text-kidville-sub">{esito.errore || t('inArrivoErroreTesto')}</p>
                <button type="button" onClick={esito.ricarica} className={btnClass('primary', 'sm', 'mt-4')}>
                    <RotateCcw size={15} strokeWidth={2} /> {t('arcRiprova')}
                </button>
            </div>
        );
    }

    const parziale = esito.totale > esito.righe.length;

    return (
        <div className="flex flex-col">
            <div className="mb-4 rounded-card bg-kidville-white p-4 shadow-sm">
                <SectionTitle icon={CalendarClock} title={t('inArrivoTitolo')} sub={t('inArrivoSottotitolo')} />

                {esito.riletturaFallita && (
                    <div
                        role="alert"
                        className="mb-3 flex flex-wrap items-center gap-2 rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong"
                    >
                        <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
                        <span className="flex-1">{esito.errore || t('arcRiletturaFallita')}</span>
                        <button type="button" onClick={esito.ricarica} className={btnClass('ghost', 'sm')}>
                            <RotateCcw size={14} strokeWidth={2} /> {t('arcRiprova')}
                        </button>
                    </div>
                )}

                {esito.ricaricando && (
                    <p aria-live="polite" className="mb-3 flex items-center gap-2 font-maven text-[13px] text-kidville-sub">
                        <RotateCcw size={14} className="animate-spin" aria-hidden="true" />
                        {t('arcRicaricando')}
                    </p>
                )}

                {parziale && (
                    <p className="mb-3 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                        {t('arcParziale')}
                    </p>
                )}

                <label className="relative block w-full">
                    <span className="sr-only">{t('inArrivoCercaEtichetta')}</span>
                    <Search
                        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub"
                        size={18}
                        aria-hidden="true"
                    />
                    <input
                        type="search"
                        value={cerca}
                        onChange={(e) => setCerca(e.target.value)}
                        placeholder={t('arcCerca')}
                        className="w-full rounded-input border-2 border-kidville-line py-2.5 pl-10 pr-4 font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:outline-none focus:ring-2 focus:ring-kidville-green/15"
                    />
                </label>
            </div>

            {esito.righe.length === 0 ? (
                <div className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-success-soft text-kidville-success-strong">
                        <CheckCircle2 size={34} strokeWidth={1.8} />
                    </div>
                    <h3 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('inArrivoVuotoTitolo')}</h3>
                    <p className="font-maven mt-1 max-w-md text-sm text-kidville-sub">{t('inArrivoVuotoTesto')}</p>
                </div>
            ) : visibili.length === 0 ? (
                /* La ricerca non trova niente ≠ non c'è nessun bambino in arrivo. */
                <div className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <h3 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('arcFiltriVuotoTitolo')}</h3>
                    <p className="font-maven mt-1 max-w-md text-sm text-kidville-sub">{t('arcFiltriVuotoTesto')}</p>
                </div>
            ) : (
                <section className="rounded-card bg-kidville-white p-4 shadow-sm">
                    <p aria-live="polite" className="mb-3 font-maven text-[13px] text-kidville-sub">
                        {t('arcConteggio', { n: visibili.length })}
                    </p>
                    <div className={TABLE_WRAP}>
                        <table className={TABLE}>
                            <caption className="sr-only">{t('inArrivoTabellaDidascalia')}</caption>
                            <thead>
                                <tr>
                                    <th scope="col" className={TH}>{t('arcColPersona')}</th>
                                    <th scope="col" className={TH}>{t('arcColNascita')}</th>
                                    {mostraSede && <th scope="col" className={TH}>{t('arcColSede')}</th>}
                                    <th scope="col" className={TH}>{t('arcColComandi')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibili.map((r) => {
                                    const nascita = typeof r.data_nascita === 'string' ? dataBreve(r.data_nascita) : '';
                                    return (
                                        <tr key={r.id} className={TROW}>
                                            <td className={cx(TD, 'font-maven text-sm font-semibold text-kidville-ink')}>{nominativo(r)}</td>
                                            <td className={cx(TD, 'font-maven text-sm text-kidville-sub')}>{nascita || t('arcSenzaData')}</td>
                                            {mostraSede && (
                                                <td className={cx(TD, 'font-maven text-sm text-kidville-sub')}>{nomeSede(r.scuola_id)}</td>
                                            )}
                                            <td className={TD}>
                                                <button
                                                    type="button"
                                                    onClick={() => apriScheda(r)}
                                                    aria-label={`${t('arcAzioneApriScheda')}: ${nominativo(r)}`}
                                                    className={btnClass('ghost', 'sm')}
                                                >
                                                    {t('arcAzioneApriScheda')}
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
        </div>
    );
}
