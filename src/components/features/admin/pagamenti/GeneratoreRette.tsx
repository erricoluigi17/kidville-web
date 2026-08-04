'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { CalendarClock, RefreshCw, CheckCircle2 } from 'lucide-react';
import { TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';

const GEN_SELECT = 'rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors cursor-pointer hover:border-kidville-green/50 focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';
const GEN_INPUT = 'rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';

interface Candidato { id: string; nome: string; cognome: string; classe_sezione?: string; importo_previsto?: number; importo_retta_mensile?: number; genitori_separati?: boolean }
interface MesePreview { periodo: string; candidati: number; gia_generati: number; importo: number }
interface Props { userId: string; scuolaId: string }
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

function currentPeriod(): string {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}
function annoScolasticoCorrente(): number {
    const n = new Date();
    return n.getMonth() + 1 >= 9 ? n.getFullYear() : n.getFullYear() - 1;
}

type Mode = 'mese' | 'anno';

export function GeneratoreRette({ userId, scuolaId }: Props) {
    const t = useTranslations('adminContabilita');
    const [mode, setMode] = useState<Mode>('anno');
    const [periodo, setPeriodo] = useState(currentPeriod());
    const [anno, setAnno] = useState(annoScolasticoCorrente());
    const [previewMese, setPreviewMese] = useState<{ candidati: Candidato[]; gia_generati: number; totale_previsto: number; retta_default?: number } | null>(null);
    const [previewAnno, setPreviewAnno] = useState<{ mesi: MesePreview[]; alunni_attivi: number; totale_candidati: number; totale_previsto: number; retta_default?: number } | null>(null);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState<string | null>(null);

    const reset = () => { setPreviewMese(null); setPreviewAnno(null); setDone(null); };

    const loadPreview = useCallback(async () => {
        setLoading(true); setDone(null);
        try {
            const qs = mode === 'anno' ? `anno=${anno}` : `periodo=${periodo}`;
            const res = await fetch(`/api/pagamenti/genera-rette?userId=${userId}&${qs}&scuola_id=${scuolaId}`, { headers: hdr(userId) });
            const j = await res.json();
            if (j.success) {
                if (mode === 'anno') { setPreviewAnno(j.data); setPreviewMese(null); }
                else { setPreviewMese(j.data); setPreviewAnno(null); }
            }
        } finally { setLoading(false); }
    }, [userId, mode, anno, periodo, scuolaId]);

    const conferma = async () => {
        setLoading(true);
        try {
            // La sede va DICHIARATA, ed è la stessa dell'anteprima: senza,
            // «genera le rette» emetteva su tutti i plessi (in produzione è già
            // successo: un clic, due sedi). Il pannello sta dentro <SedeRequired>,
            // quindi `scuolaId` c'è sempre.
            const body = mode === 'anno' ? { anno, scuola_id: scuolaId } : { periodo, scuola_id: scuolaId };
            const res = await fetch('/api/pagamenti/genera-rette', { method: 'POST', headers: hdr(userId), body: JSON.stringify(body) });
            const j = await res.json();
            if (j.success) {
                setDone(mode === 'anno'
                    ? `${t('genrGenerate')} ${j.data.generati} ${t('genrRettePerAS')} ${anno}/${anno + 1}.`
                    : `${t('genrGenerate')} ${j.data.generati} ${t('genrRettePer')} ${periodo}.`);
                reset();
            // `alert(j.error)` nudo mostrava «undefined» quando il corpo non portava `error`.
            } else alert(messaggioDaCorpo(j, t('genrErrGenerazione')));
        } finally { setLoading(false); }
    };

    const totCandidati = mode === 'anno' ? (previewAnno?.totale_candidati ?? 0) : (previewMese?.candidati.length ?? 0);
    const hasPreview = mode === 'anno' ? !!previewAnno : !!previewMese;

    return (
        <div>
            {/* Switch modalità */}
            <div className="inline-flex bg-kidville-line rounded-pill p-1 mb-5">
                {([['anno', t('genrAnnoScolastico')], ['mese', t('genrMeseSingolo')]] as [Mode, string][]).map(([m, l]) => (
                    <button key={m} onClick={() => { setMode(m); reset(); }}
                        className={cx('px-4 py-1.5 rounded-pill font-maven text-sm font-bold transition-colors', mode === m ? 'bg-kidville-white text-kidville-green shadow-sm' : 'text-kidville-muted')}>
                        {l}
                    </button>
                ))}
            </div>

            <div className="flex flex-wrap items-end gap-3 mb-5">
                {mode === 'anno' ? (
                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('genrAnnoScolasticoLabel')}</label>
                        <select value={anno} onChange={e => { setAnno(Number(e.target.value)); reset(); }}
                            className={GEN_SELECT}>
                            {[annoScolasticoCorrente() - 1, annoScolasticoCorrente(), annoScolasticoCorrente() + 1].map(y => (
                                <option key={y} value={y}>{y}/{y + 1}</option>
                            ))}
                        </select>
                    </div>
                ) : (
                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('genrMeseCompetenza')}</label>
                        <input type="month" value={periodo} onChange={e => { setPeriodo(e.target.value); reset(); }}
                            className={GEN_INPUT} />
                    </div>
                )}
                <button onClick={loadPreview} disabled={loading}
                    className="inline-flex items-center gap-1 rounded-pill border-[1.5px] border-kidville-green px-4 py-2 font-maven text-sm font-bold text-kidville-green transition-colors hover:bg-kidville-green-soft disabled:opacity-50">
                    <RefreshCw size={14} /> {t('genrAnteprima')}
                </button>
            </div>

            {done !== null && (
                <div className="bg-kidville-success-soft text-kidville-success rounded-card p-4 font-maven text-sm flex items-center gap-2">
                    <CheckCircle2 size={18} /> {done}
                </div>
            )}

            {/* Anteprima ANNO */}
            {mode === 'anno' && previewAnno && (
                <div>
                    <div className="flex flex-wrap gap-4 mb-3 font-maven text-sm">
                        <span className="text-kidville-green font-bold">{previewAnno.alunni_attivi} {t('genrAlunniAttivi')}</span>
                        <span className="text-kidville-muted">{t('genrRettaDefault')} {formatEuro(previewAnno.retta_default ?? 150)}</span>
                        <span className="text-kidville-green font-bold">{t('genrTotalePrevisto')} {formatEuro(previewAnno.totale_previsto)}</span>
                    </div>
                    <div className={cx('max-h-80 overflow-y-auto border border-kidville-line rounded-card mb-4', TABLE_WRAP)}>
                        <table className={TABLE}>
                            <thead className="sticky top-0 bg-kidville-white"><tr>
                                <th className={TH}>{t('genrColMese')}</th><th className={cx(TH, 'text-right')}>{t('genrColDaGenerare')}</th>
                                <th className={cx(TH, 'text-right')}>{t('genrColGiaGenerati')}</th><th className={cx(TH, 'text-right')}>{t('genrColImporto')}</th>
                            </tr></thead>
                            <tbody>
                                {previewAnno.mesi.map(m => (
                                    <tr key={m.periodo} className={TROW}>
                                        <td className={cx(TD, 'font-semibold text-kidville-green')}>{m.periodo.slice(0, 7)}</td>
                                        <td className={cx(TD, 'text-right text-kidville-green')}>{m.candidati}</td>
                                        <td className={cx(TD, 'text-right text-kidville-muted')}>{m.gia_generati}</td>
                                        <td className={cx(TD, 'text-right text-kidville-muted')}>{formatEuro(m.importo)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Anteprima MESE */}
            {mode === 'mese' && previewMese && (
                <div>
                    <div className="flex flex-wrap gap-4 mb-3 font-maven text-sm">
                        <span className="text-kidville-green font-bold">{previewMese.candidati.length} {t('genrAlunniCandidati')}</span>
                        <span className="text-kidville-muted">{t('genrGiaGenerati')} {previewMese.gia_generati}</span>
                        <span className="text-kidville-green font-bold">{t('genrTotalePrevisto')} {formatEuro(previewMese.totale_previsto)}</span>
                    </div>
                    {previewMese.candidati.length === 0 ? (
                        <p className="font-maven text-sm text-kidville-muted py-6 text-center">{t('genrNessunAlunnoMese')}</p>
                    ) : (
                        <div className={cx('max-h-80 overflow-y-auto border border-kidville-line rounded-card mb-4', TABLE_WRAP)}>
                            <table className={TABLE}>
                                <thead className="sticky top-0 bg-kidville-white"><tr>
                                    <th className={TH}>{t('genrColAlunno')}</th><th className={TH}>{t('genrColClasse')}</th>
                                    <th className={cx(TH, 'text-right')}>{t('genrColRetta')}</th><th className={TH}>{t('genrColTipo')}</th>
                                </tr></thead>
                                <tbody>
                                    {previewMese.candidati.map(c => (
                                        <tr key={c.id} className={TROW}>
                                            <td className={cx(TD, 'font-semibold text-kidville-green')}>{c.nome} {c.cognome}</td>
                                            <td className={cx(TD, 'text-kidville-muted')}>{c.classe_sezione ?? '—'}</td>
                                            <td className={cx(TD, 'text-right text-kidville-green')}>{formatEuro(c.importo_previsto ?? c.importo_retta_mensile ?? 0)}</td>
                                            <td className={cx(TD, 'text-xs')}>{c.genitori_separati ? <span className="text-kidville-warn">{t('genrSplit')}</span> : t('genrSingolo')}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {hasPreview && totCandidati > 0 && (
                <button onClick={conferma} disabled={loading}
                    className="inline-flex items-center gap-1 rounded-pill bg-kidville-green px-5 py-2.5 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50">
                    <CalendarClock size={15} /> {t('genrGenera')} {totCandidati} {t('genrRette')}
                </button>
            )}
        </div>
    );
}
