'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TrendingDown } from 'lucide-react';
import { SectionTitle } from '@/components/ui/cockpit';
import { useSediAttive } from '@/lib/context/sede-context';
import { logClient, nomeErrore } from '@/lib/logging/client';
import type { CassaCategoria } from '@/lib/cassa/tipi';
import { CassaDettaglio } from './CassaDettaglio';
import { CassaMovimentoModal } from './CassaMovimentoModal';
import { INPUT, SELECT, BTN_PRIMARY_AA } from './ui';

export function UscitePanel({ userId, scuolaId }: { userId: string; scuolaId: string | null }) {
  const t = useTranslations('adminContabilita');
  const { sedi, effettive } = useSediAttive();
  const sediCassa = sedi.filter((s) => scuolaId ? s.id === scuolaId : effettive.includes(s.id));
  const [da, setDa] = useState('');
  const [a, setA] = useState('');
  const [categoria, setCategoria] = useState('');
  const [metodo, setMetodo] = useState('');
  const [categorie, setCategorie] = useState<(CassaCategoria & { scuola_nome?: string | null })[]>([]);
  const [categorieErrore, setCategorieErrore] = useState(false);
  const [modal, setModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const sedeQ = scuolaId ? `&scuola_id=${encodeURIComponent(scuolaId)}` : '';
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await fetch(`/api/pagamenti/cassa/categorie?userId=${encodeURIComponent(userId)}${sedeQ}`, { headers: { 'x-user-id': userId } });
        const j = r.ok ? await r.json() as { disponibile?: boolean; categorie?: typeof categorie } : null;
        if (!r.ok || j?.disponibile !== true || !Array.isArray(j.categorie)) {
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'uscite-categorie-lettura-rifiutata', route: '/admin/pagamenti', stato: r.status });
          if (active) { setCategorie([]); setCategorieErrore(true); }
          return;
        }
        if (active) { setCategorie(j.categorie); setCategorieErrore(false); }
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `uscite-categorie-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) { setCategorie([]); setCategorieErrore(true); }
      }
    })();
    return () => { active = false; };
  }, [userId, sedeQ, refreshKey]);
  const periodoInvalido = !!(da && a && da > a);
  return <section className="min-w-0 space-y-5">
    <SectionTitle icon={TrendingDown} title={t('usciteTitolo')} sub={t('usciteSottotitolo')} />
    <div className="flex flex-wrap items-end gap-3">
      <label className="font-maven text-sm text-kidville-ink">{t('cassaRepDal')}<input type="date" value={da} onChange={(e) => setDa(e.target.value)} className={INPUT} /></label>
      <label className="font-maven text-sm text-kidville-ink">{t('cassaRepAl')}<input type="date" value={a} onChange={(e) => setA(e.target.value)} className={INPUT} /></label>
      <div className="max-w-full font-maven text-sm text-kidville-ink"><label htmlFor="uscite-categoria">{t('cassaRepThCategoria')}</label><select id="uscite-categoria" value={categoria} onChange={(e) => setCategoria(e.target.value)} className={SELECT} aria-describedby={categorieErrore ? 'uscite-categorie-errore' : undefined}>
        <option value="">{t('cassaRepTutte')}</option><option value="senza">{t('cassaRepSenzaCategoria')}</option>
        {categorie.map((c) => <option key={c.id} value={c.id}>{c.nome}{!scuolaId && c.scuola_id ? ` — ${c.scuola_nome ?? sedi.find((s) => s.id === c.scuola_id)?.nome ?? c.scuola_id}` : ''}</option>)}
      </select></div>
      <div className="font-maven text-sm text-kidville-ink"><label htmlFor="uscite-metodo">{t('cassaThMetodo')}</label><select id="uscite-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value)} className={SELECT}>
        <option value="">{t('usciteTuttiMetodi')}</option>
        <option value="contanti">{t('cassaMovMetodoContanti')}</option><option value="bonifico">{t('cassaMovMetodoBonifico')}</option><option value="carta">{t('cassaMovMetodoCarta')}</option><option value="altro">{t('cassaMovMetodoAltro')}</option>
      </select></div>
      <button type="button" ref={trigger} onClick={() => setModal(true)} className={BTN_PRIMARY_AA}>{t('cassaRegistraUscita')}</button>
    </div>
    {categorieErrore && <p id="uscite-categorie-errore" role="alert" className="font-maven text-sm text-kidville-error-strong">{t('usciteCategorieErrore')}</p>}
    {periodoInvalido ? <p role="alert" className="font-maven text-sm text-kidville-error-strong">{t('cassaDetPeriodoInvalido')}</p> : <CassaDettaglio userId={userId} scuolaId={scuolaId} tipo="uscita" categoriaId={categoria ? categoria === 'senza' ? null : categoria : undefined} da={da} a={a} metodo={metodo} refreshKey={refreshKey} />}
    {modal && <CassaMovimentoModal userId={userId} sedi={sediCassa} sedeIniziale={scuolaId} tipoIniziale="uscita" onClose={() => setModal(false)} onDone={() => { setModal(false); setRefreshKey((n) => n + 1); }} returnFocusRef={trigger} />}
  </section>;
}
