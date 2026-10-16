'use client';

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { FILTRI_CASSA_INIZIALI, intervalloMeseCassa, type ErroreFiltriCassa, type FiltriMovimentiCassa } from '@/lib/cassa/filtri';
import type { RigaMovimentoCassa } from '@/lib/cassa/tipi';
import { cx } from '@/lib/ui/cx';
import { INPUT, BTN_SECONDARY } from './ui';
import type { SedeCassa } from './CassaSede';

interface Props {
  filtri: FiltriMovimentiCassa;
  onChange: (filtri: FiltriMovimentiCassa) => void;
  movimenti: readonly RigaMovimentoCassa[];
  sedi: SedeCassa[];
  piuSedi: boolean;
  risultati: number;
  errore: ErroreFiltriCassa | null;
}

export function CassaFiltriMovimenti({ filtri, onChange, movimenti, sedi, piuSedi, risultati, errore }: Props) {
  const t = useTranslations('adminContabilita');
  const cambia = (chiave: keyof FiltriMovimentiCassa, valore: string) => onChange({ ...filtri, [chiave]: valore });
  const categorie = useMemo(() => {
    const nomi = new Map<string, string>();
    for (const r of movimenti) if (r.categoria_id) nomi.set(r.categoria_id, r.categoria_nome || r.categoria_id);
    return [...nomi].sort((a, b) => a[1].localeCompare(b[1]));
  }, [movimenti]);
  const casse = useMemo(() => {
    const nomi = new Map<string, string>();
    for (const r of movimenti) if (r.cassa_categoria_id) nomi.set(r.cassa_categoria_id, r.cassa_categoria_nome || r.cassa_categoria_id);
    return [...nomi].sort((a, b) => a[1].localeCompare(b[1]));
  }, [movimenti]);
  const mese = filtri.da && filtri.a && intervalloMeseCassa(filtri.da.slice(0, 7))?.a === filtri.a && filtri.da.endsWith('-01') ? filtri.da.slice(0, 7) : '';
  const campo = (chiave: keyof FiltriMovimentiCassa, label: string, type = 'text') => (
    <label className="block min-w-0 font-maven text-xs font-bold text-kidville-sub" htmlFor={`cassa-filtro-${chiave}`}>
      {label}
      <input id={`cassa-filtro-${chiave}`} type={type} value={filtri[chiave]} onChange={e => cambia(chiave, e.target.value)}
        inputMode={chiave === 'importoMin' || chiave === 'importoMax' ? 'decimal' : undefined}
        aria-invalid={errore === 'date' && (chiave === 'da' || chiave === 'a') || errore === 'importi' && (chiave === 'importoMin' || chiave === 'importoMax') || undefined}
        aria-describedby={errore ? 'cassa-filtri-errore' : undefined} className={cx(INPUT, 'mt-1 min-h-[44px] w-full')} />
    </label>
  );
  const selettore = (chiave: keyof FiltriMovimentiCassa, label: string, opzioni: ReactNode) => (
    <label className="block min-w-0 font-maven text-xs font-bold text-kidville-sub" htmlFor={`cassa-filtro-${chiave}`}>
      {label}
      <select id={`cassa-filtro-${chiave}`} value={filtri[chiave]} onChange={e => cambia(chiave, e.target.value)} className={cx(INPUT, 'mt-1 min-h-[44px] w-full')}>
        <option value="">{t('cassaFiltroMovTutti')}</option>
        {opzioni}
      </select>
    </label>
  );
  return (
    <fieldset className="mb-4 rounded-card border-[1.5px] border-kidville-line bg-kidville-cream/30 p-3">
      <legend className="px-1 font-barlow font-bold text-kidville-green">{t('cassaFiltroMovTitolo')}</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {selettore('tipo', t('cassaFiltroMovTipo'), <>
          <option value="uscita">{t('cassaFiltroMovSoloUscite')}</option>
          <option value="entrata">{t('cassaFiltroMovEntrate')}</option>
          <option value="prelievo">{t('cassaFiltroMovPrelievi')}</option>
          <option value="rettifica">{t('cassaFiltroMovRettifiche')}</option>
        </>)}
        {campo('ricerca', t('cassaFiltroMovRicerca'), 'search')}
        {piuSedi && selettore('scuolaId', t('cassaFiltroMovSede'), sedi.map(s => <option key={s.id} value={s.id}>{s.nome}</option>))}
        <label htmlFor="cassa-filtro-mese" className="block min-w-0 font-maven text-xs font-bold text-kidville-sub">
          {t('cassaFiltroMovMese')}
          <input id="cassa-filtro-mese" type="month" value={mese} onChange={e => {
            const intervallo = intervalloMeseCassa(e.target.value);
            onChange({ ...filtri, da: intervallo?.da ?? '', a: intervallo?.a ?? '' });
          }} className={cx(INPUT, 'mt-1 min-h-[44px] w-full')} />
        </label>
        {campo('da', t('cassaFiltroMovDa'), 'date')}
        {campo('a', t('cassaFiltroMovA'), 'date')}
        {selettore('categoriaId', t('cassaFiltroMovCategoria'), <>
          <option value="__nessuna__">{t('cassaFiltroMovSenzaCategoria')}</option>
          {categorie.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
        </>)}
        {selettore('cassaId', t('cassaFiltroMovCassa'), <>
          <option value="__generale__">{t('cassaFiltroMovGenerale')}</option>
          {casse.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
        </>)}
        {selettore('metodo', t('cassaFiltroMovMetodo'), <>
          <option value="contanti">{t('cassaFiltroMovContanti')}</option>
          <option value="bonifico">{t('cassaFiltroMovBonifico')}</option>
          <option value="carta">{t('cassaFiltroMovCarta')}</option>
          <option value="altro">{t('cassaFiltroMovAltro')}</option>
        </>)}
        {selettore('origine', t('cassaFiltroMovOrigine'), <>
          <option value="incasso">{t('cassaFiltroMovIncasso')}</option>
          <option value="cassa">{t('cassaFiltroMovManuale')}</option>
        </>)}
        {selettore('stato', t('cassaFiltroMovStato'), <>
          <option value="attivo">{t('cassaFiltroMovAttivo')}</option>
          <option value="stornato">{t('cassaFiltroMovStornato')}</option>
          <option value="contromovimento">{t('cassaFiltroMovContromovimento')}</option>
        </>)}
        {selettore('allegato', t('cassaFiltroMovAllegato'), <>
          <option value="presente">{t('cassaFiltroMovPresente')}</option>
          <option value="assente">{t('cassaFiltroMovAssente')}</option>
        </>)}
        {campo('importoMin', t('cassaFiltroMovImportoMin'))}
        {campo('importoMax', t('cassaFiltroMovImportoMax'))}
      </div>
      {errore && <p id="cassa-filtri-errore" role="alert" className="mt-3 font-maven text-xs text-kidville-error-strong">{t(errore === 'date' ? 'cassaFiltroMovErroreDate' : 'cassaFiltroMovErroreImporti')}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {!errore && <p role="status" aria-live="polite" className="font-maven text-xs text-kidville-sub">{t('cassaFiltroMovRisultati', { n: risultati, totale: movimenti.length })}</p>}
        <button type="button" onClick={() => onChange({ ...FILTRI_CASSA_INIZIALI })} className={cx(BTN_SECONDARY, 'min-h-[44px] px-3 py-2 text-xs')}><RotateCcw size={14} />{t('cassaFiltroMovReset')}</button>
      </div>
    </fieldset>
  );
}
