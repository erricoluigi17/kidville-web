'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Clock, Eye, EyeOff, FileText } from 'lucide-react';
import { StatCard, TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { CifraNascosta } from './CifraNascosta';
import type { TotaliPagamenti } from './stati';

interface Props {
    totals: TotaliPagamenti;
    totaliPerSede: { id: string; totali: TotaliPagamenti }[];
    loading: boolean;
    /** Più sedi accorpate: compare anche la tabella per sede. */
    mostraSede: boolean;
    nomeSedeTesto: (id: string) => string;
    /** Cifre nascoste (scelta ricordata per dispositivo): gli importi diventano «••••». */
    nascoste: boolean;
    onCommutaNascoste: () => void;
    /** Descrizione della selezione sommata: se manca, la riga non ne parla. */
    testoSelezione?: string;
}

/**
 * KPI della Direzione: quattro card + (con più sedi) tabella per sede + riga con la selezione
 * sommata e il bottone occhio «Nascondi cifre». Il gate `eDirezione` sta nel genitore: questo
 * componente si monta solo per la Direzione.
 */
export function KpiContabilita({ totals, totaliPerSede, loading, mostraSede, nomeSedeTesto, nascoste, onCommutaNascoste, testoSelezione }: Props) {
    const t = useTranslations('adminContabilita');
    // Importo in euro, o la maschera accessibile quando le cifre sono nascoste. Con il
    // caricamento in corso resta «—» (non c'è ancora nulla da nascondere).
    const euro = (v: number): ReactNode => (nascoste ? <CifraNascosta /> : formatEuro(v));
    const card = (v: number): ReactNode => (loading ? '—' : euro(v));

    return (
        <>
            {/* KPI (StatCard cockpit): 1 colonna sotto sm, 2 da sm, 4 da lg
                `data-testid`: le etichette dei KPI NON sono uniche nella schermata —
                «Da fatturare» è anche il badge di stato di una riga della tabella —
                e senza un confine i test finiscono per contare importi che stanno
                altrove, con esiti che cambiano col calendario. Vedi
                `__tests__/components/importi-euro-italiani.test.tsx`. */}
            <div data-testid="kpi-contabilita" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard icon={CheckCircle2} label={t('dashIncassato')} value={card(totals.incassato)} tone="success" />
                <StatCard icon={Clock} label={t('dashDaIncassare')} value={card(totals.daIncassare)} tone="warn" />
                <StatCard icon={AlertTriangle} label={t('dashScadutoMorosita')} value={card(totals.scaduto)} tone="error" />
                {/* Il conteggio «N pagamenti» NON è una cifra in euro: resta visibile anche a cifre nascoste. */}
                <StatCard icon={FileText} label={t('dashDaFatturare')} value={card(totals.daFatturare)}
                    sub={!loading && totals.nDaFatturare > 0 ? `${totals.nDaFatturare} ${totals.nDaFatturare === 1 ? t('dashPagamentoSing') : t('dashPagamentiPlur')}` : undefined} tone="info" />
            </div>

            {/* Selezione sommata (a sinistra, solo se nota) e occhio (a destra, sempre).
                Il nome del bottone è FISSO e lo stato lo racconta `aria-pressed`: un'etichetta
                che cambiasse («Mostra cifre») farebbe leggere «Mostra cifre, premuto»,
                cioè una doppia negazione. Stesso criterio di `OcchioPassword`. */}
            <div data-testid="kpi-selezione" className="mb-5 mt-2 flex items-center justify-between gap-2">
                {testoSelezione ? (
                    <p className="font-maven text-xs text-kidville-sub">{t('dashKpiSelezione', { selezione: testoSelezione })}</p>
                ) : <span />}
                <button type="button" onClick={onCommutaNascoste} aria-label={t('dashNascondiCifre')} aria-pressed={nascoste}
                    className="rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 text-kidville-sub transition-colors hover:border-kidville-green hover:text-kidville-green">
                    {nascoste ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
                </button>
            </div>

            {/* KPI PER SEDE: con più sedi accorpate il totale da solo non dice a quale
                segreteria tocca cosa. Stesse quattro somme, una riga per sede; stesso
                filtro classi delle card. Anche questi sono totali della Direzione. */}
            {mostraSede && !loading && (
                <div data-testid="kpi-per-sede" className={cx('mb-5', TABLE_WRAP)}>
                    <table className={TABLE}>
                        <caption className="px-3 pt-3 text-left font-barlow text-sm font-extrabold uppercase text-kidville-green">{t('dashMsKpiTitolo')}</caption>
                        <thead>
                            <tr>
                                <th scope="col" className={TH}>{t('dashMsThSede')}</th>
                                <th scope="col" className={cx(TH, 'text-right')}>{t('dashIncassato')}</th>
                                <th scope="col" className={cx(TH, 'text-right')}>{t('dashDaIncassare')}</th>
                                <th scope="col" className={cx(TH, 'text-right')}>{t('dashScadutoMorosita')}</th>
                                <th scope="col" className={cx(TH, 'text-right')}>{t('dashDaFatturare')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {totaliPerSede.map(({ id, totali }) => (
                                <tr key={id || 'sede-non-indicata'} className={TROW}>
                                    <th scope="row" className={cx(TD, 'text-left font-semibold text-kidville-green')}>{nomeSedeTesto(id)}</th>
                                    <td className={cx(TD, 'text-right text-kidville-ink')}>{euro(totali.incassato)}</td>
                                    <td className={cx(TD, 'text-right text-kidville-ink')}>{euro(totali.daIncassare)}</td>
                                    <td className={cx(TD, 'text-right text-kidville-ink')}>{euro(totali.scaduto)}</td>
                                    <td className={cx(TD, 'text-right text-kidville-ink')}>{euro(totali.daFatturare)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}
