'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { GraduationCap, Check, Lock, Download, Upload, FileDown, FileText, Send } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

interface Alunno { id: string; nome: string; cognome: string }
interface Materia { id: string; nome: string; e_civica: boolean }
interface Periodo { id: string; nome: string; anno_scolastico: string }
interface Giudizio { alunno_id: string; materia_id: string; giudizio_sintetico: string | null }
interface Comportamento { alunno_id: string; giudizio_testo: string | null; giudizio_globale: string | null }
interface Scrutinio { id: string; stato: 'aperto' | 'chiuso'; chiuso_il: string | null; pubblicato?: boolean }

export default function ScrutinioPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [periodi, setPeriodi] = useState<Periodo[]>([]);
  const [periodoId, setPeriodoId] = useState('');
  const [isDirigente, setIsDirigente] = useState(false);
  const [isStaff, setIsStaff] = useState(false);

  const [scrutinio, setScrutinio] = useState<Scrutinio | null>(null);
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [mieMaterieIds, setMieMaterieIds] = useState<string[]>([]);
  const [scala, setScala] = useState<string[]>([]);
  // giudizi[alunnoId][materiaId] = etichetta
  const [giudizi, setGiudizi] = useState<Record<string, Record<string, string>>>({});
  const [comp, setComp] = useState<Record<string, { testo: string; globale: string }>>({});
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const chiuso = scrutinio?.stato === 'chiuso';
  const pubblicato = !!scrutinio?.pubblicato;

  useEffect(() => {
    fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setIsDirigente(!!d.data.isDirigente);
          setIsStaff(['admin', 'coordinator', 'segreteria'].includes(d.data.ruolo));
        }
      })
      .catch(() => {});
  }, [userId]);

  useEffect(() => {
    fetch(`/api/primaria/scrutinio?sectionId=${sectionId}&userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data.periodi) {
          setPeriodi(d.data.periodi);
          if (d.data.periodi.length && !periodoId) setPeriodoId(d.data.periodi[0].id);
        }
      })
      .catch(() => {});
  }, [sectionId, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadScrutinio = useCallback(async () => {
    if (!periodoId) return;
    try {
      const r = await fetch(`/api/primaria/scrutinio?sectionId=${sectionId}&periodoId=${periodoId}&userId=${userId}`);
      const d = await r.json();
      if (!d.success) {
        setMsg(d.error || 'Errore');
      } else {
        setScrutinio(d.data.scrutinio);
        setAlunni(d.data.alunni);
        setMaterie(d.data.materie);
        setMieMaterieIds(d.data.mieMaterieIds);
        setScala(d.data.scala);
        const g: Record<string, Record<string, string>> = {};
        (d.data.giudizi as Giudizio[]).forEach((x) => {
          g[x.alunno_id] = g[x.alunno_id] || {};
          g[x.alunno_id][x.materia_id] = x.giudizio_sintetico || '';
        });
        setGiudizi(g);
        const c: Record<string, { testo: string; globale: string }> = {};
        (d.data.comportamento as Comportamento[]).forEach((x) => {
          c[x.alunno_id] = { testo: x.giudizio_testo || '', globale: x.giudizio_globale || '' };
        });
        setComp(c);
      }
    } finally {
      // nessuno stato di caricamento da azzerare
    }
  }, [periodoId, sectionId, userId]);

  useEffect(() => { loadScrutinio(); }, [loadScrutinio]);

  const canEdit = (materiaId: string) => !chiuso && (isDirigente || mieMaterieIds.includes(materiaId));

  const setGiudizio = (alunnoId: string, materiaId: string, val: string) => {
    setGiudizi((prev) => ({ ...prev, [alunnoId]: { ...(prev[alunnoId] || {}), [materiaId]: val } }));
  };

  const salvaGiudizi = async () => {
    if (!scrutinio || !userId) return;
    setSaving(true); setMsg('');
    const payload: { alunnoId: string; materiaId: string; giudizioSintetico: string }[] = [];
    alunni.forEach((a) => {
      materie.forEach((m) => {
        if (!canEdit(m.id)) return;
        const v = giudizi[a.id]?.[m.id];
        if (v) payload.push({ alunnoId: a.id, materiaId: m.id, giudizioSintetico: v });
      });
    });
    const r = await fetch(`/api/primaria/scrutinio?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scrutinioId: scrutinio.id, giudizi: payload }),
    });
    const d = await r.json();
    setSaving(false);
    setMsg(r.ok ? 'Giudizi salvati ✓' : (d.error || 'Errore'));
  };

  const salvaComportamento = async () => {
    if (!scrutinio || !userId) return;
    setSaving(true); setMsg('');
    const payload = alunni.map((a) => ({
      alunnoId: a.id,
      giudizioTesto: comp[a.id]?.testo || null,
      giudizioGlobale: comp[a.id]?.globale || null,
    }));
    const r = await fetch(`/api/primaria/scrutinio?userId=${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scrutinioId: scrutinio.id, comportamento: payload }),
    });
    const d = await r.json();
    setSaving(false);
    setMsg(r.ok ? 'Comportamento salvato ✓' : (d.error || 'Errore'));
  };

  const chiudiScrutinio = async () => {
    if (!scrutinio || !userId) return;
    if (!confirm('Chiudere lo scrutinio? Dopo la chiusura i giudizi non saranno più modificabili. Potrai poi generare le pagelle e pubblicarle ai genitori.')) return;
    setSaving(true); setMsg('');
    const r = await fetch(`/api/primaria/scrutinio/chiudi?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scrutinioId: scrutinio.id }),
    });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) {
      if (d.incompleto) setMsg(`Scrutinio incompleto: mancano ${d.mancanti.length} giudizi.`);
      else setMsg(d.error || 'Errore');
      return;
    }
    setMsg('Scrutinio chiuso ✓');
    loadScrutinio();
  };

  const scaricaPagella = (alunnoId: string) => {
    if (!scrutinio) return;
    window.open(`/api/primaria/pagella?scrutinioId=${scrutinio.id}&alunnoId=${alunnoId}&persist=1&userId=${userId}`, '_blank');
  };

  // --- CSV: template + import massivo dei giudizi ---
  // M9.4: xlsx caricato on-demand negli handler (fuori dal bundle della pagina).
  const scaricaTemplate = async () => {
    const XLSX = await import('xlsx');
    const editabili = materie.filter((m) => canEdit(m.id));
    const righe: Record<string, string>[] = [];
    alunni.forEach((a) => {
      (editabili.length ? editabili : materie).forEach((m) => {
        righe.push({ alunno: `${a.cognome} ${a.nome}`, materia: m.nome, giudizio: giudizi[a.id]?.[m.id] || '' });
      });
    });
    const ws = XLSX.utils.json_to_sheet(righe.length ? righe : [{ alunno: '', materia: '', giudizio: '' }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'giudizi');
    XLSX.writeFile(wb, `scrutinio-giudizi-template.csv`, { bookType: 'csv' });
  };

  const importaCsv = async (file: File) => {
    if (!scrutinio || !userId) return;
    setSaving(true); setMsg('');
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
      const righe = json.map((r) => ({
        alunno: r.alunno ?? r.Alunno ?? r.ALUNNO,
        materia: r.materia ?? r.Materia ?? r.MATERIA,
        giudizioSintetico: r.giudizio ?? r.Giudizio ?? r.giudizio_sintetico ?? r.GIUDIZIO,
      })).filter((r) => r.alunno && r.materia && r.giudizioSintetico);
      const res = await fetch(`/api/primaria/scrutinio/import?userId=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ scrutinioId: scrutinio.id, righe }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d.error || 'Errore import'); }
      else {
        const errCount = (d.errori ?? []).length;
        setMsg(`Importate ${d.importate} righe${errCount ? `, ${errCount} con errori` : ''} ✓`);
        loadScrutinio();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Errore lettura file');
    } finally {
      setSaving(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // --- Dirigente: generazione batch + pubblicazione ai genitori ---
  const generaTutte = async () => {
    if (!scrutinio || !userId) return;
    setSaving(true); setMsg('');
    const r = await fetch(`/api/primaria/pagella/batch?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scrutinioId: scrutinio.id }),
    });
    const d = await r.json();
    setSaving(false);
    setMsg(r.ok ? `Generate ${d.generate}/${d.totale} pagelle ✓` : (d.error || 'Errore'));
  };

  const togglePubblica = async () => {
    if (!scrutinio || !userId) return;
    const nuovo = !pubblicato;
    if (nuovo && !confirm('Pubblicare i voti? I genitori potranno vedere le pagelle e riceveranno una notifica.')) return;
    setSaving(true); setMsg('');
    const r = await fetch(`/api/primaria/scrutinio/pubblica?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scrutinioId: scrutinio.id, pubblicato: nuovo }),
    });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) { setMsg(d.error || 'Errore'); return; }
    setMsg(nuovo ? 'Voti pubblicati ✓' : 'Pubblicazione revocata ✓');
    loadScrutinio();
  };

  return (
    <div className="space-y-4">
      {/* Banner conformità O.M. 3/2025 (DR) */}
      <div className="flex items-start gap-2.5 rounded-xl border border-kidville-warn/25 bg-kidville-warn-soft px-3.5 py-3">
        <FileText size={16} className="mt-0.5 shrink-0 text-kidville-warn" />
        <span className="font-maven text-[12px] leading-snug text-kidville-warn">
          <strong>Documento ufficiale.</strong> Solo giudizi sintetici testuali — nessun voto numerico, nessuna media. Chiusura e pubblicazione sono riservate al Dirigente.
        </span>
      </div>

      <div className="rounded-card bg-white p-5 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-barlow text-lg font-bold text-kidville-ink flex items-center gap-2">
            <GraduationCap size={18} className="text-kidville-green" /> Scrutinio
          </h2>
          <select
            value={periodoId}
            onChange={(e) => setPeriodoId(e.target.value)}
            className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm"
          >
            <option value="">Periodo…</option>
            {periodi.map((p) => <option key={p.id} value={p.id}>{p.nome} ({p.anno_scolastico})</option>)}
          </select>
        </div>

        {periodi.length === 0 && (
          <p className="font-maven text-sm text-kidville-warn">
            Nessun periodo di scrutinio configurato.{' '}
            {isStaff
              ? 'Puoi configurarlo da Impostazioni → Didattica primaria (periodi di scrutinio).'
              : 'Chiedi alla segreteria di crearne uno.'}
          </p>
        )}

        {scrutinio && (
          <div className={`mb-3 inline-flex items-center gap-2 rounded-pill px-3 py-1 text-xs font-maven ${chiuso ? 'bg-kidville-neutral-soft text-kidville-ink' : 'bg-kidville-yellow-soft text-kidville-yellow-dark'}`}>
            {chiuso ? <Lock size={13} /> : null}
            {chiuso ? `Chiuso il ${scrutinio.chiuso_il ? new Date(scrutinio.chiuso_il).toLocaleDateString('it-IT') : ''}` : 'Aperto — proposta giudizi'}
          </div>
        )}

        {msg && <p className={`font-maven text-sm mb-2 ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</p>}

        {scrutinio && alunni.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white px-2 py-2 text-left font-maven text-xs text-kidville-muted">Alunno</th>
                  {materie.map((m) => (
                    <th key={m.id} className="px-2 py-2 text-left font-maven text-xs text-kidville-muted whitespace-nowrap">
                      {m.nome}{m.e_civica ? ' *' : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {alunni.map((a) => (
                  <tr key={a.id} className="border-t border-kidville-line">
                    <td className="sticky left-0 bg-white px-2 py-1.5 font-maven text-kidville-ink whitespace-nowrap">{a.cognome} {a.nome}</td>
                    {materie.map((m) => (
                      <td key={m.id} className="px-1 py-1.5">
                        <select
                          value={giudizi[a.id]?.[m.id] || ''}
                          disabled={!canEdit(m.id)}
                          onChange={(e) => setGiudizio(a.id, m.id, e.target.value)}
                          className="font-maven rounded-lg border border-kidville-line px-1.5 py-1 text-xs disabled:bg-kidville-cream disabled:text-kidville-muted"
                        >
                          <option value="">—</option>
                          {scala.map((g) => <option key={g} value={g}>{g}</option>)}
                        </select>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {scrutinio && !chiuso && alunni.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={salvaGiudizi} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
              <Check size={15} /> Salva giudizi
            </button>
            <button onClick={scaricaTemplate} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-4 py-2 text-sm text-kidville-green">
              <FileDown size={15} /> Template CSV
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-4 py-2 text-sm text-kidville-green disabled:opacity-50">
              <Upload size={15} /> Importa CSV
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importaCsv(f); }}
            />
          </div>
        )}
      </div>

      {scrutinio && alunni.length > 0 && (
        <div className="rounded-card bg-white p-5 shadow-sm">
          <h3 className="font-barlow text-base font-bold text-kidville-ink mb-3">Comportamento e giudizio globale</h3>
          <div className="space-y-3">
            {alunni.map((a) => (
              <div key={a.id} className="rounded-card bg-kidville-cream/30 p-3">
                <p className="font-maven text-sm font-semibold text-kidville-ink mb-1.5">{a.cognome} {a.nome}</p>
                <div className="grid gap-2 md:grid-cols-2">
                  <textarea
                    value={comp[a.id]?.testo || ''}
                    disabled={chiuso}
                    onChange={(e) => setComp((p) => ({ ...p, [a.id]: { testo: e.target.value, globale: p[a.id]?.globale || '' } }))}
                    rows={2}
                    placeholder="Giudizio del comportamento"
                    className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm disabled:bg-kidville-cream"
                  />
                  <textarea
                    value={comp[a.id]?.globale || ''}
                    disabled={chiuso}
                    onChange={(e) => setComp((p) => ({ ...p, [a.id]: { testo: p[a.id]?.testo || '', globale: e.target.value } }))}
                    rows={2}
                    placeholder="Giudizio globale (facoltativo)"
                    className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm disabled:bg-kidville-cream"
                  />
                </div>
                {chiuso && (
                  <button onClick={() => scaricaPagella(a.id)} className="mt-2 font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green">
                    <Download size={13} /> Pagella PDF
                  </button>
                )}
              </div>
            ))}
          </div>

          {!chiuso && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={salvaComportamento} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
                <Check size={15} /> Salva comportamento
              </button>
              {isDirigente && (
                <button onClick={chiudiScrutinio} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-warn px-5 py-2 text-sm text-white disabled:opacity-50">
                  <Lock size={15} /> Chiudi scrutinio
                </button>
              )}
            </div>
          )}

          {chiuso && isDirigente && (
            <div className="mt-4 border-t border-kidville-line pt-4">
              <div className="mb-2 flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-xs font-maven ${pubblicato ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-neutral-soft text-kidville-ink'}`}>
                  {pubblicato ? 'Pubblicato ai genitori' : 'Non pubblicato (visibile solo allo staff)'}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={generaTutte} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
                  <FileText size={15} /> Genera pagelle (tutte)
                </button>
                <button onClick={togglePubblica} disabled={saving} className={`font-maven inline-flex items-center gap-1.5 rounded-pill px-5 py-2 text-sm text-white disabled:opacity-50 ${pubblicato ? 'bg-kidville-neutral' : 'bg-kidville-green'}`}>
                  <Send size={15} /> {pubblicato ? 'Revoca pubblicazione' : 'Pubblica ai genitori'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
