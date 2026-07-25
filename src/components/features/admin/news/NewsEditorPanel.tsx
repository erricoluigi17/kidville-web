'use client';

// ─── Editor di un post News (creazione + modifica) ────────────────────────────
// Un solo form per due modalità: `admin` (Salva bozza / Programma / Pubblica,
// «Tutte le sedi») e `docente` (Salva bozza / Invia proposta, mai pubblicazione
// diretta né «Tutte le sedi»). Il client invia SOLO il JSON del rich-text: HTML e
// sanificazione sono di competenza del server. Degrada su ambiente non migrato.

import { useCallback, useEffect, useState } from 'react';
import type { JSONContent } from '@tiptap/react';
import { Save, Send, CalendarClock, Megaphone, ExternalLink, ShieldCheck, CheckCircle2, X } from 'lucide-react';
import { hdr } from '@/components/features/admin/settings/ui';
import { INPUT, SELECT, BTN_PRIMARY_AA, BTN_SECONDARY } from '@/components/features/admin/pagamenti/ui';
import { logClient } from '@/lib/logging/client';
import { cx } from '@/lib/ui/cx';
import { useTranslations } from 'next-intl';
import { parseInstagramUrl, buildEmbedUrl } from '@/lib/news/instagram';
import type { NewsCategoria, NewsGrado, NewsPost, NewsScope, NewsStato, NewsTipo } from '@/lib/news/tipi';
import { NewsRichTextEditor } from './NewsRichTextEditor';
import { NewsMediaUploader } from './NewsMediaUploader';
import { NewsTargetPicker } from './NewsTargetPicker';

interface Props {
  userId: string;
  scuolaId: string;
  modalita: 'admin' | 'docente';
  /** L'admin può indirizzare a «Tutte le sedi» (scuola_id null). */
  canAllSedi?: boolean;
  /** Se presente, il form è in modifica (PATCH) invece che in creazione (POST). */
  postIniziale?: NewsPost | null;
  onSalvato?: () => void;
  onAnnulla?: () => void;
}

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

// `labelKey` = chiave i18n (namespace adminComunicazioni), risolta nel componente.
const TIPI: { id: NewsTipo; labelKey: string }[] = [
  { id: 'articolo', labelKey: 'editorTipoArticolo' },
  { id: 'breve', labelKey: 'editorTipoBreve' },
  { id: 'instagram', labelKey: 'editorTipoInstagram' },
];

interface EsitoIg { valido: boolean; shortcode?: string | null; embed_url?: string | null; raggiungibile?: boolean }

export function NewsEditorPanel({ userId, scuolaId, modalita, canAllSedi = false, postIniziale = null, onSalvato, onAnnulla }: Props) {
  const t = useTranslations('adminComunicazioni');
  const inModifica = postIniziale !== null;

  const [tipo, setTipo] = useState<NewsTipo>(postIniziale?.tipo ?? 'articolo');
  const [titolo, setTitolo] = useState(postIniziale?.titolo ?? '');
  const [categoriaId, setCategoriaId] = useState(postIniziale?.categoria_id ?? '');
  const [contenutoJson, setContenutoJson] = useState<JSONContent | null>((postIniziale?.contenuto_json as JSONContent | null) ?? null);
  const [copertinaUrl, setCopertinaUrl] = useState(postIniziale?.copertina_url ?? '');
  const [instagramUrl, setInstagramUrl] = useState(postIniziale?.instagram_url ?? '');
  const [scope, setScope] = useState<NewsScope>(postIniziale?.target_scope ?? 'globale');
  const [gradi, setGradi] = useState<NewsGrado[]>(postIniziale?.target_gradi ?? []);
  const [classi, setClassi] = useState<string[]>(postIniziale?.target_classes ?? []);
  const [tuttiSedi, setTuttiSedi] = useState(inModifica ? postIniziale?.scuola_id === null : false);
  const [inviaNotifica, setInviaNotifica] = useState(postIniziale?.invia_notifica ?? true);
  const [programmataIl, setProgrammataIl] = useState('');
  const [consensoFoto, setConsensoFoto] = useState(false);

  const [categorie, setCategorie] = useState<NewsCategoria[]>([]);
  const [classiDisponibili, setClassiDisponibili] = useState<string[]>([]);
  const [igEsito, setIgEsito] = useState<EsitoIg | null>(null);
  const [igVerificando, setIgVerificando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [salvato, setSalvato] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  // Categorie (globali + di sede). Tollerante: ambiente non migrato → lista vuota.
  // Nessun try/catch e nessun setState prima del primo await (regola react-hooks
  // set-state-in-effect): il fetch degrada da sé con `.catch(() => null)`.
  const caricaCategorie = useCallback(async () => {
    try {
      const res = await fetch(`/api/news/categorie?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) }).catch(() => null);
      if (!res || !res.ok) return;
      const j = (await res.json().catch(() => null)) as { disponibile?: boolean; categorie?: NewsCategoria[] } | null;
      if (j?.disponibile === false) return;
      setCategorie((j?.categorie ?? []).slice().sort((a, b) => a.ordine - b.ordine));
    } finally {
      /* degrado silenzioso: senza categorie il form resta senza pillole di scelta */
    }
  }, [userId, scuolaId]);

  // Classi selezionabili: admin → sezioni di sede; docente → proprie sezioni.
  const caricaClassi = useCallback(async () => {
    try {
      if (modalita === 'docente') {
        const res = await fetch(`/api/educator-sections?userId=${userId}`).catch(() => null);
        if (!res || !res.ok) return;
        const j = (await res.json().catch(() => null)) as { sectionNames?: string[] } | null;
        setClassiDisponibili(j?.sectionNames ?? []);
      } else {
        const res = await fetch(`/api/admin/sections/scoped?userId=${userId}`).catch(() => null);
        if (!res || !res.ok) return;
        const j = (await res.json().catch(() => null)) as { success?: boolean; data?: { sezioni?: { name: string }[] }[] } | null;
        const nomi = [...new Set((j?.data ?? []).flatMap((g) => (g.sezioni ?? []).map((s) => s.name)))];
        setClassiDisponibili(nomi);
      }
    } finally {
      /* degrado silenzioso: senza sezioni il target «classi» resta senza opzioni */
    }
  }, [userId, modalita]);

  useEffect(() => { void caricaCategorie(); }, [caricaCategorie]);
  useEffect(() => { void caricaClassi(); }, [caricaClassi]);

  const verificaIg = async () => {
    const sc = parseInstagramUrl(instagramUrl);
    if (!sc) { setErrore(t('editorIgUrlNonValido')); setIgEsito({ valido: false }); return; }
    setErrore(null);
    setIgVerificando(true);
    try {
      const res = await fetch(`/api/news/instagram/valida?userId=${userId}`, {
        method: 'POST', headers: hdr(userId), body: JSON.stringify({ url: instagramUrl.trim() }),
      });
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as EsitoIg | null;
        setIgEsito(j ?? { valido: true, shortcode: sc, embed_url: buildEmbedUrl(sc) });
      } else if (res.status === 404) {
        // API non ancora disponibile: anteprima locale dallo shortcode.
        setIgEsito({ valido: true, shortcode: sc, embed_url: buildEmbedUrl(sc), raggiungibile: undefined });
      } else {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setErrore(j?.error ?? t('editorIgVerificaFallita'));
      }
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `POST news/instagram/valida — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
      setErrore(t('editorIgErroreRete'));
    } finally {
      setIgVerificando(false);
    }
  };

  const salva = async (stato: NewsStato) => {
    if (!titolo.trim()) { setErrore(t('editorTitoloObbligatorio')); return; }
    if (tipo === 'instagram' && !parseInstagramUrl(instagramUrl)) { setErrore(t('editorIgInserisciUrl')); return; }
    if (!inModifica && stato === 'programmata' && !programmataIl) { setErrore(t('editorScegliData')); return; }
    setErrore(null);
    setSalvato(false);
    setSalvando(true);
    try {
      const body: Record<string, unknown> = {
        tipo,
        titolo: titolo.trim(),
        categoria_id: categoriaId || null,
        target_scope: scope,
        target_gradi: scope === 'grado' ? gradi : null,
        target_classes: scope === 'classi' ? classi : null,
        copertina_url: copertinaUrl || null,
        invia_notifica: inviaNotifica,
        scuola_id: canAllSedi && tuttiSedi ? null : scuolaId,
      };
      if (tipo === 'instagram') body.instagram_url = instagramUrl.trim();
      else body.contenuto_json = contenutoJson;

      let res: Response;
      if (inModifica && postIniziale) {
        res = await fetch(`/api/news/${postIniziale.id}?userId=${userId}`, { method: 'PATCH', headers: hdr(userId), body: JSON.stringify(body) });
      } else {
        body.stato = stato;
        if (stato === 'programmata') body.programmata_il = new Date(programmataIl).toISOString();
        res = await fetch(`/api/news?userId=${userId}`, { method: 'POST', headers: hdr(userId), body: JSON.stringify(body) });
      }
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setErrore(j?.error ?? (res.status === 404 ? t('newsNonDisponibili') : t('editorSalvataggioFallito')));
        return;
      }
      setSalvato(true);
      if (!inModifica) {
        // Reset del form dopo una creazione riuscita.
        setTitolo(''); setContenutoJson(null); setCopertinaUrl(''); setInstagramUrl('');
        setIgEsito(null); setProgrammataIl('');
      }
      onSalvato?.();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `salva post news — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
      setErrore(t('erroreReteRiprova'));
    } finally {
      setSalvando(false);
    }
  };

  const labelCls = 'mb-1.5 block font-maven text-xs font-bold uppercase tracking-wide text-kidville-sub';

  return (
    <div className="space-y-5">
      {/* Tipo */}
      <div>
        <span className={labelCls}>{t('editorTipoContenuto')}</span>
        <div className="flex flex-wrap gap-2">
          {TIPI.map((tp) => {
            const on = tipo === tp.id;
            return (
              <button
                key={tp.id}
                type="button"
                onClick={() => setTipo(tp.id)}
                aria-pressed={on}
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-pill px-3.5 py-2 font-maven text-[13px] font-bold transition-colors',
                  'outline-none focus-visible:ring-2 focus-visible:ring-kidville-green focus-visible:ring-offset-1',
                  on ? 'bg-kidville-green text-kidville-white' : 'border-[1.5px] border-kidville-line bg-kidville-white text-kidville-green hover:border-kidville-green',
                )}
              >
                {t(tp.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Titolo */}
      <div>
        <label htmlFor="news-titolo" className={labelCls}>{t('editorTitolo')}</label>
        <input id="news-titolo" value={titolo} onChange={(e) => setTitolo(e.target.value)} placeholder={t('editorTitoloPlaceholder')} className={INPUT} />
      </div>

      {/* Categoria */}
      <div>
        <label htmlFor="news-categoria" className={labelCls}>{t('editorCategoria')}</label>
        <select id="news-categoria" value={categoriaId ?? ''} onChange={(e) => setCategoriaId(e.target.value)} className={SELECT}>
          <option value="">{t('editorNessunaCategoria')}</option>
          {categorie.map((c) => <option key={c.id} value={c.id}>{c.icona ? `${c.icona} ` : ''}{c.nome}</option>)}
        </select>
      </div>

      {/* Copertina */}
      <div>
        <span className={labelCls}>{t('editorCopertina')}</span>
        {copertinaUrl ? (
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- anteprima locale dell'upload, dimensioni ignote */}
            <img src={copertinaUrl} alt={t('editorCopertinaAlt')} className="h-16 w-24 rounded-input border border-kidville-line object-cover" />
            <button type="button" onClick={() => setCopertinaUrl('')} className={BTN_SECONDARY}><X size={14} /> {t('editorRimuovi')}</button>
          </div>
        ) : (
          <NewsMediaUploader userId={userId} consensoFoto={consensoFoto} onConsensoFoto={() => setConsensoFoto(true)} onUploaded={setCopertinaUrl} label={t('editorCaricaCopertina')} />
        )}
      </div>

      {/* Contenuto: rich-text per articolo/breve, embed per instagram */}
      {tipo === 'instagram' ? (
        <div>
          <label htmlFor="news-ig" className={labelCls}>{t('editorLinkIg')}</label>
          <div className="flex flex-wrap items-center gap-2">
            <input id="news-ig" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={instagramUrl} onChange={(e) => { setInstagramUrl(e.target.value); setIgEsito(null); }} placeholder={t('editorIgPlaceholder')} className={cx(INPUT, 'min-w-0 flex-1')} />
            <button type="button" onClick={verificaIg} disabled={igVerificando || !instagramUrl.trim()} className={BTN_SECONDARY}>
              {igVerificando ? t('editorVerificaInCorso') : t('editorVerifica')}
            </button>
          </div>
          {igEsito && (
            <div className="mt-3">
              {igEsito.raggiungibile === false && (
                <p className="mb-2 font-maven text-xs text-kidville-warn-strong">{t('editorIgNonRaggiungibile')}</p>
              )}
              {igEsito.embed_url && (
                <div className="overflow-hidden rounded-card border border-kidville-line">
                  <iframe src={igEsito.embed_url} title={t('editorIgAnteprima')} className="h-[420px] w-full" loading="lazy" />
                </div>
              )}
              {igEsito.embed_url && (
                <a href={instagramUrl.trim()} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1.5 font-maven text-sm font-bold text-kidville-green underline">
                  <ExternalLink size={14} /> {t('editorApriIg')}
                </a>
              )}
            </div>
          )}
        </div>
      ) : (
        <div>
          <span className={labelCls}>{t('editorContenuto')}</span>
          <NewsRichTextEditor
            userId={userId}
            value={contenutoJson}
            onChange={setContenutoJson}
            consensoFoto={consensoFoto}
            onConsensoFoto={() => setConsensoFoto(true)}
            placeholder={t('editorContenutoPlaceholder')}
          />
        </div>
      )}

      {/* Destinatari */}
      <div>
        <span className={labelCls}>{t('editorDestinatari')}</span>
        <NewsTargetPicker
          scope={scope}
          onScope={setScope}
          gradi={gradi}
          onGradi={setGradi}
          classi={classi}
          onClassi={setClassi}
          availableClasses={classiDisponibili}
          canAllSedi={canAllSedi}
          tuttiSedi={tuttiSedi}
          onTuttiSedi={setTuttiSedi}
        />
      </div>

      {/* Notifica */}
      <label className="flex cursor-pointer items-center gap-2.5">
        <input type="checkbox" checked={inviaNotifica} onChange={(e) => setInviaNotifica(e.target.checked)} className="h-4 w-4 rounded accent-kidville-green" />
        <span className="inline-flex items-center gap-1.5 font-maven text-sm text-kidville-ink"><Megaphone size={15} /> {t('editorInviaNotifica')}</span>
      </label>

      {/* Programmazione (solo admin, in creazione) */}
      {!inModifica && modalita === 'admin' && (
        <div>
          <label htmlFor="news-programmata" className={labelCls}>{t('editorProgrammaPer')}</label>
          <input id="news-programmata" type="datetime-local" value={programmataIl} onChange={(e) => setProgrammataIl(e.target.value)} className={cx(INPUT, 'max-w-xs')} />
        </div>
      )}

      {errore && <p role="alert" className="font-maven text-sm text-kidville-error-strong">{errore}</p>}
      {salvato && !errore && (
        <p role="status" className="inline-flex items-center gap-1.5 font-maven text-sm font-bold text-kidville-success-strong">
          <CheckCircle2 size={16} /> {inModifica ? t('editorModificheSalvate') : t('editorSalvato')}
        </p>
      )}

      {/* Azioni */}
      <div className="flex flex-wrap items-center gap-2 border-t border-kidville-line pt-4">
        {inModifica ? (
          <>
            <button type="button" onClick={() => salva('bozza')} disabled={salvando} className={BTN_PRIMARY_AA}><Save size={15} /> {t('editorSalvaModifiche')}</button>
            {onAnnulla && <button type="button" onClick={onAnnulla} disabled={salvando} className={BTN_SECONDARY}>{t('editorChiudi')}</button>}
          </>
        ) : modalita === 'admin' ? (
          <>
            <button type="button" onClick={() => salva('bozza')} disabled={salvando} className={BTN_SECONDARY}><Save size={15} /> {t('editorSalvaBozza')}</button>
            {programmataIl && <button type="button" onClick={() => salva('programmata')} disabled={salvando} className={BTN_SECONDARY}><CalendarClock size={15} /> {t('editorProgramma')}</button>}
            <button type="button" onClick={() => salva('pubblicata')} disabled={salvando} className={BTN_PRIMARY_AA}><Send size={15} /> {t('editorPubblica')}</button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => salva('bozza')} disabled={salvando} className={BTN_SECONDARY}><Save size={15} /> {t('editorSalvaBozza')}</button>
            <button type="button" onClick={() => salva('proposta')} disabled={salvando} className={BTN_PRIMARY_AA}><Send size={15} /> {t('editorInviaProposta')}</button>
          </>
        )}
      </div>

      <p className="inline-flex items-center gap-1.5 font-maven text-[11px] text-kidville-sub">
        <ShieldCheck size={12} /> {t('editorNotaSanifica')}
      </p>
    </div>
  );
}
