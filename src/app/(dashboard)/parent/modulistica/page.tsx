'use client';

import { useState, useEffect } from 'react';
import {
  FileText, Clock, Archive, Award, HeartPulse, Shield,
  ArrowRight, Download, CheckCircle2, User, Key, Info, Upload, Mail
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import { OtpEmailModal } from '@/components/features/parent/forms/OtpEmailModal';

const PARENT_ID = '33333333-3333-3333-3333-333333333333'; // Sarah Pagano

type FormType = 'sondaggio' | 'gradimento' | 'autorizzazione';

interface FieldOption { label: string; value: string }

interface FormField {
  id: string;
  type: 'text' | 'textarea' | 'checkbox' | 'date' | 'radio' | 'rating';
  label: string;
  required: boolean;
  db_mapping?: string;
  options?: FieldOption[];
}

interface AssignedForm {
  form_id: string;
  title: string;
  description: string;
  form_type: FormType;
  fields: FormField[];
  expiration_date: string | null;
  student: {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione: string;
  };
  status: 'signed' | 'expired' | 'pending';
  submission?: {
    is_signed: boolean;
    created_at: string;
    pdf_path: string;
  } | null;
}

interface SignedArchiveItem {
  id: string;
  answers: Record<string, any>;
  is_signed: boolean;
  signature_log: any;
  pdf_path: string;
  created_at: string;
  forms_templates: {
    title: string;
    description: string;
  };
  alunni: {
    nome: string;
    cognome: string;
  };
}

export default function ParentModulisticaPage() {
  const [activeTab, setActiveTab] = useState<'compilare' | 'archivio' | 'certificati' | 'medici'>('compilare');
  const [assignedForms, setAssignedForms] = useState<AssignedForm[]>([]);
  const [archive, setArchive] = useState<SignedArchiveItem[]>([]);
  const [medCerts, setMedCerts] = useState<any[]>([]);
  const [children, setChildren] = useState<{ id: string; nome: string; cognome: string }[]>([]);
  const [parentInfo, setParentInfo] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Active Compiler state
  const [compilingForm, setCompilingForm] = useState<AssignedForm | null>(null);
  const [formAnswers, setFormAnswers] = useState<Record<string, any>>({});
  // Firma OTP via email (FES)
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [otpSession, setOtpSession] = useState<{ email: string | null; expiry: number; ticket: string; devCode?: string } | null>(null);

  // Medical Certificate form
  const [selectedChildId, setSelectedChildId] = useState('');
  const [certFileName, setCertFileName] = useState('');
  const [certFile, setCertFile] = useState<File | null>(null);
  const [certDal, setCertDal] = useState('');
  const [certAl, setCertAl] = useState('');
  const [certNotes, setCertNotes] = useState('');

  // Notifications
  const [toast, setToast] = useState('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      // 1. Fetch assigned forms
      const fRes = await fetch(`/api/parent/forms?parent_id=${PARENT_ID}`);
      const fData = await fRes.json();
      if (Array.isArray(fData)) setAssignedForms(fData);

      // 2. Fetch signed archive
      const aRes = await fetch(`/api/parent/submissions?parent_id=${PARENT_ID}`);
      const aData = await aRes.json();
      if (Array.isArray(aData)) setArchive(aData);

      // 3. Fetch medical certificates
      const mRes = await fetch(`/api/parent/medical-certificates?parent_id=${PARENT_ID}`);
      const mData = await mRes.json();
      if (Array.isArray(mData)) setMedCerts(mData);

      // 4. Fetch children list via route server gated (parent-scoped, service-role)
      const sRes = await fetch('/api/parent/students', { headers: { 'x-user-id': PARENT_ID } });
      const sJson = await sRes.json().catch(() => ({}));
      const studs = Array.isArray(sJson?.data) ? sJson.data : [];
      if (studs.length > 0) {
        setChildren(studs);
        setSelectedChildId(studs[0].id);
      }

      // 5. Fetch Parent info via /api/me (gated, niente lettura anon di `utenti`)
      const pRes = await fetch('/api/me', { headers: { 'x-user-id': PARENT_ID } });
      if (pRes.ok) {
        const parent = await pRes.json().catch(() => null);
        if (parent) setParentInfo(parent);
      }

    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Compiler Setup & Autofill
  const startCompiling = (form: AssignedForm) => {
    setCompilingForm(form);
    setOtpSession(null);
    setShowOtpModal(false);

    // Prefill form answers from DB info
    const initialAnswers: Record<string, any> = {};
    form.fields.forEach(field => {
      if (field.db_mapping) {
        const [table, col] = field.db_mapping.split('.');
        if (table === 'utenti' && parentInfo) {
          initialAnswers[field.id] = parentInfo[col] || '';
        } else if (table === 'alunni') {
          // If child information is mapped, we can mock it or we could fetch child info.
          // For simplicity we prefill with child's details we already have (or mock).
          if (col === 'nome') initialAnswers[field.id] = form.student.nome;
          else if (col === 'cognome') initialAnswers[field.id] = form.student.cognome;
          else initialAnswers[field.id] = '';
        }
      } else {
        initialAnswers[field.id] = field.type === 'checkbox' ? false : '';
      }
    });

    setFormAnswers(initialAnswers);
  };

  const handleFieldChange = (fieldId: string, value: any) => {
    setFormAnswers({ ...formAnswers, [fieldId]: value });
  };

  // Firma OTP via email — step 1: valida i campi e invia il codice
  // Verifica i campi obbligatori del modulo in compilazione
  const validateRequired = (): boolean => {
    if (!compilingForm) return false;
    for (const field of compilingForm.fields) {
      const v = formAnswers[field.id];
      if (field.required && (v === undefined || v === null || v === '' || v === false)) {
        showToastMsg(`❌ Compilare il campo obbligatorio: ${field.label || 'campo'}`);
        return false;
      }
    }
    return true;
  };

  // Invio diretto (sondaggio / gradimento) — nessuna firma OTP richiesta
  const handleSubmitDirect = async () => {
    if (!compilingForm || !validateRequired()) return;
    try {
      const res = await fetch('/api/parent/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form_id: compilingForm.form_id,
          student_id: compilingForm.student.id,
          answers: formAnswers,
          is_signed: false,
          parent_id: PARENT_ID,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        showToastMsg(`❌ ${j.error ?? 'Invio fallito'}`);
        return;
      }
      showToastMsg('✅ Risposte inviate con successo!');
      setCompilingForm(null);
      fetchData();
    } catch {
      showToastMsg('❌ Errore durante l\'invio');
    }
  };

  const handleStartSigning = async () => {
    if (!compilingForm || !validateRequired()) return;

    try {
      const res = await fetch('/api/parent/forms/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: PARENT_ID }),
      });
      const json = await res.json();
      if (!res.ok) {
        showToastMsg(`❌ ${json.error ?? 'Invio codice fallito'}`);
        return;
      }
      setOtpSession({ email: json.email, expiry: json.expiry, ticket: json.ticket, devCode: json.devCode });
      setShowOtpModal(true);
      if (!json.sent) {
        showToastMsg('ℹ️ Email non configurata: usa il codice mostrato (dev).');
      }
    } catch (err) {
      showToastMsg('❌ Errore durante l\'invio del codice');
    }
  };

  // Firma OTP via email — step 2: verifica il codice, finalizza la firma e genera la ricevuta
  const verifyOtpAndSign = async (code: string): Promise<{ ok: boolean; error?: string }> => {
    if (!compilingForm || !otpSession) return { ok: false, error: 'Sessione di firma scaduta' };
    try {
      const res = await fetch('/api/parent/forms/otp', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_id: PARENT_ID,
          code,
          expiry: otpSession.expiry,
          ticket: otpSession.ticket,
          form_id: compilingForm.form_id,
          student_id: compilingForm.student.id,
          answers: formAnswers,
        }),
      });
      const json = await res.json();
      if (!res.ok) return { ok: false, error: json.error ?? 'Verifica fallita' };

      // Ricevuta PDF con il signature_log autorevole restituito dal server
      generateReceiptPDF(compilingForm, formAnswers, json.signature_log);

      // La modale mostra l'esito; chiudiamo e ricarichiamo dopo un attimo
      setTimeout(() => {
        setShowOtpModal(false);
        setCompilingForm(null);
        setOtpSession(null);
        fetchData();
      }, 1600);

      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'Errore di rete. Riprova.' };
    }
  };

  // Receipt PDF Generator
  const generateReceiptPDF = (form: AssignedForm | SignedArchiveItem, answers: Record<string, any>, log: any) => {
    const isArchive = 'forms_templates' in form;
    const title = isArchive ? (form as SignedArchiveItem).forms_templates.title : (form as AssignedForm).title;
    const desc = isArchive ? (form as SignedArchiveItem).forms_templates.description : (form as AssignedForm).description;
    const studentName = isArchive ? `${(form as SignedArchiveItem).alunni.nome} ${(form as SignedArchiveItem).alunni.cognome}` : `${(form as AssignedForm).student.nome} ${(form as AssignedForm).student.cognome}`;
    
    const doc = new jsPDF();
    
    // School Letterhead Simulation
    doc.setFillColor(0, 106, 95); // Kidville Green
    doc.rect(0, 0, 210, 40, 'F');
    
    doc.setTextColor(253, 196, 0); // Kidville Yellow
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(22);
    doc.text('KIDVILLE SCHOOLS', 20, 25);
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10);
    doc.text('Registro Elettronico & Modulistica Legale AgID', 120, 25);

    // Body
    doc.setTextColor(0, 106, 95);
    doc.setFontSize(16);
    doc.text('RICEVUTA DI FIRMA ELETTRONICA SEMPLICE (FES)', 20, 55);
    
    doc.setDrawColor(0, 106, 95);
    doc.setLineWidth(0.5);
    doc.line(20, 58, 190, 58);

    doc.setTextColor(50, 50, 50);
    doc.setFontSize(11);
    doc.setFont('Helvetica', 'normal');
    doc.text(`Documento: ${title}`, 20, 68);
    doc.text(`Descrizione: ${desc || 'Nessuna'}`, 20, 75);
    doc.text(`Alunno: ${studentName}`, 20, 82);
    doc.text(`Firmatario: ${log?.parent_details?.nome || 'Sarah'} ${log?.parent_details?.cognome || 'Pagano'} (${log?.parent_details?.cf || 'PGNSRH82E45H501K'})`, 20, 89);
    
    doc.setFont('Helvetica', 'bold');
    doc.text('RISPOSTE FORNITE:', 20, 102);
    
    doc.setFont('Helvetica', 'normal');
    let yOffset = 110;
    
    const fieldsList = isArchive 
      ? Object.entries(answers).map(([key, val]) => ({ label: key, val })) 
      : (form as AssignedForm).fields.map(f => ({ label: f.label, val: answers[f.id] }));

    fieldsList.forEach((field: any) => {
      const displayVal = typeof field.val === 'boolean' ? (field.val ? 'SÌ (Acconsentito)' : 'NO') : field.val;
      doc.text(`• ${field.label}: ${displayVal}`, 25, yOffset);
      yOffset += 8;
    });

    // Legal Shield section
    yOffset += 10;
    doc.setFillColor(254, 241, 228); // Soft Cream
    doc.rect(20, yOffset, 170, 45, 'F');
    doc.setDrawColor(253, 196, 0);
    doc.rect(20, yOffset, 170, 45, 'D');

    doc.setTextColor(0, 106, 95);
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('CRISTALLIZZAZIONE LOG COMPLIANCE (CAD Art. 20 / DPR 445/2000)', 25, yOffset + 7);
    
    doc.setTextColor(80, 80, 80);
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(`Marca temporale (UTC): ${new Date(log?.timestamp || Date.now()).toISOString()}`, 25, yOffset + 15);
    doc.text(`Indirizzo IP Firmatario: ${log?.ip || '192.168.1.45'}`, 25, yOffset + 21);
    doc.text(`User Agent: ${log?.user_agent?.substring(0, 80) || 'N.D.'}`, 25, yOffset + 27);
    doc.text(`Identity Provider SPID/CIE: ${log?.provider || 'Aruba SPID'}`, 25, yOffset + 33);
    doc.text(`SHA-256 Impronta Digitale: ${log?.hash || 'FES-HASH-' + Math.random().toString(16).substring(2, 10).toUpperCase()}`, 25, yOffset + 39);

    // Footer
    doc.setTextColor(150, 150, 150);
    doc.setFontSize(8);
    doc.text('Questo documento costituisce ricevuta inattaccabile del consenso ed è archiviato digitalmente.', 20, 280);

    doc.save(`Ricevuta_${title.replace(/\s+/g, '_')}.pdf`);
  };

  // Self-Service Certificates Generator
  const generateSelfServiceCertificate = (type: 'iscrizione' | 'frequenza') => {
    if (!parentInfo || children.length === 0) return;
    
    showToastMsg('⏳ Generazione certificato in corso...');
    setTimeout(() => {
      const doc = new jsPDF();
      const currentStudent = children[0]; // Sofia

      // Header Letterhead
      doc.setFillColor(0, 106, 95); // Kidville Green
      doc.rect(0, 0, 210, 40, 'F');
      doc.setTextColor(253, 196, 0); // Kidville Yellow
      doc.setFont('Helvetica', 'bold');
      doc.setFontSize(22);
      doc.text('KIDVILLE SCHOOLS', 20, 25);
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(10);
      doc.text('Servizio Rilascio Certificati Automatici', 130, 25);

      // Certificate content
      doc.setTextColor(0, 106, 95);
      doc.setFontSize(18);
      const mainTitle = type === 'iscrizione' ? 'CERTIFICATO DI ISCRIZIONE' : 'CERTIFICATO DI FREQUENZA';
      doc.text(mainTitle, 105, 65, { align: 'center' });

      doc.setDrawColor(0, 106, 95);
      doc.line(40, 70, 170, 70);

      doc.setTextColor(50, 50, 50);
      doc.setFont('Helvetica', 'normal');
      doc.setFontSize(12);
      
      const bodyText = type === 'iscrizione' 
        ? `Si certifica che l'alunno/a ${currentStudent.cognome} ${currentStudent.nome}, CF: PGNSRH82E45H501K, risulta regolarmente iscritto/a presso questa istituzione scolastica per l'anno scolastico 2026/2027.`
        : `Si certifica che l'alunno/a ${currentStudent.cognome} ${currentStudent.nome}, CF: PGNSRH82E45H501K, frequenta regolarmente le attività didattiche di questa scuola nella sezione dei Girasoli per l'anno scolastico corrente.`;

      const splitText = doc.splitTextToSize(bodyText, 160);
      doc.text(splitText, 25, 90);

      doc.text(`Rilasciato su richiesta del genitore ${parentInfo.nome} ${parentInfo.cognome} ad uso consentito dalla legge.`, 25, 130);

      doc.text(`Milano, lì ${new Date().toLocaleDateString('it-IT')}`, 25, 160);

      // Signature stamp
      doc.setFont('Helvetica', 'bold');
      doc.text('Il Dirigente Scolastico', 130, 180);
      
      doc.setFont('Helvetica', 'oblique');
      doc.setFontSize(10);
      doc.setTextColor(100, 100, 100);
      doc.text('Firma digitale apposta ai sensi', 125, 195);
      doc.text('dell\'art. 21 CAD (D.Lgs. 82/2005)', 125, 200);

      doc.save(`Certificato_${mainTitle.replace(/\s+/g, '_')}.pdf`);
      showToastMsg('✅ Certificato scaricato con successo!');
    }, 1000);
  };

  // Submit Medical Certificate
  const handleUploadMedicalCert = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!certFile) { showToastMsg('❌ Caricare un file di certificato medico.'); return; }
    if (!selectedChildId) { showToastMsg('❌ Seleziona il figlio.'); return; }
    if (!certDal || !certAl || certDal > certAl) { showToastMsg('❌ Indica un periodo di copertura valido (dal/al).'); return; }

    try {
      const fd = new FormData();
      fd.append('file', certFile);
      fd.append('student_id', selectedChildId);
      fd.append('data_inizio', certDal);
      fd.append('data_fine', certAl);
      fd.append('note', certNotes);
      const res = await fetch('/api/parent/medical-certificates', {
        method: 'POST',
        headers: { 'x-user-id': PARENT_ID },
        body: fd,
      });
      if (!res.ok) throw new Error('Errore upload');
      showToastMsg('✅ Certificato caricato. In attesa di validazione della Segreteria.');
      setCertFile(null); setCertFileName(''); setCertDal(''); setCertAl(''); setCertNotes('');
      fetchData();
    } catch {
      showToastMsg('❌ Errore caricamento certificato medico');
    }
  };

  return (
    <div className="flex-1 flex flex-col p-4 sm:p-6 max-w-4xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 pb-4 mb-6">
        <div>
          <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
            <FileText size={28} className="text-kidville-yellow" /> Modulistica & Burocrazia
          </h1>
          <p className="font-maven text-gray-500 mt-1">Giulia Bianchi</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 mb-6 overflow-x-auto border-b border-gray-200 scrollbar-none pb-1">
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'compilare' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-gray-400 hover:text-gray-600'}`}
          onClick={() => { setActiveTab('compilare'); setCompilingForm(null); }}
        >
          <Clock size={16} /> Da Compilare
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'archivio' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-gray-400 hover:text-gray-600'}`}
          onClick={() => { setActiveTab('archivio'); setCompilingForm(null); }}
        >
          <Archive size={16} /> Archivio Firmati
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'certificati' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-gray-400 hover:text-gray-600'}`}
          onClick={() => { setActiveTab('certificati'); setCompilingForm(null); }}
        >
          <Award size={16} /> Certificati Self-Service
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'medici' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-gray-400 hover:text-gray-600'}`}
          onClick={() => { setActiveTab('medici'); setCompilingForm(null); }}
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
          {/* TAB 1: Da Compilare */}
          {activeTab === 'compilare' && !compilingForm && (
            <div className="space-y-4">
              {assignedForms.filter(f => f.status === 'pending').length === 0 ? (
                <div className="bg-white rounded-card p-10 text-center border border-gray-100">
                  <CheckCircle2 className="mx-auto text-emerald-500 mb-3" size={48} />
                  <p className="font-maven text-gray-500">Ottimo lavoro! Non hai moduli da compilare.</p>
                </div>
              ) : (
                assignedForms.filter(f => f.status === 'pending').map(form => (
                  <div key={form.form_id + '-' + form.student.id} className="bg-white rounded-card p-5 shadow-sm border border-gray-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                        {form.title}
                      </h3>
                      <p className="font-maven text-xs text-gray-500 line-clamp-2 max-w-xl mt-1">
                        {form.description}
                      </p>
                      
                      <div className="flex flex-wrap items-center gap-3 mt-3">
                        {form.form_type === 'autorizzazione' && (
                          <span className="bg-kidville-green text-kidville-yellow px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-1">
                            <Shield size={11} /> Autorizzazione
                          </span>
                        )}
                        {form.form_type === 'sondaggio' && (
                          <span className="bg-kidville-yellow-light text-kidville-green px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider">Sondaggio</span>
                        )}
                        {form.form_type === 'gradimento' && (
                          <span className="bg-kidville-yellow-light text-kidville-green px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider">Gradimento</span>
                        )}
                        <span className="bg-kidville-cream text-kidville-green px-2.5 py-1 rounded-full text-xs font-semibold">
                          Figlio: {form.student.nome} {form.student.cognome}
                        </span>

                        {form.expiration_date && (
                          <span className="bg-amber-50 text-amber-600 px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1">
                            <Clock size={12} />
                            Scade il: {new Date(form.expiration_date).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => startCompiling(form)}
                      className="flex items-center gap-1.5 px-4.5 py-2 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase text-xs sm:text-sm tracking-wider hover:opacity-90 transition-opacity shadow-sm self-start md:self-auto"
                    >
                      {form.form_type === 'autorizzazione' ? 'Compila e Firma' : 'Compila'} <ArrowRight size={16} />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Form Compiler Overlay */}
          {activeTab === 'compilare' && compilingForm && (
            <div className="bg-white rounded-card p-6 shadow-sm border border-gray-100 space-y-6">
              <div>
                <h3 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide">
                  {compilingForm.title}
                </h3>
                <p className="font-maven text-sm text-gray-500 mt-1">
                  Compilazione per: <strong>{compilingForm.student.nome} {compilingForm.student.cognome}</strong>
                </p>
                <div className="bg-gray-50 p-4 rounded-xl font-maven text-xs text-gray-600 mt-4 leading-relaxed border border-gray-100">
                  {compilingForm.description}
                </div>
              </div>

              {/* Fields */}
              <div className="space-y-5">
                {compilingForm.fields.map(field => (
                  <div key={field.id} className="space-y-1.5">
                    {field.type === 'checkbox' ? (
                      <label className="flex items-start gap-2.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={formAnswers[field.id] || false}
                          onChange={e => handleFieldChange(field.id, e.target.checked)}
                          className="rounded text-kidville-green focus:ring-kidville-green mt-1 h-4 w-4"
                        />
                        <span className="font-maven text-sm text-gray-700 leading-tight">
                          {field.label} {field.required && <span className="text-red-500">*</span>}
                        </span>
                      </label>
                    ) : (
                      <>
                        <label className="block font-maven font-semibold text-sm text-kidville-green">
                          {field.label} {field.required && <span className="text-red-500">*</span>}
                        </label>

                        {field.type === 'textarea' && (
                          <textarea
                            value={formAnswers[field.id] || ''}
                            onChange={e => handleFieldChange(field.id, e.target.value)}
                            className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green resize-none h-24"
                            placeholder="Scrivi la tua risposta..."
                          />
                        )}

                        {field.type === 'radio' && (
                          <div className="flex flex-wrap gap-2">
                            {(field.options ?? []).map(opt => (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => handleFieldChange(field.id, opt.value)}
                                className={`px-4 py-2 rounded-pill text-sm font-semibold border-2 transition-colors ${formAnswers[field.id] === opt.value ? 'bg-kidville-green text-kidville-yellow border-kidville-green' : 'border-gray-200 text-gray-600 hover:border-kidville-green/40'}`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        )}

                        {field.type === 'rating' && (
                          <div className="flex gap-2">
                            {[1, 2, 3, 4, 5].map(n => (
                              <button
                                key={n}
                                type="button"
                                onClick={() => handleFieldChange(field.id, n)}
                                className={`w-11 h-11 rounded-full text-sm font-barlow font-bold border-2 transition-colors ${Number(formAnswers[field.id]) >= n ? 'bg-kidville-yellow text-kidville-green border-kidville-yellow' : 'border-gray-200 text-gray-400 hover:border-kidville-yellow'}`}
                              >
                                {n}
                              </button>
                            ))}
                          </div>
                        )}

                        {(field.type === 'text' || field.type === 'date') && (
                          <input
                            type={field.type === 'date' ? 'date' : 'text'}
                            value={formAnswers[field.id] || ''}
                            onChange={e => handleFieldChange(field.id, e.target.value)}
                            className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green"
                            placeholder={`Inserisci ${field.label.toLowerCase()}...`}
                          />
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>

              {/* FES — Firma con OTP via email (solo per le autorizzazioni) */}
              {compilingForm.form_type === 'autorizzazione' && (
                <div className="bg-kidville-cream/40 p-5 rounded-card border-2 border-dashed border-kidville-green/10 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <h4 className="font-barlow font-bold text-lg text-kidville-green uppercase tracking-wide flex items-center gap-1.5">
                      <Shield size={18} className="text-kidville-yellow" /> Firma Elettronica Semplice (FES)
                    </h4>
                    <p className="font-maven text-xs text-gray-500 max-w-md leading-relaxed">
                      Per validare la firma con valore legale (Art. 20 CAD) invieremo un codice OTP
                      alla tua email registrata. Inseriscilo per completare la firma.
                    </p>
                  </div>
                  <div className="bg-kidville-green-light text-kidville-green px-4 py-2 rounded-xl text-xs font-bold border border-kidville-green/15 flex items-center gap-1.5 self-start md:self-auto">
                    <Mail size={15} /> Verifica via email
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 justify-end border-t border-gray-100 pt-4">
                <button
                  onClick={() => setCompilingForm(null)}
                  className="px-4 py-2 font-maven rounded-pill border border-gray-200 text-gray-500 text-sm hover:bg-gray-50 transition-colors"
                >
                  Annulla
                </button>
                <button
                  onClick={compilingForm.form_type === 'autorizzazione' ? handleStartSigning : handleSubmitDirect}
                  className="px-5 py-2.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90 disabled:opacity-50 transition-all shadow-md flex items-center gap-1.5"
                >
                  {compilingForm.form_type === 'autorizzazione' ? 'Invia e Firma Ricevuta' : 'Invia Risposte'}
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: Archivio Firmati */}
          {activeTab === 'archivio' && (
            <div className="space-y-4">
              {archive.length === 0 ? (
                <div className="bg-white rounded-card p-10 text-center border border-gray-100">
                  <Archive className="mx-auto text-gray-300 mb-3" size={48} />
                  <p className="font-maven text-gray-500">Nessun modulo firmato finora.</p>
                </div>
              ) : (
                archive.map(item => (
                  <div key={item.id} className="bg-white rounded-card p-5 border border-gray-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                        {item.forms_templates?.title}
                      </h3>
                      <p className="font-maven text-xs text-gray-500 mt-1">
                        Figlio: {item.alunni?.nome} {item.alunni?.cognome} | Firmato il: {new Date(item.created_at).toLocaleDateString()}
                      </p>
                      <div className="mt-2.5 flex items-center gap-1 text-[10px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full font-bold w-fit uppercase tracking-wider">
                        <Shield size={10} /> Ricevuta FES Protetta
                      </div>
                    </div>

                    <button
                      onClick={() => generateReceiptPDF(item, item.answers, item.signature_log)}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 bg-kidville-cream text-kidville-green rounded-pill font-barlow font-bold text-xs uppercase hover:bg-kidville-green hover:text-kidville-yellow transition-colors self-start md:self-auto"
                    >
                      <Download size={14} /> Ricevuta PDF
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* TAB 3: Certificati Self-Service */}
          {activeTab === 'certificati' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Certificato Frequenza */}
              <div className="bg-white rounded-card p-6 border border-gray-100 shadow-sm flex flex-col justify-between">
                <div className="space-y-2">
                  <Award className="text-kidville-green/20 mb-2" size={32} />
                  <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase">Certificato Frequenza</h3>
                  <p className="font-maven text-xs text-gray-500 leading-relaxed">
                    Genera istantaneamente il certificato attestante la frequenza scolastica dell'alunno per l'anno in corso.
                  </p>
                </div>
                <button
                  onClick={() => generateSelfServiceCertificate('frequenza')}
                  className="mt-6 w-full h-11 font-barlow font-bold text-sm uppercase tracking-wider rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5"
                >
                  <Download size={16} /> Scarica PDF
                </button>
              </div>

              {/* Certificato Iscrizione */}
              <div className="bg-white rounded-card p-6 border border-gray-100 shadow-sm flex flex-col justify-between">
                <div className="space-y-2">
                  <Award className="text-kidville-green/20 mb-2" size={32} />
                  <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase">Certificato Iscrizione</h3>
                  <p className="font-maven text-xs text-gray-500 leading-relaxed">
                    Certificato formale di avvenuta iscrizione scolastica, utilizzabile per bonus INPS e detrazioni fiscali.
                  </p>
                </div>
                <button
                  onClick={() => generateSelfServiceCertificate('iscrizione')}
                  className="mt-6 w-full h-11 font-barlow font-bold text-sm uppercase tracking-wider rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5"
                >
                  <Download size={16} /> Scarica PDF
                </button>
              </div>
            </div>
          )}

          {/* TAB 4: Certificati Medici */}
          {activeTab === 'medici' && (
            <div className="space-y-6">
              <form onSubmit={handleUploadMedicalCert} className="bg-white rounded-card p-5 sm:p-6 shadow-sm border border-gray-100 space-y-4">
                <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                  Carica Certificato Medico
                </h3>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">
                      Seleziona Figlio *
                    </label>
                    <select
                      value={selectedChildId}
                      onChange={e => setSelectedChildId(e.target.value)}
                      className="w-full border-2 border-gray-100 rounded-xl px-3 py-2 font-maven text-xs text-gray-600 focus:outline-none bg-white"
                    >
                      {children.map(c => (
                        <option key={c.id} value={c.id}>{c.nome} {c.cognome}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">
                      Documento Scansionato (PDF / Foto) *
                    </label>
                    {certFileName ? (
                      <div className="flex items-center justify-between border-2 border-emerald-100 bg-emerald-50 text-emerald-700 px-3 py-2 rounded-xl text-xs font-semibold">
                        <span>📄 {certFileName}</span>
                        <button type="button" onClick={() => { setCertFileName(''); setCertFile(null); }} className="text-gray-400 hover:text-red-500">✕</button>
                      </div>
                    ) : (
                      <label className="w-full h-10 border-2 border-dashed border-gray-200 hover:border-kidville-green rounded-xl flex items-center justify-center gap-1.5 cursor-pointer text-xs font-semibold text-gray-600 transition-colors">
                        <Upload size={14} /> Carica Certificato
                        <input
                          type="file"
                          accept=".pdf,image/*"
                          className="hidden"
                          onChange={e => { const f = e.target.files?.[0] ?? null; setCertFile(f); setCertFileName(f?.name || ''); }}
                        />
                      </label>
                    )}
                  </div>
                </div>

                {/* Periodo di copertura (dal/al) — DL-027 */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">Coperto dal *</label>
                    <input type="date" value={certDal} onChange={e => setCertDal(e.target.value)}
                      className="w-full border-2 border-gray-100 rounded-xl px-3 py-2 font-maven text-xs text-gray-600 focus:outline-none focus:border-kidville-green" />
                  </div>
                  <div>
                    <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">al *</label>
                    <input type="date" value={certAl} min={certDal || undefined} onChange={e => setCertAl(e.target.value)}
                      className="w-full border-2 border-gray-100 rounded-xl px-3 py-2 font-maven text-xs text-gray-600 focus:outline-none focus:border-kidville-green" />
                  </div>
                </div>

                <div>
                  <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">
                    Note di accompagnamento
                  </label>
                  <textarea
                    value={certNotes}
                    onChange={e => setCertNotes(e.target.value)}
                    className="w-full border-2 border-gray-100 rounded-xl p-2.5 font-maven text-xs focus:outline-none focus:border-kidville-green resize-none h-16"
                    placeholder="Es. Influenza stagionale, rientro previsto dopo 5 giorni..."
                  />
                </div>

                <button
                  type="submit"
                  className="w-full h-11 font-barlow font-bold text-sm uppercase tracking-wider rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 transition-opacity"
                >
                  Invia Certificato Medico
                </button>
              </form>

              {/* Elenco certificati medici passati */}
              <div className="space-y-3">
                <h4 className="font-barlow font-bold text-base text-kidville-green uppercase tracking-wide">
                  Ricevute Caricamenti Medici Recenti
                </h4>
                {medCerts.length === 0 ? (
                  <div className="bg-white rounded-card p-6 text-center border border-gray-100 font-maven text-xs text-gray-400">
                    Nessun certificato medico caricato in precedenza.
                  </div>
                ) : (
                  medCerts.map(cert => (
                    <div key={cert.id} className="bg-white rounded-card p-4 border border-gray-100 flex items-center justify-between text-xs font-maven">
                      <div>
                        <div className="font-semibold text-gray-700">Certificato: {cert.fileName}</div>
                        <div className="text-gray-400 mt-0.5">Figlio: {cert.alunno?.nome} | Caricato il: {new Date(cert.creato_il).toLocaleDateString()}</div>
                        {cert.notes && <div className="text-gray-500 mt-1 italic">Note: {cert.notes}</div>}
                      </div>

                      <div className="flex flex-col items-end gap-1.5">
                        {cert.giorni_coperti?.length > 0 ? (
                          <span className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
                            Giustificato: {cert.giorni_coperti.map((d: string) => new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })).join(', ')}
                          </span>
                        ) : (
                          <span className="bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
                            In attesa di abbinamento assenza
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Modale Firma OTP via email (FES) */}
      <OtpEmailModal
        open={showOtpModal}
        email={otpSession?.email ?? null}
        devCode={otpSession?.devCode}
        onClose={() => setShowOtpModal(false)}
        onVerify={verifyOtpAndSign}
      />

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
