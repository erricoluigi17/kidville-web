'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Star, Check, Lock } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { suggerisciGiudizio } from '@/lib/primaria/suggerimento';
import type { ScalaVoce } from '@/lib/primaria/media';

interface Alunno { id: string; nome: string; cognome: string }
interface Materia { id: string; nome: string }
interface Obiettivo { id: string; codice: string | null; descrizione: string; livello: number }
interface Valutazione {
  id: string; tipo: string; modalita: string; argomento: string | null; giudizio_sintetico: string | null; giudizio_testo: string | null; annotazione_numerica: number | null; creato_il: string;
}
interface Impreparato {
  id: string; alunno_id: string; data: string; motivo: string | null; origine: string; alunni?: { nome: string; cognome: string } | null;
}

function oggiIso() { return new Date().toISOString().slice(0, 10); }

export default function ValutazioniPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [alunnoId, setAlunnoId] = useState('');
  const [materiaId, setMateriaId] = useState('');
  const [scala, setScala] = useState<string[]>([]);
  const [scalaValori, setScalaValori] = useState<ScalaVoce[]>([]);
  const [obiettivi, setObiettivi] = useState<Obiettivo[]>([]);
  const [obiettiviSel, setObiettiviSel] = useState<string[]>([]);
  const [recenti, setRecenti] = useState<Valutazione[]>([]);
  const [impreparati, setImpreparati] = useState<Impreparato[]>([]);

  // form
  const [tipoProva, setTipoProva] = useState('orale');
  const [modalita, setModalita] = useState<'dimensioni' | 'sintetico'>('dimensioni');
  const [autonomia, setAutonomia] = useState(true);
  const [continuita, setContinuita] = useState(true);
  const [tipologia, setTipologia] = useState<'nota' | 'non_nota'>('nota');
  const [risorse, setRisorse] = useState<'interne' | 'esterne' | 'entrambe'>('interne');
  const [giudizioSintetico, setGiudizioSintetico] = useState('');
  const [giudizioTesto, setGiudizioTesto] = useState('');
  const [annotazioneNumerica, setAnnotazioneNumerica] = useState('');
  const [argomento, setArgomento] = useState('');
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

  // Carica la scala dei giudizi sintetici per la materia/livello.
  const loadScala = useCallback(async () => {
    if (!materiaId) return;
    try {
      const r = await fetch(`/api/primaria/obiettivi?materiaId=${materiaId}&sectionId=${sectionId}&userId=${userId}`);
      const d = await r.json();
      if (d.success) {
        setScala(d.data.scala);
        setScalaValori(d.data.scalaValori ?? []);
        setObiettivi(d.data.obiettivi ?? []);
        setObiettiviSel([]);
        if (d.data.scala.length) setGiudizioSintetico(d.data.scala[0]);
      }
    } finally {
      // nessuno stato di caricamento da azzerare
    }
  }, [materiaId, sectionId, userId]);

  const toggleObiettivo = (id: string) =>
    setObiettiviSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const loadRecenti = useCallback(async () => {
    if (!alunnoId || !materiaId) return;
    try {
      const r = await fetch(`/api/primaria/valutazioni?alunnoId=${alunnoId}&materiaId=${materiaId}&userId=${userId}`);
      const d = await r.json();
      if (d.success) setRecenti(d.data);
    } finally {
      // nessuno stato di caricamento da azzerare
    }
  }, [alunnoId, materiaId, userId]);

  const loadImpreparati = useCallback(async () => {
    try {
      const r = await fetch(`/api/primaria/giustifiche-didattiche?sectionId=${sectionId}&data=${oggiIso()}&userId=${userId}`);
      const d = await r.json();
      if (d.success) setImpreparati(d.data);
    } finally {
      // nessuno stato di caricamento da azzerare
    }
  }, [sectionId, userId]);

  useEffect(() => { loadScala(); }, [loadScala]);
  useEffect(() => { loadRecenti(); }, [loadRecenti]);
  useEffect(() => { loadImpreparati(); }, [loadImpreparati]);

  // Il docente segna l'alunno selezionato come impreparato giustificato (oggi).
  const segnaImpreparato = async () => {
    if (!alunnoId) { setMsg('Seleziona un alunno'); return; }
    if (!userId) { setMsg('Identità non risolta: riapri la pagina dal registro.'); return; }
    await fetch(`/api/primaria/giustifiche-didattiche?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ sectionId, alunnoId, materiaId: materiaId || undefined, data: oggiIso(), motivo: 'Impreparato giustificato' }),
    });
    loadImpreparati();
  };

  const salva = async () => {
    setMsg('');
    if (!alunnoId || !materiaId) { setMsg('Seleziona alunno e materia'); return; }
    if (!argomento.trim()) { setMsg("Inserisci l'argomento"); return; }
    if (!userId) { setMsg('Identità non risolta: riapri la pagina dal registro.'); return; }
    // Collegamento obiettivo obbligatorio quando la materia/livello ne ha di configurati (DL-015).
    if (obiettivi.length > 0 && obiettiviSel.length === 0) { setMsg('Collega almeno un obiettivo di apprendimento'); return; }
    setSaving(true);
    const r = await fetch(`/api/primaria/valutazioni?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        alunnoId, sectionId, materiaId, tipoProva, modalita,
        dims: modalita === 'dimensioni' ? { autonomia, continuita, tipologia, risorse } : undefined,
        giudizioSintetico: modalita === 'sintetico' ? giudizioSintetico : undefined,
        giudizioTesto: giudizioTesto || undefined,
        annotazioneNumerica: annotazioneNumerica.trim() ? annotazioneNumerica.replace(',', '.') : undefined,
        argomento: argomento.trim(),
        obiettiviIds: obiettiviSel,
      }),
    });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) setMsg(d.error || 'Errore');
    else {
      setMsg('Valutazione salvata ✓');
      setGiudizioTesto('');
      setAnnotazioneNumerica('');
      setArgomento('');
      setObiettiviSel([]);
      loadRecenti();
    }
  };

  // Suggerimento (non vincolante) del giudizio a partire dall'annotazione numerica.
  const numAnnot = annotazioneNumerica.trim() === '' ? null : Number(annotazioneNumerica.replace(',', '.'));
  const giudizioSuggerito = numAnnot !== null && !Number.isNaN(numAnnot)
    ? suggerisciGiudizio(scalaValori, numAnnot)
    : null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Banner conformità O.M. 3/2025 (DR) */}
      <div className="flex items-start gap-2.5 rounded-xl border border-kidville-warn/25 bg-kidville-warn-soft px-3.5 py-3 md:col-span-2">
        <Lock size={16} className="mt-0.5 shrink-0 text-kidville-warn" />
        <span className="font-maven text-[12px] leading-snug text-kidville-warn">
          <strong>Voti numerici disabilitati alla primaria.</strong> La valutazione è espressa con giudizi descrittivi e sintetici (O.M. 3/2025). L&apos;eventuale annotazione numerica è un promemoria privato del docente.
        </span>
      </div>

      <div className="rounded-card bg-white p-5 shadow-sm">
        <h2 className="font-barlow text-lg font-bold text-kidville-ink mb-3 flex items-center gap-2">
          <Star size={18} className="text-kidville-yellow" /> Valutazione in itinere
        </h2>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <select value={alunnoId} onChange={(e) => setAlunnoId(e.target.value)} className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm">
            <option value="">Alunno…</option>
            {alunni.map((a) => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}
          </select>
          <select value={materiaId} onChange={(e) => setMateriaId(e.target.value)} className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm">
            <option value="">Materia…</option>
            {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
          </select>
        </div>

        {obiettivi.length > 0 && (
          <div className="mb-3 rounded-card border border-kidville-green/20 bg-kidville-cream/40 p-3">
            <label className="mb-1.5 block font-maven text-xs font-semibold text-kidville-ink">
              Obiettivi di apprendimento * <span className="font-normal text-kidville-muted">(collega ≥1)</span>
            </label>
            <div className="flex flex-col gap-1.5">
              {obiettivi.map((o) => (
                <label key={o.id} className="flex items-start gap-2 font-maven text-sm text-kidville-ink">
                  <input
                    type="checkbox"
                    checked={obiettiviSel.includes(o.id)}
                    onChange={() => toggleObiettivo(o.id)}
                    className="mt-0.5 accent-kidville-green"
                  />
                  <span>{o.codice ? <span className="text-kidville-muted">{o.codice} · </span> : null}{o.descrizione}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mb-3">
          <label className="block font-maven text-xs text-kidville-muted mb-1">Tipo prova</label>
          <div className="flex gap-1.5">
            {['orale', 'scritto', 'pratico'].map((t) => (
              <button key={t} onClick={() => setTipoProva(t)} className={`font-maven rounded-pill px-3 py-1 text-xs capitalize ${tipoProva === t ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-muted'}`}>{t}</button>
            ))}
          </div>
        </div>

        {/* Annotazione numerica privata (facoltativa) — strumento di lavoro del docente */}
        <div className="mb-3 rounded-card border border-kidville-warn/20 bg-kidville-warn-soft/60 p-3">
          <label className="mb-1 flex items-center gap-1.5 font-maven text-xs text-kidville-ink">
            <Lock size={12} className="text-kidville-warn" /> Annotazione numerica (privata, /10)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={0}
              max={10}
              step={0.5}
              value={annotazioneNumerica}
              onChange={(e) => setAnnotazioneNumerica(e.target.value)}
              placeholder="Es. 7.5"
              className="font-maven w-24 rounded-pill border border-kidville-line px-3 py-2 text-sm"
            />
            {giudizioSuggerito && (
              <div className="flex items-center gap-1.5">
                <span className="font-maven text-xs text-kidville-muted">Suggerito:</span>
                <span className="font-maven rounded-pill border border-kidville-warn/30 bg-white px-2.5 py-1 text-xs font-semibold text-kidville-warn">{giudizioSuggerito}</span>
                <button
                  type="button"
                  onClick={() => { setModalita('sintetico'); setGiudizioSintetico(giudizioSuggerito); }}
                  className="font-maven rounded-pill bg-kidville-green px-3 py-1 text-xs text-kidville-yellow"
                >
                  Usa
                </button>
              </div>
            )}
          </div>
          <p className="mt-1 font-maven text-[11px] text-kidville-muted">
            Solo per te: non visibile al genitore, non sul documento di valutazione. Suggerisce un giudizio, non lo genera.
          </p>
        </div>

        <div className="mb-3 flex gap-1.5">
          <button onClick={() => setModalita('dimensioni')} className={`font-maven rounded-pill px-3 py-1.5 text-xs ${modalita === 'dimensioni' ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-muted'}`}>Per dimensioni</button>
          <button onClick={() => setModalita('sintetico')} className={`font-maven rounded-pill px-3 py-1.5 text-xs ${modalita === 'sintetico' ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-muted'}`}>Giudizio sintetico</button>
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
              className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm"
            />
          </div>
        ) : (
          <div className="mb-3">
            <label className="block font-maven text-xs text-kidville-muted mb-1">Giudizio sintetico</label>
            <select value={giudizioSintetico} onChange={(e) => setGiudizioSintetico(e.target.value)} className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm">
              {scala.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        )}

        <div className="mb-3">
          <label className="block font-maven text-xs text-kidville-muted mb-1">Argomento *</label>
          <input
            type="text"
            value={argomento}
            onChange={(e) => setArgomento(e.target.value)}
            placeholder="Es. Le tabelline del 7, La comprensione del testo…"
            className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
          />
        </div>

        {msg && <p className={`font-maven text-sm mb-2 ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</p>}
        <button onClick={salva} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
          <Check size={15} /> {saving ? 'Salvataggio…' : 'Salva valutazione'}
        </button>
      </div>

      <div className="rounded-card bg-white p-5 shadow-sm">
        <h3 className="font-barlow text-base font-bold text-kidville-ink mb-3">Valutazioni recenti</h3>
        {!alunnoId || !materiaId ? (
          <p className="font-maven text-sm text-kidville-muted">Seleziona alunno e materia.</p>
        ) : (
          <ul className="divide-y divide-kidville-line">
            {recenti.map((v) => (
              <li key={v.id} className="py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-maven text-sm font-semibold text-kidville-green">
                    {v.giudizio_sintetico || (v.modalita === 'dimensioni' ? 'Per dimensioni' : '—')}
                  </span>
                  <span className="text-xs text-kidville-muted capitalize">{v.tipo}</span>
                  {v.annotazione_numerica !== null && v.annotazione_numerica !== undefined && (
                    <span
                      title="Annotazione privata del docente — non visibile al genitore"
                      className="font-maven rounded-pill border border-kidville-warn/20 bg-kidville-warn-soft px-2 py-0.5 text-[11px] text-kidville-warn"
                    >
                      ✎ {String(v.annotazione_numerica).replace('.', ',')}
                    </span>
                  )}
                  <span className="text-xs text-kidville-muted">{new Date(v.creato_il).toLocaleDateString('it-IT')}</span>
                </div>
                {v.argomento && <p className="font-maven text-xs text-kidville-ink mt-0.5"><span className="text-kidville-muted">Argomento:</span> {v.argomento}</p>}
                {v.giudizio_testo && <p className="font-maven text-xs text-kidville-muted mt-0.5">{v.giudizio_testo}</p>}
              </li>
            ))}
            {recenti.length === 0 && <li className="py-2 font-maven text-sm text-kidville-muted">Nessuna valutazione.</li>}
          </ul>
        )}
      </div>

      {/* Giustifiche didattiche (impreparato) di oggi */}
      <div className="rounded-card bg-white p-5 shadow-sm md:col-span-2">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-barlow text-base font-bold text-kidville-ink">Impreparati giustificati — oggi</h3>
          <button onClick={segnaImpreparato} className="font-maven rounded-pill bg-kidville-warn-soft px-3 py-1.5 text-xs text-kidville-warn">
            Segna impreparato (alunno selezionato)
          </button>
        </div>
        {impreparati.length === 0 ? (
          <p className="font-maven text-sm text-kidville-muted">Nessuna giustifica didattica per oggi.</p>
        ) : (
          <ul className="divide-y divide-kidville-line">
            {impreparati.map((g) => (
              <li key={g.id} className="flex items-center gap-2 py-2 font-maven text-sm">
                <span className="text-kidville-ink">{g.alunni?.cognome} {g.alunni?.nome}</span>
                <span className={`rounded-pill px-2 py-0.5 text-[11px] ${g.origine === 'genitore' ? 'bg-kidville-info-soft text-kidville-info' : 'bg-kidville-warn-soft text-kidville-warn'}`}>
                  {g.origine === 'genitore' ? 'dal genitore' : 'dal docente'}
                </span>
                {g.motivo && <span className="text-xs text-kidville-muted">— {g.motivo}</span>}
              </li>
            ))}
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
      <span className="font-maven text-sm text-kidville-ink">{label}</span>
      <div className="flex gap-1">
        {options.map(([lbl, val]) => {
          const active = String(val) === String(value) || lbl === value;
          return (
            <button key={lbl} onClick={() => onChange(val)} className={`font-maven rounded-pill px-2.5 py-1 text-xs ${active ? 'bg-kidville-green text-kidville-yellow' : 'bg-white text-kidville-muted border border-kidville-line'}`}>{lbl}</button>
          );
        })}
      </div>
    </div>
  );
}
