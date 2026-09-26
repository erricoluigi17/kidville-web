'use client';

// ─── Impostazioni cassa: fondo fisso + soglia d'avviso (solo admin) ────────────
// Fondo cassa (resta in cassa dopo lo svuotamento) e soglia contanti oltre la
// quale scatta la notifica `cassa_soglia`. Salva in `admin_settings.cassa_config`
// via PATCH shallow-merge: invia SOLO le due chiavi note { fondo, soglia_avviso }
// e MAI lo spread della config letta, così lo stato interno anti-spam
// (`soglia_notificata_il`, scritto solo dal server) non viene mai sovrascritto.
//
// Sede (P4b): fondo e soglia sono di OGNI sede (`admin_settings` per scuola_id).
// Con più sedi la si sceglie qui dentro; finché non è scelta non si legge e non
// si salva niente, e i campi compaiono solo quando i valori letti sono proprio
// quelli della sede scelta (mai il fondo di un'altra sede sotto il nome di questa).

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Save, SlidersHorizontal } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { hdr, card, h3, input, label, hint } from '../settings/ui';
import { BTN_PRIMARY_AA } from './ui';
import type { CassaConfig } from '@/lib/cassa/tipi';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { CampoSedeCassa, useSedeCassa, type SedeCassa } from './CassaSede';

interface Props {
  userId: string;
  /** Le sedi su cui l'utente può impostare la cassa. Con una sola il selettore non compare. */
  sedi: SedeCassa[];
  /** La sede già scelta dalla pagina, o null (con più sedi si sceglie qui, obbligatoriamente). */
  sedeIniziale: string | null;
}

export function CassaImpostazioni({ userId, sedi, sedeIniziale }: Props) {
  const t = useTranslations('adminContabilita');
  const { scuolaId, scegli } = useSedeCassa(sedi, sedeIniziale);
  const [fondo, setFondo] = useState('');
  const [soglia, setSoglia] = useState('');
  // La sede di cui fondo e soglia in pagina sono i valori letti: i campi si mostrano
  // solo quando coincide con la sede scelta.
  const [caricataPer, setCaricataPer] = useState<string | null>(null);
  const caricato = scuolaId !== null && caricataPer === scuolaId;
  // La sede di cui la LETTURA è fallita (rete, stato non ok, `success` non vero). Per
  // quella sede non si rendono né i campi né «Salva»: dei campi vuoti manderebbero
  // `{ fondo: 0, soglia_avviso: null }` sopra il fondo VERO del suo cassetto.
  const [fallitaPer, setFallitaPer] = useState<string | null>(null);
  const letturaFallita = scuolaId !== null && fallitaPer === scuolaId;
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scuolaId) return;
    let active = true;
    (async () => {
      try {
        const r = await fetch(`/api/admin/settings?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) });
        const d = r.ok ? ((await r.json()) as { success?: boolean; data?: { cassa_config?: CassaConfig } }) : null;
        if (!r.ok || d?.success !== true) {
          // Un 403/500, o un corpo senza `success: true`, NON è una configurazione vuota.
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'cassa-impostazioni-lettura-rifiutata', route: '/admin/pagamenti', stato: r.status });
          if (active) setFallitaPer(scuolaId);
          return;
        }
        if (!active) return;
        const cfg = d.data?.cassa_config ?? {};
        setFondo(cfg.fondo != null ? String(cfg.fondo) : '');
        setSoglia(cfg.soglia_avviso != null ? String(cfg.soglia_avviso) : '');
        setCaricataPer(scuolaId);
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-impostazioni-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) setFallitaPer(scuolaId);
      }
    })();
    return () => { active = false; };
  }, [userId, scuolaId]);

  const cambiaSede = (id: string) => {
    if (id === scuolaId) return;
    scegli(id);
    setMsg('');
    setError(null);
    // Si rilegge da capo: l'avviso di una lettura fallita non vale per la sede nuova, e
    // tornando su quella sede si ritenta invece di restare fermi sull'avviso vecchio.
    setFallitaPer(null);
  };

  const salva = async () => {
    if (!caricato || letturaFallita || !scuolaId) return;
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
      if (j.success) setMsg(t('cassaCfgSalvato'));
      else setError(messaggioDaCorpo(j, t('cassaCfgErrSalvataggio')));
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-impostazioni-salvataggio-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError(t('cassaCfgErroreRete'));
    } finally {
      setSaving(false);
    }
  };

  const piuSedi = sedi.length > 1;
  const selettore = (
    <CampoSedeCassa id="cassa-cfg-sede" className="mb-3 max-w-sm" sedi={sedi} valore={scuolaId} onCambia={cambiaSede} disabled={saving} />
  );

  if (!scuolaId) {
    return (
      <section className={card}>
        <h3 className={h3}><SlidersHorizontal size={16} /> {t('cassaCfgTitolo')}</h3>
        {selettore}
        <p className="font-maven text-sm text-kidville-sub">{sedi.length === 0 ? t('cassaSedeNessuna') : t('cassaSedeScegliPerImpostazioni')}</p>
      </section>
    );
  }

  // Una sede sola: come prima, solo il messaggio di caricamento. Con più sedi il
  // selettore resta in pagina anche mentre si legge, così la scelta si può cambiare.
  if (!caricato && !letturaFallita && !piuSedi) return <p className="py-8 text-center font-maven text-sm text-kidville-sub">{t('cassaCfgCaricamento')}</p>;

  return (
    <section className={card}>
      <h3 className={h3}><SlidersHorizontal size={16} /> {t('cassaCfgTitolo')}</h3>
      {selettore}
      {letturaFallita ? (
        <p role="alert" className="rounded-card bg-kidville-error-soft px-3 py-6 text-center font-maven text-sm text-kidville-error-strong">
          {t('cassaCfgErrLettura')}
        </p>
      ) : !caricato ? (
        <p className="py-8 text-center font-maven text-sm text-kidville-sub">{t('cassaCfgCaricamento')}</p>
      ) : (
      <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label htmlFor="cassa-fondo" className={label}>{t('cassaCfgFondoLabel')}</label>
          <input id="cassa-fondo" type="number" min="0" step="0.01" value={fondo} onChange={(e) => setFondo(e.target.value)} className={`${input} w-full`} />
          <p className={hint}>{t('cassaCfgFondoHint')}</p>
        </div>
        <div>
          <label htmlFor="cassa-soglia" className={label}>{t('cassaCfgSogliaLabel')}</label>
          <input id="cassa-soglia" type="number" min="0" step="0.01" value={soglia} onChange={(e) => setSoglia(e.target.value)} className={`${input} w-full`} placeholder={t('cassaCfgSogliaPlaceholder')} />
          <p className={hint}>{t('cassaCfgSogliaHint')}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button onClick={salva} disabled={saving} className={BTN_PRIMARY_AA}><Save size={14} /> {saving ? t('cassaCfgSalvataggio') : t('cassaCfgSalva')}</button>
        {msg && <span role="status" className="font-maven text-sm text-kidville-success-strong">{msg}</span>}
        {error && <span role="alert" className="font-maven text-sm text-kidville-error-strong">{error}</span>}
      </div>
      </>
      )}
    </section>
  );
}
