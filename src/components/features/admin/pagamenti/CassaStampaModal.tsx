'use client';

import { useState, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Printer, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { LinkDocumento } from './LinkDocumento';
import { BTN_PRIMARY_AA, BTN_SECONDARY, INPUT, MODAL_CARD, MODAL_SHADOW } from './ui';
import { cx } from '@/lib/ui/cx';

interface Props {
  userId: string;
  scuolaId: string | null;
  nomiSedi: string[];
  da?: string;
  a?: string;
  categorie: { id: string; etichetta: string }[];
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

/** La scelta di stampa è indipendente dalla categoria già filtrata a schermo. */
export function CassaStampaModal({ userId, scuolaId, nomiSedi, da, a, categorie, onClose, returnFocusRef }: Props) {
  const t = useTranslations('adminContabilita');
  const [raggruppamento, setRaggruppamento] = useState<'totale' | 'categoria'>('totale');
  const [categoria, setCategoria] = useState('');
  const p = new URLSearchParams({ userId, format: 'pdf', raggruppamento });
  if (scuolaId) p.set('scuola_id', scuolaId);
  if (da) p.set('da', da);
  if (a) p.set('a', a);
  if (raggruppamento === 'categoria' && categoria) p.set('categoria_pagamento_id', categoria);
  const href = `/api/pagamenti/cassa/report?${p.toString()}`;
  const data = (s: string) => s.split('-').reverse().join('/');
  const periodo = da && a ? `${data(da)} — ${data(a)}` : da ? t('cassaStampaDal', { data: data(da) }) : a ? t('cassaStampaFinoAl', { data: data(a) }) : t('cassaStampaStorico');
  return (
    <Modal open safeArea title={t('cassaStampaTitolo')} onClose={onClose} returnFocusRef={returnFocusRef} className={cx(MODAL_CARD, 'max-h-[85dvh] overflow-y-auto')} style={{ boxShadow: MODAL_SHADOW }}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-barlow text-lg font-black uppercase text-kidville-green"><Printer size={18} /> {t('cassaStampaTitolo')}</h3>
        <button type="button" aria-label={t('cassaStampaChiudi')} onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-kidville-sub hover:text-kidville-ink"><X size={20} /></button>
      </div>
      <dl className="mb-4 space-y-2 rounded-card bg-kidville-cream/60 p-3 font-maven text-sm text-kidville-ink">
        <div><dt className="font-bold">{t('cassaStampaSedi')}</dt><dd>{nomiSedi.join(', ') || t('cassaStampaSediAttive')}</dd></div>
        <div><dt className="font-bold">{t('cassaStampaPeriodo')}</dt><dd>{periodo}</dd></div>
      </dl>
      <fieldset className="mb-4 space-y-2 font-maven text-sm text-kidville-ink">
        <legend className="mb-2 font-bold">{t('cassaStampaScelta')}</legend>
        <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="radio" name="conteggio-stampa" value="totale" checked={raggruppamento === 'totale'} onChange={() => setRaggruppamento('totale')} className="h-4 w-4 accent-kidville-green" />{t('cassaStampaTotale')}</label>
        <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="radio" name="conteggio-stampa" value="categoria" checked={raggruppamento === 'categoria'} onChange={() => setRaggruppamento('categoria')} className="h-4 w-4 accent-kidville-green" />{t('cassaStampaPerCategoria')}</label>
      </fieldset>
      {raggruppamento === 'categoria' && <div className="mb-4">
        <label htmlFor="cassa-stampa-categoria" className="mb-1 block font-maven text-sm font-bold text-kidville-green">{t('cassaStampaCategoria')}</label>
        <select id="cassa-stampa-categoria" value={categoria} onChange={(e) => setCategoria(e.target.value)} className={INPUT}>
          <option value="">{t('cassaStampaTutte')}</option>
          {categorie.map((c) => <option key={c.id} value={c.id}>{c.etichetta}</option>)}
        </select>
        <p className="mt-2 font-maven text-xs text-kidville-sub">{t('cassaStampaFiltro')}</p>
      </div>}
      <p className="mb-5 font-maven text-sm text-kidville-sub">{t('cassaStampaSpiegazione')}</p>
      <div className="flex flex-wrap gap-2">
        <LinkDocumento href={href} modo="apri" target="_blank" nomeFile="conteggio-cassa.pdf" mime="application/pdf" etichetta="cassa-conteggio" className={BTN_PRIMARY_AA}><Printer size={16} /> {t('cassaStampaApri')}</LinkDocumento>
        <LinkDocumento href={`${href}&scarica=1`} modo="scarica" nomeFile="conteggio-cassa.pdf" mime="application/pdf" etichetta="cassa-conteggio" className={BTN_SECONDARY}><Download size={16} /> {t('cassaStampaScarica')}</LinkDocumento>
      </div>
    </Modal>
  );
}
