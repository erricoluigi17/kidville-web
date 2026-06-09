'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { FolderLock, Upload, Download, ShieldAlert, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

interface Alunno { id: string; nome: string; cognome: string }
interface Documento {
  id: string; document_type: string; descrizione: string | null; file_name: string | null; expiry_date: string | null; created_at: string;
}
interface PagellaVoce {
  scrutinioId: string; annoScolastico: string; periodoNome: string;
  dataChiusura: string | null; dataPubblicazione: string | null;
}
interface AnnoPagelle { annoScolastico: string; pagelle: PagellaVoce[] }

const TIPI: { v: string; l: string }[] = [
  { v: 'diagnosi', l: 'Diagnosi funzionale' },
  { v: 'pei', l: 'PEI' },
  { v: 'pdp', l: 'PDP' },
  { v: '104', l: 'Certificazione L.104' },
];

export default function FascicoloPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [alunnoId, setAlunnoId] = useState('');
  const [docs, setDocs] = useState<Documento[]>([]);
  const [denied, setDenied] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState('pei');
  const [descrizione, setDescrizione] = useState('');
  const [expiry, setExpiry] = useState('');
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Pagelle
  const [anniPagelle, setAnniPagelle] = useState<AnnoPagelle[]>([]);
  const [anniAperti, setAnniAperti] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) { setAlunni(d.data.alunni ?? []); setApiError(null); }
        else setApiError(d.error ?? 'Impossibile caricare gli alunni');
      });
  }, [sectionId, userId]);

  const loadDocs = useCallback(async () => {
    if (!alunnoId) { setDocs([]); setDenied(false); setAnniPagelle([]); return; }
    const r = await fetch(`/api/primaria/fascicolo?alunnoId=${alunnoId}&userId=${userId}`);
    if (r.status === 403) { setDenied(true); setDocs([]); return; }
    setDenied(false);
    const d = await r.json();
    if (d.success) setDocs(d.data);

    // Carica anche le pagelle
    const rp = await fetch(`/api/primaria/fascicolo/pagelle?alunnoId=${alunnoId}&userId=${userId}`);
    const dp = await rp.json();
    if (dp.success) {
      setAnniPagelle(dp.data ?? []);
      // Apri automaticamente l'anno più recente
      if (dp.data?.length > 0) setAnniAperti(new Set([dp.data[0].annoScolastico]));
    }
  }, [alunnoId, userId]);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  const toggleAnno = (anno: string) => setAnniAperti((prev) => {
    const next = new Set(prev);
    if (next.has(anno)) next.delete(anno); else next.add(anno);
    return next;
  });

  const carica = async () => {
    setMsg('');
    const file = fileRef.current?.files?.[0];
    if (!alunnoId) { setMsg('Seleziona un alunno'); return; }
    if (!file) { setMsg('Seleziona un file'); return; }
    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('alunnoId', alunnoId);
    fd.append('documentType', documentType);
    if (descrizione) fd.append('descrizione', descrizione);
    if (expiry) fd.append('expiryDate', expiry);
    fd.append('userId', userId);
    const r = await fetch(`/api/primaria/fascicolo?userId=${userId}`, { method: 'POST', headers: { 'x-user-id': userId }, body: fd });
    const d = await r.json();
    setUploading(false);
    if (!r.ok) { setMsg(d.error || 'Errore'); return; }
    setMsg('Documento caricato ✓');
    setDescrizione(''); setExpiry('');
    if (fileRef.current) fileRef.current.value = '';
    loadDocs();
  };

  const scarica = async (documentoId: string) => {
    const r = await fetch(`/api/primaria/fascicolo/file?documentoId=${documentoId}&userId=${userId}`);
    const d = await r.json();
    if (r.ok && d.data?.url) window.open(d.data.url, '_blank');
    else setMsg(d.error || 'Download non riuscito');
  };

  const scaricaPagella = (scrutinioId: string) => {
    window.open(`/api/primaria/pagella?scrutinioId=${scrutinioId}&alunnoId=${alunnoId}&userId=${userId}`, '_blank');
  };

  return (
    <div className="space-y-4">
      <div className="rounded-card bg-white p-5 shadow-sm">
        <h2 className="font-barlow text-lg font-bold text-gray-800 mb-1 flex items-center gap-2">
          <FolderLock size={18} className="text-kidville-green" /> Fascicolo personale
        </h2>
        <p className="font-maven text-xs text-gray-400 mb-3">
          Documenti riservati (PEI/PDP/sanitari) e pagelle. Accesso limitato ai docenti contitolari e alla dirigenza; ogni accesso è tracciato.
        </p>

        {apiError && (
          <div className="mb-3 flex items-center gap-2 rounded-card bg-red-50 px-3 py-2 font-maven text-sm text-red-600">
            <ShieldAlert size={14} /> {apiError}
          </div>
        )}

        <select value={alunnoId} onChange={(e) => setAlunnoId(e.target.value)} className="font-maven rounded-pill border border-gray-200 px-3 py-2 text-sm">
          <option value="">Alunno…</option>
          {alunni.map((a) => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}
        </select>

        {denied && (
          <div className="mt-3 flex items-center gap-2 rounded-card bg-red-50 px-3 py-2 font-maven text-sm text-red-600">
            <ShieldAlert size={15} /> Non sei autorizzato ad accedere al fascicolo di questo alunno.
          </div>
        )}
      </div>

      {alunnoId && !denied && (
        <>
          {/* ── Pagelle raggruppate per anno scolastico ─────────── */}
          {anniPagelle.length > 0 && (
            <div className="rounded-card bg-white p-5 shadow-sm">
              <h3 className="font-barlow text-base font-bold text-gray-800 mb-3 flex items-center gap-2">
                <FileText size={16} className="text-kidville-green" /> Pagelle
              </h3>
              <div className="space-y-2">
                {anniPagelle.map((anno) => (
                  <div key={anno.annoScolastico} className="rounded-card border border-gray-100">
                    <button
                      onClick={() => toggleAnno(anno.annoScolastico)}
                      className="flex w-full items-center justify-between px-4 py-3 font-maven text-sm font-semibold text-gray-700"
                    >
                      <span>A.S. {anno.annoScolastico}</span>
                      {anniAperti.has(anno.annoScolastico)
                        ? <ChevronDown size={15} className="text-gray-400" />
                        : <ChevronRight size={15} className="text-gray-400" />}
                    </button>
                    {anniAperti.has(anno.annoScolastico) && (
                      <ul className="divide-y divide-gray-50 border-t border-gray-100">
                        {anno.pagelle.map((p) => (
                          <li key={p.scrutinioId} className="flex items-center justify-between gap-2 px-4 py-2.5">
                            <div>
                              <p className="font-maven text-sm text-gray-800">{p.periodoNome}</p>
                              <p className="font-maven text-xs text-gray-400">
                                Pubblicata il {p.dataPubblicazione ? new Date(p.dataPubblicazione).toLocaleDateString('it-IT') : '—'}
                              </p>
                            </div>
                            <button
                              onClick={() => scaricaPagella(p.scrutinioId)}
                              className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green"
                            >
                              <Download size={13} /> Apri PDF
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Carica documento ────────────────────────────────── */}
          <div className="rounded-card bg-white p-5 shadow-sm">
            <h3 className="font-barlow text-base font-bold text-gray-800 mb-3">Carica documento</h3>
            <div className="grid gap-2 md:grid-cols-2">
              <select value={documentType} onChange={(e) => setDocumentType(e.target.value)} className="font-maven rounded-pill border border-gray-200 px-3 py-2 text-sm">
                {TIPI.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
              </select>
              <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="font-maven rounded-pill border border-gray-200 px-3 py-2 text-sm" placeholder="Scadenza" />
            </div>
            <input value={descrizione} onChange={(e) => setDescrizione(e.target.value)} placeholder="Descrizione (facoltativa)" className="font-maven mt-2 w-full rounded-pill border border-gray-200 px-3 py-2 text-sm" />
            <input ref={fileRef} type="file" accept="application/pdf,image/*" className="font-maven mt-2 block w-full text-sm text-gray-600 file:mr-3 file:rounded-pill file:border-0 file:bg-kidville-green/10 file:px-4 file:py-1.5 file:text-kidville-green" />
            {msg && <p className={`font-maven text-sm mt-2 ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</p>}
            <button onClick={carica} disabled={uploading} className="mt-3 font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
              <Upload size={15} /> {uploading ? 'Caricamento…' : 'Carica'}
            </button>
          </div>

          {/* ── Documenti ufficiali (PEI/PDP/ecc.) ───────────────── */}
          <div className="rounded-card bg-white p-5 shadow-sm">
            <h3 className="font-barlow text-base font-bold text-gray-800 mb-3">Documenti ufficiali</h3>
            {docs.length === 0 ? (
              <p className="font-maven text-sm text-gray-400">Nessun documento nel fascicolo.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {docs.map((doc) => (
                  <li key={doc.id} className="flex items-center justify-between gap-2 py-2.5">
                    <div>
                      <p className="font-maven text-sm font-semibold text-gray-800">
                        <span className="rounded-pill bg-kidville-green/10 px-2 py-0.5 text-[11px] text-kidville-green uppercase">{doc.document_type}</span>
                        {' '}{doc.file_name || doc.descrizione || 'Documento'}
                      </p>
                      <p className="font-maven text-xs text-gray-400">
                        {new Date(doc.created_at).toLocaleDateString('it-IT')}
                        {doc.expiry_date ? ` · scade ${new Date(doc.expiry_date).toLocaleDateString('it-IT')}` : ''}
                      </p>
                    </div>
                    <button onClick={() => scarica(doc.id)} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green">
                      <Download size={13} /> Apri
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
