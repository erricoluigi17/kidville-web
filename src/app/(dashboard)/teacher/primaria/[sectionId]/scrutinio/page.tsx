'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { GraduationCap, Check, Lock, Download, Upload, FileDown, FileText, Send } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { EliminaPagella, RiapriScrutinio, puoEliminarePagella, puoRiaprireScrutinio } from '@/components/features/primaria/AzioniScrutinio';
import { scaricaDocumento, type RisultatoScaricoNativo } from '@/lib/native/scarica';
import { avvisoDocumento } from '@/lib/native/documento-genitore';
import { isNativeApp } from '@/lib/push/native-register';

interface Alunno { id: string; nome: string; cognome: string }
interface Materia { id: string; nome: string; e_civica: boolean }
interface Periodo { id: string; nome: string; anno_scolastico: string }
interface Giudizio { alunno_id: string; materia_id: string; giudizio_sintetico: string | null }
interface Comportamento { alunno_id: string; giudizio_testo: string | null; giudizio_globale: string | null }
interface Scrutinio { id: string; stato: 'aperto' | 'chiuso'; chiuso_il: string | null; pubblicato?: boolean }

export default function ScrutinioPage() {
  const t = useTranslations('teacherPrimaria');
  const ts = useTranslations('shared');
  const f = useDateFormat();
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [periodi, setPeriodi] = useState<Periodo[]>([]);
  const [periodoId, setPeriodoId] = useState('');
  const [isDirigente, setIsDirigente] = useState(false);
  const [isStaff, setIsStaff] = useState(false);
  // Il ruolo reale: le azioni di Segreteria e Direzione (riapri, elimina pagella)
  // decidono da sé se mostrarsi, con la stessa regola del gate della route.
  const [ruolo, setRuolo] = useState<string | null>(null);

  const [scrutinio, setScrutinio] = useState<Scrutinio | null>(null);
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [mieMaterieIds, setMieMaterieIds] = useState<string[]>([]);
  const [scala, setScala] = useState<string[]>([]);
  // Alunni con un PDF di pagella DAVVERO archiviato: «Elimina pagella» si
  // monta solo su questi, mai su una pagella che non esiste.
  const [pagelleArchiviate, setPagelleArchiviate] = useState<string[]>([]);
  // La route dichiara quando NON è riuscita a leggere le pagelle archiviate:
  // l'elenco vuoto allora non vuol dire «nessuna pagella», e va detto a schermo.
  const [pagelleArchiviateNonLette, setPagelleArchiviateNonLette] = useState(false);
  // giudizi[alunnoId][materiaId] = etichetta
  const [giudizi, setGiudizi] = useState<Record<string, Record<string, string>>>({});
  const [comp, setComp] = useState<Record<string, { testo: string; globale: string }>>({});
  const [msg, setMsg] = useState('');
  // Esito di uno scarico non riuscito, accanto al bottone che l'ha avviato (non
  // in `msg`, in cima alla pagina: su un telefono, con una classe intera, il
  // bottone della pagella sta migliaia di pixel più sotto).
  // L'avviso porta con sé lo SCRUTINIO oltre all'alunno: sulla stessa sezione gli
  // alunni sono gli stessi in ogni periodo, e un avviso del primo quadrimestre
  // accanto al bottone del secondo direbbe fallita una pagella che nessuno ha toccato.
  const [avvisoPagella, setAvvisoPagella] = useState<{ scrutinioId: string; alunnoId: string; testo: string } | null>(null);
  const [avvisoTemplate, setAvvisoTemplate] = useState<{ scrutinioId: string | null; testo: string } | null>(null);
  // Pagelle in generazione nell'app (la GET con `persist=1` richiede qualche
  // secondo): il bottone si ferma, e un secondo tocco non apre un secondo foglio.
  // Il ref chiude la finestra fra due tocchi nello stesso ciclo di render.
  // Chiave `${scrutinioId}:${alunnoId}`: uno scarico ancora in volo per un altro
  // periodo non ferma il bottone di quello mostrato ora.
  const [pagelleInCorso, setPagelleInCorso] = useState<string[]>([]);
  const pagelleInCorsoRef = useRef<Set<string>>(new Set());
  // «Template CSV»: import di xlsx, file in Cache e foglio nativo richiedono un
  // attimo; un secondo tocco aprirebbe un secondo foglio, che il sistema rifiuta.
  const [templateInCorso, setTemplateInCorso] = useState(false);
  const templateInCorsoRef = useRef(false);
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
          setRuolo(typeof d.data.ruolo === 'string' ? d.data.ruolo : null);
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
        setMsg(d.error || t('comuneErrore'));
      } else {
        setScrutinio(d.data.scrutinio);
        setAlunni(d.data.alunni);
        setMaterie(d.data.materie);
        setMieMaterieIds(d.data.mieMaterieIds);
        setScala(d.data.scala);
        setPagelleArchiviate(Array.isArray(d.data.pagelleArchiviate) ? d.data.pagelleArchiviate : []);
        setPagelleArchiviateNonLette(d.data.pagelleArchiviateNonLette === true);
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
  }, [periodoId, sectionId, userId, t]);

  useEffect(() => { loadScrutinio(); }, [loadScrutinio]);

  // Ricarica al ritorno dalla scheda della pagella. Il listener chiama SEMPRE
  // l'ultima `loadScrutinio` (quella del periodo selezionato ORA), non quella
  // del render in cui è stato armato: altrimenti un focus tardivo ricaricherebbe
  // il periodo vecchio sotto al selettore che mostra quello nuovo, e «Riapri» o
  // «Elimina pagella» agirebbero sullo scrutinio sbagliato.
  const loadRef = useRef(loadScrutinio);
  useEffect(() => { loadRef.current = loadScrutinio; }, [loadScrutinio]);
  // Al massimo UN listener armato alla volta, tolto allo smontaggio.
  const ricaricaAlFocusRef = useRef<(() => void) | null>(null);
  const disarmaRicaricaAlFocus = useCallback(() => {
    if (ricaricaAlFocusRef.current) {
      window.removeEventListener('focus', ricaricaAlFocusRef.current);
      ricaricaAlFocusRef.current = null;
    }
  }, []);
  useEffect(() => disarmaRicaricaAlFocus, [disarmaRicaricaAlFocus]);

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
    setMsg(r.ok ? t('scrutinioGiudiziSalvati') : (d.error || t('comuneErrore')));
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
    setMsg(r.ok ? t('scrutinioComportamentoSalvato') : (d.error || t('comuneErrore')));
  };

  const chiudiScrutinio = async () => {
    if (!scrutinio || !userId) return;
    if (!confirm(t('scrutinioConfermaChiudi'))) return;
    setSaving(true); setMsg('');
    const r = await fetch(`/api/primaria/scrutinio/chiudi?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scrutinioId: scrutinio.id }),
    });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) {
      if (d.incompleto) setMsg(t('scrutinioIncompleto', { count: d.mancanti.length }));
      else setMsg(d.error || t('comuneErrore'));
      return;
    }
    setMsg(t('scrutinioChiuso'));
    loadScrutinio();
  };

  /**
   * Che cosa dire di uno scarico dall'helper unico (spec 2026-09-24, S4). Il log
   * lo scrive l'helper, successo compreso: qui si sceglie solo il testo. Sul
   * binario 1.0 (plugin della 1.1 assenti) il testo dice di aggiornare l'app: lì
   * riprovare non riuscirà mai. `null` = niente da dire (consegnato, o annullato
   * da chi scarica): toglie l'avviso di un tentativo precedente di QUEL bottone.
   */
  const testoEsitoScarico = (esito: RisultatoScaricoNativo): string | null => {
    const avviso = avvisoDocumento(esito);
    if (avviso === 'aggiorna') return ts('documentoAppDaAggiornare');
    if (avviso === 'riprova') return ts('documentoNonSalvato');
    return null;
  };

  const scaricaPagella = (alunnoId: string) => {
    if (!scrutinio) return;
    // Lo scrutinio di QUESTO tocco: se il periodo cambia mentre lo scarico è in
    // volo, l'esito resta legato al suo scrutinio e non finisce sotto l'altro.
    const scrutinioId = scrutinio.id;
    const chiave = `${scrutinioId}:${alunnoId}`;
    const indirizzo = `/api/primaria/pagella?scrutinioId=${scrutinioId}&alunnoId=${alunnoId}&persist=1&userId=${userId}`;
    if (isNativeApp()) {
      // Uno scarico di questa pagella è già in volo: un secondo tocco lancerebbe
      // una seconda generazione e un secondo foglio «Salva su File» in coda.
      if (pagelleInCorsoRef.current.has(chiave)) return;
      pagelleInCorsoRef.current.add(chiave);
      setPagelleInCorso(Array.from(pagelleInCorsoRef.current));
      // Nell'app la scheda di `window.open` non si apre (la WebView non ha finestre
      // multiple): il PDF passa dall'helper, che lo legge con la `fetch` della
      // WebView (stessa origine, coi cookie) e lo consegna al foglio «Salva su
      // File». Il nome porta solo frammenti di uuid, niente nomi di persona sul
      // dispositivo, e cambia con lo SCRUTINIO fissato a questo tocco: l'helper
      // scrive in Cache con quel nome, e due pagelle dello stesso alunno in volo
      // in periodi diversi non devono sovrascrivere lo stesso file mentre il
      // primo foglio «Salva su File» è ancora aperto (salverebbe il quadrimestre
      // sbagliato, senza errori). L'helper non lancia mai: il `.then` arriva
      // sempre, e sblocca il bottone.
      void scaricaDocumento({
        sorgente: indirizzo,
        nomeFile: `pagella-${alunnoId.slice(0, 8)}-${scrutinioId.slice(0, 8)}.pdf`,
        mime: 'application/pdf',
        etichetta: 'pagella',
      }).then((esito) => {
        pagelleInCorsoRef.current.delete(chiave);
        setPagelleInCorso(Array.from(pagelleInCorsoRef.current));
        const testo = testoEsitoScarico(esito);
        setAvvisoPagella((prec) =>
          testo
            ? { scrutinioId, alunnoId, testo }
            : prec?.scrutinioId === scrutinioId && prec.alunnoId === alunnoId ? null : prec,
        );
        // `persist=1` archivia il PDF già nella GET: comunque sia andato il
        // foglio, si rilegge lo scrutinio (quello del periodo selezionato ORA)
        // perché «Elimina pagella» compaia per la pagella appena creata.
        loadRef.current();
      });
      return;
    }
    // Sul web resta com'era: scheda nuova, e ricarica al ritorno sulla pagina.
    const scheda = window.open(indirizzo, '_blank');
    // `persist=1` archivia il PDF nella scheda appena aperta: quando si torna
    // qui si rilegge lo scrutinio, così «Elimina pagella» compare anche per
    // la pagella appena creata. Scheda non aperta (popup bloccato) = niente
    // archiviato e niente da ricaricare; già armato = basta quello.
    if (!scheda || ricaricaAlFocusRef.current) return;
    const alFocus = () => {
      disarmaRicaricaAlFocus();
      loadRef.current();
    };
    ricaricaAlFocusRef.current = alFocus;
    window.addEventListener('focus', alFocus);
  };

  // --- CSV: template + import massivo dei giudizi ---
  // M9.4: xlsx caricato on-demand negli handler (fuori dal bundle della pagina).
  const scaricaTemplate = async () => {
    // Un template è già in preparazione: il secondo tocco non lancia un secondo
    // foglio (rifiutato dal sistema, e il suo «riprova» smentirebbe il primo).
    if (templateInCorsoRef.current) return;
    templateInCorsoRef.current = true;
    setTemplateInCorso(true);
    // Il template contiene i giudizi del periodo di QUESTO tocco: l'esito resta
    // legato a quello scrutinio anche se nel frattempo si cambia periodo.
    const scrutinioId = scrutinio?.id ?? null;
    try {
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
      // Non più `XLSX.writeFile`: nella WebView il suo `<a download>` su un `blob:`
      // non scarica niente. Il file si costruisce qui come lo scriveva `writeFile`
      // (BOM UTF-8 in testa, che Excel usa per leggere gli accenti, più il CSV) e
      // passa dall'helper unico: sul web lo stesso scarico di prima, nell'app il
      // foglio «Salva su File».
      const csv = XLSX.write(wb, { bookType: 'csv', type: 'string' }) as string;
      const esito = await scaricaDocumento({
        sorgente: new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }),
        nomeFile: 'scrutinio-giudizi-template.csv',
        mime: 'text/csv',
        etichetta: 'scrutinio-template',
      });
      const testo = testoEsitoScarico(esito);
      setAvvisoTemplate(testo ? { scrutinioId, testo } : null);
    } finally {
      templateInCorsoRef.current = false;
      setTemplateInCorso(false);
    }
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
      if (!res.ok) { setMsg(d.error || t('scrutinioErroreImport')); }
      else {
        const errCount = (d.errori ?? []).length;
        const conErrori = errCount ? t('scrutinioImportateErrori', { count: errCount }) : '';
        setMsg(`${t('scrutinioImportate', { count: d.importate })}${conErrori} ✓`);
        loadScrutinio();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t('scrutinioErroreLettura'));
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
    setMsg(r.ok ? `${t('scrutinioPagelleGenerate', { generate: d.generate, totale: d.totale })} ✓` : (d.error || t('comuneErrore')));
    // Le pagelle appena archiviate rendono disponibile «Elimina pagella».
    if (r.ok) loadScrutinio();
  };

  const togglePubblica = async () => {
    if (!scrutinio || !userId) return;
    const nuovo = !pubblicato;
    if (nuovo && !confirm(t('scrutinioConfermaPubblica'))) return;
    setSaving(true); setMsg('');
    const r = await fetch(`/api/primaria/scrutinio/pubblica?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scrutinioId: scrutinio.id, pubblicato: nuovo }),
    });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) { setMsg(d.error || t('comuneErrore')); return; }
    setMsg(nuovo ? t('scrutinioVotiPubblicati') : t('scrutinioPubblicazioneRevocata'));
    loadScrutinio();
  };

  return (
    <div className="space-y-4">
      {/* Banner conformità O.M. 3/2025 (DR) */}
      <div className="flex items-start gap-2.5 rounded-xl border border-kidville-warn/25 bg-kidville-warn-soft px-3.5 py-3">
        <FileText size={16} className="mt-0.5 shrink-0 text-kidville-warn" />
        <span className="font-maven text-[12px] leading-snug text-kidville-warn">
          {t.rich('scrutinioBanner', { strong: (c) => <strong>{c}</strong> })}
        </span>
      </div>

      <div className="rounded-card bg-white p-5 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-barlow text-lg font-bold text-kidville-ink flex items-center gap-2">
            <GraduationCap size={18} className="text-kidville-green" /> {t('scrutinioTitolo')}
          </h2>
          <select
            value={periodoId}
            onChange={(e) => {
              // Gli avvisi di scarico parlano del periodo di prima: non restano
              // accanto ai bottoni di quello nuovo.
              setAvvisoPagella(null);
              setAvvisoTemplate(null);
              setPeriodoId(e.target.value);
            }}
            className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm"
          >
            <option value="">{t('scrutinioPeriodoPlaceholder')}</option>
            {periodi.map((p) => <option key={p.id} value={p.id}>{p.nome} ({p.anno_scolastico})</option>)}
          </select>
        </div>

        {periodi.length === 0 && (
          <p className="font-maven text-sm text-kidville-warn">
            {t('scrutinioNessunPeriodo')}{' '}
            {isStaff
              ? t('scrutinioConfiguraStaff')
              : t('scrutinioConfiguraNonStaff')}
          </p>
        )}

        {scrutinio && (
          <div className={`mb-3 inline-flex items-center gap-2 rounded-pill px-3 py-1 text-xs font-maven ${chiuso ? 'bg-kidville-neutral-soft text-kidville-ink' : 'bg-kidville-yellow-soft text-kidville-yellow-dark'}`}>
            {chiuso ? <Lock size={13} /> : null}
            {chiuso ? t('scrutinioChiusoIl', { data: scrutinio.chiuso_il ? f.dataBreve(scrutinio.chiuso_il) : '' }) : t('scrutinioAperto')}
          </div>
        )}

        {msg && <p className={`font-maven text-sm mb-2 ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</p>}

        {scrutinio && alunni.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white px-2 py-2 text-left font-maven text-xs text-kidville-muted">{t('scrutinioAlunno')}</th>
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
                          className="font-maven rounded-lg border border-kidville-line px-1.5 py-1 text-xs disabled:bg-kidville-cream disabled:text-kidville-sub"
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
              <Check size={15} /> {t('scrutinioSalvaGiudizi')}
            </button>
            <button
              onClick={scaricaTemplate}
              disabled={templateInCorso}
              aria-busy={templateInCorso ? 'true' : undefined}
              className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-4 py-2 text-sm text-kidville-green disabled:opacity-50"
            >
              <FileDown size={15} /> {t('scrutinioTemplateCsv')}
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-4 py-2 text-sm text-kidville-green disabled:opacity-50">
              <Upload size={15} /> {t('scrutinioImportaCsv')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importaCsv(f); }}
            />
            {avvisoTemplate && avvisoTemplate.scrutinioId === scrutinio.id && (
              <p role="alert" className="w-full rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
                {avvisoTemplate.testo}
              </p>
            )}
          </div>
        )}
      </div>

      {scrutinio && alunni.length > 0 && (
        <div className="rounded-card bg-white p-5 shadow-sm">
          <h3 className="font-barlow text-base font-bold text-kidville-ink mb-3">{t('scrutinioComportamentoTitolo')}</h3>
          {/* Lettura delle pagelle archiviate non riuscita: senza questo avviso la
              schermata sarebbe identica a «nessuna pagella archiviata». */}
          {chiuso && pagelleArchiviateNonLette && puoEliminarePagella(ruolo) && (
            <p role="status" className="mb-3 rounded-card border border-kidville-warn/25 bg-kidville-warn-soft px-3 py-2 font-maven text-sm text-kidville-warn">
              {t('pagelleArchiviateNonLette')}
            </p>
          )}
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
                    placeholder={t('scrutinioPlaceholderComportamento')}
                    className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm disabled:bg-kidville-cream"
                  />
                  <textarea
                    value={comp[a.id]?.globale || ''}
                    disabled={chiuso}
                    onChange={(e) => setComp((p) => ({ ...p, [a.id]: { testo: p[a.id]?.testo || '', globale: e.target.value } }))}
                    rows={2}
                    placeholder={t('scrutinioPlaceholderGlobale')}
                    className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm disabled:bg-kidville-cream"
                  />
                </div>
                {chiuso && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => scaricaPagella(a.id)}
                      disabled={pagelleInCorso.includes(`${scrutinio.id}:${a.id}`)}
                      aria-busy={pagelleInCorso.includes(`${scrutinio.id}:${a.id}`) ? 'true' : undefined}
                      className="mt-2 font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green disabled:opacity-50"
                    >
                      <Download size={13} /> {t('scrutinioPagellaPdf')}
                    </button>
                    {scrutinio && userId && pagelleArchiviate.includes(a.id) && (
                      <EliminaPagella
                        scrutinioId={scrutinio.id}
                        alunnoId={a.id}
                        nomeAlunno={`${a.cognome} ${a.nome}`}
                        userId={userId}
                        ruolo={ruolo}
                        onEliminata={(messaggio) => {
                          setMsg(messaggio);
                          // Il PDF non c'è più: il comando sparisce, invece di
                          // restare lì a promettere un secondo 404.
                          setPagelleArchiviate((prev) => prev.filter((id) => id !== a.id));
                        }}
                      />
                    )}
                    {avvisoPagella?.scrutinioId === scrutinio.id && avvisoPagella.alunnoId === a.id && (
                      <p role="alert" className="w-full rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
                        {avvisoPagella.testo}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {!chiuso && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={salvaComportamento} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
                <Check size={15} /> {t('scrutinioSalvaComportamento')}
              </button>
              {isDirigente && (
                <button onClick={chiudiScrutinio} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-warn px-5 py-2 text-sm text-white disabled:opacity-50">
                  <Lock size={15} /> {t('scrutinioChiudiScrutinio')}
                </button>
              )}
            </div>
          )}

          {chiuso && isDirigente && (
            <div className="mt-4 border-t border-kidville-line pt-4">
              <div className="mb-2 flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-xs font-maven ${pubblicato ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-neutral-soft text-kidville-ink'}`}>
                  {pubblicato ? t('scrutinioPubblicato') : t('scrutinioNonPubblicato')}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={generaTutte} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
                  <FileText size={15} /> {t('scrutinioGeneraPagelle')}
                </button>
                <button onClick={togglePubblica} disabled={saving} className={`font-maven inline-flex items-center gap-1.5 rounded-pill px-5 py-2 text-sm text-white disabled:opacity-50 ${pubblicato ? 'bg-kidville-neutral' : 'bg-kidville-green'}`}>
                  <Send size={15} /> {pubblicato ? t('scrutinioRevocaPubblicazione') : t('scrutinioPubblicaGenitori')}
                </button>
              </div>
            </div>
          )}

          {/* Riapertura: Segreteria e Direzione (spec 2026-09-24 §2), quindi
              anche la Segreteria che il blocco qui sopra, riservato al
              Dirigente, non vede. */}
          {chiuso && scrutinio && userId && puoRiaprireScrutinio(ruolo) && (
            <div className="mt-4 border-t border-kidville-line pt-4">
              <RiapriScrutinio
                scrutinioId={scrutinio.id}
                userId={userId}
                ruolo={ruolo}
                pubblicato={pubblicato}
                onRiaperto={(messaggio) => {
                  setMsg(messaggio);
                  loadScrutinio();
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
