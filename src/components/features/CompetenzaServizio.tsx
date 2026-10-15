'use client';

import { useTranslations } from 'next-intl';
import { oggiRoma } from '@/lib/storici/retroattivita';

/** La data descrive l'evento; la scelta di avvisare viene sempre rifatta dal server. */
export function CompetenzaServizio({ value, onChange }: { value: string; onChange: (data: string) => void }) {
  const t = useTranslations('teacherPrimaria');
  return <div className="my-3 rounded-card border border-kidville-line p-3">
    <label className="font-maven text-xs text-kidville-sub">
      {t('storicoDataCompetenza')}
      <input type="date" required max={oggiRoma()} value={value}
        onChange={e => { if (e.target.value) onChange(e.target.value); }}
        className="ml-3 rounded-pill border border-kidville-line px-3 py-2 text-sm" />
    </label>
    {value < oggiRoma() && <p role="status" className="mt-2 font-maven text-xs text-kidville-sub">{t('storicoSenzaAvvisiFamiglia')}</p>}
  </div>;
}
