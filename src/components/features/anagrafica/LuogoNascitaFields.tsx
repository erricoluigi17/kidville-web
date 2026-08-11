'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Combobox, normalizzaTesto, type OpzioneCombobox, type TestiCombobox } from '@/components/ui/Combobox'
import { PROVINCE } from '@/lib/anagrafiche/province'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { cx } from '@/lib/ui/cx'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * LUOGO DI NASCITA — la cascata provincia → comune che rende il codice fiscale
 * esatto PER COSTRUZIONE, invece di controllarlo dopo.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Ogni scelta valorizza `belfiore`: sono i quattro caratteri che finiscono nel
 * codice fiscale di un bambino. Il campo di testo libero che questo componente
 * sostituisce li faceva indovinare a chi compilava, e ciò che si indovina resta
 * scritto nel codice per tutta la vita della scheda.
 *
 * ─── LE DUE REGOLE CHE DECIDONO SE QUESTO CAMPO È UTILE O DANNOSO ───────────
 *
 * 1. **IL VALORE IN ARCHIVIO NON SI PERDE MAI.** Se `valore.comune` non combacia
 *    con nessuna opzione, si costruisce un'OPZIONE FANTASMA in cima al listbox —
 *    selezionata, con la nota «valore in archivio, non riconosciuto» — e accanto
 *    un avviso giallo che dice che su quel record il luogo non è verificabile.
 *    Il testo non si tocca, non si «corregge», non si cancella.
 *    Vale anche per la PROVINCIA: il dataset è fermo al 2022, e `UGGIATE CON
 *    RONAGO` — comune del 2024 — semplicemente non c'è. Un campo che azzera ciò
 *    che non riconosce cancella dati veri per il solo fatto di essere aperto.
 *
 * 2. **IL COMUNE SI AZZERA SOLO AL CAMBIO INTERATTIVO DI PROVINCIA**, mai al
 *    primo montaggio con i dati che arrivano dall'archivio. Qui non è una
 *    promessa: è una PROPRIETÀ STRUTTURALE. L'unico punto del file che azzera
 *    `comune`/`belfiore` è `scegliProvincia`, cioè l'`onChange` del Combobox
 *    delle province — che parte da un gesto dell'utente e da niente altro.
 *    **Non c'è nessun `useEffect` che chiami `onChange`**, e finché resta così
 *    il difetto classico di questo pattern (la scheda che si svuota da sola
 *    mentre i dati arrivano dal server) non può accadere.
 *
 * ─── IL BELFIORE IN ARCHIVIO NON ESISTE ANCORA: SI RISOLVE DAL NOME ─────────
 * `codice_belfiore_nascita` è nata con la migrazione `20260810094625`, che NON fa
 * backfill. MISURATO in produzione l'11 agosto, con una `SELECT`:
 *
 *     alunni  33 righe · 0 con Belfiore · 15 con un comune scritto
 *     parents 50 righe · 0 con Belfiore · 23 con un comune scritto
 *
 * Cioè: la colonna è NULL su 83 record su 83, e 38 di essi hanno un comune. Un
 * `riconosciuto` che pretendesse `belfiore !== ''` marcherebbe «valore in
 * archivio, non riconosciuto» il 100% dell'archivio popolato — GIUGLIANO IN
 * CAMPANIA compreso, che nell'elenco c'è — e accenderebbe il giallo su tutti e 38
 * il primo giorno. È l'esito contro cui argomenta l'intestazione di
 * `BadgeCoerenzaCf`, e vale identico qui.
 *
 * Perciò, quando il Belfiore manca, il comune si risolve **per NOME** contro
 * l'elenco della provincia, con la stessa normalizzazione del Combobox
 * (`normalizzaTesto`: accenti sciolti, apostrofi a spazio, minuscolo). Due limiti
 * deliberati, perché «MAI indovinare» è la regola di casa:
 *
 *  · la corrispondenza è ESATTA sul nome intero, non un prefisso. In archivio c'è
 *    `NAPO` (troncatura vera, 1 record): resta fantasma, e deve;
 *  · se i nomi che combaciano sono più d'uno, non si sceglie: fantasma e giallo.
 *
 * E soprattutto: la risoluzione è **solo di lettura**. Non chiama `onChange`, non
 * scrive il Belfiore in archivio, non «corregge» niente — la regola n.2 qui sotto
 * resta una proprietà strutturale. Il Belfiore si scrive quando qualcuno sceglie
 * una voce, mai perché una schermata si è aperta.
 *
 * Sui 38 record veri: 35 si risolvono (GIUGLIANO IN CAMPANIA ×30, NAPOLI ×4,
 * AVERSA ×1) e 3 restano gialli — `NAPO`, `RTHRH` e un `VILLA DI BRIANO` scritto
 * sotto la provincia NA quando quel comune sta in CE. Quei tre gialli sono
 * esattamente ciò per cui il giallo esiste.
 *
 * ─── ⚠️ E IL BADGE, DUE SEZIONI PIÙ SU, DEVE DIRE LA STESSA COSA ────────────
 * La risoluzione per nome ha creato — per un giorno — la contraddizione che
 * questo perimetro esiste per combattere: sugli stessi 36 record (14 alunni + 22
 * genitori con codice fiscale e comune scritti e `codice_belfiore_nascita` NULL)
 * il campo qui sotto mostrava GIUGLIANO IN CAMPANIA scelto e senza avvisi, mentre
 * `BadgeCoerenzaCf` — che riceve dai chiamanti il Belfiore GREZZO, cioè NULL —
 * dipingeva il giallo con scritto «manca il comune di nascita». Il comune non
 * mancava: stava lì sotto, e chi guardava lo vedeva.
 *
 * La contraddizione NON si è risolta facendo tacere il badge (il Belfiore manca
 * davvero, ed è ciò che `verificaCoerenza` misura), né esportando `belfioreRisolto`
 * verso i sei chiamanti (una risoluzione di sola lettura non è un dato in archivio:
 * farla passare per tale sarebbe la bugia opposta). Si è corretta la FRASE, che
 * nominava il dato sbagliato: `cfMancaLuogoNascita` ora dice che manca il CODICE
 * CATASTALE — l'unica cosa che `coerenza.ts` legge davvero — e dice l'azione che
 * lo spegne, cioè riscegliere il comune dall'elenco qui sotto (è la scelta che fa
 * partire `onChange` e scrive il Belfiore). Le due schermate ora dicono due cose
 * diverse perché sono due cose diverse: «il comune lo riconosco» e «il codice
 * catastale non è ancora in archivio». Misurato insieme, campo e badge sullo
 * stesso record, in §9 di `__tests__/components/LuogoNascitaFields.test.tsx`.
 *
 * ─── L'AVVISO GIALLO SI COLLEGA AL CAMPO CHE DESCRIVE ───────────────────────
 * `idAvviso` non è un `id` decorativo: è il bersaglio dell'`aria-describedby` del
 * campo che l'avviso riguarda — il comune quando è fuori elenco, la provincia
 * quando è fuori elenco lei. Un avviso reso in pagina e agganciato a niente è un
 * avviso per chi guarda lo schermo, cioè per tutti tranne l'unica persona che ne
 * ha bisogno nel momento in cui decide.
 *
 * ─── PERCHÉ IL DATASET NON È QUI DENTRO ─────────────────────────────────────
 * I 13.656 comuni sono ~294 KB e stanno SOLO sul server: il lock
 * `__tests__/architecture/dataset-comuni-fuori-dal-bundle.test.ts` fallisce se un
 * file `'use client'` importa `@/lib/fiscale/comuni` o `@/lib/fiscale/dati/**`.
 * Si passa da `GET /api/anagrafiche/comuni`, che restituisce la sola provincia
 * scelta (Torino, il caso peggiore, sono 33 KB) ed è l'unica risposta di questa
 * applicazione che si può mettere in cache condivisa.
 *
 * ─── L'ABORTCONTROLLER NON È UN'OTTIMIZZAZIONE ──────────────────────────────
 * Chi digita `NA` e poi `TO` lancia due richieste. Senza `AbortController` vince
 * quella che torna per ultima, che non è quella chiesta per ultima: la tendina
 * mostra i comuni di Napoli sotto l'etichetta «Torino» e nessuno se ne accorge —
 * finché un codice fiscale non nasce sbagliato. Ogni cambio di provincia
 * ANNULLA la richiesta precedente, e la risposta annullata non tocca lo stato.
 *
 * ─── I COMUNI SOPPRESSI SI SCARICANO SEMPRE, E SI MOSTRANO SU RICHIESTA ─────
 * La fetch è sempre `includiSoppressi=1`; la casella «Mostra anche i comuni
 * soppressi» filtra CIÒ CHE SI VEDE, non ciò che si è scaricato. È deliberato:
 * se il filtro fosse nella richiesta, un genitore nato in un comune estinto —
 * valore perfettamente legittimo e già in archivio — verrebbe marcato «non
 * riconosciuto» solo perché la casella era spenta. Il valore scelto resta
 * visibile anche a casella spenta, per la stessa ragione.
 *
 * ─── LO STATO DI CARICAMENTO NON È UNO `useState` ───────────────────────────
 * `caricamento` si DERIVA (`elenco === null || elenco.sigla !== sigla`) invece di
 * essere impostato all'inizio dell'effetto. Non è uno stile: un `setState`
 * sincrono nel corpo di un `useEffect` fa fallire `react-hooks/set-state-in-effect`,
 * che in questo repo è un ERRORE del gate. Derivarlo toglie il problema alla
 * radice — e toglie anche il disallineamento fra «sto caricando» e «che cosa ho».
 */

export interface ValoreLuogoNascita {
  /** Sigla della provincia, oppure `EE` per chi è nato all'estero. */
  provincia: string
  /** Nome del comune (o dello stato estero) COSÌ COM'È in archivio. */
  comune: string
  /** Codice catastale: i quattro caratteri che entrano nel codice fiscale. */
  belfiore: string
  /** Nazione di nascita. Si compila da sé a ogni scelta. */
  nazione: string
}

interface LuogoNascitaFieldsProps {
  valore: ValoreLuogoNascita
  onChange: (v: ValoreLuogoNascita) => void
  /** Radice degli `id` dei due campi: `alunno`, `adulto-2`, `children.0`. */
  idPrefisso: string
  disabled?: boolean
  mostraNazione?: boolean
  errori?: Partial<Record<'provincia' | 'comune', string>>
}

/** La sigla convenzionale dell'estero: è quella del dataset e della route. */
export const SIGLA_ESTERO = 'EE'

/** Nazione implicita di ogni comune italiano. È un DATO, non un testo d'interfaccia. */
const NAZIONE_ITALIA = 'Italia'

/**
 * Il valore dell'opzione fantasma quando il record NON ha un codice catastale.
 * Non può essere la stringa vuota (che nel Combobox significa «nessuna scelta»)
 * e non può collidere con un Belfiore vero, che è sempre `[A-Z][0-9]{3}`.
 */
const VALORE_ARCHIVIO = '__archivio__'

/** La forma che la route accetta per la sigla; tutto il resto non si chiede nemmeno. */
const FORMA_SIGLA = /^[A-Z]{2}$/

/** La proiezione che `GET /api/anagrafiche/comuni` restituisce. */
interface ComuneApi {
  belfiore: string
  nome: string
  sigla: string
  attivo: boolean
}

/**
 * `idPrefisso` arriva anche come percorso di react-hook-form (`children.0`), e un
 * punto dentro un `id` è legale in HTML ma velenoso in ogni selettore CSS. Si
 * riduce a `[A-Za-z0-9_-]` una volta sola, qui.
 */
function idSicuro(prefisso: string): string {
  const ridotto = prefisso.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return ridotto === '' ? 'luogo-nascita' : ridotto
}

/**
 * Gli `id` che DESCRIVONO un campo, uniti con uno spazio.
 *
 * `aria-describedby` accetta una LISTA di riferimenti, non uno solo: è questo che
 * permette a un campo di portarsi dietro sia il proprio errore sia l'avviso sul
 * valore in archivio, invece di far vincere l'uno sull'altro. `undefined` quando
 * non c'è niente da collegare — un attributo vuoto o che punta a un `id` non reso
 * è un riferimento rotto, e uno screen reader lo salta senza dire perché.
 */
function descrittori(...ids: (string | false | undefined)[]): string | undefined {
  const usati = ids.filter((x): x is string => typeof x === 'string' && x !== '')
  return usati.length > 0 ? usati.join(' ') : undefined
}

export function LuogoNascitaFields({
  valore,
  onChange,
  idPrefisso,
  disabled = false,
  mostraNazione = true,
  errori,
}: LuogoNascitaFieldsProps): React.ReactElement {
  const t = useTranslations('shared')

  const radice = idSicuro(idPrefisso)
  const idProvincia = `${radice}-provincia`
  const idComune = `${radice}-comune`
  const idErroreProvincia = `${idProvincia}-errore`
  const idErroreComune = `${idComune}-errore`
  const idAvviso = `${radice}-avviso-archivio`
  const idSoppressi = `${radice}-soppressi`

  const sigla = valore.provincia.trim().toUpperCase()
  const siglaValida = FORMA_SIGLA.test(sigla)
  const estero = sigla === SIGLA_ESTERO

  const [mostraSoppressi, setMostraSoppressi] = useState(false)

  /**
   * L'elenco scaricato, con la sigla PER CUI è stato scaricato dentro lo stesso
   * oggetto. È ciò che rende impossibile mostrare i comuni di Napoli sotto
   * l'etichetta «Torino»: un elenco senza la propria provincia attaccata è un
   * elenco di cui non si può dimostrare la provenienza.
   */
  const [elenco, setElenco] = useState<{ sigla: string; comuni: ComuneApi[]; errore: boolean } | null>(null)

  const arrivato = elenco !== null && elenco.sigla === sigla
  const caricamento = siglaValida && !arrivato
  const erroreElenco = arrivato && elenco.errore
  const comuniDellaSigla = useMemo<ComuneApi[]>(
    () => (arrivato && elenco !== null ? elenco.comuni : []),
    [arrivato, elenco],
  )

  useEffect(() => {
    if (!siglaValida) return
    const ac = new AbortController()

    /**
     * ⚠️ NIENTE `catch` QUI DENTRO, ed è un vincolo di forma misurato, non uno
     * stile: un blocco `catch` che chiama un setter fa fallire
     * `react-hooks/set-state-in-effect` (errore nel gate di questo repo). Il ramo
     * d'errore vive su `.catch()` DELLA PROMISE — restituisce `null`, il motivo
     * viene catturato nella callback e la gestione resta nel flusso lineare.
     */
    void (async () => {
      let motivo = ''
      const url = `/api/anagrafiche/comuni?provincia=${encodeURIComponent(sigla)}&includiSoppressi=1`
      const res = await fetch(url, { signal: ac.signal }).catch((e: unknown) => {
        motivo = nomeErrore(e)
        return null
      })

      // La richiesta è stata superata da una più recente: non è un guasto, e
      // soprattutto non deve toccare lo stato — sarebbe la tendina sbagliata.
      if (ac.signal.aborted) return

      if (res === null) {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `anagrafiche-comuni-non-caricati:${sigla}:${motivo}`,
        })
        setElenco({ sigla, comuni: [], errore: true })
        return
      }
      if (!res.ok) {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `anagrafiche-comuni-non-caricati:${sigla}`,
          stato: res.status,
        })
        setElenco({ sigla, comuni: [], errore: true })
        return
      }

      const corpo: unknown = await res.json().catch((e: unknown) => {
        motivo = nomeErrore(e)
        return null
      })
      if (ac.signal.aborted) return

      const comuni = (corpo as { comuni?: unknown } | null)?.comuni
      if (!Array.isArray(comuni)) {
        // 200 con un corpo che non è un elenco: è un guasto, non «zero comuni».
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `anagrafiche-comuni-corpo-inatteso:${sigla}:${motivo}`,
          stato: res.status,
        })
        setElenco({ sigla, comuni: [], errore: true })
        return
      }
      setElenco({ sigla, comuni: comuni as ComuneApi[], errore: false })
    })()

    return () => ac.abort()
  }, [sigla, siglaValida])

  // ── PROVINCIA ────────────────────────────────────────────────────────────────

  const provinciaFuoriElenco =
    valore.provincia !== '' && !estero && !PROVINCE.some((p) => p.sigla === sigla)

  const opzioniProvincia = useMemo<OpzioneCombobox[]>(() => {
    const voci: OpzioneCombobox[] = []
    // Il fantasma sta in CIMA e senza gruppo: il primo blocco reso dal Combobox è
    // quello delle voci senza gruppo, nell'ordine in cui compaiono qui.
    if (provinciaFuoriElenco) {
      voci.push({
        valore: sigla,
        etichetta: valore.provincia,
        nota: t('anagValoreInArchivio'),
        disabilitata: true,
      })
    }
    for (const p of PROVINCE) {
      voci.push({ valore: p.sigla, etichetta: `${p.nome} (${p.sigla})`, gruppo: t('anagGruppoProvince') })
    }
    voci.push({ valore: SIGLA_ESTERO, etichetta: t('anagEsteroEtichetta'), gruppo: t('anagGruppoEstero') })
    return voci
  }, [provinciaFuoriElenco, sigla, valore.provincia, t])

  /**
   * L'UNICO azzeramento di `comune`/`belfiore` di tutto il file, e parte da un
   * gesto: è questa la regola n.2 scritta in cima. La guardia sull'uguaglianza
   * evita che riscegliere la stessa provincia butti via il comune già scelto.
   */
  const scegliProvincia = (nuova: string) => {
    if (nuova === sigla) return
    onChange({
      provincia: nuova,
      comune: '',
      belfiore: '',
      nazione: nuova === SIGLA_ESTERO ? '' : NAZIONE_ITALIA,
    })
  }

  // ── COMUNE (o STATO, quando la provincia è `EE`) ──────────────────────────────

  /**
   * Il Belfiore da SELEZIONARE nella tendina, oppure `''` se il valore in archivio
   * non corrisponde a nessuna voce. Due strade, e nessuna delle due scrive niente:
   *
   *  1. il record ha già un Belfiore → vale se quell'elenco lo contiene davvero
   *     (un codice che l'elenco non conosce è un fantasma, come prima);
   *  2. il record NON ha il Belfiore — cioè 83 record su 83, vedi in cima — → si
   *     cerca il comune che porta ESATTAMENTE quel nome. Una sola corrispondenza:
   *     con zero o con più d'una si resta al fantasma, perché fra due comuni
   *     omonimi scegliere «quello giusto» sarebbe indovinare.
   *
   * `normalizzaTesto` è quella del Combobox: la stessa con cui l'utente trova la
   * voce digitando. Riusarla è ciò che rende impossibile che il campo riconosca
   * qualcosa che la ricerca non trova, o viceversa.
   */
  const belfioreRisolto = useMemo<string>(() => {
    if (valore.belfiore !== '') {
      return comuniDellaSigla.some((c) => c.belfiore === valore.belfiore) ? valore.belfiore : ''
    }
    const cercato = normalizzaTesto(valore.comune)
    if (cercato === '') return ''
    const combacianti = comuniDellaSigla.filter((c) => normalizzaTesto(c.nome) === cercato)
    return combacianti.length === 1 ? combacianti[0].belfiore : ''
  }, [valore.belfiore, valore.comune, comuniDellaSigla])

  const riconosciuto = belfioreRisolto !== ''
  const etichettaArchivio = valore.comune !== '' ? valore.comune : valore.belfiore
  const fantasmaComune = etichettaArchivio !== '' && !riconosciuto
  const valoreFantasma = valore.belfiore !== '' ? valore.belfiore : VALORE_ARCHIVIO
  const valoreComune = fantasmaComune ? valoreFantasma : belfioreRisolto

  const ciSonoSoppressi = comuniDellaSigla.some((c) => !c.attivo)

  const opzioniComune = useMemo<OpzioneCombobox[]>(() => {
    const voci: OpzioneCombobox[] = []
    if (fantasmaComune) {
      voci.push({
        valore: valoreFantasma,
        etichetta: etichettaArchivio,
        nota: t('anagValoreInArchivio'),
        disabilitata: true,
      })
    }
    for (const c of comuniDellaSigla) {
      // Il soppresso resta visibile se la casella è accesa OPPURE se è proprio
      // quello scelto: nascondere il valore corrente svuoterebbe il campo a
      // schermo lasciando il dato in memoria — cioè mentendo su ciò che c'è.
      // Si guarda `belfioreRisolto`, non `valore.belfiore`: il record che nomina
      // un comune estinto SENZA il codice catastale è il caso normale, non
      // l'eccezione (la colonna è NULL su tutto l'archivio).
      if (!c.attivo && !mostraSoppressi && c.belfiore !== belfioreRisolto) continue
      voci.push({
        valore: c.belfiore,
        etichetta: c.nome,
        gruppo: estero
          ? t('anagGruppoStati')
          : c.attivo
            ? t('anagGruppoComuni')
            : t('anagGruppoComuniSoppressi'),
      })
    }
    return voci
  }, [
    fantasmaComune,
    valoreFantasma,
    etichettaArchivio,
    comuniDellaSigla,
    mostraSoppressi,
    belfioreRisolto,
    estero,
    t,
  ])

  const scegliComune = (_valore: string, opzione: OpzioneCombobox | null) => {
    // Il fantasma è `disabilitata`, quindi il Combobox non lo sceglie mai: questa
    // è la seconda rete, non la prima.
    if (opzione === null || opzione.disabilitata) return
    const nome = opzione.etichetta
    onChange({
      provincia: valore.provincia,
      comune: nome,
      belfiore: opzione.valore,
      nazione: estero ? nome : NAZIONE_ITALIA,
    })
  }

  // ── TESTI DI SERVIZIO DEL COMBOBOX ───────────────────────────────────────────
  // Il Combobox non contiene testo: li traduce chi lo monta. Il conteggio è una
  // FUNZIONE perché il plurale lo decide l'ICU del catalogo, non un ternario.
  const testi = (vuoto: string): TestiCombobox => ({
    vuoto,
    caricamento: t('caricamentoInCorso'),
    conteggio: (n) => t('anagRisultatiPlurale', { n }),
    commutaElenco: t('anagCommutaElenco'),
  })

  const avvisoArchivio = !caricamento && !erroreElenco && (fantasmaComune || provinciaFuoriElenco)

  /**
   * ─── L'AVVISO È UNO, MA I CAMPI CHE DESCRIVE SONO DUE ─────────────────────
   * Il riquadro giallo è uno solo, e si accende per due ragioni diverse: il
   * COMUNE fuori elenco, oppure la PROVINCIA fuori elenco. Ognuna delle due
   * descrive il proprio campo, e solo quello: agganciare l'avviso anche al campo
   * che non c'entra farebbe sentire a chi arriva sulla provincia — riconosciuta,
   * regolare — una spiegazione che parla del comune.
   *
   * Prima queste due costanti non esistevano e `idAvviso` era un `id` reso in
   * pagina e bersaglio di NIENTE. Il difetto non era teorico: chi legge con uno
   * screen reader arrivava sul campo di un record fuori elenco e sentiva
   * «Comune di nascita, combobox, UGGIATE CON RONAGO» — il valore, senza una
   * parola sul fatto che lì non è verificabile. L'avviso c'era, a schermo, più
   * in basso: cioè per gli occhi e non per chi non guarda.
   */
  const avvisoSuProvincia = avvisoArchivio && provinciaFuoriElenco
  const avvisoSuComune = avvisoArchivio && fantasmaComune

  return (
    <div className="flex flex-col gap-4">
      <Combobox
        id={idProvincia}
        // ⚠️ `sigla`, MAI `valore.provincia` grezzo. Ogni opzione di questa tendina
        // porta come `valore` una sigla MAIUSCOLA — le 107 vere, `EE`, e anche il
        // fantasma, che è costruito su `sigla`. Il Combobox risolve l'etichetta
        // con `options.find(o => o.valore === value)`: passargli `'na'` (che in
        // archivio esiste, 3 alunni + 1 genitore, MISURATO) non combacia con
        // `'NA'`, l'etichetta esce vuota e il campo si apre BIANCO su un dato che
        // c'è — senza nemmeno l'avviso giallo, perché `provinciaFuoriElenco` la
        // sigla normalizzata la riconosce benissimo. Un dato in archivio che lo
        // schermo non mostra e non spiega è il difetto n.1 di questo file.
        value={sigla}
        onChange={scegliProvincia}
        options={opzioniProvincia}
        label={t('anagProvinciaEtichetta')}
        testi={testi(t('anagNessunaProvincia'))}
        placeholder={t('anagProvinciaSegnaposto')}
        disabled={disabled}
        invalido={errori?.provincia !== undefined}
        describedById={descrittori(
          errori?.provincia !== undefined && idErroreProvincia,
          avvisoSuProvincia && idAvviso,
        )}
      />
      {errori?.provincia !== undefined && (
        <p id={idErroreProvincia} role="alert" className="-mt-2 font-maven text-[13px] text-kidville-error-strong">
          {errori.provincia}
        </p>
      )}

      <Combobox
        id={idComune}
        value={valoreComune}
        onChange={scegliComune}
        options={opzioniComune}
        label={estero ? t('anagStatoEtichetta') : t('anagComuneEtichetta')}
        testi={testi(t('anagNessunComune'))}
        placeholder={siglaValida ? (estero ? t('anagStatoSegnaposto') : t('anagComuneSegnaposto')) : t('anagPrimaLaProvincia')}
        disabled={disabled || !siglaValida}
        caricamento={caricamento}
        invalido={errori?.comune !== undefined}
        describedById={descrittori(errori?.comune !== undefined && idErroreComune, avvisoSuComune && idAvviso)}
      />
      {errori?.comune !== undefined && (
        <p id={idErroreComune} role="alert" className="-mt-2 font-maven text-[13px] text-kidville-error-strong">
          {errori.comune}
        </p>
      )}

      {/* La casella dei soppressi compare solo se ce ne sono davvero: un comando
          che non cambia niente è rumore, e in una schermata di anagrafica il
          rumore è ciò che fa smettere di leggere gli avvisi veri. */}
      {!estero && ciSonoSoppressi && (
        <div className="-mt-1">
          <label htmlFor={idSoppressi} className="flex items-start gap-2.5 font-maven text-[13.5px] text-kidville-ink">
            <input
              id={idSoppressi}
              type="checkbox"
              checked={mostraSoppressi}
              disabled={disabled}
              onChange={(e) => setMostraSoppressi(e.target.checked)}
              aria-describedby={`${idSoppressi}-aiuto`}
              className="mt-0.5 h-4 w-4 shrink-0 accent-kidville-green"
            />
            <span>{t('anagMostraSoppressi')}</span>
          </label>
          <p id={`${idSoppressi}-aiuto`} className="ml-[26px] mt-0.5 font-maven text-[12.5px] text-kidville-sub">
            {t('anagMostraSoppressiAiuto')}
          </p>
        </div>
      )}

      {/* L'errore della fetch è un ERRORE (`role="alert"`), l'avviso sul valore in
          archivio è un'OSSERVAZIONE (`role="status"`): sono due cose diverse e
          non devono avere la stessa voce. */}
      {erroreElenco && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-card border border-kidville-error bg-kidville-error-soft px-3 py-2.5 font-maven text-[13.5px] text-kidville-error-strong"
        >
          <AlertTriangle size={16} strokeWidth={2.2} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{t('anagErroreComuni')}</span>
        </p>
      )}

      {avvisoArchivio && (
        <p
          id={idAvviso}
          role="status"
          className={cx(
            'flex items-start gap-2 rounded-card border border-kidville-warn bg-kidville-warn-soft px-3 py-2.5',
            'font-maven text-[13.5px] text-kidville-warn-strong',
          )}
        >
          <AlertTriangle size={16} strokeWidth={2.2} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{t('anagAvvisoArchivio')}</span>
        </p>
      )}

      {mostraNazione && (
        <p className="flex items-center gap-2 font-maven text-[13.5px] text-kidville-sub">
          <Info size={15} strokeWidth={2.2} aria-hidden="true" className="shrink-0" />
          {/* `NAZIONE_ITALIA` è un DATO che finisce in archivio, e in archivio
              resta scritto «Italia» in italiano. A schermo però è testo, e un
              testo cablato è l'unico modo in cui un utente inglese si ritrova a
              leggere «Nation of birth: Italia»: si rende dal catalogo. Gli altri
              valori sono nomi di stati che arrivano dalla route (`MAROCCO`), e
              quelli si mostrano come sono. I due punti stanno DENTRO la chiave,
              come già in `cfCalcolatoEtichetta`: la punteggiatura è lingua. */}
          <span>
            {t('anagNazioneEtichetta')}{' '}
            <strong className="font-semibold text-kidville-ink">
              {valore.nazione === ''
                ? t('anagNazioneNonIndicata')
                : valore.nazione === NAZIONE_ITALIA
                  ? t('anagNazioneItalia')
                  : valore.nazione}
            </strong>
          </span>
        </p>
      )}
    </div>
  )
}
