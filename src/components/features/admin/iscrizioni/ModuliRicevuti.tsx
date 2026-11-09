'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useDateFormat } from '@/lib/i18n/date'
import {
  Baby, Users, FileText, CheckCircle2, XCircle, Loader2,
  ChevronLeft, Clock, KeyRound, AlertTriangle, ExternalLink, Star, MapPin,
} from 'lucide-react'
import { ADULT_ROLE_LABELS } from '@/lib/forms/enrollment-template'
import { LIMITE_ISCRIZIONI_DEFAULT } from '@/lib/api/paginazione'
import type { EnrollmentSubmissionData, EnrollmentChild, EnrollmentAdult } from '@/types/database.types'
import { StatCard } from '@/components/ui/cockpit'
import { useSediAttive } from '@/lib/context/sede-context'
import { useCalendario } from '@/lib/context/calendario-context'
import { annoAttivoDelCalendario, etichettaAnno, type RigaCalendario } from '@/lib/anno-scolastico'
import { STATO_DOMANDA_IN_ATTESA } from '@/lib/iscrizioni/stati'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { AVVISO_FINESTRA_BLOCCATA, apriDocumentoFirmato, apriLinkNellApp } from '@/lib/ui/apri-documento-firmato'
import { BarraFiltri, testiBarraFiltri } from '@/components/ui/BarraFiltri'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { ColonnaDettaglio } from '@/components/ui/ColonnaDettaglio'
import { useFiltri } from '@/lib/ui/filtri/use-filtri'
import { decidiStatoElenco } from '@/lib/ui/filtri/motore'
import { campiRicevuti } from './filtri-ricevuti'
import { opzioniSedeAttive } from '@/components/features/admin/opzioni-sede'

/**
 * Un errore bloccante dell'import. I campi oltre a `dove`/`messaggio` esistono solo
 * dove il pannello deve fare qualcosa di diverso dal mostrare il testo: oggi il
 * doppione (`POSSIBILE_DOPPIONE`, 2026-09-14), a cui si risponde riusando la scheda.
 */
interface ErroreImport {
  dove: string
  messaggio: string
  codice?: string
  /** L'indice del bambino nella domanda, da zero: la chiave di `abbinamenti`. */
  bambino?: number
  /** L'unica scheda gemella; assente quando sono più d'una e non se ne propone nessuna. */
  alunno_esistente_id?: string
}

// Esito dell'import. `success:false` = almeno un errore BLOCCANTE (referente/figlio non
// creati): l'invio resta tra i "Da importare" e va mostrato il pannello d'errore in evidenza.
interface ImportResult {
  success?: boolean
  credentials?: { email: string; password: string } | null
  credentialsEmailSent?: boolean
  warnings?: string[]
  errors?: ErroreImport[]
}

/** La scheda esistente che si può proporre per questo errore, oppure `null`. */
function schedaProponibile(er: ErroreImport): { bambino: number; alunnoId: string } | null {
  if (er.codice !== 'POSSIBILE_DOPPIONE') return null
  if (typeof er.bambino !== 'number' || typeof er.alunno_esistente_id !== 'string') return null
  return { bambino: er.bambino, alunnoId: er.alunno_esistente_id }
}

// "Moduli ricevuti": iscrizioni compilate via /iscrizione (enrollment_submissions)
// con import in anagrafica. Estratto da /admin/iscrizioni (tab "Ricevute").

// NB: niente `credentials` qui dentro. La GET non lo restituisce più (e la PATCH
// non lo archivia più): la password del genitore si vede UNA volta sola, nella
// risposta dell'import — vedi `ImportResult` qui sopra — e poi si rigenera da
// «Rigenera credenziali». Il campo era dichiarato e mai letto: toglierlo evita
// che qualcuno ci ricostruisca sopra un elenco di password.
//
// ⚠️ E dal 2026-08-04 (T11-F4) niente `data` NELL'ELENCO. La lista mostra il
// nome del primo bambino e due conteggi: prima, per disegnarli, si tirava giù
// il payload INTERO di ogni domanda — codici fiscali dei minori, ALLERGIE e
// NOTE MEDICHE in testo libero, recapiti degli adulti. Misurato in produzione:
// 299 domande, 514 kB verso il browser di ogni membro dello staff a ogni
// apertura della pagina, anche senza aprire nessun dettaglio. Ora l'elenco
// porta un `riassunto` e il payload arriva da `GET ?id=<uuid>`, cioè quando
// qualcuno APRE quella domanda: una alla volta, e per scelta.
interface RigaElenco {
  id: string
  status: 'pending' | 'approved' | 'rejected'
  assigned_classes?: Record<string, string>
  created_at: string
  // Sede per cui la famiglia ha fatto domanda (scelta al passo 0 del wizard).
  scuola_id?: string | null
  // Anno scolastico della domanda (`anni_scolastici.id`): le classi proposte sono quelle di QUELL'anno (PR 4.5.8).
  anno_id?: string | null
  riassunto?: { bambini: number; adulti: number; primo_bambino: string | null }
}

/** La domanda APERTA: la riga d'elenco più il payload, letto dal dettaglio. */
interface SubmissionRow extends RigaElenco {
  data: EnrollmentSubmissionData
}

interface Section { id: string; name: string; scuola_id?: string | null }

/**
 * I campi numerici compilati, convertiti in numeri. Salta i vuoti e chi è escluso.
 *
 * `esclusi` sono i bambini a carico di un fratello: per loro il campo importo non
 * si manda affatto. È la riga che impedisce di mandare uno zero — e lo zero, su
 * `alunni.importo_retta_mensile`, non significa «non paga»: significa «usa il
 * default di sede», cioè 150 € al mese.
 */
function numeriDaCampi(campi: Record<string, string>, esclusi: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(campi)) {
    if (esclusi[k]) continue
    const n = Number(String(v).replace(',', '.').trim())
    if (String(v).trim() !== '' && Number.isFinite(n)) out[k] = n
  }
  return out
}

/** Gli indici scelti in una tendina, come numeri. Le voci non scelte non si mandano. */
function indiciDaCampi(campi: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(campi)) {
    if (String(v).trim() === '') continue
    const n = Number(v)
    if (Number.isInteger(n) && n >= 0) out[k] = n
  }
  return out
}

export function ModuliRicevuti() {
  const t = useTranslations('adminAltro')
  /**
   * Il catalogo della SCHERMATA («Modulistica»), per le sole etichette dei
   * filtri. Le parole degli STATI restano quelle di `adminAltro`, cioè le stesse
   * del badge di ogni riga: due cataloghi per la stessa parola sono due parole
   * diverse nella stessa schermata.
   */
  const tm = useTranslations('adminModulistica')
  const ts = useTranslations('shared')
  const f = useDateFormat()
  const [rows, setRows] = useState<RigaElenco[]>([])
  const [totale, setTotale] = useState(0)
  /** Quante domande esistono in questa linguetta SENZA filtri (dal server). */
  const [totaleLinguetta, setTotaleLinguetta] = useState(0)
  /**
   * I tre conteggi per stato, dal DATABASE.
   *
   * Prima si contavano le righe CARICATE — cioè cinquanta su cinquecentotrenta —
   * e il ripiego era nascondere i riquadri finché non erano tutte in memoria:
   * la fotografia spariva proprio quando serviva.
   */
  const [conteggi, setConteggi] = useState<{ pending: number; approved: number; rejected: number }>({
    pending: 0,
    approved: 0,
    rejected: 0,
  })
  const [caricandoAltre, setCaricandoAltre] = useState(false)
  const [sections, setSections] = useState<Section[]>([])
  /** Le classi dell'anno della domanda aperta; `null` = quelle dell'elenco (l'anno in corso), come prima. */
  const [sezioniDellaDomanda, setSezioniDellaDomanda] = useState<Section[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<SubmissionRow | null>(null)
  const [aprendo, setAprendo] = useState<string | null>(null)
  /**
   * Un gettone per apertura: avanza a ogni clic su una riga e a ogni chiusura. Dal
   * 2026-10-17, sul telefono, il dettaglio è un foglio che si chiude (Escape, la X, lo
   * sfondo) anche mentre sta ancora arrivando — e senza gettone la risposta arrivata
   * dopo lo RIAPRIREBBE da sola, o due clic veloci mostrerebbero la domanda sbagliata.
   */
  const gettoneDettaglio = useRef(0)

  /** Chiude il dettaglio, anche a metà caricamento: la risposta in volo non tocca più lo schermo. */
  function chiudiDettaglio() {
    gettoneDettaglio.current += 1
    setAprendo(null)
    setSelected(null)
  }
  const [assignments, setAssignments] = useState<Record<string, string>>({})
  /**
   * LA RETTA, CHIESTA AL MOMENTO DELL'IMPORT — e perché non era così prima.
   *
   * Fino al 2026-09-02 l'import chiedeva solo la classe. Il bambino nasceva con
   * `importo_retta_mensile = 0`, e chi genera le rette mensili legge:
   *
   *     COALESCE(NULLIF(importo_retta_mensile, 0), retta_default_importo, 150)
   *   (formula STORICA: dalla PR 4.6 la generazione dell'anno non ripiega più su 150; lo zero resta da non scrivere)
   *
   * `NULLIF(…, 0)` ANNULLA LO ZERO: ogni bambino importato dal modulo si prendeva
   * 150 €/mese senza che nessuno l'avesse deciso e senza che nessun errore
   * comparisse da nessuna parte. In archivio, il 2026-09-02, quaranta alunni veri
   * erano in questa condizione.
   *
   * Tre stati e non uno solo perché le domande sono tre e vanno tenute distinte:
   *  · `rette`        quanto paga (stringa: è il valore grezzo del campo, e "" ≠ 0)
   *  · `retteACarico` chi non paga, e QUALE fratello paga per lui — mai lo zero
   *  · `intestatari`  a quale adulto si intesta la fattura (serve la detrazione)
   *  · `giorniScadenza` il giorno del mese, vuoto = default di sede
   */
  const [rette, setRette] = useState<Record<string, string>>({})
  const [retteACarico, setRetteACarico] = useState<Record<string, string>>({})
  const [intestatari, setIntestatari] = useState<Record<string, string>>({})
  const [giorniScadenza, setGiorniScadenza] = useState<Record<string, string>>({})
  const [referenteIndex, setReferenteIndex] = useState(0)
  /**
   * «È lo stesso bambino»: indice del bambino → scheda esistente da riusare.
   *
   * Si ACCUMULA fra un tentativo e l'altro: con due bambini doppi la segreteria
   * risponde al primo, l'import si ferma sul secondo, e la seconda risposta non deve
   * far dimenticare la prima. Si azzera solo aprendo un'altra domanda.
   */
  const [abbinamenti, setAbbinamenti] = useState<Record<string, string>>({})
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  /** La URL firmata che il browser ha rifiutato di aprire: si offre come link. */
  const [docBloccato, setDocBloccato] = useState<string | null>(null)

  const { reFetchKey, sedi, effettive } = useSediAttive()

  /**
   * L'ANNO DELLA DOMANDA (PR 4.5.14). Il calendario di ogni sede viene da `useCalendario().perSede`: l'elenco mostra
   * domande di più sedi e un hook per sede non si può chiamare in un ciclo. Una domanda senza `anno_id`, o una sede
   * senza calendario (il database della CI, non migrato), non ha anno: niente etichetta, niente pulsante.
   */
  const { perSede } = useCalendario()
  const [spostando, setSpostando] = useState(false)
  /** L'esito dell'ultimo spostamento, scritto sotto il pulsante; sparisce aprendo un'altra domanda. */
  const [esitoSposta, setEsitoSposta] = useState<{ tipo: 'ok' | 'errore'; testo: string } | null>(null)

  const rigaAnnoDi = (r: RigaElenco): RigaCalendario | null => {
    if (!r.anno_id || !r.scuola_id) return null
    return perSede[r.scuola_id]?.find((c) => c.annoId === r.anno_id) ?? null
  }
  /** `2027/28` se la domanda NON è per l'anno attivo della sua sede; `null` altrimenti (oggi sono quasi tutte così). */
  const etichettaFuoriAnno = (r: RigaElenco): string | null => {
    const riga = rigaAnnoDi(r)
    const attivo = annoAttivoDelCalendario(r.scuola_id ? perSede[r.scuola_id] : null)
    if (!riga || !attivo || riga.annoId === attivo.annoId) return null
    return etichettaAnno(riga.annoInizio, 'breve')
  }
  /** Gli anni della sede, diversi da quello della domanda, che accettano ancora domande. */
  const altriAnniAperti = (r: RigaElenco): RigaCalendario[] => {
    if (!r.anno_id || !r.scuola_id || r.status !== STATO_DOMANDA_IN_ATTESA) return []
    return (perSede[r.scuola_id] ?? []).filter((c) => c.annoId !== r.anno_id && c.domandeAperte)
  }

  // Con tre plessi la domanda va letta insieme alla sua sede: importare "alla cieca"
  // significa archiviare un bambino di Aversa a Giugliano. L'uuid non dice niente a
  // nessuno, quindi si risolve nel nome del plesso.
  const nomeSede = (scuolaId?: string | null) =>
    sedi.find((s) => s.id === scuolaId)?.nome ?? t('ricevutiSedeSconosciuta')

  /**
   * I campi della barra: TUTTI `dove: 'server'`.
   *
   * Le etichette degli stati arrivano da `adminAltro`, cioè dalle stesse chiavi
   * con cui `StatusBadge` disegna la pastiglia di ogni riga.
   */
  const campi = campiRicevuti(
    tm,
    {
      pending: t('ricevutiStatAttesa'),
      approved: t('badgeImportata'),
      rejected: t('badgeRifiutata'),
    },
    opzioniSedeAttive(sedi, effettive),
    (iso) => f.dataBreve(iso),
  )
  const filtri = useFiltri<RigaElenco>(campi)

  /**
   * ⚠️ SI RICARICA ANCHE QUANDO CAMBIA `chiaveServer`, ed è il punto di tutto.
   *
   * `chiaveServer` è una STRINGA stabile e già attesa (debounce di 300 ms): un
   * `URLSearchParams` qui dentro sarebbe un oggetto nuovo a ogni render, cioè un
   * ciclo di fetch infinito che si presenta come «la pagina è lenta».
   */
  useEffect(() => { load(reFetchKey, filtri.chiaveServer, true) }, [reFetchKey, filtri.chiaveServer])

  /**
   * @param azzera  la richiesta nasce da un CAMBIO DI FILTRO: l'accumulo delle
   *   pagine si svuota PRIMA che parta la pagina 0. Senza, `offset=rows.length`
   *   punterebbe dentro il risultato VECCHIO e le due pagine si fonderebbero —
   *   righe di due insiemi diversi nella stessa lista, con lo stesso aspetto.
   */
  async function load(sediKey: string, chiave: string, azzera = false) {
    if (azzera) {
      setRows([])
      setTotale(0)
    }
    try {
      const hdr = { 'x-sedi': sediKey }
      const coda = chiave ? `&${chiave}` : ''
      const [r, s] = await Promise.all([
        fetch(`/api/admin/iscrizioni?limit=${LIMITE_ISCRIZIONI_DEFAULT}&offset=0${coda}`, { headers: hdr }).then(x => x.json()),
        fetch('/api/admin/sections', { headers: hdr }).then(x => x.json()),
      ])
      // La risposta è `{ data, total }`: `total` è il conteggio ESATTO lato
      // database, non la lunghezza della pagina. Serve a dire all'operatore
      // quante domande ci sono davvero, e non solo quante gliene sono arrivate.
      if (Array.isArray(r?.data)) {
        setRows(r.data as RigaElenco[])
        setTotale(typeof r.total === 'number' ? r.total : r.data.length)
        // ⚠️ RIPIEGO SUL TOTALE FILTRATO quando il server non lo manda: una
        // risposta senza `totaleLinguetta` (un deploy più vecchio, una pagina in
        // cache) non deve far sparire i riquadri e la barra — sarebbe una
        // schermata che si svuota per un campo assente, non per un dato.
        setTotaleLinguetta(
          typeof r.totaleLinguetta === 'number'
            ? r.totaleLinguetta
            : typeof r.total === 'number'
              ? r.total
              : r.data.length,
        )
        if (r.conteggi && typeof r.conteggi === 'object') {
          const c = r.conteggi as Record<string, unknown>
          const n = (v: unknown) => (typeof v === 'number' ? v : 0)
          setConteggi({ pending: n(c.pending), approved: n(c.approved), rejected: n(c.rejected) })
        }
      }
      if (Array.isArray(s)) setSections(s)
    } catch (e) {
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `moduli-iscrizione-caricamento-fallito: ${nomeErrore(e)}`,
        route: '/admin/iscrizioni',
      })
    } finally {
      setLoading(false)
    }
  }

  /** Pagina successiva, in coda a quelle già mostrate. */
  async function caricaAltre() {
    setCaricandoAltre(true)
    try {
      // ⚠️ LA STESSA `chiaveServer` DELLA PAGINA 0. Senza, l'offset conterebbe
      // righe di un insieme e la pagina arriverebbe da un altro: due elenchi
      // diversi fusi in una lista sola, con lo stesso aspetto.
      const coda = filtri.chiaveServer ? `&${filtri.chiaveServer}` : ''
      const r = await fetch(
        `/api/admin/iscrizioni?limit=${LIMITE_ISCRIZIONI_DEFAULT}&offset=${rows.length}${coda}`,
        { headers: { 'x-sedi': reFetchKey } },
      ).then(x => x.json())
      if (Array.isArray(r?.data)) {
        // Deduplicato per `id`: il modulo pubblico riceve invii di continuo, e
        // una domanda arrivata fra la prima pagina e la seconda sposta tutto di
        // uno — cioè fa ricomparire una riga già mostrata, con la stessa `key`.
        setRows(prec => {
          const perId = new Map(prec.map((riga) => [riga.id, riga]))
          for (const riga of r.data as RigaElenco[]) perId.set(riga.id, riga)
          return [...perId.values()]
        })
        if (typeof r.total === 'number') setTotale(r.total)
      }
    } catch (e) {
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `moduli-iscrizione-pagina-fallita: ${nomeErrore(e)}`,
        route: '/admin/iscrizioni',
      })
    } finally {
      setCaricandoAltre(false)
    }
  }

  /**
   * Apre una domanda: è QUI che il payload viene chiesto, per una riga sola.
   * L'esito non si butta via — il server risponde 404 anche quando la domanda
   * è di un'altra sede, e un pannello che resta vuoto senza dire niente è
   * peggio di un errore.
   */
  /**
   * Le classi proposte per un bambino sono quelle dell'anno DELLA domanda (PR 4.5.8): una domanda per l'anno prossimo sceglie
   * fra le sezioni di quell'anno, non fra quelle di oggi. Se la lettura cade restano le classi dell'elenco, come prima:
   * il server rifiuta comunque una classe che non è dell'anno della domanda.
   */
  async function caricaSezioniDellAnno(riga: SubmissionRow, mio: number) {
    try {
      const sede = riga.scuola_id ? `&scuola_id=${encodeURIComponent(riga.scuola_id)}` : ''
      const res = await fetch(`/api/admin/sections?anno_id=${encodeURIComponent(String(riga.anno_id))}${sede}`, {
        headers: { 'x-sedi': reFetchKey },
      })
      const json = await res.json()
      if (mio !== gettoneDettaglio.current) return
      if (res.ok && Array.isArray(json)) setSezioniDellaDomanda(json as Section[])
    } catch (e) {
      logClient({
        livello: 'warn',
        evento: 'react',
        messaggio: `iscrizione-sezioni-anno-non-lette: ${nomeErrore(e)}`,
        route: '/admin/iscrizioni',
      })
    }
  }

  async function openDetail(row: RigaElenco) {
    const mio = ++gettoneDettaglio.current
    setSelected(null)
    setAprendo(row.id)
    setSezioniDellaDomanda(null)
    setEsitoSposta(null)
    setAssignments(row.assigned_classes ?? {})
    // Retta e affini NON si precompilano: decisione del titolare del 2026-09-02.
    // Un valore già scritto nel campo è un valore che si conferma senza guardarlo,
    // ed è esattamente il modo in cui i 150 € di default sono passati inosservati
    // per quaranta bambini. Chi importa deve digitare la cifra.
    setRette({})
    setRetteACarico({})
    setIntestatari({})
    setGiorniScadenza({})
    setReferenteIndex(0)
    setAbbinamenti({})
    setResult(null)
    try {
      const res = await fetch(`/api/admin/iscrizioni?id=${encodeURIComponent(row.id)}`, {
        headers: { 'x-sedi': reFetchKey },
      })
      const json = await res.json()
      // Chiuso, o superato da un altro clic, mentre la risposta viaggiava.
      if (mio !== gettoneDettaglio.current) return
      if (!res.ok || !json?.data) {
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `iscrizione-dettaglio-non-aperto: http ${res.status}`,
          route: '/admin/iscrizioni',
        })
        alert(json?.error ?? t('ricevutiDettaglioNonAperto'))
        return
      }
      const aperta = json.data as SubmissionRow
      if (aperta.anno_id) await caricaSezioniDellAnno(aperta, mio)
      if (mio !== gettoneDettaglio.current) return
      setSelected(aperta)
    } catch (e) {
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `iscrizione-dettaglio-fallito: ${nomeErrore(e)}`,
        route: '/admin/iscrizioni',
      })
      if (mio === gettoneDettaglio.current) alert(t('ricevutiDettaglioNonAperto'))
    } finally {
      if (mio === gettoneDettaglio.current) setAprendo(null)
    }
  }

  /**
   * La scansione allegata alla domanda: URL firmata dal server, scheda nuova.
   *
   * ⚠️ QUESTA FUNZIONE ERA ROTTA IN TRE PUNTI, e il difetto si vedeva solo su
   * Safari e dentro la WebView Capacitor — cioè proprio dove la segreteria apre
   * l'app dal telefono. Apriva la finestra DOPO l'`await`, quindi il popup
   * blocker la fermava; non guardava `res.ok`, quindi un 403 finiva in un
   * `json.url` assente e in nessun messaggio; e faceva `await res.json()` senza
   * rete di protezione, cioè una promise rifiutata non gestita su un corpo non
   * JSON. Il gesto era lo stesso di `CandidatureInsegnanti`, ma la copia aveva
   * già smesso di somigliare all'originale: adesso il COME sta in un posto solo
   * (`@/lib/ui/apri-documento-firmato`) e qui resta solo cosa dire.
   */
  async function viewDoc(path?: string) {
    if (!path) return
    setDocBloccato(null)
    const esito = await apriDocumentoFirmato({
      endpoint: '/api/admin/iscrizioni',
      path,
      headers: { 'x-sedi': reFetchKey },
      route: '/admin/iscrizioni',
      etichetta: 'iscrizione-documento',
    })
    if (esito.esito === 'bloccato') setDocBloccato(esito.url)
    else if (esito.esito === 'errore') alert(t('ricevutiDocumentoErrore'))
  }

  /**
   * @param nuovoAbbinamento  la risposta a un `POSSIBILE_DOPPIONE` («è lo stesso
   *   bambino»): si aggiunge a quelle già date e l'import si ripete con TUTTO ciò che
   *   la segreteria aveva scelto — classe, retta, intestatario. Arriva come argomento,
   *   e non letto dallo stato dopo averlo scritto, perché `setAbbinamenti` non
   *   aggiorna lo stato in tempo per questa stessa chiamata.
   */
  async function doImport(nuovoAbbinamento?: { bambino: number; alunnoId: string }) {
    if (!selected) return
    const daMandare = nuovoAbbinamento
      ? { ...abbinamenti, [String(nuovoAbbinamento.bambino)]: nuovoAbbinamento.alunnoId }
      : abbinamenti
    if (nuovoAbbinamento) setAbbinamenti(daMandare)
    setWorking(true)
    setResult(null)
    try {
      const res = await fetch('/api/admin/iscrizioni', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selected.id,
          action: 'import',
          assignments,
          referenteIndex,
          // I quattro campi economici. Si mandano NUMERI, non stringhe: la
          // conversione avviene qui, una volta, invece che in tre punti del server.
          // Chi è a carico di un fratello non manda nessuna cifra — la sua retta
          // NON è zero, è di qualcun altro, e la differenza vale 150 € al mese.
          rette: numeriDaCampi(rette, retteACarico),
          retteACarico: indiciDaCampi(retteACarico),
          intestatari: indiciDaCampi(intestatari),
          giorniScadenza: numeriDaCampi(giorniScadenza, {}),
          abbinamenti: daMandare,
        }),
      })
      const json = await res.json()
      if (!res.ok) { alert(json.error ?? t('ricevutiImportFallito')); return }
      // `success:false` = errori bloccanti: l'invio resta 'pending' (nessun cambio di stato
      // lato server), quindi resta tra i "Da importare" e i pulsanti Importa/Rifiuta restano
      // disponibili per riprovare. Il pannello d'errore lo mostra in evidenza.
      setResult({
        success: json.success !== false,
        credentials: json.credentials,
        credentialsEmailSent: json.credentialsEmailSent,
        warnings: json.warnings,
        errors: json.errors,
      })
      await load(reFetchKey, filtri.chiaveServer)
    } catch (e) {
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `iscrizione-import-fallito: ${nomeErrore(e)}`,
        route: '/admin/iscrizioni',
      })
      alert(t('ricevutiErroreImport'))
    } finally {
      setWorking(false)
    }
  }

  async function doReject() {
    if (!selected) return
    if (!confirm(t('ricevutiConfermaRifiuto'))) return
    setWorking(true)
    try {
      const res = await fetch('/api/admin/iscrizioni', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selected.id, action: 'reject' }),
      })
      // L'esito NON si butta via: il server può rispondere 403 (domanda di un'altra
      // sede). Ricaricare e chiudere il pannello senza guardare significherebbe dire
      // all'operatore "fatto" su un rifiuto che non è mai avvenuto.
      if (!res.ok) {
        // Un corpo illeggibile non deve far sparire l'avviso all'operatore: si
        // ripiega sul messaggio generico, ma l'anomalia si logga (mai un catch muto).
        const json = await res.json().catch((e: unknown) => {
          logClient({
            livello: 'warn',
            evento: 'react',
            messaggio: `iscrizione-rifiuto-corpo-illeggibile: ${nomeErrore(e)}`,
            route: '/admin/iscrizioni',
          })
          return {} as { error?: string }
        })
        alert(json.error ?? t('ricevutiImportFallito'))
        return
      }
      await load(reFetchKey, filtri.chiaveServer)
      setSelected(null)
    } finally {
      setWorking(false)
    }
  }

  /**
   * Sposta una domanda IN ATTESA a un altro anno aperto della sua sede (PR 4.5.14, route `sposta-anno` della 4.5.8).
   * Le classi scelte erano dell'altro anno: si azzerano e si rileggono quelle del nuovo. 409 = qualcuno l'ha già
   * esaminata (l'anno non cambia, si rilegge l'elenco); 422 = la sede ha chiuso quell'anno nel frattempo (il pulsante resta).
   * Nei log solo codici di stato: la domanda è un'anagrafica di minori.
   */
  async function spostaAnno(destinazione: RigaCalendario) {
    if (!selected || spostando) return
    const domanda = selected
    const anno = etichettaAnno(destinazione.annoInizio, 'breve')
    if (!confirm(t('ricevutiSpostaAnnoConferma', { anno }))) return
    const mio = gettoneDettaglio.current
    setSpostando(true)
    setEsitoSposta(null)
    try {
      const res = await fetch('/api/admin/iscrizioni/sposta-anno', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sedi': reFetchKey },
        body: JSON.stringify({ domanda_id: domanda.id, anno_id: destinazione.annoId }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string; codice?: string }
      const ancoraAperta = mio === gettoneDettaglio.current
      if (res.ok) {
        setRows((prec) => prec.map((r) => (r.id === domanda.id ? { ...r, anno_id: destinazione.annoId } : r)))
        if (!ancoraAperta) return
        const spostata = { ...domanda, anno_id: destinazione.annoId }
        setSelected(spostata)
        setAssignments({})
        setSezioniDellaDomanda(null)
        await caricaSezioniDellAnno(spostata, mio)
        setEsitoSposta({ tipo: 'ok', testo: t('ricevutiSpostaAnnoFatto', { anno }) })
        return
      }
      logClient({
        livello: 'warn',
        evento: 'react',
        messaggio: `iscrizione-sposta-anno-rifiutato: http ${res.status} ${json.codice ?? 'senza-codice'}`,
        route: '/admin/iscrizioni',
      })
      if (res.status === 409) await load(reFetchKey, filtri.chiaveServer)
      if (!ancoraAperta) return
      setEsitoSposta({
        tipo: 'errore',
        testo:
          res.status === 409
            ? (json.error ?? t('ricevutiSpostaAnnoGiaEsaminata'))
            : res.status === 422
              ? t('ricevutiSpostaAnnoNonOfferto')
              : t('ricevutiSpostaAnnoErrore'),
      })
    } catch (e) {
      logClient({
        livello: 'warn',
        evento: 'react',
        messaggio: `iscrizione-sposta-anno-fallito: ${nomeErrore(e)}`,
        route: '/admin/iscrizioni',
      })
      if (mio === gettoneDettaglio.current) setEsitoSposta({ tipo: 'errore', testo: t('ricevutiSpostaAnnoErrore') })
    } finally {
      setSpostando(false)
    }
  }

  const tutteCaricate = rows.length >= totale
  /**
   * Quale delle cinque schermate rendere.
   *
   * ⚠️ `totale` qui è quello della LINGUETTA, non quello filtrato: dire «nessun
   * risultato con questi filtri» su una tabella che non ha mai avuto una riga
   * accusa i filtri di una colpa che non hanno, e manda a cercare un filtro che
   * non esiste.
   */
  const statoElenco = decidiStatoElenco({
    caricamento: loading,
    errore: false,
    totale: totaleLinguetta,
    mostrati: rows.length,
  })

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
        <p className="font-maven text-sm text-kidville-muted max-w-xl">{t('ricevutiIntro')}</p>
        <a
          href="/admin/sidi"
          className="inline-flex h-[40px] items-center gap-2 rounded-pill bg-kidville-green-soft px-4 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green hover:bg-kidville-green/20"
        >
          <ExternalLink size={16} /> {t('ricevutiSidi')}
        </a>
      </div>

      {!loading && totaleLinguetta > 0 && (
        // I QUATTRO riquadri, sempre. «Totale» è il conteggio filtrato del
        // server; gli altri tre vengono dai conteggi ESATTI per stato, sulla
        // stessa selezione. Prima contavano le righe CARICATE — cinquanta su
        // cinquecentotrenta — e per non mentire si nascondevano: la fotografia
        // spariva proprio quando serviva.
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={Users} label={t('ricevutiStatTotale')} value={totale} tone="green" />
          <StatCard icon={Clock} label={t('ricevutiStatAttesa')} value={conteggi.pending} tone="warn" />
          <StatCard icon={CheckCircle2} label={t('ricevutiStatImportate')} value={conteggi.approved} tone="success" />
          <StatCard icon={XCircle} label={t('ricevutiStatRifiutate')} value={conteggi.rejected} tone="error" />
        </div>
      )}

      {/* La barra non si disegna su una linguetta che non ha mai avuto una riga:
          filtrare il nulla non è un'operazione che qualcuno voglia fare. */}
      {totaleLinguetta > 0 && (
        <BarraFiltri
          campi={campi}
          stato={filtri}
          testi={testiBarraFiltri(ts)}
          totale={totaleLinguetta}
          mostrati={totale}
          className="mb-5"
        />
      )}

      {statoElenco !== 'pronto' ? (
        <StatoElenco
          stato={statoElenco}
          testi={{ ...testiStatoElenco(ts), vuotoTitolo: t('ricevutiVuoto') }}
          attivi={filtri.attivi}
          onPulisci={filtri.pulisci}
        />
      ) : (
        // `lg:items-start`: la cella del dettaglio è alta quanto il dettaglio, non quanto
        // la lista — è ciò che lascia a `ColonnaDettaglio` lo spazio per restare ferma.
        <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
          {/* Lista */}
          {/* L'attenuazione sta sulla COLONNA dell'elenco: il pannello di
              dettaglio non ha niente da aspettare quando cambia un filtro. */}
          <div
            className={`space-y-3 ${filtri.inAttesa ? 'opacity-60' : ''}`}
            aria-busy={filtri.inAttesa || undefined}
          >
            <p className="text-xs font-bold uppercase tracking-wider text-kidville-muted">
              {t('ricevutiListaHeader', { attesa: conteggi.pending, totale: rows.length })}
            </p>
            {/* `sub` e non `muted`: la riga qui sotto È l'avviso che l'elenco è troncato —
                l'unico segnale che dice all'operatore che ci sono domande che non sta
                vedendo. Scriverla nel grigio a basso contrasto renderebbe poco leggibile
                proprio la frase che esiste per farsi leggere. (lock `testo-muted-allowlist`) */}
            {!tutteCaricate && (
              <p className="text-xs text-kidville-sub font-maven">
                {t('ricevutiMostrate', { n: rows.length, totale })}
              </p>
            )}
            {rows.map(row => {
              const nChildren = row.riassunto?.bambini ?? 0
              const nAdults = row.riassunto?.adulti ?? 0
              const fuoriAnno = etichettaFuoriAnno(row)
              return (
                <button
                  key={row.id}
                  onClick={() => openDetail(row)}
                  className={`w-full text-left bg-kidville-white rounded-card p-4 border transition-all ${
                    selected?.id === row.id ? 'border-kidville-green ring-1 ring-kidville-green/30' : 'border-kidville-line hover:border-kidville-line'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-barlow font-bold text-kidville-ink">
                      {row.riassunto?.primo_bambino ?? t('ricevutiFallbackNome')}
                    </span>
                    <StatusBadge status={row.status} />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-kidville-muted font-maven flex-wrap">
                    <span className="flex items-center gap-1"><Baby size={13} /> {nChildren}</span>
                    <span className="flex items-center gap-1"><Users size={13} /> {nAdults}</span>
                    <span>{f.dataBreve(row.created_at)}</span>
                    <span className="flex items-center gap-1 text-kidville-green font-semibold">
                      <MapPin size={13} /> {nomeSede(row.scuola_id)}
                    </span>
                    {fuoriAnno && (
                      <span className="rounded-full bg-kidville-warn-soft px-2 py-0.5 text-[10px] font-bold uppercase text-kidville-warn">
                        {t('ricevutiAnnoPer', { anno: fuoriAnno })}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
            {!tutteCaricate && (
              <button
                onClick={caricaAltre}
                // ⚠️ Spento anche durante i 300 ms di debounce di un cambio di
                // filtro (`inAttesa`): lì `chiaveServer` è ancora quella VECCHIA e
                // un clic chiederebbe la pagina successiva del risultato di PRIMA,
                // accodandola a un elenco che sta per essere sostituito.
                disabled={caricandoAltre || filtri.inAttesa}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-kidville-line px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-[0.03em] text-kidville-green hover:bg-kidville-green-soft disabled:opacity-50"
              >
                {caricandoAltre && <Loader2 size={14} className="animate-spin" />}
                {t('ricevutiMostraAltre')}
              </button>
            )}
          </div>

          {/* Dettaglio: fermo accanto alla lista sul computer, in un foglio sopra la
              lista sul telefono (vedi `ColonnaDettaglio`). */}
          <ColonnaDettaglio
            aperto={aprendo !== null || selected !== null}
            onChiudi={chiudiDettaglio}
            titolo={t('ricevutiDettaglioTitolo')}
            occupato={aprendo !== null}
            chiaveContenuto={aprendo ?? selected?.id ?? null}
            segnaposto={
              <div className="bg-kidville-white rounded-card p-10 text-center border border-kidville-line text-kidville-muted font-maven">
                {t('ricevutiSelezionaDettagli')}
              </div>
            }
          >
            {aprendo ? (
              <div className="bg-kidville-white rounded-card p-10 flex items-center justify-center gap-3 border border-kidville-line">
                <Loader2 className="w-5 h-5 animate-spin text-kidville-green" />
                <span className="font-maven text-kidville-sub">{t('caricamento')}</span>
              </div>
            ) : selected ? (
              <DetailPanel
                row={selected}
                sections={sezioniDellaDomanda ?? sections}
                nomeSede={nomeSede(selected.scuola_id)}
                annoDomanda={(() => {
                  const r = rigaAnnoDi(selected)
                  return r ? etichettaAnno(r.annoInizio, 'breve') : null
                })()}
                altriAnni={altriAnniAperti(selected)}
                spostando={spostando}
                esitoSposta={esitoSposta}
                onSposta={spostaAnno}
                assignments={assignments}
                setAssignments={setAssignments}
                rette={rette}
                setRette={setRette}
                retteACarico={retteACarico}
                setRetteACarico={setRetteACarico}
                intestatari={intestatari}
                setIntestatari={setIntestatari}
                giorniScadenza={giorniScadenza}
                setGiorniScadenza={setGiorniScadenza}
                referenteIndex={referenteIndex}
                setReferenteIndex={setReferenteIndex}
                working={working}
                result={result}
                // Una funzione che non passa l'evento: `doImport` accetta un
                // abbinamento come primo argomento, e il clic gli darebbe il MouseEvent.
                onImport={() => doImport()}
                onUsaSchedaEsistente={(proposta) => doImport(proposta)}
                onReject={doReject}
                onViewDoc={viewDoc}
                docBloccato={docBloccato}
                onBack={chiudiDettaglio}
              />
            ) : null}
          </ColonnaDettaglio>
        </div>
      )}
    </>
  )
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('adminAltro')
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: t('ricevutiStatAttesa'), cls: 'bg-kidville-warn-soft text-kidville-warn' },
    approved: { label: t('badgeImportata'), cls: 'bg-kidville-success-soft text-kidville-success' },
    rejected: { label: t('badgeRifiutata'), cls: 'bg-kidville-error-soft text-kidville-error' },
  }
  const m = map[status] ?? map.pending
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${m.cls}`}>{m.label}</span>
}

function DetailPanel({
  row, sections, nomeSede, annoDomanda, altriAnni, spostando, esitoSposta, onSposta, assignments, setAssignments,
  rette, setRette, retteACarico, setRetteACarico,
  intestatari, setIntestatari, giorniScadenza, setGiorniScadenza,
  referenteIndex, setReferenteIndex,
  working, result, onImport, onUsaSchedaEsistente, onReject, onViewDoc, docBloccato, onBack,
}: {
  row: SubmissionRow
  sections: Section[]
  nomeSede: string
  /** `2026/27`, o `null` se la domanda non ha anno o il calendario non c'è. */
  annoDomanda: string | null
  /** Gli altri anni della sede che accettano domande: vuoto = niente spostamento. */
  altriAnni: RigaCalendario[]
  spostando: boolean
  esitoSposta: { tipo: 'ok' | 'errore'; testo: string } | null
  onSposta: (destinazione: RigaCalendario) => void
  assignments: Record<string, string>
  setAssignments: (a: Record<string, string>) => void
  rette: Record<string, string>
  setRette: (a: Record<string, string>) => void
  retteACarico: Record<string, string>
  setRetteACarico: (a: Record<string, string>) => void
  intestatari: Record<string, string>
  setIntestatari: (a: Record<string, string>) => void
  giorniScadenza: Record<string, string>
  setGiorniScadenza: (a: Record<string, string>) => void
  referenteIndex: number
  setReferenteIndex: (n: number) => void
  working: boolean
  result: ImportResult | null
  onImport: () => void
  /** Ripete l'import riusando la scheda proposta da un `POSSIBILE_DOPPIONE`. */
  onUsaSchedaEsistente: (proposta: { bambino: number; alunnoId: string }) => void
  onReject: () => void
  onViewDoc: (path?: string) => void
  /** URL firmata che il browser ha bloccato: sta in cima, non accanto al bottone
      premuto — i pulsanti «Documento» sono uno per bambino e uno per adulto, e
      l'avviso è uno solo. */
  docBloccato: string | null
  onBack: () => void
}) {
  const t = useTranslations('adminAltro')
  const ts = useTranslations('shared')
  const children = row.data?.children ?? []
  const adults = row.data?.adults ?? []
  const done = row.status !== 'pending'
  // L'anno scelto nell'elenco a discesa (solo con più di un altro anno aperto); di default il primo.
  const [sceltoId, setSceltoId] = useState('')
  const destinazione = altriAnni.find((a) => a.annoId === sceltoId) ?? altriAnni[0] ?? null
  // Le sezioni sono per plesso e i nomi si ripetono fra sedi ("3 ANNI" esiste in
  // tutte e tre): offrire quelle delle altre sedi porta dritti a un `section_id`
  // NULL, perché il trigger DB risolve il nome SOLO dentro la scuola dell'alunno.
  // Se l'invio non ha sede (storico) non c'è niente su cui filtrare: si mostrano tutte.
  const sezioniSede = row.scuola_id
    ? sections.filter((s) => s.scuola_id === row.scuola_id)
    : sections

  return (
    <div className="bg-kidville-white rounded-card border border-kidville-line p-5 space-y-5">
      <button onClick={onBack} className="lg:hidden flex items-center gap-1 text-sm text-kidville-muted">
        <ChevronLeft size={16} /> {t('ricevutiIndietro')}
      </button>

      {/* Per quale scuola si sta importando: prima di ogni altro dato. */}
      <p className="flex items-center gap-1.5 rounded-xl bg-kidville-green-soft px-3 py-2 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green">
        <MapPin size={14} /> {t('ricevutiSede')} <strong>{nomeSede}</strong>
      </p>

      {annoDomanda && (
        <div className="space-y-2">
          <p className="font-maven text-sm text-kidville-ink">
            {t('ricevutiAnnoDomanda', { anno: annoDomanda })}
          </p>
          {destinazione && (
            <div className="flex flex-wrap items-center gap-2">
              {altriAnni.length > 1 && (
                <>
                  <label htmlFor="ricevuti-sposta-anno" className="text-[11px] font-semibold text-kidville-muted uppercase">
                    {t('ricevutiSpostaAnnoScegli')}
                  </label>
                  <select
                    id="ricevuti-sposta-anno"
                    value={destinazione.annoId}
                    onChange={(e) => setSceltoId(e.target.value)}
                    disabled={spostando}
                    className="min-w-0 px-3 py-2 rounded-lg border border-kidville-line text-sm bg-white focus:outline-none focus:border-kidville-green"
                  >
                    {altriAnni.map((a) => (
                      <option key={a.annoId} value={a.annoId}>{etichettaAnno(a.annoInizio, 'breve')}</option>
                    ))}
                  </select>
                </>
              )}
              <button
                type="button"
                onClick={() => onSposta(destinazione)}
                disabled={spostando}
                className="inline-flex items-center gap-1.5 rounded-xl border border-kidville-line px-3 py-2 font-barlow text-sm font-bold uppercase tracking-[0.03em] text-kidville-green hover:bg-kidville-green-soft disabled:opacity-50"
              >
                {spostando && <Loader2 size={14} className="animate-spin" />}
                {spostando
                  ? t('ricevutiSpostaAnnoLavora')
                  : altriAnni.length > 1
                    ? t('ricevutiSpostaAnnoGenerico')
                    : t('ricevutiSpostaAnno', { anno: etichettaAnno(destinazione.annoInizio, 'breve') })}
              </button>
            </div>
          )}
          {esitoSposta && (
            <p
              role={esitoSposta.tipo === 'errore' ? 'alert' : 'status'}
              className={`text-xs font-maven ${esitoSposta.tipo === 'errore' ? 'text-kidville-error' : 'text-kidville-success'}`}
            >
              {esitoSposta.testo}
            </p>
          )}
        </div>
      )}

      {docBloccato && (
        <p role="alert" className={AVVISO_FINESTRA_BLOCCATA}>
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {ts('docFinestraBloccata')}{' '}
          <a
            href={docBloccato}
            target="_blank"
            rel="noopener noreferrer"
            onClick={apriLinkNellApp(docBloccato, 'iscrizione-documento', {
              onNonConsegnato: () => alert(t('ricevutiDocumentoErrore')),
            })}
            className="font-bold text-kidville-green underline"
          >
            {ts('docApriManuale')}
          </a>
        </p>
      )}

      {/* Bambini */}
      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-kidville-muted mb-2 flex items-center gap-1.5">
          <Baby size={14} /> {t('ricevutiBambini', { count: children.length })}
        </p>
        <div className="space-y-3">
          {children.map((c: EnrollmentChild, i: number) => (
            <div key={i} className="rounded-xl border border-kidville-line p-3 bg-kidville-cream/50">
              <div className="flex items-center justify-between">
                <span className="font-barlow font-bold text-kidville-ink">{c.nome} {c.cognome}</span>
                {c.documento_path && (
                  <button onClick={() => onViewDoc(c.documento_path)} className="text-xs text-kidville-green flex items-center gap-1 hover:underline">
                    <FileText size={13} /> {t('ricevutiDocumento')} <ExternalLink size={11} />
                  </button>
                )}
              </div>
              <p className="text-xs text-kidville-muted font-mono mt-0.5">{c.codice_fiscale} · {c.data_nascita}</p>
              {!done && (
                <div className="mt-2">
                  {/* ⚠️ `htmlFor`/`id`: l'etichetta era VISIBILE ma non legata al
                      controllo, quindi la tendina non aveva nessun nome
                      accessibile — uno screen reader annunciava «menu a
                      discesa», e basta. Dal 2026-09-01 la pagina ha anche le
                      tendine della barra filtri: senza un nome, «la tendina
                      delle classi» non è più nemmeno identificabile, né da una
                      persona che naviga a tastiera né da un test. L'`id` porta
                      l'indice del bambino perché i controlli sono uno per
                      figlio: un `id` ripetuto legherebbe tutte le etichette
                      alla prima tendina. */}
                  <label
                    htmlFor={`ricevuti-classe-${i}`}
                    className="text-[11px] font-semibold text-kidville-muted uppercase"
                  >
                    {t('ricevutiClasseSezione')}
                  </label>
                  <select
                    id={`ricevuti-classe-${i}`}
                    value={assignments[String(i)] ?? ''}
                    onChange={e => setAssignments({ ...assignments, [String(i)]: e.target.value })}
                    className="w-full mt-1 px-3 py-2 rounded-lg border border-kidville-line text-sm bg-white focus:outline-none focus:border-kidville-green"
                  >
                    <option value="">{t('ricevutiSelezionaSezione')}</option>
                    {sezioniSede.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                  </select>

                  {/* ── LA RETTA ────────────────────────────────────────────
                      Obbligatoria come la classe, e VUOTA di partenza: un campo
                      precompilato è un campo che si conferma senza guardarlo, ed
                      è così che quaranta bambini hanno preso 150 € al mese senza
                      che nessuno l'avesse deciso.

                      ⚠️ Chi non paga NON si scrive con uno zero. Su
                      `alunni.importo_retta_mensile` lo zero significa «usa il
                      default di sede», cioè 150 €: per questo l'alternativa è una
                      tendina che nomina il fratello che paga, e quando è scelta
                      l'importo si disabilita invece di restare lì a mentire.
                      In produzione, prima di questa schermata, sei bambini
                      avevano la retta a 0,01 € — il ripiego che la segreteria
                      aveva trovato da sola per aggirare lo zero. */}
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label
                        htmlFor={`ricevuti-retta-${i}`}
                        className="text-[11px] font-semibold text-kidville-sub uppercase"
                      >
                        {t('ricevutiRettaMensile')}
                      </label>
                      <input
                        id={`ricevuti-retta-${i}`}
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        disabled={!!retteACarico[String(i)]}
                        value={rette[String(i)] ?? ''}
                        onChange={e => setRette({ ...rette, [String(i)]: e.target.value })}
                        placeholder={t('ricevutiRettaPlaceholder')}
                        className="w-full mt-1 px-3 py-2 rounded-lg border border-kidville-line text-sm bg-white focus:outline-none focus:border-kidville-green disabled:bg-kidville-cream disabled:text-kidville-sub"
                      />
                    </div>
                    {children.length > 1 && (
                      <div>
                        <label
                          htmlFor={`ricevuti-acarico-${i}`}
                          className="text-[11px] font-semibold text-kidville-muted uppercase"
                        >
                          {t('ricevutiRettaACarico')}
                        </label>
                        <select
                          id={`ricevuti-acarico-${i}`}
                          value={retteACarico[String(i)] ?? ''}
                          onChange={e => setRetteACarico({ ...retteACarico, [String(i)]: e.target.value })}
                          className="w-full mt-1 px-3 py-2 rounded-lg border border-kidville-line text-sm bg-white focus:outline-none focus:border-kidville-green"
                        >
                          <option value="">{t('ricevutiRettaPagaLui')}</option>
                          {children.map((f: EnrollmentChild, j: number) => j === i ? null : (
                            <option key={j} value={String(j)}>{f.nome} {f.cognome}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <label
                        htmlFor={`ricevuti-giorno-${i}`}
                        className="text-[11px] font-semibold text-kidville-sub uppercase"
                      >
                        {t('ricevutiGiornoScadenza')}
                      </label>
                      <input
                        id={`ricevuti-giorno-${i}`}
                        type="number"
                        min={1}
                        max={28}
                        inputMode="numeric"
                        value={giorniScadenza[String(i)] ?? ''}
                        onChange={e => setGiorniScadenza({ ...giorniScadenza, [String(i)]: e.target.value })}
                        placeholder={t('ricevutiGiornoScadenzaPlaceholder')}
                        className="w-full mt-1 px-3 py-2 rounded-lg border border-kidville-line text-sm bg-white focus:outline-none focus:border-kidville-green"
                      />
                    </div>
                    {/* A chi si intesta la fattura: è il campo che serve al
                        genitore per la detrazione. Vuoto = lo decide il server
                        dal referente, come faceva prima. */}
                    <div>
                      <label
                        htmlFor={`ricevuti-intestatario-${i}`}
                        className="text-[11px] font-semibold text-kidville-sub uppercase"
                      >
                        {t('ricevutiIntestatarioFatture')}
                      </label>
                      <select
                        id={`ricevuti-intestatario-${i}`}
                        value={intestatari[String(i)] ?? ''}
                        onChange={e => setIntestatari({ ...intestatari, [String(i)]: e.target.value })}
                        className="w-full mt-1 px-3 py-2 rounded-lg border border-kidville-line text-sm bg-white focus:outline-none focus:border-kidville-green"
                      >
                        <option value="">{t('ricevutiIntestatarioReferente')}</option>
                        {adults.map((a: EnrollmentAdult, j: number) => (
                          <option key={j} value={String(j)}>{a.first_name} {a.last_name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}
              {done && assignments[String(i)] && (
                <p className="text-xs text-kidville-success mt-1">{t('ricevutiClasseAssegnata', { classe: assignments[String(i)] })}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Adulti */}
      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-kidville-muted mb-2 flex items-center gap-1.5">
          <Users size={14} /> {t('ricevutiAdulti', { count: adults.length })}
        </p>
        <div className="space-y-3">
          {adults.map((a: EnrollmentAdult, i: number) => (
            <div key={i} className="rounded-xl border border-kidville-line p-3 bg-kidville-cream/50">
              <div className="flex items-center justify-between">
                <span className="font-barlow font-bold text-kidville-ink">
                  {a.first_name} {a.last_name}
                  <span className="ml-2 text-[10px] font-semibold uppercase text-kidville-muted">
                    {ADULT_ROLE_LABELS[a.ruolo] ?? a.ruolo}
                  </span>
                </span>
                {a.documento_path && (
                  <button onClick={() => onViewDoc(a.documento_path)} className="text-xs text-kidville-green flex items-center gap-1 hover:underline">
                    <FileText size={13} /> {t('ricevutiDocumento')} <ExternalLink size={11} />
                  </button>
                )}
              </div>
              <p className="text-xs text-kidville-muted font-mono mt-0.5">{a.fiscal_code}</p>
              <p className="text-xs text-kidville-muted mt-0.5">{a.email || t('ricevutiNessunaEmail')} · {a.phone || t('ricevutiNessunTelefono')}</p>
              {!done && (
                <label className="flex items-center gap-2 mt-2 text-xs text-kidville-ink/70 cursor-pointer">
                  <input
                    type="radio"
                    name="referente"
                    checked={referenteIndex === i}
                    onChange={() => setReferenteIndex(i)}
                    className="accent-kidville-green"
                  />
                  <Star size={12} className={referenteIndex === i ? 'text-kidville-warn' : 'text-kidville-neutral/50'} />
                  {t('ricevutiReferente')}
                </label>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Esito import — errore bloccante (in evidenza) */}
      {result && result.success === false && (
        <div className="rounded-xl border-2 border-kidville-error/40 bg-kidville-error-soft p-4 space-y-2">
          <p className="text-sm font-bold text-kidville-error-strong flex items-center gap-1.5">
            <XCircle size={16} /> {t('ricevutiImportNonCompletato')}
          </p>
          <p className="text-xs text-kidville-error-strong">
            {t('ricevutiImportNonCompletatoDesc')}
          </p>
          {result.errors && result.errors.length > 0 && (
            <ul className="text-xs text-kidville-error-strong list-disc ml-5 space-y-0.5">
              {result.errors.map((er, i) => {
                // Il doppione ha due uscite: rifiutare la domanda (il pulsante c'è già,
                // qui sotto) o riusare la scheda esistente, che si offre solo quando il
                // server ne ha trovata UNA — fra più d'una, sceglierla sarebbe indovinare.
                const proposta = schedaProponibile(er)
                return (
                  <li key={i}>
                    <strong>{er.dove}:</strong> {er.messaggio}
                    {proposta && !done && (
                      <button
                        type="button"
                        onClick={() => onUsaSchedaEsistente(proposta)}
                        disabled={working}
                        className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-kidville-green/40 bg-kidville-white px-3 py-1.5 text-xs font-semibold text-kidville-green hover:bg-kidville-green-soft disabled:opacity-50"
                      >
                        <CheckCircle2 size={13} /> {t('ricevutiUsaSchedaEsistente')}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {result.warnings && result.warnings.length > 0 && (
            <div className="text-xs text-kidville-warn-strong mt-1">
              <p className="flex items-center gap-1 font-semibold"><AlertTriangle size={12} /> {t('ricevutiAvvisi')}</p>
              <ul className="list-disc ml-5">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {/* Esito import — successo */}
      {result && result.success !== false && (
        <div className="rounded-xl border border-kidville-success/30 bg-kidville-success-soft p-3 space-y-2">
          <p className="text-sm font-semibold text-kidville-success flex items-center gap-1.5">
            <CheckCircle2 size={16} /> {t('ricevutiImportata')}
          </p>
          {result.credentials && (
            <div className="text-xs text-kidville-success flex items-center gap-2">
              <KeyRound size={13} />
              <span>{t('ricevutiCredenziali')} <strong>{result.credentials.email}</strong> / <code>{result.credentials.password}</code></span>
            </div>
          )}
          {result.credentials && (
            <p className="text-xs flex items-center gap-1.5">
              {result.credentialsEmailSent
                ? <><CheckCircle2 size={12} className="text-kidville-success" /> <span className="text-kidville-success">{t('ricevutiCredInviate')}</span></>
                : <><AlertTriangle size={12} className="text-kidville-warn" /> <span className="text-kidville-warn-strong">{t('ricevutiCredNonInviate')}</span></>}
            </p>
          )}
          {result.warnings && result.warnings.length > 0 && (
            <div className="text-xs text-kidville-warn-strong">
              <p className="flex items-center gap-1 font-semibold"><AlertTriangle size={12} /> {t('ricevutiAvvisi')}</p>
              <ul className="list-disc ml-5">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {/* Azioni */}
      {!done && (
        <div className="flex items-center gap-3 pt-2 border-t border-kidville-line">
          <button
            onClick={onImport}
            disabled={working}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-kidville-green text-kidville-yellow font-semibold text-sm hover:opacity-90 disabled:opacity-50 transition-all"
          >
            {working ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            {t('ricevutiImporta')}
          </button>
          <button
            onClick={onReject}
            disabled={working}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-kidville-error/30 text-kidville-error font-semibold text-sm hover:bg-kidville-error-soft disabled:opacity-50 transition-all"
          >
            <XCircle size={16} /> {t('ricevutiRifiuta')}
          </button>
        </div>
      )}
    </div>
  )
}
