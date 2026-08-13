'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, UserX, Trash2, AlertTriangle, MailWarning } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { AvvisoOblio, type ContiOblio, type StatoMisuraOblio } from './AvvisoOblio';

// Pannello «Richieste di cancellazione account» (App Store 5.1.1(v) + GDPR art. 17).
// Il genitore avvia la richiesta dall'app; qui la Direzione la evade: anonimizza il
// genitore e i figli NON iscritti (gli iscritti restano, scuola titolare). Riservato
// alla Direzione dal gate server; l'anonimizzazione è IRREVERSIBILE (audit preservato).
//
// ─── QUESTO PANNELLO CONFERMAVA ALLA CIECA, E ERA IL PIÙ PERICOLOSO DEI DUE ──
//
// Fino al 2026-08-13 il dry-run mostrava quattro conteggi — genitore, figli non
// iscritti, figli mantenuti, figli fuori scope — e nemmeno una parola su ciò che
// l'operazione DISTRUGGE: pagelle, certificati medici, foto, allegati di chat,
// PDF delle credenziali. Il commento della route lo diceva («qui l'oblio è in
// BLOCCO e la Direzione conferma vedendo dei CONTEGGI»), ma un commento non lo
// legge chi digita ANONIMIZZA.
//
// È il canale che evade la richiesta VERA di una famiglia, e agisce su PIÙ
// bambini con una conferma sola: se un avviso serviva da qualche parte, serviva
// prima qui. Nello stesso rilascio in cui `OblioPanel` riceveva il suo, questo
// pannello — sulla stessa pagina, dieci pixel più su — restava com'era; e
// l'operatore che confermava qui poteva leggere sotto, nel riquadro dell'altro
// pannello, dei numeri che appartenevano a un bambino diverso. Adesso il
// riquadro è lo stesso componente, ma alimentato dal dry-run di QUESTA richiesta.
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

interface DryRun extends ContiOblio {
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
  // Vale come GATE della conferma, esattamente come in `OblioPanel`: finché la
  // misura non è `ok` il bottone rosso resta spento.
  const [misura, setMisura] = useState<StatoMisuraOblio>('assente');
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

  // Una misura fallita non è una misura a zero: il riquadro lo dice e il bottone
  // resta spento. Stessa regola dell'altro canale, per la stessa ragione — con
  // l'aggravante che qui l'operazione tocca più bambini in un colpo solo.
  //
  // Nessun `logClient` qui: il patch di `fetch` di `installaLoggerClient` logga
  // già ogni `!res.ok` con la politica dei livelli in un posto solo. Quello che
  // il log non sa fare è fermare la conferma, ed è ciò che si aggiunge.
  const misuraDi = useCallback(async (r: Richiesta) => {
    setDry(null);
    setMisura('in-corso');
    setBusy(true);
    try {
      const res = await fetch('/api/admin/gdpr/richieste', { method: 'POST', headers: hdr, body: JSON.stringify({ id: r.id, mode: 'dryrun' }) });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || typeof j !== 'object') { setMisura('fallita'); return; }
      setDry(j);
      setMisura('ok');
    } catch {
      setMisura('fallita');
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const apri = async (r: Richiesta) => {
    setTarget(r);
    setConfirm('');
    await misuraDi(r);
  };

  const esegui = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/gdpr/richieste', { method: 'POST', headers: hdr, body: JSON.stringify({ id: target.id, mode: 'execute', confirm }) });
      const j = await res.json();
      if (!res.ok) { alert(messaggioDaCorpo(j, t('errore'))); return; }
      setTarget(null);
      setMisura('assente');
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

      {/* CHE COSA SI DISTRUGGE, DETTO PRIMA — e qui su TUTTI i figli non più
          iscritti insieme, perché è quello che fa una conferma sola. I conteggi
          sono la somma dei loro: se anche uno solo non è misurabile il totale
          non esiste e si legge «non misurato», perché un totale parziale
          dall'aria misurata è la conferma inventata che questo riquadro abolisce. */}
      <AvvisoOblio
        stato={misura}
        conti={dry}
        genitoriAnonimizzati={dry ? dry.parent : null}
        onRiprova={target ? () => { void misuraDi(target); } : undefined}
      />

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

                {misura === 'in-corso' ? (
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
                  <button onClick={() => { setTarget(null); setMisura('assente'); }} className="rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-muted hover:bg-kidville-cream">{t('annulla')}</button>
                  {/* `misura !== 'ok'` è il GATE: qui l'oblio è in BLOCCO su più
                      bambini, e una parola digitata non può valere più dei
                      numeri che nessuno ha potuto leggere. */}
                  <button
                    disabled={busy || confirm.trim().toUpperCase() !== CONFERMA || misura !== 'ok'}
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
