'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { PenLine, BookOpen, Check, Paperclip, FileText, Image as ImageIcon } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { saveLocalRegistro, syncPendingRegistro } from '@/lib/offline/syncEngine';

interface Campanella { id: string; ordine: number; ora_inizio: string; ora_fine: string; tipo: string }
interface OrarioCella { campanella_id: string; materia_id: string | null; materie?: { nome: string } | null }
interface Firma { id: string; maestra_id: string; tipo_compresenza: string; argomento_proprio: string | null; compiti_propri: string | null; utenti?: { nome: string; cognome: string } | null }
interface Allegato { id: string; ambito: string; tipo: string; file_url: string; file_name: string | null }
interface Riga { id: string; ora_lezione: number; materia: string | null; argomento: string | null; compiti: string | null; materie?: { nome: string } | null; firme_docenti?: Firma[]; allegati_registro?: Allegato[] }
interface Materia { id: string; nome: string }
interface Alunno { id: string; nome: string; cognome: string }

function oggiIso() { return new Date().toISOString().slice(0, 10); }

export default function RegistroPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [data, setData] = useState(oggiIso());
  const [campanelle, setCampanelle] = useState<Campanella[]>([]);
  const [orarioCelle, setOrarioCelle] = useState<OrarioCella[]>([]);
  const [righe, setRighe] = useState<Riga[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ ordine: number; materiaId: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reg, ctx] = await Promise.all([
        fetch(`/api/primaria/registro?sectionId=${sectionId}&data=${data}&userId=${userId}`).then((r) => r.json()),
        fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`).then((r) => r.json()),
      ]);
      if (reg.success) {
        setCampanelle(reg.data.campanelle.filter((c: Campanella) => c.tipo === 'lezione'));
        setOrarioCelle(reg.data.orarioCelle);
        setRighe(reg.data.righe);
      }
      if (ctx.success) {
        setMaterie(ctx.data.materie ?? []);
        setAlunni(ctx.data.alunni ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [sectionId, data, userId]);

  useEffect(() => { load(); }, [load]);

  // Flush della coda registro al ritorno della connessione.
  useEffect(() => {
    const flush = () => syncPendingRegistro().then(load);
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [load]);

  const uploadAllegato = async (registroId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('registroId', registroId);
    fd.append('userId', userId);
    const r = await fetch(`/api/primaria/allegati?userId=${userId}`, { method: 'POST', headers: { 'x-user-id': userId }, body: fd });
    if (r.ok) load();
    else { const d = await r.json(); alert(d.error || 'Errore upload'); }
  };

  const rigaDi = (ordine: number) => righe.find((r) => r.ora_lezione === ordine);
  const plannedMateriaId = (camp: Campanella) =>
    orarioCelle.find((o) => o.campanella_id === camp.id)?.materia_id ?? '';

  return (
    <div className="rounded-card bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-barlow text-lg font-bold text-gray-800">Registro di classe</h2>
        <input
          type="date"
          value={data}
          onChange={(e) => setData(e.target.value)}
          className="font-maven rounded-pill border border-gray-200 px-3 py-1.5 text-sm"
        />
      </div>

      {loading ? (
        <p className="font-maven text-gray-400 text-sm">Caricamento…</p>
      ) : campanelle.length === 0 ? (
        <p className="font-maven text-gray-400 text-sm">Nessuna ora prevista dall&apos;orario in questo giorno.</p>
      ) : (
        <ul className="space-y-2">
          {campanelle.map((camp) => {
            const riga = rigaDi(camp.ordine);
            const plannedId = plannedMateriaId(camp);
            const plannedName = orarioCelle.find((o) => o.campanella_id === camp.id)?.materie?.nome;
            const firmata = (riga?.firme_docenti?.length ?? 0) > 0;
            return (
              <li key={camp.id} className="rounded-card border border-gray-100 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-barlow text-sm font-bold text-kidville-green">{camp.ordine}ª ora</span>
                      <span className="text-xs text-gray-400">{camp.ora_inizio?.slice(0, 5)}–{camp.ora_fine?.slice(0, 5)}</span>
                      <span className="font-maven text-sm text-gray-700">
                        · {riga?.materie?.nome || riga?.materia || plannedName || 'materia non assegnata'}
                      </span>
                    </div>
                    {riga?.argomento && <p className="mt-1 font-maven text-sm text-gray-600">{riga.argomento}</p>}
                    {riga?.compiti && (
                      <p className="mt-1 rounded bg-kidville-yellow/20 px-2 py-1 font-maven text-xs text-gray-700">
                        Compiti: {riga.compiti}
                      </p>
                    )}
                    {riga?.firme_docenti?.map((f) => (
                      <div key={f.id} className="mt-1 text-[11px] text-gray-400">
                        ✍ {f.utenti ? `${f.utenti.nome} ${f.utenti.cognome}` : '—'} ({f.tipo_compresenza})
                        {f.argomento_proprio && <span className="ml-1 text-purple-500">· attività individualizzata</span>}
                      </div>
                    ))}
                    {(riga?.allegati_registro?.length ?? 0) > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {riga!.allegati_registro!.map((a) => (
                          <a key={a.id} href={a.file_url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-pill bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-200">
                            {a.tipo === 'pdf' ? <FileText size={11} /> : <ImageIcon size={11} />}
                            {a.file_name || 'allegato'}
                          </a>
                        ))}
                      </div>
                    )}
                    {riga && (
                      <label className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-[11px] text-kidville-green">
                        <Paperclip size={11} /> Allega
                        <input
                          type="file"
                          accept="application/pdf,image/*"
                          className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAllegato(riga.id, f); }}
                        />
                      </label>
                    )}
                  </div>
                  <button
                    onClick={() => setModal({ ordine: camp.ordine, materiaId: plannedId })}
                    className={`font-maven inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs ${
                      firmata ? 'bg-kidville-cream text-kidville-green' : 'bg-kidville-green text-kidville-yellow'
                    }`}
                  >
                    {firmata ? <Check size={13} /> : <PenLine size={13} />}
                    {firmata ? 'Modifica' : 'Firma'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {modal && (
        <FirmaModal
          sectionId={sectionId}
          userId={userId}
          data={data}
          ordine={modal.ordine}
          materie={materie}
          alunni={alunni}
          defaultMateriaId={modal.materiaId}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}

function FirmaModal({
  sectionId, userId, data, ordine, materie, alunni, defaultMateriaId, onClose, onSaved,
}: {
  sectionId: string; userId: string; data: string; ordine: number;
  materie: Materia[]; alunni: Alunno[]; defaultMateriaId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [materiaId, setMateriaId] = useState(defaultMateriaId);
  const [tipo, setTipo] = useState<'principale' | 'compresenza' | 'cofirma' | 'sostegno'>('principale');
  const [argomento, setArgomento] = useState('');
  const [compiti, setCompiti] = useState('');
  const [argomentoProprio, setArgomentoProprio] = useState('');
  const [compitiPropri, setCompitiPropri] = useState('');
  const [destinatari, setDestinatari] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const indipendente = tipo === 'sostegno' && destinatari.length > 0;

  const toggleDest = (id: string) =>
    setDestinatari((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const salva = async () => {
    setSaving(true);
    setError('');
    // Offline-first: senza rete, accoda la firma base (no destinatari) e chiudi.
    if (typeof navigator !== 'undefined' && !navigator.onLine && tipo !== 'sostegno') {
      await saveLocalRegistro({
        id: crypto.randomUUID(), section_id: sectionId, data, ora_lezione: ordine,
        materia_id: materiaId || null, argomento, compiti, tipo_compresenza: tipo,
        creato_il: new Date().toISOString(),
      });
      setSaving(false);
      onSaved();
      return;
    }
    const r = await fetch(`/api/primaria/registro?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        sectionId, data, oraLezione: ordine, materiaId: materiaId || null,
        argomento, compiti, tipoCompresenza: tipo,
        argomentoProprio, compitiPropri, destinatariIds: tipo === 'sostegno' ? destinatari : [],
      }),
    });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) setError(d.error || 'Errore');
    else onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-card bg-white shadow-xl">
        <div className="flex items-center gap-2 rounded-t-card bg-kidville-green p-4 text-kidville-yellow">
          <BookOpen size={18} />
          <h3 className="font-barlow text-lg font-bold">{ordine}ª ora — Firma lezione</h3>
        </div>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4">
          {error && <div className="rounded-card bg-kidville-error/10 text-kidville-error px-3 py-2 text-sm font-maven">{error}</div>}

          <div>
            <label className="block font-maven text-xs text-gray-500">Materia</label>
            <select value={materiaId} onChange={(e) => setMateriaId(e.target.value)} className="font-maven w-full rounded-pill border border-gray-200 px-3 py-2 text-sm">
              <option value="">— seleziona —</option>
              {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
            </select>
          </div>

          <div>
            <label className="block font-maven text-xs text-gray-500">Tipo firma</label>
            <select value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)} className="font-maven w-full rounded-pill border border-gray-200 px-3 py-2 text-sm">
              <option value="principale">Principale</option>
              <option value="compresenza">Compresenza</option>
              <option value="cofirma">Cofirma (condivido l&apos;argomento)</option>
              <option value="sostegno">Sostegno (attività individualizzata)</option>
            </select>
          </div>

          {!indipendente ? (
            <>
              <div>
                <label className="block font-maven text-xs text-gray-500">Argomento svolto</label>
                <textarea value={argomento} onChange={(e) => setArgomento(e.target.value)} rows={2} className="font-maven w-full rounded-card border border-gray-200 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block font-maven text-xs text-gray-500">Compiti</label>
                <textarea value={compiti} onChange={(e) => setCompiti(e.target.value)} rows={2} className="font-maven w-full rounded-card border border-gray-200 px-3 py-2 text-sm" />
              </div>
            </>
          ) : null}

          {tipo === 'sostegno' && (
            <div className="rounded-card bg-purple-50 p-3">
              <p className="mb-2 font-maven text-xs text-purple-700">
                Attività individualizzata: argomento/compiti visibili solo alle famiglie degli alunni selezionati.
              </p>
              <div className="mb-2 max-h-32 overflow-y-auto rounded bg-white p-2">
                {alunni.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 py-0.5 font-maven text-sm">
                    <input type="checkbox" checked={destinatari.includes(a.id)} onChange={() => toggleDest(a.id)} />
                    {a.cognome} {a.nome}
                  </label>
                ))}
              </div>
              <label className="block font-maven text-xs text-gray-500">Argomento (per i destinatari)</label>
              <textarea value={argomentoProprio} onChange={(e) => setArgomentoProprio(e.target.value)} rows={2} className="mb-2 font-maven w-full rounded-card border border-gray-200 px-3 py-2 text-sm" />
              <label className="block font-maven text-xs text-gray-500">Compiti (per i destinatari)</label>
              <textarea value={compitiPropri} onChange={(e) => setCompitiPropri(e.target.value)} rows={2} className="font-maven w-full rounded-card border border-gray-200 px-3 py-2 text-sm" />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 p-4">
          <button onClick={onClose} className="font-maven rounded-pill bg-kidville-cream px-4 py-2 text-sm text-gray-600">Annulla</button>
          <button onClick={salva} disabled={saving} className="font-maven rounded-pill bg-kidville-green px-4 py-2 text-sm text-kidville-yellow disabled:opacity-50">
            {saving ? 'Salvataggio…' : 'Firma'}
          </button>
        </div>
      </div>
    </div>
  );
}
