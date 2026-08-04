'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, UserX, Trash2, AlertTriangle, MailWarning } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';

// Pannello «Richieste di cancellazione account» (App Store 5.1.1(v) + GDPR art. 17).
// Il genitore avvia la richiesta dall'app; qui la Direzione la evade: anonimizza il
// genitore e i figli NON iscritti (gli iscritti restano, scuola titolare). Riservato
// alla Direzione dal gate server; l'anonimizzazione è IRREVERSIBILE (audit preservato).
const CONFERMA = 'ANONIMIZZA';

interface Richiesta {
  id: string;
  creata_il: string;
  parent_nome: string;
  alunni_iscritti: number;
  alunni_non_iscritti: number;
  /** Figli in plessi NON accessibili a chi evade: contati, mai anonimizzati qui. */
  alunni_fuori_scope?: number;
}

interface DryRun {
  parent: number;
  alunni_non_iscritti: number;
  alunni_iscritti_mantenuti: number;
  alunni_fuori_scope?: number;
}

export function RichiesteCancellazionePanel({ userId }: { userId: string }) {
  const t = useTranslations('adminAltro');
  const [list, setList] = useState<Richiesta[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<Richiesta | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const hdr = { 'Content-Type': 'application/json', 'x-user-id': userId };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/gdpr/richieste', { headers: { 'x-user-id': userId } });
      const j = await res.json();
      if (Array.isArray(j)) setList(j);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const apri = async (r: Richiesta) => {
    setTarget(r);
    setConfirm('');
    setDry(null);
    setBusy(true);
    try {
      const res = await fetch('/api/admin/gdpr/richieste', { method: 'POST', headers: hdr, body: JSON.stringify({ id: r.id, mode: 'dryrun' }) });
      const j = await res.json();
      if (res.ok) setDry(j);
    } finally {
      setBusy(false);
    }
  };

  const esegui = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/gdpr/richieste', { method: 'POST', headers: hdr, body: JSON.stringify({ id: target.id, mode: 'execute', confirm }) });
      const j = await res.json();
      if (!res.ok) { alert(messaggioDaCorpo(j, t('errore'))); return; }
      setTarget(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 font-maven text-sm text-kidville-muted">
        <Loader2 className="animate-spin" size={16} /> {t('richiesteLoading')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-kidville-warn/30 bg-kidville-warn-soft p-4">
        <MailWarning size={20} className="mt-0.5 shrink-0 text-kidville-warn" />
        <p className="font-maven text-[13px] leading-relaxed text-kidville-ink/80">
          {t.rich('richiesteBanner', { strong: (c) => <strong>{c}</strong> })}
        </p>
      </div>

      {list.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-kidville-line bg-kidville-white/60 p-10 text-center">
          <UserX size={26} className="mx-auto text-kidville-muted" />
          <p className="mt-2 font-maven text-sm text-kidville-muted">{t('richiesteVuoto')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr] lg:items-start">
          <aside className="rounded-2xl border border-kidville-line bg-kidville-white p-2">
            {list.map((r) => {
              const on = target?.id === r.id;
              return (
                <button
                  key={r.id}
                  onClick={() => apri(r)}
                  className={cx('flex w-full flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors', on ? 'bg-kidville-error-soft' : 'hover:bg-kidville-cream')}
                >
                  <span className="font-barlow text-sm font-extrabold uppercase text-kidville-green">{r.parent_nome}</span>
                  <span className="truncate font-maven text-[11.5px] text-kidville-muted">
                    {t('richiesteFigli', { nonIscritti: r.alunni_non_iscritti, iscritti: r.alunni_iscritti })}
                  </span>
                </button>
              );
            })}
          </aside>

          <section className="rounded-2xl border-t-4 border-kidville-error bg-kidville-white p-5 shadow-sm" style={{ boxShadow: '0 1px 3px rgba(0,84,75,.04), 0 8px 24px -18px rgba(0,84,75,.28)' }}>
            {!target ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Trash2 size={24} className="text-kidville-muted" />
                <p className="mt-2 font-maven text-sm text-kidville-muted">{t('richiesteNonSelezionato')}</p>
              </div>
            ) : (
              <>
                <h3 className="flex items-center gap-2 font-barlow text-xl font-black uppercase tracking-wide text-kidville-error">
                  <AlertTriangle size={20} /> {t('richiesteTitolo')}
                </h3>
                <p className="mb-4 mt-2 font-maven text-sm text-kidville-ink/80">
                  {t.rich('richiesteAvviso', { nome: target.parent_nome, strong: (c) => <strong>{c}</strong> })}
                </p>

                {busy && !dry ? (
                  <div className="flex items-center gap-2 py-3 font-maven text-sm text-kidville-muted"><Loader2 className="animate-spin" size={14} /> {t('richiesteDryRun')}</div>
                ) : dry ? (
                  <div className="mb-4 space-y-1 rounded-xl bg-kidville-cream p-3.5 font-maven text-xs text-kidville-ink/80">
                    <div>{t('richiesteGenitoreAnon')} <strong>{dry.parent}</strong></div>
                    <div>{t('richiesteFigliNonIscrittiAnon')} <strong>{dry.alunni_non_iscritti}</strong></div>
                    {dry.alunni_iscritti_mantenuti > 0 && <div className="text-kidville-warn">{t('richiesteFigliMantenuti', { n: dry.alunni_iscritti_mantenuti })}</div>}
                    {/* Il residuo NON si tace: questa evasione chiude la richiesta,
                        e un pezzo dell'oblio resta in carico a un altro plesso.
                        Chi sta per digitare ANONIMIZZA deve saperlo qui, non in un
                        campo JSON che non guarda nessuno. */}
                    {(dry.alunni_fuori_scope ?? 0) > 0 && (
                      <div className="text-kidville-error">{t('richiesteFigliFuoriScope', { n: dry.alunni_fuori_scope ?? 0 })}</div>
                    )}
                  </div>
                ) : null}

                <label className="mb-1.5 block font-maven text-xs font-semibold text-kidville-muted">
                  {t('richiesteConfermaDigita')} <span className="font-mono text-kidville-error">{CONFERMA}</span>
                </label>
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={CONFERMA}
                  className="mb-4 w-full rounded-xl border-2 border-kidville-line px-3 py-2 text-sm outline-none focus:border-kidville-error"
                />

                <div className="flex justify-end gap-3">
                  <button onClick={() => setTarget(null)} className="rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-muted hover:bg-kidville-cream">{t('annulla')}</button>
                  <button
                    disabled={busy || confirm.trim().toUpperCase() !== CONFERMA}
                    onClick={esegui}
                    className="rounded-pill bg-kidville-error px-5 py-2 font-barlow text-sm font-black uppercase tracking-wider text-kidville-white hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? t('oblioBtnAnonimizzando') : t('oblioBtnAnonimizza')}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
