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
import { useSediAttive } from '@/lib/context/sede-context';
import { RevisioneFatturePanel, type SedeRevisione } from './RevisioneFatturePanel';
import { LinkDocumento, MIME_XLSX } from './LinkDocumento';

interface RicevutaRiga {
    id: string;
    /** Sede che ha numerato la ricevuta (K7): la numerazione è per sede, «n. 7» esiste una volta per plesso. */
    scuola_id?: string | null;
    /** `schools.nome`; null quando la route ripiega senza la FK verso `schools`. */
    scuola_nome?: string | null;
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
interface Alunno { id: string; nome?: string; cognome?: string; classe_sezione?: string | null; section_id?: string | null; scuola_id?: string | null }

/**
 * `scuolaId` è null quando le sedi selezionate sono più d'una. Allora:
 *  - l'elenco alunni e l'export AdE NON portano `scuola_id` (le route restringono già alle
 *    sedi attive dell'utente): mai `scuola_id=null` nell'URL;
 *  - la sede si dice ovunque serva a distinguere: nel menu degli alunni e in una colonna del
 *    registro ricevute (la numerazione è per sede);
 *  - la revisione fatture riceve le sedi effettive e fa scegliere la sede al suo interno.
 */
interface Props { userId: string; scuolaId: string | null }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

/** Vista Fiscale: attestazioni annuali per alunno + registro delle ricevute numerate. */
export function FiscalePanel({ userId, scuolaId }: Props) {
    const t = useTranslations('adminContabilita');
    const { sedi, effettive } = useSediAttive();
    const piuSedi = scuolaId == null;
    const nomeSede = (id?: string | null): string | null => (id ? sedi.find((s) => s.id === id)?.nome ?? null : null);
    // Alla revisione fatture solo le sedi su cui l'utente sta lavorando. Con una sola sede è
    // quella della pagina, anche se l'elenco del cockpit non ne ha ancora il nome.
    const sediRevisione: SedeRevisione[] = scuolaId
        ? [{ id: scuolaId, nome: nomeSede(scuolaId) ?? '' }]
        : sedi.filter((s) => effettive.includes(s.id)).map((s) => ({ id: s.id, nome: s.nome }));
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
        // Con più sedi niente `scuola_id`: la route restringe alle sedi attive dell'utente.
        const sede = scuolaId ? `&scuola_id=${encodeURIComponent(scuolaId)}` : '';
        fetch(`/api/admin/students?stato=iscritto${sede}&limit=${LIMITE_ELENCO_ALUNNI}`, { headers: hdr(userId) })
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
    // Il nome dalla route (K7), altrimenti quello del cockpit; null quando la sede non si risolve
    // (la riga mostra allora «Sede non indicata», e la scheda mobile senza il prefisso «Sede:»).
    const sedeRiga = (r: RicevutaRiga): SedeRiga => {
        const nome = r.scuola_nome || nomeSede(r.scuola_id);
        return nome ? { nome, ignota: false } : { nome: t('fisc_sede_ignota'), ignota: true };
    };
    const selCls = 'rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors cursor-pointer hover:border-kidville-green/50 focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';

    return (
        <div className="space-y-8">
            <RevisioneFatturePanel userId={userId} sedi={sediRevisione} sedeIniziale={scuolaId} />

            <div>
                <SectionTitle icon={FileSpreadsheet} title={t('fisc_att_title')}
                    sub={t('fisc_att_sub')} />
                <div className="flex flex-wrap items-center gap-2">
                    <select value={attAlunno} onChange={(e) => setAttAlunno(e.target.value)} className={`${selCls} min-w-[220px]`}>
                        {alunni.map((a) => (
                            <option key={a.id} value={a.id}>
                                {a.nome} {a.cognome}{a.classe_sezione ? ` · ${a.classe_sezione}` : ''}
                                {piuSedi ? ` · ${nomeSede(a.scuola_id) ?? t('fisc_sede_ignota')}` : ''}
                            </option>
                        ))}
                    </select>
                    <select value={attAnno} onChange={(e) => setAttAnno(Number(e.target.value))} className={selCls}>
                        {anni.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                    {attAlunno ? (
                        <LinkDocumento href={`/api/pagamenti/attestazione?alunno_id=${attAlunno}&anno=${attAnno}&userId=${userId}`}
                            modo="apri" nomeFile={`attestazione-730-${attAnno}.pdf`} mime="application/pdf" etichetta="attestazione-730"
                            className="inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-2 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark">
                            <Download size={14} /> {t('fisc_scarica_att')}
                        </LinkDocumento>
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
                    {/* Più sedi: un file unico, la colonna Sede la scrive il server (K2). */}
                    <LinkDocumento href={`/api/pagamenti/export?tipo=ade&anno=${adeAnno}&userId=${userId}${scuolaId ? `&scuola_id=${encodeURIComponent(scuolaId)}` : ''}`}
                        modo="scarica" nomeFile={`comunicazione-ade-${adeAnno}.xlsx`} mime={MIME_XLSX} etichetta="export-ade"
                        className="inline-flex items-center gap-1.5 rounded-pill border-[1.5px] border-kidville-green px-4 py-2 font-maven text-sm font-bold text-kidville-green transition-colors hover:bg-kidville-green hover:text-kidville-yellow">
                        <Download size={14} /> {t('fisc_esporta_com')} {adeAnno}
                    </LinkDocumento>
                </div>
                {piuSedi && (
                    <p className="mt-2 font-maven text-xs text-kidville-sub">{t('fisc_ade_file_unico')}</p>
                )}
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
                                        {piuSedi && <th className={TH}>{t('fisc_th_sede')}</th>}
                                        <th className={TH}>{t('fisc_th_data')}</th>
                                        <th className={TH}>{t('fisc_th_alunno')}</th>
                                        <th className={cx(TH, 'text-right')}>{t('fisc_th_importo')}</th>
                                        <th className={TH}>{t('fisc_th_stato')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {ricevute.map((r) => <RigaRegistro key={r.id} r={r} mobile={false} sede={piuSedi ? sedeRiga(r) : null} />)}
                                </tbody>
                            </table>
                        </div>
                        <div className="space-y-2 lg:hidden">
                            {ricevute.map((r) => <RigaRegistro key={r.id} r={r} mobile sede={piuSedi ? sedeRiga(r) : null} />)}
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

/** La sede di una ricevuta: il nome da mostrare, e se è il ripiego «Sede non indicata». */
interface SedeRiga { nome: string; ignota: boolean }

/** `sede` è la sede da mostrare, o null quando le sedi selezionate sono una sola (nessuna colonna). */
function RigaRegistro({ r, mobile, sede }: { r: RicevutaRiga; mobile: boolean; sede: SedeRiga | null }) {
    const t = useTranslations('adminContabilita');
    const f = useDateFormat();
    // Data breve localizzata (IT identica a `toLocaleDateString('it-IT')`); '—' se assente.
    const dataIt = (d?: string | null) => (d ? f.dataBreve(d) : '—');
    const alunno = `${r.alunni?.nome ?? ''} ${r.alunni?.cognome ?? ''}`.trim() || '—';
    if (mobile) {
        return (
            <div className="rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3">
                <p className="font-maven text-sm font-bold text-kidville-green">{t('fisc_n_abbr')} {r.numero}/{r.anno} · {alunno}</p>
                {sede !== null && (
                    // Il ripiego si dice da solo: «Sede: Sede non indicata» ripeterebbe il prefisso.
                    <p className="font-maven text-xs font-bold text-kidville-ink">
                        {sede.ignota ? sede.nome : t('fisc_sede_riga', { sede: sede.nome })}
                    </p>
                )}
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
            {sede !== null && <td className={cx(TD, 'text-kidville-ink')}>{sede.nome}</td>}
            <td className={cx(TD, 'text-kidville-muted')}>{dataIt(r.creato_il)}</td>
            <td className={cx(TD, 'text-kidville-ink')}>{alunno}</td>
            <td className={cx(TD, 'text-right text-kidville-green')}>{formatEuro(r.importo)}</td>
            <td className={TD}><ChipsRicevuta r={r} /></td>
        </tr>
    );
}
