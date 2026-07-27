'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Loader2, Flag, ShieldAlert, CheckCircle2, Inbox } from 'lucide-react';
import { CockpitSelect } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';

// =============================================================================
// Coda di moderazione (C5 §2 — pannello Direzione).
//
// La Direzione tria le segnalazioni ricevute (GET /api/admin/segnalazioni):
// filtra per stato, apre il dettaglio col `motivo` IN CHIARO (strumento interno,
// NON un log) e marca la segnalazione in_lavorazione/chiusa via PATCH (autorship
// della gestione scritta server-side). Nessun dato personale è mostrato oltre al
// contenuto della segnalazione stessa: qui non si risolvono i nomi.
// =============================================================================

interface Segnalazione {
  id: string;
  scuola_id: string | null;
  segnalante_id: string;
  segnalato_id: string | null;
  tipo_oggetto: 'messaggio_chat' | 'media_galleria' | 'voce_diario' | 'utente';
  oggetto_id: string | null;
  thread_id: string | null;
  categoria: string;
  motivo: string | null;
  stato: 'aperta' | 'in_lavorazione' | 'chiusa';
  creata_il: string;
  gestita_il: string | null;
  gestita_da: string | null;
  note_gestione: string | null;
}

type Filtro = 'aperta' | 'in_lavorazione' | 'chiusa' | 'tutte';

function fmtDate(iso: string | null, locale: string) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

export function SegnalazioniPanel({ userId }: { userId: string }) {
  const t = useTranslations('adminAltro');
  const locale = useLocale();
  const [filtro, setFiltro] = useState<Filtro>('aperta');
  const [list, setList] = useState<Segnalazione[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Segnalazione | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async (f: Filtro) => {
    const params = new URLSearchParams();
    if (f !== 'tutte') params.set('stato', f);
    params.set('limit', '100');
    try {
      const res = await fetch(`/api/admin/segnalazioni?${params.toString()}`, { headers: { 'x-user-id': userId } });
      const j = await res.json();
      if (res.ok && Array.isArray(j.segnalazioni)) {
        const rows = j.segnalazioni as Segnalazione[];
        setList(rows);
        // Mantieni la selezione se la segnalazione è ancora nel nuovo elenco.
        setSel((prev) => (prev ? (rows.find((s) => s.id === prev.id) ?? null) : null));
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(filtro); }, [filtro, load]);

  const apri = (s: Segnalazione) => {
    setSel(s);
    setNote(s.note_gestione ?? '');
    setMsg('');
  };

  const aggiorna = async (stato: 'in_lavorazione' | 'chiusa') => {
    if (!sel) return;
    setBusy(true);
    setMsg('');
    try {
      const body: Record<string, unknown> = { id: sel.id, stato };
      if (note.trim()) body.note_gestione = note.trim();
      const res = await fetch('/api/admin/segnalazioni', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) {
        setMsg(t('modErrore'));
        return;
      }
      setMsg(t('modAggiornata'));
      await load(filtro);
    } finally {
      setBusy(false);
    }
  };

  const statoOpts = [
    { value: 'aperta', label: t('modStatoAperta') },
    { value: 'in_lavorazione', label: t('modStatoInLavorazione') },
    { value: 'chiusa', label: t('modStatoChiusa') },
    { value: 'tutte', label: t('modStatoTutte') },
  ];

  const statoBadge = (stato: Segnalazione['stato']) => {
    const cfg: Record<Segnalazione['stato'], { label: string; cls: string }> = {
      aperta: { label: t('modBadgeAperta'), cls: 'bg-kidville-warn-soft text-kidville-warn' },
      in_lavorazione: { label: t('modBadgeInLavorazione'), cls: 'bg-kidville-info-soft text-kidville-info' },
      chiusa: { label: t('modBadgeChiusa'), cls: 'bg-kidville-neutral-soft text-kidville-neutral' },
    };
    const c = cfg[stato];
    return (
      <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 font-barlow text-[10px] font-bold uppercase tracking-wide', c.cls)}>
        {c.label}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-maven text-xs font-semibold text-kidville-muted">{t('modFiltroStato')}</span>
        <CockpitSelect value={filtro} onChange={(v) => setFiltro(v as Filtro)} options={statoOpts} />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-6 font-maven text-sm text-kidville-muted">
          <Loader2 className="animate-spin" size={16} /> {t('modCaricamento')}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-kidville-line bg-kidville-white/60 p-10 text-center">
          <Inbox size={26} className="mx-auto text-kidville-muted" />
          <p className="mt-2 font-maven text-sm text-kidville-muted">{t('modVuoto')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr] lg:items-start">
          {/* Elenco segnalazioni */}
          <aside className="rounded-2xl border border-kidville-line bg-kidville-white p-2">
            {list.map((s) => {
              const on = sel?.id === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => apri(s)}
                  className={cx('flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors', on ? 'bg-kidville-green-soft' : 'hover:bg-kidville-cream')}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-barlow text-sm font-extrabold uppercase text-kidville-green">{t(`modCat_${s.categoria}`)}</span>
                    {statoBadge(s.stato)}
                  </span>
                  <span className="font-maven text-[11.5px] text-kidville-muted">
                    {t(`modTipo_${s.tipo_oggetto}`)} · {fmtDate(s.creata_il, locale)}
                  </span>
                </button>
              );
            })}
          </aside>

          {/* Dettaglio */}
          <section className="rounded-2xl border-t-4 border-kidville-green bg-kidville-white p-5 shadow-sm">
            {!sel ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Flag size={24} className="text-kidville-muted" />
                <p className="mt-2 font-maven text-sm text-kidville-muted">{t('modSelezionaDettaglio')}</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 font-barlow text-xl font-black uppercase tracking-wide text-kidville-green">
                    <ShieldAlert size={20} /> {t(`modTipo_${sel.tipo_oggetto}`)}
                  </h3>
                  {statoBadge(sel.stato)}
                </div>
                <p className="mt-1 font-maven text-xs text-kidville-muted">
                  {t(`modCat_${sel.categoria}`)} · {t('modSegnalataIl', { data: fmtDate(sel.creata_il, locale) })}
                </p>
                {sel.gestita_il && (
                  <p className="font-maven text-xs text-kidville-muted">{t('modGestitaIl', { data: fmtDate(sel.gestita_il, locale) })}</p>
                )}

                <div className="mt-4 rounded-xl bg-kidville-cream p-3.5">
                  <p className="mb-1 font-maven text-[11px] font-semibold uppercase tracking-wide text-kidville-muted">{t('modMotivoLabel')}</p>
                  <p className="whitespace-pre-wrap font-maven text-sm text-kidville-ink">
                    {sel.motivo?.trim() ? sel.motivo : <span className="text-kidville-muted italic">{t('modNessunMotivo')}</span>}
                  </p>
                </div>

                <label className="mb-1.5 mt-4 block font-maven text-xs font-semibold text-kidville-muted">{t('modNoteGestione')}</label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t('modNotePlaceholder')}
                  rows={3}
                  className="w-full resize-none rounded-xl border-2 border-kidville-line px-3 py-2 font-maven text-sm outline-none focus:border-kidville-green"
                />

                {msg && (
                  <p className="mt-2 flex items-center gap-1.5 font-maven text-xs text-kidville-green">
                    <CheckCircle2 size={13} /> {msg}
                  </p>
                )}

                <div className="mt-4 flex flex-wrap justify-end gap-3">
                  {sel.stato === 'aperta' && (
                    <button
                      disabled={busy}
                      onClick={() => aggiorna('in_lavorazione')}
                      className="rounded-pill border border-kidville-info px-4 py-2 font-barlow text-sm font-bold uppercase tracking-wide text-kidville-info hover:bg-kidville-info-soft disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : t('modPrendiInCarico')}
                    </button>
                  )}
                  {sel.stato !== 'chiusa' && (
                    <button
                      disabled={busy}
                      onClick={() => aggiorna('chiusa')}
                      className="rounded-pill bg-kidville-green px-5 py-2 font-barlow text-sm font-black uppercase tracking-wider text-kidville-white hover:bg-kidville-green-dark disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : t('modChiudi')}
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      <p className="font-maven text-xs text-kidville-muted">{t('modCrossLinkSospese')}</p>
    </div>
  );
}
