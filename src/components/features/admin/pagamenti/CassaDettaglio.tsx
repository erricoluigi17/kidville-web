'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Paperclip } from 'lucide-react';
import { useDateFormat } from '@/lib/i18n/date';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { metodoLabel } from '@/lib/cassa/tipi';
import type { DettaglioCassa } from '@/lib/cassa/dettaglio';
import { TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';
import { isNativeApp } from '@/lib/push/native-register';
import { AvvisoDocumentoNativo, useDocumentoNativo } from './LinkDocumento';
import { BTN_SECONDARY } from './ui';

interface Props {
  userId: string;
  scuolaId: string | null;
  tipo: 'entrata' | 'uscita';
  /** undefined = tutte, null = soltanto senza categoria. */
  categoriaId?: string | null;
  da?: string;
  a?: string;
  metodo?: string;
  refreshKey?: number;
}

/** Il cambio di filtro rimonta l'elenco: pagina e dati appartengono al medesimo filtro. */
export function CassaDettaglio(props: Props) {
  const p = new URLSearchParams({ userId: props.userId, tipo: props.tipo });
  if (props.scuolaId) p.set('scuola_id', props.scuolaId);
  if (props.categoriaId !== undefined) p.set('categoria_id', props.categoriaId ?? 'senza');
  if (props.da) p.set('da', props.da);
  if (props.a) p.set('a', props.a);
  if (props.metodo) p.set('metodo', props.metodo);
  const query = p.toString();
  return <Elenco key={`${query}:${props.refreshKey ?? 0}`} query={query} userId={props.userId} tipo={props.tipo} />;
}

function Elenco({ query, userId, tipo }: { query: string; userId: string; tipo: Props['tipo'] }) {
  const t = useTranslations('adminContabilita');
  const f = useDateFormat();
  const [pagina, setPagina] = useState(1);
  const [tentativo, setTentativo] = useState(0);
  const richiesta = `${query}&pagina=${pagina}&limite=50`;
  const [esito, setEsito] = useState<{ richiesta: string; tentativo: number; dati?: DettaglioCassa; errore?: true } | null>(null);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/pagamenti/cassa/dettaglio?${richiesta}`, { headers: { 'x-user-id': userId } });
        if (!res.ok) {
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'cassa-dettaglio-lettura-rifiutata', route: '/admin/pagamenti', stato: res.status });
          if (active) setEsito({ richiesta, tentativo, errore: true });
          return;
        }
        const dati = await res.json() as DettaglioCassa;
        if (active) setEsito({ richiesta, tentativo, dati });
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-dettaglio-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) setEsito({ richiesta, tentativo, errore: true });
      }
    })();
    return () => { active = false; };
  }, [richiesta, userId, tentativo]);

  const corrente = esito?.richiesta === richiesta && esito.tentativo === tentativo ? esito : null;
  // La navigazione conserva i nodi e il focus anche mentre le righe sono in volo.
  // Il conteggio precedente appartiene allo stesso filtro (Elenco è keyed sul filtro).
  const navigazione = <Paginazione key="paginazione" pagina={pagina} conteggio={esito?.dati?.conteggio ?? 0} bloccata={!corrente || !!corrente.errore || corrente.dati?.disponibile !== true} cambia={setPagina} />;
  if (!corrente) return <div className="min-w-0 space-y-4"><p role="status" className="py-6 font-maven text-sm text-kidville-sub">{t('cassaRepCaricamento')}</p>{navigazione}</div>;
  if (corrente.errore) return <div className="min-w-0 space-y-4"><div role="alert" className="space-y-3 font-maven text-sm text-kidville-error-strong"><p>{t('cassaDetErrore')}</p><button type="button" onClick={() => setTentativo((n) => n + 1)} className={BTN_SECONDARY}>{t('cassaDetRiprova')}</button></div>{navigazione}</div>;
  const dati = corrente.dati!;
  if (!dati.disponibile) return <div className="min-w-0 space-y-4"><p className="font-maven text-sm text-kidville-sub">{t('cassaRepNonAttivo')}</p>{navigazione}</div>;
  return (
    <div className="min-w-0 space-y-4">
      {dati.totali && <div data-testid="cassa-dettaglio-totali" className="flex flex-wrap gap-x-6 gap-y-2 font-maven text-sm text-kidville-ink">
        <p>{t('cassaDetTotaleFiltro')} <strong>{formatEuro(dati.totali.totale)}</strong></p>
        <p>{t('cassaDetContanti')} <strong>{formatEuro(dati.totali.contanti)}</strong></p>
        <p>{t('cassaDetAltri')} <strong>{formatEuro(dati.totali.altri)}</strong></p>
      </div>}
      {dati.righe.length === 0 ? <p className="font-maven text-sm text-kidville-sub">{t('cassaDetVuoto')}</p> : <div className={TABLE_WRAP}>
        <table className={TABLE}>
          <thead><tr>
            <th scope="col" className={TH}>{t('cassaThData')}</th>
            <th scope="col" className={TH}>{t('cassaMsThSede')}</th>
            <th scope="col" className={TH}>{t('cassaRepThCategoria')}</th>
            <th scope="col" className={TH}>{t('cassaThDescrizione')}</th>
            <th scope="col" className={TH}>{t('cassaThMetodo')}</th>
            <th scope="col" className={cx(TH, 'text-right')}>{t('cassaThImporto')}</th>
          </tr></thead>
          <tbody>{dati.righe.map((r) => <tr key={r.id} className={TROW}>
            <td className={cx(TD, 'whitespace-nowrap')}>{f.dataBreve(r.data)}</td>
            <td className={TD}>{r.scuola_nome ?? r.scuola_id}</td>
            <td className={TD}>{r.categoria_nome ?? t('cassaRepSenzaCategoria')}</td>
            <td className={cx(TD, 'min-w-44 max-w-sm break-words')}>
              <p>{r.descrizione ?? '—'}</p>
              {r.note && <details className="mt-1 text-kidville-sub"><summary className="min-h-11 cursor-pointer py-2">{t('cassaDetNote')}</summary><p className="whitespace-pre-wrap">{r.note}</p></details>}
              {r.storno_di ? <span className="font-bold text-kidville-warn-strong">{t('cassaDetContromovimento')}</span> : r.stornato_il ? <span className="font-bold text-kidville-warn-strong">{t('cassaDetStornato')}</span> : null}
              {r.allegato_path && <Giustificativo userId={userId} path={r.allegato_path} />}
            </td>
            <td className={TD}>{metodoLabel(r.metodo)}</td>
            <td className={cx(TD, 'whitespace-nowrap text-right font-bold', tipo === 'uscita' ? 'text-kidville-error-strong' : 'text-kidville-green')}>{formatEuro(r.importo)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {navigazione}
    </div>
  );
}

function Paginazione({ pagina, conteggio, bloccata, cambia }: { pagina: number; conteggio: number; bloccata: boolean; cambia: (pagina: number) => void }) {
  const t = useTranslations('adminContabilita');
  const prima = bloccata || pagina <= 1;
  const ultima = bloccata || pagina * 50 >= conteggio;
  return <nav aria-label={t('cassaDetPaginazione')} aria-busy={bloccata} className="flex flex-wrap items-center justify-between gap-3">
    <button type="button" aria-disabled={prima} onClick={() => { if (!prima) cambia(pagina - 1); }} className={cx(BTN_SECONDARY, prima && 'cursor-not-allowed opacity-50')}>{t('cassaDetPrecedente')}</button>
    <p role="status" className="font-maven text-sm text-kidville-sub">{t('cassaDetPagina', { pagina, pagine: Math.max(1, Math.ceil(conteggio / 50)), n: conteggio })}</p>
    <button type="button" aria-disabled={ultima} onClick={() => { if (!ultima) cambia(pagina + 1); }} className={cx(BTN_SECONDARY, ultima && 'cursor-not-allowed opacity-50')}>{t('cassaDetSuccessiva')}</button>
  </nav>;
}

function Giustificativo({ userId, path }: { userId: string; path: string }) {
  const t = useTranslations('adminContabilita');
  const documento = useDocumentoNativo();
  const [errore, setErrore] = useState(false);
  const [busy, setBusy] = useState(false);
  const apri = async () => {
    setBusy(true); setErrore(false);
    try {
      const r = await fetch(`/api/pagamenti/cassa/allegato?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(path)}`, { headers: { 'x-user-id': userId } });
      const j = await r.json() as { url?: string };
      if (!r.ok || !j.url) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: 'cassa-dettaglio-allegato-rifiutato', route: '/admin/pagamenti', stato: r.status });
        setErrore(true); return;
      }
      if (isNativeApp()) {
        const estensione = path.split('.').pop()?.toLowerCase() ?? '';
        await documento.esegui(j.url, { modo: 'apri', nomeFile: `giustificativo-cassa${/^[a-z0-9]{1,5}$/.test(estensione) ? `.${estensione}` : ''}`, etichetta: 'giustificativo-cassa' });
      } else window.open(j.url, '_blank', 'noopener');
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-dettaglio-allegato-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setErrore(true);
    } finally { setBusy(false); }
  };
  return <div className="mt-2"><button type="button" onClick={apri} disabled={busy} className={BTN_SECONDARY}><Paperclip size={14} />{t('cassaDetGiustificativo')}</button>{errore && <p role="alert" className="text-kidville-error-strong">{t('cassaDetAllegatoErrore')}</p>}{documento.avviso && <AvvisoDocumentoNativo tipo={documento.avviso} />}</div>;
}
