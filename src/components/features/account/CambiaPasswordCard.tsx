'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { AlertCircle, CheckCircle2, Loader2, Minus, ShieldCheck } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { OcchioPassword } from '@/components/ui/OcchioPassword'
import { FUOCO_ESITO } from '@/lib/ui/fuoco'
import { doLogout } from '@/lib/auth/logout'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { erroreDaRisposta, soloCatalogoDaCorpo, type CodiceErrore } from '@/lib/ui/esito-fetch'
import {
  LUNGHEZZA_MINIMA_PASSWORD,
  forzaPassword,
  valutaPasswordNuova,
} from '@/lib/auth/regole-password'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * IL MODULO CON CUI SI CAMBIA LA PROPRIA PASSWORD — uno solo, per tutte le vesti.
 *
 * Lo montano quattro superfici: il profilo del genitore, il profilo del docente,
 * le impostazioni della segreteria e l’interstiziale del primo accesso. Il gesto è
 * identico in tutte e quattro — la password non è un affare di area, esattamente
 * come non lo è la route che la scrive (`POST /api/account/password`, una sola per
 * genitori e personale). Quattro copie di questo form avrebbero significato quattro
 * validazioni, quattro messaggi e quattro modi di raccontare il successo, e la
 * prima a divergere sarebbe stata quella che nessuno riapre più.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * ⚠️ IL FATTO CHE DISEGNA LA SCHERMATA DI SUCCESSO: DOPO IL CAMBIO SI È FUORI.
 *
 * Misurato sul sorgente di GoTrue (2026-09-01): `internal/api/admin.go` →
 * `adminUserUpdate` chiama `user.UpdatePassword(tx, nil)`; `internal/models/user.go`
 * con `sessionID == nil` esegue `Logout(tx, u.ID)`, cioè
 * `DELETE FROM sessions WHERE user_id = ?`. Il cambio revoca **tutte** le sessioni,
 * COMPRESA quella del dispositivo che si ha in mano.
 *
 * Una schermata che dicesse «fatto!» e restasse dov’è mostrerebbe, un istante dopo,
 * una raffica di 401 — e chi ha appena fatto la cosa giusta crederebbe di aver rotto
 * l’applicazione. Perciò il successo lo DICE, con parole che non somigliano a un
 * errore (è una conseguenza normale), e offre il comando per rientrare.
 *
 * E lo dice perché lo ha LETTO: `sessioniTerminate` arriva nel corpo della risposta e
 * si guarda. Darlo per scontato sarebbe una promessa del client su un comportamento
 * del server — cioè la stessa forma di difetto che questo repo ha già pagato ogni
 * volta che una regola è stata ricopiata invece che chiesta a chi la conosce.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * LE TRE COSE CHE DECIDONO SE FUNZIONA DAVVERO SU UN TELEFONO
 *
 *  1. **Incollare deve funzionare.** Nessun `onPaste` intercettato, nessun campo
 *     spezzato in gruppi: chi arriva dall’email incolla `Xxxx-xxxx-xxxx-xxxx` e deve
 *     entrare tale e quale. Per la stessa ragione la password ATTUALE non si
 *     ripulisce mai: uno spazio ai bordi può essere vero, e c’è chi ce l’ha dentro
 *     l’hash — `src/app/auth/login/page.tsx` porta un intero secondo tentativo
 *     d’accesso proprio per non chiudere fuori quelle persone (difetto del
 *     2026-08-22). Sulla password NUOVA invece lo spazio si RIFIUTA, con la sua
 *     frase: di password così non se ne creano più.
 *  2. **`autoCapitalize="none"`** su tutti e tre i campi: senza, iOS maiuscola la
 *     prima lettera di ciò che si digita, e il rifiuto arriva su una password che a
 *     schermo sembra quella giusta.
 *  3. **Il comando in invio non è `disabled`.** `ui/Btn.tsx` lo scrive per esteso:
 *     `disabled` fa sfogare il fuoco a Chrome — che torna su `<body>`, cioè
 *     all’inizio della pagina — e sbiadisce l’unico segnale che il gesto sia
 *     partito. Si usa `aria-disabled` più la guardia in cima al gestore.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/** Da quale porta si sta cambiando: finisce in `password_cambi.origine`, e si misura. */
export type OriginePassword = 'self-service' | 'primo-accesso'

interface Props {
  origine: OriginePassword
  /**
   * L’etichetta del campo «attuale». L’interstiziale del primo accesso la
   * pre-etichetta «La password ricevuta via email»: è il momento in cui l’utente ce
   * l’ha ancora negli appunti, e chiamarla «password attuale» gli farebbe cercare
   * una password che non ha mai scelto.
   */
  etichettaAttuale?: string
  /**
   * Che cosa fare quando il cambio riesce **e** la sessione regge. Oggi non regge mai
   * (vedi la testata), ma il ramo esiste perché la risposta è la fonte: il giorno in
   * cui GoTrue cambiasse idea, la schermata non racconterebbe una cosa falsa.
   */
  onProsegui?: () => void
  /** Etichetta del comando di prosecuzione, quando `onProsegui` c’è. */
  etichettaProsegui?: string
  className?: string
}

/** I quattro gradini di `forzaPassword`, con la parola che li accompagna. */
const PAROLA_FORZA = ['forzaDebole', 'forzaDebole', 'forzaDiscreta', 'forzaBuona', 'forzaOttima'] as const

/** Quale campo va corretto per primo. Il fuoco ci va sopra, e `aria-invalid` con lui. */
type CampoPassword = 'attuale' | 'nuova' | 'conferma'

/**
 * QUALE CAMPO ACCUSA il codice che il server ha mandato — e `null` quando non ne
 * accusa nessuno.
 *
 * ⚠️ IL RAMO `null` È IL PUNTO DI QUESTA FUNZIONE. Un tetto di frequenza (429) e un
 * guasto di scrittura (500) non dicono niente su ciò che l’utente ha digitato:
 * marcare comunque un campo `aria-invalid` significa dire a chi usa uno screen
 * reader «hai sbagliato la password» mentre il problema è nostro — e a quell’utente
 * è anche l’UNICA versione del messaggio che arriva. È lo stesso difetto che
 * `auth/login/page.tsx` documenta su `credenzialiErrate`, e per cui lì esiste uno
 * stato separato dal messaggio.
 *
 * `PASSWORD_RIFIUTATA` invece accusa la nuova, ed è giusto: il provider ha respinto
 * proprio quella stringa (lista di violazioni, policy sua) e il rimedio è
 * sceglierne un’altra.
 */
function campoAccusato(codice: string | null): CampoPassword | null {
  if (codice === 'PASSWORD_ATTUALE_ERRATA') return 'attuale'
  if (
    codice === 'PASSWORD_TROPPO_CORTA' ||
    codice === 'PASSWORD_SENZA_CIFRA' ||
    codice === 'PASSWORD_CON_SPAZI_AI_BORDI' ||
    codice === 'PASSWORD_UGUALE_ALLA_PRECEDENTE' ||
    codice === 'PASSWORD_RIFIUTATA'
  ) {
    return 'nuova'
  }
  return null
}

/**
 * ─── IL CAMPO, E LE TRE COSE CHE IL SUO VESTITO DEVE TENERE INSIEME ──────────
 *
 * 1. **L’ALTEZZA È DICHIARATA (`h-12` = 48px), non calcolata.** Prima non lo era:
 *    veniva fuori da `py-2.5` (10+10), dall’interlinea di `text-sm` (20) e da
 *    `border-2` (2+2), cioè **44px esatti** — il minimo di WCAG 2.5.8 con margine
 *    ZERO. Un carattere che non si carica, o un’interlinea che cambia, e il
 *    bersaglio scende sotto senza che nessuna riga di codice sia cambiata. Ora sono
 *    48, e il numero si legge invece di ricostruirlo.
 *
 * 2. **`scroll-mt-24` e non un valore in CSS**: dentro le tre shell dell’app la
 *    regola `[data-kv-shell] input { scroll-margin-top: var(--kv-appbar-h) }` di
 *    `globals.css` ha specificità (0,1,1) e VINCE su questa utility (0,1,0), quindi
 *    lì continua a valere l’altezza vera dell’AppBar. Fuori dalle shell
 *    (l’interstiziale sta sotto `/auth`, dove non c’è nessuna barra sticky) resta
 *    questa. Nessuna delle due copia il numero dell’altra.
 *
 * 3. **`pr-12` = 48px** è lo spazio che il bersaglio dell’occhio (44px a `right-1`,
 *    cioè 4+44) toglie al testo: se cambia uno dei due, cambia anche l’altro.
 */
const CAMPO = 'block h-12 w-full rounded-input bg-kidville-white pl-3.5 pr-12 font-maven text-sm text-kidville-ink outline-none placeholder:text-kidville-hint scroll-mt-24'

/**
 * ⚠️ LO STATO DI RIPOSO NON PUÒ ESSERE IL TRATTAMENTO PIÙ FORTE DELLA SCHERMATA.
 *
 * Il difetto, misurato RISOLVENDO LA CASCATA e non guardando la sola utility:
 * `border-kidville-line` su un `<input>` non resta `line`. Una regola non-layered di
 * `globals.css` lo riscrive a `neutral`, e sotto un antenato `.bg-kidville-cream` —
 * le tre shell dell’app e l’interstiziale del primo accesso lo sono **tutte** — lo
 * porta a `sub` #55615C. Con `border-2` erano DUE pixel a 6,46:1 su tutti e tre i
 * campi insieme: sembravano tutti attivi, e sopra non restava niente. L’anello di
 * fuoco (`green`, 6,51:1) e il bordo d’errore (`error`, 4,23:1) erano *meno*
 * evidenti dello stato di riposo — l’errore, letteralmente, si vedeva meno del
 * normale.
 *
 * Ora la scala è di INCHIOSTRO, non di sola tinta:
 *   · riposo → 1px (6,46:1 sulla carta del campo; `neutral` 3,10:1 dove non c’è
 *     antenato crema; NERO 21:1 in Alto Contrasto, che è il motivo per cui la
 *     classe resta `border-kidville-line` invece di un token esplicito: sono
 *     quelle regole a dare all’Alto Contrasto il suo bordo, e scavalcarle
 *     significherebbe toglierglielo)
 *   · fuoco  → bordo verde + anello da 2px = tre pixel di verde
 *   · errore → 2px rossi, PIÙ un’icona e il testo (1.4.1: mai il solo colore)
 *
 * I due stati sono mutuamente esclusivi e non si mescolano mai: in errore la classe
 * `border-kidville-line` NON c’è, ed è l’unico modo in cui la cascata — che dichiara
 * di non toccare i bordi di stato — ci riesce davvero.
 * Misure e lock: `__tests__/a11y/contrasto-barra-forza-password.test.ts`.
 */
const CAMPO_A_RIPOSO = 'border border-kidville-line focus:border-kidville-green focus:ring-2 focus:ring-kidville-green'
const CAMPO_IN_ERRORE = 'border-2 border-kidville-error'

const BOTTONE_OCCHIO =
  'absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-kidville-green active:bg-kidville-green-soft'

export function CambiaPasswordCard({
  origine,
  etichettaAttuale,
  onProsegui,
  etichettaProsegui,
  className,
}: Props) {
  const t = useTranslations('password')
  const percorso = usePathname()
  const base = useId()

  const [attuale, setAttuale] = useState('')
  const [nuova, setNuova] = useState('')
  const [conferma, setConferma] = useState('')
  const [mostra, setMostra] = useState<Record<CampoPassword, boolean>>({
    attuale: false,
    nuova: false,
    conferma: false,
  })
  const [invio, setInvio] = useState(false)
  /**
   * Il rifiuto in corso: che cosa dire, e QUALE campo va corretto.
   *
   * `n` è un contatore, e non è cerimonia: due tentativi che sbagliano lo stesso campo
   * con lo stesso messaggio produrrebbero un oggetto uguale al precedente, l’effetto
   * del fuoco non ripartirebbe, e il secondo rifiuto non riporterebbe l’utente sul
   * campo — proprio nel caso in cui insistere è più probabile (la password attuale
   * digitata male due volte).
   */
  const [rifiuto, setRifiuto] = useState<{ campo: CampoPassword | null; testo: string; n: number } | null>(null)
  const [fatto, setFatto] = useState<{ sessioniTerminate: boolean } | null>(null)

  const rifAttuale = useRef<HTMLInputElement>(null)
  const rifNuova = useRef<HTMLInputElement>(null)
  const rifConferma = useRef<HTMLInputElement>(null)
  const esito = useRef<HTMLDivElement>(null)

  const errore = rifiuto?.testo ?? null
  const campoInErrore = rifiuto?.campo ?? null

  // Il comando che ha lanciato la richiesta SMONTA quando il cambio riesce: senza
  // questo, il fuoco cadrebbe su `<body>` (WCAG 2.4.3). Il ricovero è il messaggio.
  useEffect(() => {
    if (fatto) esito.current?.focus()
  }, [fatto])

  /**
   * IL FUOCO AL PRIMO CAMPO IN ERRORE — e perché sta in un EFFETTO.
   *
   * Chi naviga da tastiera non deve andarselo a cercare, e chi usa uno screen reader
   * sente il campo insieme al motivo (i due sono legati da `aria-describedby`).
   *
   * ⚠️ Spostarlo dentro `segnala()` sembrerebbe più diretto e non si può: quella
   * funzione viene passata come `onBlur` mentre l’albero si costruisce, e leggere
   * `ref.current` in quel momento è accesso a un ref DURANTE il render — che React
   * (e la regola `react-hooks/refs`) vieta, perché il nodo di cui si legge il valore
   * può non essere quello che finirà a schermo.
   */
  useEffect(() => {
    const campo = rifiuto?.campo
    if (!campo) return
    const nodo = campo === 'attuale' ? rifAttuale.current : campo === 'nuova' ? rifNuova.current : rifConferma.current
    nodo?.focus()
  }, [rifiuto])

  const idErrore = `${base}-errore`
  const idCriteri = `${base}-criteri`
  const idForza = `${base}-forza`

  /** I tre requisiti, calcolati mentre si digita. Sono una lista viva, non un rifiuto. */
  const criteri = [
    { chiave: 'criterioLunghezza' as const, testo: t('criterioLunghezza', { minimo: LUNGHEZZA_MINIMA_PASSWORD }), ok: nuova.length >= LUNGHEZZA_MINIMA_PASSWORD },
    { chiave: 'criterioLetteraCifra' as const, testo: t('criterioLetteraCifra'), ok: /[A-Za-z]/.test(nuova) && /[0-9]/.test(nuova) },
    { chiave: 'criterioDiversa' as const, testo: t('criterioDiversa'), ok: nuova !== '' && nuova !== attuale },
  ]
  const soddisfatti = criteri.filter((c) => c.ok).length
  const livello = forzaPassword(nuova)

  /** Un rifiuto da mostrare. `campo: null` = non c’è niente da correggere in un campo. */
  function segnala(campo: CampoPassword | null, testo: string) {
    setRifiuto((r) => ({ campo, testo, n: (r?.n ?? 0) + 1 }))
  }

  function pulisci() {
    setRifiuto(null)
  }

  /** La ripetizione si giudica in USCITA dal campo, non a ogni carattere. */
  function controllaConferma() {
    if (conferma === '' || conferma === nuova) {
      if (campoInErrore === 'conferma') pulisci()
      return
    }
    segnala('conferma', t('erroreConfermaDiversa'))
  }

  async function invia(e: React.FormEvent) {
    e.preventDefault()
    // LA GUARDIA, non `disabled`: vedi la testata e il commento di `ui/Btn.tsx`.
    if (invio) return
    pulisci()

    if (attuale === '') {
      segnala('attuale', t('erroreAttualeMancante'))
      return
    }
    // LA REGOLA STA IN UN POSTO SOLO, ed è quella che userà il server fra un istante.
    // Il `codice` è tipizzato `CodiceErrore`: se un domani la regola ne aggiungesse uno
    // senza dichiararlo in `CODICI_ERRORE`, `tsc` diventerebbe rosso QUI invece di
    // lasciar leggere all’utente la frase generica.
    const regola = valutaPasswordNuova(nuova, attuale)
    if (!regola.ok) {
      const codice: CodiceErrore = regola.codice
      segnala('nuova', soloCatalogoDaCorpo({ codice }, t('erroreGenerico')))
      return
    }
    if (conferma !== nuova) {
      segnala('conferma', t('erroreConfermaDiversa'))
      return
    }

    setInvio(true)
    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ⚠️ `attuale` GREZZA, senza `trim()`: vedi il punto 1 della testata.
        body: JSON.stringify({ attuale, nuova, origine }),
      })

      if (!res.ok) {
        // `erroreDaRisposta` non lancia e non perde lo status; il testo esce dal
        // CATALOGO e mai dalla prosa del server (rilievo T10-F1). Il 429 arriva qui
        // come `TROPPE_RICHIESTE` e il comando resta premibile: non si spegne un
        // comando per un tetto temporaneo.
        const esitoErrore = await erroreDaRisposta(res, t('erroreGenerico'))
        // ⚠️ IL 401 HA UNA FRASE SUA, E SERVE DAVVERO. `requireSessioneAuth` risponde
        // 401 senza `codice`, quindi il ripiego sarebbe «riprova fra poco: quella
        // attuale resta valida» — che manderebbe a ripremere un comando che non può
        // riuscire. Succede in due casi concreti: questa schermata sta sotto `/auth` e
        // la può aprire chiunque anche senza sessione; e chi torna INDIETRO dopo un
        // cambio riuscito ha una sessione che GoTrue ha appena cancellato. Lo status
        // basta a distinguerlo: nessun codice nuovo da dichiarare sul server.
        segnala(
          esitoErrore.stato === 401 ? null : campoAccusato(esitoErrore.codice),
          esitoErrore.stato === 401 ? t('erroreSessioneScaduta') : esitoErrore.testo,
        )
        return
      }

      // Il corpo si LEGGE: `sessioniTerminate` è ciò che decide che cosa dire dopo.
      let sessioniTerminate = false
      try {
        const corpo = (await res.json()) as { sessioniTerminate?: unknown } | null
        sessioniTerminate = corpo?.sessioniTerminate === true
      } catch (err) {
        // La password È cambiata (200): quello che non si è letto è la RISPOSTA. Non è
        // ignorabile — senza questa riga il caso «successo raccontato male» sarebbe
        // invisibile — e non porta `stato`, perché `livelloEvento` scarta in silenzio
        // gli eventi con uno status 4xx fuori da `ANOMALIE_4XX`.
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `cambio password riuscito con corpo illeggibile — origine=${origine} errore=${nomeErrore(err)}`,
          route: percorso ?? undefined,
        })
      }
      setFatto({ sessioniTerminate })
    } catch (err) {
      // L’UNICO guasto che il server non vede: la richiesta che non è mai partita.
      // Il successo e i rifiuti li logga già la route (`account/password:POST`);
      // ripeterli da qui sarebbe la riga di rumore sotto cui non si trova più niente.
      logClient({
        livello: 'warn',
        evento: 'fetch',
        messaggio: `cambio password non inviato — origine=${origine} errore=${nomeErrore(err)}`,
        route: percorso ?? undefined,
      })
      // Nessun campo da mettere a fuoco: non c’è niente di sbagliato in ciò che
      // l’utente ha scritto, e marcare un campo come non valido gli direbbe il
      // contrario proprio mentre il guasto è dalla nostra parte.
      segnala(null, t('erroreRete'))
    } finally {
      setInvio(false)
    }
  }

  if (fatto) {
    return (
      <div
        ref={esito}
        role="status"
        tabIndex={-1}
        className={`rounded-card border border-kidville-green bg-kidville-green-soft p-4 ${FUOCO_ESITO} ${className ?? ''}`}
      >
        <p className="flex items-center gap-2 font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green">
          <ShieldCheck size={20} aria-hidden="true" /> {t('successoTitolo')}
        </p>
        <p className="mt-2 font-maven text-[13px] leading-relaxed text-kidville-ink">
          {fatto.sessioniTerminate ? t('successoSessioni') : t('successoSenzaSessioni')}
        </p>
        {fatto.sessioniTerminate ? (
          // `doLogout()` e non un semplice link: la sessione lato server non esiste
          // più, ma i cookie e l’identità in `localStorage` sono ancora qui. Uscire
          // davvero è l’unico modo di non ripresentarsi al login con addosso lo stato
          // di una sessione che nessuno onorerà.
          <Btn variant="primary" size="lg" className="mt-3 w-full" onClick={() => void doLogout()}>
            {t('vaiAllAccesso')}
          </Btn>
        ) : onProsegui ? (
          <Btn variant="primary" size="lg" className="mt-3 w-full" onClick={onProsegui}>
            {etichettaProsegui ?? t('prosegui')}
          </Btn>
        ) : null}
      </div>
    )
  }

  const campo = (
    quale: CampoPassword,
    etichetta: string,
    autocomplete: 'current-password' | 'new-password',
    valore: string,
    scrivi: (v: string) => void,
    nomeOcchio: string,
    descrizioni: string[],
    onBlur?: () => void,
    vincolo?: string,
  ) => {
    const id = `${base}-${quale}`
    const inErrore = campoInErrore === quale
    const descritto = [...descrizioni, inErrore ? idErrore : null].filter(Boolean).join(' ')
    const riferimento = quale === 'attuale' ? rifAttuale : quale === 'nuova' ? rifNuova : rifConferma
    return (
      <div>
        {/* Etichetta VISIBILE, mai il solo segnaposto: quello sparisce al primo
            carattere, cioè un istante prima del momento in cui servirebbe. */}
        <label htmlFor={id} className="mb-1 block font-maven text-xs font-semibold text-kidville-green">
          {etichetta}
        </label>
        {/* ── IL VINCOLO, SOPRA IL CAMPO E NON SOTTO ──────────────────────────
            ⚠️ IL PANNELLO DELLA REGOLA STA SOTTO, ED È GIUSTO CHE CI STIA: è un
            RISCONTRO, dice a che punto sei. Ma su un telefono, con la tastiera
            aperta e il campo a fuoco, la metà inferiore dello schermo sparisce — e
            con lei «Almeno 10 caratteri», cioè la regola che serviva PRIMA di
            digitare. Due critici indipendenti l'hanno rilevato lo stesso giorno.

            Portare il pannello sopra il campo sembrava la mossa ovvia ed è stata
            scartata per misura: quel pannello è VIVO, la riga «Robustezza: …» va a
            capo quando la parola cambia, e sopra il campo ogni variazione
            sposterebbe in basso il campo che si sta compilando — il cursore che si
            muove sotto il dito mentre si scrive una password che non si vede.

            Quindi la regola si sdoppia per FUNZIONE, non per posto:
              · qui sopra, STATICA, ciò che devi sapere prima → non si muove mai
              · lì sotto,  VIVA,    a che punto sei          → cambia a ogni tasto

            ⚠️ `aria-hidden` NON è una svista. Il campo nomina già l'elenco completo
            dei requisiti in `aria-describedby`, e quell'elenco dice la stessa cosa
            per esteso: senza, chi usa uno screen reader sentirebbe la regola due
            volte a ogni fuoco. È la versione VISIVA di un'informazione che per chi
            ascolta è già arrivata — stessa decisione, stesso motivo, delle tacche.
            E sta FUORI dall'etichetta: dentro, entrerebbe nel nome accessibile del
            campo, e ogni elenco di controlli lo leggerebbe per esteso. */}
        {vincolo && (
          <p data-vincolo aria-hidden="true" className="mb-1 font-maven text-[13px] leading-snug text-kidville-sub">
            {vincolo}
          </p>
        )}
        <div className="relative">
          <input
            ref={riferimento}
            id={id}
            type={mostra[quale] ? 'text' : 'password'}
            value={valore}
            onChange={(e) => scrivi(e.target.value)}
            onBlur={onBlur}
            autoComplete={autocomplete}
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={inErrore}
            aria-describedby={descritto === '' ? undefined : descritto}
            className={`${CAMPO} ${inErrore ? CAMPO_IN_ERRORE : CAMPO_A_RIPOSO}`}
          />
          {/* Bersaglio 44×44 REALE attorno a un’icona di 20 (WCAG 2.5.8). Il NOME non
              cambia con lo stato — lo stato lo dice `aria-pressed`: un’etichetta che
              diventasse «Nascondi» farebbe annunciare «Nascondi la password, premuto».
              La stessa decisione è scritta accanto al bottone della login. */}
          <button
            type="button"
            onClick={() => setMostra((s) => ({ ...s, [quale]: !s[quale] }))}
            aria-label={nomeOcchio}
            aria-pressed={mostra[quale]}
            className={BOTTONE_OCCHIO}
          >
            <span className="block h-5 w-5">
              <OcchioPassword off={mostra[quale]} />
            </span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={invia} className={`space-y-4 ${className ?? ''}`} noValidate>
      {campo(
        'attuale',
        etichettaAttuale ?? t('labelAttuale'),
        'current-password',
        attuale,
        setAttuale,
        t('mostraAttuale'),
        [],
      )}

      {/* ⚠️ IL CAMPO «NUOVA» E LA SUA REGOLA SONO UN GRUPPO SOLO, e questo involucro
          è ciò che lo rende vero: `space-y-4` del form (16px) separa i GRUPPI, non le
          righe dentro un gruppo. Il blocco si stacca dal campo di 4px — la stessa
          distanza che c’è fra un’etichetta e il suo campo — e dal blocco successivo
          di 16. Prossimità: un elemento appartiene a ciò da cui dista meno. */}
      <div>
        {campo(
          'nuova',
          t('labelNuova'),
          'new-password',
          nuova,
          setNuova,
          t('mostraNuova'),
          [idForza, idCriteri],
          undefined,
          // Il minimo si CHIEDE alla regola, non si ricopia: `LUNGHEZZA_MINIMA_PASSWORD`
          // è la stessa costante che il server userà fra un istante.
          t('vincoloNuova', { minimo: LUNGHEZZA_MINIMA_PASSWORD }),
        )}

        {/* ── LA REGOLA DELLA NUOVA PASSWORD: robustezza e requisiti, UN BLOCCO SOLO
            ═══════════════════════════════════════════════════════════════════════
            ⚠️ PRIMA STAVA IN FONDO, SOTTO TUTTI E TRE I CAMPI, e il percorso reale
            era questo: si digita la nuova, la si ripete, POI si legge «Almeno 10
            caratteri» — e chi ne aveva scritta una di otto torna su, la cambia, e
            adesso la ripetizione non combacia più. Due campi da rifare che credeva
            finiti. I requisiti funzionavano come autopsia dell’errore, non come
            guida. Una regola che vale per un campo sta in UN posto solo, attaccata a
            quel campo — e la barra di forza è la stessa regola detta in un altro
            modo, non un secondo argomento.

            IL FONDO È CREMA, e conta: è il colore su cui vanno misurati gli
            inchiostri di questo blocco. Misurarli sul bianco della card dava numeri
            che nessuno vede mai. `ink` su crema vale 10,61:1, `green-dark` 7,98:1.

            L’ANNUNCIO È UNO SOLO. Con robustezza e requisiti nello stesso blocco,
            due regioni vive annuncerebbero due volte lo stesso gesto: il valore
            visibile della robustezza NON è `aria-live`, e la sola regione viva è la
            riga `sr-only` in fondo, che le dice entrambe.
            ═══════════════════════════════════════════════════════════════════════ */}
        {/* ⚠️ `mt-1` (4px) e `py-2.5` NON si toccano al ribasso né al rialzo senza
            rifare il conto: il distacco di 4px verso l’alto contro i 16 di `space-y-4`
            del form è il rapporto 1:4 che due critici hanno misurato e dichiarato
            risolto. Comprimere il form a `space-y-3` avrebbe recuperato 12px di altezza
            e riportato quel rapporto a 1:3, cioè avrebbe pagato un punto CHIUSO per un
            punto aperto. I 4px qui dentro (`py-3`→`py-2.5`) non toccano il rapporto. */}
        <div data-regole className="mt-1 rounded-xl bg-kidville-cream px-3 py-2.5 text-kidville-ink">
          {/* ⚠️ LA PAROLA «ROBUSTEZZA» C’È SEMPRE, anche a campo vuoto. Prima l’etichetta
              esisteva ma restava VUOTA finché non si digitava — cioè era assente proprio
              nell’istante in cui la barra si vede per la prima volta. Quattro pillole
              uguali e mute non insegnano che il linguaggio è «si riempiono»: si leggono
              come decorazione, o peggio come uno scheletro di caricamento. Il giudizio
              invece non si dà su un campo mai toccato: lì il valore è «non ancora
              valutata», che è una misura onesta e non un verdetto. */}
          <p id={idForza} className="flex flex-wrap items-baseline gap-x-1.5 font-maven text-[13px]">
            <span className="font-semibold">{t('forzaTitolo')}</span>
            <span data-forza-etichetta={livello} className="font-bold text-kidville-green-dark">
              {nuova === '' ? t('forzaNonValutata') : t(PAROLA_FORZA[livello])}
            </span>
          </p>

          {/* ── LE QUATTRO TACCHE ────────────────────────────────────────────────
              Una barra continua mente sui pixel (una password appena sufficiente e una
              ottima si somigliano), quindi si contano.

              ⚠️ LARGHE QUANTO IL CAMPO, e non è estetica. Con `w-9` misuravano
              4×36 + 3×6 di spazio = **162px** dentro un campo da 400: finivano 238px
              prima del bordo destro, e due critici indipendenti le hanno lette come un
              rendering rotto invece che come una misura. `flex-1` le fa dividere la riga.

              ⚠️ IL CONTORNO È IL DIFETTO CHE LA MISURA HA TROVATO **TRE** VOLTE, E LE
              PRIME DUE VOLTE LA DIAGNOSI ERA SBAGLIATA.
                1ª — tacche spente `bg-kidville-line` (1,23:1 sul bianco): sparivano.
                     Rimedio: un contorno `neutral`, dichiarato 3,10:1.
                2ª — sui pixel resi valeva 2,35–2,7:1. Rimedio: contorno `sub`, 5,82:1
                     sul crema e 6,46:1 sul riempimento bianco.
                3ª — 2026-09-02: due critici indipendenti misurano **2,14–2,65:1**.
                     Col token già a 5,82. Cioè: il numero non si era mosso di niente.

              LA CAUSA RADICE, misurata su `getComputedStyle` della pagina servita e non
              dedotta: `border-width: 1px` su una pillola ARROTONDATA. Sotto i 2px il
              tratto non copre un pixel intero, e ciò che arriva allo schermo non è il
              token — è il token MESCOLATO al crema. L’aritmetica lo ricostruisce esatto:
              `sub` al 50–63% di copertura vale 2,13–2,67:1, cioè la misura dei critici.

              Le prime due volte si è cercato il difetto nella TAVOLOZZA, perché è lì che
              si sapeva guardare. La tavolozza era innocente dal secondo giro: il difetto
              era la GEOMETRIA. Ora il contorno è di **2px** e la tacca è alta 10, così
              fra i due contorni restano 6px di nucleo — perché è il nucleo a dire quali
              tacche sono piene (verde su bianco: 6,51:1).

              ⚠️ IL «BINARIO PIENO» CHIESTO DAI CRITICI NON SI PUÒ FARE, ed è una misura
              e non un’opinione: `sub` (#55615C) e `green` (#006A5F) hanno luminanza quasi
              identica e distano **1,01:1**. Qualunque riempimento scuro abbastanza da
              staccarsi dal crema si avvicina al verde, e le tacche piene diventerebbero
              indistinguibili dalle vuote: si chiuderebbe 1.4.11 sul fondo aprendolo fra i
              due stati. Il nucleo resta CHIARO, e a farsi vedere è l’inchiostro.
              Lock: `__tests__/a11y/contrasto-barra-forza-password.test.ts`. */}
          <div data-tacche className="mt-1 flex w-full gap-1.5" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                data-tacca={i < livello ? 'piena' : 'vuota'}
                aria-hidden="true"
                className={`h-2.5 flex-1 rounded-pill border-2 border-kidville-sub ${i < livello ? 'bg-kidville-green' : 'bg-kidville-white'}`}
              />
            ))}
          </div>

          {/* ── I REQUISITI: una lista VIVA, non un rifiuto ─────────────────────
              Si accendono digitando, e nessuno di loro è rosso: chi sta scrivendo non
              ha ancora sbagliato niente. */}
          <p className="mt-2.5 font-maven text-[13px] font-semibold">{t('criteriTitolo')}</p>
          {/* ⚠️ L'`id` sta sull'ELENCO, non su una sola riga. È lui che il campo
              «nuova password» nomina in `aria-describedby`: chi usa uno screen reader
              deve sentire TUTTI E TRE i requisiti quando entra nel campo — cioè PRIMA
              di sbagliare — non soltanto il primo. Con l'id su una riga sola i due
              requisiti restanti esistevano solo per chi guarda. */}
          <ul id={idCriteri} data-criteri className="mt-1 space-y-0.5">
            {criteri.map((c) => (
              <li
                key={c.chiave}
                data-criterio={c.ok ? 'sì' : 'no'}
                className={`flex items-start gap-2 font-maven text-[13px] ${c.ok ? 'text-kidville-green-dark' : 'text-kidville-ink'}`}
              >
                {/* ⚠️ IL MARCATORE «DA FARE» NON È PIÙ UN CERCHIO. Un cerchio vuoto da
                    14px ha la forma esatta di un radio non selezionato, su righe di SOLA
                    LETTURA: si legge come qualcosa da premere. E il passaggio a
                    «soddisfatto» era un solo cambio di colore — il colore da solo non è
                    informazione (WCAG 1.4.1). Ora il segno cambia FORMA: un trattino
                    diventa una spunta DENTRO un cerchio, cioè una casella che si spunta.

                    ⚠️ `strokeWidth` NON È DECORAZIONE, ED È IL SECONDO CAPO DELLO STESSO
                    DIFETTO DELLE TACCHE. `lucide` disegna su un viewBox di 24 e scala a
                    `size`: a `size={15}` con lo spessore di default (2) il tratto reso
                    misurava **1,25px**. Il colore era `ink`, 10,61:1 sul crema; i critici
                    hanno misurato **2,20–2,45:1**, che è esattamente `ink` al 40–50% di
                    copertura. Un trattino più sottile di un pixel non arriva a schermo
                    col proprio colore, e nessun lock che legga hex se ne accorge.
                    Ora: 3 × 16 / 24 = **2,0px** di tratto reso, su entrambe le forme —
                    perché anche la spunta ha lo stesso problema (`green-dark` 7,98:1
                    nominale, 2,49:1 a metà copertura). La regola del blocco è una sola:
                    nessun inchiostro sotto i 2px. */}
                {c.ok ? (
                  <CheckCircle2 size={16} strokeWidth={3} aria-hidden="true" className="mt-px flex-shrink-0" />
                ) : (
                  <Minus size={16} strokeWidth={3} aria-hidden="true" className="mt-px flex-shrink-0" />
                )}
                <span>{c.testo}</span>
              </li>
            ))}
          </ul>

          {/* L’UNICA regione viva del blocco: dice la robustezza E quanti requisiti
              sono a posto, in un annuncio solo. Due `aria-live` qui dentro
              ripeterebbero due volte lo stesso gesto a ogni tasto. */}
          <p aria-live="polite" className="sr-only">
            {`${t('forzaTitolo')} ${nuova === '' ? t('forzaNonValutata') : t(PAROLA_FORZA[livello])}. ${t('criteriRiepilogo', { fatti: soddisfatti, totale: criteri.length })}`}
          </p>
        </div>
      </div>

      {campo(
        'conferma',
        t('labelConferma'),
        'new-password',
        conferma,
        setConferma,
        t('mostraConferma'),
        [],
        controllaConferma,
      )}

      {errore && (
        // L’ICONA non è un ornamento: senza, il rifiuto sarebbe affidato al colore
        // del riquadro (WCAG 1.4.1) — e chi non distingue il rosso vedrebbe una nota.
        <p
          id={idErrore}
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-kidville-error bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] leading-snug text-kidville-error-strong"
        >
          <AlertCircle size={16} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
          <span>{errore}</span>
        </p>
      )}

      {/* ⚠️ MAI `disabled`: `aria-disabled` più la guardia in cima a `invia`.
          `size="lg"` (54px) e non `md` (46): è l’azione richiesta, e deve pesare
          visibilmente più della via d’uscita che le sta accanto nell’interstiziale
          del primo accesso — dove «Non ora», a parità di larghezza e di altezza, era
          un secondo primario.

          ⚠️⚠️ IL GIALLO DI QUESTO BOTTONE NON SI «UNIFORMA» AL TOKEN DI MARCA.
          Misurato in pagina il 2026-09-02: l’inchiostro è `#FFDA5C`
          (`--color-kidville-yellow-ink`) su `#006A5F`, cioè **4,78:1** — passa AA.
          Il giallo di marca `#FDC400` sullo stesso verde vale **4,05:1** e NON passa:
          nessuna delle taglie di `ui/Btn` arriva ai 18,66px del «testo grande», quindi
          la soglia applicabile è 4,5:1 e non 3:1. È la pulizia che sembra ovvia — «qui
          c’è un giallo che non è il token di marca, allineiamolo» — e che romperebbe
          una cosa che funziona, in silenzio e su tutta l’app. Il perché sta scritto in
          `src/components/ui/Btn.tsx`; il divieto è un lock con controllo positivo che
          misura proprio 4,05 — `__tests__/a11y/contrasto-cascata.test.tsx` (§2). */}
      <Btn type="submit" variant="primary" size="lg" className="w-full" aria-disabled={invio} aria-busy={invio}>
        {invio && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        {invio ? t('salvataggio') : t('salva')}
      </Btn>
    </form>
  )
}
