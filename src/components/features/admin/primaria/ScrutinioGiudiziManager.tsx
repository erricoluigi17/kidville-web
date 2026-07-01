'use client';

import { useCallback, useEffect, useState } from 'react';
import { GraduationCap } from 'lucide-react';

interface Section { id: string; name: string; school_type: string }
interface Periodo { id: string; nome: string; anno_scolastico: string }
interface Materia { id: string; nome: string; codice: string }
interface ScalaItem { etichetta: string; ordine: number }
interface DescrRow { materia_codice: string; etichetta_voto: string; giudizio_descrittivo: string }

const LIVELLI = [1, 2, 3, 4, 5];

// Configurazione del giudizio descrittivo di scrutinio per voto, distinto da
// quello in itinere. Granularità: livello × materia × periodo × voto. In pagella
// il testo si associa in automatico al voto assegnato. Compilare un livello vale
// per tutte le sezioni di quel livello.
export function ScrutinioGiudiziManager({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const [periodi, setPeriodi] = useState<Periodo[]>([]);
  const [scala, setScala] = useState<ScalaItem[]>([]);
  const [sezioni, setSezioni] = useState<Section[]>([]);
  const [livello, setLivello] = useState(1);
  const [periodoId, setPeriodoId] = useState('');
  const [materie, setMaterie] = useState<Materia[]>([]);
  // testi[materia_codice][etichetta_voto] = testo
  const [testi, setTesti] = useState<Record<string, Record<string, string>>>({});
  const [msg, setMsg] = useState('');

  // Carica periodi, scala e sezioni una volta.
  useEffect(() => {
    fetch(`/api/admin/primaria/scrutinio-periodi?userId=${userId}`, { headers: { 'x-user-id': userId } })
      .then((r) => r.json())
      .then((d) => { if (d.success) { setPeriodi(d.data); if (d.data.length) setPeriodoId((p) => p || d.data[0].id); } })
      .catch(() => {});
    fetch(`/api/admin/primaria/giudizi?scuolaId=${scuolaId}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setScala(d.data.scala ?? []); })
      .catch(() => {});
    fetch(`/api/admin/sections?scuola_id=${scuolaId}`)
      .then((r) => r.json())
      .then((d) => { setSezioni(Array.isArray(d) ? d.filter((s: Section) => s.school_type === 'primaria') : []); })
      .catch(() => {});
  }, [scuolaId, userId]);

  // Materie del livello: usa una sezione rappresentativa di quel livello.
  useEffect(() => {
    const sez = sezioni.find((s) => s.name?.match(/[1-5]/)?.[0] === String(livello));
    if (!sez) { setMaterie([]); return; }
    fetch(`/api/admin/primaria/materie?sectionId=${sez.id}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setMaterie((d.data as Materia[]).filter((m) => m.codice)); })
      .catch(() => {});
  }, [sezioni, livello]);

  const loadTesti = useCallback(async () => {
    if (!periodoId) return;
    const r = await fetch(`/api/admin/primaria/scrutinio-giudizio?scuolaId=${scuolaId}&livello=${livello}&periodoId=${periodoId}`);
    const d = await r.json();
    if (!d.success) return;
    const map: Record<string, Record<string, string>> = {};
    (d.data as DescrRow[]).forEach((row) => {
      map[row.materia_codice] = map[row.materia_codice] || {};
      map[row.materia_codice][row.etichetta_voto] = row.giudizio_descrittivo;
    });
    setTesti(map);
  }, [scuolaId, livello, periodoId]);

  useEffect(() => { loadTesti(); }, [loadTesti]);

  const salva = async (materiaCodice: string, etichettaVoto: string, testo: string) => {
    setMsg('');
    const r = await fetch(`/api/admin/primaria/scrutinio-giudizio?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scuolaId, livello, materiaCodice, periodoId, etichettaVoto, testo }),
    });
    setTesti((prev) => ({ ...prev, [materiaCodice]: { ...(prev[materiaCodice] || {}), [etichettaVoto]: testo } }));
    setMsg(r.ok ? 'Salvato ✓' : 'Errore salvataggio');
  };

  return (
    <div>
      <h3 className="font-barlow text-base font-bold text-kidville-ink mb-1 flex items-center gap-2">
        <GraduationCap size={16} className="text-kidville-green" /> Giudizi di scrutinio per voto
      </h3>
      <p className="font-maven text-xs text-kidville-muted mb-4">
        Per ogni livello di classe, materia e periodo, definisci il testo associato a ciascun voto. In pagella
        viene applicato in automatico al voto assegnato. Compilare un livello (es. 1ª) vale per tutte le sezioni di quel livello.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="font-maven text-sm text-kidville-ink">Livello:</label>
        <select value={livello} onChange={(e) => setLivello(Number(e.target.value))} className="font-maven rounded-pill border border-kidville-line bg-white px-4 py-2 text-sm">
          {LIVELLI.map((l) => <option key={l} value={l}>{l}ª</option>)}
        </select>
        <label className="font-maven text-sm text-kidville-ink">Periodo:</label>
        <select value={periodoId} onChange={(e) => setPeriodoId(e.target.value)} className="font-maven rounded-pill border border-kidville-line bg-white px-4 py-2 text-sm">
          {periodi.length === 0 && <option value="">Nessun periodo</option>}
          {periodi.map((p) => <option key={p.id} value={p.id}>{p.nome} ({p.anno_scolastico})</option>)}
        </select>
        {msg && <span className={`font-maven text-xs ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</span>}
      </div>

      {periodi.length === 0 ? (
        <p className="font-maven text-sm text-kidville-warn">Configura prima un periodo di scrutinio (tab Scrutinio).</p>
      ) : scala.length === 0 ? (
        <p className="font-maven text-sm text-kidville-warn">Configura prima la scala dei giudizi (tab Giudizi).</p>
      ) : materie.length === 0 ? (
        <p className="font-maven text-sm text-kidville-warn">Nessuna materia con codice per il livello {livello}ª. Configura le materie (tab Materie).</p>
      ) : (
        <div className="space-y-5">
          {materie.map((m) => (
            <div key={m.id} className="rounded-card border border-kidville-line p-3">
              <p className="font-maven text-sm font-semibold text-kidville-ink mb-2">{m.nome}</p>
              <div className="space-y-2">
                {scala.map((s) => (
                  <div key={s.etichetta} className="flex items-start gap-2">
                    <span className="font-maven text-xs text-kidville-muted w-28 shrink-0 pt-2">{s.etichetta}</span>
                    <textarea
                      defaultValue={testi[m.codice]?.[s.etichetta] ?? ''}
                      key={`${m.codice}-${s.etichetta}-${livello}-${periodoId}`}
                      rows={2}
                      placeholder="Testo del giudizio per questo voto…"
                      onBlur={(e) => {
                        const v = e.target.value;
                        if (v !== (testi[m.codice]?.[s.etichetta] ?? '')) salva(m.codice, s.etichetta, v);
                      }}
                      className="font-maven flex-1 rounded border border-kidville-line px-2 py-1.5 text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
