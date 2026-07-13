'use client';

import { useCallback, useEffect, useState } from 'react';
import { X, Pencil, Check, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { RUOLI_ASSEGNABILI, labelRuolo } from '@/lib/auth/ruoli';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

// Scheda dedicata di un membro dello STAFF (elenco reale da `utenti`, tab Staff
// dell'anagrafica). Si auto-carica da GET /api/admin/staff e seleziona il membro.
// Sola lettura per la Segreteria; modifica ruolo/sede/classi + rigenera credenziali
// riservate alla Direzione (affordance nascoste, gate applicato dal server).

interface StaffMember {
  id: string;
  nome?: string;
  cognome?: string;
  email?: string | null;
  ruolo: string;
  scuola_id?: string | null;
  gradi?: string[];
}
interface School { id: string; nome: string }
interface Section { id: string; name: string; scuola_id: string; school_type?: string }
interface Assegnazione { utente_id: string; section_id: string }

interface Props {
  staffId: string;
  onClose: () => void;
}

export function StaffDetailPanel({ staffId, onClose }: Props) {
  const { userId, role, ready } = useSessionIdentity();
  const canEdit = role === 'admin' || role === 'coordinator';

  const [loading, setLoading] = useState(true);
  const [errore, setErrore] = useState<string | null>(null);
  const [member, setMember] = useState<StaffMember | null>(null);
  const [schools, setSchools] = useState<School[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [asseg, setAsseg] = useState<Assegnazione[]>([]);

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<{ ruolo: string; scuola_id: string; section_ids: string[] }>({ ruolo: '', scuola_id: '', section_ids: [] });
  const [saving, setSaving] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/staff', { headers: userId ? { 'x-user-id': userId } : undefined });
      const j = await res.json().catch(() => null);
      // Mai un vuoto muto: se il fetch non riesce, si mostra il motivo.
      if (!res.ok || !j?.success) {
        setErrore(j?.error || 'Errore nel caricamento dello staff');
        setMember(null);
        return;
      }
      setErrore(null);
      setSchools(j.schools ?? []);
      setSections(j.sections ?? []);
      setAsseg(j.assegnazioni ?? []);
      setMember((j.data ?? []).find((u: StaffMember) => u.id === staffId) ?? null);
    } finally {
      setLoading(false);
    }
  }, [staffId, userId]);

  useEffect(() => {
    // Attendo la risoluzione dell'identità (per l'header x-user-id) prima di caricare:
    // un solo fetch, con l'utente già risolto.
    if (!ready) return;
    void load();
  }, [ready, load]);

  const apri = () => {
    if (!member) return;
    setDraft({
      ruolo: member.ruolo,
      scuola_id: member.scuola_id ?? '',
      section_ids: asseg.filter((a) => a.utente_id === staffId).map((a) => a.section_id),
    });
    setEditMode(true);
  };

  const salva = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/staff', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
        body: JSON.stringify({ id: staffId, ruolo: draft.ruolo, scuola_id: draft.scuola_id || undefined, section_ids: draft.section_ids }),
      });
      if (res.status === 403) { alert('Azione riservata alla Direzione, oppure non puoi modificare il tuo stesso ruolo.'); return; }
      if (!res.ok) { const j = await res.json().catch(() => ({})); alert((j as { error?: string }).error || 'Errore nel salvataggio'); return; }
      setEditMode(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const rigenera = async () => {
    if (!member) return;
    if (!confirm(`Rigenerare le credenziali di ${member.cognome ?? ''} ${member.nome ?? ''}? La password precedente non sarà più valida.`)) return;
    setRegenBusy(true);
    try {
      const res = await fetch('/api/admin/regenerate-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
        body: JSON.stringify({ targetKind: 'staff', targetId: staffId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { alert((body as { error?: string }).error || 'Errore'); return; }
      const b = body as { pdf_notifica?: boolean; email_inviata?: boolean; warning?: string };
      alert(b.pdf_notifica
        ? 'Fatto: email inviata e PDF disponibile nel centro notifiche.'
        : b.email_inviata ? 'Fatto: email con le credenziali inviata.' : (b.warning || 'Credenziali rigenerate.'));
    } finally {
      setRegenBusy(false);
    }
  };

  const toggleSezione = (sid: string) => {
    setDraft((d) => ({ ...d, section_ids: d.section_ids.includes(sid) ? d.section_ids.filter((x) => x !== sid) : [...d.section_ids, sid] }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="animate-spin text-kidville-green" size={32} />
      </div>
    );
  }

  if (errore) {
    return (
      <div className="rounded-card bg-white p-6 shadow-sm">
        <div className="rounded-xl border border-kidville-error/30 bg-kidville-error-soft p-4 font-maven text-sm text-kidville-error">{errore}</div>
      </div>
    );
  }

  if (!member) {
    return (
      <div className="rounded-card bg-white p-10 text-center shadow-sm">
        <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">Membro non trovato</h2>
        <p className="mt-1 font-maven text-sm text-kidville-muted">Questo utente non è nell&apos;elenco del personale o non appartiene ai tuoi plessi.</p>
      </div>
    );
  }

  const initials = `${member.nome?.[0] ?? ''}${member.cognome?.[0] ?? ''}`.toUpperCase() || '—';
  const sedeNome = member.scuola_id ? (schools.find((s) => s.id === member.scuola_id)?.nome ?? '—') : '—';
  const classiAssegnate = asseg
    .filter((a) => a.utente_id === staffId)
    .map((a) => sections.find((s) => s.id === a.section_id)?.name)
    .filter((n): n is string => Boolean(n));
  const sezioniPerSede = sections.filter((s) => !draft.scuola_id || s.scuola_id === draft.scuola_id);

  return (
    <div className="flex w-full flex-col rounded-card bg-white shadow-sm">
      {/* Header: avatar iniziali + nome + ruolo */}
      <div className="flex items-center gap-4 border-b border-kidville-line p-5">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-kidville-green/10 font-barlow text-lg font-black text-kidville-green">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-barlow text-xl font-black uppercase tracking-wide text-kidville-green">
            {member.cognome} {member.nome}
          </h2>
          <span className="mt-1 inline-block rounded-full bg-kidville-cream px-2.5 py-0.5 font-maven text-[11px] font-bold text-kidville-green">
            {labelRuolo(member.ruolo)}
          </span>
        </div>
        <button
          onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-kidville-line text-kidville-muted hover:text-kidville-ink"
          title="Chiudi"
        >
          <X size={16} />
        </button>
      </div>

      <div className="space-y-5 p-5 md:p-6">
        {/* Contatti */}
        <section>
          <h3 className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">Contatti</h3>
          <label className="mb-1 block font-maven text-xs text-kidville-muted">Email</label>
          <p className="break-all font-maven text-sm text-kidville-green">{member.email || '—'}</p>
        </section>

        {/* Ruolo e Sede */}
        <section>
          <h3 className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">Ruolo e Sede</h3>
          {!editMode ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block font-maven text-xs text-kidville-muted">Ruolo</label>
                <span className="inline-block rounded-full bg-kidville-cream px-2.5 py-1 font-maven text-xs font-bold text-kidville-green">{labelRuolo(member.ruolo)}</span>
              </div>
              <div>
                <label className="mb-1 block font-maven text-xs text-kidville-muted">Sede</label>
                <p className="font-maven text-sm text-kidville-green">{sedeNome}</p>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-maven text-xs text-kidville-muted">Ruolo</label>
                <select value={draft.ruolo} onChange={(e) => setDraft({ ...draft, ruolo: e.target.value })}
                  className="w-full rounded-lg border-2 border-kidville-line px-2 py-1.5 text-sm text-kidville-green focus:border-kidville-green focus:outline-none">
                  {RUOLI_ASSEGNABILI.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block font-maven text-xs text-kidville-muted">Sede</label>
                <select value={draft.scuola_id} onChange={(e) => setDraft({ ...draft, scuola_id: e.target.value })}
                  className="w-full rounded-lg border-2 border-kidville-line px-2 py-1.5 text-sm text-kidville-green focus:border-kidville-green focus:outline-none">
                  <option value="">—</option>
                  {schools.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
                </select>
              </div>
            </div>
          )}
        </section>

        {/* Gradi (sola lettura, se presenti) */}
        {member.gradi && member.gradi.length > 0 && (
          <section>
            <h3 className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">Gradi</h3>
            <div className="flex flex-wrap gap-1.5">
              {member.gradi.map((g) => (
                <span key={g} className="rounded-full border border-kidville-line bg-white px-2 py-1 font-maven text-[11px] font-bold capitalize text-kidville-muted">{g}</span>
              ))}
            </div>
          </section>
        )}

        {/* Classi assegnate */}
        <section>
          <h3 className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">Classi assegnate</h3>
          {!editMode ? (
            classiAssegnate.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {classiAssegnate.map((n) => (
                  <span key={n} className="rounded-full bg-kidville-green/10 px-2.5 py-1 font-maven text-[11px] font-bold text-kidville-green">{n}</span>
                ))}
              </div>
            ) : (
              <p className="font-maven text-sm text-kidville-muted">Nessuna classe assegnata</p>
            )
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {sezioniPerSede.length === 0 && <span className="font-maven text-xs text-kidville-muted">Nessuna classe per questa sede.</span>}
              {sezioniPerSede.map((s) => {
                const on = draft.section_ids.includes(s.id);
                return (
                  <button key={s.id} type="button" onClick={() => toggleSezione(s.id)}
                    className={`rounded-full border px-2 py-1 font-maven text-[11px] font-bold ${on ? 'border-kidville-green bg-kidville-green text-white' : 'border-kidville-line bg-white text-kidville-muted hover:border-kidville-green'}`}>
                    {s.name}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Footer azioni — solo Direzione (il server rifiuta comunque le scritture della Segreteria) */}
      {canEdit ? (
        <div className="space-y-2 border-t border-kidville-line p-5">
          {!editMode ? (
            <>
              <button onClick={apri}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-pill bg-kidville-green font-barlow text-sm font-black uppercase tracking-wide text-kidville-yellow transition-all hover:opacity-90 active:scale-[0.98]">
                <Pencil size={15} /> Modifica
              </button>
              <button onClick={rigenera} disabled={regenBusy}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-pill border-2 border-kidville-green/40 font-barlow text-sm font-bold uppercase text-kidville-green transition-all hover:bg-kidville-green/5 disabled:opacity-50">
                {regenBusy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} Rigenera credenziali
              </button>
            </>
          ) : (
            <div className="flex gap-2">
              <button onClick={salva} disabled={saving}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-pill bg-kidville-green font-barlow text-sm font-black uppercase tracking-wide text-kidville-yellow transition-all hover:opacity-90 disabled:opacity-50">
                {saving ? <Loader2 size={16} className="animate-spin" /> : <><Check size={16} /> Salva</>}
              </button>
              <button onClick={() => setEditMode(false)} disabled={saving}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-pill border-2 border-kidville-line font-barlow text-sm font-bold uppercase text-kidville-muted transition-all hover:border-kidville-error hover:text-kidville-error disabled:opacity-50">
                <X size={16} /> Annulla
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 border-t border-kidville-line px-5 py-3 font-maven text-[11px] text-kidville-muted">
          <ShieldCheck size={12} /> Modifiche riservate alla Direzione
        </div>
      )}
    </div>
  );
}
