'use client';

// ─── Categorie delle News (Step 4) ────────────────────────────────────────────
// Clone del pattern «Causali/Categorie cassa»: elenco (globali di sistema + di
// sede), creazione con slug server-side, rinomina ed eliminazione delle sole
// personalizzate (le is_sistema sono bloccate lato server con 409).

import { useCallback, useEffect, useState } from 'react';
import { Tag, Plus, Trash2, Lock } from 'lucide-react';
import { hdr } from '@/components/features/admin/settings/ui';
import { INPUT, BTN_PRIMARY_AA } from '@/components/features/admin/pagamenti/ui';
import { logClient } from '@/lib/logging/client';
import { cx } from '@/lib/ui/cx';
import type { NewsCategoria } from '@/lib/news/tipi';

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Props {
  userId: string;
  scuolaId: string;
}

export function NewsCategoriePanel({ userId, scuolaId }: Props) {
  const [categorie, setCategorie] = useState<NewsCategoria[]>([]);
  const [loading, setLoading] = useState(true);
  const [disponibile, setDisponibile] = useState(true);
  const [nuovoNome, setNuovoNome] = useState('');
  const [errore, setErrore] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carica = useCallback(async () => {
    try {
      const res = await fetch(`/api/news/categorie?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) }).catch(() => null);
      if (!res || !res.ok) {
        setDisponibile(res?.status !== 404);
        setCategorie([]);
      } else {
        const j = (await res.json().catch(() => null)) as { disponibile?: boolean; categorie?: NewsCategoria[] } | null;
        setDisponibile(j?.disponibile !== false);
        setCategorie((j?.categorie ?? []).slice().sort((a, b) => a.ordine - b.ordine));
      }
    } finally {
      setLoading(false);
    }
  }, [userId, scuolaId]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const crea = async () => {
    if (!nuovoNome.trim()) return;
    setErrore(null);
    setSalvando(true);
    try {
      const res = await fetch(`/api/news/categorie?userId=${userId}`, { method: 'POST', headers: hdr(userId), body: JSON.stringify({ nome: nuovoNome.trim(), scuola_id: scuolaId }) });
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setErrore(j?.error ?? 'Creazione non riuscita.');
        return;
      }
      setNuovoNome('');
      void carica();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `crea categoria news — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
      setErrore('Errore di rete.');
    } finally {
      setSalvando(false);
    }
  };

  const rinomina = async (id: string, nome: string) => {
    try {
      const res = await fetch(`/api/news/categorie?userId=${userId}`, { method: 'PATCH', headers: hdr(userId), body: JSON.stringify({ id, nome }) });
      if (res.ok) void carica();
      else {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setErrore(j?.error ?? 'Rinomina non riuscita.');
      }
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `rinomina categoria news — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
    }
  };

  const elimina = async (id: string) => {
    if (!confirm('Eliminare questa categoria?')) return;
    try {
      const res = await fetch(`/api/news/categorie?userId=${userId}&id=${id}`, { method: 'DELETE', headers: hdr(userId) });
      if (res.ok) void carica();
      else {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setErrore(j?.error ?? 'Eliminazione non riuscita.');
      }
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina categoria news — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
    }
  };

  return (
    <div className="space-y-4">
      {/* Nuova categoria */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="nuova-cat" className="mb-1.5 block font-maven text-xs font-bold uppercase tracking-wide text-kidville-sub">Nuova categoria</label>
          <input id="nuova-cat" value={nuovoNome} onChange={(e) => setNuovoNome(e.target.value)} placeholder="Es. Sport e movimento" className={INPUT} />
        </div>
        <button type="button" onClick={() => void crea()} disabled={salvando || !nuovoNome.trim()} className={BTN_PRIMARY_AA}><Plus size={15} /> Aggiungi</button>
      </div>
      {errore && <p role="alert" className="font-maven text-sm text-kidville-error-strong">{errore}</p>}

      {loading ? (
        <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-input bg-kidville-cream-dark" />)}</div>
      ) : !disponibile ? (
        <p className="rounded-card bg-kidville-cream-dark px-4 py-8 text-center font-maven text-sm text-kidville-muted">Le News non sono ancora disponibili su questo ambiente.</p>
      ) : (
        <ul className="divide-y divide-kidville-line rounded-card border border-kidville-line bg-kidville-white">
          {categorie.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <Tag size={16} className="flex-shrink-0 text-kidville-green" strokeWidth={2} />
              {c.is_sistema ? (
                <span className="min-w-0 flex-1 truncate font-maven text-sm text-kidville-ink">{c.nome}</span>
              ) : (
                <input
                  defaultValue={c.nome}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== c.nome) void rinomina(c.id, v); }}
                  className={cx(INPUT, 'min-w-0 flex-1 py-1.5')}
                  aria-label={`Rinomina ${c.nome}`}
                />
              )}
              {c.is_sistema ? (
                <span className="inline-flex flex-shrink-0 items-center gap-1 font-barlow text-[10.5px] font-bold uppercase tracking-wide text-kidville-muted"><Lock size={12} /> Sistema</span>
              ) : (
                <button type="button" onClick={() => void elimina(c.id)} aria-label={`Elimina ${c.nome}`} className="flex-shrink-0 text-kidville-error-strong"><Trash2 size={16} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
