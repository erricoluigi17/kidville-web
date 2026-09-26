'use client';

// ─── Modale «Registra uscita» / «Entrata manuale» del registro di cassa ───────
// Form denaro (euro decimali, step 0.01) con categoria obbligatoria SOLO per le
// uscite, metodo (solo i contanti muovono il saldo → banner d'avviso), data,
// descrizione, note e FOTO FACOLTATIVA del giustificativo (upload diretto su
// Storage privato via URL firmato). Se la foto non si carica, il movimento viene
// comunque salvato senza allegato (decisione #6: nessun blocco). Tutte le
// risposte del server sono gestite senza crash (400 validazione, 503 schema
// assente su ambiente non migrato). Solo token `kidville-*`, mai hex.
//
// Sede (P4b): il movimento è di UNA sede, scelta qui dentro quando le sedi sono
// più d'una (vedi `CassaSede`). Categorie, allegato e POST usano tutti la sede
// scelta; senza sede non si legge niente e non si salva niente. Una lettura delle
// categorie rifiutata (403/500/rete) si logga con lo stato e si dice accanto al select.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X, Wallet, TrendingDown, TrendingUp } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { MODAL_CARD, MODAL_SHADOW, INPUT, SELECT, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';
import type { CassaCategoria, CassaMetodo } from '@/lib/cassa/tipi';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { CampoSedeCassa, useSedeCassa, type SedeCassa } from './CassaSede';

interface Props {
  userId: string;
  /** Le sedi su cui l'utente può scrivere. Con una sola il selettore non compare. */
  sedi: SedeCassa[];
  /** La sede già scelta dalla pagina, o null (con più sedi si sceglie qui, obbligatoriamente). */
  sedeIniziale: string | null;
  /** Preselezione dal bottone d'apertura (l'utente può comunque cambiarla). */
  tipoIniziale: 'uscita' | 'entrata';
  onClose: () => void;
  onDone: () => void;
  /** Ripristino focus (WCAG 2.4.3): il bottone che ha aperto la modale. */
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
}

type Traduttore = ReturnType<typeof useTranslations>;

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

const ERRORE_ID = 'cassa-mov-errore';
/** Avviso accanto al select della categoria quando la lettura delle categorie è fallita. */
const CAT_ERRORE_ID = 'cassa-mov-categorie-errore';

/** Chiave i18n del nome italiano dei campi del form, per un 400 azionabile (RC1/E3.2). */
const CAMPO_LABEL_KEY: Record<string, string> = {
  importo: 'cassaMovCampoImporto',
  categoria_id: 'cassaMovCampoCategoria',
  metodo: 'cassaMovCampoMetodo',
  data: 'cassaMovCampoData',
  descrizione: 'cassaMovCampoDescrizione',
  note: 'cassaMovCampoNote',
  allegato_path: 'cassaMovCampoAllegato',
  scuola_id: 'cassaMovCampoSede',
  tipo: 'cassaMovCampoTipo',
};

/**
 * Costruisce un messaggio che NOMINA i campi rifiutati dal server.
 *
 * Riceve il CORPO, non la sola `error`: quando il rifiuto non nomina campi (403 di sede,
 * 500) il testo lo decide `messaggioDaCorpo`, cioè il catalogo se il server ha mandato un
 * codice dichiarato. Prima qui arrivava `j.error` e basta, e un «Sede non accessibile»
 * finiva a schermo in italiano anche con l'interfaccia in inglese.
 */
function messaggioValidazione(corpo: unknown, campi: string[], t: Traduttore): string {
  if (campi.length === 0) return messaggioDaCorpo(corpo, t('cassaMovErrDefault'));
  const nomi = campi.map((c) => { const k = CAMPO_LABEL_KEY[c]; return k ? t(k) : c; });
  return `${t('cassaMovControlla')} ${campi.length === 1 ? t('cassaMovIlCampo') : t('cassaMovICampi')}: ${nomi.join(', ')}.`;
}

/** Metodi di pagamento del movimento cassa (contratto §3.1); `l` = chiave i18n. */
const METODI: { v: CassaMetodo; l: string }[] = [
  { v: 'contanti', l: 'cassaMovMetodoContanti' },
  { v: 'bonifico', l: 'cassaMovMetodoBonifico' },
  { v: 'carta', l: 'cassaMovMetodoCarta' },
  { v: 'altro', l: 'cassaMovMetodoAltro' },
];

/** Vincoli del giustificativo (specchio di `@/lib/cassa/store`, ri-validati dal server). */
const FOTO_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const FOTO_MAX_MB = 10;

const TITLE_ID = 'cassa-mov-title';

/** Carica il giustificativo su Storage privato (upload-url firmato → PUT). */
async function caricaAllegato(userId: string, scuolaId: string, file: File, t: Traduttore): Promise<{ path: string } | { error: string }> {
  if (!FOTO_MIME.includes(file.type)) return { error: t('cassaMovFotoFormato') };
  if (file.size > FOTO_MAX_MB * 1024 * 1024) return { error: `${t('cassaMovFotoGrandePre')}${FOTO_MAX_MB}${t('cassaMovFotoGrandePost')}` };
  try {
    const res = await fetch(`/api/pagamenti/cassa/allegato/upload-url?userId=${userId}`, {
      method: 'POST',
      headers: hdr(userId),
      body: JSON.stringify({ nome: file.name, mime: file.type, size: file.size, scuola_id: scuolaId }),
    });
    const j = (await res.json()) as { error?: string; data?: { signedUrl?: string; path?: string }; signedUrl?: string; path?: string };
    const payload = j.data ?? j;
    if (!res.ok || !payload.signedUrl || !payload.path) return { error: messaggioDaCorpo(j, t('cassaMovFotoPrep')) };
    const put = await fetch(payload.signedUrl, { method: 'PUT', headers: { 'content-type': file.type, 'x-upsert': 'false' }, body: file });
    if (!put.ok) return { error: `${t('cassaMovFotoHttpPre')}${put.status}${t('cassaMovFotoHttpPost')}` };
    return { path: payload.path };
  } catch (err) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-allegato-upload-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
    return { error: t('cassaMovFotoRete') };
  }
}

export function CassaMovimentoModal({ userId, sedi, sedeIniziale, tipoIniziale, onClose, onDone, returnFocusRef }: Props) {
  const t = useTranslations('adminContabilita');
  const { scuolaId, scegli } = useSedeCassa(sedi, sedeIniziale);
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
  // La sede di cui la lettura delle categorie è fallita (vedi l'effetto qui sotto).
  const [categorieFallitePer, setCategorieFallitePer] = useState<string | null>(null);
  const categorieNonLette = scuolaId !== null && categorieFallitePer === scuolaId;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campiErrati, setCampiErrati] = useState<Set<string>>(new Set());
  const [warnFoto, setWarnFoto] = useState<string | null>(null);
  const salvaBtnRef = useRef<HTMLButtonElement>(null);

  // aria per un campo: invalido + collegato al messaggio d'errore (WCAG 3.3.1, P8).
  const ariaCampo = (campo: string) =>
    campiErrati.has(campo) ? { 'aria-invalid': true as const, 'aria-describedby': ERRORE_ID } : {};

  // Categorie di uscita (globali + della sede scelta): servono al select dell'uscita.
  // Senza sede non si legge niente: nessuna sede «indovinata» nell'URL.
  // Una lettura RIFIUTATA (403 `SEDE_NON_ACCESSIBILE`, 500, rete) non è «nessuna categoria»:
  // il select resta vuoto ma dice perché, e «Salva» su un'uscita non risponde «seleziona una
  // categoria», che porterebbe fuori strada.
  useEffect(() => {
    if (!scuolaId) return;
    let active = true;
    (async () => {
      try {
        const r = await fetch(`/api/pagamenti/cassa/categorie?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) });
        if (!r.ok) {
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'cassa-categorie-lettura-rifiutata', route: '/admin/pagamenti', stato: r.status });
          if (active) { setCategorie([]); setCategorieFallitePer(scuolaId); }
          return;
        }
        const j = (await r.json()) as { disponibile?: boolean; categorie?: CassaCategoria[] };
        if (!active) return;
        const raw = j?.categorie ?? [];
        // Dedup per slug (una globale e una di sede possono ripetersi): l'ultima vince.
        const perSlug = new Map<string, CassaCategoria>();
        for (const c of raw) if (c.attivo) perSlug.set(c.slug, c);
        setCategorieFallitePer(null);
        setCategorie([...perSlug.values()].sort((a, b) => a.ordine - b.ordine));
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-categorie-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) { setCategorie([]); setCategorieFallitePer(scuolaId); }
      }
    })();
    return () => { active = false; };
  }, [userId, scuolaId]);

  const cambiaSede = (id: string) => {
    scegli(id);
    // Le categorie di sede non valgono per un'altra sede: la scelta si rifà sulla lista nuova.
    setCategorie([]);
    setCategoriaId('');
    setCategorieFallitePer(null);
    setError(null);
    setCampiErrati(new Set());
  };

  const submit = async () => {
    setError(null);
    setCampiErrati(new Set());
    setWarnFoto(null);
    if (!scuolaId) {
      // Con zero sedi il form non è nemmeno reso (vedi sotto): qui si arriva solo con più
      // sedi e nessuna scelta, e il campo da marcare è il selettore, che c'è.
      setError(t('cassaSedeObbligatoria'));
      setCampiErrati(new Set(['scuola_id']));
      return;
    }
    if (!importo || importo <= 0) { setError(t('cassaMovImportoZero')); setCampiErrati(new Set(['importo'])); return; }
    // Categorie non lette: l'avviso accanto al select dice già perché (e il select vi
    // rimanda con aria-describedby); qui si marca soltanto il campo, senza un secondo testo.
    if (tipo === 'uscita' && categorieNonLette) { setCampiErrati(new Set(['categoria_id'])); return; }
    if (tipo === 'uscita' && !categoriaId) { setError(t('cassaMovCategoriaUscita')); setCampiErrati(new Set(['categoria_id'])); return; }
    setSaving(true);
    let allegatoPath: string | null = null;
    try {
      if (file) {
        const up = await caricaAllegato(userId, scuolaId, file, t);
        if ('error' in up) setWarnFoto(`${t('cassaMovFotoNonCaricataPre')}${up.error}${t('cassaMovFotoNonCaricataPost')}`);
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
      if (res.status === 503) { setError(t('cassaMovNonAttivo503')); return; }
      const j = (await res.json()) as { error?: string; details?: { path?: string }[] };
      if (!res.ok) {
        const campi = (j.details ?? []).map((d) => d.path).filter((p): p is string => typeof p === 'string' && p.length > 0);
        setCampiErrati(new Set(campi));
        setError(messaggioValidazione(j, campi, t));
        return;
      }
      onDone();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-movimento-salvataggio-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError(t('cassaMovErroreRete'));
    } finally {
      setSaving(false);
    }
  };

  const isUscita = tipo === 'uscita';

  return (
    <Modal
      open
      onClose={onClose}
      title={isUscita ? t('cassaMovRegistraUscita') : t('cassaMovEntrataManuale')}
      labelledBy={TITLE_ID}
      className={MODAL_CARD}
      style={{ boxShadow: MODAL_SHADOW }}
      returnFocusRef={returnFocusRef}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 id={TITLE_ID} className="flex items-center gap-2 font-barlow text-lg font-black uppercase text-kidville-green">
          <Wallet size={18} /> {isUscita ? t('cassaMovRegistraUscita') : t('cassaMovEntrataManuale')}
        </h3>
        <button onClick={onClose} aria-label={t('cassaMovChiudi')} className="-mr-2 flex h-10 w-10 items-center justify-center rounded-pill text-kidville-sub hover:text-kidville-ink"><X size={20} /></button>
      </div>

      {sedi.length === 0 ? (
        // Nessuna sede su cui scrivere: lo si dice SUBITO, come nelle altre tre finestre,
        // al posto di un form che non potrebbe mai salvare (e senza «Prima scegli la sede»,
        // che qui non si può fare).
        <>
          <p className="rounded-card bg-kidville-cream/60 px-3 py-6 text-center font-maven text-sm text-kidville-sub">
            {t('cassaSedeNessuna')}
          </p>
          <div className="mt-5 flex gap-2">
            <button onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>{t('cassaMovAnnulla')}</button>
          </div>
        </>
      ) : (
      <>
      <div className="space-y-3">
        <CampoSedeCassa
          id="cassa-mov-sede"
          sedi={sedi}
          valore={scuolaId}
          onCambia={cambiaSede}
          disabled={saving}
          erroreId={campiErrati.has('scuola_id') ? ERRORE_ID : null}
        />

        <div>
          <label htmlFor="cassa-mov-tipo" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaMovLabelTipo')}</label>
          <select
            id="cassa-mov-tipo"
            value={tipo}
            onChange={(e) => { setTipo(e.target.value as 'uscita' | 'entrata'); setError(null); }}
            className={SELECT}
            {...ariaCampo('tipo')}
          >
            <option value="uscita">{t('cassaMovOptUscita')}</option>
            <option value="entrata">{t('cassaMovOptEntrata')}</option>
          </select>
        </div>

        <div>
          <label htmlFor="cassa-mov-importo" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaMovLabelImporto')}</label>
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
            <label htmlFor="cassa-mov-categoria" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaMovLabelCategoria')}</label>
            <select
              id="cassa-mov-categoria"
              value={categoriaId}
              onChange={(e) => setCategoriaId(e.target.value)}
              disabled={!scuolaId || categorieNonLette}
              className={SELECT}
              {...ariaCampo('categoria_id')}
              {...(categorieNonLette ? { 'aria-describedby': CAT_ERRORE_ID } : {})}
            >
              <option value="">{scuolaId ? t('cassaMovSelezionaCategoria') : t('cassaSedePrimaLaSede')}</option>
              {categorie.map((c) => (
                <option key={c.id} value={c.id}>{c.icona ? `${c.icona} ` : ''}{c.nome}</option>
              ))}
            </select>
            {categorieNonLette && (
              <p id={CAT_ERRORE_ID} role="alert" className="mt-1 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
                {t('cassaMovCatErrLettura')}
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="cassa-mov-metodo" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaMovLabelMetodo')}</label>
            <select id="cassa-mov-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value as CassaMetodo)} className={SELECT} {...ariaCampo('metodo')}>
              {METODI.map((m) => <option key={m.v} value={m.v}>{t(m.l)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="cassa-mov-data" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaMovLabelData')}</label>
            <input id="cassa-mov-data" type="date" value={data} onChange={(e) => setData(e.target.value)} className={INPUT} {...ariaCampo('data')} />
          </div>
        </div>

        {metodo !== 'contanti' && (
          <p className="rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-[11px] leading-snug text-kidville-warn-strong">
            {t('cassaMovWarnContanti')}
          </p>
        )}

        <div>
          <label htmlFor="cassa-mov-descrizione" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaMovLabelDescrizione')}</label>
          <input id="cassa-mov-descrizione" type="text" value={descrizione} onChange={(e) => setDescrizione(e.target.value)} className={INPUT} maxLength={300} {...ariaCampo('descrizione')} />
          <p className="mt-1 font-maven text-[11px] text-kidville-sub">{t('cassaMovHintDescrizione')}</p>
        </div>

        <div>
          <label htmlFor="cassa-mov-note" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaMovLabelNote')}</label>
          <input id="cassa-mov-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} maxLength={500} {...ariaCampo('note')} />
        </div>

        <div>
          <label htmlFor="cassa-mov-foto" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaMovLabelFoto')}</label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="cassa-mov-foto"
              type="file"
              accept={FOTO_MIME.join(',')}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block flex-1 min-w-[12rem] font-maven text-xs text-kidville-ink file:mr-3 file:rounded-pill file:border-0 file:bg-kidville-green-soft file:px-3 file:py-1.5 file:font-barlow file:text-xs file:font-bold file:uppercase file:text-kidville-green hover:file:bg-kidville-green/20"
            />
            {/* Nativo: scatta la foto dello scontrino/ricevuta. Su web non compare. */}
            <ScattaFotoButton
              onFile={setFile}
              className="inline-flex items-center gap-1.5 rounded-pill bg-kidville-green-soft px-3 py-1.5 font-barlow text-xs font-bold uppercase text-kidville-green transition-colors hover:bg-kidville-green/20"
            />
          </div>
          {file && <p className="mt-1 font-maven text-[11px] text-kidville-green">📷 {file.name}</p>}
          <p className="mt-1 font-maven text-[11px] text-kidville-sub">{t('cassaMovHintFotoPre')}{FOTO_MAX_MB}{t('cassaMovHintFotoPost')}</p>
        </div>

        {warnFoto && <p role="status" className="rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn-strong">{warnFoto}</p>}
        {error && <p id={ERRORE_ID} role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}
      </div>

      <div className="mt-5 flex gap-2">
        <button onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>{t('cassaMovAnnulla')}</button>
        <button ref={salvaBtnRef} onClick={submit} disabled={saving} className={cx(BTN_PRIMARY_AA, 'flex-1')}>
          {isUscita ? <TrendingDown size={15} /> : <TrendingUp size={15} />}
          {saving ? t('cassaMovSalvataggio') : `${t('cassaMovSalva')} ${formatEuro(importo || 0)}`}
        </button>
      </div>
      </>
      )}
    </Modal>
  );
}
