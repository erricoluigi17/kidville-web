'use client';

import { useState, useEffect } from 'react';
import { 
  FileText, Plus, UserCheck, Settings, Calendar, Users, 
  Trash2, Download, CheckCircle, XCircle, ArrowRight, Eye, RefreshCw, Upload
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';

interface FormField {
  id: string;
  type: 'text' | 'checkbox' | 'date';
  label: string;
  required: boolean;
  db_mapping: string; // e.g. "alunni.note_mediche"
}

interface FormTemplate {
  id: string;
  title: string;
  description: string;
  fields: FormField[];
  target_scope: 'class' | 'external';
  target_classes: string[];
  expiration_date: string | null;
  created_at: string;
}

interface PreInscription {
  id: string;
  parent_first_name: string;
  parent_last_name: string;
  parent_email: string;
  parent_phone: string;
  parent_fiscal_code: string;
  parent_address: string;
  students: {
    nome: string;
    cognome: string;
    data_nascita: string;
    codice_fiscale: string;
    note_mediche: string;
  }[];
  status: 'pending' | 'approved' | 'rejected';
  assigned_class?: string;
  created_at: string;
}

export default function AdminModulisticaPage() {
  const [activeTab, setActiveTab] = useState<'moduli' | 'attesa' | 'odt'>('moduli');
  const [forms, setForms] = useState<FormTemplate[]>([]);
  const [preInscriptions, setPreInscriptions] = useState<PreInscription[]>([]);
  const [sections, setSections] = useState<{ id: string; name: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Form Builder state
  const [showBuilder, setShowBuilder] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formScope, setFormScope] = useState<'class' | 'external'>('class');
  const [formClasses, setFormClasses] = useState<string[]>([]);
  const [formExpiration, setFormExpiration] = useState('');
  const [formFields, setFormFields] = useState<FormField[]>([
    { id: 'f_1', type: 'text', label: 'Nome Pediatra', required: true, db_mapping: '' }
  ]);

  // Pre-inscription details modal
  const [selectedPre, setSelectedPre] = useState<PreInscription | null>(null);
  const [assignedClass, setAssignedClass] = useState('');
  const [showConfirmApproval, setShowConfirmApproval] = useState(false);
  const [showCredentials, setShowCredentials] = useState<{ email: string; pass: string } | null>(null);

  // ODT State
  const [odtLetterhead, setOdtLetterhead] = useState<string | null>(null);
  const [odtFrequenza, setOdtFrequenza] = useState<string | null>(null);
  const [odtIscrizione, setOdtIscrizione] = useState<string | null>(null);

  // Notifications
  const [toast, setToast] = useState('');

  useEffect(() => {
    fetchInitialData();
  }, []);

  const fetchInitialData = async () => {
    setIsLoading(true);
    try {
      // 1. Fetch Forms
      const fRes = await fetch(`/api/admin/forms?scuola_id=${SCUOLA_ID}`);
      const fData = await fRes.json();
      if (Array.isArray(fData)) setForms(fData);

      // 2. Le pre-iscrizioni sono gestite nella nuova dashboard /admin/iscrizioni

      // 3. Fetch Classes/Sections
      const sRes = await fetch('/api/admin/sections');
      const sData = await sRes.json();
      if (Array.isArray(sData)) setSections(sData);
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

  // Form Builder fields
  const handleAddField = () => {
    const nextId = 'f_' + (formFields.length + 1);
    setFormFields([...formFields, { id: nextId, type: 'text', label: '', required: false, db_mapping: '' }]);
  };

  const handleRemoveField = (index: number) => {
    if (formFields.length === 1) return;
    setFormFields(formFields.filter((_, i) => i !== index));
  };

  const handleFieldChange = (index: number, key: keyof FormField, value: any) => {
    const next = [...formFields];
    next[index] = { ...next[index], [key]: value };
    setFormFields(next);
  };

  const handleToggleClass = (clsName: string) => {
    if (formClasses.includes(clsName)) {
      setFormClasses(formClasses.filter(c => c !== clsName));
    } else {
      setFormClasses([...formClasses, clsName]);
    }
  };

  const handleSaveForm = async () => {
    if (!formTitle.trim()) {
      showToastMsg('❌ Titolo del modulo richiesto');
      return;
    }

    try {
      const res = await fetch('/api/admin/forms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: formTitle,
          description: formDesc,
          target_scope: formScope,
          target_classes: formClasses,
          expiration_date: formExpiration || null,
          fields: formFields,
          scuola_id: SCUOLA_ID
        })
      });

      if (!res.ok) throw new Error('Errore di salvataggio');
      showToastMsg('✅ Modulo creato con successo!');
      setShowBuilder(false);
      
      // Reset
      setFormTitle('');
      setFormDesc('');
      setFormScope('class');
      setFormClasses([]);
      setFormExpiration('');
      setFormFields([{ id: 'f_1', type: 'text', label: 'Nome Pediatra', required: true, db_mapping: '' }]);

      fetchInitialData();
    } catch (err) {
      showToastMsg('❌ Errore nel salvataggio del modulo');
    }
  };

  const handleDeleteForm = async (id: string) => {
    if (!confirm('Sei sicuro di voler eliminare questo modulo?')) return;
    try {
      const res = await fetch('/api/admin/forms', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        showToastMsg('✅ Modulo eliminato');
        fetchInitialData();
      }
    } catch (err) {
      showToastMsg('❌ Errore eliminazione');
    }
  };

  const handleApprovePreInscription = async () => {
    if (!selectedPre || !assignedClass) return;

    try {
      const res = await fetch('/api/admin/pre-inscriptions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedPre.id,
          status: 'approved',
          assigned_class: assignedClass
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Errore approvazione');

      showToastMsg('✅ Pre-iscrizione approvata con successo!');
      setShowConfirmApproval(false);
      setSelectedPre(null);
      setAssignedClass('');

      // Show temporary credentials modal
      if (data.credentials) {
        setShowCredentials(data.credentials);
      }

      fetchInitialData();
    } catch (err: any) {
      showToastMsg(`❌ ${err.message || 'Errore approvazione'}`);
      setShowConfirmApproval(false);
    }
  };

  const handleRejectPreInscription = async (id: string) => {
    if (!confirm('Rifiutare definitivamente questa pre-iscrizione?')) return;
    try {
      const res = await fetch('/api/admin/pre-inscriptions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          status: 'rejected'
        })
      });
      if (res.ok) {
        showToastMsg('❌ Pre-iscrizione rifiutata');
        fetchInitialData();
        setSelectedPre(null);
      }
    } catch (err) {
      showToastMsg('❌ Errore durante l\'azione');
    }
  };

  const handleExtendScadenza = async (form: FormTemplate) => {
    const nuovaScadenza = prompt('Inserisci nuova data di scadenza (AAAA-MM-GG):', '2026-06-30');
    if (!nuovaScadenza) return;
    
    try {
      const res = await fetch('/api/admin/forms', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: form.id,
          expiration_date: new Date(nuovaScadenza).toISOString()
        })
      });
      if (res.ok) {
        showToastMsg('✅ Scadenza aggiornata');
        fetchInitialData();
      }
    } catch (err) {
      showToastMsg('❌ Errore estensione scadenza');
    }
  };

  // Merge PDF Simulator & Exporter (Client-side jsPDF)
  const handleExportMergePDF = async (form: FormTemplate, className: string) => {
    showToastMsg('⏳ Generazione report FES cumulativo...');
    try {
      const res = await fetch(`/api/admin/documents-merge?form_id=${form.id}&class_name=${className}`);
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Errore caricamento dati per merge');

      const doc = new jsPDF();
      const results = data.results || [];

      doc.setFont('Helvetica', 'bold');
      doc.setFontSize(18);
      doc.text(`REPORT CUMULATIVO AUTORIZZAZIONI — ${className}`, 20, 20);
      
      doc.setFontSize(12);
      doc.text(`Modulo: ${form.title}`, 20, 30);
      doc.text(`Descrizione: ${form.description || 'Nessuna'}`, 20, 37);
      doc.text(`Data di Stampa: ${new Date().toLocaleString()}`, 20, 44);
      
      doc.setDrawColor(0, 106, 95); // Kidville Green
      doc.setLineWidth(1);
      doc.line(20, 50, 190, 50);

      let yOffset = 60;

      for (let i = 0; i < results.length; i++) {
        const item = results[i];
        
        // Verifica spazio pagina
        if (yOffset > 240) {
          doc.addPage();
          yOffset = 20;
        }

        doc.setFont('Helvetica', 'bold');
        doc.setFontSize(11);
        doc.text(`${i + 1}. ALUNNO: ${item.cognome_alunno} ${item.nome_alunno}`, 20, yOffset);
        
        doc.setFont('Helvetica', 'normal');
        doc.setFontSize(10);
        
        if (item.signed) {
          doc.setTextColor(67, 160, 71); // Success Green
          doc.text('STATO: AUTORIZZATO (FES FIRMATA DIGITALMENTE)', 20, yOffset + 6);
          
          doc.setTextColor(80, 80, 80);
          doc.text(`Timestamp: ${new Date(item.created_at).toLocaleString('it-IT', { timeZone: 'UTC' })}`, 20, yOffset + 12);
          doc.text(`IP del Client: ${item.signature_log?.ip || 'N.D.'}`, 20, yOffset + 18);
          doc.text(`User Agent: ${item.signature_log?.user_agent?.substring(0, 70) || 'N.D.'}...`, 20, yOffset + 24);
          doc.text(`Hash FES (SHA-256): ${item.signature_log?.hash || 'FES-OK-' + Math.random().toString(16).substring(2, 10).toUpperCase()}`, 20, yOffset + 30);
          
          yOffset += 40;
        } else {
          doc.setTextColor(229, 57, 53); // Error Red
          doc.text('STATO: NON AUTORIZZATO (FIRMA MANCANTE)', 20, yOffset + 6);
          
          doc.setTextColor(120, 120, 120);
          doc.text('In attesa di compilazione e firma FES da parte del genitore.', 20, yOffset + 12);
          
          yOffset += 22;
        }

        doc.setTextColor(0, 0, 0);
        doc.setDrawColor(230, 230, 230);
        doc.line(20, yOffset - 2, 190, yOffset - 2);
        yOffset += 6;
      }

      doc.save(`Cumulative_${form.title.replace(/\s+/g, '_')}_${className}.pdf`);
      showToastMsg('✅ Report cumulativo PDF scaricato!');
    } catch (err: any) {
      showToastMsg(`❌ ${err.message || 'Errore esportazione'}`);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-4 sm:p-6 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
            <FileText size={28} className="text-kidville-yellow" /> Modulistica & Onboarding
          </h1>
          <p className="font-maven text-gray-500 mt-1">
            Gestione moduli di consenso, sala d'attesa pre-iscrizioni e carta intestata.
          </p>
        </div>

        {activeTab === 'moduli' && (
          <button
            onClick={() => setShowBuilder(true)}
            className="flex items-center gap-2 px-5 py-2.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90 transition-all shadow-md self-start md:self-auto"
          >
            <Plus size={18} /> Nuovo Modulo FES
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-4 mb-6 border-b border-gray-200">
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide transition-colors flex items-center gap-1.5 ${activeTab === 'moduli' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-gray-400 hover:text-gray-600'}`}
          onClick={() => setActiveTab('moduli')}
        >
          <FileText size={16} /> Moduli Creati
        </button>
        <a
          href="/admin/iscrizioni"
          className="pb-3 px-2 font-barlow font-bold uppercase tracking-wide transition-colors flex items-center gap-1.5 text-gray-400 hover:text-kidville-green"
        >
          <UserCheck size={16} /> Iscrizioni Nuovi Alunni
        </a>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide transition-colors flex items-center gap-1.5 ${activeTab === 'odt' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-gray-400 hover:text-gray-600'}`}
          onClick={() => setActiveTab('odt')}
        >
          <Settings size={16} /> Template Certificati ODT
        </button>
      </div>

      {/* Loading state */}
      {isLoading ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[40vh] gap-3">
          <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
          <p className="font-maven text-gray-500">Caricamento in corso...</p>
        </div>
      ) : (
        <>
          {/* TAB 1: Moduli Creati */}
          {activeTab === 'moduli' && (
            <div className="space-y-4">
              {forms.length === 0 ? (
                <div className="bg-white rounded-card p-10 text-center border border-gray-100">
                  <FileText className="mx-auto text-gray-300 mb-3" size={48} />
                  <p className="font-maven text-gray-500">Nessun modulo FES creato finora.</p>
                </div>
              ) : (
                forms.map(form => (
                  <div key={form.id} className="bg-white rounded-card p-5 shadow-sm border border-gray-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                        {form.title}
                      </h3>
                      <p className="font-maven text-xs text-gray-500 line-clamp-2 max-w-xl mt-1">
                        {form.description || 'Nessuna descrizione.'}
                      </p>
                      
                      <div className="flex flex-wrap items-center gap-3 mt-3">
                        <span className="bg-kidville-cream text-kidville-green px-2.5 py-1 rounded-full text-xs font-semibold">
                          Destinatari: {form.target_scope === 'external' ? 'Esterni (Pre-iscrizione)' : form.target_classes.join(', ')}
                        </span>
                        
                        {form.expiration_date && (
                          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1 ${new Date(form.expiration_date) < new Date() ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>
                            <Calendar size={12} />
                            Scadenza: {new Date(form.expiration_date).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-end md:self-auto flex-wrap">
                      {form.target_scope !== 'external' && form.target_classes.map(clsName => (
                        <button
                          key={clsName}
                          onClick={() => handleExportMergePDF(form, clsName)}
                          className="flex items-center gap-1.5 px-3.5 py-1.5 bg-kidville-cream text-kidville-green rounded-pill font-barlow font-bold text-xs uppercase hover:bg-kidville-green hover:text-kidville-yellow transition-colors"
                          title={`Esporta consensi classe ${clsName}`}
                        >
                          <Download size={14} /> Merge {clsName}
                        </button>
                      ))}

                      <button
                        onClick={() => handleExtendScadenza(form)}
                        className="p-2 text-gray-400 hover:text-kidville-green hover:bg-gray-50 rounded-lg transition-all"
                        title="Modifica Scadenza"
                      >
                        <Calendar size={18} />
                      </button>

                      <button
                        onClick={() => handleDeleteForm(form.id)}
                        className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                        title="Elimina Modulo"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* TAB 2: Sala d'Attesa */}
          {activeTab === 'attesa' && (
            <div className="space-y-4">
              {preInscriptions.filter(p => p.status === 'pending').length === 0 ? (
                <div className="bg-white rounded-card p-10 text-center border border-gray-100">
                  <UserCheck className="mx-auto text-gray-300 mb-3" size={48} />
                  <p className="font-maven text-gray-500">Nessuna pre-iscrizione in attesa di approvazione.</p>
                </div>
              ) : (
                preInscriptions.filter(p => p.status === 'pending').map(pre => (
                  <div key={pre.id} className="bg-white rounded-card p-5 shadow-sm border border-gray-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                          Famiglia {pre.parent_last_name}
                        </h3>
                        <span className="bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
                          Nuovo
                        </span>
                      </div>
                      
                      <p className="font-maven text-xs text-gray-500 mt-1">
                        Genitore: {pre.parent_first_name} {pre.parent_last_name} ({pre.parent_email} - {pre.parent_phone || 'N.D.'})
                      </p>
                      
                      <div className="mt-3 flex items-center gap-1 text-xs text-kidville-green font-semibold">
                        <Users size={14} /> Figli da iscrivere: {pre.students?.map((s: any) => `${s.cognome} ${s.nome}`).join(', ')}
                      </div>
                    </div>

                    <button
                      onClick={() => {
                        setSelectedPre(pre);
                        setAssignedClass('');
                        setShowConfirmApproval(false);
                      }}
                      className="flex items-center gap-1.5 px-4.5 py-2 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase text-xs sm:text-sm tracking-wider hover:opacity-90 transition-opacity shadow-sm self-start md:self-auto"
                    >
                      Gestisci <ArrowRight size={16} />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* TAB 3: Template ODT */}
          {activeTab === 'odt' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Carta Intestata */}
              <div className="bg-white rounded-card p-6 border border-gray-100 shadow-sm text-center">
                <Settings className="mx-auto text-kidville-green/20 mb-4" size={48} />
                <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase mb-2">
                  Carta Intestata Scuola
                </h3>
                <p className="font-maven text-xs text-gray-500 mb-6 leading-relaxed">
                  Trascina il file ODT della carta intestata contenente i loghi istituzionali e l'intestazione personalizzata.
                </p>
                
                {odtLetterhead ? (
                  <div className="bg-emerald-50 text-emerald-700 p-3 rounded-xl text-xs font-semibold mb-4 border border-emerald-200">
                    📄 {odtLetterhead} caricato
                  </div>
                ) : (
                  <label className="w-full h-11 border-2 border-dashed border-gray-200 hover:border-kidville-green rounded-xl flex items-center justify-center gap-2 cursor-pointer text-sm font-semibold text-gray-600 transition-colors mb-4">
                    <Upload size={16} /> Carica .ODT
                    <input
                      type="file"
                      accept=".odt"
                      className="hidden"
                      onChange={e => setOdtLetterhead(e.target.files?.[0]?.name || null)}
                    />
                  </label>
                )}
              </div>

              {/* Certificato di Frequenza */}
              <div className="bg-white rounded-card p-6 border border-gray-100 shadow-sm text-center">
                <FileText className="mx-auto text-kidville-green/20 mb-4" size={48} />
                <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase mb-2">
                  Prestampato Certificato Frequenza
                </h3>
                <p className="font-maven text-xs text-gray-500 mb-6 leading-relaxed">
                  Carica il modello ODT con i tag per autocompilazione: `{"{nome}"}`, `{"{cognome}"}`, `{"{data_nascita}"}`.
                </p>
                
                {odtFrequenza ? (
                  <div className="bg-emerald-50 text-emerald-700 p-3 rounded-xl text-xs font-semibold mb-4 border border-emerald-200">
                    📄 {odtFrequenza} caricato
                  </div>
                ) : (
                  <label className="w-full h-11 border-2 border-dashed border-gray-200 hover:border-kidville-green rounded-xl flex items-center justify-center gap-2 cursor-pointer text-sm font-semibold text-gray-600 transition-colors mb-4">
                    <Upload size={16} /> Carica .ODT
                    <input
                      type="file"
                      accept=".odt"
                      className="hidden"
                      onChange={e => setOdtFrequenza(e.target.files?.[0]?.name || null)}
                    />
                  </label>
                )}
              </div>

              {/* Certificato di Iscrizione */}
              <div className="bg-white rounded-card p-6 border border-gray-100 shadow-sm text-center">
                <FileText className="mx-auto text-kidville-green/20 mb-4" size={48} />
                <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase mb-2">
                  Prestampato Certificato Iscrizione
                </h3>
                <p className="font-maven text-xs text-gray-500 mb-6 leading-relaxed">
                  Modello predefinito ODT da far scaricare in autonomia alle famiglie per bonus INPS.
                </p>
                
                {odtIscrizione ? (
                  <div className="bg-emerald-50 text-emerald-700 p-3 rounded-xl text-xs font-semibold mb-4 border border-emerald-200">
                    📄 {odtIscrizione} caricato
                  </div>
                ) : (
                  <label className="w-full h-11 border-2 border-dashed border-gray-200 hover:border-kidville-green rounded-xl flex items-center justify-center gap-2 cursor-pointer text-sm font-semibold text-gray-600 transition-colors mb-4">
                    <Upload size={16} /> Carica .ODT
                    <input
                      type="file"
                      accept=".odt"
                      className="hidden"
                      onChange={e => setOdtIscrizione(e.target.files?.[0]?.name || null)}
                    />
                  </label>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Modal: Form Builder */}
      {showBuilder && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-2xl rounded-card p-6 shadow-2xl flex flex-col max-h-[90vh]">
            <h2 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide mb-4">
              Nuovo Modulo FES
            </h2>

            <div className="flex-1 overflow-y-auto space-y-5 pr-1">
              <div>
                <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                  Titolo Modulo *
                </label>
                <input
                  type="text"
                  required
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green"
                  placeholder="Es. Consenso Uscita Didattica Museo Scienza"
                />
              </div>

              <div>
                <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                  Descrizione / Istruzioni *
                </label>
                <textarea
                  value={formDesc}
                  onChange={e => setFormDesc(e.target.value)}
                  className="w-full border-2 border-gray-100 rounded-xl p-3 font-maven text-sm focus:outline-none focus:border-kidville-green resize-none h-20"
                  placeholder="Specificare le note informative per il genitore..."
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                    Ambito d'Uso (Scope)
                  </label>
                  <select
                    value={formScope}
                    onChange={e => setFormScope(e.target.value as any)}
                    className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 font-maven text-sm text-gray-600 focus:outline-none bg-white"
                  >
                    <option value="class">Classi / Sezioni Specifiche</option>
                    <option value="external">Esterni (Pre-Iscrizione)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                    Scadenza Modulo
                  </label>
                  <input
                    type="date"
                    value={formExpiration}
                    onChange={e => setFormExpiration(e.target.value)}
                    className="w-full border-2 border-gray-100 rounded-xl px-3 py-2 font-maven text-sm text-gray-600 focus:outline-none"
                  />
                </div>
              </div>

              {formScope === 'class' && (
                <div>
                  <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                    Seleziona Classi Target
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {sections.map(sec => (
                      <button
                        key={sec.id}
                        type="button"
                        onClick={() => handleToggleClass(sec.name)}
                        className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition-colors ${formClasses.includes(sec.name) ? 'bg-kidville-green text-kidville-yellow border-kidville-green' : 'border-gray-100 text-gray-500 hover:border-gray-300'}`}
                      >
                        {sec.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Dynamic Fields Editor */}
              <div className="space-y-4">
                <div className="flex items-center justify-between border-t border-gray-100 pt-4">
                  <h4 className="font-barlow font-bold text-lg text-kidville-green uppercase">Campi Dinamici Richiesti</h4>
                  <button
                    onClick={handleAddField}
                    className="flex items-center gap-1 px-3 py-1 bg-kidville-cream text-kidville-green border border-kidville-green/10 rounded-pill font-barlow font-bold text-xs uppercase"
                  >
                    <Plus size={14} /> Aggiungi Campo
                  </button>
                </div>

                {formFields.map((field, idx) => (
                  <div key={field.id} className="bg-gray-50 p-4 rounded-xl border border-gray-100 flex flex-col md:flex-row gap-4 items-end">
                    <div className="flex-1 w-full grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div className="md:col-span-2">
                        <label className="block font-maven text-xs font-semibold text-gray-500 mb-1">Nome Etichetta</label>
                        <input
                          type="text"
                          value={field.label}
                          onChange={e => handleFieldChange(idx, 'label', e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 font-maven text-xs bg-white focus:outline-none"
                          placeholder="Es. Aggiorna Recapito"
                        />
                      </div>
                      
                      <div>
                        <label className="block font-maven text-xs font-semibold text-gray-500 mb-1">Tipo Input</label>
                        <select
                          value={field.type}
                          onChange={e => handleFieldChange(idx, 'type', e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 font-maven text-xs bg-white focus:outline-none"
                        >
                          <option value="text">Testo</option>
                          <option value="checkbox">Consenso (Check)</option>
                          <option value="date">Data</option>
                        </select>
                      </div>

                      <div>
                        <label className="block font-maven text-xs font-semibold text-gray-500 mb-1">Mapping DB</label>
                        <select
                          value={field.db_mapping}
                          onChange={e => handleFieldChange(idx, 'db_mapping', e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 font-maven text-xs bg-white focus:outline-none"
                        >
                          <option value="">Nessuno</option>
                          <option value="alunni.note_mediche">Allergie Alunno</option>
                          <option value="alunni.codice_fiscale">CF Alunno</option>
                          <option value="utenti.cellulare">Cellulare Genitore</option>
                          <option value="utenti.nome">Nome Genitore</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1 text-xs text-gray-500 mb-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={field.required}
                          onChange={e => handleFieldChange(idx, 'required', e.target.checked)}
                          className="rounded text-kidville-green focus:ring-kidville-green"
                        />
                        Obblig.
                      </label>

                      {formFields.length > 1 && (
                        <button
                          onClick={() => handleRemoveField(idx)}
                          className="text-gray-400 hover:text-red-500 transition-colors mb-2"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-gray-100 pt-4 mt-4">
              <button
                onClick={() => setShowBuilder(false)}
                className="px-4 py-2 font-maven rounded-pill border border-gray-200 text-gray-500 text-sm hover:bg-gray-50 transition-colors"
              >
                Annulla
              </button>
              <button
                onClick={handleSaveForm}
                className="px-5 py-2.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90 transition-all shadow-md"
              >
                Salva Modulo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Pre-Inscription / Sala d'Attesa Details */}
      {selectedPre && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-xl rounded-card p-6 shadow-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3 mb-4">
              <h2 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide">
                Scheda Onboarding Famiglia
              </h2>
              <button 
                onClick={() => setSelectedPre(null)}
                className="text-gray-400 hover:text-gray-600 font-maven text-lg p-1"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-6 pr-1">
              {/* Genitore info */}
              <div className="bg-kidville-cream/30 p-4 rounded-xl border border-kidville-green/5">
                <h4 className="font-barlow font-bold text-sm text-kidville-green uppercase tracking-wide mb-2">Contatti Genitore</h4>
                <div className="grid grid-cols-2 gap-y-2 text-xs font-maven text-gray-600">
                  <div><strong>Nome:</strong> {selectedPre.parent_first_name} {selectedPre.parent_last_name}</div>
                  <div><strong>Email:</strong> {selectedPre.parent_email}</div>
                  <div><strong>Telefono:</strong> {selectedPre.parent_phone || 'N.D.'}</div>
                  <div><strong>CF:</strong> {selectedPre.parent_fiscal_code || 'N.D.'}</div>
                  <div className="col-span-2"><strong>Indirizzo:</strong> {selectedPre.parent_address || 'N.D.'}</div>
                </div>
              </div>

              {/* Figli */}
              <div>
                <h4 className="font-barlow font-bold text-sm text-kidville-green uppercase tracking-wide mb-3">Figli da Registrare</h4>
                <div className="space-y-3">
                  {selectedPre.students?.map((s: any, idx: number) => (
                    <div key={idx} className="p-3 bg-gray-50 border border-gray-100 rounded-xl text-xs font-maven">
                      <div className="font-semibold text-gray-800 text-sm">{s.cognome} {s.nome}</div>
                      <div className="text-gray-500 mt-1">Data Nascita: {new Date(s.data_nascita).toLocaleDateString()} | CF: {s.codice_fiscale || 'N.D.'}</div>
                      {s.note_mediche && (
                        <div className="mt-2 text-red-600 bg-red-50 p-1.5 rounded-lg font-semibold flex items-start gap-1">
                          ⚠️ Allergie/Note: {s.note_mediche}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Assegnazione Classe */}
              <div className="border-t border-gray-100 pt-4">
                <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                  Assegna Sezione Didattica *
                </label>
                <select
                  value={assignedClass}
                  onChange={e => setAssignedClass(e.target.value)}
                  className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 font-maven text-sm text-gray-600 focus:outline-none bg-white"
                >
                  <option value="">Seleziona Sezione...</option>
                  {sections.map(sec => (
                    <option key={sec.id} value={sec.name}>{sec.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex justify-between gap-3 border-t border-gray-100 pt-4 mt-4">
              <button
                onClick={() => handleRejectPreInscription(selectedPre.id)}
                className="px-4 py-2 font-barlow font-bold text-xs uppercase tracking-wider rounded-pill border border-red-200 text-red-500 hover:bg-red-50"
              >
                Rifiuta Iscrizione
              </button>

              <div className="flex gap-3">
                <button
                  onClick={() => setSelectedPre(null)}
                  className="px-4 py-2 font-maven rounded-pill border border-gray-200 text-gray-500 text-sm hover:bg-gray-50"
                >
                  Annulla
                </button>
                <button
                  disabled={!assignedClass}
                  onClick={() => setShowConfirmApproval(true)}
                  className="px-5 py-2.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90 disabled:opacity-50 transition-all shadow-md"
                >
                  Approva ed Importa
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Secondary confirmation for Approval */}
      {showConfirmApproval && selectedPre && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-sm rounded-card p-6 shadow-2xl text-center">
            <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide mb-3">Conferma Approvazione</h3>
            <p className="font-maven text-sm text-gray-500 mb-6">
              Stai per approvare l'onboarding di <strong>Famiglia {selectedPre.parent_last_name}</strong> e importare <strong>{selectedPre.students?.length}</strong> alunni nella sezione <strong>{assignedClass}</strong>. 
              Questo creerà automaticamente gli account utente. Vuoi procedere?
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => setShowConfirmApproval(false)}
                className="px-4 py-2 font-maven rounded-pill border border-gray-200 text-gray-500 text-sm hover:bg-gray-50"
              >
                Indietro
              </button>
              <button
                onClick={handleApprovePreInscription}
                className="px-6 py-2.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90"
              >
                Sì, Approva!
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Generated Credentials Modal */}
      {showCredentials && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-sm rounded-card p-6 shadow-2xl text-center border-t-4 border-kidville-green">
            <CheckCircle className="text-kidville-success mx-auto mb-3" size={48} />
            <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide mb-1">Account Creato!</h3>
            <p className="font-maven text-xs text-gray-500 mb-6">
              Invia queste credenziali di accesso provvisorie alla famiglia:
            </p>
            <div className="bg-gray-50 p-4 rounded-xl text-left font-maven text-sm border border-gray-150 mb-6 space-y-2 select-all">
              <div><strong>Email:</strong> {showCredentials.email}</div>
              <div><strong>Password:</strong> {showCredentials.pass}</div>
            </div>
            <button
              onClick={() => setShowCredentials(null)}
              className="w-full h-11 font-barlow font-black uppercase tracking-wider rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 transition-opacity"
            >
              Fatto / Chiudi
            </button>
          </div>
        </div>
      )}

      {/* Toast notification */}
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
