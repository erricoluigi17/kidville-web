'use client';

import { useTranslations } from 'next-intl';
import { Pencil, Layers, Eye } from 'lucide-react';
import { useDateFormat } from '@/lib/i18n/date';
import { isMoroso } from '@/lib/pagamenti/aging';
import { Badge } from '@/components/ui/Badge';
import { TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { BadgeMetodoPagamento } from '@/components/features/pagamenti/BadgeMetodoPagamento';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import type { PagamentoRow } from './RegistraIncassoModal';
import { FatturaButton, type EsitoAccodamento } from './FatturaButton';
import { FatturaChip } from './FatturaChip';
import { PagamentoCardMobile, BadgeSede } from './PagamentoCardMobile';
import { STATI_PAGAMENTO as STATI } from './stati';
import { BTN_PRIMARY_SM, ICON_BTN } from './ui';

/** Le righe dell'elenco per voce: quelle di `GET /api/pagamenti` (il genitore ne ha il tipo completo). */
export interface RigaVoce extends PagamentoRow {
    alunno_id: string;
    scadenza: string;
    scuola_nome?: string | null;
}

interface Props<P extends RigaVoce> {
    righe: P[];
    mostraSede: boolean;
    /** Colonna «Categoria» (e riga nella card): quando la selezione non è UNA categoria sola. */
    mostraCategoria: boolean;
    /** Nome da mostrare per la categoria della voce (con la sede per quelle di sede); «—» se ignota. */
    nomeCategoria: (p: P) => string;
    sospesoByAlunno: Map<string, boolean>;
    /** «Oggi» come `YYYY-MM-DD`: serve a riconoscere le voci morose. */
    oggiStr: string;
    userId: string;
    onIncassa: (p: P) => void;
    onRateizza: (p: P) => void;
    onDettagli: (p: P) => void;
    onModifica: (p: P) => void;
    dopoAccodamento: (pagamentoId: string, esito?: EsitoAccodamento) => void;
}

/** Elenco per voce: tabella su desktop (da `lg`), card su mobile. Solo presentazione. */
export function TabellaVociContabilita<P extends RigaVoce>({
    righe, mostraSede, mostraCategoria, nomeCategoria, sospesoByAlunno, oggiStr, userId,
    onIncassa, onRateizza, onDettagli, onModifica, dopoAccodamento,
}: Props<P>) {
    const t = useTranslations('adminContabilita');
    const f = useDateFormat();
    return (
        <>
            <div className={cx('hidden lg:block', TABLE_WRAP)}>
                <table className={TABLE}>
                    <thead>
                        <tr>
                            <th className={TH}>{t('dashThAlunno')}</th>
                            {mostraSede && <th className={TH}>{t('dashMsThSede')}</th>}
                            {mostraCategoria && <th className={TH}>{t('dashThCategoria')}</th>}
                            <th className={TH}>{t('dashThDescrizione')}</th>
                            <th className={TH}>{t('dashThScadenza')}</th>
                            <th className={cx(TH, 'text-right')}>{t('dashThImporto')}</th>
                            <th className={cx(TH, 'text-right')}>{t('dashAcconto')}</th>
                            <th className={TH}>{t('dashThStato')}</th>
                            <th className={TH}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {righe.map((p) => {
                            const st = STATI[p.stato] ?? STATI.da_pagare;
                            const moroso = isMoroso(p, oggiStr);
                            const acconto = Number(p.importo_pagato || 0);
                            return (
                                <tr key={p.id} className={cx(TROW, moroso && 'bg-kidville-error-soft/50')}>
                                    <td className={cx(TD, 'font-semibold text-kidville-green')}>
                                        {p.alunni?.nome} {p.alunni?.cognome}
                                        {sospesoByAlunno.get(p.alunno_id) && (
                                            <Badge tone="error" className="ml-1 align-middle">{t('dashSospeso')}</Badge>
                                        )}
                                    </td>
                                    {mostraSede && <td className={TD}><BadgeSede nome={p.scuola_nome} /></td>}
                                    {mostraCategoria && <td className={cx(TD, 'text-kidville-ink')}>{nomeCategoria(p)}</td>}
                                    <td className={cx(TD, 'text-kidville-ink')}>
                                        {p.descrizione}
                                        <BadgeMetodoPagamento metodi={p.metodi_ammessi} testoSoloContanti={t('badgeSoloContanti')} testoSoloBonifico={t('badgeSoloBonifico')} className="ml-2 align-middle" />
                                    </td>
                                    <td className={cx(TD, 'text-kidville-sub')}>{p.scadenza ? f.dataBreve(p.scadenza) : '—'}</td>
                                    <td className={cx(TD, 'text-right text-kidville-green')}>{formatEuro(p.importo)}</td>
                                    <td className={cx(TD, 'text-right text-kidville-sub')}>{acconto > 0 ? formatEuro(acconto) : '—'}</td>
                                    <td className={TD}>
                                        <span className="inline-flex flex-wrap items-center gap-1">
                                            <Badge tone={st.tone}>{st.label}</Badge>
                                            {moroso && acconto > 0 && (
                                                <Badge tone="warn">{t('dashAcconto')} {formatEuro(acconto)}</Badge>
                                            )}
                                            <FatturaChip stato={p.stato} fatturaStato={p.fattura_stato} codaStato={p.coda_stato} />
                                        </span>
                                    </td>
                                    <td className={cx(TD, 'text-right')}>
                                        <div className="flex items-center justify-end gap-2">
                                            {p.stato !== 'pagato' ? (
                                                <button onClick={() => onIncassa(p)}
                                                    className={BTN_PRIMARY_SM}>{t('dashIncassa')}</button>
                                            ) : (
                                                <FatturaButton pagamentoId={p.id} userId={userId} fatturaStato={p.fattura_stato} codaStato={p.coda_stato ?? null} onEmessa={(e) => dopoAccodamento(p.id, e)} />
                                            )}
                                            {p.tipo === 'singolo' && p.stato !== 'pagato' && (
                                                <button onClick={() => onRateizza(p)} title={t('dashDividiAcconti')} className={ICON_BTN}><Layers size={15} /></button>
                                            )}
                                            <button onClick={() => onDettagli(p)} title={t('dashDettagli')} className={ICON_BTN}><Eye size={15} /></button>
                                            <button onClick={() => onModifica(p)} title={t('dashModifica')} className={ICON_BTN}><Pencil size={15} /></button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <div className="space-y-2 lg:hidden">
                {righe.map((p) => (
                    <PagamentoCardMobile
                        key={p.id}
                        pagamento={p}
                        alunnoLabel={`${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''}`.trim() || '—'}
                        categoriaLabel={mostraCategoria ? nomeCategoria(p) : undefined}
                        sospeso={!!sospesoByAlunno.get(p.alunno_id)}
                        mostraSede={mostraSede}
                        onIncassa={() => onIncassa(p)}
                        onApri={() => onDettagli(p)}
                    />
                ))}
            </div>
        </>
    );
}
