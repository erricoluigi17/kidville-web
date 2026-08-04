'use client';

import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { Download, FileSpreadsheet, Receipt, RefreshCw } from 'lucide-react';
import { SectionTitle, TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { Badge } from '@/components/ui/Badge';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';

interface RicevutaRiga {
    id: string;
    pagamento_id: string;
    numero: number;
    anno: number;
    importo: number;
    tracciabile: boolean;
    bollo: boolean;
    annullata_il: string | null;
    annullo_motivo: string | null;
    creato_il: string;
    alunni?: { nome?: string; cognome?: string } | null;
}
interface Alunno { id: string; nome?: string; cognome?: string; classe_sezione?: string | null; section_id?: string | null }

interface Props { userId: string; scuolaId: string }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

/** Vista Fiscale: attestazioni annuali per alunno + registro delle ricevute numerate. */
export function FiscalePanel({ userId, scuolaId }: Props) {
    const t = useTranslations('adminContabilita');
    const annoCorrente = new Date().getFullYear();
    const [anno, setAnno] = useState(annoCorrente);
    const [ricevute, setRicevute] = useState<RicevutaRiga[]>([]);
    const [disponibile, setDisponibile] = useState(true);
    const [loading, setLoading] = useState(true);
    const [alunni, setAlunni] = useState<Alunno[]>([]);
    const [attAlunno, setAttAlunno] = useState('');
    const [attAnno, setAttAnno] = useState(annoCorrente);
    // La comunicazione AdE riguarda tipicamente l'anno d'imposta precedente.
    const [adeAnno, setAdeAnno] = useState(annoCorrente - 1);

    const loadRegistro = useCallback(async () => {
        try {
            const r = await fetch(`/api/pagamenti/ricevute?userId=${userId}&anno=${anno}`, { headers: hdr(userId) });
            const j = await r.json();
            if (j?.success) {
                setRicevute(j.data || []);
                setDisponibile(j.disponibile !== false);
            }
        } finally {
            setLoading(false);
        }
    }, [userId, anno]);

    useEffect(() => { loadRegistro(); }, [loadRegistro]);
    useEffect(() => {
        fetch(`/api/admin/students?stato=iscritto&scuola_id=${scuolaId}&limit=${LIMITE_ELENCO_ALUNNI}`, { headers: hdr(userId) })
            .then((r) => r.json())
            .then((d) => {
                const lista: Alunno[] = Array.isArray(d) ? d : (d.data || []);
                // solo frequentanti: gli iscritti senza sezione non maturano rette
                const frequentanti = lista.filter((a) => a.classe_sezione != null || a.section_id != null);
                setAlunni(frequentanti);
                if (frequentanti[0]) setAttAlunno((cur) => cur || frequentanti[0].id);
            })
            .catch(() => {});
    }, [userId, scuolaId]);

    const anni = [annoCorrente, annoCorrente - 1, annoCorrente - 2];
    const selCls = 'rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors cursor-pointer hover:border-kidville-green/50 focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';

    return (
        <div className="space-y-8">
            <div>
                <SectionTitle icon={FileSpreadsheet} title={t('fisc_att_title')}
                    sub={t('fisc_att_sub')} />
                <div className="flex flex-wrap items-center gap-2">
                    <select value={attAlunno} onChange={(e) => setAttAlunno(e.target.value)} className={`${selCls} min-w-[220px]`}>
                        {alunni.map((a) => (
                            <option key={a.id} value={a.id}>{a.nome} {a.cognome}{a.classe_sezione ? ` · ${a.classe_sezione}` : ''}</option>
                        ))}
                    </select>
                    <select value={attAnno} onChange={(e) => setAttAnno(Number(e.target.value))} className={selCls}>
                        {anni.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                    {attAlunno ? (
                        <a href={`/api/pagamenti/attestazione?alunno_id=${attAlunno}&anno=${attAnno}&userId=${userId}`}
                            className="inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-2 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark">
                            <Download size={14} /> {t('fisc_scarica_att')}
                        </a>
                    ) : (
                        <span className="font-maven text-xs text-kidville-muted">{t('fisc_nessun_alunno')}</span>
                    )}
                </div>
            </div>

            <div>
                <SectionTitle icon={FileSpreadsheet} title={t('fisc_ade_title')}
                    sub={t('fisc_ade_sub')} />
                <div className="flex flex-wrap items-center gap-2">
                    <select value={adeAnno} onChange={(e) => setAdeAnno(Number(e.target.value))} className={selCls}>
                        {anni.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                    <a href={`/api/pagamenti/export?tipo=ade&anno=${adeAnno}&userId=${userId}&scuola_id=${scuolaId}`}
                        className="inline-flex items-center gap-1.5 rounded-pill border-[1.5px] border-kidville-green px-4 py-2 font-maven text-sm font-bold text-kidville-green transition-colors hover:bg-kidville-green hover:text-kidville-yellow">
                        <Download size={14} /> {t('fisc_esporta_com')} {adeAnno}
                    </a>
                </div>
            </div>

            <div>
                <SectionTitle icon={Receipt} title={t('fisc_reg_title')}
                    sub={t('fisc_reg_sub')}
                    action={
                        <span className="flex items-center gap-2">
                            <select value={anno} onChange={(e) => { setAnno(Number(e.target.value)); setLoading(true); }} className={selCls}>
                                {anni.map((a) => <option key={a} value={a}>{a}</option>)}
                            </select>
                            <button onClick={() => { setLoading(true); loadRegistro(); }} aria-label={t('fisc_aggiorna')} title={t('fisc_aggiorna')}
                                className="rounded-pill border-[1.5px] border-kidville-line p-2 text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                                <RefreshCw size={14} />
                            </button>
                        </span>
                    } />
                {loading ? (
                    <p className="py-6 text-center font-maven text-sm text-kidville-muted">{t('fisc_caricamento')}</p>
                ) : !disponibile ? (
                    <p className="py-6 text-center font-maven text-sm text-kidville-muted">
                        {t('fisc_non_disponibile')}
                    </p>
                ) : ricevute.length === 0 ? (
                    <p className="py-6 text-center font-maven text-sm text-kidville-muted">{t('fisc_nessuna_ricevuta')} {anno}.</p>
                ) : (
                    <>
                        <div className={cx('hidden lg:block', TABLE_WRAP)}>
                            <table className={TABLE}>
                                <thead>
                                    <tr>
                                        <th className={TH}>{t('fisc_th_n')}</th>
                                        <th className={TH}>{t('fisc_th_data')}</th>
                                        <th className={TH}>{t('fisc_th_alunno')}</th>
                                        <th className={cx(TH, 'text-right')}>{t('fisc_th_importo')}</th>
                                        <th className={TH}>{t('fisc_th_stato')}</th>
                                        <th className={TH}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {ricevute.map((r) => <RigaRegistro key={r.id} r={r} userId={userId} mobile={false} />)}
                                </tbody>
                            </table>
                        </div>
                        <div className="space-y-2 lg:hidden">
                            {ricevute.map((r) => <RigaRegistro key={r.id} r={r} userId={userId} mobile />)}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

function ChipsRicevuta({ r }: { r: RicevutaRiga }) {
    const t = useTranslations('adminContabilita');
    return (
        <span className="inline-flex flex-wrap items-center gap-1">
            {r.annullata_il
                ? <Badge tone="error" title={r.annullo_motivo ?? undefined}>{t('fisc_annullata')}</Badge>
                : <Badge tone={r.tracciabile ? 'success' : 'warn'}>{r.tracciabile ? t('fisc_tracciabile') : t('fisc_contanti')}</Badge>}
            {r.bollo && <Badge tone="neutral">{t('fisc_bollo')}</Badge>}
        </span>
    );
}

function RigaRegistro({ r, userId, mobile }: { r: RicevutaRiga; userId: string; mobile: boolean }) {
    const t = useTranslations('adminContabilita');
    const f = useDateFormat();
    // Data breve localizzata (IT identica a `toLocaleDateString('it-IT')`); '—' se assente.
    const dataIt = (d?: string | null) => (d ? f.dataBreve(d) : '—');
    const alunno = `${r.alunni?.nome ?? ''} ${r.alunni?.cognome ?? ''}`.trim() || '—';
    const pdf = !r.annullata_il && (
        <a href={`/api/pagamenti/ricevuta?pagamento_id=${r.pagamento_id}&userId=${userId}`}
            className="inline-flex items-center gap-1 rounded-pill bg-kidville-green-soft px-2 py-1 text-xs font-bold text-kidville-green transition-colors hover:bg-kidville-green/20">
            <Download size={12} /> PDF
        </a>
    );
    if (mobile) {
        return (
            <div className="rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3">
                <div className="flex items-center justify-between gap-2">
                    <p className="font-maven text-sm font-bold text-kidville-green">{t('fisc_n_abbr')} {r.numero}/{r.anno} · {alunno}</p>
                    {pdf}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 font-maven text-xs text-kidville-muted">
                    <span>{dataIt(r.creato_il)} · {formatEuro(r.importo)}</span>
                    <ChipsRicevuta r={r} />
                </div>
            </div>
        );
    }
    return (
        <tr className={TROW}>
            <td className={cx(TD, 'font-bold text-kidville-green')}>{r.numero}/{r.anno}</td>
            <td className={cx(TD, 'text-kidville-muted')}>{dataIt(r.creato_il)}</td>
            <td className={cx(TD, 'text-kidville-ink')}>{alunno}</td>
            <td className={cx(TD, 'text-right text-kidville-green')}>{formatEuro(r.importo)}</td>
            <td className={TD}><ChipsRicevuta r={r} /></td>
            <td className={cx(TD, 'text-right')}>{pdf}</td>
        </tr>
    );
}
