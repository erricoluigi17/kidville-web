'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Star, Check } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

interface Alunno { id: string; nome: string; cognome: string }
interface Materia { id: string; nome: string }
interface Obiettivo { id: string; codice: string | null; descrizione: string }
interface Valutazione {
  id: string; tipo: string; modalita: string; giudizio_sintetico: string | null; giudizio_testo: string | null; creato_il: string;
}

export default function ValutazioniPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [alunnoId, setAlunnoId] = useState('');
  const [materiaId, setMateriaId] = useState('');
  const [obiettivi, setObiettivi] = useState<Obiettivo[]>([]);
  const [scala, setScala] = useState<string[]>([]);
  const [recenti, setRecenti] = useState<Valutazione[]>([]);

  // form
  const [tipoProva, setTipoProva] = useState('orale');
  const [modalita, setModalita] = useState<'dimensioni' | 'sintetico'>('dimensioni');
  const [autonomia, setAutonomia] = useState(true);
  const [continuita, setContinuita] = useState(true);
  const [tipologia, setTipologia] = useState<'nota' | 'non_nota'>('nota');
  const [risorse, setRisorse] = useState<'interne' | 'esterne' | 'entrambe'>('interne');
  const [giudizioSintetico, setGiudizioSintetico] = useState('');
  const [giudizioTesto, setGiudizioTesto] = useState('');
  const [obiettiviSel, setObiettiviSel] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setAlunni(d.data.alunni ?? []);
          setMaterie(d.data.materie ?? []);
        }
      });
  }, [sectionId, userId]);

  const loadObiettivi = useCallback(async () => {
    if (!materiaId) return;
    const r = await fetch(`/api/primaria/obiettivi?materiaId=${materiaId}&sectionId=${sectionId}&userId=${userId}`);
    const d = await r.json();
    if (d.success) {
      setObiettivi(d.data.obiettivi);
      setScala(d.data.scala);
      if (d.data.scala.length) setGiudizioSintetico(d.data.scala[0]);
    }
  }, [materiaId, sectionId, userId]);

  const loadRecenti = useCallback(async () => {
    if (!alunnoId || !materiaId) { setRecenti([]); return; }
    const r = await fetch(`/api/primaria/valutazioni?alunnoId=${alunnoId}&materiaId=${materiaId}&userId=${userId}`);
    const d = await r.json();
    if (d.success) setRecenti(d.data);
  }, [alunnoId, materiaId, userId]);

  useEffect(() => { loadObiettivi(); }, [loadObiettivi]);
  useEffect(() => { loadRecenti(); }, [loadRecenti]);

  const toggleObiettivo = (id: string) =>
    setObiettiviSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const salva = async () => {
    setMsg('');
    if (!alunnoId || !materiaId) { setMsg('Seleziona alunno e materia'); return; }
    if (obiettiviSel.length === 0) { setMsg('Seleziona almeno un obiettivo'); return; }
    setSaving(true);
    const r = await fetch(`/api/primaria/valutazioni?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        alunnoId, sectionId, materiaId, tipoProva, modalita,
        dims: modalita === 'dimensioni' ? { autonomia, continuita, tipologia, risorse } : undefined,
        giudizioSintetico: modalita === 'sintetico' ? giudizioSintetico : undefined,
        giudizioTesto: giudizioTesto || undefined,
        obiettiviIds: obiettiviSel,
      }),
    });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) setMsg(d.error || 'Errore');
    else {
      setMsg('Valutazione salvata ✓');
      setGiudizioTesto('');
      setObiettiviSel([]);
      loadRecenti();
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-card bg-white p-5 shadow-sm">
        <h2 className="font-barlow text-lg font-bold text-gray-800 mb-3 flex items-center gap-2">
          <Star size={18} className="text-kidville-yellow" /> Valutazione in itinere
        </h2>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <select value={alunnoId} onChange={(e) => setAlunnoId(e.target.value)} className="font-maven rounded-pill border border-gray-200 px-3 py-2 text-sm">
            <option value="">Alunno…</option>
            {alunni.map((a) => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}
          </select>
          <select value={materiaId} onChange={(e) => setMateriaId(e.target.value)} className="font-maven rounded-pill border border-gray-200 px-3 py-2 text-sm">
            <option value="">Materia…</option>
            {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
          </select>
        </div>

        <div className="mb-3">
          <label className="block font-maven text-xs text-gray-500 mb-1">Tipo prova</label>
          <div className="flex gap-1.5">
            {['orale', 'scritto', 'pratico'].map((t) => (
              <button key={t} onClick={() => setTipoProva(t)} className={`font-maven rounded-pill px-3 py-1 text-xs capitalize ${tipoProva === t ? 'bg-kidville-green text-kidville-yellow' : 'bg-gray-100 text-gray-500'}`}>{t}</button>
            ))}
          </div>
        </div>

        <div className="mb-3 flex gap-1.5">
          <button onClick={() => setModalita('dimensioni')} className={`font-maven rounded-pill px-3 py-1.5 text-xs ${modalita === 'dimensioni' ? 'bg-kidville-green text-kidville-yellow' : 'bg-gray-100 text-gray-500'}`}>Per dimensioni</button>
          <button onClick={() => setModalita('sintetico')} className={`font-maven rounded-pill px-3 py-1.5 text-xs ${modalita === 'sintetico' ? 'bg-kidville-green text-kidville-yellow' : 'bg-gray-100 text-gray-500'}`}>Giudizio sintetico</button>
        </div>

        {modalita === 'dimensioni' ? (
          <div className="space-y-2 rounded-card bg-kidville-cream/40 p-3 mb-3">
            <DimToggle label="Autonomia" value={autonomia ? 'sì' : 'no'} options={[['sì', true], ['no', false]]} onChange={(v) => setAutonomia(v as boolean)} />
            <DimToggle label="Continuità" value={continuita ? 'sì' : 'no'} options={[['sì', true], ['no', false]]} onChange={(v) => setContinuita(v as boolean)} />
            <DimToggle label="Tipologia" value={tipologia} options={[['nota', 'nota'], ['non nota', 'non_nota']]} onChange={(v) => setTipologia(v as 'nota' | 'non_nota')} />
            <DimToggle label="Risorse" value={risorse} options={[['interne', 'interne'], ['esterne', 'esterne'], ['entrambe', 'entrambe']]} onChange={(v) => setRisorse(v as 'interne' | 'esterne' | 'entrambe')} />
            <textarea
              value={giudizioTesto}
              onChange={(e) => setGiudizioTesto(e.target.value)}
              rows={2}
              placeholder="Giudizio descrittivo (lascia vuoto per generarlo automaticamente)"
              className="font-maven w-full rounded-card border border-gray-200 px-3 py-2 text-sm"
            />
          </div>
        ) : (
          <div className="mb-3">
            <label className="block font-maven text-xs text-gray-500 mb-1">Giudizio sintetico</label>
            <select value={giudizioSintetico} onChange={(e) => setGiudizioSintetico(e.target.value)} className="font-maven w-full rounded-pill border border-gray-200 px-3 py-2 text-sm">
              {scala.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        )}

        <div className="mb-3">
          <label className="block font-maven text-xs text-gray-500 mb-1">Obiettivi (almeno uno) *</label>
          <div className="max-h-32 overflow-y-auto rounded-card border border-gray-100 p-2">
            {obiettivi.map((o) => (
              <label key={o.id} className="flex items-start gap-2 py-0.5 font-maven text-sm">
                <input type="checkbox" checked={obiettiviSel.includes(o.id)} onChange={() => toggleObiettivo(o.id)} className="mt-1" />
                <span>{o.codice && <b className="text-kidville-green mr-1">{o.codice}</b>}{o.descrizione}</span>
              </label>
            ))}
            {obiettivi.length === 0 && <p className="font-maven text-xs text-gray-400">Nessun obiettivo per questa materia/livello. Configurali nell&apos;admin.</p>}
          </div>
        </div>

        {msg && <p className={`font-maven text-sm mb-2 ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</p>}
        <button onClick={salva} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
          <Check size={15} /> {saving ? 'Salvataggio…' : 'Salva valutazione'}
        </button>
      </div>

      <div className="rounded-card bg-white p-5 shadow-sm">
        <h3 className="font-barlow text-base font-bold text-gray-800 mb-3">Valutazioni recenti</h3>
        {!alunnoId || !materiaId ? (
          <p className="font-maven text-sm text-gray-400">Seleziona alunno e materia.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {recenti.map((v) => (
              <li key={v.id} className="py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-maven text-sm font-semibold text-kidville-green">
                    {v.giudizio_sintetico || (v.modalita === 'dimensioni' ? 'Per dimensioni' : '—')}
                  </span>
                  <span className="text-xs text-gray-400 capitalize">{v.tipo}</span>
                  <span className="text-xs text-gray-300">{new Date(v.creato_il).toLocaleDateString('it-IT')}</span>
                </div>
                {v.giudizio_testo && <p className="font-maven text-xs text-gray-500 mt-0.5">{v.giudizio_testo}</p>}
              </li>
            ))}
            {recenti.length === 0 && <li className="py-2 font-maven text-sm text-gray-400">Nessuna valutazione.</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

function DimToggle({ label, value, options, onChange }: {
  label: string; value: string; options: [string, unknown][]; onChange: (v: unknown) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-maven text-sm text-gray-600">{label}</span>
      <div className="flex gap-1">
        {options.map(([lbl, val]) => {
          const active = String(val) === String(value) || lbl === value;
          return (
            <button key={lbl} onClick={() => onChange(val)} className={`font-maven rounded-pill px-2.5 py-1 text-xs ${active ? 'bg-kidville-green text-kidville-yellow' : 'bg-white text-gray-500 border border-gray-200'}`}>{lbl}</button>
          );
        })}
      </div>
    </div>
  );
}
