'use client';

// ─── Impostazioni cassa: fondo fisso + soglia d'avviso (solo admin) ────────────
// Fondo cassa (resta in cassa dopo lo svuotamento) e soglia contanti oltre la
// quale scatta la notifica `cassa_soglia`. Salva in `admin_settings.cassa_config`
// via PATCH shallow-merge: invia SOLO le due chiavi note { fondo, soglia_avviso }
// e MAI lo spread della config letta, così lo stato interno anti-spam
// (`soglia_notificata_il`, scritto solo dal server) non viene mai sovrascritto.

import { useEffect, useState } from 'react';
import { Save, SlidersHorizontal } from 'lucide-react';
import { logClient } from '@/lib/logging/client';
import { hdr, card, h3, input, label, hint } from '../settings/ui';
import { BTN_PRIMARY_AA } from './ui';
import type { CassaConfig } from '@/lib/cassa/tipi';

interface Props {
  userId: string;
  scuolaId: string;
}

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function CassaImpostazioni({ userId, scuolaId }: Props) {
  const [fondo, setFondo] = useState('');
  const [soglia, setSoglia] = useState('');
  const [caricato, setCaricato] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/admin/settings?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
      .then((r) => r.json())
      .then((d: { success?: boolean; data?: { cassa_config?: CassaConfig } }) => {
        if (!active) return;
        const cfg = (d?.success ? d.data?.cassa_config : undefined) ?? {};
        setFondo(cfg.fondo != null ? String(cfg.fondo) : '');
        setSoglia(cfg.soglia_avviso != null ? String(cfg.soglia_avviso) : '');
        setCaricato(true);
      })
      .catch((err) => {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `GET settings cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) setCaricato(true);
      });
    return () => { active = false; };
  }, [userId, scuolaId]);

  const salva = async () => {
    setSaving(true);
    setMsg('');
    setError(null);
    try {
      // SOLO le due chiavi note: mai lo spread della config letta (proteggo
      // `soglia_notificata_il`, gestito unicamente dal server).
      const cassa_config = {
        fondo: fondo.trim() === '' ? 0 : Number(fondo),
        soglia_avviso: soglia.trim() === '' ? null : Number(soglia),
      };
      const res = await fetch(`/api/admin/settings?userId=${userId}`, {
        method: 'PATCH', headers: hdr(userId),
        body: JSON.stringify({ scuola_id: scuolaId, cassa_config }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (j.success) setMsg('Impostazioni cassa salvate.');
      else setError(j.error ?? 'Errore di salvataggio.');
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `PATCH settings cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError('Errore di rete nel salvataggio.');
    } finally {
      setSaving(false);
    }
  };

  if (!caricato) return <p className="py-8 text-center font-maven text-sm text-kidville-sub">Caricamento…</p>;

  return (
    <section className={card}>
      <h3 className={h3}><SlidersHorizontal size={16} /> Impostazioni cassa</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label htmlFor="cassa-fondo" className={label}>Fondo cassa (€)</label>
          <input id="cassa-fondo" type="number" min="0" step="0.01" value={fondo} onChange={(e) => setFondo(e.target.value)} className={`${input} w-full`} />
          <p className={hint}>È il contante che resta in cassa dopo ogni svuotamento.</p>
        </div>
        <div>
          <label htmlFor="cassa-soglia" className={label}>Soglia d&apos;avviso contanti (€)</label>
          <input id="cassa-soglia" type="number" min="0" step="0.01" value={soglia} onChange={(e) => setSoglia(e.target.value)} className={`${input} w-full`} placeholder="Vuoto = nessun avviso" />
          <p className={hint}>Oltre questa soglia gli amministratori ricevono una notifica. Lascia vuoto per disattivare.</p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button onClick={salva} disabled={saving} className={BTN_PRIMARY_AA}><Save size={14} /> {saving ? 'Salvataggio…' : 'Salva'}</button>
        {msg && <span role="status" className="font-maven text-sm text-kidville-success-strong">{msg}</span>}
        {error && <span role="alert" className="font-maven text-sm text-kidville-error-strong">{error}</span>}
      </div>
    </section>
  );
}
