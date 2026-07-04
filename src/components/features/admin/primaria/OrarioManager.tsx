'use client';

import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';

interface Campanella { id: string; giorno_settimana: number; ordine: number; ora_inizio: string; ora_fine: string; tipo: string }
interface Cella { giorno_settimana: number; campanella_id: string; materia_id: string | null; docente_id: string | null }
interface Materia { id: string; nome: string }
interface Docente { id: string; nome: string; cognome: string; gradi?: string[] }

const GIORNI = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

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
    </div>
  );
}
