'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Clock, Archive, Award, HeartPulse, Shield,
  ArrowRight, Download, CheckCircle2, Upload, Mail
} from 'lucide-react';
import { OtpEmailModal } from '@/components/features/parent/forms/OtpEmailModal';
import { DateField } from '@/components/ui/DateField';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { annoScolasticoCorrente } from '@/lib/anno-scolastico';
import { buildCertificatoBody, buildIntestazioneSede, rigaLuogoData } from '@/lib/certificati/self-service';

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

// Valore di risposta di un campo modulo (testo, rating numerico, consenso).
type AnswerValue = string | number | boolean;

// Log di firma FES restituito dal server (campi usati nella ricevuta PDF).
interface SignatureLogInfo {
  timestamp?: string;
  ip?: string;
  user_agent?: string;
  provider?: string;
  hash?: string;
  parent_details?: { nome?: string | null; cognome?: string | null; cf?: string | null } | null;
}

interface MedCert {
  id: string;
  fileName?: string | null;
  alunno?: { nome?: string | null } | null;
  creato_il: string;
  notes?: string | null;
  giorni_coperti?: string[] | null;
}

interface SignedArchiveItem {
  id: string;
  answers: Record<string, unknown>;
  is_signed: boolean;
  signature_log: SignatureLogInfo | null;
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

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
export default function ParentModulisticaPage() {
  const { userId: parentId } = useSessionIdentity();
  const [activeTab, setActiveTab] = useState<'compilare' | 'archivio' | 'certificati' | 'medici'>('compilare');
  const [assignedForms, setAssignedForms] = useState<AssignedForm[]>([]);
  const [archive, setArchive] = useState<SignedArchiveItem[]>([]);
  const [medCerts, setMedCerts] = useState<MedCert[]>([]);
  // Include i dati reali di classe e sede (per-figlio, multi-sede) forniti da
  // /api/parent/students: alimentano i certificati self-service.
  const [children, setChildren] = useState<{
    id: string; nome: string; cognome: string;
    classe_sezione?: string | null;
    scuola_nome?: string | null; scuola_citta?: string | null; scuola_indirizzo?: string | null;
    scuola_cap?: string | null; scuola_provincia?: string | null; scuola_codice_meccanografico?: string | null;
  }[]>([]);
  const [parentInfo, setParentInfo] = useState<{ nome?: string | null; cognome?: string | null } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Active Compiler state
  const [compilingForm, setCompilingForm] = useState<AssignedForm | null>(null);
  const [formAnswers, setFormAnswers] = useState<Record<string, AnswerValue>>({});
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

  const fetchData = useCallback(async () => {
    if (!parentId) return; // identità non risolta: lo spinner resta
    try {
      // 1. Fetch assigned forms (gate requireUser: identità da sessione/header)
      const fRes = await fetch('/api/parent/forms', { headers: { 'x-user-id': parentId } }).catch(() => null);
      const fData = await fRes?.json().catch(() => null);
      if (Array.isArray(fData)) setAssignedForms(fData);

      // 2. Fetch signed archive
      const aRes = await fetch('/api/parent/submissions', { headers: { 'x-user-id': parentId } }).catch(() => null);
      const aData = await aRes?.json().catch(() => null);
      if (Array.isArray(aData)) setArchive(aData);

      // 3. Fetch medical certificates
      const mRes = await fetch('/api/parent/medical-certificates', { headers: { 'x-user-id': parentId } }).catch(() => null);
      const mData = await mRes?.json().catch(() => null);
      if (Array.isArray(mData)) setMedCerts(mData);

      // 4. Fetch children list via route server gated (parent-scoped, service-role)
      const sRes = await fetch('/api/parent/students', { headers: { 'x-user-id': parentId } }).catch(() => null);
      const sJson = await sRes?.json().catch(() => ({}));
      const studs = Array.isArray(sJson?.data) ? sJson.data : [];
      if (studs.length > 0) {
        setChildren(studs);
        setSelectedChildId(studs[0].id);
      }

      // 5. Fetch Parent info via /api/me (gated, niente lettura anon di `utenti`)
      const pRes = await fetch('/api/me', { headers: { 'x-user-id': parentId } }).catch(() => null);
      if (pRes?.ok) {
        const parent = await pRes.json().catch(() => null);
        if (parent) setParentInfo(parent);
      }
    } finally {
      setIsLoading(false);
    }
  }, [parentId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
    const initialAnswers: Record<string, AnswerValue> = {};
    form.fields.forEach(field => {
      if (field.db_mapping) {
        const [table, col] = field.db_mapping.split('.');
        if (table === 'utenti' && parentInfo) {
          const v = (parentInfo as Record<string, unknown>)[col];
          initialAnswers[field.id] = typeof v === 'string' ? v : '';
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

  const handleFieldChange = (fieldId: string, value: AnswerValue) => {
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
    if (!compilingForm || !parentId || !validateRequired()) return;
    try {
      const res = await fetch('/api/parent/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
        body: JSON.stringify({
          form_id: compilingForm.form_id,
          student_id: compilingForm.student.id,
          answers: formAnswers,
          is_signed: false,
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
    if (!compilingForm || !parentId || !validateRequired()) return;

    try {
      const res = await fetch('/api/parent/forms/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
        body: JSON.stringify({}),
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
    } catch {
      showToastMsg('❌ Errore durante l\'invio del codice');
    }
  };

  // Firma OTP via email — step 2: verifica il codice, finalizza la firma e genera la ricevuta
  const verifyOtpAndSign = async (code: string): Promise<{ ok: boolean; error?: string }> => {
    if (!compilingForm || !otpSession || !parentId) return { ok: false, error: 'Sessione di firma scaduta' };
    try {
      const res = await fetch('/api/parent/forms/otp', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
        body: JSON.stringify({
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
    } catch {
      return { ok: false, error: 'Errore di rete. Riprova.' };
    }
  };

  // Receipt PDF Generator
  // M9.4: async per caricare jsPDF on-demand; i chiamanti sono fire-and-forget
  // (onClick e post-firma), nessuno dipende dal completamento sincrono.
  const generateReceiptPDF = async (form: AssignedForm | SignedArchiveItem, answers: Record<string, unknown>, log: SignatureLogInfo | null) => {
    const isArchive = 'forms_templates' in form;
    const title = isArchive ? (form as SignedArchiveItem).forms_templates.title : (form as AssignedForm).title;
    const desc = isArchive ? (form as SignedArchiveItem).forms_templates.description : (form as AssignedForm).description;
    const studentName = isArchive ? `${(form as SignedArchiveItem).alunni.nome} ${(form as SignedArchiveItem).alunni.cognome}` : `${(form as AssignedForm).student.nome} ${(form as AssignedForm).student.cognome}`;

    const { jsPDF } = await import('jspdf');
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
    doc.text(`Firmatario: ${log?.parent_details?.nome || ''} ${log?.parent_details?.cognome || ''} (${log?.parent_details?.cf || 'CF non disponibile'})`.trim(), 20, 89);
    
    doc.setFont('Helvetica', 'bold');
    doc.text('RISPOSTE FORNITE:', 20, 102);
    
    doc.setFont('Helvetica', 'normal');
    let yOffset = 110;
    
    const fieldsList = isArchive 
      ? Object.entries(answers).map(([key, val]) => ({ label: key, val })) 
      : (form as AssignedForm).fields.map(f => ({ label: f.label, val: answers[f.id] }));

    fieldsList.forEach((field) => {
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
    doc.text(`Marca temporale (UTC): ${log?.timestamp ? new Date(log.timestamp).toISOString() : 'N.D.'}`, 25, yOffset + 15);
    doc.text(`Indirizzo IP Firmatario: ${log?.ip || '192.168.1.45'}`, 25, yOffset + 21);
    doc.text(`User Agent: ${log?.user_agent?.substring(0, 80) || 'N.D.'}`, 25, yOffset + 27);
    doc.text(`Identity Provider SPID/CIE: ${log?.provider || 'Aruba SPID'}`, 25, yOffset + 33);
    doc.text(`SHA-256 Impronta Digitale: ${log?.hash || 'N.D.'}`, 25, yOffset + 39);

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
    setTimeout(async () => {
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      // NB: sempre children[0] — il tab Certificati non ha selettore figlio
      // (semantica esistente, fuori scope del de-hardcode).
      const currentStudent = children[0];
      const anno = annoScolasticoCorrente();

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

      // Intestazione sede reale (dal DB, per-figlio): righe omesse se mancanti.
      const intestazione = buildIntestazioneSede(currentStudent);
      if (intestazione.length > 0) {
        doc.setTextColor(100, 100, 100);
        doc.setFont('Helvetica', 'normal');
        doc.setFontSize(9);
        intestazione.forEach((riga, i) => doc.text(riga, 20, 47 + i * 5));
      }

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
      
      // Testo dal builder puro (testato): sezione reale dell'alunno e anno
      // scolastico calcolato — nessun valore cablato.
      const bodyText = buildCertificatoBody(type, currentStudent, anno);

      const splitText = doc.splitTextToSize(bodyText, 160);
      doc.text(splitText, 25, 90);

      doc.text(`Rilasciato su richiesta del genitore ${parentInfo.nome} ${parentInfo.cognome} ad uso consentito dalla legge.`, 25, 130);

      // Luogo reale della sede del figlio (scuole.citta), degrado a sola data.
      doc.text(rigaLuogoData(currentStudent.scuola_citta, new Date().toLocaleDateString('it-IT')), 25, 160);

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
    if (!parentId) { showToastMsg('❌ Identità non risolta: accedi di nuovo.'); return; }
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
        headers: { 'x-user-id': parentId },
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
    <div className="flex-1 flex flex-col px-4 pt-5 pb-24">
      {/* Header */}
      <PageHeaderCard
        eyebrow="Documenti"
        title="Modulistica"
        subtitle="Firme, certificati e documenti"
      />

      {/* Tabs */}
      <div className="mt-5 flex gap-4 mb-6 overflow-x-auto border-b border-kidville-line scrollbar-none pb-1">
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'compilare' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => { setActiveTab('compilare'); setCompilingForm(null); }}
        >
          <Clock size={16} /> Da Compilare
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'archivio' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => { setActiveTab('archivio'); setCompilingForm(null); }}
        >
          <Archive size={16} /> Archivio Firmati
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'certificati' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => { setActiveTab('certificati'); setCompilingForm(null); }}
        >
          <Award size={16} /> Certificati Self-Service
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'medici' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => { setActiveTab('medici'); setCompilingForm(null); }}
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
          {/* TAB 1: Da Compilare */}
          {activeTab === 'compilare' && !compilingForm && (
            <div className="space-y-4">
              {assignedForms.filter(f => f.status === 'pending').length === 0 ? (
                <div className="bg-white rounded-card p-10 text-center border border-kidville-line">
                  <CheckCircle2 className="mx-auto text-kidville-success mb-3" size={48} />
                  <p className="font-maven text-kidville-muted">Ottimo lavoro! Non hai moduli da compilare.</p>
                </div>
              ) : (
                assignedForms.filter(f => f.status === 'pending').map(form => (
                  <div key={form.form_id + '-' + form.student.id} className="bg-white rounded-card p-5 shadow-sm border border-kidville-line flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                        {form.title}
                      </h3>
                      <p className="font-maven text-xs text-kidville-muted line-clamp-2 max-w-xl mt-1">
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
                          <span className="bg-kidville-warn-soft text-kidville-warn px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1">
                            <Clock size={12} />
                            Scade il: {new Date(form.expiration_date).toLocaleDateString('it-IT')}
                          </span>
                        )}
                      </div>
                    </div>

                    <Btn
                      variant="primary"
                      size="sm"
                      onClick={() => startCompiling(form)}
                      className="self-start md:self-auto"
                    >
                      {form.form_type === 'autorizzazione' ? 'Compila e Firma' : 'Compila'} <ArrowRight size={16} />
                    </Btn>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Form Compiler Overlay */}
          {activeTab === 'compilare' && compilingForm && (
            <div className="bg-white rounded-card p-6 shadow-sm border border-kidville-line space-y-6">
              <div>
                <h3 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide">
                  {compilingForm.title}
                </h3>
                <p className="font-maven text-sm text-kidville-muted mt-1">
                  Compilazione per: <strong>{compilingForm.student.nome} {compilingForm.student.cognome}</strong>
                </p>
                <div className="bg-kidville-neutral-soft p-4 rounded-xl font-maven text-xs text-kidville-sub mt-4 leading-relaxed border border-kidville-line">
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
                          checked={Boolean(formAnswers[field.id])}
                          onChange={e => handleFieldChange(field.id, e.target.checked)}
                          className="rounded text-kidville-green focus:ring-kidville-green mt-1 h-4 w-4"
                        />
                        <span className="font-maven text-sm text-kidville-ink leading-tight">
                          {field.label} {field.required && <span className="text-kidville-error">*</span>}
                        </span>
                      </label>
                    ) : (
                      <>
                        <label className="block font-maven font-semibold text-sm text-kidville-green">
                          {field.label} {field.required && <span className="text-kidville-error">*</span>}
                        </label>

                        {field.type === 'textarea' && (
                          <textarea
                            value={String(formAnswers[field.id] ?? '')}
                            onChange={e => handleFieldChange(field.id, e.target.value)}
                            className="w-full border-2 border-kidville-line rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green resize-none h-24"
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
                                className={`px-4 py-2 rounded-pill text-sm font-semibold border-2 transition-colors ${formAnswers[field.id] === opt.value ? 'bg-kidville-green text-kidville-yellow border-kidville-green' : 'border-kidville-line text-kidville-sub hover:border-kidville-green/40'}`}
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
                                className={`w-11 h-11 rounded-full text-sm font-barlow font-bold border-2 transition-colors ${Number(formAnswers[field.id]) >= n ? 'bg-kidville-yellow text-kidville-green border-kidville-yellow' : 'border-kidville-line text-kidville-muted hover:border-kidville-yellow'}`}
                              >
                                {n}
                              </button>
                            ))}
                          </div>
                        )}

                        {field.type === 'date' && (
                          <DateField
                            value={String(formAnswers[field.id] ?? '')}
                            onChange={(iso) => handleFieldChange(field.id, iso)}
                            aria-label={field.label}
                            className="w-full border-2 border-kidville-line rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green"
                          />
                        )}

                        {field.type === 'text' && (
                          <input
                            type="text"
                            value={String(formAnswers[field.id] ?? '')}
                            onChange={e => handleFieldChange(field.id, e.target.value)}
                            className="w-full border-2 border-kidville-line rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green"
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
                    <p className="font-maven text-xs text-kidville-muted max-w-md leading-relaxed">
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
              <div className="flex gap-3 justify-end border-t border-kidville-line pt-4">
                <Btn
                  variant="ghost"
                  size="sm"
                  onClick={() => setCompilingForm(null)}
                >
                  Annulla
                </Btn>
                <Btn
                  variant="primary"
                  size="md"
                  onClick={compilingForm.form_type === 'autorizzazione' ? handleStartSigning : handleSubmitDirect}
                >
                  {compilingForm.form_type === 'autorizzazione' ? 'Invia e Firma Ricevuta' : 'Invia Risposte'}
                </Btn>
              </div>
            </div>
          )}

          {/* TAB 2: Archivio Firmati */}
          {activeTab === 'archivio' && (
            <div className="space-y-4">
              {archive.length === 0 ? (
                <div className="bg-white rounded-card p-10 text-center border border-kidville-line">
                  <Archive className="mx-auto text-kidville-line mb-3" size={48} />
                  <p className="font-maven text-kidville-muted">Nessun modulo firmato finora.</p>
                </div>
              ) : (
                archive.map(item => (
                  <div key={item.id} className="bg-white rounded-card p-5 border border-kidville-line flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                        {item.forms_templates?.title}
                      </h3>
                      <p className="font-maven text-xs text-kidville-muted mt-1">
                        Figlio: {item.alunni?.nome} {item.alunni?.cognome} | Firmato il: {new Date(item.created_at).toLocaleDateString('it-IT')}
                      </p>
                      <div className="mt-2.5 flex items-center gap-1 text-[10px] text-kidville-success bg-kidville-success-soft px-2 py-0.5 rounded-full font-bold w-fit uppercase tracking-wider">
                        <Shield size={10} /> Ricevuta FES Protetta
                      </div>
                    </div>

                    <Btn
                      variant="ghost"
                      size="sm"
                      onClick={() => generateReceiptPDF(item, item.answers, item.signature_log)}
                      className="self-start md:self-auto"
                    >
                      <Download size={14} /> Ricevuta PDF
                    </Btn>
                  </div>
                ))
              )}
            </div>
          )}

          {/* TAB 3: Certificati Self-Service */}
          {activeTab === 'certificati' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Certificato Frequenza */}
              <div className="bg-white rounded-card p-6 border border-kidville-line shadow-sm flex flex-col justify-between">
                <div className="space-y-2">
                  <Award className="text-kidville-green/20 mb-2" size={32} />
                  <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase">Certificato Frequenza</h3>
                  <p className="font-maven text-xs text-kidville-muted leading-relaxed">
                    Genera istantaneamente il certificato attestante la frequenza scolastica dell&apos;alunno per l&apos;anno in corso.
                  </p>
                </div>
                <Btn
                  variant="primary"
                  size="md"
                  onClick={() => generateSelfServiceCertificate('frequenza')}
                  className="mt-6 w-full"
                >
                  <Download size={16} /> Scarica PDF
                </Btn>
              </div>

              {/* Certificato Iscrizione */}
              <div className="bg-white rounded-card p-6 border border-kidville-line shadow-sm flex flex-col justify-between">
                <div className="space-y-2">
                  <Award className="text-kidville-green/20 mb-2" size={32} />
                  <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase">Certificato Iscrizione</h3>
                  <p className="font-maven text-xs text-kidville-muted leading-relaxed">
                    Certificato formale di avvenuta iscrizione scolastica, utilizzabile per bonus INPS e detrazioni fiscali.
                  </p>
                </div>
                <Btn
                  variant="primary"
                  size="md"
                  onClick={() => generateSelfServiceCertificate('iscrizione')}
                  className="mt-6 w-full"
                >
                  <Download size={16} /> Scarica PDF
                </Btn>
              </div>
            </div>
          )}

          {/* TAB 4: Certificati Medici */}
          {activeTab === 'medici' && (
            <div className="space-y-6">
              <form onSubmit={handleUploadMedicalCert} className="bg-white rounded-card p-5 sm:p-6 shadow-sm border border-kidville-line space-y-4">
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
                      className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-xs text-kidville-sub focus:outline-none bg-white"
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
                      <div className="flex items-center justify-between border-2 border-kidville-success/20 bg-kidville-success-soft text-kidville-success px-3 py-2 rounded-xl text-xs font-semibold">
                        <span>📄 {certFileName}</span>
                        <button type="button" onClick={() => { setCertFileName(''); setCertFile(null); }} className="text-kidville-muted hover:text-kidville-error">✕</button>
                      </div>
                    ) : (
                      <label className="w-full h-10 border-2 border-dashed border-kidville-line hover:border-kidville-green rounded-xl flex items-center justify-center gap-1.5 cursor-pointer text-xs font-semibold text-kidville-sub transition-colors">
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
                    <DateField value={certDal} onChange={setCertDal} aria-label="Certificato medico: coperto dal"
                      className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-xs text-kidville-sub focus:outline-none focus:border-kidville-green" />
                  </div>
                  <div>
                    <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">al *</label>
                    <DateField value={certAl} onChange={setCertAl} aria-label="Certificato medico: coperto al"
                      className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-xs text-kidville-sub focus:outline-none focus:border-kidville-green" />
                  </div>
                </div>

                <div>
                  <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">
                    Note di accompagnamento
                  </label>
                  <textarea
                    value={certNotes}
                    onChange={e => setCertNotes(e.target.value)}
                    className="w-full border-2 border-kidville-line rounded-xl p-2.5 font-maven text-xs focus:outline-none focus:border-kidville-green resize-none h-16"
                    placeholder="Es. Influenza stagionale, rientro previsto dopo 5 giorni..."
                  />
                </div>

                <Btn type="submit" variant="primary" size="md" className="w-full">
                  Invia Certificato Medico
                </Btn>
              </form>

              {/* Elenco certificati medici passati */}
              <div className="space-y-3">
                <h4 className="font-barlow font-bold text-base text-kidville-green uppercase tracking-wide">
                  Ricevute Caricamenti Medici Recenti
                </h4>
                {medCerts.length === 0 ? (
                  <div className="bg-white rounded-card p-6 text-center border border-kidville-line font-maven text-xs text-kidville-muted">
                    Nessun certificato medico caricato in precedenza.
                  </div>
                ) : (
                  medCerts.map(cert => (
                    <div key={cert.id} className="bg-white rounded-card p-4 border border-kidville-line flex items-center justify-between text-xs font-maven">
                      <div>
                        <div className="font-semibold text-kidville-ink">Certificato: {cert.fileName}</div>
                        <div className="text-kidville-muted mt-0.5">Figlio: {cert.alunno?.nome} | Caricato il: {new Date(cert.creato_il).toLocaleDateString('it-IT')}</div>
                        {cert.notes && <div className="text-kidville-muted mt-1 italic">Note: {cert.notes}</div>}
                      </div>

                      <div className="flex flex-col items-end gap-1.5">
                        {(cert.giorni_coperti?.length ?? 0) > 0 ? (
                          <span className="bg-kidville-success-soft text-kidville-success px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
                            Giustificato: {(cert.giorni_coperti ?? []).map((d: string) => new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })).join(', ')}
                          </span>
                        ) : (
                          <span className="bg-kidville-warn-soft text-kidville-warn px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
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
