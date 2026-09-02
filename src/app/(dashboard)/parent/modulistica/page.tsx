'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formattaIstante } from '@/i18n/config';
import {
  Clock, Archive, Award, HeartPulse, Shield,
  ArrowRight, Download, Upload, Mail
} from 'lucide-react';
import { OtpEmailModal } from '@/components/features/parent/forms/OtpEmailModal';
import { PrestampatiGenitore } from '@/components/features/prestampati/PrestampatiGenitore';
import { DateField } from '@/components/ui/DateField';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { BarraFiltri, testiBarraFiltri } from '@/components/ui/BarraFiltri';
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { useDateFormat } from '@/lib/i18n/date';
import { useClientValue } from '@/lib/hooks/use-client-value';
import { dataCivile } from '@/i18n/config';
import { decidiStatoElenco } from '@/lib/ui/filtri/motore';
import { useFiltri } from '@/lib/ui/filtri/use-filtri';
import { logClient } from '@/lib/logging/client';
import {
  campiArchivio,
  campiCertificatiMedici,
  campiDaCompilare,
  descriviPeriodoIt,
} from '@/components/features/parent/filtri-modulistica';

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

/**
 * Il certificato medico come lo serve `GET /api/parent/medical-certificates`.
 *
 * ⚠️ `alunno_id`, `stato`, `data_inizio` e `data_fine` NON sono campi nuovi: la
 * rotta li seleziona da sempre (`.select('id, alunno_id, data_inizio, data_fine,
 * stato, …')`) e questo tipo non li dichiarava, quindi la pagina li buttava via
 * senza saperlo. Nessuna modifica alla rotta: solo il tipo che smette di mentire.
 */
interface MedCert {
  id: string;
  alunno_id?: string | null;
  fileName?: string | null;
  alunno?: { nome?: string | null; cognome?: string | null } | null;
  creato_il: string;
  stato?: string | null;
  data_inizio?: string | null;
  data_fine?: string | null;
  notes?: string | null;
  giorni_coperti?: string[] | null;
}

interface SignedArchiveItem {
  id: string;
  answers: Record<string, unknown>;
  is_signed: boolean;
  pdf_path: string;
  created_at: string;
  /** `online` = firmato dalla famiglia · `cartaceo` = scansione acquisita dallo staff. */
  origine?: string | null;
  forms_templates: {
    title: string;
    description: string;
  };
  alunni: {
    nome: string;
    cognome: string;
  };
}

/**
 * Una delle quattro letture non è arrivata, e lo si dice.
 *
 * Fuori dal componente perché non ha bisogno di niente di suo: è il collo di
 * bottiglia da cui passano i tre rami di fallimento, così nessuno di essi resta
 * muto — ed è la regola 6 di AGENTS.md applicata dove il guasto si presenta
 * all'utente come «l'elenco è vuoto», che è indistinguibile da «non c'è nessuno».
 * Nessun dato della famiglia nel messaggio: solo che cosa non si è caricato.
 */
function segnalaLetturaFallita(cosa: string, stato?: number): void {
  logClient({
    livello: 'warn',
    evento: 'fetch',
    messaggio: `modulistica genitore: ${cosa} non letti`,
    route: '/parent/modulistica',
    ...(typeof stato === 'number' ? { stato } : null),
  });
}

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
function ContenutoModulistica() {
  const t = useTranslations('parentServizi');
  const ts = useTranslations('shared');
  const { userId: parentId } = useSessionIdentity();
  const f = useDateFormat();
  /**
   * La linguetta d'apertura, che ora si può DICHIARARE nell'indirizzo.
   *
   * 🔴 Misurato in un browser vero il 2026-08-16: la notifica della gita portava a
   * `/parent/modulistica`, la pagina si apriva su «DA COMPILARE» e a quel genitore diceva
   * «Ottimo lavoro! Non hai moduli da compilare» — mentre il modulo della gita stava nella
   * terza scheda. Il testo della notifica per giunta nominava una linguetta con un'etichetta
   * che nell'app non esiste. Un avviso che porta a una schermata che dice «non hai niente da
   * fare» è peggio di nessun avviso.
   *
   * Stesso identico schema di `/admin/modulistica`, che i suoi `?tab=` li legge già: le
   * quattro parole ammesse sono scritte QUI, e sono le stesse del tipo e della barra. È la
   * riga che si dimentica — finché nessuno manda quel link, il difetto non si vede — ed è il
   * motivo per cui il collegamento della notifica ha un test suo nella route che lo compone.
   *
   * ⚠️ E `useSearchParams()` VUOLE UN `<Suspense>` SOPRA, che sta in fondo a questo file.
   * Qui prima c'era scritto il contrario — «non serve, tanto `/admin/modulistica` usa lo
   * stesso schema e compila» — ed era falso in tutte e due le metà: quella pagina il
   * `<Suspense fallback={null}>` ce l'ha da prima di questo ramo, e la build passava solo
   * perché `src/app/layout.tsx` fa `await cookies()`, che rende dinamica ogni rotta. Cioè
   * un appoggio non dichiarato su una riga di un altro file: il giorno in cui quella
   * `cookies()` sparisce, `npm run build` cade con `missing-suspense-with-csr-bailout`
   * (`node_modules/next/dist/docs/…/use-search-params.md`). Tre righe, e la dipendenza non
   * c'è più.
   */
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab: 'compilare' | 'archivio' | 'certificati' | 'medici' =
    tabParam === 'archivio' || tabParam === 'certificati' || tabParam === 'medici'
      ? tabParam
      : 'compilare';
  const [activeTab, setActiveTab] = useState<'compilare' | 'archivio' | 'certificati' | 'medici'>(initialTab);
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
  /**
   * Una lettura FALLITA non è mai «nessun risultato», e nemmeno «vuoto»: le tre
   * cose si somigliano a schermo e chiedono all'utente gesti opposti — riprova,
   * togli un filtro, non c'è ancora nulla. Prima di questo ramo la pagina non le
   * distingueva affatto: un guasto di rete si presentava come un archivio vuoto.
   */
  const [erroreForms, setErroreForms] = useState(false);
  const [erroreArchivio, setErroreArchivio] = useState(false);
  const [erroreMedici, setErroreMedici] = useState(false);

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
      else segnalaLetturaFallita('moduli assegnati', fRes?.status);
      setErroreForms(!Array.isArray(fData));

      // 2. Fetch signed archive
      const aRes = await fetch('/api/parent/submissions', { headers: { 'x-user-id': parentId } }).catch(() => null);
      const aData = await aRes?.json().catch(() => null);
      if (Array.isArray(aData)) setArchive(aData);
      else segnalaLetturaFallita('archivio firmati', aRes?.status);
      setErroreArchivio(!Array.isArray(aData));

      /**
       * 3. I certificati medici.
       *
       * 🔴 QUI C'ERA `if (Array.isArray(mData)) setMedCerts(mData)`, e la rotta
       * risponde `{ success, data }` — lo fa da sempre. `Array.isArray` su un
       * oggetto è `false`, quindi questa scheda era VUOTA SEMPRE, per chiunque,
       * qualunque cosa ci fosse nel database: nessun errore, nessun log, nessun
       * test rosso. È la stessa firma del guasto delle email di credenziali —
       * «non c'è niente» e «non è mai arrivato niente» hanno lo stesso aspetto.
       *
       * L'array nudo resta accettato: durante un rilascio il client può essere
       * più nuovo del server, o viceversa.
       */
      const mRes = await fetch('/api/parent/medical-certificates', { headers: { 'x-user-id': parentId } }).catch(() => null);
      const mCorpo = await mRes?.json().catch(() => null);
      const mData = Array.isArray(mCorpo) ? mCorpo : mCorpo?.data;
      if (Array.isArray(mData)) setMedCerts(mData);
      else segnalaLetturaFallita('certificati medici', mRes?.status);
      setErroreMedici(!Array.isArray(mData));

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
        showToastMsg(t('modulisticaToastCampoObbligatorio', { campo: field.label || t('modulisticaCampoFallback') }));
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
        // Niente prosa del server: è italiana per costruzione (T10-F1).
        showToastMsg(`❌ ${soloCatalogoDaCorpo(j, t('modulisticaInvioFallito'))}`);
        return;
      }
      showToastMsg(t('modulisticaToastRisposteInviate'));
      setCompilingForm(null);
      fetchData();
    } catch {
      showToastMsg(t('modulisticaToastErrInvio'));
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
        // Niente prosa del server: è italiana per costruzione (T10-F1).
        showToastMsg(`❌ ${soloCatalogoDaCorpo(json, t('modulisticaInvioCodiceFallito'))}`);
        return;
      }
      setOtpSession({ email: json.email, expiry: json.expiry, ticket: json.ticket, devCode: json.devCode });
      setShowOtpModal(true);
      if (!json.sent) {
        showToastMsg(t('modulisticaEmailNonConfigurata'));
      }
    } catch {
      showToastMsg(t('modulisticaToastErrInvioCodice'));
    }
  };

  // Firma OTP via email — step 2: verifica il codice, finalizza la firma e genera la ricevuta
  const verifyOtpAndSign = async (code: string): Promise<{ ok: boolean; error?: string }> => {
    if (!compilingForm || !otpSession || !parentId) return { ok: false, error: t('modulisticaSessioneScaduta') };
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
      // `OtpEmailModal` mostra questa stringa così com'è: qui è l'ULTIMO punto in
      // cui esiste il locale, quindi la traduzione avviene qui e non lì (T10-F1).
      if (!res.ok) return { ok: false, error: soloCatalogoDaCorpo(json, t('modulisticaVerificaFallita')) };

      // La ricevuta la DISEGNA IL SERVER, sulla carta intestata vera: qui si chiede
      // soltanto, con l'id della submission appena creata. Se il server non lo
      // restituisce non si inventa niente — la ricevuta resta nell'Archivio firmati,
      // dove ha il suo pulsante.
      const submissionId = (json?.submission as { id?: string } | undefined)?.id;
      if (submissionId) void apriRicevutaFirma(submissionId);

      // La modale mostra l'esito; chiudiamo e ricarichiamo dopo un attimo
      setTimeout(() => {
        setShowOtpModal(false);
        setCompilingForm(null);
        setOtpSession(null);
        fetchData();
      }, 1600);

      return { ok: true };
    } catch {
      return { ok: false, error: t('modulisticaErrRete') };
    }
  };

  /**
   * LA RICEVUTA DI FIRMA LA DISEGNA IL SERVER — `GET /api/fea/receipt`.
   *
   * ⚠️ QUI C'ERA UN SECONDO MOTORE, `generateReceiptPDF`, e produceva un documento che
   * una famiglia poteva scaricare. Rimosso il 2026-08-16, con l'elenco di ciò che
   * stampava, perché è la ragione per cui non deve tornare:
   *
   *  · una banda verde disegnata dal codice al posto della carta intestata vera;
   *  · «KIDVILLE SCHOOLS» in giallo — che non è la ragione sociale, non è il marchio, e
   *    non è niente — e «Registro Elettronico & Modulistica Legale AgID», una conformità
   *    AgID che nessuno ha certificato;
   *  · il **codice fiscale** del firmatario, il suo **indirizzo IP** e lo **User Agent**,
   *    sotto la frase «ricevuta inattaccabile del consenso»;
   *  · e la parte peggiore: quando il log quei dati non li aveva, **li inventava** —
   *    `log?.ip || '192.168.1.45'` e `log?.provider || 'Aruba SPID'`. Un foglio che
   *    dichiara un indirizzo IP e un identity provider che nessuno ha mai registrato non
   *    è una ricevuta: è un dato fabbricato, scaricabile da un genitore.
   *
   * Il gemello lato server era già stato ripulito su questo ramo («il nome del firmatario
   * senza recapiti: mai un'email, mai un indirizzo IP», `src/lib/fea/receipt-pdf.ts`) e
   * disegna sulla carta reale della scuola. Restava questa copia nel browser: due motori
   * per lo stesso foglio divergono al primo ritocco, e questo era già divergente.
   *
   * `entita=forms`: la ricevuta è ancorata alla riga di `forms_submissions`, e la rotta
   * la serve **solo al firmatario** (gate `requireUser` + confronto con `parent_id`).
   * Nessun `x-user-id`: quell'header là non è accettato come prova d'identità.
   */
  const apriRicevutaFirma = async (submissionId: string) => {
    try {
      const res = await fetch(`/api/fea/receipt?entita=forms&id=${encodeURIComponent(submissionId)}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        // Niente prosa del server: è italiana per costruzione (T10-F1). Una frase sua
        // per «la ricevuta non si è aperta» andrebbe in `parentServizi`, che è catalogo
        // di un'altra mano: dichiarato all'orchestratore.
        showToastMsg(`❌ ${soloCatalogoDaCorpo(j, t('modulisticaErrRete'))}`);
        return;
      }
      // Stesso schema di `PrestampatiGenitore.scaricaBase64`: un `<a download>` invece di
      // `window.open`, che dopo un `await` il blocco pop-up del browser ferma.
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `ricevuta-firma-${submissionId.slice(0, 8)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Un catch che non logga è un bug: qui il canale è il genitore, e il messaggio è
      // l'unica traccia che vede chi sta aspettando il file.
      showToastMsg(t('modulisticaErrRete'));
    }
  };

  // ⚠️ QUI C'ERA `generateSelfServiceCertificate`, e con lui i due pulsanti «Scarica PDF»
  // della scheda Certificati. Rimossi il 2026-08-16, ed è utile dire che cosa producevano
  // — perché era l'unica strada da cui una famiglia otteneva un certificato:
  //
  //  · una banda verde inventata dal codice al posto della carta intestata vera;
  //  · «KIDVILLE SCHOOLS» in giallo, che non è la ragione sociale, non è il marchio e non è
  //    niente;
  //  · «Il Dirigente Scolastico» in calce: in una società cooperativa quella figura NON
  //    ESISTE, e comunque non è chi firma — firma il legale rappresentante, che sta in
  //    anagrafica su tutte e tre le sedi;
  //  · nessun numero di protocollo e nessuna archiviazione: il foglio nasceva nel browser,
  //    si scaricava e spariva.
  //
  // Il certificato ora lo emette `POST /api/parent/prestampati` dal motore vero — carta
  // intestata della scuola, firma del legale rappresentante, protocollo in uscita,
  // archiviazione nel fascicolo — e il pannello che lo chiede è `PrestampatiGenitore`, che
  // vive nella stessa scheda. Il selettore del figlio è suo, e per questo `certificatiChildId`
  // non serve più: là dentro la scelta è già fatta prima di premere qualunque cosa.

  // Punto d'ingresso unico per il file del certificato: lo usano sia l'<input>
  // (che accetta anche PDF) sia il bottone «Scatta foto» nativo. Il documento può
  // essere un PDF o una foto → il supporto PDF resta intatto.
  const processaCertFile = (f: File | null) => {
    setCertFile(f);
    setCertFileName(f?.name ?? '');
  };

  // Submit Medical Certificate
  const handleUploadMedicalCert = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!parentId) { showToastMsg(t('modulisticaIdentitaNonRisolta')); return; }
    if (!certFile) { showToastMsg(t('modulisticaCaricareFile')); return; }
    if (!selectedChildId) { showToastMsg(t('modulisticaSelezionaIlFiglio')); return; }
    if (!certDal || !certAl || certDal > certAl) { showToastMsg(t('modulisticaPeriodoNonValido')); return; }

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
      showToastMsg(t('modulisticaCertCaricato'));
      setCertFile(null); setCertFileName(''); setCertDal(''); setCertAl(''); setCertNotes('');
      fetchData();
    } catch {
      showToastMsg(t('modulisticaToastErrCaricamento'));
    }
  };

  // ── I FILTRI DELLE TRE SCHEDE ───────────────────────────────────────────────
  //
  // Tre hook al livello della pagina, non uno per scheda montata a turno: qui
  // NON serve, perché ogni campo è `dove: 'client'` e i dati sono già tutti in
  // memoria — non c'è nessuna cornice da conoscere prima di nascere, che è
  // invece il vincolo della pagina del docente (vedi `PannelloSemaforo`).
  //
  // ⚠️ `scriviUrl: false`. Tre barre sulla stessa pagina governano gli stessi nomi
  // di parametro (`q`, `figlio`, `stato`): scrivendoli tutte, l'ultima che tocca
  // cancella i filtri della precedente e lascia nella barra degli indirizzi uno
  // stato che non descrive quello che si vede. L'indirizzo resta comunque LETTO
  // (`?tab=` continua a funzionare, e un `?q=` incollato apre la ricerca già
  // fatta): si rinuncia alla scrittura, non alla lettura.
  const oggi = useClientValue(dataCivile, '');
  const descriviPeriodo = descriviPeriodoIt(t, f.dataBreve);
  const campiCompilare = campiDaCompilare(assignedForms, t, { oggi });
  const campiArch = campiArchivio(archive, t, { descriviPeriodo });
  const campiMed = campiCertificatiMedici(medCerts, t, { descriviPeriodo });
  const filtriCompilare = useFiltri<AssignedForm>(campiCompilare, { scriviUrl: false });
  const filtriArchivio = useFiltri<SignedArchiveItem>(campiArch, { scriviUrl: false });
  const filtriMedici = useFiltri<MedCert>(campiMed, { scriviUrl: false });

  const moduliVisibili = filtriCompilare.filtra(assignedForms);
  const archivioVisibile = filtriArchivio.filtra(archive);
  const mediciVisibili = filtriMedici.filtra(medCerts);

  const testiBarra = testiBarraFiltri(ts);
  const testiStato = testiStatoElenco(ts);

  // `totale` è quante righe esistono nella scheda SENZA filtri, e non `mostrati`:
  // è il cardine di «vuoto» contro «nessun risultato». Per una famiglia lo zero è
  // il caso normale — `forms_templates`, `forms_submissions` e `certificati_medici`
  // hanno zero righe in produzione — quindi è la distinzione che si vede più spesso.
  const statoCompilare = decidiStatoElenco({
    caricamento: isLoading, errore: erroreForms,
    totale: assignedForms.length, mostrati: moduliVisibili.length,
  });
  const statoArchivio = decidiStatoElenco({
    caricamento: isLoading, errore: erroreArchivio,
    totale: archive.length, mostrati: archivioVisibile.length,
  });
  const statoMedici = decidiStatoElenco({
    caricamento: isLoading, errore: erroreMedici,
    totale: medCerts.length, mostrati: mediciVisibili.length,
  });

  return (
    <div className="flex-1 flex flex-col px-4 pt-5 pb-24">
      {/* Header */}
      <PageHeaderCard
        eyebrow={t('modulisticaEyebrow')}
        title={t('modulisticaTitolo')}
        subtitle={t('modulisticaSottotitolo')}
      />

      {/* Tabs */}
      <div className="mt-5 flex gap-4 mb-6 overflow-x-auto border-b border-kidville-line scrollbar-none pb-1">
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'compilare' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => { setActiveTab('compilare'); setCompilingForm(null); }}
        >
          <Clock size={16} /> {t('modulisticaTabCompilare')}
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'archivio' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => { setActiveTab('archivio'); setCompilingForm(null); }}
        >
          <Archive size={16} /> {t('modulisticaTabArchivio')}
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'certificati' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => { setActiveTab('certificati'); setCompilingForm(null); }}
        >
          <Award size={16} /> {t('modulisticaTabCertificati')}
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeTab === 'medici' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => { setActiveTab('medici'); setCompilingForm(null); }}
        >
          <HeartPulse size={16} /> {t('modulisticaTabMedici')}
        </button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[40vh] gap-3">
          <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
          <p className="font-maven text-kidville-muted">{t('modulisticaCaricamento')}</p>
        </div>
      ) : (
        <>
          {/* TAB 1: Da Compilare */}
          {activeTab === 'compilare' && !compilingForm && (
            <div className="space-y-4">
              {/* 🔴 Qui c'era `assignedForms.filter(f => f.status === 'pending')`,
                  scritto DUE volte: una per decidere se l'elenco è vuoto, una per
                  disegnarlo. Ora è un filtro con `pending` come valore di riposo —
                  la scheda si apre esattamente su ciò che si apriva prima, ma la
                  famiglia può anche guardare i firmati e gli scaduti, e «Pulisci
                  filtri» riporta al riposo invece di azzerare. */}
              <BarraFiltri
                campi={campiCompilare}
                stato={filtriCompilare}
                testi={testiBarra}
                totale={assignedForms.length}
                mostrati={moduliVisibili.length}
                variante="compatta"
              />
              <StatoElenco
                stato={statoCompilare}
                testi={{ ...testiStato, vuotoTitolo: t('modulisticaNessunModulo') }}
                attivi={filtriCompilare.attivi}
                onPulisci={filtriCompilare.pulisci}
                onRiprova={fetchData}
              />
              {moduliVisibili.map(form => (
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
                            <Shield size={11} /> {t('modulisticaBadgeAutorizzazione')}
                          </span>
                        )}
                        {form.form_type === 'sondaggio' && (
                          <span className="bg-kidville-yellow-light text-kidville-green px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider">{t('modulisticaBadgeSondaggio')}</span>
                        )}
                        {form.form_type === 'gradimento' && (
                          <span className="bg-kidville-yellow-light text-kidville-green px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider">{t('modulisticaBadgeGradimento')}</span>
                        )}
                        <span className="bg-kidville-cream text-kidville-green px-2.5 py-1 rounded-full text-xs font-semibold">
                          {t('modulisticaFiglio', { nome: `${form.student.nome} ${form.student.cognome}` })}
                        </span>

                        {form.expiration_date && (
                          <span className="bg-kidville-warn-soft text-kidville-warn px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1">
                            <Clock size={12} />
                            {t('modulisticaScadeIl', { data: f.dataBreve(form.expiration_date) })}
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
                      {form.form_type === 'autorizzazione' ? t('modulisticaCompilaFirma') : t('modulisticaCompila')} <ArrowRight size={16} />
                    </Btn>
                  </div>
                ))}
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
                  {t.rich('modulisticaCompilazionePer', {
                    nome: `${compilingForm.student.nome} ${compilingForm.student.cognome}`,
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
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
                            placeholder={t('modulisticaRispostaPlaceholder')}
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
                            placeholder={t('modulisticaInserisciCampo', { campo: field.label.toLowerCase() })}
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
                      <Shield size={18} className="text-kidville-yellow" /> {t('modulisticaFesTitolo')}
                    </h4>
                    <p className="font-maven text-xs text-kidville-muted max-w-md leading-relaxed">
                      {t('modulisticaFesTesto')}
                    </p>
                  </div>
                  <div className="bg-kidville-green-light text-kidville-green px-4 py-2 rounded-xl text-xs font-bold border border-kidville-green/15 flex items-center gap-1.5 self-start md:self-auto">
                    <Mail size={15} /> {t('modulisticaVerificaEmail')}
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
                  {t('modulisticaAnnulla')}
                </Btn>
                <Btn
                  variant="primary"
                  size="md"
                  onClick={compilingForm.form_type === 'autorizzazione' ? handleStartSigning : handleSubmitDirect}
                >
                  {compilingForm.form_type === 'autorizzazione' ? t('modulisticaInviaFirmaRicevuta') : t('modulisticaInviaRisposte')}
                </Btn>
              </div>
            </div>
          )}

          {/* TAB 2: Archivio Firmati */}
          {activeTab === 'archivio' && (
            <div className="space-y-4">
              <BarraFiltri
                campi={campiArch}
                stato={filtriArchivio}
                testi={testiBarra}
                totale={archive.length}
                mostrati={archivioVisibile.length}
                variante="compatta"
              />
              <StatoElenco
                stato={statoArchivio}
                testi={{ ...testiStato, vuotoTitolo: t('modulisticaNessunFirmato') }}
                attivi={filtriArchivio.attivi}
                onPulisci={filtriArchivio.pulisci}
                onRiprova={fetchData}
              />
              {archivioVisibile.map(item => (
                  <div key={item.id} className="bg-white rounded-card p-5 border border-kidville-line flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                        {item.forms_templates?.title}
                      </h3>
                      <p className="font-maven text-xs text-kidville-muted mt-1">
                        {t('modulisticaFiglioFirmato', { nome: `${item.alunni?.nome ?? ''} ${item.alunni?.cognome ?? ''}`.trim(), data: f.dataBreve(item.created_at) })}
                      </p>
                      <div className="mt-2.5 flex items-center gap-1 text-[10px] text-kidville-success bg-kidville-success-soft px-2 py-0.5 rounded-full font-bold w-fit uppercase tracking-wider">
                        <Shield size={10} /> {t('modulisticaRicevutaFesProtetta')}
                      </div>
                    </div>

                    <Btn
                      variant="ghost"
                      size="sm"
                      onClick={() => void apriRicevutaFirma(item.id)}
                      className="self-start md:self-auto"
                    >
                      <Download size={14} /> {t('modulisticaRicevutaPdf')}
                    </Btn>
                  </div>
                ))}
            </div>
          )}

          {/* TAB 3: Certificati e moduli della famiglia */}
          {activeTab === 'certificati' && (
            <div className="space-y-8">
              {/* I prestampati della famiglia: si compilano, si firmano con l'OTP, si
                  generano e si riscaricano — tutto da qui dentro, dove il figlio si sceglie
                  una volta sola. I due riquadri «Scarica PDF» che stavano sotto sono spariti
                  insieme al loro generatore: vedi il blocco più su in questo file. */}
              <PrestampatiGenitore figli={children} />
            </div>
          )}

          {/* TAB 4: Certificati Medici */}
          {activeTab === 'medici' && (
            <div className="space-y-6">
              <form onSubmit={handleUploadMedicalCert} className="bg-white rounded-card p-5 sm:p-6 shadow-sm border border-kidville-line space-y-4">
                <h3 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                  {t('modulisticaCaricaCertMedico')}
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">
                      {t('modulisticaSelezionaFiglio')} *
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
                      {t('modulisticaDocScansionato')} *
                    </label>
                    {certFileName ? (
                      <div className="flex items-center justify-between border-2 border-kidville-success/20 bg-kidville-success-soft text-kidville-success px-3 py-2 rounded-xl text-xs font-semibold">
                        <span>📄 {certFileName}</span>
                        <button type="button" onClick={() => { setCertFileName(''); setCertFile(null); }} className="text-kidville-muted hover:text-kidville-error">✕</button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        <label className="w-full h-10 border-2 border-dashed border-kidville-line hover:border-kidville-green rounded-xl flex items-center justify-center gap-1.5 cursor-pointer text-xs font-semibold text-kidville-sub transition-colors">
                          <Upload size={14} /> {t('modulisticaCaricaCertificato')}
                          <input
                            type="file"
                            accept=".pdf,image/*"
                            className="hidden"
                            onChange={e => processaCertFile(e.target.files?.[0] ?? null)}
                          />
                        </label>
                        {/* Nativo: scatta la foto del certificato cartaceo. Su web non compare. */}
                        <ScattaFotoButton
                          onFile={processaCertFile}
                          label={t('modulisticaScattaFoto')}
                          className="h-10 w-full flex items-center justify-center gap-1.5 border-2 border-dashed border-kidville-line hover:border-kidville-green rounded-xl text-xs font-semibold text-kidville-green transition-colors"
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* Periodo di copertura (dal/al) — DL-027 */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">{t('modulisticaCopertoDal')} *</label>
                    <DateField value={certDal} onChange={setCertDal} aria-label={t('modulisticaAriaCopertoDal')}
                      className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-xs text-kidville-sub focus:outline-none focus:border-kidville-green" />
                  </div>
                  <div>
                    <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">{t('modulisticaAl')} *</label>
                    <DateField value={certAl} onChange={setCertAl} aria-label={t('modulisticaAriaCopertoAl')}
                      className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-xs text-kidville-sub focus:outline-none focus:border-kidville-green" />
                  </div>
                </div>

                <div>
                  <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">
                    {t('modulisticaNoteAccompagnamento')}
                  </label>
                  <textarea
                    value={certNotes}
                    onChange={e => setCertNotes(e.target.value)}
                    className="w-full border-2 border-kidville-line rounded-xl p-2.5 font-maven text-xs focus:outline-none focus:border-kidville-green resize-none h-16"
                    placeholder={t('modulisticaNotePlaceholder')}
                  />
                </div>

                <Btn type="submit" variant="primary" size="md" className="w-full">
                  {t('modulisticaInviaCertMedico')}
                </Btn>
              </form>

              {/* Elenco certificati medici passati */}
              <div className="space-y-3">
                <h4 className="font-barlow font-bold text-base text-kidville-green uppercase tracking-wide">
                  {t('modulisticaRicevuteRecenti')}
                </h4>
                <BarraFiltri
                  campi={campiMed}
                  stato={filtriMedici}
                  testi={testiBarra}
                  totale={medCerts.length}
                  mostrati={mediciVisibili.length}
                  variante="compatta"
                />
                <StatoElenco
                  stato={statoMedici}
                  testi={{ ...testiStato, vuotoTitolo: t('modulisticaNessunCertMedico') }}
                  attivi={filtriMedici.attivi}
                  onPulisci={filtriMedici.pulisci}
                  onRiprova={fetchData}
                />
                {mediciVisibili.map(cert => (
                    <div key={cert.id} className="bg-white rounded-card p-4 border border-kidville-line flex items-center justify-between text-xs font-maven">
                      <div>
                        <div className="font-semibold text-kidville-ink">{t('modulisticaCertLabel', { nome: cert.fileName ?? '' })}</div>
                        <div className="text-kidville-muted mt-0.5">{t('modulisticaFiglioCaricato', { nome: cert.alunno?.nome ?? '', data: f.dataBreve(cert.creato_il) })}</div>
                        {cert.notes && <div className="text-kidville-muted mt-1 italic">{t('modulisticaNote', { note: cert.notes })}</div>}
                      </div>

                      <div className="flex flex-col items-end gap-1.5">
                        {(cert.giorni_coperti?.length ?? 0) > 0 ? (
                          <span className="bg-kidville-success-soft text-kidville-success px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
                            {t('modulisticaGiustificato', { giorni: (cert.giorni_coperti ?? []).map((d: string) => formattaIstante(new Date(d), f.locale, { day: '2-digit', month: '2-digit' })).join(', ') })}
                          </span>
                        ) : (
                          <span className="bg-kidville-warn-soft text-kidville-warn px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
                            {t('modulisticaInAttesaAbbinamento')}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
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

/**
 * Il confine di sospensione attorno a `useSearchParams()` — tre righe, e non una scelta di
 * stile: è quello che fanno TUTTE le altre pagine statiche di questo repo (misurato:
 * `parent/modulistica` era l'unica rotta senza segmento dinamico che ne facesse a meno).
 * Vedi la nota accanto a `useSearchParams()`, sopra, per che cosa la reggeva finora.
 */
export default function ParentModulisticaPage() {
  return (
    <Suspense fallback={null}>
      <ContenutoModulistica />
    </Suspense>
  );
}
