'use client';

// ─── Gestione delle categorie di USCITA della cassa (solo admin) ───────────────
// Clone del pattern `settings/SettingsPanel → CategorieManager`, puntato a
// `cassa_categorie`. Chip con lucchetto sulle categorie di sistema (non
// eliminabili → 409 dal server, gestito con un messaggio), aggiunta a slug
// generato server-side. Degrada su ambiente non migrato (disponibile:false).
//
// Sede (P4b): le categorie di sede si gestiscono una sede alla volta. Con più sedi
// la si sceglie qui dentro; finché non è scelta non si legge e non si scrive
// niente. Lettura, aggiunta ed eliminazione usano tutte la sede scelta. Mentre un
// POST o un DELETE è in volo il selettore è fermo; e se la sede cambia comunque, esito,
// errore e rilettura di quella scrittura si scartano (ref `sedeCorrente`).
// Una lettura RIFIUTATA (403 `SEDE_NON_ACCESSIBILE`, 500, rete) non è un elenco vuoto:
// si logga con lo stato e, per quella sede, al posto di chip e «Aggiungi» c'è un avviso.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Tag, Plus, Trash2, Lock } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { hdr, card, h3, input, hint } from '../settings/ui';
import { BTN_PRIMARY_AA } from './ui';
import type { CassaCategoria } from '@/lib/cassa/tipi';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { CampoSedeCassa, useSedeCassa, type SedeCassa } from './CassaSede';

interface Props {
  userId: string;
  /** Le sedi su cui l'utente può gestire le categorie. Con una sola il selettore non compare. */
  sedi: SedeCassa[];
  /** La sede già scelta dalla pagina, o null (con più sedi si sceglie qui, obbligatoriamente). */
  sedeIniziale: string | null;
}

export function CassaCategorieManager({ userId, sedi, sedeIniziale }: Props) {
  const t = useTranslations('adminContabilita');
  const { scuolaId, scegli } = useSedeCassa(sedi, sedeIniziale);
  // Numero dell'ultima lettura partita: una risposta più vecchia (di un'altra sede)
  // arriva dopo e non deve sovrascrivere l'elenco della sede scelta per ultima.
  const ultimaLettura = useRef(0);
  // La sede scelta ADESSO, letta dopo un `await`. Una scrittura parte con la sede del suo
  // render; quando la risposta arriva, la sede può essere cambiata: esito, errore e
  // rilettura di quella scrittura si scartano, invece di finire sotto il nome dell'altra.
  const sedeCorrente = useRef<string | null>(scuolaId);
  useLayoutEffect(() => { sedeCorrente.current = scuolaId; }, [scuolaId]);
  const [cats, setCats] = useState<CassaCategoria[]>([]);
  const [disponibile, setDisponibile] = useState(true);
  const [nuovo, setNuovo] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Un POST o un DELETE in volo: selettore, «Aggiungi» e cestini restano fermi, come
  // nelle altre finestre che disabilitano la sede durante il salvataggio.
  const [busy, setBusy] = useState(false);
  // La sede di cui la LETTURA è fallita (rete, 403 `SEDE_NON_ACCESSIBILE`, 500). Il corpo
  // `{ error, codice }` di un rifiuto NON è un elenco vuoto: per quella sede niente chip e
  // niente «Aggiungi», ma un avviso. Come `fallitaPer` in CassaImpostazioni.
  const [fallitaPer, setFallitaPer] = useState<string | null>(null);
  const letturaFallita = scuolaId !== null && fallitaPer === scuolaId;

  // La sede è un ARGOMENTO, non una closure: chi rilegge dopo una scrittura dice di quale
  // sede, e la risposta vale solo se è ancora la sede scelta (e l'ultima lettura partita).
  const load = useCallback((sede: string) => {
    const n = ++ultimaLettura.current;
    const valida = () => n === ultimaLettura.current && sede === sedeCorrente.current;
    fetch(`/api/pagamenti/cassa/categorie?userId=${userId}&scuola_id=${sede}`, { headers: hdr(userId) })
      .then(async (r) => {
        if (!r.ok) {
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'cassa-categorie-lettura-rifiutata', route: '/admin/pagamenti', stato: r.status });
          if (valida()) { setCats([]); setFallitaPer(sede); }
          return;
        }
        const j = (await r.json()) as { disponibile?: boolean; categorie?: CassaCategoria[] };
        if (!valida()) return;
        setFallitaPer(null);
        setDisponibile(j?.disponibile !== false);
        setCats((j?.categorie ?? []).slice().sort((a, b) => a.ordine - b.ordine));
      })
      .catch((err) => {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-categorie-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (valida()) { setCats([]); setFallitaPer(sede); }
      });
  }, [userId]);

  useEffect(() => { if (scuolaId) load(scuolaId); }, [load, scuolaId]);

  const cambiaSede = (id: string) => {
    if (id === scuolaId) return;
    sedeCorrente.current = id;
    scegli(id);
    // L'elenco in pagina era dell'altra sede: via subito, poi si rilegge. Anche l'avviso di
    // una lettura fallita era dell'altra sede: tornandoci si ritenta.
    setCats([]);
    setDisponibile(true);
    setError(null);
    setFallitaPer(null);
  };

  /** Vero se, al ritorno della scrittura partita per `sede`, la sede scelta è cambiata. */
  const superata = (sede: string) => sede !== sedeCorrente.current;

  const add = async () => {
    const sede = scuolaId;
    if (!sede || !nuovo.trim() || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/pagamenti/cassa/categorie?userId=${userId}`, {
        method: 'POST', headers: hdr(userId),
        body: JSON.stringify({ scuola_id: sede, nome: nuovo.trim() }),
      });
      const j = (await res.json()) as { error?: string };
      if (superata(sede)) return;
      if (!res.ok) { setError(messaggioDaCorpo(j, t('cassaCatErrAggiungi'))); return; }
      setNuovo('');
      load(sede);
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-categoria-creazione-fallita: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      if (!superata(sede)) setError(t('cassaCatErroreRete'));
    } finally {
      setBusy(false);
    }
  };

  const del = async (id: string) => {
    const sede = scuolaId;
    if (!sede || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/pagamenti/cassa/categorie?userId=${userId}&id=${id}&scuola_id=${sede}`, { method: 'DELETE', headers: hdr(userId) });
      const j = res.ok ? null : ((await res.json()) as { error?: string });
      if (superata(sede)) return;
      if (j) setError(messaggioDaCorpo(j, t('cassaCatErrElimina')));
      load(sede);
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-categoria-eliminazione-fallita: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      if (!superata(sede)) setError(t('cassaCatErroreRete'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={card}>
      <h3 className={h3}><Tag size={16} /> {t('cassaCatTitolo')}</h3>
      <CampoSedeCassa id="cassa-cat-sede" className="mb-3 max-w-sm" sedi={sedi} valore={scuolaId} onCambia={cambiaSede} disabled={busy} />
      {!scuolaId ? (
        <p className="font-maven text-sm text-kidville-sub">{sedi.length === 0 ? t('cassaSedeNessuna') : t('cassaSedeScegliPerCategorie')}</p>
      ) : letturaFallita ? (
        <p role="alert" className="rounded-card bg-kidville-error-soft px-3 py-4 font-maven text-sm text-kidville-error-strong">{t('cassaCatErrLettura')}</p>
      ) : !disponibile ? (
        <p className="font-maven text-sm text-kidville-sub">{t('cassaCatNonAttivo')}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {cats.map((c) => (
              <span key={c.id} className="flex max-w-full items-center gap-1 rounded-pill bg-kidville-cream py-1 pl-3 pr-2 font-maven text-sm text-kidville-green [overflow-wrap:anywhere]">
                {c.icona ? `${c.icona} ` : ''}{c.nome}
                {c.is_sistema
                  ? <Lock size={11} role="img" className="shrink-0 text-kidville-sub" aria-label={t('cassaCatSistemaAria')} />
                  : <button onClick={() => del(c.id)} disabled={busy} aria-label={`${t('cassaCatElimina')} ${c.nome}`} className="shrink-0 text-kidville-sub hover:text-kidville-error"><Trash2 size={13} /></button>}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <label htmlFor="cassa-nuova-cat" className="sr-only">{t('cassaCatNuovaLabel')}</label>
            <input id="cassa-nuova-cat" value={nuovo} onChange={(e) => setNuovo(e.target.value)} placeholder={t('cassaCatPlaceholder')} className={`${input} min-w-0 flex-1`} />
            <button onClick={add} disabled={busy} className={BTN_PRIMARY_AA}><Plus size={14} /> {t('cassaCatAggiungi')}</button>
          </div>
          {error && <p role="alert" className="mt-2 font-maven text-xs text-kidville-error-strong">{error}</p>}
          <p className={hint}><Lock size={10} role="img" aria-label={t('cassaCatSistemaAria')} className="inline" /> {t('cassaCatSistemaHint')}</p>
        </>
      )}
    </section>
  );
}
