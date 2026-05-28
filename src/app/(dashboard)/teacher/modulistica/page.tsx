'use client';

import { useState, useEffect } from 'react';
import { 
  FileText, Users, Clock, ShieldCheck, HeartPulse, 
  AlertCircle, Upload, Check, Bell, Calendar, Eye
} from 'lucide-react';

const CLASS_NAME = 'Girasoli';
const TEACHER_ID = '22222222-2222-2222-2222-222222222222'; // Maestra Anna

interface StudentSemaforo {
  student_id: string;
  nome: string;
  cognome: string;
  status: 'green' | 'red';
  submission: any | null;
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
  giorni_coperti: string[];
  note: string;
  creato_il: string;
}

export default function TeacherModulisticaPage() {
  const [activeTab, setActiveTab] = useState<'semaforo' | 'medici'>('semaforo');
  const [forms, setForms] = useState<FormTemplate[]>([]);
  const [selectedFormId, setSelectedFormId] = useState('');
  const [students, setStudents] = useState<StudentSemaforo[]>([]);
  const [medCerts, setMedCerts] = useState<MedicalCertificate[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Proxy Upload state
  const [showProxyModal, setShowProxyModal] = useState<StudentSemaforo | null>(null);
  const [proxyFileName, setProxyFileName] = useState('');

  // Manage Covered Days state
  const [managingCert, setManagingCert] = useState<MedicalCertificate | null>(null);
  const [coveredDaysInput, setCoveredDaysInput] = useState<string[]>([]);
  const [newCoveredDay, setNewCoveredDay] = useState('');

  // Notifications
  const [toast, setToast] = useState('');

  useEffect(() => {
    fetchForms();
    fetchMedicalCertificates();
  }, []);

  useEffect(() => {
    if (selectedFormId) {
      fetchSemaforo();
    }
  }, [selectedFormId]);

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const fetchForms = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/admin/forms');
      const data = await res.json();
      if (Array.isArray(data)) {
        // Filter forms assigned to this teacher's class
        const classForms = data.filter((f: any) => f.target_classes?.includes(CLASS_NAME));
        setForms(classForms);
        if (classForms.length > 0) {
          setSelectedFormId(classForms[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchSemaforo = async () => {
    if (!selectedFormId) return;
    try {
      const res = await fetch(`/api/teacher/modulistica?form_id=${selectedFormId}&class_name=${CLASS_NAME}`);
      const data = await res.json();
      if (Array.isArray(data)) setStudents(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchMedicalCertificates = async () => {
    try {
      const res = await fetch(`/api/teacher/medical-certificates?class_name=${CLASS_NAME}`);
      const data = await res.json();
      if (Array.isArray(data)) setMedCerts(data);
    } catch (err) {
      console.error(err);
    }
  };

  // Actions
  const handleSendReminder = (studentName: string) => {
    showToastMsg(`🔔 Sollecito inviato con successo a Genitore di ${studentName}!`);
  };

  const handleProxyUploadSubmit = async () => {
    if (!showProxyModal || !proxyFileName) return;
    
    try {
      const res = await fetch('/api/teacher/modulistica', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form_id: selectedFormId,
          student_id: showProxyModal.student_id,
          file_path: `proxy_uploads/${selectedFormId}/${showProxyModal.student_id}_${proxyFileName}`,
          teacher_id: TEACHER_ID
        })
      });

      if (!res.ok) throw new Error('Errore proxy upload');

      showToastMsg(`✅ Autorizzazione cartacea registrata per ${showProxyModal.nome}!`);
      setShowProxyModal(null);
      setProxyFileName('');
      fetchSemaforo();
    } catch (err) {
      showToastMsg('❌ Errore durante l\'inserimento');
    }
  };

  // Manage days logic
  const handleOpenDaysManager = (cert: MedicalCertificate) => {
    setManagingCert(cert);
    setCoveredDaysInput(cert.giorni_coperti || []);
  };

  const handleAddCoveredDay = () => {
    if (!newCoveredDay) return;
    if (coveredDaysInput.includes(newCoveredDay)) {
      showToastMsg('❌ Giorno già presente');
      return;
    }
    setCoveredDaysInput([...coveredDaysInput, newCoveredDay].sort());
    setNewCoveredDay('');
  };

  const handleRemoveCoveredDay = (day: string) => {
    setCoveredDaysInput(coveredDaysInput.filter(d => d !== day));
  };

  const handleSaveCoveredDays = async () => {
    if (!managingCert) return;

    try {
      const res = await fetch('/api/teacher/medical-certificates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          certificate_id: managingCert.id,
          giorni_coperti: coveredDaysInput
        })
      });

      if (!res.ok) throw new Error('Errore salvataggio');

      showToastMsg('✅ Giorni coperti aggiornati con successo!');
      setManagingCert(null);
      fetchMedicalCertificates();
    } catch (err) {
      showToastMsg('❌ Errore durante il salvataggio');
    }
  };

  return (
    <div className="flex-1 flex flex-col p-4 sm:p-6 max-w-4xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 pb-4 mb-6">
        <div>
          <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
            <FileText size={28} className="text-kidville-yellow" /> Registro Documentale
          </h1>
          <p className="font-maven text-gray-500 mt-1">Sezione Girasoli</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 mb-6 border-b border-gray-200">
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide transition-colors flex items-center gap-1.5 ${activeTab === 'semaforo' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-gray-400 hover:text-gray-600'}`}
          onClick={() => setActiveTab('semaforo')}
        >
          <Users size={16} /> Semaforo Consensi
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide transition-colors flex items-center gap-1.5 ${activeTab === 'medici' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-gray-400 hover:text-gray-600'}`}
          onClick={() => setActiveTab('medici')}
        >
          <HeartPulse size={16} /> Certificati Medici
        </button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[40vh] gap-3">
          <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
          <p className="font-maven text-gray-500">Caricamento in corso...</p>
        </div>
      ) : (
        <>
          {/* TAB 1: Semaforo Autorizzazioni */}
          {activeTab === 'semaforo' && (
            <div className="space-y-6">
              {/* Form Selector */}
              <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <label className="font-maven font-semibold text-sm text-kidville-green">
                  Seleziona Modulo di Autorizzazione
                </label>
                <select
                  value={selectedFormId}
                  onChange={e => setSelectedFormId(e.target.value)}
                  className="border-2 border-gray-100 rounded-xl px-3 py-2 font-maven text-sm text-gray-600 focus:outline-none bg-white max-w-sm"
                >
                  {forms.map(form => (
                    <option key={form.id} value={form.id}>{form.title}</option>
                  ))}
                </select>
              </div>

              {/* Semaforo Table */}
              <div className="bg-white rounded-card shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-4 bg-gray-50 border-b border-gray-150 flex items-center justify-between">
                  <h3 className="font-barlow font-bold text-base text-kidville-green uppercase tracking-wide">
                    Stato Approvazioni Classe
                  </h3>
                  <div className="flex items-center gap-3 text-xs font-maven font-semibold text-gray-500">
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-emerald-500 rounded-full" /> {students.filter(s => s.status === 'green').length} Firmati</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-red-500 rounded-full" /> {students.filter(s => s.status === 'red').length} Mancanti</span>
                  </div>
                </div>

                <div className="divide-y divide-gray-100">
                  {students.map(student => (
                    <div key={student.student_id} className="p-4 flex items-center justify-between gap-4 hover:bg-gray-50/50 transition-colors">
                      <div className="flex items-center gap-3">
                        <span className={`w-3.5 h-3.5 rounded-full shadow-inner ${student.status === 'green' ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`} />
                        <span className="font-maven font-semibold text-sm text-gray-800">
                          {student.cognome} {student.nome}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        {student.status === 'red' ? (
                          <>
                            <button
                              onClick={() => handleSendReminder(student.nome)}
                              className="p-2 text-gray-400 hover:text-[#0066cc] hover:bg-gray-100 rounded-lg transition-colors"
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
                          <span className="text-[10px] text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full font-bold uppercase tracking-wider flex items-center gap-1">
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
                <div className="bg-white rounded-card p-10 text-center border border-gray-100">
                  <HeartPulse className="mx-auto text-gray-300 mb-3" size={48} />
                  <p className="font-maven text-gray-500">Nessun certificato medico caricato in classe.</p>
                </div>
              ) : (
                medCerts.map(cert => (
                  <div key={cert.id} className="bg-white rounded-card p-5 border border-gray-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase">
                          {cert.cognome_alunno} {cert.nome_alunno}
                        </h3>
                        <span className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
                          Certificato Medico
                        </span>
                      </div>
                      <p className="font-maven text-xs text-gray-400 mt-1">
                        Caricato il: {new Date(cert.creato_il).toLocaleDateString()}
                      </p>
                      {cert.note && (
                        <p className="font-maven text-xs text-gray-600 mt-2 bg-gray-50 p-2 rounded-lg italic">
                          "{cert.note}"
                        </p>
                      )}
                      
                      <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                        {cert.giorni_coperti?.length > 0 ? (
                          cert.giorni_coperti.map((day: string) => (
                            <span key={day} className="bg-emerald-50 text-emerald-700 border border-emerald-150 px-2.5 py-0.5 rounded-full text-[10px] font-semibold">
                              {new Date(day).toLocaleDateString()}
                            </span>
                          ))
                        ) : (
                          <span className="text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 font-maven uppercase tracking-wider">
                            <AlertCircle size={10} /> Da registrare giorni coperti
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => handleOpenDaysManager(cert)}
                      className="flex items-center gap-1 px-3.5 py-2 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase text-xs tracking-wider shadow-sm hover:opacity-90 transition-opacity"
                    >
                      <Calendar size={14} /> Gestisci Giorni
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-sm rounded-card p-6 shadow-2xl text-center">
            <Upload className="text-kidville-green mx-auto mb-3" size={40} />
            <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide mb-1">Proxy Upload Cartaceo</h3>
            <p className="font-maven text-xs text-gray-500 mb-6">
              Carica la scansione o la foto del modulo firmato a penna consegnato a mano dal genitore di <strong>{showProxyModal.nome}</strong>.
            </p>

            <div className="space-y-4">
              {proxyFileName ? (
                <div className="flex items-center justify-between border-2 border-emerald-100 bg-emerald-50 text-emerald-700 px-3 py-2 rounded-xl text-xs font-semibold select-none">
                  <span>📄 {proxyFileName}</span>
                  <button onClick={() => setProxyFileName('')} className="text-gray-400 hover:text-red-500">✕</button>
                </div>
              ) : (
                <label className="w-full h-12 border-2 border-dashed border-gray-200 hover:border-kidville-green rounded-xl flex items-center justify-center gap-1.5 cursor-pointer text-xs font-semibold text-gray-600 transition-colors">
                  <Upload size={14} /> Carica File
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    className="hidden"
                    onChange={e => setProxyFileName(e.target.files?.[0]?.name || '')}
                  />
                </label>
              )}
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowProxyModal(null); setProxyFileName(''); }}
                className="flex-1 h-11 font-maven text-sm rounded-pill border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors"
              >
                Annulla
              </button>
              <button
                disabled={!proxyFileName}
                onClick={handleProxyUploadSubmit}
                className="flex-1 h-11 font-barlow font-black uppercase tracking-wider rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 disabled:opacity-50 transition-all"
              >
                Registra Firma
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Covered Days Calendar Checklist */}
      {managingCert && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-md rounded-card p-6 shadow-2xl flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3 mb-4">
              <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">
                Gestione Giorni Certificati
              </h2>
              <button onClick={() => setManagingCert(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              <p className="font-maven text-xs text-gray-500 leading-relaxed">
                Spunta o inserisci le date di assenza dell'alunno <strong>{managingCert.cognome_alunno} {managingCert.nome_alunno}</strong> coperte da questo certificato medico per giustificarle ufficialmente.
              </p>

              {/* Add Day Input */}
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block font-maven text-[10px] font-semibold text-gray-500 mb-1">Aggiungi Giorno</label>
                  <input
                    type="date"
                    value={newCoveredDay}
                    onChange={e => setNewCoveredDay(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 font-maven text-xs focus:outline-none"
                  />
                </div>
                <button
                  onClick={handleAddCoveredDay}
                  className="h-8.5 px-4 bg-kidville-cream text-kidville-green border border-kidville-green/10 rounded-pill font-barlow font-bold text-xs uppercase"
                >
                  Aggiungi
                </button>
              </div>

              {/* Covered Days list checklist */}
              <div className="space-y-2">
                <h4 className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Giorni di Copertura Inseriti</h4>
                {coveredDaysInput.length === 0 ? (
                  <div className="text-center py-6 border border-dashed border-gray-250 rounded-xl font-maven text-xs text-gray-400">
                    Nessun giorno inserito. Aggiungerne uno sopra.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {coveredDaysInput.map(day => (
                      <span key={day} className="bg-emerald-50 text-emerald-700 border border-emerald-150 px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5">
                        {new Date(day).toLocaleDateString()}
                        <button
                          onClick={() => handleRemoveCoveredDay(day)}
                          className="text-gray-400 hover:text-red-500 font-bold"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-3 border-t border-gray-100 pt-4 mt-4 justify-end">
              <button
                onClick={() => setManagingCert(null)}
                className="px-4 py-2 font-maven rounded-pill border border-gray-200 text-gray-500 text-sm hover:bg-gray-50"
              >
                Annulla
              </button>
              <button
                onClick={handleSaveCoveredDays}
                className="px-5 py-2.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90 transition-all shadow-md"
              >
                Salva Copertura
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-gray-900 text-white font-maven font-semibold px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-slideIn">
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
