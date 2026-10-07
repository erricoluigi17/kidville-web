'use client';

import { useId } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useDateFormat } from '@/lib/i18n/date';
import { formatEuro } from '@/lib/format/valuta';
import { etichettaMese } from '@/lib/pagamenti/selezione-voci';
import type { VociDaDecidere, VoceDaDecidere } from './servizi-client';
import { btnSecondario } from './servizi-stili';
import { BottonePrimarioServizi } from './BottonePrimarioServizi';

interface Props {
    voci: VociDaDecidere;
    invio: boolean;
    onElimina: () => void;
    onMantieni: () => void;
    onAnnulla: () => void;
}

const CHIAVE_STATO: Record<string, string> = {
    da_pagare: 'servStatoDaPagare', parziale: 'servStatoParziale', pagato: 'servStatoPagato', scaduto: 'servStatoScaduto',
};
const CHIAVE_MOTIVO: Record<string, string> = {
    manuale: 'servMotivoManuale', rateizzata: 'servMotivoRateizzata', pagata: 'servMotivoPagata', parziale: 'servMotivoParziale',
    incassi: 'servMotivoIncassi', fatturata: 'servMotivoFatturata', in_coda: 'servMotivoInCoda',
};

function RigaVoce({ v, conMotivo }: { v: VoceDaDecidere; conMotivo: boolean }) {
    const t = useTranslations('adminContabilita');
    const locale = useLocale();
    const f = useDateFormat();
    const importo = formatEuro(v.importo);
    const data = v.scadenza ? f.dataBreve(v.scadenza) : '—';
    const riga = v.periodo
        ? t('servVfRiga', { mese: etichettaMese(v.periodo, locale, 'corta'), data, importo })
        : t('servVfRigaSenzaMese', { data, importo });
    const chiaveStato = v.stato ? CHIAVE_STATO[v.stato] : undefined;
    const chiaveMotivo = v.motivo ? CHIAVE_MOTIVO[v.motivo] : undefined;
    return (
        <li className="rounded-input bg-kidville-cream px-3 py-2 font-maven text-xs text-kidville-ink">
            <span>{riga}</span>
            {chiaveStato && <span className="ml-2 font-bold">{t(chiaveStato)}</span>}
            {conMotivo && chiaveMotivo && <span className="mt-0.5 block text-kidville-sub">{t(chiaveMotivo)}</span>}
            {!conMotivo && v.sollecitata && (
                <span className="mt-0.5 flex items-start gap-1 text-kidville-warn-strong">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                    {t('servVfSolleciti')}
                </span>
            )}
        </li>
    );
}

/**
 * Secondo tempo di una modifica o eliminazione: le voci già generate che cadono fuori dal
 * nuovo periodo. Qui non si invia niente da soli: i tre bottoni chiamano chi ha la richiesta.
 * «Annulla» (e Escape) chiude senza spedire.
 */
export function VociFutureDialog({ voci, invio, onElimina, onMantieni, onAnnulla }: Props) {
    const t = useTranslations('adminContabilita');
    const titoloId = useId();
    const nElim = voci.eliminabili.length;
    return (
        <Modal open onClose={onAnnulla} title={t('servVfTitolo')} labelledBy={titoloId} closeOnBackdrop={false}
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-card bg-kidville-white p-5 shadow-xl">
            <h3 id={titoloId} className="font-barlow text-lg font-extrabold text-kidville-green">{t('servVfTitolo')}</h3>
            <p className="mt-1 font-maven text-sm text-kidville-ink">{t('servVfIntro')}</p>

            {nElim > 0 && (
                <section className="mt-4">
                    <h4 className="mb-1.5 font-maven text-sm font-bold text-kidville-green">{t('servVfEliminabili', { n: nElim })}</h4>
                    <ul className="space-y-1.5">{voci.eliminabili.map((v) => <RigaVoce key={v.id} v={v} conMotivo={false} />)}</ul>
                </section>
            )}
            {voci.intoccabili.length > 0 && (
                <section className="mt-4">
                    <h4 className="mb-1.5 font-maven text-sm font-bold text-kidville-green">{t('servVfIntoccabili', { n: voci.intoccabili.length })}</h4>
                    <ul className="space-y-1.5">{voci.intoccabili.map((v) => <RigaVoce key={v.id} v={v} conMotivo />)}</ul>
                </section>
            )}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button type="button" onClick={onAnnulla} disabled={invio} className={btnSecondario}>{t('servAnnulla')}</button>
                {nElim > 0
                    ? <button type="button" onClick={onMantieni} disabled={invio} className={btnSecondario}>{t('servVfMantieni')}</button>
                    : <BottonePrimarioServizi onClick={onMantieni} disabled={invio}>{t('servVfProcedi')}</BottonePrimarioServizi>}
                {nElim > 0 && (
                    <BottonePrimarioServizi onClick={onElimina} disabled={invio}>{t('servVfElimina', { n: nElim })}</BottonePrimarioServizi>
                )}
            </div>
        </Modal>
    );
}
