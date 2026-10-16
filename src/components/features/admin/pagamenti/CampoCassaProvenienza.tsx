'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { SELECT } from './ui';

interface Categoria { id: string; nome: string; scuola_id: string | null; attivo: boolean }
interface Props {
  userId: string;
  scuolaId: string | null;
  valore: string;
  onCambia: (valore: string) => void;
  uscita: boolean;
  disabled: boolean;
  erroreId?: string;
}

/** La categoria d'incasso che finanzia il movimento è distinta dalla sua causale di spesa. */
export function CampoCassaProvenienza({ userId, scuolaId, valore, onCambia, uscita, disabled, erroreId }: Props) {
  const t = useTranslations('adminContabilita');
  const [risposta, setRisposta] = useState<{ sede: string; categorie?: Categoria[]; errore?: true } | null>(null);
  const corrente = risposta?.sede === scuolaId ? risposta : null;
  useEffect(() => {
    if (!scuolaId) return;
    let active = true;
    (async () => {
      try {
        const r = await fetch(`/api/admin/settings/categorie?userId=${encodeURIComponent(userId)}&scuola_id=${encodeURIComponent(scuolaId)}`, { headers: { 'x-user-id': userId } });
        if (!r.ok) {
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'cassa-provenienza-categorie-rifiutate', route: '/admin/pagamenti', stato: r.status });
          if (active) setRisposta({ sede: scuolaId, errore: true });
          return;
        }
        const j = await r.json() as { success?: boolean; data?: Categoria[] };
        if (j.success !== true || !Array.isArray(j.data)) {
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'cassa-provenienza-categorie-non-lette', route: '/admin/pagamenti', stato: r.status });
          if (active) setRisposta({ sede: scuolaId, errore: true });
          return;
        }
        if (active) setRisposta({ sede: scuolaId, categorie: j.data.filter((c) => c.attivo === true && (c.scuola_id === null || c.scuola_id === scuolaId)) });
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-provenienza-categorie-fallite: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) setRisposta({ sede: scuolaId, errore: true });
      }
    })();
    return () => { active = false; };
  }, [userId, scuolaId]);

  const categorie = corrente?.categorie ?? [];
  const descrizioneId = [erroreId, 'cassa-provenienza-aiuto', ...(corrente?.errore ? ['cassa-provenienza-errore'] : [])].filter(Boolean).join(' ');
  return <div>
    <label htmlFor="cassa-provenienza" className="mb-1 block font-maven text-xs text-kidville-sub">{t(uscita ? 'cassaFonteLabelUscita' : 'cassaFonteLabelEntrata')}</label>
    <select id="cassa-provenienza" value={valore} onChange={(e) => onCambia(e.target.value)} disabled={disabled || !scuolaId} required={uscita} className={SELECT} aria-invalid={erroreId ? true : undefined} aria-describedby={descrizioneId}>
      <option value="">{t(uscita ? 'cassaFonteScegli' : 'cassaFonteFacoltativa')}</option>
      <option value="generale">{t('cassaFonteGenerale')}</option>
      {categorie.map((c) => <option key={c.id} value={c.id}>{categorie.some((a) => a.id !== c.id && a.nome === c.nome) ? t(c.scuola_id === null ? 'cassaFonteGlobale' : 'cassaFonteSede', { nome: c.nome }) : c.nome}</option>)}
    </select>
    <p id="cassa-provenienza-aiuto" className="mt-1 font-maven text-xs text-kidville-sub">{t('cassaFonteAiuto')}</p>
    {corrente?.errore && <p id="cassa-provenienza-errore" role="alert" className="mt-1 font-maven text-xs text-kidville-error-strong">{t('cassaFonteErroreLettura')}</p>}
  </div>;
}
