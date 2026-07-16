'use client';

import { useState, useEffect, useCallback } from 'react';
import { Users, Loader2, Pencil, Check, X, ShieldCheck, KeyRound } from 'lucide-react';
import { RUOLI_ASSEGNABILI, labelRuolo } from '@/lib/auth/ruoli';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

interface StaffUser { id: string; nome?: string; cognome?: string; email?: string; ruolo: string; scuola_id?: string; gradi?: string[] }
interface School { id: string; nome: string }
interface Section { id: string; name: string; scuola_id: string }

// Pannello gestione Staff RBAC (DL-028) — lista leggibile da tutto lo staff di
// gestione (Segreteria inclusa, T3); le AZIONI (modifica, rigenera credenziali)
// restano della Direzione: affordance nascoste ai non-Direzione, così nessun
// bottone che finisce sempre in un alert 403 (il gate vero resta sul server).
export function StaffPanel({ userId }: { userId: string }) {
  const { role } = useSessionIdentity();
  const canEdit = role === 'admin' || role === 'coordinator';
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [asseg, setAsseg] = useState<{ utente_id: string; section_id: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [errore, setErrore] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ ruolo: string; scuola_id: string; section_ids: string[] }>({ ruolo: '', scuola_id: '', section_ids: [] });
  const [saving, setSaving] = useState(false);
  const [regenId, setRegenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    // niente setLoading(true) sincrono: loading parte true da useState(true)
    // (react-hooks set-state-in-effect); refetch senza spinner, accettato.
    try {
      const res = await fetch('/api/admin/staff', { headers: { 'x-user-id': userId } });
      const j = await res.json().catch(() => null);
      // Mai una lista eternamente vuota che nasconde un errore: se il fetch non
      // riesce, si mostra il motivo (T3).
      if (!res.ok || !j?.success) {
        setErrore(j?.error || 'Errore di caricamento dello staff');
        return;
      }
      setErrore(null);
      setStaff(j.data); setSchools(j.schools ?? []); setSections(j.sections ?? []); setAsseg(j.assegnazioni ?? []);
    } finally { setLoading(false); }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const apri = (u: StaffUser) => {
    setEditId(u.id);
    setDraft({
      ruolo: u.ruolo,
      scuola_id: u.scuola_id ?? '',
      section_ids: asseg.filter((a) => a.utente_id === u.id).map((a) => a.section_id),
    });
  };

  const salva = async (id: string) => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/staff', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ id, ruolo: draft.ruolo, scuola_id: draft.scuola_id || undefined, section_ids: draft.section_ids }),
      });
      if (res.status === 403) { alert('Azione riservata alla Direzione, oppure non puoi modificare il tuo stesso ruolo.'); return; }
      if (!res.ok) { const j = await res.json().catch(() => ({})); alert(j.error || 'Errore'); return; }
      setEditId(null);
      await load();
    } finally { setSaving(false); }
  };

  const rigenera = async (u: StaffUser) => {
    if (!confirm(`Rigenerare le credenziali di ${u.cognome ?? ''} ${u.nome ?? ''}? La password precedente non sarà più valida.`)) return;
    setRegenId(u.id);
    try {
      const res = await fetch('/api/admin/regenerate-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ targetKind: 'staff', targetId: u.id }),
      });
      const body = await res.json();
      if (!res.ok) { alert(body.error || 'Errore'); return; }
      alert(body.pdf_notifica
        ? 'Fatto: email inviata e PDF disponibile nel centro notifiche.'
        : body.email_inviata ? 'Fatto: email con le credenziali inviata.' : (body.warning || 'Credenziali rigenerate.'));
    } finally { setRegenId(null); }
  };

  const toggleSezione = (sid: string) => {
    setDraft((d) => ({ ...d, section_ids: d.section_ids.includes(sid) ? d.section_ids.filter((x) => x !== sid) : [...d.section_ids, sid] }));
  };

  if (loading) return <div className="flex items-center gap-2 text-kidville-muted p-6"><Loader2 className="animate-spin" size={16} /> Caricamento staff…</div>;

  if (errore) return <div className="rounded-xl border border-kidville-error/30 bg-kidville-error-soft p-4 font-maven text-sm text-kidville-error">{errore}</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-kidville-green">
        <Users size={18} />
        <h3 className="font-barlow font-black uppercase tracking-wide">Gestione Staff (RBAC)</h3>
        <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-kidville-muted"><ShieldCheck size={12} /> modifiche solo Direzione</span>
      </div>

      <div className="space-y-2">
        {staff.map((u) => {
          const isEditing = editId === u.id;
          const sezioniUtente = sections.filter((s) => !draft.scuola_id || s.scuola_id === draft.scuola_id);
          return (
            <div key={u.id} className="bg-kidville-white border border-kidville-line rounded-xl p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-maven font-bold text-sm text-kidville-green truncate">{u.cognome} {u.nome}</p>
                  <p className="font-maven text-xs text-kidville-muted truncate">{u.email}</p>
                </div>
                {!isEditing ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="px-2 py-0.5 rounded-full bg-kidville-cream text-kidville-green text-[11px] font-bold">{labelRuolo(u.ruolo)}</span>
                    {/* Azioni solo Direzione: alla Segreteria (sola lettura) non si
                        mostrano bottoni destinati a fallire col 403 del server. */}
                    {canEdit && (
                      <>
                        <button onClick={() => rigenera(u)} disabled={regenId === u.id} className="text-kidville-muted hover:text-kidville-green disabled:opacity-40" title="Rigenera credenziali">
                          {regenId === u.id ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
                        </button>
                        <button onClick={() => apri(u)} className="text-kidville-muted hover:text-kidville-green" title="Modifica"><Pencil size={15} /></button>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => salva(u.id)} disabled={saving} className="text-kidville-success hover:text-kidville-success" title="Salva">
                      {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                    </button>
                    <button onClick={() => setEditId(null)} className="text-kidville-muted hover:text-kidville-error" title="Annulla"><X size={16} /></button>
                  </div>
                )}
              </div>

              {isEditing && (
                <div className="mt-3 grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-kidville-muted mb-1">Ruolo</label>
                    <select value={draft.ruolo} onChange={(e) => setDraft({ ...draft, ruolo: e.target.value })}
                      className="w-full border-2 border-kidville-line rounded-lg px-2 py-1.5 text-sm text-kidville-green focus:outline-none focus:border-kidville-green">
                      {RUOLI_ASSEGNABILI.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-kidville-muted mb-1">Sede</label>
                    <select value={draft.scuola_id} onChange={(e) => setDraft({ ...draft, scuola_id: e.target.value })}
                      className="w-full border-2 border-kidville-line rounded-lg px-2 py-1.5 text-sm text-kidville-green focus:outline-none focus:border-kidville-green">
                      <option value="">—</option>
                      {schools.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-semibold text-kidville-muted mb-1">Classi assegnate</label>
                    <div className="flex flex-wrap gap-1.5">
                      {sezioniUtente.length === 0 && <span className="text-xs text-kidville-muted">Nessuna classe per questa sede.</span>}
                      {sezioniUtente.map((s) => {
                        const on = draft.section_ids.includes(s.id);
                        return (
                          <button key={s.id} type="button" onClick={() => toggleSezione(s.id)}
                            className={`px-2 py-1 rounded-full text-[11px] font-bold border ${on ? 'bg-kidville-green text-kidville-white border-kidville-green' : 'bg-kidville-white text-kidville-muted border-kidville-line hover:border-kidville-green'}`}>
                            {s.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
