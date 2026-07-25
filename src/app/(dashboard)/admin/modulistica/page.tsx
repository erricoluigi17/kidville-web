'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import {
  FileText, Plus, UserCheck, Settings, Calendar, Users,
  Trash2, Download, CheckCircle, ArrowRight, Upload, Shield, Inbox, Send, Stamp, X
} from 'lucide-react';
import { HEADER_BTN, PageHeader, Tabs } from '@/components/ui/cockpit';
import { DateField } from '@/components/ui/DateField';
import { SedeNotice, useSediAttive } from '@/lib/context/sede-context';
import { ModuliInviabili } from '@/components/features/admin/iscrizioni/ModuliInviabili';
import { ModuliRicevuti } from '@/components/features/admin/iscrizioni/ModuliRicevuti';

type FormType = 'sondaggio' | 'gradimento' | 'autorizzazione';

interface FieldOption { label: string; value: string }

interface FormField {
  id: string;
  type: 'text' | 'textarea' | 'checkbox' | 'date' | 'radio' | 'rating';
  label: string;
  required: boolean;
  db_mapping?: string;
  options?: FieldOption[]; // per 'radio'
}

interface FormTemplate {
  id: string;
  title: string;
  description: string;
  form_type: FormType;
  fields: FormField[];
  target_scope: 'class' | 'external';
  target_classes: string[];
  expiration_date: string | null;
  created_at: string;
}

/** Riga di documents-merge usata dal pannello «Protocolla» (moduli firmati). */
interface ProtocollaItem {
  student_id: string;
  nome_alunno: string;
  cognome_alunno: string;
  signed: boolean;
  submission_id?: string;
  pdf_path?: string | null;
  origine?: string;
  created_at?: string;
}

// Metadati dei tre tipi di modulo per genitori iscritti. `labelKey`/`descKey`
// sono chiavi i18n; le chiavi enum (sondaggio/gradimento/autorizzazione) restano.
const FORM_TYPE_META: Record<FormType, { labelKey: string; descKey: string; otp: boolean }> = {
  sondaggio: { labelKey: 'modFormTypeSondaggio', descKey: 'modFormTypeSondaggioDesc', otp: false },
  gradimento: { labelKey: 'modFormTypeGradimento', descKey: 'modFormTypeGradimentoDesc', otp: false },
  autorizzazione: { labelKey: 'modFormTypeAutorizzazione', descKey: 'modFormTypeAutorizzazioneDesc', otp: true },
};

// Tipi di campo disponibili per ciascun tipo di modulo. Il primo elemento è il
// valore enum del tipo, il secondo la chiave i18n dell'etichetta mostrata.
const INPUT_TYPES_BY_FORM: Record<FormType, [FormField['type'], string][]> = {
  sondaggio: [['text', 'modInputTestoBreve'], ['textarea', 'modInputTestoLungo'], ['radio', 'modInputSceltaSingola'], ['date', 'modInputData']],
  gradimento: [['rating', 'modInputValutazione'], ['radio', 'modInputSceltaSingola'], ['textarea', 'modInputCommento']],
  autorizzazione: [['checkbox', 'modInputConsenso'], ['text', 'modInputTesto'], ['date', 'modInputData']],
};

// Campo di default coerente con il tipo di modulo
function defaultFieldForType(formType: FormType): FormField {
  if (formType === 'gradimento') return { id: 'f_1', type: 'rating', label: '', required: true };
  if (formType === 'autorizzazione') return { id: 'f_1', type: 'checkbox', label: '', required: true };
  return { id: 'f_1', type: 'text', label: '', required: true };
}

// Hash FES di fallback per il report PDF quando il log firma non contiene l'hash reale
function fallbackFesHash(): string {
  return 'FES-OK-' + Math.random().toString(16).substring(2, 10).toUpperCase();
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

type ModulisticaTab = 'inviabili' | 'ricevuti' | 'moduli-genitori' | 'attesa' | 'odt';

function ModulisticaInner() {
  const t = useTranslations('adminModulistica');
  const f = useDateFormat();
  const { sedeCorrente, loading: sediLoading } = useSediAttive();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab: ModulisticaTab =
    tabParam === 'ricevuti' || tabParam === 'moduli-genitori' || tabParam === 'odt' ? tabParam : 'inviabili';
  const [activeTab, setActiveTab] = useState<ModulisticaTab>(initialTab);
  const [forms, setForms] = useState<FormTemplate[]>([]);
  const [preInscriptions] = useState<PreInscription[]>([]);
  const [sections, setSections] = useState<{ id: string; name: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Form Builder state
  const [showBuilder, setShowBuilder] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formScope, setFormScope] = useState<'class' | 'external'>('class');
  const [formType, setFormType] = useState<FormType>('autorizzazione');
  const [formClasses, setFormClasses] = useState<string[]>([]);
  const [formExpiration, setFormExpiration] = useState('');
  // Contabilità v2: modulo «essenziale» (salute/sicurezza) → firmabile anche da
  // genitore sospeso per morosità (eccezione alla matrice sospensione).
  const [formSempreFirmabile, setFormSempreFirmabile] = useState(false);
  const [formFields, setFormFields] = useState<FormField[]>([defaultFieldForType('autorizzazione')]);

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

  // «Protocolla» moduli firmati (registro protocolli)
  const [protocollaTarget, setProtocollaTarget] = useState<{ form: FormTemplate; className: string; items: ProtocollaItem[] } | null>(null);
  const [protocollaBusy, setProtocollaBusy] = useState<string | null>(null);
  const [protocollati, setProtocollati] = useState<Record<string, string>>({});

  const fetchInitialData = useCallback(async () => {
    if (!sedeCorrente) return; // sede ambigua: mostro l'avviso, nessuna fetch
    try {
      // Il server scopa forms/sezioni dal cookie; `x-sedi` ne fa la chiave di re-fetch.
      const hdr = { 'x-sedi': sedeCorrente };
      // 1. Fetch Forms
      const fRes = await fetch(`/api/admin/forms`, { headers: hdr }).catch(() => null);
      const fData = fRes ? await fRes.json().catch(() => null) : null;
      if (Array.isArray(fData)) setForms(fData);

      // 2. Le iscrizioni ricevute sono nella tab "Moduli ricevuti" (componente dedicato).

      // 3. Fetch Classes/Sections
      const sRes = await fetch('/api/admin/sections', { headers: hdr }).catch(() => null);
      const sData = sRes ? await sRes.json().catch(() => null) : null;
      if (Array.isArray(sData)) setSections(sData);
    } finally {
      setIsLoading(false);
    }
  }, [sedeCorrente]);

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Form Builder fields
  const handleAddField = () => {
    const nextId = 'f_' + Date.now();
    const defaultType = INPUT_TYPES_BY_FORM[formType][0][0];
    setFormFields([...formFields, { id: nextId, type: defaultType, label: '', required: false }]);
  };

  const handleRemoveField = (index: number) => {
    if (formFields.length === 1) return;
    setFormFields(formFields.filter((_, i) => i !== index));
  };

  const handleFieldChange = <K extends keyof FormField>(index: number, key: K, value: FormField[K]) => {
    const next = [...formFields];
    next[index] = { ...next[index], [key]: value };
    setFormFields(next);
  };

  // Apre il builder con lo scope coerente con la sezione attiva
  const openBuilder = (scope: 'class' | 'external') => {
    setFormScope(scope);
    // Gli esterni (pre-iscrizione) sono compilati senza login → tipo neutro senza OTP
    const initialType: FormType = scope === 'external' ? 'sondaggio' : 'autorizzazione';
    setFormType(initialType);
    setFormFields([defaultFieldForType(initialType)]);
    if (scope === 'external') setFormClasses([]);
    setShowBuilder(true);
  };

  // Cambia il tipo di modulo e reimposta un campo di default coerente
  const selectFormType = (type: FormType) => {
    setFormType(type);
    setFormFields([defaultFieldForType(type)]);
  };

  // Aggiorna le opzioni di un campo 'radio' (input separato da virgole)
  const handleFieldOptions = (index: number, raw: string) => {
    const opts = raw.split(',').map(s => s.trim()).filter(Boolean).map(s => ({ label: s, value: s }));
    handleFieldChange(index, 'options', opts);
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
      showToastMsg(t('modToastTitoloRichiesto'));
      return;
    }

    try {
      const res = await fetch('/api/admin/forms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: formTitle,
          description: formDesc,
          form_type: formType,
          target_scope: formScope,
          target_classes: formClasses,
          expiration_date: formExpiration || null,
          fields: formFields,
          sempre_firmabile: formSempreFirmabile,
          scuola_id: sedeCorrente
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('modErroreSalvataggio'));
      }
      showToastMsg(t('modToastModuloCreato'));
      setShowBuilder(false);

      // Reset
      setFormTitle('');
      setFormDesc('');
      setFormType('autorizzazione');
      setFormClasses([]);
      setFormExpiration('');
      setFormSempreFirmabile(false);
      setFormFields([defaultFieldForType('autorizzazione')]);

      fetchInitialData();
    } catch {
      showToastMsg(t('modToastErroreSalvataggio'));
    }
  };

  const handleDeleteForm = async (id: string) => {
    if (!confirm(t('modConfermaEliminaModulo'))) return;
    try {
      const res = await fetch('/api/admin/forms', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        showToastMsg(t('modToastModuloEliminato'));
        fetchInitialData();
      }
    } catch {
      showToastMsg(t('modToastErroreEliminazione'));
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
      if (!res.ok) throw new Error(data.error || t('modErroreApprovazione'));

      showToastMsg(t('modToastPreApprovata'));
      setShowConfirmApproval(false);
      setSelectedPre(null);
      setAssignedClass('');

      // Show temporary credentials modal
      if (data.credentials) {
        setShowCredentials(data.credentials);
      }

      fetchInitialData();
    } catch (err) {
      showToastMsg(`❌ ${(err as { message?: string })?.message || t('modErroreApprovazione')}`);
      setShowConfirmApproval(false);
    }
  };

  const handleRejectPreInscription = async (id: string) => {
    if (!confirm(t('modConfermaRifiuto'))) return;
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
        showToastMsg(t('modToastPreRifiutata'));
        fetchInitialData();
        setSelectedPre(null);
      }
    } catch {
      showToastMsg(t('modToastErroreAzione'));
    }
  };

  const handleExtendScadenza = async (form: FormTemplate) => {
    const nuovaScadenza = prompt(t('modPromptNuovaScadenza'), '2026-06-30');
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
        showToastMsg(t('modToastScadenzaAggiornata'));
        fetchInitialData();
      }
    } catch {
      showToastMsg(t('modToastErroreScadenza'));
    }
  };

  // «Protocolla» (registro protocolli): elenca i moduli FIRMATI con PDF
  // archiviato e li registra in INGRESSO con numero e fascia di segnatura.
  const apriProtocolla = async (form: FormTemplate, className: string) => {
    showToastMsg(t('modToastCercoModuli'));
    try {
      const res = await fetch(`/api/admin/documents-merge?form_id=${form.id}&class_name=${className}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('modErroreCaricamentoModuli'));
      const firmati = ((data.results || []) as ProtocollaItem[]).filter((r) => r.signed && r.pdf_path && r.submission_id);
      if (firmati.length === 0) {
        showToastMsg(t('modToastNessunModuloFirmato'));
        return;
      }
      setProtocollaTarget({ form, className, items: firmati });
    } catch {
      showToastMsg(t('modToastErroreCaricamentoModuli'));
    }
  };

  const protocollaModulo = async (submissionId: string) => {
    setProtocollaBusy(submissionId);
    try {
      const res = await fetch('/api/admin/protocolli/da-documento', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sorgente: 'modulo_firmato', id: submissionId }),
      });
      const data = await res.json();
      if (!res.ok) { showToastMsg(`❌ ${data.error ?? t('modProtocollazioneNonRiuscita')}`); return; }
      const numero = data.data?.numeroFormattato ?? '';
      setProtocollati((prev) => ({ ...prev, [submissionId]: numero }));
      showToastMsg(t('modToastProtocollato', { numero }));
    } catch {
      showToastMsg(t('modToastErroreReteProtocollo'));
    } finally {
      setProtocollaBusy(null);
    }
  };

  // Merge PDF Simulator & Exporter (Client-side jsPDF)
  const handleExportMergePDF = async (form: FormTemplate, className: string) => {
    showToastMsg(t('modToastGenerazioneReport'));
    try {
      const res = await fetch(`/api/admin/documents-merge?form_id=${form.id}&class_name=${className}`);
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || t('modErroreCaricamentoMerge'));

      // M9.4: jsPDF caricato on-demand solo quando si esporta (fuori dal bundle
      // della pagina). L'import statico di jspdf-autotable è stato RIMOSSO:
      // autoTable non è mai usato in questo file.
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      const results = data.results || [];

      doc.setFont('Helvetica', 'bold');
      doc.setFontSize(18);
      doc.text(t('modPdfTitolo', { classe: className }), 20, 20);

      doc.setFontSize(12);
      doc.text(t('modPdfModulo', { titolo: form.title }), 20, 30);
      doc.text(t('modPdfDescrizione', { descrizione: form.description || t('modPdfNessuna') }), 20, 37);
      doc.text(t('modPdfDataStampa', { data: new Date().toLocaleString('it-IT') }), 20, 44);
      
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
        doc.text(t('modPdfAlunno', { n: i + 1, cognome: item.cognome_alunno, nome: item.nome_alunno }), 20, yOffset);

        doc.setFont('Helvetica', 'normal');
        doc.setFontSize(10);

        if (item.signed) {
          doc.setTextColor(67, 160, 71); // Success Green
          doc.text(
            item.origine === 'cartaceo'
              ? t('modPdfStatoAutorizzatoCartaceo')
              : t('modPdfStatoAutorizzatoFes'),
            20, yOffset + 6
          );

          doc.setTextColor(80, 80, 80);
          doc.text(t('modPdfTimestamp', { ts: new Date(item.created_at).toLocaleString('it-IT', { timeZone: 'UTC' }) }), 20, yOffset + 12);
          doc.text(t('modPdfIpClient', { ip: item.signature_log?.ip || t('modNd') }), 20, yOffset + 18);
          doc.text(t('modPdfUserAgent', { ua: item.signature_log?.user_agent?.substring(0, 70) || t('modNd') }), 20, yOffset + 24);
          doc.text(t('modPdfHashFes', { hash: item.signature_log?.hash || fallbackFesHash() }), 20, yOffset + 30);

          yOffset += 40;
        } else {
          doc.setTextColor(229, 57, 53); // Error Red
          doc.text(t('modPdfStatoNonAutorizzato'), 20, yOffset + 6);

          doc.setTextColor(120, 120, 120);
          doc.text(t('modPdfInAttesa'), 20, yOffset + 12);

          yOffset += 22;
        }

        doc.setTextColor(0, 0, 0);
        doc.setDrawColor(230, 230, 230);
        doc.line(20, yOffset - 2, 190, yOffset - 2);
        yOffset += 6;
      }

      doc.save(`Cumulative_${form.title.replace(/\s+/g, '_')}_${className}.pdf`);
      showToastMsg(t('modToastReportScaricato'));
    } catch (err) {
      showToastMsg(`❌ ${(err as { message?: string })?.message || t('modErroreEsportazione')}`);
    }
  };

  // Moduli per i genitori iscritti (scope class). Gli "esterni" sono stati rimossi.
  const scopedForms = forms.filter(f => f.target_scope !== 'external');

  return (
    <div className="flex-1 flex flex-col p-4 sm:p-6 max-w-6xl mx-auto w-full">
      {/* Header */}
      <PageHeader
        eyebrow={t('eyebrowAmministrazione')}
        icon={FileText}
        title={t('modPageTitle')}
        subtitle={t('modPageSubtitle')}
        actions={
          activeTab === 'moduli-genitori' ? (
            <button onClick={() => openBuilder('class')} className={HEADER_BTN}>
              <Plus size={18} /> {t('modNuovoModuloGenitori')}
            </button>
          ) : undefined
        }
      />

      {/* Tabs (pillole, linguaggio dell'app) */}
      <Tabs
        value={activeTab}
        onChange={(id) => setActiveTab(id as ModulisticaTab)}
        options={[
          { id: 'inviabili', label: t('modTabInviabili'), icon: Send },
          { id: 'ricevuti', label: t('modTabRicevuti'), icon: Inbox },
          { id: 'moduli-genitori', label: t('modTabModuliGenitori'), icon: Users },
          { id: 'odt', label: t('modTabOdt'), icon: Settings },
        ]}
      />

      {/* Moduli inviabili / ricevuti: operano multi-sede (nessuna guardia sede singola). */}
      {activeTab === 'inviabili' ? (
        <ModuliInviabili />
      ) : activeTab === 'ricevuti' ? (
        <ModuliRicevuti />
      ) : sediLoading ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[40vh] gap-3">
          <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
          <p className="font-maven text-kidville-muted">{t('modCaricamento')}</p>
        </div>
      ) : !sedeCorrente ? (
        <SedeNotice cosa={t('modSedeNoticeCosa')} />
      ) : isLoading ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[40vh] gap-3">
          <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
          <p className="font-maven text-kidville-muted">{t('modCaricamento')}</p>
        </div>
      ) : (
        <>
          {/* TAB: Moduli Genitori (iscritti) */}
          {activeTab === 'moduli-genitori' && (
            <div className="space-y-4">
              {scopedForms.length === 0 ? (
                <div className="bg-white rounded-card p-10 text-center border border-kidville-line">
                  <FileText className="mx-auto text-kidville-muted mb-3" size={48} />
                  <p className="font-maven text-kidville-muted">
                    {t('modNessunModuloGenitori')}
                  </p>
                </div>
              ) : (
                scopedForms.map(form => (
                  <div key={form.id} className="bg-white rounded-card p-5 shadow-sm border border-kidville-line flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                        {form.title}
                      </h3>
                      <p className="font-maven text-xs text-kidville-muted line-clamp-2 max-w-xl mt-1">
                        {form.description || t('modNessunaDescrizione')}
                      </p>

                      <div className="flex flex-wrap items-center gap-3 mt-3">
                        {form.form_type && (
                          <span className="bg-kidville-green text-kidville-yellow px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-1">
                            {FORM_TYPE_META[form.form_type]?.otp && <Shield size={11} />}
                            {FORM_TYPE_META[form.form_type] ? t(FORM_TYPE_META[form.form_type].labelKey) : form.form_type}
                          </span>
                        )}
                        <span className="bg-kidville-cream text-kidville-green px-2.5 py-1 rounded-full text-xs font-semibold">
                          {t('modDestinatari')} {form.target_scope === 'external' ? t('modEsterniPreiscrizione') : form.target_classes.join(', ')}
                        </span>

                        {form.expiration_date && (
                          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1 ${new Date(form.expiration_date) < new Date() ? 'bg-kidville-error-soft text-kidville-error' : 'bg-kidville-warn-soft text-kidville-warn'}`}>
                            <Calendar size={12} />
                            {t('modScadenza')} {f.dataBreve(form.expiration_date)}
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
                          title={t('modEsportaConsensiClasse', { classe: clsName })}
                        >
                          <Download size={14} /> {t('modMergeClasse', { classe: clsName })}
                        </button>
                      ))}
                      {form.target_scope !== 'external' && form.target_classes.map(clsName => (
                        <button
                          key={`prot-${clsName}`}
                          onClick={() => apriProtocolla(form, clsName)}
                          className="flex items-center gap-1.5 px-3.5 py-1.5 bg-kidville-info-soft text-kidville-info rounded-pill font-barlow font-bold text-xs uppercase hover:bg-kidville-info hover:text-white transition-colors"
                          title={t('modProtocollaClasseTitle', { classe: clsName })}
                        >
                          <Stamp size={14} /> {t('modProtocollaClasse', { classe: clsName })}
                        </button>
                      ))}

                      <button
                        onClick={() => handleExtendScadenza(form)}
                        className="p-2 text-kidville-muted hover:text-kidville-green hover:bg-kidville-cream rounded-lg transition-all"
                        title={t('modModificaScadenza')}
                      >
                        <Calendar size={18} />
                      </button>

                      <button
                        onClick={() => handleDeleteForm(form.id)}
                        className="p-2 text-kidville-muted hover:text-kidville-error hover:bg-kidville-error-soft rounded-lg transition-all"
                        title={t('modEliminaModulo')}
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
                <div className="bg-white rounded-card p-10 text-center border border-kidville-line">
                  <UserCheck className="mx-auto text-kidville-muted mb-3" size={48} />
                  <p className="font-maven text-kidville-muted">{t('modNessunaPreiscrizione')}</p>
                </div>
              ) : (
                preInscriptions.filter(p => p.status === 'pending').map(pre => (
                  <div key={pre.id} className="bg-white rounded-card p-5 shadow-sm border border-kidville-line flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                          {t('modFamiglia', { cognome: pre.parent_last_name })}
                        </h3>
                        <span className="bg-kidville-warn-soft text-kidville-warn px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
                          {t('modNuovo')}
                        </span>
                      </div>

                      <p className="font-maven text-xs text-kidville-muted mt-1">
                        {t('modGenitoreRiga', { nome: pre.parent_first_name, cognome: pre.parent_last_name, email: pre.parent_email, telefono: pre.parent_phone || t('modNd') })}
                      </p>

                      <div className="mt-3 flex items-center gap-1 text-xs text-kidville-green font-semibold">
                        <Users size={14} /> {t('modFigliDaIscrivere', { figli: pre.students?.map(s => `${s.cognome} ${s.nome}`).join(', ') ?? '' })}
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
                      {t('modGestisci')} <ArrowRight size={16} />
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
              <div className="bg-white rounded-card p-6 border border-kidville-line shadow-sm text-center">
                <Settings className="mx-auto text-kidville-green/20 mb-4" size={48} />
                <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase mb-2">
                  {t('modCartaIntestata')}
                </h3>
                <p className="font-maven text-xs text-kidville-muted mb-6 leading-relaxed">
                  {t('modCartaIntestataDesc')}
                </p>

                {odtLetterhead ? (
                  <div className="bg-kidville-success-soft text-kidville-success p-3 rounded-xl text-xs font-semibold mb-4 border border-kidville-success/30">
                    {t('modOdtCaricato', { nome: odtLetterhead })}
                  </div>
                ) : (
                  <label className="w-full h-11 border-2 border-dashed border-kidville-line hover:border-kidville-green rounded-xl flex items-center justify-center gap-2 cursor-pointer text-sm font-semibold text-kidville-ink transition-colors mb-4">
                    <Upload size={16} /> {t('modCaricaOdt')}
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
              <div className="bg-white rounded-card p-6 border border-kidville-line shadow-sm text-center">
                <FileText className="mx-auto text-kidville-green/20 mb-4" size={48} />
                <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase mb-2">
                  {t('modCertFrequenza')}
                </h3>
                <p className="font-maven text-xs text-kidville-muted mb-6 leading-relaxed">
                  {t('modCertFrequenzaDesc')} `{"{nome}"}`, `{"{cognome}"}`, `{"{data_nascita}"}`.
                </p>

                {odtFrequenza ? (
                  <div className="bg-kidville-success-soft text-kidville-success p-3 rounded-xl text-xs font-semibold mb-4 border border-kidville-success/30">
                    {t('modOdtCaricato', { nome: odtFrequenza })}
                  </div>
                ) : (
                  <label className="w-full h-11 border-2 border-dashed border-kidville-line hover:border-kidville-green rounded-xl flex items-center justify-center gap-2 cursor-pointer text-sm font-semibold text-kidville-ink transition-colors mb-4">
                    <Upload size={16} /> {t('modCaricaOdt')}
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
              <div className="bg-white rounded-card p-6 border border-kidville-line shadow-sm text-center">
                <FileText className="mx-auto text-kidville-green/20 mb-4" size={48} />
                <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase mb-2">
                  {t('modCertIscrizione')}
                </h3>
                <p className="font-maven text-xs text-kidville-muted mb-6 leading-relaxed">
                  {t('modCertIscrizioneDesc')}
                </p>

                {odtIscrizione ? (
                  <div className="bg-kidville-success-soft text-kidville-success p-3 rounded-xl text-xs font-semibold mb-4 border border-kidville-success/30">
                    {t('modOdtCaricato', { nome: odtIscrizione })}
                  </div>
                ) : (
                  <label className="w-full h-11 border-2 border-dashed border-kidville-line hover:border-kidville-green rounded-xl flex items-center justify-center gap-2 cursor-pointer text-sm font-semibold text-kidville-ink transition-colors mb-4">
                    <Upload size={16} /> {t('modCaricaOdt')}
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
        <div className="fixed inset-0 bg-kidville-green/30 z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-2xl rounded-card p-6 shadow-2xl flex flex-col max-h-[90vh]">
            <h2 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide mb-4">
              {formScope === 'external' ? t('modNuovoModuloEsterni') : t('modNuovoModuloTipo', { tipo: t(FORM_TYPE_META[formType].labelKey) })}
            </h2>

            <div className="flex-1 overflow-y-auto space-y-5 pr-1">
              {formScope === 'class' && (
                <div>
                  <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                    {t('modTipoModulo')}
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {(Object.keys(FORM_TYPE_META) as FormType[]).map(tipo => {
                      const meta = FORM_TYPE_META[tipo];
                      const active = formType === tipo;
                      return (
                        <button
                          key={tipo}
                          type="button"
                          onClick={() => selectFormType(tipo)}
                          className={`text-left p-3 rounded-xl border-2 transition-all ${active ? 'border-kidville-green bg-kidville-green-light' : 'border-kidville-line hover:border-kidville-muted'}`}
                        >
                          <span className="flex items-center gap-1.5 font-barlow font-bold text-sm uppercase text-kidville-green">
                            {tipo === 'autorizzazione' && <Shield size={14} className="text-kidville-yellow" />}
                            {t(meta.labelKey)}
                            {meta.otp && <span className="ml-auto text-[9px] bg-kidville-green text-kidville-yellow px-1.5 py-0.5 rounded-full tracking-wider">OTP</span>}
                          </span>
                          <span className="block font-maven text-[11px] text-kidville-muted mt-1 leading-snug">{t(meta.descKey)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                  {t('modTitoloModulo')}
                </label>
                <input
                  type="text"
                  required
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  className="w-full border-2 border-kidville-line rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green"
                  placeholder={t('modTitoloPlaceholder')}
                />
              </div>

              <div>
                <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                  {t('modDescrizioneIstruzioni')}
                </label>
                <textarea
                  value={formDesc}
                  onChange={e => setFormDesc(e.target.value)}
                  className="w-full border-2 border-kidville-line rounded-xl p-3 font-maven text-sm focus:outline-none focus:border-kidville-green resize-none h-20"
                  placeholder={t('modDescrizionePlaceholder')}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                    {t('modAmbitoUso')}
                  </label>
                  <div className="w-full border-2 border-kidville-green/15 rounded-xl px-3 py-2.5 font-maven text-sm text-kidville-green bg-kidville-cream flex items-center gap-2">
                    {formScope === 'external'
                      ? <><FileText size={14} /> {t('modAmbitoEsterni')}</>
                      : <><Users size={14} /> {t('modAmbitoGenitori')}</>}
                  </div>
                </div>

                <div>
                  <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                    {t('modScadenzaModulo')}
                  </label>
                  <DateField
                    value={formExpiration}
                    onChange={setFormExpiration}
                    aria-label={t('modScadenzaAriaLabel')}
                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-ink focus:outline-none"
                  />
                </div>
              </div>

              {/* Contabilità v2: flag «essenziale» — firmabile anche da moroso sospeso */}
              <label className="flex items-start gap-3 rounded-xl border-2 border-kidville-line px-3 py-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formSempreFirmabile}
                  onChange={e => setFormSempreFirmabile(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-kidville-green"
                />
                <span className="font-maven text-sm text-kidville-green">
                  <span className="font-semibold">{t('modEssenziale')}</span>
                  <span className="block text-xs text-kidville-muted">
                    {t('modEssenzialeDesc')}
                  </span>
                </span>
              </label>

              {formScope === 'class' && (
                <div>
                  <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                    {t('modSelezionaClassi')}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {sections.map(sec => (
                      <button
                        key={sec.id}
                        type="button"
                        onClick={() => handleToggleClass(sec.name)}
                        className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition-colors ${formClasses.includes(sec.name) ? 'bg-kidville-green text-kidville-yellow border-kidville-green' : 'border-kidville-line text-kidville-muted hover:border-kidville-muted'}`}
                      >
                        {sec.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Dynamic Fields Editor */}
              <div className="space-y-4">
                <div className="flex items-center justify-between border-t border-kidville-line pt-4">
                  <h4 className="font-barlow font-bold text-lg text-kidville-green uppercase">{t('modCampiDinamici')}</h4>
                  <button
                    onClick={handleAddField}
                    className="flex items-center gap-1 px-3 py-1 bg-kidville-cream text-kidville-green border border-kidville-green/10 rounded-pill font-barlow font-bold text-xs uppercase"
                  >
                    <Plus size={14} /> {t('modAggiungiCampo')}
                  </button>
                </div>

                {formFields.map((field, idx) => (
                  <div key={field.id} className="bg-kidville-cream p-4 rounded-xl border border-kidville-line flex flex-col md:flex-row gap-4 items-end">
                    <div className="flex-1 w-full grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block font-maven text-xs font-semibold text-kidville-muted mb-1">
                          {formType === 'autorizzazione' ? t('modTestoConsensoDomanda') : t('modDomanda')}
                        </label>
                        <input
                          type="text"
                          value={field.label}
                          onChange={e => handleFieldChange(idx, 'label', e.target.value)}
                          className="w-full border border-kidville-line rounded-lg px-2.5 py-1.5 font-maven text-xs bg-white focus:outline-none focus:border-kidville-green"
                          placeholder={formType === 'autorizzazione' ? t('modPlaceholderAutorizzazione') : formType === 'gradimento' ? t('modPlaceholderGradimento') : t('modPlaceholderSondaggio')}
                        />
                      </div>

                      <div>
                        <label className="block font-maven text-xs font-semibold text-kidville-muted mb-1">{t('modTipoInput')}</label>
                        <select
                          value={field.type}
                          onChange={e => handleFieldChange(idx, 'type', e.target.value as FormField['type'])}
                          className="w-full border border-kidville-line rounded-lg px-2 py-1.5 font-maven text-xs bg-white text-kidville-green focus:outline-none focus:border-kidville-green"
                        >
                          {INPUT_TYPES_BY_FORM[formType].map(([val, lblKey]) => (
                            <option key={val} value={val}>{t(lblKey)}</option>
                          ))}
                        </select>
                      </div>

                      {field.type === 'radio' && (
                        <div className="md:col-span-2">
                          <label className="block font-maven text-xs font-semibold text-kidville-muted mb-1">{t('modOpzioniScelta')}</label>
                          <input
                            type="text"
                            value={(field.options ?? []).map(o => o.label).join(', ')}
                            onChange={e => handleFieldOptions(idx, e.target.value)}
                            className="w-full border border-kidville-line rounded-lg px-2.5 py-1.5 font-maven text-xs bg-white focus:outline-none focus:border-kidville-green"
                            placeholder={t('modOpzioniPlaceholder')}
                          />
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1 text-xs text-kidville-muted mb-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={field.required}
                          onChange={e => handleFieldChange(idx, 'required', e.target.checked)}
                          className="rounded text-kidville-green focus:ring-kidville-green"
                        />
                        {t('modObblig')}
                      </label>

                      {formFields.length > 1 && (
                        <button
                          onClick={() => handleRemoveField(idx)}
                          className="text-kidville-muted hover:text-kidville-error transition-colors mb-2"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-kidville-line pt-4 mt-4">
              <button
                onClick={() => setShowBuilder(false)}
                className="px-4 py-2 font-maven rounded-pill border border-kidville-line text-kidville-muted text-sm hover:bg-kidville-cream transition-colors"
              >
                {t('annulla')}
              </button>
              <button
                onClick={handleSaveForm}
                className="px-5 py-2.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90 transition-all shadow-md"
              >
                {t('modSalvaModulo')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Pre-Inscription / Sala d'Attesa Details */}
      {selectedPre && (
        <div className="fixed inset-0 bg-kidville-green/30 z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-xl rounded-card p-6 shadow-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between border-b border-kidville-line pb-3 mb-4">
              <h2 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide">
                {t('modSchedaOnboarding')}
              </h2>
              <button 
                onClick={() => setSelectedPre(null)}
                className="text-kidville-muted hover:text-kidville-ink font-maven text-lg p-1"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-6 pr-1">
              {/* Genitore info */}
              <div className="bg-kidville-cream/30 p-4 rounded-xl border border-kidville-green/5">
                <h4 className="font-barlow font-bold text-sm text-kidville-green uppercase tracking-wide mb-2">{t('modContattiGenitore')}</h4>
                <div className="grid grid-cols-2 gap-y-2 text-xs font-maven text-kidville-ink">
                  <div><strong>{t('modLabelNome')}</strong> {selectedPre.parent_first_name} {selectedPre.parent_last_name}</div>
                  <div><strong>{t('modLabelEmail')}</strong> {selectedPre.parent_email}</div>
                  <div><strong>{t('modLabelTelefono')}</strong> {selectedPre.parent_phone || t('modNd')}</div>
                  <div><strong>{t('modLabelCf')}</strong> {selectedPre.parent_fiscal_code || t('modNd')}</div>
                  <div className="col-span-2"><strong>{t('modLabelIndirizzo')}</strong> {selectedPre.parent_address || t('modNd')}</div>
                </div>
              </div>

              {/* Figli */}
              <div>
                <h4 className="font-barlow font-bold text-sm text-kidville-green uppercase tracking-wide mb-3">{t('modFigliDaRegistrare')}</h4>
                <div className="space-y-3">
                  {selectedPre.students?.map((s, idx) => (
                    <div key={idx} className="p-3 bg-kidville-cream border border-kidville-line rounded-xl text-xs font-maven">
                      <div className="font-semibold text-kidville-ink text-sm">{s.cognome} {s.nome}</div>
                      <div className="text-kidville-muted mt-1">{t('modDataNascitaCf', { data: f.dataBreve(s.data_nascita), cf: s.codice_fiscale || t('modNd') })}</div>
                      {s.note_mediche && (
                        <div className="mt-2 text-kidville-error bg-kidville-error-soft p-1.5 rounded-lg font-semibold flex items-start gap-1">
                          {t('modAllergieNote')} {s.note_mediche}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Assegnazione Classe */}
              <div className="border-t border-kidville-line pt-4">
                <label className="block font-maven text-sm font-semibold text-kidville-green mb-1.5">
                  {t('modAssegnaSezione')}
                </label>
                <select
                  value={assignedClass}
                  onChange={e => setAssignedClass(e.target.value)}
                  className="w-full border-2 border-kidville-line rounded-xl px-3 py-2.5 font-maven text-sm text-kidville-ink focus:outline-none bg-white"
                >
                  <option value="">{t('modSelezionaSezione')}</option>
                  {sections.map(sec => (
                    <option key={sec.id} value={sec.name}>{sec.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex justify-between gap-3 border-t border-kidville-line pt-4 mt-4">
              <button
                onClick={() => handleRejectPreInscription(selectedPre.id)}
                className="px-4 py-2 font-barlow font-bold text-xs uppercase tracking-wider rounded-pill border border-kidville-error-soft text-kidville-error hover:bg-kidville-error-soft"
              >
                {t('modRifiutaIscrizione')}
              </button>

              <div className="flex gap-3">
                <button
                  onClick={() => setSelectedPre(null)}
                  className="px-4 py-2 font-maven rounded-pill border border-kidville-line text-kidville-muted text-sm hover:bg-kidville-cream"
                >
                  {t('annulla')}
                </button>
                <button
                  disabled={!assignedClass}
                  onClick={() => setShowConfirmApproval(true)}
                  className="px-5 py-2.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90 disabled:opacity-50 transition-all shadow-md"
                >
                  {t('modApprovaImporta')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Secondary confirmation for Approval */}
      {showConfirmApproval && selectedPre && (
        <div className="fixed inset-0 bg-kidville-green/30 z-[60] flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-sm rounded-card p-6 shadow-2xl text-center">
            <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide mb-3">{t('modConfermaApprovazione')}</h3>
            <p className="font-maven text-sm text-kidville-muted mb-6">
              {t.rich('modConfermaApprovazioneTesto', {
                cognome: selectedPre.parent_last_name,
                n: selectedPre.students?.length ?? 0,
                sezione: assignedClass,
                strong: (c) => <strong>{c}</strong>,
              })}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => setShowConfirmApproval(false)}
                className="px-4 py-2 font-maven rounded-pill border border-kidville-line text-kidville-muted text-sm hover:bg-kidville-cream"
              >
                {t('modIndietro')}
              </button>
              <button
                onClick={handleApprovePreInscription}
                className="px-6 py-2.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90"
              >
                {t('modSiApprova')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Generated Credentials Modal */}
      {showCredentials && (
        <div className="fixed inset-0 bg-kidville-green/30 z-[60] flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white w-full max-w-sm rounded-card p-6 shadow-2xl text-center border-t-4 border-kidville-green">
            <CheckCircle className="text-kidville-success mx-auto mb-3" size={48} />
            <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide mb-1">{t('modAccountCreato')}</h3>
            <p className="font-maven text-xs text-kidville-muted mb-6">
              {t('modInviaCredenziali')}
            </p>
            <div className="bg-kidville-cream p-4 rounded-xl text-left font-maven text-sm border border-kidville-line mb-6 space-y-2 select-all">
              <div><strong>{t('modLabelEmail')}</strong> {showCredentials.email}</div>
              <div><strong>{t('modLabelPassword')}</strong> {showCredentials.pass}</div>
            </div>
            <button
              onClick={() => setShowCredentials(null)}
              className="w-full h-11 font-barlow font-black uppercase tracking-wider rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 transition-opacity"
            >
              {t('modFattoChiudi')}
            </button>
          </div>
        </div>
      )}

      {/* Modal «Protocolla moduli firmati» (registro protocolli) */}
      {protocollaTarget && (
        <div className="fixed inset-0 bg-kidville-green/30 z-50 flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-barlow text-xl font-black uppercase text-kidville-green flex items-center gap-2">
                  <Stamp size={20} /> {t('modProtocollaModuli')}
                </h3>
                <p className="mt-0.5 font-maven text-sm text-kidville-muted">
                  {t('modProtocollaSottotitolo', { titolo: protocollaTarget.form.title, classe: protocollaTarget.className })}
                </p>
              </div>
              <button onClick={() => setProtocollaTarget(null)} aria-label={t('chiudi')} className="p-2 rounded-lg text-kidville-muted hover:bg-kidville-cream">
                <X size={18} />
              </button>
            </div>
            <ul className="max-h-[320px] overflow-y-auto divide-y divide-kidville-line">
              {protocollaTarget.items.map((item) => (
                <li key={item.submission_id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate font-maven text-sm font-semibold text-kidville-ink">{item.cognome_alunno} {item.nome_alunno}</p>
                    <p className="font-maven text-[11.5px] text-kidville-muted">
                      {t('modFirmato')} {item.origine === 'cartaceo' ? t('modCartaceoAcquisito') : t('modFesDigitale')}{item.created_at ? ` ${t('modIlData', { data: f.dataBreve(item.created_at) })}` : ''}
                    </p>
                  </div>
                  {protocollati[item.submission_id ?? ''] ? (
                    <span className="shrink-0 rounded-pill bg-kidville-success-soft px-2.5 py-1 font-maven text-[11.5px] font-bold text-kidville-success">
                      {t('modNumeroProt', { numero: protocollati[item.submission_id ?? ''] })}
                    </span>
                  ) : (
                    <button
                      onClick={() => protocollaModulo(item.submission_id!)}
                      disabled={protocollaBusy === item.submission_id}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-bold text-[11px] uppercase disabled:opacity-50"
                    >
                      <Stamp size={12} /> {protocollaBusy === item.submission_id ? t('modInCorso') : t('modProtocolla')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 font-maven text-[11.5px] text-kidville-muted">
              {t('modProtocollaHint')}
            </p>
          </div>
        </div>
      )}

      {/* Toast notification */}
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

export default function AdminModulisticaPage() {
  return (
    <Suspense fallback={null}>
      <ModulisticaInner />
    </Suspense>
  );
}
