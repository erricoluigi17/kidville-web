'use client';

import { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, Loader2, Trash2, AlertTriangle, UserX } from 'lucide-react';
import { cx } from '@/lib/ui/cx';

interface Candidato {
  id: string;
  nome: string;
  cognome: string;
  classe_sezione?: string | null;
  stato?: string | null;
  genitori: { id: string; nome: string }[];
}

interface DryRun {
  alunno: number;
  parents: number;
  parents_non_anonimizzati: number;
  file_da_rimuovere: number;
  nominativo_conferma: string;
}

// Pannello Diritto all'oblio (DL-034) — riservato alla Direzione (gate server).
// Layout DR: 2 colonne (lista candidati | dettaglio con dry-run + doppia conferma).
// Compliance: la cancellazione ANONIMIZZA (irreversibile), NON elimina fisicamente;
// audit e registri fiscali (fatture) sono preservati per obbligo di legge.
export function OblioPanel({ userId }: { userId: string }) {
  const [list, setList] = useState<Candidato[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<Candidato | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const hdr = { 'Content-Type': 'application/json', 'x-user-id': userId };

  const load = useCallback(async () => {
    // niente setLoading(true) sincrono: loading parte true da useState(true)
    // (react-hooks set-state-in-effect); refetch senza spinner, accettato.
    try {
      const res = await fetch('/api/admin/gdpr/candidates', { headers: { 'x-user-id': userId } });
      const j = await res.json();
      if (Array.isArray(j)) setList(j);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const apri = async (c: Candidato) => {
    setTarget(c);
    setConfirm('');
    setDry(null);
    setBusy(true);
    try {
      const res = await fetch('/api/admin/gdpr/erase', { method: 'POST', headers: hdr, body: JSON.stringify({ alunno_id: c.id, mode: 'dryrun' }) });
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
      const res = await fetch('/api/admin/gdpr/erase', { method: 'POST', headers: hdr, body: JSON.stringify({ alunno_id: target.id, mode: 'execute', confirm }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error || 'Errore'); return; }
      setTarget(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="flex items-center gap-2 p-6 font-maven text-sm text-kidville-muted"><Loader2 className="animate-spin" size={16} /> Caricamento…</div>;

  const nomeConferma = dry?.nominativo_conferma ?? (target ? `${target.cognome} ${target.nome}`.toUpperCase() : '');

  return (
    <div className="space-y-4">
      {/* banner compliance: anonimizza ≠ cancella */}
      <div className="flex items-start gap-3 rounded-2xl border border-kidville-warn/30 bg-kidville-warn-soft p-4">
        <ShieldAlert size={20} className="mt-0.5 shrink-0 text-kidville-warn" />
        <p className="font-maven text-[13px] leading-relaxed text-kidville-ink/80">
          Solo alunni <strong>non iscritti</strong> e relativi genitori. La cancellazione definitiva
          <strong> anonimizza</strong> i dati personali (irreversibile): i registri di audit e i documenti
          fiscali (fatture) restano conservati per obbligo di legge.
        </p>
      </div>

      {list.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-kidville-line bg-kidville-white/60 p-10 text-center">
          <UserX size={26} className="mx-auto text-kidville-muted" />
          <p className="mt-2 font-maven text-sm text-kidville-muted">Nessun alunno non iscritto da anonimizzare.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr] lg:items-start">
          {/* colonna sinistra: candidati */}
          <aside className="rounded-2xl border border-kidville-line bg-kidville-white p-2">
            {list.map((c) => {
              const on = target?.id === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => apri(c)}
                  className={cx('flex w-full flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors', on ? 'bg-kidville-error-soft' : 'hover:bg-kidville-cream')}
                >
                  <span className="flex items-center gap-2 font-barlow text-sm font-extrabold uppercase text-kidville-green">
                    {c.cognome} {c.nome}
                    <span className="rounded-pill bg-kidville-neutral-soft px-2 py-0.5 font-maven text-[10px] font-semibold uppercase text-kidville-muted">{c.stato ?? 'non iscritto'}</span>
                  </span>
                  <span className="truncate font-maven text-[11.5px] text-kidville-muted">
                    {c.classe_sezione ? `Classe ${c.classe_sezione} · ` : ''}Genitori: {c.genitori.map((g) => g.nome).join(', ') || '—'}
                  </span>
                </button>
              );
            })}
          </aside>

          {/* colonna destra: dettaglio + dry-run + doppia conferma */}
          <section className="rounded-2xl border-t-4 border-kidville-error bg-kidville-white p-5 shadow-sm" style={{ boxShadow: '0 1px 3px rgba(0,84,75,.04), 0 8px 24px -18px rgba(0,84,75,.28)' }}>
            {!target ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Trash2 size={24} className="text-kidville-muted" />
                <p className="mt-2 font-maven text-sm text-kidville-muted">Seleziona un alunno per analizzare e anonimizzare i dati.</p>
              </div>
            ) : (
              <>
                <h3 className="flex items-center gap-2 font-barlow text-xl font-black uppercase tracking-wide text-kidville-error">
                  <AlertTriangle size={20} /> Cancellazione definitiva
                </h3>
                <p className="mb-4 mt-2 font-maven text-sm text-kidville-ink/80">
                  Stai per <strong>anonimizzare irreversibilmente</strong> i dati di <strong>{target.cognome} {target.nome}</strong>.
                </p>

                {busy && !dry ? (
                  <div className="flex items-center gap-2 py-3 font-maven text-sm text-kidville-muted"><Loader2 className="animate-spin" size={14} /> Analisi (dry-run)…</div>
                ) : dry ? (
                  <div className="mb-4 space-y-1 rounded-xl bg-kidville-cream p-3.5 font-maven text-xs text-kidville-ink/80">
                    <div>Anagrafica alunno anonimizzata: <strong>{dry.alunno}</strong></div>
                    <div>Genitori anonimizzati (orfani): <strong>{dry.parents}</strong></div>
                    {dry.parents_non_anonimizzati > 0 && <div className="text-kidville-warn">Genitori con altri figli iscritti (mantenuti): {dry.parents_non_anonimizzati}</div>}
                    <div>File personali rimossi: <strong>{dry.file_da_rimuovere}</strong></div>
                  </div>
                ) : null}

                <label className="mb-1.5 block font-maven text-xs font-semibold text-kidville-muted">
                  Per confermare, digita <span className="font-mono text-kidville-error">{nomeConferma}</span>
                </label>
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Cognome Nome"
                  className="mb-4 w-full rounded-xl border-2 border-kidville-line px-3 py-2 text-sm outline-none focus:border-kidville-error"
                />

                <div className="flex justify-end gap-3">
                  <button onClick={() => setTarget(null)} className="rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-muted hover:bg-kidville-cream">Annulla</button>
                  <button
                    disabled={busy || !confirm.trim()}
                    onClick={esegui}
                    className="rounded-pill bg-kidville-error px-5 py-2 font-barlow text-sm font-black uppercase tracking-wider text-kidville-white hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? 'Anonimizzazione…' : 'Anonimizza definitivamente'}
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
