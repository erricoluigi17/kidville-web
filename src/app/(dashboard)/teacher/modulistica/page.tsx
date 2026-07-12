'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  FileText, Users, HeartPulse,
  AlertCircle, Upload, Check, Bell, Calendar
} from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';

interface StudentSemaforo {
  student_id: string;
  nome: string;
  cognome: string;
  status: 'green' | 'red';
  submission: unknown;
}

interface FormTemplate {
  id: string;
  title: string;
  description: string;
  target_classes: string[];
}

interface MedicalCertificate {
  id: string;
  alunno_id: string;
  nome_alunno: string;
  cognome_alunno: string;
  file_path: string;
  giorni_coperti?: string[];
  data_inizio?: string | null;
  data_fine?: string | null;
  stato?: string;
  nota_validazione?: string | null;
  note: string;
  creato_il: string;
}

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
export default function TeacherModulisticaPage() {
  const { userId: teacherId } = useSessionIdentity();
  const [className, setClassName] = useState('');
  const [availableSections, setAvailableSections] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'semaforo' | 'medici'>('semaforo');
  const [forms, setForms] = useState<FormTemplate[]>([]);
  const [selectedFormId, setSelectedFormId] = useState('');
  const [students, setStudents] = useState<StudentSemaforo[]>([]);
  const [medCerts, setMedCerts] = useState<MedicalCertificate[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Proxy Upload state
  const [showProxyModal, setShowProxyModal] = useState<StudentSemaforo | null>(null);
  const [proxyFileName, setProxyFileName] = useState('');
  const [proxyFile, setProxyFile] = useState<File | null>(null);
  const [proxyUploading, setProxyUploading] = useState(false);

  // Manage Covered Days state
  const [managingCert, setManagingCert] = useState<MedicalCertificate | null>(null);
  const [notaValidazione, setNotaValidazione] = useState('');

  // Notifications
  const [toast, setToast] = useState('');

  // Sezione reale del docente (niente 'Girasoli' hardcoded): da educator-sections.
  useEffect(() => {
    if (!teacherId) return;
    fetch(`/api/educator-sections?userId=${teacherId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const secs: string[] = d?.sectionNames ?? [];
        setAvailableSections(secs);
        if (secs.length > 0) setClassName((prev) => prev || secs[0]);
      })
      .catch(() => {});
  }, [teacherId]);

  const fetchForms = useCallback(async () => {
    if (!teacherId) return; // identità non risolta: lo spinner resta
    try {
      const res = await fetch('/api/admin/forms').catch(() => null);
      const data = await res?.json().catch(() => null);
      if (Array.isArray(data)) {
        // Filter forms assigned to this teacher's class
        const classForms = data.filter((f: FormTemplate) => f.target_classes?.includes(className));
        setForms(classForms);
        if (classForms.length > 0) {
          setSelectedFormId(classForms[0].id);
        }
      }
    } finally {
      setIsLoading(false);
    }
  }, [teacherId, className]);

  const fetchSemaforo = useCallback(async () => {
    if (!selectedFormId) return;
    try {
      const res = await fetch(`/api/teacher/modulistica?form_id=${selectedFormId}&class_name=${className}`).catch(() => null);
      const data = await res?.json().catch(() => null);
      if (Array.isArray(data)) setStudents(data);
    } finally {
      // errore di rete ⇒ stato invariato (nessun loading dedicato)
    }
  }, [selectedFormId, className]);

  const fetchMedicalCertificates = useCallback(async () => {
    if (!teacherId) return; // identità non risolta: lo spinner resta
    try {
      const res = await fetch(`/api/teacher/medical-certificates?class_name=${className}`, { headers: { 'x-user-id': teacherId } }).catch(() => null);
      const data = await res?.json().catch(() => null);
      const rows = Array.isArray(data) ? data : (data?.data ?? []);
      setMedCerts(rows);
    } finally {
      // errore di rete ⇒ stato invariato (nessun loading dedicato)
    }
  }, [teacherId, className]);

  useEffect(() => {
    fetchForms();
    fetchMedicalCertificates();
  }, [fetchForms, fetchMedicalCertificates]);

  useEffect(() => {
    fetchSemaforo();
  }, [fetchSemaforo]);

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Actions
  const handleSendReminder = (studentName: string) => {
    showToastMsg(`🔔 Sollecito inviato con successo a Genitore di ${studentName}!`);
  };

  const handleProxyUploadSubmit = async () => {
    if (!showProxyModal || !proxyFile || !teacherId) return;
    setProxyUploading(true);
    try {
      // Upload reale della scansione (multipart) — DL-032.
      const fd = new FormData();
      fd.append('file', proxyFile);
      fd.append('form_id', selectedFormId);
      fd.append('student_id', showProxyModal.student_id);
      const res = await fetch('/api/teacher/modulistica', {
        method: 'POST',
        headers: { 'x-user-id': teacherId },
        body: fd,
      });

      if (!res.ok) throw new Error('Errore proxy upload');

      showToastMsg(`✅ Autorizzazione cartacea registrata per ${showProxyModal.nome}!`);
      setShowProxyModal(null);
      setProxyFileName('');
      setProxyFile(null);
      fetchSemaforo();
    } catch {
      showToastMsg('❌ Errore durante l\'inserimento');
    } finally {
      setProxyUploading(false);
    }
  };

  // Manage days logic
  const handleOpenManager = (cert: MedicalCertificate) => {
    setManagingCert(cert);
    setNotaValidazione('');
  };

  const handleValidate = async (esito: 'validato' | 'rifiutato') => {
    if (!managingCert || !teacherId) return;
    try {
      const res = await fetch('/api/teacher/medical-certificates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': teacherId },
        body: JSON.stringify({
          id: managingCert.id,
          esito,
          nota_validazione: notaValidazione || undefined,
        }),
      });
      if (!res.ok) throw new Error('Errore validazione');
      showToastMsg(esito === 'validato' ? '✅ Certificato validato.' : '⛔ Certificato rifiutato.');
      setManagingCert(null);
      setNotaValidazione('');
      fetchMedicalCertificates();
    } catch {
      showToastMsg('❌ Errore durante la validazione');
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col px-4 pt-5">
      {/* Header verde (DR) */}
      <PageHeaderCard
        eyebrow="Documenti"
        title="Modulistica"
        subtitle={<>Consensi e certificati · Sezione {className || '…'}</>}
      />

      {availableSections.length > 1 && (
        <div className="mt-3 flex items-center gap-2">
          <label htmlFor="mod-section-select" className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-muted">Sezione:</label>
          <select
            id="mod-section-select"
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            className="rounded-xl border border-kidville-line bg-white px-3 py-1.5 font-barlow text-sm font-bold uppercase text-kidville-green shadow-sm focus:outline-none"
          >
            {availableSections.map((sec) => <option key={sec} value={sec}>{sec}</option>)}
          </select>
        </div>
      )}

      {/* Tabs */}
      <div className="mt-5 mb-6 flex gap-4 border-b border-kidville-line">
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide transition-colors flex items-center gap-1.5 ${activeTab === 'semaforo' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => setActiveTab('semaforo')}
        >
          <Users size={16} /> Semaforo Consensi
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide transition-colors flex items-center gap-1.5 ${activeTab === 'medici' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => setActiveTab('medici')}
        >
          <HeartPulse size={16} /> Certificati Medici
        </button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[40vh] gap-3">
          <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
          <p className="font-maven text-kidville-muted">Caricamento in corso...</p>
        </div>
      ) : (
        <>
          {/* TAB 1: Semaforo Autorizzazioni */}
          {activeTab === 'semaforo' && (
            <div className="space-y-6">
              {/* Form Selector */}
              <div className="bg-white p-4 rounded-xl shadow-sm border border-kidville-line flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <label className="font-maven font-semibold text-sm text-kidville-green">
                  Seleziona Modulo di Autorizzazione
                </label>
                <select
                  value={selectedFormId}
                  onChange={e => setSelectedFormId(e.target.value)}
                  className="border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-ink focus:outline-none bg-white max-w-sm"
                >
                  {forms.map(form => (
                    <option key={form.id} value={form.id}>{form.title}</option>
                  ))}
                </select>
              </div>

              {/* Semaforo Table */}
              <div className="bg-white rounded-card shadow-sm border border-kidville-line overflow-hidden">
                <div className="p-4 bg-kidville-cream border-b border-kidville-line flex items-center justify-between">
                  <h3 className="font-barlow font-bold text-base text-kidville-green uppercase tracking-wide">
                    Stato Approvazioni Classe
                  </h3>
                  <div className="flex items-center gap-3 text-xs font-maven font-semibold text-kidville-muted">
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-kidville-success rounded-full" /> {students.filter(s => s.status === 'green').length} Firmati</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-kidville-error rounded-full" /> {students.filter(s => s.status === 'red').length} Mancanti</span>
                  </div>
                </div>

                <div className="divide-y divide-kidville-line">
                  {students.map(student => (
                    <div key={student.student_id} className="p-4 flex items-center justify-between gap-4 hover:bg-kidville-cream/50 transition-colors">
                      <div className="flex items-center gap-3">
                        <span className={`w-3.5 h-3.5 rounded-full shadow-inner ${student.status === 'green' ? 'bg-kidville-success' : 'bg-kidville-error animate-pulse'}`} />
                        <span className="font-maven font-semibold text-sm text-kidville-ink">
                          {student.cognome} {student.nome}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        {student.status === 'red' ? (
                          <>
                            <button
                              onClick={() => handleSendReminder(student.nome)}
                              className="p-2 text-kidville-muted hover:text-kidville-info hover:bg-kidville-cream-dark rounded-lg transition-colors"
                              title="Invia Sollecito"
                            >
                              <Bell size={18} />
                            </button>
                            
                            <button
                              onClick={() => setShowProxyModal(student)}
                              className="flex items-center gap-1 px-3 py-1.5 bg-kidville-cream text-kidville-green border border-kidville-green/10 rounded-pill font-barlow font-bold text-xs uppercase hover:bg-kidville-green hover:text-kidville-yellow transition-colors"
                              title="Proxy Cartaceo"
                            >
                              <Upload size={13} /> Proxy
                            </button>
                          </>
                        ) : (
                          <span className="text-[10px] text-kidville-success bg-kidville-success-soft px-2.5 py-1 rounded-full font-bold uppercase tracking-wider flex items-center gap-1">
                            <Check size={12} /> FES OK
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: Certificati Medici */}
          {activeTab === 'medici' && (
            <div className="space-y-4">
              {medCerts.length === 0 ? (
                <div className="bg-white rounded-card p-10 text-center border border-kidville-line">
                  <HeartPulse className="mx-auto text-kidville-muted mb-3" size={48} />
                  <p className="font-maven text-kidville-muted">Nessun certificato medico caricato in classe.</p>
                </div>
              ) : (
                medCerts.map(cert => (
                  <div key={cert.id} className="bg-white rounded-card p-5 border border-kidville-line flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase">
                          {cert.cognome_alunno} {cert.nome_alunno}
                        </h3>
                        <span className="bg-kidville-success-soft text-kidville-success px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
                          Certificato Medico
                        </span>
                      </div>
                      <p className="font-maven text-xs text-kidville-muted mt-1">
                        Caricato il: {new Date(cert.creato_il).toLocaleDateString()}
                      </p>
                      {cert.note && (
                        <p className="font-maven text-xs text-kidville-ink mt-2 bg-kidville-cream p-2 rounded-lg italic">
                          &quot;{cert.note}&quot;
                        </p>
                      )}
                      
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                        {(cert.data_inizio || cert.data_fine) && (
                          <span className="bg-kidville-cream text-kidville-ink px-2.5 py-0.5 rounded-full text-[10px] font-semibold">
                            {cert.data_inizio ?? '—'} → {cert.data_fine ?? '—'}
                          </span>
                        )}
                        {cert.stato === 'validato' ? (
                          <span className="bg-kidville-success-soft text-kidville-success px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">Validato</span>
                        ) : cert.stato === 'rifiutato' ? (
                          <span className="bg-kidville-error-soft text-kidville-error px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">Rifiutato</span>
                        ) : (
                          <span className="text-kidville-warn bg-kidville-warn-soft px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 font-maven uppercase tracking-wider">
                            <AlertCircle size={10} /> In validazione
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => handleOpenManager(cert)}
                      className="flex items-center gap-1 px-3.5 py-2 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase text-xs tracking-wider shadow-sm hover:opacity-90 transition-opacity"
                    >
                      <Calendar size={14} /> Valida
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}

      {/* Modal: Proxy Upload Paper Form */}
      {showProxyModal && (
        <div className="fixed inset-0 bg-kidville-green/30 z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-sm rounded-card p-6 shadow-2xl text-center">
            <Upload className="text-kidville-green mx-auto mb-3" size={40} />
            <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide mb-1">Proxy Upload Cartaceo</h3>
            <p className="font-maven text-xs text-kidville-muted mb-6">
              Carica la scansione o la foto del modulo firmato a penna consegnato a mano dal genitore di <strong>{showProxyModal.nome}</strong>.
            </p>

            <div className="space-y-4">
              {proxyFile ? (
                <div className="flex items-center justify-between border-2 border-kidville-success/30 bg-kidville-success-soft text-kidville-success px-3 py-2 rounded-xl text-xs font-semibold select-none">
                  <span>📄 {proxyFileName}</span>
                  <button onClick={() => { setProxyFileName(''); setProxyFile(null); }} className="text-kidville-muted hover:text-kidville-error">✕</button>
                </div>
              ) : (
                <label className="w-full h-12 border-2 border-dashed border-kidville-line hover:border-kidville-green rounded-xl flex items-center justify-center gap-1.5 cursor-pointer text-xs font-semibold text-kidville-ink transition-colors">
                  <Upload size={14} /> Carica File
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0] ?? null;
                      setProxyFile(f);
                      setProxyFileName(f?.name ?? '');
                    }}
                  />
                </label>
              )}
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowProxyModal(null); setProxyFileName(''); setProxyFile(null); }}
                className="flex-1 h-11 font-maven text-sm rounded-pill border border-kidville-line text-kidville-muted hover:bg-kidville-cream transition-colors"
              >
                Annulla
              </button>
              <button
                disabled={!proxyFile || proxyUploading}
                onClick={handleProxyUploadSubmit}
                className="flex-1 h-11 font-barlow font-black uppercase tracking-wider rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 disabled:opacity-50 transition-all"
              >
                {proxyUploading ? 'Caricamento…' : 'Registra Firma'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Covered Days Calendar Checklist */}
      {managingCert && (
        <div className="fixed inset-0 bg-kidville-green/30 z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-md rounded-card p-6 shadow-2xl flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between border-b border-kidville-line pb-3 mb-4">
              <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">
                Validazione Certificato
              </h2>
              <button onClick={() => setManagingCert(null)} className="text-kidville-muted hover:text-kidville-ink">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              <p className="font-maven text-xs text-kidville-muted leading-relaxed">
                Certificato per <strong>{managingCert.cognome_alunno} {managingCert.nome_alunno}</strong>.
                Verifica il documento e il periodo dichiarato, poi valida o rifiuta.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-kidville-cream/50 rounded-xl px-3 py-2">
                  <p className="font-maven text-[10px] text-kidville-muted uppercase">Coperto dal</p>
                  <p className="font-maven text-sm font-bold text-kidville-green">{managingCert.data_inizio ?? '—'}</p>
                </div>
                <div className="bg-kidville-cream/50 rounded-xl px-3 py-2">
                  <p className="font-maven text-[10px] text-kidville-muted uppercase">al</p>
                  <p className="font-maven text-sm font-bold text-kidville-green">{managingCert.data_fine ?? '—'}</p>
                </div>
              </div>

              {managingCert.note && (
                <p className="font-maven text-xs text-kidville-ink"><span className="font-semibold">Note genitore:</span> {managingCert.note}</p>
              )}

              <a href={`/api/parent/medical-certificates/file?id=${managingCert.id}&userId=${teacherId ?? ''}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-bold text-kidville-green hover:underline">
                <FileText size={14} /> Apri documento
              </a>

              <div>
                <label className="block font-maven text-[10px] font-semibold text-kidville-muted mb-1">Nota di validazione (opzionale, obbligatoria per il rifiuto)</label>
                <textarea value={notaValidazione} onChange={e => setNotaValidazione(e.target.value)} rows={2}
                  className="w-full border border-kidville-line rounded-lg px-3 py-1.5 font-maven text-xs focus:outline-none focus:border-kidville-green resize-none"
                  placeholder="Es. Periodo corretto in 01/03–04/03" />
              </div>
            </div>

            <div className="flex gap-3 border-t border-kidville-line pt-4 mt-4 justify-end">
              <button
                onClick={() => handleValidate('rifiutato')}
                className="px-4 py-2 font-barlow font-bold uppercase tracking-wide rounded-pill border border-kidville-error/20 text-kidville-error text-sm hover:bg-kidville-error-soft"
              >
                Rifiuta
              </button>
              <button
                onClick={() => handleValidate('validato')}
                className="px-5 py-2.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90 transition-all shadow-md"
              >
                Valida
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-kidville-green text-white font-maven font-semibold px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-slideIn">
          {toast}
        </div>
      )}

      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        .animate-fadeIn {
          animation: fadeIn 0.2s ease-out forwards;
        }
        .animate-slideIn {
          animation: slideIn 0.3s ease-out forwards;
        }
      `}</style>
    </div>
  );
}
