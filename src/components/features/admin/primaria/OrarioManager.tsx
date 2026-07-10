'use client';

import { useCallback, useEffect, useState } from 'react';
import { Sparkles, Plus, Trash2 } from 'lucide-react';

interface Campanella { id: string; giorno_settimana: number; ordine: number; ora_inizio: string; ora_fine: string; tipo: string }
interface Cella { giorno_settimana: number; campanella_id: string; materia_id: string | null; docente_id: string | null }
interface Materia { id: string; nome: string }
interface Docente { id: string; nome: string; cognome: string; gradi?: string[] }

const GIORNI = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const TIPI: { id: string; label: string }[] = [
  { id: 'lezione', label: 'Lezione' },
  { id: 'intervallo', label: 'Intervallo' },
  { id: 'mensa', label: 'Mensa' },
];

// "HH:MM" + minuti → "HH:MM" (per proporre l'orario della campanella successiva).
function addMin(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function OrarioManager({ sectionId, scuolaId, userId }: { sectionId: string; scuolaId: string; userId: string }) {
  const [tempo, setTempo] = useState<{ modello: number; giorni_settimana: number } | null>(null);
  const [campanelle, setCampanelle] = useState<Campanella[]>([]);
  const [orario, setOrario] = useState<Cella[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [docenti, setDocenti] = useState<Docente[]>([]);
  const [modello, setModello] = useState(27);
  const [giorni, setGiorni] = useState(5);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!sectionId) return;
    let res:
      | [
          { success: boolean; data: { tempoScuola: { modello: number; giorni_settimana: number } | null; campanelle: Campanella[]; orario: Cella[] } },
          { success: boolean; data: Materia[] },
          { success: boolean; data: Docente[] },
        ]
      | null = null;
    try {
      res = await Promise.all([
        fetch(`/api/admin/primaria/orario?sectionId=${sectionId}`, { headers: { 'x-user-id': userId } }).then((r) => r.json()),
        fetch(`/api/admin/primaria/materie?sectionId=${sectionId}`, { headers: { 'x-user-id': userId } }).then((r) => r.json()),
        fetch(`/api/admin/primaria/docente-gradi?scuolaId=${scuolaId}`, { headers: { 'x-user-id': userId } }).then((r) => r.json()),
      ]);
    } finally {
      if (res) {
        const [oRes, mRes, dRes] = res;
        if (oRes.success) {
          setTempo(oRes.data.tempoScuola);
          setCampanelle(oRes.data.campanelle);
          setOrario(oRes.data.orario);
          if (oRes.data.tempoScuola) {
            setModello(oRes.data.tempoScuola.modello);
            setGiorni(oRes.data.tempoScuola.giorni_settimana);
          }
        }
        setMaterie(mRes.success ? mRes.data : []);
        setDocenti((dRes.success ? dRes.data : []).filter((d: Docente) => (d.gradi ?? []).includes('primaria')));
      }
    }
  }, [sectionId, scuolaId, userId]);

  useEffect(() => {
    load();
  }, [load]);

  const setTempoScuola = async () => {
    setBusy(true);
    await fetch(`/api/admin/primaria/orario?action=set-tempo&userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ sectionId, modello, giorniSettimana: giorni }),
    });
    await load();
    setBusy(false);
  };

  const setCell = async (giorno: number, campanellaId: string, field: 'materiaId' | 'docenteId', value: string) => {
    const existing = orario.find((o) => o.campanella_id === campanellaId && o.giorno_settimana === giorno);
    const payload = {
      sectionId,
      giorno,
      campanellaId,
      materiaId: field === 'materiaId' ? value || null : existing?.materia_id ?? null,
      docenteId: field === 'docenteId' ? value || null : existing?.docente_id ?? null,
    };
    // ottimistico
    setOrario((prev) => {
      const others = prev.filter((o) => !(o.campanella_id === campanellaId && o.giorno_settimana === giorno));
      return [...others, { giorno_settimana: giorno, campanella_id: campanellaId, materia_id: payload.materiaId, docente_id: payload.docenteId }];
    });
    await fetch(`/api/admin/primaria/orario?action=set-cell&userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify(payload),
    });
  };

  // ── Editing manuale delle singole campanelle (orari/tipo/aggiungi/elimina) ──
  const postAction = (action: string, body: object) =>
    fetch(`/api/admin/primaria/orario?action=${action}&userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify(body),
    });

  const updateCampanella = async (campanellaId: string, patch: { oraInizio?: string; oraFine?: string; tipo?: string }) => {
    setBusy(true);
    await postAction('update-campanella', { sectionId, campanellaId, ...patch });
    await load();
    setBusy(false);
  };

  const deleteCampanella = async (campanellaId: string) => {
    setBusy(true);
    await postAction('delete-campanella', { sectionId, campanellaId });
    await load();
    setBusy(false);
  };

  const addCampanella = async (giorno: number) => {
    const delGiorno = campanelle.filter((c) => c.giorno_settimana === giorno).sort((a, b) => a.ordine - b.ordine);
    const last = delGiorno[delGiorno.length - 1];
    const maxOrd = last ? last.ordine : 0;
    const start = last ? String(last.ora_fine).slice(0, 5) : '08:30';
    setBusy(true);
    await postAction('add-campanella', { sectionId, giornoSettimana: giorno, ordine: maxOrd + 1, oraInizio: start, oraFine: addMin(start, 60), tipo: 'lezione' });
    await load();
    setBusy(false);
  };

  if (!sectionId) return <p className="font-maven text-kidville-muted">Seleziona una sezione primaria.</p>;

  const giorniPresenti = Array.from(new Set(campanelle.map((c) => c.giorno_settimana))).sort();
  const ordini = Array.from(new Set(campanelle.map((c) => c.ordine))).sort((a, b) => a - b);
  const campanellaDi = (g: number, o: number) => campanelle.find((c) => c.giorno_settimana === g && c.ordine === o);
  const cellDi = (campId: string, g: number) => orario.find((o) => o.campanella_id === campId && o.giorno_settimana === g);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-card bg-kidville-cream/50 p-3">
        <span className="font-maven text-sm text-kidville-ink">Tempo scuola</span>
        <select value={modello} onChange={(e) => setModello(Number(e.target.value))} className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm">
          <option value={27}>27 ore</option>
          <option value={29}>29 ore</option>
          <option value={40}>40 ore (tempo pieno)</option>
        </select>
        <select value={giorni} onChange={(e) => setGiorni(Number(e.target.value))} className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm">
          <option value={5}>5 giorni</option>
          <option value={6}>6 giorni</option>
        </select>
        <button onClick={setTempoScuola} disabled={busy} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50">
          <Sparkles size={14} /> {tempo ? 'Rigenera campanelle' : 'Genera orario'}
        </button>
        {tempo && <span className="font-maven text-xs text-kidville-muted">Attivo: {tempo.modello}h / {tempo.giorni_settimana}gg</span>}
      </div>

      {campanelle.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">Imposta il tempo scuola per generare la griglia.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs font-maven">
            <thead>
              <tr>
                <th className="p-1.5 text-left text-kidville-muted">Ora</th>
                {giorniPresenti.map((g) => (
                  <th key={g} className="p-1.5 text-center text-kidville-ink">{GIORNI[g - 1]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordini.map((ord) => {
                const ref = campanelle.find((c) => c.ordine === ord);
                return (
                  <tr key={ord} className="border-t border-kidville-line">
                    <td className="p-1.5 text-kidville-muted whitespace-nowrap">{ref?.ora_inizio?.slice(0, 5)}</td>
                    {giorniPresenti.map((g) => {
                      const camp = campanellaDi(g, ord);
                      if (!camp) return <td key={g} className="p-1.5" />;
                      if (camp.tipo !== 'lezione') {
                        return <td key={g} className="p-1.5 text-center text-kidville-muted">{camp.tipo === 'mensa' ? '🍽' : '☕'}</td>;
                      }
                      const cell = cellDi(camp.id, g);
                      return (
                        <td key={g} className="p-1 align-top">
                          <select
                            value={cell?.materia_id ?? ''}
                            onChange={(e) => setCell(g, camp.id, 'materiaId', e.target.value)}
                            className="mb-1 w-full rounded border border-kidville-line px-1 py-0.5"
                          >
                            <option value="">—</option>
                            {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
                          </select>
                          <select
                            value={cell?.docente_id ?? ''}
                            onChange={(e) => setCell(g, camp.id, 'docenteId', e.target.value)}
                            className="w-full rounded border border-kidville-line px-1 py-0.5 text-kidville-muted"
                          >
                            <option value="">docente…</option>
                            {docenti.map((d) => <option key={d.id} value={d.id}>{d.cognome}</option>)}
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {campanelle.length > 0 && (
        <details className="rounded-card border border-kidville-line bg-white p-3">
          <summary className="cursor-pointer font-maven text-sm font-semibold text-kidville-ink">Modifica campanelle (orari, intervallo/mensa)</summary>
          <p className="mt-1 font-maven text-xs text-kidville-muted">Modifica gli orari e il tipo di ogni campanella, aggiungi un intervallo/mensa o elimina uno slot. Attenzione: la rigenerazione dal tempo scuola sovrascrive queste modifiche.</p>
          <div className="mt-3 space-y-4">
            {giorniPresenti.map((g) => (
              <div key={g}>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">{GIORNI[g - 1]}</span>
                  <button onClick={() => addCampanella(g)} disabled={busy} className="font-maven inline-flex items-center gap-1 rounded-pill bg-kidville-cream px-2.5 py-1 text-xs text-kidville-ink disabled:opacity-50">
                    <Plus size={12} /> aggiungi ora
                  </button>
                </div>
                <ul className="space-y-1.5">
                  {campanelle.filter((c) => c.giorno_settimana === g).sort((a, b) => a.ordine - b.ordine).map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-1.5">
                      <span className="w-5 font-maven text-xs text-kidville-muted">{c.ordine}</span>
                      <input
                        type="time"
                        defaultValue={String(c.ora_inizio).slice(0, 5)}
                        onBlur={(e) => { if (e.target.value && e.target.value !== String(c.ora_inizio).slice(0, 5)) updateCampanella(c.id, { oraInizio: e.target.value }); }}
                        className="rounded border border-kidville-line px-1.5 py-0.5 font-maven text-xs"
                        aria-label="ora inizio"
                      />
                      <span className="text-xs text-kidville-muted">–</span>
                      <input
                        type="time"
                        defaultValue={String(c.ora_fine).slice(0, 5)}
                        onBlur={(e) => { if (e.target.value && e.target.value !== String(c.ora_fine).slice(0, 5)) updateCampanella(c.id, { oraFine: e.target.value }); }}
                        className="rounded border border-kidville-line px-1.5 py-0.5 font-maven text-xs"
                        aria-label="ora fine"
                      />
                      <select value={c.tipo} onChange={(e) => updateCampanella(c.id, { tipo: e.target.value })} className="rounded border border-kidville-line px-1.5 py-0.5 font-maven text-xs">
                        {TIPI.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                      <button onClick={() => deleteCampanella(c.id)} disabled={busy} className="ml-auto inline-flex items-center rounded-pill p-1 text-kidville-error hover:bg-kidville-error/10 disabled:opacity-50" aria-label="elimina campanella">
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
