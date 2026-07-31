'use client';

import { Suspense, useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search, Filter, UserPlus, Users, FileDown, CheckCircle2, GraduationCap, Briefcase, AlertTriangle, RotateCcw } from 'lucide-react';
import { StudentTable } from '@/components/features/admin/StudentTable';
import { BulkAssignBar } from '@/components/features/admin/BulkAssignBar';
import { SectionsView } from '@/components/features/admin/SectionsView';
import { CockpitPage, HEADER_BTN, PageHeader, Tabs, StatCard } from '@/components/ui/cockpit';
import { useLabelRuolo } from '@/lib/auth/ruoli';
import { useSediAttive } from '@/lib/context/sede-context';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';

type TipoVista = 'child' | 'adult' | 'sections' | 'staff';

/** La tab richiesta dall'URL (`?tab=sections` = back-link dal dettaglio sezione). */
const tabDaQuery = (v: string | null): TipoVista =>
  v === 'adult' || v === 'sections' || v === 'staff' ? v : 'child';

/**
 * «Questa tab aspetta un elenco dal server?» — e quindi: lo spinner va acceso?
 *
 * È l'UNICA condizione che decide, e la leggono TUTTI E TRE i punti che prima
 * decidevano per conto proprio: l'accensione iniziale di `isLoading`, l'effetto
 * che lancia il fetch e il cambio tab. Il difetto nasceva proprio da quella
 * separazione: `isLoading` partiva `true` per qualunque tab, ma solo tre su
 * quattro hanno un fetch — e `setIsLoading(false)` vive dentro `caricaElenco`.
 * Con `?tab=sections` (la Sezioni carica da sé, dentro `SectionsView`) nessun
 * fetch partiva, nessuno spegneva lo spinner, e «Caricamento anagrafica...»
 * restava lì per sempre: riaprire la voce di menu non ripara — è la stessa
 * rotta, il componente non si rimonta.
 *
 * Legare le tre decisioni a questa sola funzione è ciò che rende il difetto
 * irripetibile: una tab senza elenco non può più accendere uno spinner che
 * nessuno spegnerà, perché è lo stesso predicato a fare entrambe le cose.
 */
const attendeElenco = (v: TipoVista) => v !== 'sections';

interface Student {
  id: string;
  nome?: string;
  cognome?: string;
  first_name?: string;
  last_name?: string;
  data_nascita?: string;
  classe_sezione?: string | null;
  stato?: string;
  /** Segnale «c'è una nota medica»: la lista non riceve più il testo (W8). */
  ha_note_mediche?: boolean;
  codice_fiscale?: string | null;
  fiscal_code?: string | null;
  bes?: boolean;
  note_bes?: string | null;
  emails?: string[];
  phone_numbers?: string[];
  // Campi popolati solo per la tab Staff (elenco da `utenti`).
  ruolo?: string;
  sede_nome?: string;
  classi_count?: number;
}



function AdminStudentsInner() {
  const t = useTranslations('adminStudents');
  const labelRuolo = useLabelRuolo();
  // Tab iniziale dal query param (?tab=sections: back-link dal dettaglio sezione).
  const search = useSearchParams();
  const router = useRouter();
  const userId = search.get('userId');
  const { reFetchKey } = useSediAttive();
  // Calcolata UNA volta: la vista iniziale e lo spinner iniziale sono due
  // decisioni che devono nascere dallo stesso valore, non da due letture.
  const tabIniziale = tabDaQuery(search.get('tab'));
  const [students, setStudents] = useState<Student[]>([]);
  const [isLoading, setIsLoading] = useState(() => attendeElenco(tabIniziale));
  // «Non ho potuto caricare» ≠ «non c'è nessuno».
  //
  // `null` = nessun errore. `''` = errore senza un messaggio del server (rete
  // giù, corpo illeggibile) → si mostra il testo generico. Una stringa = il
  // motivo detto dal SERVER. La traduzione avviene al render e non dentro le
  // `useCallback`: `useTranslations` restituisce una funzione nuova a ogni
  // render, e metterla nelle dipendenze di una callback usata da un `useEffect`
  // farebbe ripartire l'effetto a ogni render — un ciclo di fetch infinito.
  const [erroreElenco, setErroreElenco] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [viewType, setViewType] = useState<TipoVista>(tabIniziale);
  
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [targetClass, setTargetClass] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [availableSections, setAvailableSections] = useState<{id: string, name: string, school_type: string, scuola_id?: string | null}[]>([]);
  // P5.4 (DL-050): gruppi mensa per la bulk assign
  const [mensaGroups, setMensaGroups] = useState<{ id: string; nome: string }[]>([]);
  const [targetMensa, setTargetMensa] = useState('');

  // Carica sezioni disponibili. `x-sedi` = chiave di re-fetch al cambio sedi
  // attive (il server scopa dal cookie); così reFetchKey è referenziato (deps).
  useEffect(() => {
    const hdr = { 'x-sedi': reFetchKey };
    fetch('/api/admin/sections', { headers: hdr }).then(r => r.json()).then(d => { if (Array.isArray(d)) setAvailableSections(d); }).catch(() => {});
    fetch('/api/admin/gruppi-mensa', { headers: hdr }).then(r => r.json()).then(d => { if (d?.success) setMensaGroups(d.data ?? []); }).catch(() => {});
  }, [reFetchKey]);

  // NOMI di classe univoci fra le sedi attive.
  //
  // Sia il filtro qui sotto sia la barra di assegnazione massiva lavorano sul
  // NOME (`s.classe_sezione === filterClass`; PATCH `{ classe_sezione }`), non
  // sull'identità della sezione. Dal 2026-07-29 lo stesso nome esiste in più
  // plessi: elencare le sezioni una per una produceva tre voci «3 ANNI»
  // identiche e con lo stesso valore — tre modi di dire la stessa cosa, offerti
  // come se fossero scelte diverse. Un nome = una voce; a decidere in quale sede
  // quel nome sia lecito è il server, per OGNI alunno selezionato
  // (`classeEsisteInOgniSede`, admin/students:PATCH).
  const nomiClasse = useMemo(
    () => [...new Set(availableSections.map((s) => s.name))].sort((a, b) => a.localeCompare(b, 'it')),
    [availableSections],
  );

  // Toast stabile (setter di stato = identità stabile): definito prima delle fetch
  // così `fetchStaff` può usarlo nelle dipendenze senza ricrearsi a ogni render.
  const showToastMsg = useCallback((msg: string) => {
    setToastMessage(msg);
    setShowToast(true);
    setTimeout(() => setShowToast(false), 3000);
  }, []);

  /**
   * Carica un elenco e DISTINGUE i tre esiti. Prima ce n'erano due soli — «ho
   * dei dati» e «tutto il resto» — e «tutto il resto» finiva nella card «Nessun
   * alunno trovato»: la rete giù raccontata come un archivio vuoto.
   *
   * ⚠️ DUE VINCOLI DI FORMA, entrambi imposti da `react-hooks/set-state-in-effect`
   * (che qui è un ERRORE del gate, non un warning) e misurati, non supposti:
   *
   *  1. NIENTE blocco `catch`. Un `catch { setStudents([]) }` aggiunto alla
   *     versione precedente fa fallire `eslint --max-warnings 0`. Il ramo
   *     d'errore vive su `.catch()` DELLA PROMISE: restituisce `null` e la
   *     gestione resta nel flusso normale, dopo l'`await`. Il motivo non si
   *     perde — lo si cattura nella callback (`motivo`) e lo si logga.
   *  2. IL `try { … } finally { setIsLoading(false) }` RESTA. Spostare quel
   *     `setIsLoading(false)` nel corpo lineare (stesso codice, stessi rami)
   *     fa scattare la regola. È la forma che l'analisi riconosce; toglierla
   *     costa un rosso senza guadagnare niente.
   *
   * Da questi due vincoli era nato il difetto: il `try/finally` SENZA ramo
   * d'errore. La via d'uscita non era rinunciare al ramo — era scriverlo qui.
   */
  const caricaElenco = useCallback(async (
    url: string,
    /** `null` = corpo inatteso: è un guasto, non una lista vuota. */
    estrai: (corpo: unknown) => Student[] | null,
    operazione: string,
  ) => {
    // Il NOME della classe d'errore, non il messaggio: `TypeError` (rete giù)
    // contro `Error` (il server ha detto di no) è l'unica distinzione che serve
    // al triage, ed è l'unico pezzo che può lasciare il dispositivo.
    let motivo = '';
    try {
      const res = await fetch(url, { headers: { 'x-sedi': reFetchKey } })
        .catch((e: unknown) => { motivo = nomeErrore(e); return null; });

      if (res === null) {
        // La fetch non è mai arrivata: rete giù, DNS, CORS. È il caso che nessun
        // log del server vedrà mai — e finora non lo vedeva nemmeno il client.
        setStudents([]);
        setErroreElenco('');
        logClient({ livello: 'error', evento: 'fetch', messaggio: `${operazione}: ${motivo}`, route: '/admin/students' });
        return;
      }
      if (!res.ok) {
        setStudents([]);
        setErroreElenco(await messaggioErrore(res, ''));
        logClient({ livello: 'error', evento: 'fetch', messaggio: operazione, route: '/admin/students', stato: res.status });
        return;
      }
      const corpo: unknown = await res.json().catch(() => null);
      const righe = estrai(corpo);
      if (righe === null) {
        // 200 con un corpo che non è una lista: `if (Array.isArray(data))` senza
        // `else` lo trattava esattamente come «non ci sono alunni».
        setStudents([]);
        setErroreElenco('');
        logClient({ livello: 'error', evento: 'fetch', messaggio: `${operazione}-corpo-inatteso`, route: '/admin/students', stato: res.status });
        return;
      }
      setStudents(righe);
      setErroreElenco(null);
    } finally {
      setIsLoading(false);
    }
  }, [reFetchKey]);

  const fetchStudents = useCallback(
    () => caricaElenco(
      `/api/admin/students?limit=1000`,
      (c) => (Array.isArray(c) ? (c as Student[]) : null),
      'anagrafica-alunni-non-caricata',
    ),
    [caricaElenco],
  );

  const fetchParents = useCallback(
    () => caricaElenco(
      `/api/admin/parents`,
      (c) => (Array.isArray(c) ? (c as Student[]) : null),
      'anagrafica-genitori-non-caricata',
    ),
    [caricaElenco],
  );

  // Personale reale da `utenti` via /api/admin/staff (non più il workaround su
  // parents.citizenship, che teneva la tab sempre vuota).
  const fetchStaff = useCallback(
    () => caricaElenco(
      '/api/admin/staff',
      (c) => {
        const j = c as { success?: boolean; data?: unknown[]; schools?: { id: string; nome: string }[]; assegnazioni?: { utente_id: string }[] } | null;
        if (!j?.success) return null;
        const sedi = new Map<string, string>((j.schools ?? []).map((s: { id: string; nome: string }) => [s.id, s.nome]));
        const nClassi = new Map<string, number>();
        for (const a of (j.assegnazioni ?? []) as { utente_id: string }[]) {
          nClassi.set(a.utente_id, (nClassi.get(a.utente_id) ?? 0) + 1);
        }
        return ((j.data ?? []) as { id: string; nome?: string; cognome?: string; email?: string | null; ruolo: string; scuola_id?: string | null }[]).map((u) => ({
          id: u.id,
          nome: u.nome,
          cognome: u.cognome,
          emails: u.email ? [u.email] : [],
          ruolo: u.ruolo,
          sede_nome: u.scuola_id ? (sedi.get(u.scuola_id) ?? '—') : '—',
          classi_count: nClassi.get(u.id) ?? 0,
        }));
      },
      'anagrafica-staff-non-caricata',
    ),
    [caricaElenco],
  );

  /** Ritenta l'elenco della tab corrente. Gestore d'evento: può alzare lo spinner. */
  const ricaricaElenco = () => {
    setIsLoading(true);
    setErroreElenco(null);
    if (viewType === 'adult') void fetchParents();
    else if (viewType === 'staff') void fetchStaff();
    else void fetchStudents();
  };

  // NB: lo spinner viene attivato dall'inizializzazione di `isLoading` e dal
  // cambio tab (onChange dei Tabs), non qui: setState sincrono negli effect è
  // vietato (react-hooks/set-state-in-effect). Entrambi i punti usano
  // `attendeElenco`, lo stesso predicato che governa la `return` qui sotto: se
  // questo effetto non lancia nessun fetch, lo spinner non si è mai acceso.
  useEffect(() => {
    if (!attendeElenco(viewType)) return; // Sezioni: SectionsView carica da sé.
    if (viewType === 'child') {
      fetchStudents();
    } else if (viewType === 'adult') {
      fetchParents();
    } else {
      fetchStaff();
    }
  }, [viewType, fetchStudents, fetchParents, fetchStaff]);

  // Lista filtrata derivata (niente state+effect: stessa resa, zero cascading render)
  const filteredStudents = useMemo(() => {
    let result = [...students];

    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      result = result.filter(s =>
        (s.nome && s.nome.toLowerCase().includes(search)) ||
        (s.cognome && s.cognome.toLowerCase().includes(search)) ||
        (s.first_name && s.first_name.toLowerCase().includes(search)) ||
        (s.last_name && s.last_name.toLowerCase().includes(search)) ||
        (s.codice_fiscale && s.codice_fiscale.toLowerCase().includes(search)) ||
        (s.fiscal_code && s.fiscal_code.toLowerCase().includes(search))
      );
    }

    if (viewType === 'child') {
      if (filterClass !== 'all') {
        result = result.filter(s => s.classe_sezione === filterClass);
      }

      if (filterStatus !== 'all') {
        result = result.filter(s => s.stato === filterStatus);
      }
    }

    return result;
  }, [searchTerm, filterClass, filterStatus, students, viewType]);

  const handleToggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handleToggleSelectAll = () => {
    if (selectedIds.size === filteredStudents.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredStudents.map(s => s.id)));
    }
  };

  // Apertura scheda anagrafica a TUTTA AREA (route dedicata /admin/students/[id],
  // non più il drawer laterale). `kind` instrada su scheda alunno o genitore/staff.
  const openDetail = useCallback((s: Student) => {
    const kind = viewType === 'adult' ? 'adult' : viewType === 'staff' ? 'staff' : 'child';
    const qs = new URLSearchParams({ kind });
    if (userId) qs.set('userId', userId);
    router.push(`/admin/students/${s.id}?${qs.toString()}`);
  }, [viewType, userId, router]);

  const handleBulkAssign = async () => {
    if (!targetClass || selectedIds.size === 0) return;
    setIsAssigning(true);
    try {
      const res = await fetch('/api/admin/students', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: Array.from(selectedIds),
          classe_sezione: targetClass
        }),
      });
      if (!res.ok) throw new Error('Errore bulk assign');

      showToastMsg(`✅ ${t('toastAssegnati', { n: selectedIds.size, classe: targetClass })}`);
      fetchStudents();
      setSelectedIds(new Set());
      setTargetClass('');
    } catch (err) {
      // Il nome della classe di destinazione NON entra nel log: è un dato di
      // contesto scolastico, e il messaggio è testo libero (nessuna whitelist lo guarda).
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `assegnazione-classe-massiva-fallita: ${nomeErrore(err)}`,
        route: '/admin/students',
      });
      showToastMsg(`❌ ${t('toastErrAssegnazione')}`);
    } finally {
      setIsAssigning(false);
    }
  };

  const handleBulkAssignMensa = async () => {
    if (!targetMensa || selectedIds.size === 0) return;
    setIsAssigning(true);
    try {
      const res = await fetch('/api/admin/students', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds), gruppo_mensa_id: targetMensa }),
      });
      if (!res.ok) throw new Error('Errore bulk mensa');
      const grp = mensaGroups.find(g => g.id === targetMensa);
      showToastMsg(`✅ ${t('toastAssegnatiMensa', { n: selectedIds.size, nome: grp?.nome ?? '' })}`);
      fetchStudents();
      setSelectedIds(new Set());
      setTargetMensa('');
    } catch (err) {
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `assegnazione-mensa-massiva-fallita: ${nomeErrore(err)}`,
        route: '/admin/students',
      });
      showToastMsg(`❌ ${t('toastErrMensa')}`);
    } finally {
      setIsAssigning(false);
    }
  };

  // Esporta l'elenco corrente (già filtrato) in CSV — lato client, nessuna nuova
  // API (non esiste un endpoint di export per l'anagrafica). Decisione utente.
  const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const handleExport = () => {
    const rows = filteredStudents;
    if (rows.length === 0) { showToastMsg(t('exportVuoto')); return; }
    const isChild = viewType === 'child';
    const isStaff = viewType === 'staff';
    const headers = isChild
      ? [t('csvCognome'), t('csvNome'), t('csvCodiceFiscale'), t('csvClasse'), t('csvStato')]
      : isStaff
        ? [t('csvCognome'), t('csvNome'), t('csvEmail'), t('csvRuolo'), t('csvSede')]
        : [t('csvCognome'), t('csvNome'), t('csvCodiceFiscale'), t('csvEmail'), t('csvTelefono')];
    const lines = rows.map((s) => {
      const cognome = s.cognome ?? s.last_name ?? '';
      const nome = s.nome ?? s.first_name ?? '';
      const cf = s.codice_fiscale ?? s.fiscal_code ?? '';
      const cols = isChild
        ? [cognome, nome, cf, s.classe_sezione ?? '', s.stato ?? '']
        : isStaff
          ? [cognome, nome, s.emails?.[0] ?? '', labelRuolo(s.ruolo ?? ''), s.sede_nome ?? '']
          : [cognome, nome, cf, s.emails?.[0] ?? '', s.phone_numbers?.[0] ?? ''];
      return cols.map((c) => csvCell(String(c))).join(',');
    });
    const csv = [headers.join(','), ...lines].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `anagrafica-${viewType}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToastMsg(`✅ ${t('toastExport', { n: rows.length })}`);
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
        <p className="font-maven text-kidville-muted">{t('caricamentoAnagrafica')}</p>
      </div>
    );
  }

  return (
    <CockpitPage max={1152} className="flex flex-col">
      <PageHeader
        icon={Users}
        eyebrow={t('listEyebrow')}
        title={t('listTitolo')}
        subtitle={t('listSottotitolo')}
        actions={
          <>
            <button
              onClick={handleExport}
              className="inline-flex h-[46px] items-center gap-2 rounded-pill border border-kidville-line bg-kidville-white px-5 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green transition-colors hover:border-kidville-green"
            >
              <FileDown size={16} /> {t('azioneEsporta')}
            </button>
            {/* Lo staff non si crea da qui (gestione RBAC dedicata): niente "Nuovo". */}
            {viewType !== 'staff' && (
              <button onClick={() => (window.location.href = '/admin/students/new')} className={HEADER_BTN}>
                <UserPlus size={18} /> {viewType === 'child' ? t('azioneNuovoAlunno') : t('azioneNuovoGenitore')}
              </button>
            )}
          </>
        }
      />

      {/* Tipo Vista (Tabs) */}
      <Tabs
        value={viewType}
        onChange={(id) => {
          const v = tabDaQuery(id);
          // Stesso predicato del montaggio: acceso se un elenco sta per partire,
          // SPENTO altrimenti. Non `if (v !== 'sections') setIsLoading(true)`:
          // così lo spinner non può nemmeno restare acceso da prima.
          setIsLoading(attendeElenco(v));
          setViewType(v);
        }}
        options={[
          { id: 'child', label: t('tabAlunni'), icon: Users },
          { id: 'adult', label: t('tabGenitori'), icon: Users },
          { id: 'sections', label: t('tabSezioni'), icon: GraduationCap },
          { id: 'staff', label: t('tabStaff'), icon: Briefcase },
        ]}
      />

      {/* Toolbar / Filtri — nascosta per la tab Sezioni */}
      {viewType !== 'sections' && (
      <div className="bg-kidville-white rounded-card p-4 shadow-sm mb-6 flex flex-col md:flex-row gap-4 items-center">
        {/* Search */}
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" size={18} />
          <input
            type="text"
            // Lo staff non ha codice fiscale in anagrafica: placeholder coerente
            // (il filtro resta lo stesso, cerca su nome/cognome).
            placeholder={viewType === 'staff' ? t('cercaStaff') : t('cercaDefault')}
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border-2 border-kidville-line rounded-input font-maven text-sm transition-colors focus:outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
          />
        </div>
        
        {/* Filtro Classe */}
        {viewType === 'child' && (
          <>
            <div className="flex items-center gap-2 w-full md:w-auto">
              <Filter size={16} className="text-kidville-muted" />
              <select
                value={filterClass}
                onChange={e => setFilterClass(e.target.value)}
                className="flex-1 md:w-40 border-2 border-kidville-line rounded-input px-3 py-2 font-maven text-sm text-kidville-ink/70 bg-kidville-white focus:outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
              >
                <option value="all">{t('filtroTutteClassi')}</option>
                {nomiClasse.map(nome => (
                  <option key={nome} value={nome}>{nome}</option>
                ))}
                <option value="">{t('filtroNonAssegnata')}</option>
              </select>
            </div>

            {/* Filtro Stato */}
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="w-full md:w-40 border-2 border-kidville-line rounded-input px-3 py-2 font-maven text-sm text-kidville-ink/70 bg-kidville-white focus:outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
            >
              <option value="all">{t('filtroTuttiStati')}</option>
              <option value="iscritto">{t('statoIscritto')}</option>
              <option value="ritirato">{t('statoRitirato')}</option>
              <option value="sospeso">{t('statoSospeso')}</option>
            </select>
          </>
        )}
      </div>
      )}

      {/* Content area — switch by viewType */}
      {viewType === 'sections' ? (
        <SectionsView />
      ) : erroreElenco !== null ? (
        /* L'elenco NON è arrivato. Questo riquadro prende il posto di contatori
           e tabella: lasciarli renderebbe «0 alunni» e «Nessun alunno trovato»,
           cioè due affermazioni sui dati fatte senza avere i dati. È di proposito
           diverso dalla card vuota — colore, titolo, e un bottone da premere. */
        <div role="alert" className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
          <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-error-soft text-kidville-error">
            <AlertTriangle size={34} strokeWidth={1.8} />
          </div>
          <h3 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('listErrTitolo')}</h3>
          <p className="font-maven mt-1 max-w-md text-sm text-kidville-muted">{erroreElenco || t('listErrCaricamento')}</p>
          <button
            onClick={ricaricaElenco}
            className="mt-4 inline-flex items-center gap-2 rounded-pill bg-kidville-green px-5 py-2.5 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-yellow"
          >
            <RotateCcw size={15} strokeWidth={2} /> {t('listErrRiprova')}
          </button>
        </div>
      ) : (
        <>
          {/* Statistiche rapide — solo per alunni */}
          {viewType === 'child' && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <StatCard icon={Users} label={t('statTotale')} value={students.length} tone="green" />
              <StatCard icon={CheckCircle2} label={t('statIscritti')} value={students.filter((s) => s.stato === 'iscritto').length} tone="success" />
              <StatCard icon={GraduationCap} label={t('statConBes')} value={students.filter((s) => s.bes).length} tone="warn" />
              {/* Conteggio dal SEGNALE, non dal testo: la lista non riceve più la
                  nota medica (W8), riceve solo `ha_note_mediche`. */}
              <StatCard icon={AlertTriangle} label={t('statConAllergie')} value={students.filter((s) => s.ha_note_mediche).length} tone="error" />
            </div>
          )}

          {/* Tabella */}
          <StudentTable
            students={filteredStudents}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            onStudentClick={openDetail}
            currentTypeFilter={viewType as 'child' | 'adult' | 'staff'}
          />

          {/* Floating Bulk Bar — non per lo staff: la sua PATCH agisce su `alunni`
              (assegnazione classe/mensa), priva di senso per il personale. */}
          {viewType !== 'staff' && (
            <BulkAssignBar
              selectedCount={selectedIds.size}
              availableClasses={nomiClasse}
              targetClass={targetClass}
              onTargetClassChange={setTargetClass}
              onAssign={handleBulkAssign}
              onClear={() => setSelectedIds(new Set())}
              isAssigning={isAssigning}
              mensaGroups={mensaGroups}
              targetMensa={targetMensa}
              onTargetMensaChange={setTargetMensa}
              onAssignMensa={handleBulkAssignMensa}
            />
          )}

        </>
      )}

      {/* Toast */}
      {showToast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-kidville-green text-kidville-white font-maven font-semibold px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-[slideInRight_0.3s_ease-out]">
          {toastMessage}
        </div>
      )}

      <style jsx global>{`
        @keyframes slideUp {
          from { transform: translate(-50%, 100%); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </CockpitPage>
  );
}

export default function AdminStudentsPage() {
  const t = useTranslations('adminStudents');
  return (
    <Suspense fallback={
      <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
        <p className="font-maven text-kidville-muted">{t('caricamentoAnagrafica')}</p>
      </div>
    }>
      <AdminStudentsInner />
    </Suspense>
  );
}
