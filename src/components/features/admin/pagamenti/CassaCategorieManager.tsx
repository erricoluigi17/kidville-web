'use client';

// ─── Gestione delle categorie di USCITA della cassa (solo admin) ───────────────
// Clone del pattern `settings/SettingsPanel → CategorieManager`, puntato a
// `cassa_categorie`. Chip con lucchetto sulle categorie di sistema (non
// eliminabili → 409 dal server, gestito con un messaggio), aggiunta a slug
// generato server-side. Degrada su ambiente non migrato (disponibile:false).

import { useCallback, useEffect, useState } from 'react';
import { Tag, Plus, Trash2, Lock } from 'lucide-react';
import { logClient } from '@/lib/logging/client';
import { hdr, card, h3, input, hint } from '../settings/ui';
import { BTN_PRIMARY_AA } from './ui';
import type { CassaCategoria } from '@/lib/cassa/tipi';

interface Props {
  userId: string;
  scuolaId: string;
}

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function CassaCategorieManager({ userId, scuolaId }: Props) {
  const [cats, setCats] = useState<CassaCategoria[]>([]);
  const [disponibile, setDisponibile] = useState(true);
  const [nuovo, setNuovo] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/pagamenti/cassa/categorie?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
      .then((r) => r.json())
      .then((j: { disponibile?: boolean; categorie?: CassaCategoria[] }) => {
        setDisponibile(j?.disponibile !== false);
        setCats((j?.categorie ?? []).slice().sort((a, b) => a.ordine - b.ordine));
      })
      .catch((err) => {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `GET categorie cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      });
  }, [userId, scuolaId]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!nuovo.trim()) return;
    setError(null);
    try {
      const res = await fetch(`/api/pagamenti/cassa/categorie?userId=${userId}`, {
        method: 'POST', headers: hdr(userId),
        body: JSON.stringify({ scuola_id: scuolaId, nome: nuovo.trim() }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) { setError(j.error ?? 'Impossibile aggiungere la categoria.'); return; }
      setNuovo('');
      load();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `POST categoria cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError('Errore di rete: riprova.');
    }
  };

  const del = async (id: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/pagamenti/cassa/categorie?userId=${userId}&id=${id}&scuola_id=${scuolaId}`, { method: 'DELETE', headers: hdr(userId) });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setError(j.error ?? 'Impossibile eliminare la categoria.');
      }
      load();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `DELETE categoria cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError('Errore di rete: riprova.');
    }
  };

  return (
    <section className={card}>
      <h3 className={h3}><Tag size={16} /> Categorie di uscita</h3>
      {!disponibile ? (
        <p className="font-maven text-sm text-kidville-sub">Modulo cassa non ancora attivo su questo ambiente.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {cats.map((c) => (
              <span key={c.id} className="flex max-w-full items-center gap-1 rounded-pill bg-kidville-cream py-1 pl-3 pr-2 font-maven text-sm text-kidville-green [overflow-wrap:anywhere]">
                {c.icona ? `${c.icona} ` : ''}{c.nome}
                {c.is_sistema
                  ? <Lock size={11} role="img" className="shrink-0 text-kidville-sub" aria-label="categoria di sistema" />
                  : <button onClick={() => del(c.id)} aria-label={`Elimina ${c.nome}`} className="shrink-0 text-kidville-sub hover:text-kidville-error"><Trash2 size={13} /></button>}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <label htmlFor="cassa-nuova-cat" className="sr-only">Nuova categoria di uscita</label>
            <input id="cassa-nuova-cat" value={nuovo} onChange={(e) => setNuovo(e.target.value)} placeholder="Nuova categoria…" className={`${input} min-w-0 flex-1`} />
            <button onClick={add} className={BTN_PRIMARY_AA}><Plus size={14} /> Aggiungi</button>
          </div>
          {error && <p role="alert" className="mt-2 font-maven text-xs text-kidville-error-strong">{error}</p>}
          <p className={hint}><Lock size={10} role="img" aria-label="categoria di sistema" className="inline" /> = categoria di sistema (non eliminabile).</p>
        </>
      )}
    </section>
  );
}
