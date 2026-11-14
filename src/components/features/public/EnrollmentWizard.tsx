'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useForm, FieldValues } from 'react-hook-form'
import { motion } from 'framer-motion'
import {
  ArrowLeft, ArrowRight, Check, Loader2, PartyPopper, Baby, Users,
  Plus, Trash2, UserPlus, Info, MapPin, AlertTriangle, RefreshCw, CalendarDays,
} from 'lucide-react'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import { PublicContrastButton } from '@/components/ui/PublicContrastButton'
import { MarchioKidville } from '@/components/ui/MarchioKidville'
import {
  CHILD_FIELDS, ADULT_FIELDS, CONSENSI_FIELDS, ENROLLMENT_LIMITS,
} from '@/lib/forms/enrollment-template'
import { extractEnrollmentTemplates } from '@/lib/forms/enrollment-default-schema'
import { LegendaObbligatori } from '@/components/features/public/wizard/pezzi-wizard-pubblico'
import { useAnniPubblici } from '@/components/features/public/wizard/use-anni-pubblici'
import { useInfoAnno } from '@/components/features/public/wizard/use-info-anno'
import { InfoAnnoIscrizione } from '@/components/features/public/wizard/InfoAnnoIscrizione'
import { validateField, isProvinceField } from '@/lib/forms/validate-fields'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { EMAIL_RIPETUTA_FRA_GENITORI, indiciEmailRipetute } from '@/lib/iscrizioni/email-genitori'
import { logClient, nomeErrore } from '@/lib/logging/client'
import type { FormField, EnrollmentSubmissionData } from '@/types/database.types'

const UPLOAD_ENDPOINT = '/api/iscrizione/upload'

const slide = {
  enter: (dir: number) => ({ x: dir > 0 ? 64 : -64, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -64 : 64, opacity: 0 }),
}

type Step =
  | { kind: 'sede' }
  | { kind: 'anno' }
  | { kind: 'child'; index: number }
  | { kind: 'adult'; index: number }
  | { kind: 'consensi' }
  | { kind: 'review' }

interface Sede {
  id: string
  nome: string
}

/**
 * Stato dell'elenco sedi. Sono TRE, e il difetto nasceva dall'averne due:
 * «elenco vuoto» e «elenco non ottenuto» finivano nella stessa variabile, e
 * `sedi.length > 1` non poteva distinguerli. Un 429 diventava «c'è una sede
 * sola, vai avanti» — e la domanda partiva per non poter essere inviata.
 */
type StatoSedi = 'caricamento' | 'pronto' | 'errore'

/**
 * Estrae `[{ id, nome }]` dalla risposta di /api/iscrizione/sedi, scartando le
 * voci di forma inattesa: il wizard non deve rompersi per un payload strano.
 *
 * `null` = **elenco NON ottenuto** (il corpo non contiene affatto un array
 * `data`), che NON è la stessa cosa di un elenco vuoto: `[]` è una risposta
 * valida — è ciò che risponde il DB della CI, dove l'elenco pubblico è vuoto —
 * e fa proseguire; `null` è un guasto e va detto al genitore.
 */
function sediValide(payload: unknown): Sede[] | null {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return null
  return data
    .filter(
      (s): s is Sede =>
        s !== null && typeof s === 'object' &&
        typeof (s as Sede).id === 'string' && (s as Sede).id.length > 0 &&
        typeof (s as Sede).nome === 'string' && (s as Sede).nome.length > 0,
    )
    .map((s) => ({ id: s.id, nome: s.nome }))
}

function nsFields(prefix: string, fields: FormField[]): FormField[] {
  return fields.map(f => ({ ...f, id: `${prefix}.${f.id}` }))
}

function resolveError(errors: FieldValues, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]),
    errors,
  )
}

export function EnrollmentWizard({ scuolaId = null }: { scuolaId?: string | null } = {}) {
  const t = useTranslations('public')
  const ta = useTranslations('annoPubblico')
  // Sede arrivata dal link (?scuola=). La stringa VUOTA vale come assente: è falsy
  // ma non null, e trattata come "sede già decisa" farebbe partire l'invio senza
  // sede pur avendo fatto scegliere il plesso al genitore.
  const sedeDaLink = scuolaId !== null && scuolaId.trim().length > 0 ? scuolaId.trim() : null
  const [childCount, setChildCount] = useState(1)
  const [adultCount, setAdultCount] = useState(1)
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  // Campi del modulo: default = template; se la segreteria ha modificato il
  // "Modulo d'iscrizione standard" nel builder, il wizard riflette lo schema.
  const [childFields, setChildFields] = useState<FormField[]>(CHILD_FIELDS)
  const [adultFields, setAdultFields] = useState<FormField[]>(ADULT_FIELDS)

  // Sedi selezionabili. Il passo di scelta compare SOLO se il link non porta già
  // la sede (?scuola=) e ce n'è più d'una: con un plesso solo il flusso resta
  // identico a prima. Se l'elenco arriva VUOTO la domanda non comincia affatto
  // (vedi `sediVuote`): non c'è nessuna sede in cui archiviarla.
  const [sedi, setSedi] = useState<Sede[]>([])
  const [sedeScelta, setSedeScelta] = useState<string | null>(null)
  const [erroreSede, setErroreSede] = useState(false)
  /** L'invio ha fallito: si dice IN PAGINA, non con un `alert()` di sistema. */
  const [erroreInvio, setErroreInvio] = useState(false)
  /** L'anno scelto dalla famiglia nel passo «anno» (esiste solo con almeno due anni offerti). */
  const [annoScelto, setAnnoScelto] = useState<string | null>(null)
  const [erroreAnno, setErroreAnno] = useState(false)
  /** Il server ha risposto 409 `ISCRIZIONI_CHIUSE` all'invio: si dice in pagina, senza buttare i dati. */
  const [chiusoDalServer, setChiusoDalServer] = useState(false)
  /**
   * Il server ha risposto 422 `ANNO_NON_OFFERTO`: l'anno della domanda non accetta più domande. Cosa si dice dipende da
   * come torna l'elenco ricaricato (vedi il blocco dopo `steps`): `scegli` (c'è il passo «anno»), `cambiato` (un anno solo,
   * diverso, e dice quale), `incerto` (l'elenco non è cambiato o non è arrivato: si può riprovare, decide il server).
   */
  const [avvisoAnno, setAvvisoAnno] = useState<
    null | { tipo: 'scegli' } | { tipo: 'cambiato'; anno: string } | { tipo: 'incerto' }
  >(null)
  /**
   * Rifiuto in attesa dell'elenco ricaricato: `letture` = quante letture erano concluse al momento del rifiuto,
   * `inviato` = l'anno che la domanda portava. Finché c'è, il passo da mostrare non è ancora deciso.
   */
  const [rifiuto, setRifiuto] = useState<{ letture: number; inviato: string | null } | null>(null)
  /**
   * Lo stato dell'elenco sedi — `caricamento` → `pronto` | `errore`.
   *
   * `pronto` serve a NON dipingere nessun passo finché non si sa se il passo
   * sede esiste. Senza questa attesa il primo render monta il bambino, poi
   * l'arrivo delle sedi cambia la FORMA di `steps` e quindi la `key` dentro
   * `AnimatePresence mode="wait"`: l'uscita del pannello vecchio non si completa
   * e il wizard resta congelato sul bambino per sempre, mentre il contatore —
   * che sta fuori dall'animazione — continua ad avanzare. Il difetto si
   * manifesta solo con DUE o più sedi, che è esattamente la condizione che né
   * jsdom né il DB di CI hanno mai avuto.
   *
   * `errore` è il terzo stato, ed è quello che mancava (collaudo 2026-08-02):
   * finché l'elenco non è noto la domanda NON comincia. Vedi il commento sul
   * ramo d'errore, più sotto.
   */
  const [statoSedi, setStatoSedi] = useState<StatoSedi>('caricamento')
  /** Cambia a ogni «Riprova»: è ciò che fa ripartire la fetch dell'elenco. */
  const [tentativoSedi, setTentativoSedi] = useState(0)

  useEffect(() => {
    fetch('/api/iscrizione/model')
      .then(r => r.json())
      .then(d => {
        const { child, adult } = extractEnrollmentTemplates(d?.schema)
        setChildFields(child)
        setAdultFields(adult)
      })
      // La domanda resta compilabile coi campi predefiniti (`CHILD_FIELDS`/`ADULT_FIELDS`): ma
      // senza il modello della scuola le modifiche della segreteria non ci sono, e va saputo.
      .catch((err) => logClient({ livello: 'warn', evento: 'fetch', messaggio: `iscrizione-modello-non-caricato: ${nomeErrore(err)}` }))
  }, [])

  useEffect(() => {
    // Col link già "targato" (?scuola=) la scelta non serve: niente fetch inutile.
    if (sedeDaLink) return
    let annullato = false
    fetch('/api/iscrizione/sedi')
      .then(async r => {
        // `!r.ok` NON è un'eccezione: il `catch` qui sotto non scatterebbe, e
        // fino al 2026-08-02 il 429 del rate-limit passava di qui in silenzio.
        if (!r.ok) {
          logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio: 'iscrizione-sedi-non-caricate',
            stato: r.status,
          })
          return null
        }
        const lista = sediValide(await r.json())
        if (lista === null) {
          // 200 con un corpo che non contiene l'elenco: l'elenco non c'è lo
          // stesso, e trattarlo come «nessuna sede» è il difetto di prima con
          // un'altra faccia.
          logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio: 'iscrizione-sedi-corpo-inatteso',
            stato: r.status,
          })
        }
        return lista
      })
      .then(lista => {
        if (annullato) return
        if (lista === null) {
          setStatoSedi('errore')
          return
        }
        // Nessuna compensazione dello `step`: il primo passo non viene dipinto
        // finché `statoSedi` non è `pronto`, quindi `steps` non può più cambiare
        // forma sotto le mani del genitore.
        setSedi(lista)
        setStatoSedi('pronto')
      })
      .catch(err => {
        // Rete giù (o JSON illeggibile). Un catch che non logga è un bug, e
        // `logClient` non lancia.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `iscrizione-sedi-non-caricate: ${nomeErrore(err)}`,
          stack: err instanceof Error ? err.stack : undefined,
        })
        if (annullato) return
        setStatoSedi('errore')
      })
    return () => { annullato = true }
  }, [sedeDaLink, tentativoSedi])

  const {
    register, control, trigger, getValues, setValue, setFocus, setError,
    formState: { errors },
  } = useForm<FieldValues>({ mode: 'onTouched' })

  // La sede si sceglie solo quando c'è davvero qualcosa da scegliere.
  const mostraSede = !sedeDaLink && sedi.length > 1
  /**
   * La FORMA di `steps` è ormai definitiva e si può dipingere il primo passo.
   * Col link già targato non c'è nessuna fetch da attendere.
   *
   * `errore` NON decide la forma: con l'elenco ignoto non si sa se il passo
   * sede serva, e far cominciare la domanda significherebbe farla compilare per
   * intero — anagrafica del minore, allergie, documenti — per poi rifiutarla.
   */
  const sedeNota = !!sedeDaLink || (statoSedi === 'pronto' && sedi.length > 0)
  /**
   * Gli ANNI che la sede offre (compito 4.5.7). Si chiedono appena la sede è nota: dal link, dalla scelta, oppure
   * dall'unica sede dell'elenco. Un guasto di questa lettura NON ferma niente (vedi `use-anni-pubblici`).
   */
  const sedeAnni = sedeDaLink ?? sedeScelta ?? (statoSedi === 'pronto' && sedi.length === 1 ? sedi[0].id : null)
  const anni = useAnniPubblici({ sedeId: sedeAnni })
  /** Il passo «anno» c'è solo con almeno due anni offerti: con uno (o con la lettura fallita) nessuna domanda in più. */
  const mostraAnno = anni.scelta
  /** L'anno che parte nel POST: la scelta (se è ancora fra gli offerti) o l'unico offerto. Altrimenti nessuno. */
  const annoEffettivo = mostraAnno
    ? (anni.anni.find((a) => a.anno_id === annoScelto)?.anno_id ?? null)
    : (anni.anni.length === 1 ? anni.anni[0].anno_id : null)
  // Quota di nuova iscrizione e documenti dell'anno (accessoria: se la lettura non riesce il pannello dice solo l'anno).
  const infoAnno = useInfoAnno({ sedeId: sedeAnni, annoId: annoEffettivo })
  const etichettaAnnoEffettivo = anni.anni.find((a) => a.anno_id === annoEffettivo)?.etichetta_breve ?? null
  /** Le iscrizioni della sede sono chiuse, e la famiglia non ha un'altra sede fra cui scegliere. */
  const annoChiusoSenzaAlternative = anni.chiuso && !mostraSede
  /**
   * Con il passo «sede» la forma dei passi non dipende dagli anni finché la sede non è scelta; senza, la
   * forma è definitiva solo quando è arrivato anche l'elenco degli anni (altrimenti l'arrivo del passo
   * «anno» cambierebbe la forma sotto le mani del genitore).
   */
  const formaDecisa = sedeNota && (mostraSede || !anni.inCaricamento)
  /** L'elenco non è arrivato: si dice, e si offre di riprovare. */
  const sediNonCaricate = !sedeDaLink && statoSedi === 'errore'
  /**
   * L'elenco è ARRIVATO ed è VUOTO: non esiste nessuna sede su cui iscriversi.
   *
   * Misurato in CI il 2026-08-02 (run 30765844979). Fin qui il caso era trattato
   * come «una sede sola, vai avanti», sull'assunzione — scritta proprio qui —
   * che sul DB di collaudo il POST deducesse la sede da solo. L'assunzione è
   * decaduta il 2026-07-31, quando il seed ha cominciato a creare DUE sedi per
   * poter provare l'isolamento fra plessi: `POST /api/iscrizione` risponde
   * `400 «Specificare la scuola per l'iscrizione»` e deve continuare a farlo,
   * perché scegliere fra due candidate significa archiviare la domanda di un
   * minore nel plesso sbagliato senza dirlo a nessuno.
   *
   * Il risultato era il difetto del ramo `errore` con un'altra faccia: quattro
   * passi compilati — anagrafica del minore, codice fiscale, note mediche,
   * documento d'identità — e un rifiuto generico all'invio. Quindi la domanda
   * non comincia, e si dice perché.
   *
   * `?scuola=` nel link resta la via d'uscita: la sede è già decisa, l'elenco
   * pubblico non serve, e il POST accetta anche le sedi escluse dall'elenco.
   */
  const sediVuote = !sedeDaLink && statoSedi === 'pronto' && sedi.length === 0
  /** Nessuna sede utilizzabile: elenco non ottenuto, oppure ottenuto e vuoto. */
  const domandaNonPuoCominciare = sediNonCaricate || sediVuote

  function riprovaSedi() {
    setStatoSedi('caricamento')
    setTentativoSedi(n => n + 1)
  }
  /** Scostamento introdotto dai passi «sede» e «anno»: sposta di 1 ciascuno gli indici di tutti i passi dopo. */
  const offset = (mostraSede ? 1 : 0) + (mostraAnno ? 1 : 0)
  /** L'indice del passo «anno», quando esiste. */
  const passoAnno = mostraSede ? 1 : 0

  const steps: Step[] = useMemo(() => {
    const s: Step[] = []
    if (mostraSede) s.push({ kind: 'sede' })
    if (mostraAnno) s.push({ kind: 'anno' })
    for (let i = 0; i < childCount; i++) s.push({ kind: 'child', index: i })
    for (let i = 0; i < adultCount; i++) s.push({ kind: 'adult', index: i })
    s.push({ kind: 'consensi' })
    s.push({ kind: 'review' })
    return s
  }, [mostraSede, mostraAnno, childCount, adultCount])

  /**
   * IL RIFIUTO `ANNO_NON_OFFERTO` SI RISOLVE QUANDO L'ELENCO È TORNATO, e nello stesso render in cui `steps` cambia forma.
   *
   * Dopo il rifiuto l'elenco si ricarica e può tornare con un anno solo, con due (nasce il passo «anno»), con nessuno,
   * o non tornare affatto (resta il vecchio). In ogni caso gli indici dei passi si possono spostare sotto le mani del
   * genitore: decidere il passo in un effetto, o prima dell'arrivo, lo lascerebbe per un giro su un passo a caso (o con
   * `step` oltre l'ultimo, e il pulsante che dice «Avanti» invece di «Invia»). Aggiustare lo stato durante il render fa
   * ripartire il render subito, senza dipingere il passo sbagliato. Si risolve una volta sola (`rifiuto` torna nullo).
   */
  if (rifiuto !== null && anni.letture > rifiuto.letture) {
    const ultimo = Math.max(0, steps.length - 1)
    const unico = anni.anni.length === 1 ? anni.anni[0] : null
    setRifiuto(null)
    setDirection(-1)
    if (anni.chiuso) {
      // Nessun anno accetta più domande: vale il messaggio delle iscrizioni chiuse, con i dati al loro posto.
      setChiusoDalServer(true)
      setAvvisoAnno(null)
      setStep(ultimo)
    } else if (mostraAnno) {
      setAvvisoAnno({ tipo: 'scegli' })
      setStep(passoAnno)
    } else if (unico !== null && unico.anno_id !== rifiuto.inviato) {
      setAvvisoAnno({ tipo: 'cambiato', anno: unico.etichetta_breve })
      setStep(ultimo)
    } else {
      setAvvisoAnno({ tipo: 'incerto' })
      setStep(ultimo)
    }
  }

  const current = steps[Math.min(step, steps.length - 1)]
  const isLast = step === steps.length - 1
  const progress = ((step + 1) / steps.length) * 100

  // Campi (namespacizzati) dell'istanza corrente. Le pagine bambino/adulto sono
  // template RIPETIBILI: ogni figlio/adulto ha i propri campi `children.i.*` /
  // `adults.i.*`, e la validazione va applicata all'istanza mostrata.
  function currentNsFields(): FormField[] {
    if (current.kind === 'child') return nsFields(`children.${current.index}`, childFields)
    if (current.kind === 'adult') return nsFields(`adults.${current.index}`, adultFields)
    // I consensi NON sono namespacizzati: sono uno per invio, non uno per figlio.
    if (current.kind === 'consensi') return CONSENSI_FIELDS
    return []
  }

  /**
   * Mappa gli errori per-campo del server (400 `{ campi: { children: { i: { id: msg } }, adults: {…} } }`)
   * sulla stessa UI degli errori client, e porta l'utente all'istanza in errore.
   */
  function mappaErroriServer(campi: unknown): boolean {
    if (campi === null || typeof campi !== 'object') return false
    const c = campi as {
      children?: Record<string, Record<string, string>>
      adults?: Record<string, Record<string, string>>
    }
    let primoStep = -1
    const applica = (
      gruppo: 'children' | 'adults',
      mappa: Record<string, Record<string, string>> | undefined,
      stepDi: (i: number) => number,
    ): void => {
      if (mappa === null || mappa === undefined || typeof mappa !== 'object') return
      for (const [idxStr, campiRec] of Object.entries(mappa)) {
        const i = Number(idxStr)
        if (!Number.isInteger(i) || campiRec === null || typeof campiRec !== 'object') continue
        for (const [campoId, msg] of Object.entries(campiRec)) {
          if (typeof msg !== 'string' || msg.length === 0) continue
          setError(`${gruppo}.${i}.${campoId}`, { type: 'server', message: msg })
          const s = stepDi(i)
          if (primoStep === -1 || s < primoStep) primoStep = s
        }
      }
    }
    // `offset`: col passo sede in testa, il bambino i-esimo non è più il passo i.
    applica('children', c.children, i => offset + i)
    applica('adults', c.adults, i => offset + childCount + i)
    if (primoStep === -1) return false
    if (primoStep !== step) {
      setDirection(primoStep < step ? -1 : 1)
      setStep(primoStep)
    }
    return true
  }

  async function goNext() {
    // Passo sede: nessun campo del modulo da validare, ma la scelta è obbligatoria.
    if (current.kind === 'sede') {
      if (!sedeScelta) {
        setErroreSede(true)
        return
      }
      setErroreSede(false)
      // Prima di cambiare passo si sa se il passo «anno» esiste: l'elenco degli anni della sede scelta può
      // essere ancora in volo, e `steps` non deve cambiare forma dopo che si è avanzato. Se la sede non
      // accetta domande (`chiuso`) non si avanza: lo dice il messaggio sotto l'elenco delle sedi.
      const { chiuso } = await anni.attendi()
      if (chiuso) return
      setDirection(1)
      setStep(s => s + 1)
      return
    }

    // Passo anno: la scelta è obbligatoria, come quella della sede.
    if (current.kind === 'anno') {
      if (!annoEffettivo) {
        setErroreAnno(true)
        return
      }
      setErroreAnno(false)
      setDirection(1)
      setStep(s => s + 1)
      return
    }

    const fields = currentNsFields()
    // Provincia: normalizza i nomi riconosciuti in sigla PRIMA di validare
    // ("Napoli" → "NA"), così passa anche senza blur; l'irriconoscibile resta e
    // la validazione lo blocca.
    for (const f of fields) {
      if (!isProvinceField(f)) continue
      const raw = getValues(f.id)
      if (raw === null || raw === undefined || String(raw).trim() === '') continue
      const sigla = normalizzaProvincia(raw)
      if (sigla && sigla !== raw) setValue(f.id, sigla, { shouldValidate: false })
    }

    const valid = await trigger(fields.map(f => f.id))
    if (!valid) {
      const primo = fields.find(f => validateField(f, getValues(f.id)))
      if (primo) setFocus(primo.id)
      return
    }

    // ── UN GENITORE, UNA CASELLA ──────────────────────────────────────────
    // `validateField` guarda un campo per volta e `trigger` un passo per volta:
    // nessuno dei due può vedere che questo indirizzo è lo stesso di un altro
    // genitore. Si guarda uscendo dal passo, contro i genitori GIÀ compilati, e
    // si segnala su questo campo — che è quello da cambiare.
    if (current.kind === 'adult') {
      const finQui = Array.from({ length: current.index + 1 }, (_, i) => getValues(`adults.${i}.email`))
      if (indiciEmailRipetute(finQui).includes(current.index)) {
        const id = `adults.${current.index}.email`
        setError(id, { type: 'validate', message: EMAIL_RIPETUTA_FRA_GENITORI })
        setFocus(id)
        return
      }
    }

    if (isLast) {
      // Rete di sicurezza: se il genitore è tornato indietro e ha cambiato la
      // casella del PRIMO adulto facendola coincidere con quella del secondo, il
      // controllo all'uscita del passo non l'ha vista — guarda solo all'indietro.
      // Qui si guardano tutti insieme, un istante prima dell'invio.
      //
      // ⚠️ In quel caso si finisce sul campo del SECONDO adulto, non su quello
      // appena modificato: `indiciEmailRipetute` segnala per contratto la seconda
      // occorrenza, e da qui non si sa quale dei due campi sia stato toccato per
      // ultimo. Non è la stessa cosa che portarlo dove ha appena scritto, ma
      // l'esito è comunque risolvibile — cambiare l'una o l'altra casella scioglie
      // il duplicato — e la frase spiega il perché su entrambe.
      const tutte = Array.from({ length: adultCount }, (_, i) => getValues(`adults.${i}.email`))
      const ripetute = indiciEmailRipetute(tutte)
      if (ripetute.length > 0) {
        const primo = ripetute[0]
        setError(`adults.${primo}.email`, { type: 'validate', message: EMAIL_RIPETUTA_FRA_GENITORI })
        setDirection(-1)
        setStep(offset + childCount + primo)
        return
      }
    }
    if (isLast) {
      // Ultima difesa lato client: se il passo sede esiste ma nessuna sede è stata
      // scelta (può accadere solo se l'elenco è arrivato a genitore già avanzato),
      // non si invia alla cieca — si torna a farla scegliere. Un'iscrizione finita
      // nel plesso sbagliato è peggio di un passo in più.
      if (mostraSede && !sedeScelta) {
        setErroreSede(true)
        setDirection(-1)
        setStep(0)
        return
      }
      // Lo stesso per l'anno: se il passo c'è e nessun anno è scelto (l'elenco è cambiato dopo un rifiuto),
      // si torna a farlo scegliere. Un bambino iscritto nell'anno sbagliato è peggio di un passo in più.
      if (mostraAnno && !annoEffettivo) {
        setErroreAnno(true)
        setDirection(-1)
        setStep(passoAnno)
        return
      }
      await handleSubmit()
    } else {
      setDirection(1)
      setStep(s => s + 1)
    }
  }

  function goPrev() {
    // Tornare indietro per correggere qualcosa spegne l'errore d'invio: tenerlo
    // acceso lo trasformerebbe in un avviso che si impara a ignorare.
    setErroreInvio(false)
    setChiusoDalServer(false)
    setAvvisoAnno(null)
    setDirection(-1)
    setStep(s => Math.max(0, s - 1))
  }

  async function handleSubmit() {
    setSubmitting(true)
    setErroreInvio(false)
    setChiusoDalServer(false)
    setAvvisoAnno(null)
    try {
      const all = getValues()
      const children = (all.children ?? []).slice(0, childCount).filter(Boolean)
      const adults = (all.adults ?? []).slice(0, adultCount).filter(Boolean)
      // I CONSENSI vanno nel payload, e questa riga è la ragione per cui il
      // percorso end-to-end esiste: senza, il wizard li raccoglieva e li buttava
      // via prima dell'invio. Ogni pezzo funzionava — la casella, la
      // validazione, la registrazione della prova — e il collegamento fra
      // penultimo e ultimo no. Il server rifiutava, giustamente, un invio senza
      // presa visione.
      const consensi = Object.fromEntries(
        CONSENSI_FIELDS.map(f => [f.id, (all as Record<string, unknown>)[f.id] === true]),
      )
      const data: EnrollmentSubmissionData = { ...consensi, children, adults }

      const res = await fetch('/api/iscrizione', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Priorità al link (?scuola=), poi alla scelta del genitore. Se nessuna
        // delle due c'è, il server risolve la sede da solo (o risponde 400).
        // `anno_id`: l'anno scelto (o l'unico offerto). Assente quando l'elenco degli anni non c'è (database
        // in ritardo, guasto): allora sceglie il server, come prima di questa modifica.
        body: JSON.stringify({
          data,
          scuola_id: sedeDaLink ?? sedeScelta ?? undefined,
          anno_id: annoEffettivo ?? undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        // Due rifiuti dell'ANNO che non sono un guasto: si dicono in pagina, con i dati ancora al loro posto.
        if (res.status === 409 && json?.codice === 'ISCRIZIONI_CHIUSE') {
          setChiusoDalServer(true)
          return
        }
        if (res.status === 422 && json?.codice === 'ANNO_NON_OFFERTO') {
          // L'elenco è cambiato mentre si compilava: si riprende l'elenco, e quando torna (nel render, subito dopo `steps`)
          // si decide dove sta la famiglia e che cosa legge. Vale anche senza il passo «anno»: con un anno solo il
          // messaggio compare nel punto in cui si trova, non c'è un passo a cui tornare.
          setAnnoScelto(null)
          setRifiuto({ letture: anni.letture, inviato: annoEffettivo })
          anni.ricarica()
          return
        }
        // Il server riverifica e risponde 400 con gli errori per campo: mappali
        // sui campi (stessa UI del client) e riporta l'utente all'istanza in errore,
        // invece di un alert generico.
        if (res.status === 400 && mappaErroriServer(json?.campi)) return
        // ETICHETTA STABILE, non `json.error`. A schermo quella prosa non arriva
        // (il `catch` accende `setErroreInvio`), ma `err.stack` comincia con il
        // MESSAGGIO ed è ciò che `logClient` spedisce: la frase del server ci
        // finiva dentro tale e quale, e questo è il modulo in cui una famiglia
        // scrive il nome del figlio. Lo status è un numero e basta a capire.
        throw new Error(`invio-iscrizione: HTTP ${res.status}`)
      }
      setDone(true)
    } catch (err) {
      // Un catch che riporta l'errore all'utente deve LOGGARE: `withRoute` è lato
      // server e non vede questa eccezione. `logClient` redige il path e non lancia.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `iscrizione-invio-fallito: ${nomeErrore(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
      })
      // NIENTE `alert()`. Il pannello di sistema non dice cosa fare, non lascia
      // traccia in pagina, non è leggibile da chi ingrandisce i caratteri e
      // nella WebView dell'app è ancora peggio. Il messaggio sta in pagina,
      // accanto al bottone che si è appena premuto, e dice l'unica cosa che
      // conta a chi ha appena compilato quattro passi: i dati sono ancora qui.
      setErroreInvio(true)
    } finally {
      setSubmitting(false)
    }
  }

  function addChild() {
    if (childCount >= ENROLLMENT_LIMITS.maxChildren) return
    setChildCount(c => c + 1)
    setDirection(1)
    setStep(offset + childCount) // vai alla nuova pagina figlio (in coda ai figli)
  }
  function addAdult() {
    if (adultCount >= ENROLLMENT_LIMITS.maxAdults) return
    setAdultCount(a => a + 1)
    setDirection(1)
    setStep(offset + childCount + adultCount) // nuova pagina adulto
  }

  // Header dinamico. Il numero dell'istanza è un VALORE composto in JS (il
  // sostantivo è tradotto, la posizione del numero è identica in it/en); i
  // plurali veri restano ICU nel riepilogo.
  //
  // ⚠️ Il ramo `consensi` non c'era, e la catena di ternari cadeva sul ramo
  // finale: il passo dei CONSENSI si annunciava «Riepilogo — Controlla e invia
  // la richiesta», cioè il titolo del passo successivo. Sotto, il corpo del
  // passo ripeteva il titolo vero in una seconda intestazione dello stesso
  // livello: due `h2` di cui uno mentiva, sulla schermata su cui una famiglia
  // presta il consenso al trattamento dei dati del figlio. Un'intestazione che
  // dice il nome di un'altra pagina non è un dettaglio estetico — è ciò che uno
  // screen reader legge per prima cosa quando ci si arriva.
  const heading =
    current.kind === 'sede'
      ? { icon: MapPin, title: t('wizardSede'), sub: t('wizardSedeSub') }
      : current.kind === 'anno'
      ? { icon: CalendarDays, title: ta('annoPassoTitolo'), sub: ta('annoPassoSottotitolo') }
      : current.kind === 'child'
      ? { icon: Baby, title: `${t('wizardBambino')} ${current.index + 1}`, sub: t('wizardBambinoSub') }
      : current.kind === 'adult'
      ? {
          icon: Users,
          title: `${t('wizardAdulto')} ${current.index + 1}${current.index === 0 ? t('wizardAdultoObbligatorioSuffix') : ''}`,
          sub: t('wizardAdultoSub'),
        }
      : current.kind === 'consensi'
      ? { icon: Info, title: t('wizardConsensiTitolo'), sub: t('wizardConsensiSottotitolo') }
      : { icon: Check, title: t('wizardRiepilogo'), sub: t('wizardRiepilogoSub') }

  const HeadIcon = heading.icon

  return (
    // `kv-public` è il marcatore della superficie PUBBLICA: senza, l'Alto
    // Contrasto su questa pagina non cambiava un pixel. I token si ribaltano
    // (`--color-kidville-cream` → #000), ma il guscio è dipinto con le utility
    // `bg-kidville-cream`/`bg-white`, il cui hex `@theme inline` ha già inlinato:
    // le regole per-superficie in globals.css sono l'unico modo di raggiungerlo.
    <div className="kv-public min-h-screen flex flex-col bg-kidville-cream text-kidville-ink">
      {/* Progress bar */}
      <div className="h-1 w-full bg-kidville-cream-dark">
        <motion.div
          className="h-full bg-kidville-green"
          initial={false}
          animate={{ width: `${progress}%` }}
          transition={{ type: 'spring', damping: 30, stiffness: 200 }}
        />
      </div>

      <div className="flex-1 w-full max-w-2xl mx-auto px-5 py-8 flex flex-col">
        {/*
          Brand header — ed è anche l'`<h1>` della pagina.

          Fino al 2026-08-01 questa schermata non ne aveva NESSUNO: era un `div`
          con dentro uno `span`. Su `/iscrizione` 251 famiglie hanno consegnato
          codici fiscali di minori, allergie e note mediche (≈9 invii l'ora), e
          chi naviga per intestazioni con uno screen reader — il modo normale di
          orientarsi in una pagina lunga — non trovava nulla da cui partire: né
          il nome della pagina, né il punto in cui ricominciare dopo un errore.
          Il testo è lo stesso di prima (`wizardEyebrow` = «Iscrizione Nuovo
          Alunno»), l'aspetto pure: cambia solo che adesso è un'intestazione.

          L'icona è decorativa e viene tolta dall'albero di accessibilità, così
          il nome dell'`h1` resta esattamente il titolo.
        */}
        {/* ⚠️ `flex-wrap` E `min-w-0`, E NON SONO RIFINITURE — SONO UNA MISURA.
            Aggiungere il marchio a questa riga ha fatto TRABOCCARE la pagina, e
            non solo su schermo stretto: misurato con Chromium il 2026-08-20 su
            `/iscrizione` viva, `document.documentElement.scrollWidth` contro
            `clientWidth`:

              viewport   prima      dopo
              320 px     394        320
              360 px     423        360
              390 px     437        390
              414 px     448        414

            Nascondendo il solo `<img>` l'eccedenza spariva del tutto a ogni
            larghezza: la causa era il marchio, e la pagina scrollava in
            orizzontale — su quella da cui ~9 famiglie l'ora consegnano dati di
            minori.

            Il rilievo che l'aveva ipotizzata parlava di «250 px in una riga che
            non va a capo» sotto i 360, e la sua aritmetica era giusta ma per
            difetto: la riga era `flex … justify-between gap-3` SENZA
            `flex-wrap`, il gruppo destro (`Alto contrasto` 148 px + gap +
            wordmark 94 px) non si comprime per costruzione, e il blocco di
            sinistra non aveva `min-w-0` — quindi il suo min-content spingeva
            fuori tutto il resto a QUALUNQUE larghezza, non solo sotto i 360.

            Il commento di `MarchioKidville.tsx` misurava il wrap su
            `PublicPageHeader`, che `flex-wrap` ce l'ha: quella misura non
            diceva niente di questa riga, ed è il motivo per cui il difetto è
            passato. */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 mb-2 text-xs uppercase tracking-widest font-semibold text-kidville-warn-strong">
              <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
              {t('wizardEyebrow')}
            </h1>
            {!done && formaDecisa && (
              <p className="text-xs text-kidville-sub font-medium">
                {t('wizardPassoDi', { corrente: step + 1, totale: steps.length })}
              </p>
            )}
          </div>
          {/* Il comando di Alto Contrasto. Su questa schermata i bottoni erano
              DUE — «Indietro» e «Avanti» — e nessuno offriva accessibilità: è la
              pagina da cui ~9 famiglie l'ora consegnano dati di minori, e chi
              fatica a leggere non aveva alcun rimedio raggiungibile. */}
          {/* ⚠️ IL MARCHIO MANCAVA PROPRIO QUI, e il lock diceva il contrario.
              `PublicPageHeader-logo.test.tsx` elencava `/iscrizione` fra le
              pagine che prendono la testata dal componente unico: questa pagina
              non lo ha mai usato — monta il comando di contrasto a mano, perché
              a sinistra ha il contatore dei passi invece del ritorno. Il lock
              restava verde perché prova il componente ISOLATO, senza mai rendere
              la pagina. Misurato il 2026-08-20: zero `<img>` nel DOM di
              `/iscrizione`. È la pagina da cui ~9 famiglie l'ora consegnano dati
              di minori, cioè la superficie pubblica più vista di tutte. */}
          <div className="flex shrink-0 items-center gap-2">
            <PublicContrastButton />
            <MarchioKidville />
          </div>
        </div>

        {annoChiusoSenzaAlternative ? (
          /*
           * LE ISCRIZIONI DI QUESTA SEDE SONO CHIUSE — e lo si dice PRIMA di far compilare quattro passi.
           * Il server ha risposto `chiuso: true` (nessun anno accetta domande) e la famiglia non ha un'altra
           * sede da scegliere: non c'è un invio possibile. Senza «Riprova»: ripetere darebbe la stessa risposta.
           * Con più sedi il messaggio sta sotto l'elenco delle sedi (passo «sede»), così se ne può scegliere
           * un'altra.
           */
          <div role="alert" className="flex-1 flex flex-col items-center justify-center gap-4 py-10">
            <div className="w-full rounded-card border border-kidville-error bg-kidville-error-soft px-5 py-4 text-left">
              <h2 className="flex items-center gap-2 text-base font-semibold text-kidville-error-strong">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                {ta('annoChiusoTitolo')}
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-kidville-ink">{ta('annoChiusoCorpo')}</p>
            </div>
          </div>
        ) : domandaNonPuoCominciare ? (
          /*
           * NON C'È NESSUNA SEDE SU CUI ISCRIVERSI — e lo si dice.
           *
           * Due cause, due frasi, un solo pannello: l'elenco NON è arrivato
           * (`sediNonCaricate`, guasto → si riprova) oppure è arrivato ed è
           * VUOTO (`sediVuote`, niente da ricaricare → si contatta la
           * segreteria). Distinguerle non è cosmesi: dire «non riusciamo a
           * caricare le sedi» quando l'elenco è arrivato manda il genitore a
           * controllare la propria connessione per un problema che non ha.
           *
           * Il caso del guasto, per esteso.
           *
           * Misurato in collaudo: `GET /api/iscrizione/sedi` → 429 (tetto 30
           * richieste ogni 10 minuti per IP; dietro il NAT di una scuola o il
           * CGNAT di un operatore mobile quell'IP lo condividono decine di
           * famiglie). Prima di questo ramo il guasto era muto: il modulo si
           * apriva su «Passo 1 di 4 — Bambino 1», il genitore compilava
           * anagrafica del minore, codice fiscale, allergie, note mediche e
           * documento d'identità, e all'invio riceveva un 400 dentro un
           * `alert()`. Tutto il lavoro buttato, senza una spiegazione.
           *
           * Con tre plessi la sede NON è deducibile: `resolveScuolaScrittura`
           * risponde 400 se non è indicata, ed è giusto così — una domanda
           * archiviata nel plesso sbagliato è peggio di una domanda non
           * cominciata. Quindi qui non si prosegue: si spiega e si riprova.
           */
          <div
            role="alert"
            className="flex-1 flex flex-col items-center justify-center gap-4 py-10"
          >
            <div className="w-full rounded-card border border-kidville-error bg-kidville-error-soft px-5 py-4 text-left">
              <h2 className="flex items-center gap-2 text-base font-semibold text-kidville-error-strong">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                {sediVuote ? t('wizardSediVuoteTitolo') : t('wizardSediErroreTitolo')}
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-kidville-ink">
                {sediVuote ? t('wizardSediVuoteCorpo') : t('wizardSediErroreCorpo')}
              </p>
            </div>
            {/* «Riprova» solo per il GUASTO. Con l'elenco già arrivato e vuoto
                non c'è niente da ricaricare: un pulsante che ripete la stessa
                risposta insegna a non fidarsi dei pulsanti.

                L'inchiostro è `yellow-ink` e non `yellow`: il riempimento di
                brand resta lo stesso, ma la coppia giallo-su-verde vale 4,05:1 —
                sotto AA per un testo di questa misura — mentre `yellow-ink` su
                verde vale 4,78:1 (6,51:1 sull'hover). È la stessa scelta di
                `Btn.tsx`, misurata in `__tests__/a11y/contrasto-cascata.test.tsx`. */}
            {!sediVuote && (
              <button
                type="button"
                onClick={riprovaSedi}
                className="flex items-center gap-2 px-6 py-2.5 rounded-pill bg-kidville-green hover:bg-kidville-green-dark text-kidville-yellow-ink font-barlow font-bold uppercase tracking-wide text-sm transition-all"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                {t('wizardSediRiprova')}
              </button>
            )}
          </div>
        ) : !formaDecisa ? (
          // Attesa dell'elenco sedi: nessun passo viene dipinto finché non si sa se
          // il passo sede esiste. Dipingerne uno adesso e cambiarlo dopo congelerebbe
          // `AnimatePresence mode="wait"` (vedi il commento su `statoSedi`).
          <div
            className="flex-1 flex items-center justify-center"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="w-6 h-6 animate-spin text-kidville-green" aria-hidden="true" />
            <span className="sr-only">{t('wizardCaricamento')}</span>
          </div>
        ) : done ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex-1 flex flex-col items-center justify-center text-center"
          >
            <div className="w-16 h-16 rounded-2xl bg-kidville-success-soft flex items-center justify-center mb-4">
              <PartyPopper className="w-8 h-8 text-kidville-success" />
            </div>
            <h2 className="text-xl font-semibold text-kidville-green">{t('wizardInviata')}</h2>
            <p className="text-sm text-kidville-sub mt-1.5 max-w-sm">
              {t('wizardInviataCorpo')}
            </p>
          </motion.div>
        ) : (
          <>
            <div className="flex-1 relative overflow-hidden">
              {/*
                NIENTE `AnimatePresence mode="wait"` qui, ed è una scelta pagata cara.
                Con `mode="wait"` il pannello nuovo si monta solo DOPO che l'uscita del
                vecchio si è conclusa: quando quell'uscita non si concludeva, il wizard
                restava inchiodato al primo passo mentre `step` avanzava lo stesso —
                e il pannello mai montato non registra i propri campi in react-hook-form,
                quindi la validazione passava a vuoto e si arrivava all'invio con
                bambini e adulti VUOTI. Un'animazione non può decidere se un modulo
                funziona. Qui il cambio di `key` smonta e rimonta subito: si perde
                l'animazione d'uscita, si guadagna un modulo che non può bloccarsi.
              */}
              <motion.div
                key={`${current.kind}-${current.kind === 'child' || current.kind === 'adult' ? current.index : 'x'}`}
                custom={direction}
                variants={slide}
                initial="enter"
                animate="center"
                transition={{ type: 'spring', damping: 30, stiffness: 260, opacity: { duration: 0.2 } }}
              >
                  {/* Step header */}
                  <div className="mb-5 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-kidville-success-soft flex items-center justify-center flex-shrink-0">
                      <HeadIcon className="w-4.5 h-4.5 text-kidville-success" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-kidville-green leading-tight">{heading.title}</h2>
                      <p className="text-sm text-kidville-sub">{heading.sub}</p>
                    </div>
                  </div>

                  {/* Per quale anno si iscrive il bambino, con quota e documenti: dal primo passo dopo la sede (e dopo
                      la scelta dell'anno, se c'è); il riepilogo lo rimostra più sotto, al posto di questa copia. */}
                  {etichettaAnnoEffettivo && current.kind !== 'sede' && current.kind !== 'anno' && current.kind !== 'review' && (
                    <InfoAnnoIscrizione anno={etichettaAnnoEffettivo} info={infoAnno} />
                  )}

                  {/* SEDE step — compare solo con più sedi e senza ?scuola= nel link */}
                  {current.kind === 'sede' && (
                    <fieldset className="space-y-3">
                      <legend className="sr-only">{t('wizardSedeLegenda')}</legend>
                      {sedi.map(s => {
                        const scelta = sedeScelta === s.id
                        return (
                          <label
                            key={s.id}
                            htmlFor={`sede-${s.id}`}
                            /* Niente `focus-within:ring-*`: l'anello lo disegna
                               `:focus-visible` sul radio, come sulle card che
                               rende `FieldRenderer` nei passi successivi di
                               QUESTO stesso modulo. Tenerlo qui e non là (o
                               viceversa) vuol dire due segni del fuoco diversi
                               nella stessa schermata, ed è il rilievo chiuso
                               l'11/08/2026 sul modulo insegnanti: sull'`input`
                               `outline: 2px solid rgb(0,106,95)` e sulla
                               `<label>` un secondo anello da 4px, concentrico. */
                            className={`flex items-center gap-3 px-4 py-3.5 rounded-xl border cursor-pointer transition-all ${
                              scelta
                                ? 'border-kidville-green bg-kidville-green-soft'
                                /* `neutral` e non `line`: misurato l'11/08/2026, `--color-kidville-line`
                                   (#EFE7DC) su fondo crema fa **1,10:1**, cioè un contorno che a
                                   occhio non esiste — e qui il riempimento bianco su crema aggiunge
                                   appena 1,11:1, quindi quel bordo è l'UNICO indizio di dove
                                   finisce una sede e comincia l'altra. Con `neutral` la regola per
                                   superficie di `globals.css` (§ «il confine di una card di scelta»)
                                   lo porta a 5,82:1, e in Alto Contrasto a nero pieno. Non è una
                                   scelta estetica: WCAG 1.4.11 chiede 3:1 al confine di un
                                   componente, e questa è la schermata su cui 375 famiglie hanno
                                   scelto il plesso del proprio figlio. */
                                : 'border-kidville-neutral bg-kidville-white hover:border-kidville-green/40'
                            }`}
                          >
                            <input
                              type="radio"
                              id={`sede-${s.id}`}
                              name="sede"
                              value={s.id}
                              checked={scelta}
                              onChange={() => { setSedeScelta(s.id); setErroreSede(false) }}
                              className="w-4 h-4 accent-kidville-green"
                            />
                            <MapPin className={`w-4 h-4 flex-shrink-0 ${scelta ? 'text-kidville-green' : 'text-kidville-sub'}`} />
                            <span className={`text-sm ${scelta ? 'text-kidville-green font-semibold' : 'text-kidville-ink'}`}>
                              {s.nome}
                            </span>
                          </label>
                        )
                      })}
                      {erroreSede && (
                        <p role="alert" className="text-xs text-kidville-error-strong">
                          {t('wizardSedeErrore')}
                        </p>
                      )}
                      {/* La sede scelta non accetta domande: lo si dice qui, accanto alla scelta, perché se ne
                          può scegliere un'altra. «Avanti» non avanza (vedi `goNext`). */}
                      {anni.chiuso && sedeScelta && (
                        <div role="alert" className="rounded-card border border-kidville-error bg-kidville-error-soft px-4 py-3">
                          <p className="flex items-center gap-2 text-sm font-semibold text-kidville-error-strong">
                            <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                            {ta('annoChiusoTitolo')}
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-kidville-ink">{ta('annoChiusoCorpo')}</p>
                        </div>
                      )}
                    </fieldset>
                  )}

                  {/* ANNO step — compare solo con almeno due anni che accettano domande */}
                  {current.kind === 'anno' && (
                    <fieldset className="space-y-3">
                      <legend className="sr-only">{ta('annoLegenda')}</legend>
                      {anni.anni.map(a => {
                        const scelto = annoEffettivo === a.anno_id
                        return (
                          <label
                            key={a.anno_id}
                            htmlFor={`anno-${a.anno_id}`}
                            /* Stesso aspetto, e stesse ragioni di contrasto, delle card di scelta della sede. */
                            className={`flex items-center gap-3 px-4 py-3.5 rounded-xl border cursor-pointer transition-all ${
                              scelto
                                ? 'border-kidville-green bg-kidville-green-soft'
                                : 'border-kidville-neutral bg-kidville-white hover:border-kidville-green/40'
                            }`}
                          >
                            <input
                              type="radio"
                              id={`anno-${a.anno_id}`}
                              name="anno"
                              value={a.anno_id}
                              checked={scelto}
                              onChange={() => { setAnnoScelto(a.anno_id); setErroreAnno(false); setAvvisoAnno(null) }}
                              className="w-4 h-4 accent-kidville-green"
                            />
                            <CalendarDays className={`w-4 h-4 flex-shrink-0 ${scelto ? 'text-kidville-green' : 'text-kidville-sub'}`} />
                            <span className="flex flex-col">
                              <span className={`text-sm ${scelto ? 'text-kidville-green font-semibold' : 'text-kidville-ink'}`}>
                                {a.etichetta_breve}
                              </span>
                              <span className="text-xs text-kidville-sub">
                                {a.ingresso === 'durante' ? ta('annoIngressoDurante') : ta('annoIngressoInizio')}
                              </span>
                            </span>
                          </label>
                        )
                      })}
                      {erroreAnno && (
                        <p role="alert" className="text-xs text-kidville-error-strong">
                          {ta('annoErroreScelta')}
                        </p>
                      )}
                    </fieldset>
                  )}

                  {/* CHILD step */}
                  {current.kind === 'child' && (
                    <div className="space-y-6">
                      {/* CHE COSA SIGNIFICA QUELL'ASTERISCO (25/08/2026).
                          `FieldRenderer` lo stampa accanto a ogni etichetta
                          obbligatoria; fino a oggi questo modulo non diceva da
                          nessuna parte che cosa fosse. MISURATO a 390×844 sul
                          passo «Bambino 1»: DIECI asterischi, dieci
                          `aria-required`, e in pagina nessun testo che li
                          spiegasse. La riga decide da sé se comparire — le si
                          passano i campi del passo, non un elenco scritto a mano. */}
                      <LegendaObbligatori campi={childFields} />
                      {nsFields(`children.${current.index}`, childFields).map(f => (
                        <FieldRenderer
                          key={f.id}
                          field={f}
                          modelId="iscrizioni"
                          register={register}
                          control={control}
                          error={resolveError(errors, f.id)}
                          uploadEndpoint={UPLOAD_ENDPOINT}
                        />
                      ))}
                      {current.index === childCount - 1 && (
                        <div className="flex items-center gap-3 pt-2">
                          {childCount < ENROLLMENT_LIMITS.maxChildren && (
                            <button
                              type="button"
                              onClick={addChild}
                              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-kidville-success-soft border border-kidville-success/30 text-kidville-success-strong text-sm font-medium hover:bg-kidville-success-soft transition-all"
                            >
                              <Plus className="w-4 h-4" /> {t('wizardAggiungiFiglio')}
                            </button>
                          )}
                          {childCount > 1 && current.index === childCount - 1 && (
                            <button
                              type="button"
                              onClick={() => { setChildCount(c => c - 1); setStep(s => Math.max(0, s - 1)) }}
                              className="flex items-center gap-2 px-3 py-2 rounded-xl text-kidville-sub hover:text-kidville-error text-sm transition-all"
                            >
                              <Trash2 className="w-4 h-4" /> {t('wizardRimuovi')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ADULT step */}
                  {current.kind === 'adult' && (
                    <div className="space-y-6">
                      {current.index === 0 && (
                        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-kidville-info-soft border border-kidville-info/20">
                          <Info className="w-4 h-4 text-kidville-info-strong flex-shrink-0 mt-0.5" />
                          <p className="text-xs text-kidville-info-strong leading-relaxed">
                            {t('wizardAdultoInfo')}
                          </p>
                        </div>
                      )}
                      {/* Dal secondo adulto in poi si dice PRIMA perché serve una
                          casella diversa: scoprirlo con un errore, dopo aver
                          scritto l'indirizzo di famiglia, fa pensare a un
                          capriccio del modulo — e la reazione naturale sarebbe
                          inventare un indirizzo pur di andare avanti. */}
                      {current.index > 0 && (
                        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-kidville-info-soft border border-kidville-info/20">
                          <Info className="w-4 h-4 text-kidville-info-strong flex-shrink-0 mt-0.5" />
                          <p className="text-xs text-kidville-info-strong leading-relaxed">
                            {t('wizardAdultoEmailPropria')}
                          </p>
                        </div>
                      )}
                      <LegendaObbligatori campi={adultFields} />
                      {nsFields(`adults.${current.index}`, adultFields).map(f => (
                        <FieldRenderer
                          key={f.id}
                          field={f}
                          modelId="iscrizioni"
                          register={register}
                          control={control}
                          error={resolveError(errors, f.id)}
                          uploadEndpoint={UPLOAD_ENDPOINT}
                        />
                      ))}
                      {current.index === adultCount - 1 && (
                        <div className="flex items-center gap-3 pt-2">
                          {adultCount < ENROLLMENT_LIMITS.maxAdults && (
                            <button
                              type="button"
                              onClick={addAdult}
                              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-kidville-success-soft border border-kidville-success/30 text-kidville-success-strong text-sm font-medium hover:bg-kidville-success-soft transition-all"
                            >
                              <Plus className="w-4 h-4" /> {t('wizardAggiungiAdulto')}
                            </button>
                          )}
                          {adultCount > 1 && current.index === adultCount - 1 && (
                            <button
                              type="button"
                              onClick={() => { setAdultCount(a => a - 1); setStep(s => Math.max(0, s - 1)) }}
                              className="flex items-center gap-2 px-3 py-2 rounded-xl text-kidville-sub hover:text-kidville-error text-sm transition-all"
                            >
                              <Trash2 className="w-4 h-4" /> {t('wizardRimuovi')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* CONSENSI step — informativa al punto di raccolta (art. 13)
                      + prova della presa visione. NB: nessuna spunta sui dati
                      sanitari: per quelli il consenso non è la base giuridica, e
                      chiederlo darebbe una falsa sicurezza (vedi CONSENSI_FIELDS). */}
                  {current.kind === 'consensi' && (
                    <div className="space-y-4">
                      {/* Nessuna intestazione qui dentro: il titolo del passo lo
                          dà ormai l'header dello step (ramo `consensi` di
                          `heading`), con la stessa icona. Ripeterlo qui creava
                          il secondo `h2` che diceva una cosa diversa dal primo. */}
                      <LegendaObbligatori campi={CONSENSI_FIELDS} />
                      <div className="space-y-3">
                        {CONSENSI_FIELDS.map(f => (
                          <FieldRenderer
                            key={f.id}
                            field={f}
                            modelId="iscrizioni"
                            register={register}
                            control={control}
                            error={resolveError(errors, f.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* REVIEW step */}
                  {current.kind === 'review' && (
                    <div className="space-y-4">
                      <div className="px-4 py-3 rounded-xl bg-white border border-kidville-line">
                        <p className="text-sm text-kidville-ink">
                          {t.rich('wizardRiepilogoConteggio', {
                            bambini: childCount,
                            adulti: adultCount,
                            n: (chunks) => <span className="text-kidville-success font-semibold">{chunks}</span>,
                          })}
                        </p>
                      </div>
                      {/* L'anno si dice UNA volta: lo dice il titolo del pannello (rilievo 5 della revisione). */}
                      {etichettaAnnoEffettivo && <InfoAnnoIscrizione anno={etichettaAnnoEffettivo} info={infoAnno} />}
                      <p className="text-xs text-kidville-sub leading-relaxed">
                        {t.rich('wizardRiepilogoNota', {
                          b: (chunks) => <strong className="text-kidville-ink">{chunks}</strong>,
                        })}
                      </p>
                    </div>
                  )}
              </motion.div>
            </div>

            {/* Il server ha detto che le iscrizioni sono chiuse (409): i dati sono ancora qui, e si può
                tornare indietro a scegliere un'altra sede. */}
            {chiusoDalServer && (
              <div role="alert" className="mt-4 rounded-card border border-kidville-error bg-kidville-error-soft px-4 py-3">
                <p className="flex items-center gap-2 text-sm font-semibold text-kidville-error-strong">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                  {ta('annoChiusoTitolo')}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-kidville-ink">{ta('annoChiusoCorpo')}</p>
              </div>
            )}

            {/* L'anno della domanda non accetta più domande (422): il messaggio sta QUI, nel punto in cui si trova la
                famiglia — anche con un anno solo, quando il passo «anno» non esiste — e i dati sono ancora al loro posto. */}
            {avvisoAnno !== null && (
              <div role="alert" className="mt-4 rounded-card border border-kidville-error bg-kidville-error-soft px-4 py-3">
                <p className="flex items-center gap-2 text-sm font-semibold text-kidville-error-strong">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                  {avvisoAnno.tipo === 'scegli'
                    ? ta('annoNonOffertoTitolo')
                    : avvisoAnno.tipo === 'cambiato'
                    ? ta('annoCambiatoTitolo')
                    : ta('annoNonOffertoRiprovaTitolo')}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-kidville-ink">
                  {avvisoAnno.tipo === 'scegli'
                    ? ta('annoNonOffertoCorpo')
                    : avvisoAnno.tipo === 'cambiato'
                    ? ta('annoCambiatoCorpo', { anno: avvisoAnno.anno })
                    : ta('annoNonOffertoRiprovaCorpo')}
                </p>
              </div>
            )}

            {/* L'invio è fallito. Sta QUI — sopra i bottoni, dentro la pagina —
                e non in un `alert()` di sistema: il genitore ha appena premuto
                «Invia richiesta» e deve leggere, senza chiudere niente, che il
                lavoro fatto non è andato perduto. */}
            {erroreInvio && (
              <div
                role="alert"
                className="mt-4 rounded-card border border-kidville-error bg-kidville-error-soft px-4 py-3"
              >
                <p className="flex items-center gap-2 text-sm font-semibold text-kidville-error-strong">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                  {t('wizardErroreInvio')}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-kidville-ink">
                  {t('wizardErroreInvioDatiSalvi')}
                </p>
              </div>
            )}

            {/* Navigation */}
            <div className="flex items-center justify-between gap-3 pt-6 mt-4 border-t border-kidville-line">
              <button
                onClick={goPrev}
                disabled={step === 0 || submitting || rifiuto !== null}
                className="flex items-center gap-2 px-4 py-2.5 rounded-pill font-barlow font-bold uppercase tracking-wide text-sm text-kidville-sub hover:text-kidville-green hover:bg-kidville-green-soft disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                <ArrowLeft className="w-4 h-4" /> {t('wizardIndietro')}
              </button>

              <button
                onClick={goNext}
                disabled={submitting || rifiuto !== null}
                className="flex items-center gap-2 px-6 py-2.5 rounded-pill bg-kidville-green hover:bg-kidville-green-dark disabled:opacity-50 text-kidville-yellow font-barlow font-bold uppercase tracking-wide text-sm transition-all"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isLast ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <ArrowRight className="w-4 h-4 order-2" />
                )}
                <span className={isLast || submitting ? '' : 'order-1'}>
                  {submitting ? t('wizardInvioInCorso') : isLast ? t('wizardInviaRichiesta') : t('wizardAvanti')}
                </span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
