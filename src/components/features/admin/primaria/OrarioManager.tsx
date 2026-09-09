'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
import { creaMuta } from '@/lib/ui/muta';

interface Campanella { id: string; giorno_settimana: number; ordine: number; ora_inizio: string; ora_fine: string; tipo: string }
interface Cella { giorno_settimana: number; campanella_id: string; materia_id: string | null; docente_id: string | null }
interface Materia { id: string; nome: string }
interface Docente { id: string; nome: string; cognome: string; gradi?: string[] }
/** Il corpo di `GET /api/admin/primaria/orario`, sotto `data`. */
interface DatiOrario { tempoScuola: { modello: number; giorni_settimana: number } | null; campanelle: Campanella[]; orario: Cella[] }

/** La rotta della PAGINA che monta questo componente: è il luogo dell'incidente nei log. */
const ROTTA = '/admin/primaria';

// Abbreviazioni giorni indicizzate per giorno_settimana (1=Lun): solo display → chiavi i18n.
const GIORNI_KEYS = ['orarioGiornoLun', 'orarioGiornoMar', 'orarioGiornoMer', 'orarioGiornoGio', 'orarioGiornoVen', 'orarioGiornoSab'] as const;
// `id` è il valore persistito/confrontato (tipo campanella); labelKey è solo display.
const TIPI: { id: string; labelKey: string }[] = [
  { id: 'lezione', labelKey: 'orarioTipoLezione' },
  { id: 'intervallo', labelKey: 'orarioTipoIntervallo' },
  { id: 'mensa', labelKey: 'orarioTipoMensa' },
];

// "HH:MM" + minuti → "HH:MM" (per proporre l'orario della campanella successiva).
function addMin(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Legge UNA delle tre risorse, e ritorna `null` — senza mai lanciare — su
 * qualunque modo di fallire: rete giù, 4xx/5xx, corpo non JSON, `success: false`.
 *
 * ─── PERCHÉ NON BASTAVA IL `try/finally` DI PRIMA ───────────────────────────
 *
 * `load()` aveva un `try { … } finally { … }` SENZA catch, e dentro il `finally`
 * tre `if (res.success)` senza `else`. Le due cose insieme fanno una cosa sola:
 * qualunque fallimento lascia lo stato com'era — `campanelle` a `[]` — e la
 * schermata rende «Imposta il tempo scuola per generare la griglia.» Quella non
 * è una schermata vuota: è un'AFFERMAZIONE («ho letto, e orario non ce n'è»)
 * che esce identica in quattro mondi — campanelle davvero assenti, `{error}` di
 * PostgREST ingoiato, 500 della route, rete caduta. E indirizza al pulsante
 * «Rigenera», che è quello che CANCELLA l'orario.
 *
 * ⚠️ Dei quattro mondi, il secondo — il `{error}` di PostgREST ingoiato — da qui
 * NON si separa, e va saputo prima di credere il contrario: la route risponde
 * `200 { success: true, campanelle: [] }` anche quando le sue tre query hanno
 * fallito, e per questa funzione è una lettura RIUSCITA e vuota. Il dettaglio, e
 * a chi tocca chiuderlo, stanno sul controllo del corpo qui sotto.
 *
 * Ritornare `null` invece di lanciare è ciò che permette a `Promise.all` di
 * andare fino in fondo: se cade `materie` si vogliono comunque le campanelle,
 * perché una griglia con le tendine vuote è meno peggio di nessuna griglia.
 *
 * Il fallimento si logga sempre (AGENTS.md regola 6: un catch che non logga è un
 * bug), con lo `stato` e mai il corpo — che qui può contenere il nome di una
 * classe o di una materia. ⚠️ Il log NON è il presidio: `logClient` scarta 401,
 * 403 e 404 prima di spedirli, e il 403 di sede è il rifiuto più probabile di
 * tutti con tre plessi. Ciò che resta fra il guasto e chi guarda è l'avviso a
 * schermo, ed è per questo che il chiamante deve distinguere `null` dai dati.
 */
async function leggi<T>(url: string, userId: string, evento: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'x-user-id': userId } });
    if (!res.ok) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: evento, route: ROTTA, stato: res.status });
      return null;
    }
    const corpo = (await res.json()) as { success?: boolean; data?: T } | null;
    /*
     * Un 200 con un corpo che non è quello atteso — `success` falso, `data`
     * assente — resta una lettura NON riuscita, e da qui esce `null`. È a costo
     * zero e copre le forme che una route può assumere domani.
     *
     * ⚠️ MA NON È IL PRESIDIO SUL `{error}` DI POSTGREST, e finché questa riga
     * ha detto di sì ha detto il falso — che è il difetto che AGENTS.md e
     * CLAUDE.md raccontano di sé stessi. Le tre route lette qui non emettono MAI
     * `success: false`: `GET /api/admin/primaria/orario` (route.ts:299)
     * destruttura le tre query buttando via i tre `error` e risponde
     * `200 { success: true, campanelle: [] }`. Per questa funzione è una lettura
     * RIUSCITA e vuota — cioè il QUARTO dei mondi elencati sopra, l'unico che da
     * qui non si può separare, perché nel corpo non c'è niente che distingua
     * «vuoto» da «errore ingoiato». Si chiude nella route, ed è la prima
     * dipendenza dichiarata a L1: controllare i tre `error` e rispondere 500.
     */
    if (!corpo?.success || corpo.data === undefined || corpo.data === null) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}-corpo`, route: ROTTA, stato: res.status });
      return null;
    }
    return corpo.data;
  } catch (err) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}: ${nomeErrore(err)}`, route: ROTTA });
    return null;
  }
}

export function OrarioManager({ sectionId, scuolaId, userId }: { sectionId: string; scuolaId: string; userId: string }) {
  const t = useTranslations('adminPrimaria');
  const [tempo, setTempo] = useState<{ modello: number; giorni_settimana: number } | null>(null);
  const [campanelle, setCampanelle] = useState<Campanella[]>([]);
  const [orario, setOrario] = useState<Cella[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [docenti, setDocenti] = useState<Docente[]>([]);
  const [modello, setModello] = useState(27);
  const [giorni, setGiorni] = useState(5);
  const [busy, setBusy] = useState(false);
  /**
   * L'esito dell'ultima lettura, ed è ciò che decide se la schermata ha il
   * DIRITTO di affermare che orario non ce n'è.
   *
   * Tre stati e non un booleano `guasto`, per una ragione che si vede al primo
   * fotogramma: con `guasto = true` di partenza la schermata accuserebbe un
   * guasto che non è ancora successo, e con `guasto = false` tornerebbe ad
   * affermare il vuoto prima di aver letto qualsiasi cosa. `'attesa'` è il solo
   * valore onesto finché le tre risposte non sono arrivate, e non dice niente.
   *
   * `'letta'` si raggiunge SOLO con tutte e tre le risposte buone: è la sola
   * condizione in cui «non c'è orario» è una notizia e non un'ipotesi.
   *
   * ⚠️ L'ESITO PORTA CON SÉ LA SEZIONE A CUI APPARTIENE, e non è una raffinatezza:
   * `admin/primaria/page.tsx:90` monta questo componente SENZA `key`, quindi
   * cambiando sezione dalla tendina non si rimonta niente — `tempo`, `campanelle`
   * e `orario` restano quelli di prima finché le tre GET nuove non rispondono. Un
   * `'letta'` senza nome di sezione varrebbe come «ho letto QUESTA», e in quella
   * finestra il bottone che cancella lavorerebbe sulla sezione nuova (il
   * `sectionId` della POST è già cambiato) contando le celle della vecchia: se la
   * vecchia era vuota, la conferma non uscirebbe nemmeno. Confrontando la sezione
   * si torna da soli in `'attesa'`, che è la verità.
   */
  const [esitoLettura, setEsitoLettura] = useState<{ sezione: string; stato: 'letta' | 'guasta' } | null>(null);
  const lettura: 'attesa' | 'letta' | 'guasta' = esitoLettura?.sezione === sectionId ? esitoLettura.stato : 'attesa';
  /** L'esito dell'ultima MUTAZIONE. Stringa vuota = nessun errore in piedi. */
  const [errore, setErrore] = useState('');

  /*
   * ⚠️ IL `try { … } finally { … }` SENZA `catch` NON È UN RESIDUO: è la forma che
   * `react-hooks/set-state-in-effect` accetta, ed è misurata, non supposta.
   * Scrivendo le stesse `setState` nel corpo lineare dopo l'`await` — stesso
   * codice, stessi rami — `npx eslint --max-warnings 0` diventa rosso su
   * `load()` dentro l'effetto (provato il 2026-09-09). Il vincolo è già
   * documentato in `admin/students/page.tsx`, che ci è arrivato dalla stessa
   * parte, insieme al secondo: NIENTE blocco `catch` qui dentro.
   *
   * Ed è proprio da questi due vincoli che era nato il difetto: il `try/finally`
   * senza ramo d'errore. La via d'uscita non era rinunciare al ramo — era
   * spostarlo dentro `leggi()`, che sta fuori dal componente e non lancia mai.
   */
  const load = useCallback(async () => {
    if (!sectionId) return;
    let letti: [DatiOrario | null, Materia[] | null, Docente[] | null] | null = null;
    try {
      letti = await Promise.all([
        leggi<DatiOrario>(`/api/admin/primaria/orario?sectionId=${sectionId}`, userId, 'orario-lettura-respinta'),
        leggi<Materia[]>(`/api/admin/primaria/materie?sectionId=${sectionId}`, userId, 'orario-materie-respinte'),
        leggi<Docente[]>(`/api/admin/primaria/docente-gradi?scuolaId=${scuolaId}`, userId, 'orario-docenti-respinti'),
      ]);
    } finally {
      // `letti` nullo vuol dire che è saltato `Promise.all` stesso: `leggi()` non
      // lancia, quindi non dovrebbe accadere — e se accade è un guasto, non un
      // vuoto. Il ripiego a tre `null` lo fa finire in `'guasta'` come gli altri,
      // invece di lasciare la schermata a raccontare l'orario che non ha letto.
      const [datiOrario, datiMaterie, datiDocenti] = letti ?? [null, null, null];

      if (datiOrario) {
        setTempo(datiOrario.tempoScuola);
        setCampanelle(datiOrario.campanelle);
        setOrario(datiOrario.orario);
        if (datiOrario.tempoScuola) {
          setModello(datiOrario.tempoScuola.modello);
          setGiorni(datiOrario.tempoScuola.giorni_settimana);
        }
      }
      /*
       * NON SI AZZERA NIENTE SU UN RIFIUTO. Prima era
       * `setMaterie(mRes.success ? mRes.data : [])`: un 403 su `/materie` — con
       * tre sedi, il rifiuto più probabile — svuotava la tendina, e una tendina
       * vuota dice «questa classe non ha materie», che è un'altra cosa. Chi
       * compilava l'orario si trovava senza scelte e senza una spiegazione.
       * L'ultimo valore buono resta, e del guasto parla l'avviso qui sotto.
       */
      if (datiMaterie) setMaterie(datiMaterie);
      if (datiDocenti) setDocenti(datiDocenti.filter((d: Docente) => (d.gradi ?? []).includes('primaria')));

      setEsitoLettura({ sezione: sectionId, stato: datiOrario && datiMaterie && datiDocenti ? 'letta' : 'guasta' });
    }
  }, [sectionId, scuolaId, userId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Le mutazioni «semplici»: quelle che dopo la risposta rileggono tutto.
   * `set-cell` non passa di qui — è ottimistica e le serve un rollback: vedi sotto.
   */
  const muta = creaMuta({
    route: ROTTA,
    ricarica: () => { void load(); },
    setErrore,
    fallback: t('orarioErroreOperazione'),
  });

  const intestazioni = { 'Content-Type': 'application/json', 'x-user-id': userId };
  const postAzione = (action: string, body: object, evento: string) =>
    muta(
      `/api/admin/primaria/orario?action=${action}&userId=${userId}`,
      { method: 'POST', headers: intestazioni, body: JSON.stringify(body) },
      evento,
    );

  /**
   * C'È DAVVERO QUALCOSA DA PERDERE? Si guarda ciò che si è LETTO, non `tempo`.
   *
   * `rigeneraCampanelle` cancella per SEZIONE (`DELETE FROM campanelle WHERE
   * section_id = …`), non per tempo scuola: le campanelle possono esserci anche
   * quando `tempoScuola` arriva nullo, e allora `tempo` non è il segnale di
   * «non c'è niente da distruggere» — è solo un altro segnale che tace.
   *
   * Non è un caso di scuola: la route legge il tempo con `maybeSingle()`, che
   * con DUE modelli attivi esce a mani vuote — lo dice il commento della route
   * stessa, sul ramo `errSpegni` — e la GET quell'errore non lo riporta. Il
   * client vede `tempoScuola: null` sopra una griglia piena, e la condizione
   * `if (tempo && …)` avrebbe cancellato le campanelle senza chiedere niente.
   * In produzione, misurato il 2026-09-09: 2 sezioni con campanelle, 60
   * campanelle in tutto, 0 celle, e ZERO sezioni oggi in quello stato — ma
   * «zero oggi» non è un invariante, e il segnale giusto costa la stessa riga.
   */
  const qualcosaDaPerdere = campanelle.length > 0 || orario.length > 0;

  const setTempoScuola = async () => {
    /*
     * «RIGENERA» È UNA CANCELLAZIONE, E VA DETTO PRIMA.
     *
     * Il pulsante è lo stesso di «Genera» e cambia solo etichetta. Dietro,
     * `action=set-tempo` chiama `rigeneraCampanelle`, che fa
     * `DELETE FROM campanelle WHERE section_id = …`; e la FK
     * `orario_settimanale_campanella_id_fkey` è `ON DELETE CASCADE`, quindi si
     * porta via TUTTE le celle materia/docente già compilate. Sul database di
     * produzione, il 2026-09-09, la sezione di prova contava NOVANTA righe in
     * `tempo_scuola`: novanta rigenerazioni, nessuna delle quali ha mai chiesto
     * niente a nessuno.
     *
     * La domanda NOMINA ciò che si perde, col numero vero (`orario.length` è già
     * in memoria): «sei sicuro?» non è una domanda a cui si possa rispondere.
     * Su una griglia davvero vuota non si chiede niente — non c'è ancora nulla
     * da distruggere, e una conferma che scatta sempre si impara a schiacciare
     * senza leggerla.
     *
     * ⚠️ E QUESTA RIGA VALE SOLO PERCHÉ LA LETTURA È BUONA. Il bottone che porta
     * qui è `disabled` finché `lettura !== 'letta'` (il perché sta sul bottone).
     * Senza quel gate «non ho potuto leggere» entrava qui sotto forma di
     * `campanelle` vuote — prima ancora, di `tempo` nullo — la domanda non
     * usciva affatto, e si cancellava senza chiedere PROPRIO nel caso in cui non
     * si sa che cosa: la stessa confusione fra «non lo so» e «non c'è» che
     * questo file è nato per togliere, tornata dentro la sua correzione.
     *
     * ⚠️ Questa è metà del rimedio: il server accetta ancora la cancellazione
     * senza condizioni. Il rifiuto 409 salvo flag esplicito è lavoro di route.
     */
    if (qualcosaDaPerdere && !window.confirm(t('orarioConfermaRigenera', { celle: orario.length }))) return;
    setBusy(true);
    await postAzione('set-tempo', { sectionId, modello, giorniSettimana: giorni }, 'orario-set-tempo-respinto');
    setBusy(false);
  };

  /**
   * La cella della griglia: OTTIMISTICA, quindi con ROLLBACK.
   *
   * Prima era `await fetch(...)` e basta — nessun `res.ok`, nessun catch, nessun
   * log, nessuna rilettura. Su un 400/403/500 la materia restava a schermo per
   * tutto il tempo in cui la pagina restava aperta, e nel database non c'era: la
   * segreteria leggeva un orario che non esisteva.
   *
   * Il rollback è LOCALE e non una rilettura (il modello è
   * `teacher/primaria/[sectionId]/appello/page.tsx`): è immediato, e soprattutto
   * non può fallire a sua volta — una rilettura che cadesse lascerebbe a schermo
   * proprio il valore sbagliato che doveva togliere.
   */
  const setCell = async (giorno: number, campanellaId: string, field: 'materiaId' | 'docenteId', value: string) => {
    const existing = orario.find((o) => o.campanella_id === campanellaId && o.giorno_settimana === giorno);
    const precedente = existing ?? null;
    const payload = {
      sectionId,
      giorno,
      campanellaId,
      materiaId: field === 'materiaId' ? value || null : existing?.materia_id ?? null,
      docenteId: field === 'docenteId' ? value || null : existing?.docente_id ?? null,
    };
    const senzaLaCella = (prev: Cella[]) => prev.filter((o) => !(o.campanella_id === campanellaId && o.giorno_settimana === giorno));
    const annulla = () => setOrario((prev) => (precedente ? [...senzaLaCella(prev), precedente] : senzaLaCella(prev)));

    // ottimistico
    setOrario((prev) => [...senzaLaCella(prev), { giorno_settimana: giorno, campanella_id: campanellaId, materia_id: payload.materiaId, docente_id: payload.docenteId }]);
    setErrore('');
    try {
      const res = await fetch(`/api/admin/primaria/orario?action=set-cell&userId=${userId}`, {
        method: 'POST',
        headers: intestazioni,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        annulla();
        logClient({ livello: 'error', evento: 'fetch', messaggio: 'orario-cella-respinta', route: ROTTA, stato: res.status });
        setErrore(await messaggioErrore(res, t('orarioErroreOperazione')));
      }
    } catch (err) {
      annulla();
      logClient({ livello: 'error', evento: 'fetch', messaggio: `orario-cella-respinta: ${nomeErrore(err)}`, route: ROTTA });
      setErrore(t('orarioErroreOperazione'));
    }
  };

  // ── Editing manuale delle singole campanelle (orari/tipo/aggiungi/elimina) ──
  const updateCampanella = async (campanellaId: string, patch: { oraInizio?: string; oraFine?: string; tipo?: string }) => {
    setBusy(true);
    await postAzione('update-campanella', { sectionId, campanellaId, ...patch }, 'orario-campanella-non-aggiornata');
    setBusy(false);
  };

  const deleteCampanella = async (campanellaId: string) => {
    setBusy(true);
    await postAzione('delete-campanella', { sectionId, campanellaId }, 'orario-campanella-non-eliminata');
    setBusy(false);
  };

  const addCampanella = async (giorno: number) => {
    const delGiorno = campanelle.filter((c) => c.giorno_settimana === giorno).sort((a, b) => a.ordine - b.ordine);
    const last = delGiorno[delGiorno.length - 1];
    const maxOrd = last ? last.ordine : 0;
    const start = last ? String(last.ora_fine).slice(0, 5) : '08:30';
    setBusy(true);
    await postAzione(
      'add-campanella',
      { sectionId, giornoSettimana: giorno, ordine: maxOrd + 1, oraInizio: start, oraFine: addMin(start, 60), tipo: 'lezione' },
      'orario-campanella-non-aggiunta',
    );
    setBusy(false);
  };

  if (!sectionId) return <p className="font-maven text-kidville-muted">{t('comuneSelezionaSezione')}</p>;

  const giorniPresenti = Array.from(new Set(campanelle.map((c) => c.giorno_settimana))).sort();
  const ordini = Array.from(new Set(campanelle.map((c) => c.ordine))).sort((a, b) => a - b);
  const campanellaDi = (g: number, o: number) => campanelle.find((c) => c.giorno_settimana === g && c.ordine === o);
  const cellDi = (campId: string, g: number) => orario.find((o) => o.campanella_id === campId && o.giorno_settimana === g);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-card bg-kidville-cream/50 p-3">
        <span className="font-maven text-sm text-kidville-ink">{t('orarioTempoScuola')}</span>
        <select value={modello} onChange={(e) => setModello(Number(e.target.value))} className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm">
          <option value={27}>{t('orarioModello27')}</option>
          <option value={29}>{t('orarioModello29')}</option>
          <option value={40}>{t('orarioModello40')}</option>
        </select>
        <select value={giorni} onChange={(e) => setGiorni(Number(e.target.value))} className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm">
          <option value={5}>{t('orarioGiorni5')}</option>
          <option value={6}>{t('orarioGiorni6')}</option>
        </select>
        {/*
          DISABILITATO FINCHÉ LA LETTURA NON È BUONA. Non è prudenza generica:
          questo bottone CANCELLA (`set-tempo` → `rigeneraCampanelle` → `DELETE
          FROM campanelle`, con la FK dell'orario in CASCADE). Dopo una lettura
          fallita non si sa né se una griglia c'è né quanto è grande: la conferma
          uscirebbe con un numero falso, o — com'era — non uscirebbe affatto,
          perché `tempo` e `campanelle` restano vuoti sia quando non c'è niente
          sia quando non si è potuto leggere. Sopra c'è già l'avviso che ammette
          di non sapere: offrire lì accanto un pulsante che distrugge è la
          contraddizione che ha fatto bocciare la prima stesura.
          Il gate sta QUI e non dentro `setTempoScuola` perché questo bottone ne
          è l'UNICO chiamante (verificato): una guardia nell'handler non sarebbe
          raggiungibile da nessun test, e un presidio che non si è mai visto
          scattare è esattamente ciò che questo lotto è stato bocciato per aver
          scritto. Chi domani appende lo stesso gesto a un'altra scorciatoia
          sposti il controllo nell'handler, e lo provi da lì.
          L'etichetta dice ciò che il gesto FA: «Rigenera» anche quando il tempo
          scuola non risulta ma la griglia c'è — la parola innocua sul pulsante
          che cancella era metà del difetto.
        */}
        <button onClick={setTempoScuola} disabled={busy || lettura !== 'letta'} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50">
          <Sparkles size={14} /> {tempo || qualcosaDaPerdere ? t('orarioRigenera') : t('orarioGenera')}
        </button>
        {tempo && <span className="font-maven text-xs text-kidville-muted">{t('orarioAttivo', { modello: tempo.modello, giorni: tempo.giorni_settimana })}</span>}
      </div>

      {errore && (
        <div role="alert" className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2.5 font-maven text-sm text-kidville-error-strong">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} />
          <span>{errore}</span>
        </div>
      )}

      {/*
        LA FRASE DIVERSA. Non «non c'è orario» ma «non ho potuto leggerlo»: sono
        due notizie opposte e finora erano la stessa. `role="alert"`: è un guasto
        sopraggiunto, e va annunciato anche a chi non guarda lo schermo. Il
        modello — avviso + «Riprova» — è `SedeNotice` in `@/lib/context/sede-context`.
      */}
      {lettura === 'guasta' && (
        <div role="alert" className="rounded-2xl border border-kidville-line bg-kidville-white p-4 text-center">
          <p className="font-barlow text-sm font-extrabold uppercase text-kidville-green">{t('orarioLetturaGuastaTitolo')}</p>
          <p className="mt-1 font-maven text-[13px] text-kidville-sub">{t('orarioLetturaGuastaCorpo')}</p>
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={() => { void load(); }}
              className="min-h-[44px] rounded-full bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase text-kidville-white transition-colors hover:bg-kidville-green-dark"
            >
              {t('orarioRiprova')}
            </button>
          </div>
        </div>
      )}

      {campanelle.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs font-maven">
            <thead>
              <tr>
                <th className="p-1.5 text-left text-kidville-muted">{t('orarioColonnaOra')}</th>
                {giorniPresenti.map((g) => (
                  <th key={g} className="p-1.5 text-center text-kidville-ink">{t(GIORNI_KEYS[g - 1])}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordini.map((ord) => {
                const ref = campanelle.find((c) => c.ordine === ord);
                return (
                  <tr key={ord} className="border-t border-kidville-line">
                    <td className="p-1.5 text-kidville-muted whitespace-nowrap">{ref?.ora_inizio?.slice(0, 5)}</td>
                    {giorniPresenti.map((g) => {
                      const camp = campanellaDi(g, ord);
                      if (!camp) return <td key={g} className="p-1.5" />;
                      if (camp.tipo !== 'lezione') {
                        return <td key={g} className="p-1.5 text-center text-kidville-muted">{camp.tipo === 'mensa' ? '🍽' : '☕'}</td>;
                      }
                      const cell = cellDi(camp.id, g);
                      return (
                        <td key={g} className="p-1 align-top">
                          <select
                            value={cell?.materia_id ?? ''}
                            onChange={(e) => setCell(g, camp.id, 'materiaId', e.target.value)}
                            className="mb-1 w-full rounded border border-kidville-line px-1 py-0.5"
                          >
                            <option value="">—</option>
                            {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
                          </select>
                          <select
                            value={cell?.docente_id ?? ''}
                            onChange={(e) => setCell(g, camp.id, 'docenteId', e.target.value)}
                            className="w-full rounded border border-kidville-line px-1 py-0.5 text-kidville-muted"
                          >
                            <option value="">{t('orarioDocentePlaceholder')}</option>
                            {docenti.map((d) => <option key={d.id} value={d.id}>{d.cognome}</option>)}
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : lettura === 'letta' ? (
        /*
          L'AFFERMAZIONE, e adesso è vera: le tre risposte sono arrivate tutte
          buone, e campanelle non ce n'è. È il caso di NOVE sezioni di primaria su
          undici (misurato in produzione il 2026-09-09), ed è a loro che questa
          frase serve — per questo non basta cancellarla.
        */
        <p className="font-maven text-sm text-kidville-muted">{t('orarioImpostaTempo')}</p>
      ) : null}

      {campanelle.length > 0 && (
        <details className="rounded-card border border-kidville-line bg-white p-3">
          <summary className="cursor-pointer font-maven text-sm font-semibold text-kidville-ink">{t('orarioModificaCampanelle')}</summary>
          <p className="mt-1 font-maven text-xs text-kidville-muted">{t('orarioModificaHint')}</p>
          <div className="mt-3 space-y-4">
            {giorniPresenti.map((g) => (
              <div key={g}>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">{t(GIORNI_KEYS[g - 1])}</span>
                  <button onClick={() => addCampanella(g)} disabled={busy} className="font-maven inline-flex items-center gap-1 rounded-pill bg-kidville-cream px-2.5 py-1 text-xs text-kidville-ink disabled:opacity-50">
                    <Plus size={12} /> {t('orarioAggiungiOra')}
                  </button>
                </div>
                <ul className="space-y-1.5">
                  {campanelle.filter((c) => c.giorno_settimana === g).sort((a, b) => a.ordine - b.ordine).map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-1.5">
                      <span className="w-5 font-maven text-xs text-kidville-muted">{c.ordine}</span>
                      <input
                        type="time"
                        defaultValue={String(c.ora_inizio).slice(0, 5)}
                        onBlur={(e) => { if (e.target.value && e.target.value !== String(c.ora_inizio).slice(0, 5)) updateCampanella(c.id, { oraInizio: e.target.value }); }}
                        className="rounded border border-kidville-line px-1.5 py-0.5 font-maven text-xs"
                        aria-label={t('orarioAriaOraInizio')}
                      />
                      <span className="text-xs text-kidville-muted">–</span>
                      <input
                        type="time"
                        defaultValue={String(c.ora_fine).slice(0, 5)}
                        onBlur={(e) => { if (e.target.value && e.target.value !== String(c.ora_fine).slice(0, 5)) updateCampanella(c.id, { oraFine: e.target.value }); }}
                        className="rounded border border-kidville-line px-1.5 py-0.5 font-maven text-xs"
                        aria-label={t('orarioAriaOraFine')}
                      />
                      <select value={c.tipo} onChange={(e) => updateCampanella(c.id, { tipo: e.target.value })} className="rounded border border-kidville-line px-1.5 py-0.5 font-maven text-xs">
                        {TIPI.map((tipo) => <option key={tipo.id} value={tipo.id}>{t(tipo.labelKey)}</option>)}
                      </select>
                      <button onClick={() => deleteCampanella(c.id)} disabled={busy} className="ml-auto inline-flex items-center rounded-pill p-1 text-kidville-error hover:bg-kidville-error/10 disabled:opacity-50" aria-label={t('orarioAriaElimina')}>
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
