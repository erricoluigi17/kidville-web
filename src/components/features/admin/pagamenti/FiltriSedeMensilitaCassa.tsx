'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import type { SedeCassa } from './CassaSede';
import { INPUT, SELECT, BTN_SECONDARY } from './ui';

/** Mese solare del movimento, con estremi inclusivi e febbraio bisestile. */
export function periodoMensileCassa(mensilita: string) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(mensilita);
  if (!m || Number(m[1]) === 0) return { mensilita: '', da: '', a: '' };
  const anno = Number(m[1]);
  const mese = Number(m[2]);
  const bisestile = anno % 4 === 0 && (anno % 100 !== 0 || anno % 400 === 0);
  const giorni = [31, bisestile ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mese - 1];
  return { mensilita, da: `${mensilita}-01`, a: `${mensilita}-${giorni}` };
}

export function useFiltriCassa(sedePagina: string | null, sedi: readonly SedeCassa[]) {
  const [scelta, setScelta] = useState<string | null>(sedePagina);
  const scuolaId = sedePagina ?? (sedi.some((s) => s.id === scelta) ? scelta : null);
  const [periodo, setPeriodo] = useState(() => periodoMensileCassa(oggiFiscaleISO().slice(0, 7)));
  return {
    scuolaId,
    scegliSede: (id: string) => setScelta(id || null),
    ...periodo,
    scegliMensilita: (mese: string) => setPeriodo(periodoMensileCassa(mese)),
    setDa: (da: string) => setPeriodo((p) => ({ ...p, mensilita: '', da })),
    setA: (a: string) => setPeriodo((p) => ({ ...p, mensilita: '', a })),
  };
}

export function FiltriSedeMensilitaCassa({ prefisso, sedi, scuolaId, onSede, mensilita, onMensilita, disabled }: {
  prefisso: string;
  sedi: readonly SedeCassa[];
  scuolaId: string | null;
  onSede: (id: string) => void;
  mensilita: string;
  onMensilita: (mese: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('adminContabilita');
  return <>
    <div className="max-w-full font-maven text-sm text-kidville-ink">
      <label htmlFor={`${prefisso}-sede`}>{t('cassaSedeLabel')}</label>
      <select id={`${prefisso}-sede`} value={scuolaId ?? ''} onChange={(e) => onSede(e.target.value)} className={SELECT}>
        {(!scuolaId || sedi.length > 1) && <option value="">{t('cassaFiltroTutteSedi')}</option>}
        {sedi.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
        {scuolaId && !sedi.some((s) => s.id === scuolaId) && <option value={scuolaId}>{scuolaId}</option>}
      </select>
    </div>
    <div className="max-w-full font-maven text-sm text-kidville-ink">
      <label htmlFor={`${prefisso}-mensilita`}>{t('cassaFiltroMensilita')}</label>
      <div className="flex flex-wrap items-center gap-2">
        <input id={`${prefisso}-mensilita`} type="month" min="0001-01" max="9999-12" value={mensilita} disabled={disabled} onChange={(e) => onMensilita(e.target.value)} className={INPUT} />
        <button type="button" onClick={() => onMensilita('')} disabled={disabled} className={BTN_SECONDARY}>{t('cassaFiltroTuttiMesi')}</button>
      </div>
    </div>
  </>;
}
