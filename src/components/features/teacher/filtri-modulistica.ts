import type { CampoFiltro, OpzioneFiltro, Traduttore } from '@/lib/ui/filtri/tipi';

/**
 * ─── I FILTRI DELLE DUE SCHEDE DI «MODULISTICA» (DOCENTE) ────────────────────
 *
 * Il rovescio esatto della scheda del genitore: là l'elenco è di una famiglia e
 * sta tutto in memoria, qui è di una sezione intera e le due rotte i filtri li
 * accettano già. Perciò qui compaiono campi `dove: 'server'`, che là sarebbero
 * stati un errore.
 *
 * ── IL PARAMETRO CHE ESISTEVA E NESSUNO MANDAVA ────────────────────────────
 * `GET /api/teacher/medical-certificates` dichiara `stato` nel proprio schema
 * `zod` fin dal primo giorno, lo passa a `.eq('stato', stato)` — e l'interfaccia
 * non gliel'ha mai mandato: la scheda «Certificati medici» scaricava tutto e
 * mostrava tutto, con i validati e i rifiutati mescolati ai nuovi. Non c'era
 * niente da scrivere lato server: bastava dire il nome giusto.
 *
 * ⚠️ E il nome è la cosa che si sbaglia. `parseQuery` SCARTA ciò che non conosce:
 * un `?statoCert=` invece di `?stato=` non produce nessun errore, nessun log e
 * nessun rosso — produce l'elenco intero sotto una barra che dice di aver
 * filtrato. Il banco di prova non ripete i nomi a memoria: li legge dallo schema
 * della rotta (`__tests__/lib/filtri-modulistica-teacher.test.ts`, §3).
 *
 * ── SEZIONE E MODULO SONO LA DOMANDA, NON UN FILTRO ────────────────────────
 * `obbligatorio: true` dice tre cose in una: non entrano nel conteggio della
 * pastiglia «Filtri ③», non diventano chip removibili, e «Pulisci filtri» non li
 * tocca. Senza, il gesto che promette di rimettere ordine svuoterebbe la
 * schermata — un elenco senza modulo scelto non è «nessun risultato», è una
 * domanda che nessuno ha fatto.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Le righe, nella forma MINIMA che i filtri leggono
// ─────────────────────────────────────────────────────────────────────────────

export interface RigaSemaforo {
  student_id: string;
  nome: string;
  cognome: string;
  /** `green` = firmato · `red` = mancante. Lo compone la rotta dal `is_signed`. */
  status: string;
}

export interface RigaCertificatoDocente {
  id: string;
  nome_alunno?: string | null;
  cognome_alunno?: string | null;
  stato?: string | null;
}

/** Un modulo di autorizzazione fra cui scegliere. */
export interface ModuloSelezionabile {
  id: string;
  title: string;
}

const sezioniInOpzioni = (sezioni: readonly string[]): OpzioneFiltro[] =>
  sezioni.map((s) => ({ valore: s, etichetta: s }));

/**
 * Il campo «Sezione», identico nelle due schede.
 *
 * Vive in una funzione sola e non in due copie perché è LO STESSO campo: le due
 * barre lo mostrano nella stessa posizione, lo mandano con lo stesso nome e lo
 * tengono allo stesso valore. Due dichiarazioni gemelle sarebbero due cose che
 * divergono al primo ritocco — e la divergenza qui è un docente che guarda la
 * sezione A nel semaforo e la B nei certificati, senza accorgersene.
 */
function campoSezione<R>(t: Traduttore, sezioni: readonly string[], predefinita: string): CampoFiltro<R> {
  return {
    tipo: 'scelta',
    chiave: 'class_name',
    etichetta: t('modulisticaFiltroSezione'),
    dove: 'server',
    obbligatorio: true,
    primario: true,
    // Con una sezione sola il selettore non serve; con zero (identità non ancora
    // risolta) offrirebbe una tendina vuota, che è peggio di niente.
    nascondiSeVuoto: true,
    predefinito: predefinita,
    opzioni: sezioniInOpzioni(sezioni),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · «Semaforo consensi»
// ─────────────────────────────────────────────────────────────────────────────

export function campiSemaforo<R extends RigaSemaforo>(
  t: Traduttore,
  opzioni: {
    sezioni: readonly string[];
    moduli: readonly ModuloSelezionabile[];
    sezionePredefinita: string;
  },
): CampoFiltro<R>[] {
  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('modulisticaFiltroCercaAlunno'),
      segnaposto: t('modulisticaFiltroCercaAlunnoSegnaposto'),
      // A SCHERMO: la rotta del semaforo un parametro di ricerca non lo ha, e
      // l'elenco è di una sezione — trenta righe già in memoria. Mandarlo
      // significherebbe un parametro che `parseQuery` scarta in silenzio.
      dove: 'client',
      primario: true,
      testiDi: (r) => [r.cognome, r.nome],
    },
    campoSezione<R>(t, opzioni.sezioni, opzioni.sezionePredefinita),
    {
      tipo: 'scelta',
      chiave: 'form_id',
      etichetta: t('modulisticaFiltroModulo'),
      dove: 'server',
      obbligatorio: true,
      primario: true,
      nascondiSeVuoto: true,
      /**
       * 🔴 IL VALORE DI RIPOSO, e senza di lui la scheda non chiedeva NIENTE.
       *
       * `valoreNeutro` di una `scelta` è `predefinito ?? ''`. Senza `predefinito`
       * il modulo partiva vuoto, `queryServer` non lo scriveva (scrive solo i
       * valori non vuoti) e il semaforo non faceva nessuna richiesta: elenco
       * perennemente vuoto, nessun errore, nessun log. E non poteva ripararsi da
       * solo — nessun effetto ha il diritto di riscrivere lo stato dell'hook
       * (`react-hooks/set-state-in-effect` è un ERRORE in questo gate).
       *
       * Perciò la cornice si dichiara alla NASCITA: la pagina monta il pannello
       * solo quando i moduli della sezione sono noti, e con `key={sezione}`, così
       * qui il primo modulo c'è sempre. `''` quando la sezione non ne ha nessuno:
       * lì l'elenco è VUOTO, ed è la verità da mostrare.
       */
      predefinito: opzioni.moduli[0]?.id ?? '',
      opzioni: opzioni.moduli.map((m) => ({ valore: m.id, etichetta: m.title })),
    },
    {
      // Gli stessi due colori dei pallini della riga: verde «firmato», rosso
      // «mancante». Chi guarda deve riconoscere nel filtro il colore del dato.
      tipo: 'chip',
      chiave: 'stato',
      etichetta: t('modulisticaFiltroStato'),
      dove: 'client',
      opzioni: [
        { valore: 'green', etichetta: t('modulisticaStatoFirmato'), tono: 'success' },
        { valore: 'red', etichetta: t('modulisticaStatoMancante'), tono: 'error' },
      ],
      valoreDi: (r) => r.status,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · «Certificati medici»
// ─────────────────────────────────────────────────────────────────────────────

export function campiCertificatiMedici<R extends RigaCertificatoDocente>(
  t: Traduttore,
  opzioni: { sezioni: readonly string[]; sezionePredefinita: string },
): CampoFiltro<R>[] {
  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('modulisticaFiltroCercaAlunno'),
      segnaposto: t('modulisticaFiltroCercaAlunnoSegnaposto'),
      dove: 'client',
      primario: true,
      testiDi: (r) => [r.cognome_alunno, r.nome_alunno],
    },
    campoSezione<R>(t, opzioni.sezioni, opzioni.sezionePredefinita),
    {
      // I tre valori sono quelli del vincolo `certificati_medici_stato_chk`: un
      // quarto qui dentro sarebbe una scelta che la rotta accetta, il database
      // non conosce e l'elenco restituisce vuoto senza dire perché.
      tipo: 'scelta',
      chiave: 'stato',
      etichetta: t('modulisticaFiltroStato'),
      dove: 'server',
      opzioni: [
        { valore: 'in_validazione', etichetta: t('modulisticaInValidazione'), tono: 'warn' },
        { valore: 'validato', etichetta: t('modulisticaValidato'), tono: 'success' },
        { valore: 'rifiutato', etichetta: t('modulisticaRifiutato'), tono: 'error' },
      ],
    },
  ];
}
