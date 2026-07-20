'use client';

// ─── Modale «Registra uscita» / «Entrata manuale» del registro di cassa ───────
// Form denaro (euro decimali, step 0.01) con categoria obbligatoria SOLO per le
// uscite, metodo (solo i contanti muovono il saldo → banner d'avviso), data,
// descrizione, note e FOTO FACOLTATIVA del giustificativo (upload diretto su
// Storage privato via URL firmato). Se la foto non si carica, il movimento viene
// comunque salvato senza allegato (decisione #6: nessun blocco). Tutte le
// risposte del server sono gestite senza crash (400 validazione, 503 schema
// assente su ambiente non migrato). Solo token `kidville-*`, mai hex.

import { useEffect, useRef, useState } from 'react';
import { X, Wallet, TrendingDown, TrendingUp } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { MODAL_CARD, MODAL_SHADOW, INPUT, SELECT, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { logClient } from '@/lib/logging/client';
import type { CassaCategoria, CassaMetodo } from '@/lib/cassa/tipi';

interface Props {
  userId: string;
  scuolaId: string;
  /** Preselezione dal bottone d'apertura (l'utente può comunque cambiarla). */
  tipoIniziale: 'uscita' | 'entrata';
  onClose: () => void;
  onDone: () => void;
  /** Ripristino focus (WCAG 2.4.3): il bottone che ha aperto la modale. */
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

const ERRORE_ID = 'cassa-mov-errore';

/** Nome italiano dei campi del form, per un 400 azionabile (RC1/E3.2). */
const CAMPO_LABEL: Record<string, string> = {
  importo: 'Importo',
  categoria_id: 'Categoria',
  metodo: 'Metodo',
  data: 'Data',
  descrizione: 'Descrizione',
  note: 'Note',
  allegato_path: 'Foto del giustificativo',
  scuola_id: 'Sede',
  tipo: 'Tipo di movimento',
};

/** Costruisce un messaggio che NOMINA i campi rifiutati dal server. */
function messaggioValidazione(errore: string | undefined, campi: string[]): string {
  if (campi.length === 0) return errore ?? 'Errore nel salvataggio del movimento.';
  const nomi = campi.map((c) => CAMPO_LABEL[c] ?? c);
  return `Controlla ${campi.length === 1 ? 'il campo' : 'i campi'}: ${nomi.join(', ')}.`;
}

/** Metodi di pagamento del movimento cassa (contratto §3.1). */
const METODI: { v: CassaMetodo; l: string }[] = [
  { v: 'contanti', l: 'Contanti' },
  { v: 'bonifico', l: 'Bonifico' },
  { v: 'carta', l: 'Carta' },
  { v: 'altro', l: 'Altro' },
];

/** Vincoli del giustificativo (specchio di `@/lib/cassa/store`, ri-validati dal server). */
const FOTO_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const FOTO_MAX_MB = 10;

const TITLE_ID = 'cassa-mov-title';

/** Carica il giustificativo su Storage privato (upload-url firmato → PUT). */
async function caricaAllegato(userId: string, scuolaId: string, file: File): Promise<{ path: string } | { error: string }> {
  if (!FOTO_MIME.includes(file.type)) return { error: 'formato non ammesso (JPG, PNG, WebP o PDF)' };
  if (file.size > FOTO_MAX_MB * 1024 * 1024) return { error: `file troppo grande (max ${FOTO_MAX_MB} MB)` };
  try {
    const res = await fetch(`/api/pagamenti/cassa/allegato/upload-url?userId=${userId}`, {
      method: 'POST',
      headers: hdr(userId),
      body: JSON.stringify({ nome: file.name, mime: file.type, size: file.size, scuola_id: scuolaId }),
    });
    const j = (await res.json()) as { error?: string; data?: { signedUrl?: string; path?: string }; signedUrl?: string; path?: string };
    const payload = j.data ?? j;
    if (!res.ok || !payload.signedUrl || !payload.path) return { error: j.error ?? 'preparazione non riuscita' };
    const put = await fetch(payload.signedUrl, { method: 'PUT', headers: { 'content-type': file.type, 'x-upsert': 'false' }, body: file });
    if (!put.ok) return { error: `caricamento non riuscito (HTTP ${put.status})` };
    return { path: payload.path };
  } catch (err) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `upload allegato cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
    return { error: 'caricamento non riuscito (rete)' };
  }
}

export function CassaMovimentoModal({ userId, scuolaId, tipoIniziale, onClose, onDone, returnFocusRef }: Props) {
  const [tipo, setTipo] = useState<'uscita' | 'entrata'>(tipoIniziale);
  const [importo, setImporto] = useState<number>(0);
  const [categoriaId, setCategoriaId] = useState('');
  const [metodo, setMetodo] = useState<CassaMetodo>('contanti');
  // Data di default nel fuso Europe/Rome (P2): il runtime UTC anteponeva la
  // mezzanotte italiana → un movimento di sera prendeva la data del giorno dopo.
  const [data, setData] = useState(() => oggiFiscaleISO());
  const [descrizione, setDescrizione] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [categorie, setCategorie] = useState<CassaCategoria[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campiErrati, setCampiErrati] = useState<Set<string>>(new Set());
  const [warnFoto, setWarnFoto] = useState<string | null>(null);
  const salvaBtnRef = useRef<HTMLButtonElement>(null);

  // aria per un campo: invalido + collegato al messaggio d'errore (WCAG 3.3.1, P8).
  const ariaCampo = (campo: string) =>
    campiErrati.has(campo) ? { 'aria-invalid': true as const, 'aria-describedby': ERRORE_ID } : {};

  // Categorie di uscita (globali + di sede): servono al select dell'uscita.
  useEffect(() => {
    let active = true;
    fetch(`/api/pagamenti/cassa/categorie?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
      .then((r) => r.json())
      .then((j: { disponibile?: boolean; categorie?: CassaCategoria[] }) => {
        if (!active) return;
        const raw = j?.categorie ?? [];
        // Dedup per slug (una globale e una di sede possono ripetersi): l'ultima vince.
        const perSlug = new Map<string, CassaCategoria>();
        for (const c of raw) if (c.attivo) perSlug.set(c.slug, c);
        setCategorie([...perSlug.values()].sort((a, b) => a.ordine - b.ordine));
      })
      .catch((err) => {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `GET categorie cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      });
    return () => { active = false; };
  }, [userId, scuolaId]);

  const submit = async () => {
    setError(null);
    setCampiErrati(new Set());
    setWarnFoto(null);
    if (!importo || importo <= 0) { setError('Inserisci un importo maggiore di zero.'); setCampiErrati(new Set(['importo'])); return; }
    if (tipo === 'uscita' && !categoriaId) { setError('Seleziona una categoria per l\'uscita.'); setCampiErrati(new Set(['categoria_id'])); return; }
    setSaving(true);
    let allegatoPath: string | null = null;
    try {
      if (file) {
        const up = await caricaAllegato(userId, scuolaId, file);
        if ('error' in up) setWarnFoto(`Foto non caricata (${up.error}): il movimento è stato salvato senza giustificativo.`);
        else allegatoPath = up.path;
      }
      const body: Record<string, unknown> = {
        scuola_id: scuolaId,
        tipo,
        importo,
        metodo,
        data,
        descrizione: descrizione.trim() || null,
        note: note.trim() || null,
      };
      if (tipo === 'uscita') body.categoria_id = categoriaId;
      if (allegatoPath) body.allegato_path = allegatoPath;

      const res = await fetch(`/api/pagamenti/cassa/movimenti?userId=${userId}`, {
        method: 'POST',
        headers: hdr(userId),
        body: JSON.stringify(body),
      });
      if (res.status === 503) { setError('Il modulo cassa non è ancora attivo su questo ambiente.'); return; }
      const j = (await res.json()) as { error?: string; details?: { path?: string }[] };
      if (!res.ok) {
        const campi = (j.details ?? []).map((d) => d.path).filter((p): p is string => typeof p === 'string' && p.length > 0);
        setCampiErrati(new Set(campi));
        setError(messaggioValidazione(j.error, campi));
        return;
      }
      onDone();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `POST movimento cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError('Errore di rete: riprova.');
    } finally {
      setSaving(false);
    }
  };

  const isUscita = tipo === 'uscita';

  return (
    <Modal
      open
      onClose={onClose}
      title={isUscita ? 'Registra uscita' : 'Entrata manuale'}
      labelledBy={TITLE_ID}
      className={MODAL_CARD}
      style={{ boxShadow: MODAL_SHADOW }}
      returnFocusRef={returnFocusRef}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 id={TITLE_ID} className="flex items-center gap-2 font-barlow text-lg font-black uppercase text-kidville-green">
          <Wallet size={18} /> {isUscita ? 'Registra uscita' : 'Entrata manuale'}
        </h3>
        <button onClick={onClose} aria-label="Chiudi" className="-mr-2 flex h-10 w-10 items-center justify-center rounded-pill text-kidville-sub hover:text-kidville-ink"><X size={20} /></button>
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor="cassa-mov-tipo" className="mb-1 block font-maven text-xs text-kidville-sub">Tipo di movimento</label>
          <select
            id="cassa-mov-tipo"
            value={tipo}
            onChange={(e) => { setTipo(e.target.value as 'uscita' | 'entrata'); setError(null); }}
            className={SELECT}
            {...ariaCampo('tipo')}
          >
            <option value="uscita">Uscita (spesa)</option>
            <option value="entrata">Entrata manuale</option>
          </select>
        </div>

        <div>
          <label htmlFor="cassa-mov-importo" className="mb-1 block font-maven text-xs text-kidville-sub">Importo (€)</label>
          <input
            id="cassa-mov-importo"
            type="number" min="0.01" step="0.01" value={importo || ''}
            onChange={(e) => setImporto(e.target.value === '' ? 0 : Number(e.target.value))}
            className={INPUT}
            {...ariaCampo('importo')}
          />
        </div>

        {isUscita && (
          <div>
            <label htmlFor="cassa-mov-categoria" className="mb-1 block font-maven text-xs text-kidville-sub">Categoria</label>
            <select id="cassa-mov-categoria" value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} className={SELECT} {...ariaCampo('categoria_id')}>
              <option value="">— Seleziona una categoria —</option>
              {categorie.map((c) => (
                <option key={c.id} value={c.id}>{c.icona ? `${c.icona} ` : ''}{c.nome}</option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="cassa-mov-metodo" className="mb-1 block font-maven text-xs text-kidville-sub">Metodo</label>
            <select id="cassa-mov-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value as CassaMetodo)} className={SELECT} {...ariaCampo('metodo')}>
              {METODI.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="cassa-mov-data" className="mb-1 block font-maven text-xs text-kidville-sub">Data</label>
            <input id="cassa-mov-data" type="date" value={data} onChange={(e) => setData(e.target.value)} className={INPUT} {...ariaCampo('data')} />
          </div>
        </div>

        {metodo !== 'contanti' && (
          <p className="rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-[11px] leading-snug text-kidville-warn-strong">
            Solo i contanti muovono il saldo cassa: questo movimento resterà nei report ma non cambierà il contante atteso nel cassetto.
          </p>
        )}

        <div>
          <label htmlFor="cassa-mov-descrizione" className="mb-1 block font-maven text-xs text-kidville-sub">Descrizione (facoltativa)</label>
          <input id="cassa-mov-descrizione" type="text" value={descrizione} onChange={(e) => setDescrizione(e.target.value)} className={INPUT} maxLength={300} {...ariaCampo('descrizione')} />
          <p className="mt-1 font-maven text-[11px] text-kidville-sub">Scrivi la causale della spesa (es. «detersivi»), non nomi di bambini o famiglie.</p>
        </div>

        <div>
          <label htmlFor="cassa-mov-note" className="mb-1 block font-maven text-xs text-kidville-sub">Note / riferimento (facoltativo)</label>
          <input id="cassa-mov-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} maxLength={500} {...ariaCampo('note')} />
        </div>

        <div>
          <label htmlFor="cassa-mov-foto" className="mb-1 block font-maven text-xs text-kidville-sub">Foto del giustificativo (facoltativa)</label>
          <input
            id="cassa-mov-foto"
            type="file"
            accept={FOTO_MIME.join(',')}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full font-maven text-xs text-kidville-ink file:mr-3 file:rounded-pill file:border-0 file:bg-kidville-green-soft file:px-3 file:py-1.5 file:font-barlow file:text-xs file:font-bold file:uppercase file:text-kidville-green hover:file:bg-kidville-green/20"
          />
          <p className="mt-1 font-maven text-[11px] text-kidville-sub">Scontrino o ricevuta. JPG, PNG, WebP o PDF, max {FOTO_MAX_MB} MB.</p>
        </div>

        {warnFoto && <p role="status" className="rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn-strong">{warnFoto}</p>}
        {error && <p id={ERRORE_ID} role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}
      </div>

      <div className="mt-5 flex gap-2">
        <button onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>Annulla</button>
        <button ref={salvaBtnRef} onClick={submit} disabled={saving} className={cx(BTN_PRIMARY_AA, 'flex-1')}>
          {isUscita ? <TrendingDown size={15} /> : <TrendingUp size={15} />}
          {saving ? 'Salvataggio…' : `Salva ${formatEuro(importo || 0)}`}
        </button>
      </div>
    </Modal>
  );
}
