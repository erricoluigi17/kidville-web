'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { logClient, nomeErrore } from '@/lib/logging/client';

/** La firma originale viene conservata dal server prima di revocare la giustifica corrente. */
export function AnnullaGiustifica({ presenzaId, firmaIl, versioneAttesa, userId, nomeAlunno, onCambiato }: {
  presenzaId: string; firmaIl: string | null; versioneAttesa?: number; userId?: string | null; nomeAlunno?: string; onCambiato: () => void | Promise<void>;
}) {
  const t = useTranslations('teacherPresenze');
  const [conferma, setConferma] = useState(false);
  const [inCorso, setInCorso] = useState(false);
  const [esito, setEsito] = useState<'ok' | 'errore' | null>(null);
  const annulla = async () => {
    setInCorso(true);
    setEsito(null);
    try {
      const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
      const res = await fetch(`/api/attendance/justification${qs}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presenzaId, firmaIl, versioneAttesa }),
      });
      if (!res.ok) { const errore = new Error(); errore.name = `HTTP${res.status}`; throw errore; }
      setConferma(false);
      setEsito('ok');
      try { await onCambiato(); } catch (err) {
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `giustifica-annullata-rilettura-fallita: ${nomeErrore(err)}` });
      }
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `giustifica-annullamento-fallito: ${nomeErrore(err)}` });
      setEsito('errore');
    } finally {
      setInCorso(false);
    }
  };
  return <div className="mt-2 font-maven text-xs text-kidville-sub">
    {!conferma ? <button type="button" aria-label={nomeAlunno ? t('giustificaAnnullaAria', { alunno: nomeAlunno }) : undefined} onClick={() => { setConferma(true); setEsito(null); }} className="min-h-11 rounded-pill border border-kidville-line px-3 py-1.5">{t('giustificaAnnulla')}</button> : <div className="rounded-xl border border-kidville-line p-3">
      <p>{t('giustificaAnnullaConferma')}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={inCorso} onClick={() => void annulla()} className="min-h-11 rounded-pill bg-kidville-green px-3 py-1.5 text-kidville-yellow disabled:opacity-50">{t('giustificaConfermaAnnulla')}</button>
        <button type="button" disabled={inCorso} onClick={() => setConferma(false)} className="min-h-11 rounded-pill border border-kidville-line px-3 py-1.5">{t('giustificaMantieni')}</button>
      </div>
    </div>}
    {esito && <p role={esito === 'errore' ? 'alert' : 'status'} className="mt-1">{t(esito === 'ok' ? 'giustificaAnnullata' : 'giustificaAnnullaErrore')}</p>}
  </div>;
}
