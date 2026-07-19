'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Save, Star } from 'lucide-react';
import { logClient } from '@/lib/logging/client';
import {
  DEFAULT_CAUSALE_TEMPLATE,
  PLACEHOLDER_CAUSALE,
  renderCausale,
  type DatiCausale,
} from '@/lib/pagamenti/causale';
import { hdr, card, h3, input, label, hint } from '../settings/ui';
import { BTN_PRIMARY_AA } from './ui';

interface Props {
  userId: string;
  scuolaId: string;
}

interface CategoriaRaw {
  nome: string;
  slug?: string | null;
  icona?: string | null;
}
interface Categoria {
  slug: string;
  nome: string;
  icona: string;
}

/** Chiave della riga «Predefinito» nel JSONB flat `causali_config`. */
const CHIAVE_DEFAULT = 'default';

/**
 * Dati d'esempio dell'anteprima. CF SINTETICO (mai un CF reale di un minore):
 * coincide con l'esempio di `PLACEHOLDER_CAUSALE`. La sede è il nome pubblico
 * della struttura, non un dato personale.
 */
const DATI_ESEMPIO: DatiCausale = {
  descrizione: 'Retta Settembre 2026',
  nome: 'Mario',
  cognome: 'Rossi',
  codiceFiscale: 'RSSMRA85T10A562S',
  sede: 'Kidville Giugliano',
  mese: 'settembre',
  anno: '2026',
  importo: '€ 150,00',
  scadenza: '30/09/2026',
};

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Sezione «Causali» della Contabilità: un MODELLO di causale bonifico
 * personalizzabile PER CATEGORIA (chiave = slug) più un «Predefinito»
 * (chiave `default`). Il JSONB `admin_settings.causali_config` è FLAT
 * (`{ default?, <slug>: }`) e viene salvato in shallow-merge lato server,
 * così ogni riga è indipendente. Anteprima dal vivo con dati sintetici.
 */
export function CausaliPanel({ userId, scuolaId }: Props) {
  const [categorie, setCategorie] = useState<Categoria[]>([]);
  const [modelli, setModelli] = useState<Record<string, string>>({});
  const [caricato, setCaricato] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Campo attivo (per l'inserimento dei chip) + riferimenti agli input, così il
  // segnaposto entra al cursore del campo che l'utente sta modificando.
  const campoAttivo = useRef<string>(CHIAVE_DEFAULT);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    let active = true;
    const onErr = (op: string) => (err: unknown): null => {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `${op} — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      return null;
    };
    Promise.all([
      fetch(`/api/admin/settings/categorie?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
        .then((r) => r.json()).catch(onErr('GET categorie (causali)')),
      fetch(`/api/admin/settings?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
        .then((r) => r.json()).catch(onErr('GET settings (causali)')),
    ]).then(([catRes, cfgRes]) => {
      if (!active) return;
      const raw: CategoriaRaw[] = catRes?.success ? (catRes.data ?? []) : [];
      const cfg = (cfgRes?.success ? (cfgRes.data?.causali_config as Record<string, string> | undefined) : undefined) ?? {};
      // Dedup per slug (globali + scuola possono ripetersi): l'ultima vince.
      const perSlug = new Map<string, Categoria>();
      for (const c of raw) {
        if (!c.slug) continue;
        perSlug.set(String(c.slug), { slug: String(c.slug), nome: c.nome, icona: c.icona ?? '💶' });
      }
      const cats = [...perSlug.values()];
      setCategorie(cats);
      const iniz: Record<string, string> = {
        [CHIAVE_DEFAULT]: cfg[CHIAVE_DEFAULT] ?? DEFAULT_CAUSALE_TEMPLATE,
      };
      for (const c of cats) iniz[c.slug] = cfg[c.slug] ?? '';
      setModelli(iniz);
      setCaricato(true);
    });
    return () => { active = false; };
  }, [userId, scuolaId]);

  const setModello = useCallback((chiave: string, valore: string) => {
    setMsg('');
    setModelli((prev) => ({ ...prev, [chiave]: valore }));
  }, []);

  // Inserisce `{chiave}` nel campo attivo, al cursore (o in coda se il cursore
  // non è determinabile). Ripristina il focus e la posizione del cursore.
  const inserisciSegnaposto = useCallback((chiave: string) => {
    const key = campoAttivo.current || CHIAVE_DEFAULT;
    const token = `{${chiave}}`;
    const el = inputRefs.current[key];
    setMsg('');
    setModelli((prev) => {
      const attuale = prev[key] ?? '';
      if (el && el.selectionStart != null) {
        const start = el.selectionStart;
        const end = el.selectionEnd ?? start;
        const nuovo = attuale.slice(0, start) + token + attuale.slice(end);
        requestAnimationFrame(() => {
          try {
            el.focus();
            const pos = start + token.length;
            el.setSelectionRange(pos, pos);
          } catch {
            // jsdom/WebView senza selection API: il valore è già aggiornato.
            logClient({ livello: 'warn', evento: 'js', messaggio: 'setSelectionRange non disponibile (causali)', route: '/admin/pagamenti' });
          }
        });
        return { ...prev, [key]: nuovo };
      }
      return { ...prev, [key]: attuale + token };
    });
  }, []);

  const salva = useCallback(async () => {
    setSaving(true);
    setMsg('');
    setError(null);
    // Invia TUTTE le righe (anche vuote, come ''): il server tiene solo le stringhe
    // non vuote e RIMUOVE le chiavi svuotate → una riga cancellata torna DAVVERO al
    // Predefinito (lo shallow-merge da solo non potrebbe rimuovere una chiave).
    const causali_config: Record<string, string> = {};
    for (const [chiave, modello] of Object.entries(modelli)) {
      causali_config[chiave] = (modello ?? '').trim();
    }
    try {
      const res = await fetch(`/api/admin/settings?userId=${userId}`, {
        method: 'PATCH',
        headers: hdr(userId),
        body: JSON.stringify({ scuola_id: scuolaId, causali_config }),
      });
      const j = await res.json();
      if (j.success) setMsg('Modelli di causale salvati');
      else setError(j.error ?? 'Errore di salvataggio');
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `PATCH settings causali — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError('Errore di rete nel salvataggio');
    } finally {
      setSaving(false);
    }
  }, [modelli, userId, scuolaId]);

  if (!caricato) {
    return <p className="py-8 text-center font-maven text-sm text-kidville-muted">Caricamento…</p>;
  }

  const righe: { chiave: string; etichetta: string; badge: React.ReactNode }[] = [
    { chiave: CHIAVE_DEFAULT, etichetta: 'Predefinito', badge: <Star size={14} className="text-kidville-green" aria-hidden /> },
    ...categorie.map((c) => ({ chiave: c.slug, etichetta: c.nome, badge: <span aria-hidden>{c.icona}</span> })),
  ];
  const placeholderDefault = (modelli[CHIAVE_DEFAULT] ?? '').trim() || DEFAULT_CAUSALE_TEMPLATE;

  return (
    <section className={card}>
      <h3 className={h3}><Pencil size={16} /> Causali bonifico</h3>
      <p className="font-maven text-[13px] text-kidville-sub mb-4">
        Il modello della causale che il genitore copia nel bonifico. Personalizzabile per categoria;
        una riga lasciata vuota usa il <strong>Predefinito</strong>. Clicca un segnaposto per inserirlo
        nel campo selezionato.
      </p>

      {/* Chip dei segnaposto: inseriscono {chiave} nel campo attivo. */}
      <div className="flex flex-wrap gap-2 mb-5" role="group" aria-label="Segnaposto disponibili">
        {PLACEHOLDER_CAUSALE.map((p) => (
          <button
            key={p.chiave}
            type="button"
            onClick={() => inserisciSegnaposto(p.chiave)}
            title={`${p.label} · es. ${p.esempio}`}
            className="inline-flex items-center gap-1.5 rounded-pill bg-kidville-cream px-3 py-1.5 font-maven text-xs text-kidville-green ring-[1.5px] ring-inset ring-kidville-green/20 transition-colors hover:ring-kidville-green outline-none focus-visible:ring-2 focus-visible:ring-kidville-green"
          >
            <code className="font-semibold">{`{${p.chiave}}`}</code>
            <span className="text-kidville-sub">{p.label}</span>
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {righe.map(({ chiave, etichetta, badge }) => {
          const id = `causale-${chiave}`;
          // Riga vuota → anteprima col modello che il server userà DAVVERO: per una
          // categoria è il «Predefinito» VIVO (non l'hardcoded), così anteprima = runtime.
          const fallback = chiave === CHIAVE_DEFAULT ? DEFAULT_CAUSALE_TEMPLATE : placeholderDefault;
          const anteprima = renderCausale((modelli[chiave] || '').trim() || fallback, DATI_ESEMPIO);
          return (
            <div key={chiave} className="rounded-xl border-2 border-kidville-line p-3">
              <label htmlFor={id} className={`${label} flex items-center gap-1.5`}>
                {badge} {etichetta}
              </label>
              <input
                id={id}
                ref={(el) => { inputRefs.current[chiave] = el; }}
                value={modelli[chiave] ?? ''}
                onChange={(e) => setModello(chiave, e.target.value)}
                onFocus={() => { campoAttivo.current = chiave; }}
                placeholder={chiave === CHIAVE_DEFAULT ? DEFAULT_CAUSALE_TEMPLATE : placeholderDefault}
                className={`${input} w-full`}
              />
              <p className="mt-1.5 flex flex-wrap items-baseline gap-1.5">
                <span className="font-barlow text-[10px] font-extrabold uppercase tracking-wide text-kidville-sub">Anteprima</span>
                <span className="rounded bg-kidville-cream px-2 py-0.5 font-maven text-[12.5px] text-kidville-ink">
                  {anteprima || '—'}
                </span>
              </p>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={salva} disabled={saving} className={BTN_PRIMARY_AA}>
          <Save size={14} /> {saving ? 'Salvataggio…' : 'Salva'}
        </button>
        {msg && <span role="status" className="font-maven text-sm text-kidville-success">{msg}</span>}
        {error && <span role="alert" className="font-maven text-sm text-kidville-error">{error}</span>}
      </div>
      <p className={hint}>L&apos;anteprima usa dati d&apos;esempio; i dati reali del minore restano visibili solo al genitore.</p>
    </section>
  );
}
