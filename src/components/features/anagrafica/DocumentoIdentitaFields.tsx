'use client'

import type { ReactElement } from 'react'
import { useTranslations } from 'next-intl'
import { useMessaggioCampo } from '@/components/features/forms/messaggio-campo'
import {
  Controller, useWatch,
  type Control, type FieldErrors, type FieldValues, type UseFormRegister,
} from 'react-hook-form'
import { AlertTriangle, CalendarClock } from 'lucide-react'
import {
  FieldRenderer, FIELD_BASE, FIELD_BASE_ERRORE,
} from '@/components/features/forms/FieldRenderer'
import { DateField } from '@/components/ui/DateField'
import { PERSONALE_FIELDS } from '@/lib/forms/personale-template'
import { validateField } from '@/lib/forms/validate-fields'
import { statoScadenza, type StatoScadenza } from '@/lib/anagrafica/scadenze'
import { isoToIt } from '@/lib/format/data'
import type { FormField } from '@/types/database.types'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  IL DOCUMENTO D'IDENTITÀ — cinque campi che stanno insieme per forza     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Fratello di `LuogoNascitaFields`: quello tiene insieme i quattro campi da cui
 * si ricava il codice fiscale, questo i cinque che descrivono il documento —
 * tipo, numero, SCADENZA e le DUE facce (fronte e retro, dal 12/08/2026: prima
 * era una scansione sola). Stanno in un componente solo perché uno di essi
 * (`document_expiry`) cambia ciò che si legge accanto agli altri, e perché la
 * data di scadenza è l'unica colonna che il cron notturno interroga: un modulo
 * che la raccoglie senza dire niente a chi la scrive è un modulo che manda un
 * allarme a una persona che non sapeva di averlo acceso.
 *
 * Il numero è cambiato, la ragione dello stare insieme no — e il retro è
 * obbligatorio per TUTTI E TRE i tipi di documento: il perché, per esteso, è
 * accanto ai due campi in `personale-template.ts`.
 *
 * ── ⚠️ DEBITO DICHIARATO: PERCHÉ LA SCADENZA NON PASSA DA `FieldRenderer` ────
 *
 * `document_expiry` è dichiarato `type: 'date'` nel template, e la branca `date`
 * di `FieldRenderer` (riga 465) rende un `<input type="date">` NATIVO. Quello è
 * esattamente il difetto per cui `DateField` esiste, ed è scritto nella sua
 * testata: il selettore nativo mostra il formato del LOCALE DI SISTEMA, cioè
 * `mm/dd/yyyy` su un telefono configurato in inglese — e su questo campo un
 * giorno e un mese scambiati non producono un errore, producono una data valida
 * e sbagliata. `12/06/2027` letto all'americana è il 6 dicembre invece del 12
 * giugno: sei mesi di differenza su una scadenza, cioè un preavviso che parte
 * quando non serve più.
 *
 * Perciò QUI la scadenza è resa con `DateField` (maschera `gg/mm/aaaa`
 * deterministica, ISO in uscita) e NON con `FieldRenderer`. Il debito è che le
 * due strade esistono entrambe: ogni altro campo `date` del repo — la data di
 * nascita di questo stesso modulo compresa — continua a passare dalla branca
 * nativa. Si chiude portando quella branca a `DateField` una volta sola, e
 * quando si farà questo file dovrà tornare a usare `FieldRenderer` come gli
 * altri. Finché non si fa, la deroga vale per il campo su cui il danno è
 * misurabile, non per tutti.
 *
 * ── ⚠️ DEBITO DICHIARATO: LE TRE RIGHE DI AIUTO SONO TESTO, NON DESCRIZIONI ──
 *
 * La nota comune e le due righe per lato sono `<p>` visibili e basta: nessuna è
 * agganciata al proprio campo con `aria-describedby`, quindi chi usa uno screen
 * reader sente «Retro del documento, campo file» e non sente qual è la pagina da
 * fotografare. Non è un difetto introdotto qui — la nota era già così quando la
 * scansione era una sola — ma con due campi la distanza fra ciò che si vede e ciò
 * che si sente raddoppia, e va scritto invece che taciuto.
 *
 * ⚠️ E DAL 25/08/2026 SI CHIUDE PROPRIO DA QUESTO FILE — fino a stamattina queste
 * righe dicevano il contrario, ed è la parte che vale più della frase. Dicevano
 * che «`FieldRenderer` costruisce `aria-describedby` per conto suo e lo valorizza
 * SOLO in errore, senza accettare descrittori aggiuntivi», e che il debito si
 * chiudesse «aggiungendo quel prop a `FieldRenderer` una volta sola». Quel prop è
 * stato aggiunto il 24/08 e si chiama `nota`: il componente ne deriva l'`id`
 * (`<campo>-nota`), rende il `<p>` sotto il campo e CONCATENA `aria-describedby` —
 * prima l'errore, poi la nota. Il debito era già chiuso dal commit che qui lo dava
 * per aperto, e la frase è sopravvissuta in QUATTRO copie nate da un copia-incolla
 * (due qui e nel wizard, due già corrette in `CandidaturaInsegnanteWizard`).
 *
 * Resta aperto solo il lavoro, non la strada: le tre righe qui sotto sono ancora
 * `<p>` muti, e si agganciano passando `nota={t('persDocFronteAiuto')}` (e le altre
 * due) ai `FieldRenderer` delle due facce, togliendo i `<p>` scritti a mano. Non è
 * stato fatto in questo passaggio perché cambia ciò che uno screen reader annuncia
 * su due campi di un modulo fuori dal perimetro di questo lavoro, e va misurato.
 *
 * ⚠️ E NON È PIÙ «la stessa ragione per cui il codice fiscale non passa da lì»:
 * quella, dal 25/08, è la FORMA del badge di coerenza — un `<div role="status">`
 * con un bottone dentro, che compare solo quando ha qualcosa da dire — non
 * l'assenza del prop. Vedi l'intestazione di `ID_CF` nel wizard.
 *
 * La scadenza qui accanto la descrizione ce l'ha, perché è l'unico campo che non
 * passa da `FieldRenderer`: è la prova che la strada funziona, non un'incoerenza.
 *
 * ── ⚠️ E LA SCADENZA PASSATA NON BLOCCA NIENTE ──────────────────────────────
 *
 * Il riquadro rosso è `role="status"` e non `role="alert"`, e non è una
 * sfumatura: `alert` è l'annuncio che qualcosa è andato storto e va corretto
 * PRIMA di proseguire, e qui non c'è niente da correggere. Chi ha il documento
 * scaduto è esattamente la persona per cui questo modulo esiste
 * (`personale-template.ts`, righe 210-212): bloccarla significherebbe lasciare
 * la Segreteria senza nemmeno il suo nome. Il modulo lo dice, lo ripete sopra il
 * bottone d'invio, e va avanti.
 */

/** Gli `id` dei cinque campi, come li dichiara il template. */
const ID_TIPO = 'document_type'
const ID_NUMERO = 'document_number'
const ID_SCADENZA = 'document_expiry'
const ID_ALLEGATO_FRONTE = 'documento_fronte_path'
const ID_ALLEGATO_RETRO = 'documento_retro_path'

/**
 * Il campo del template, oppure un'eccezione ALL'IMPORT.
 *
 * ⚠️ Il lancio è deliberato, ed è la scelta meno peggiore delle due. Un `find`
 * che restituisce `undefined` porterebbe a NON RENDERE un campo obbligatorio, e
 * un campo obbligatorio non reso non è «un campo in meno»: è `validatePage` che
 * sul server lo trova vuoto a ogni invio, cioè un modulo che non si può
 * compilare — per chiunque, per sempre, in silenzio. Se domani qualcuno rinomina
 * `document_expiry` nel template, questo file smette di caricarsi e la cosa si
 * vede al primo `npm run build`, non in produzione.
 */
function campoDelTemplate(id: string): FormField {
  const f = PERSONALE_FIELDS.find((c) => c.id === id)
  if (!f) {
    throw new Error(
      `DocumentoIdentitaFields: «${id}» non è più in PERSONALE_FIELDS. ` +
        'Il campo si legge dal template, non si ribatte qui: se è stato rinominato, ' +
        'aggiorna la costante in questo file (e il wizard che lo monta).',
    )
  }
  return f
}

const CAMPO_TIPO = campoDelTemplate(ID_TIPO)
const CAMPO_NUMERO = campoDelTemplate(ID_NUMERO)
const CAMPO_SCADENZA = campoDelTemplate(ID_SCADENZA)
// ⚠️ DUE chiamate, non una: il lancio all'import vale per ENTRAMBE le facce. Un
// rinomino del solo retro nel template lascerebbe altrimenti in pagina un campo
// obbligatorio non reso — cioè un modulo che il server rifiuta a ogni invio, in
// silenzio. Con questa riga si rompe il build, che è il posto giusto.
const CAMPO_ALLEGATO_FRONTE = campoDelTemplate(ID_ALLEGATO_FRONTE)
const CAMPO_ALLEGATO_RETRO = campoDelTemplate(ID_ALLEGATO_RETRO)

/**
 * I cinque campi nell'ordine in cui si compilano.
 *
 * ⚠️ NON è solo l'ordine a schermo: da questa lista il wizard deriva `IDS_DOCUMENTO`,
 * i campi che il passo valida, quelli che finiscono nel corpo del POST e le righe del
 * riepilogo — nessuno dei quattro è scritto a mano da nessuna parte. Aggiungere una
 * voce qui la fa comparire in tutti e quattro; l'ORDINE conta perché è anche quello in
 * cui il wizard cerca «il primo campo mancante» per portarci il fuoco, e quel primo
 * dev'essere il primo che si incontra scendendo.
 */
export const CAMPI_DOCUMENTO: FormField[] = [
  CAMPO_TIPO,
  CAMPO_NUMERO,
  CAMPO_SCADENZA,
  CAMPO_ALLEGATO_FRONTE,
  CAMPO_ALLEGATO_RETRO,
]

/**
 * `idPrefisso` arriva anche come percorso di react-hook-form: un punto dentro un
 * `id` è legale in HTML e velenoso in ogni selettore CSS. Stessa riduzione di
 * `LuogoNascitaFields`.
 */
function idSicuro(prefisso: string): string {
  const ridotto = prefisso.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return ridotto === '' ? 'documento' : ridotto
}

/** Gli `id` che DESCRIVONO un campo, uniti con uno spazio; `undefined` se non ce n'è. */
function descrittori(...ids: (string | false | undefined)[]): string | undefined {
  const usati = ids.filter((x): x is string => typeof x === 'string' && x !== '')
  return usati.length > 0 ? usati.join(' ') : undefined
}

/**
 * `true` quando `<AvvisoScadenzaDocumento />` renderà davvero qualcosa.
 *
 * Stessa disciplina di `badgeHaQualcosaDaDire`: la condizione vive in un posto
 * solo, e chi deve decidere un `aria-describedby` la chiede invece di
 * riscriverla. Un `aria-describedby` che punta a un elemento inesistente è un
 * riferimento rotto — lo screen reader annuncia un campo che rimanda a una
 * descrizione che non c'è.
 */
export function avvisoScadenzaDaDire(
  stato: StatoScadenza,
): stato is Extract<StatoScadenza, { stato: 'scaduto' | 'in-scadenza' }> {
  return stato.stato === 'scaduto' || stato.stato === 'in-scadenza'
}

/**
 * IL RIQUADRO CHE PARLA DELLA SCADENZA — e che si monta DUE VOLTE.
 *
 * Una accanto al campo, mentre la data si scrive; una nel riepilogo, sopra il
 * bottone d'invio. Non sono due riquadri: è lo stesso componente, montato due
 * volte, e la ragione è la stessa per cui il riepilogo si costruisce dai campi
 * del template — due formulazioni della stessa avvertenza divergono alla prima
 * modifica, e a divergere sarebbe ciò che una persona legge nell'unico punto in
 * cui rilegge prima di consegnare.
 *
 * `role="status"` e non `alert`: vedi la testata del file. Il colore non porta
 * l'informazione da solo — c'è un'icona, e il testo dice tutto per esteso.
 */
export function AvvisoScadenzaDocumento({
  scadenzaISO,
  oggi,
  id,
}: {
  /** La data di scadenza in ISO (`YYYY-MM-DD`), com'è nel modulo. */
  scadenzaISO: string
  /** Il giorno civile italiano, INIETTATO: vedi la regola 1 di `scadenze.ts`. */
  oggi: string
  /** L'`id` del riquadro, per chi lo aggancia con `aria-describedby`. */
  id?: string
}): ReactElement | null {
  const t = useTranslations('public')
  const stato = statoScadenza(scadenzaISO, oggi)
  if (!avvisoScadenzaDaDire(stato)) return null

  const data = isoToIt(scadenzaISO)
  const scaduto = stato.stato === 'scaduto'

  return (
    <div
      id={id}
      role="status"
      className={`flex items-start gap-2 rounded-card border px-4 py-3 ${
        scaduto
          ? 'border-kidville-error bg-kidville-error-soft'
          : 'border-kidville-warn bg-kidville-warn-soft'
      }`}
    >
      {scaduto ? (
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-kidville-error-strong"
          aria-hidden="true"
        />
      ) : (
        <CalendarClock
          className="mt-0.5 h-4 w-4 shrink-0 text-kidville-warn-strong"
          aria-hidden="true"
        />
      )}
      <p
        className={`text-xs font-semibold leading-relaxed ${
          scaduto ? 'text-kidville-error-strong' : 'text-kidville-warn-strong'
        }`}
      >
        {scaduto
          ? t('persDocScaduto', { data })
          : t('persDocInScadenza', { giorni: stato.giorni, data })}
      </p>
    </div>
  )
}

/**
 * `DateField` è una funzione componente che spande `...rest` sull'`<input>`: in
 * React 19 il `ref` arriva fra i props e da lì finisce sul nodo vero. Il tipo dei
 * suoi props non lo dichiara, e senza questo alias `setFocus('document_expiry')`
 * non troverebbe niente da mettere a fuoco — cioè chi preme «Avanti» da tastiera
 * con la scadenza vuota resterebbe sul bottone, che è precisamente il difetto che
 * `FieldRenderer` ha chiuso l'11/08/2026 aggiungendo `ref={rhf.ref}` dentro i
 * propri `Controller`.
 *
 * L'alias sta QUI e non in `DateField.tsx` perché quel file è condiviso con la
 * modulistica in-app e non è il perimetro di questo intervento: il giorno in cui
 * `DateFieldProps` dichiarerà il `ref`, questa riga si cancella e non cambia
 * nient'altro.
 */
const CampoData = DateField as unknown as (
  props: React.ComponentProps<typeof DateField> & { ref?: React.Ref<HTMLInputElement> },
) => ReactElement

export function DocumentoIdentitaFields({
  register,
  control,
  errori,
  idPrefisso,
  oggi,
  uploadEndpoint,
  modelId,
}: {
  register: UseFormRegister<FieldValues>
  control: Control<FieldValues>
  /** Gli errori del modulo: gli stessi che il wizard passa a `FieldRenderer`. */
  errori: FieldErrors<FieldValues>
  /** Radice degli `id` che questo blocco crea da sé (aiuto e avviso). */
  idPrefisso: string
  /** Il giorno civile italiano, INIETTATO: vedi la regola 1 di `scadenze.ts`. */
  oggi: string
  /** Dove va caricata la scansione. Sul modulo pubblico del personale è la sua rotta. */
  uploadEndpoint: string
  /** La cartella logica passata al caricamento (il `folder` di `FileField`). */
  modelId: string
}): ReactElement {
  const t = useTranslations('public')
  const messaggioCampo = useMessaggioCampo()

  const radice = idSicuro(idPrefisso)
  const idScadenza = `${radice}-scadenza`
  const idAiutoScadenza = `${idScadenza}-aiuto`
  const idErroreScadenza = `${idScadenza}-errore`
  const idAvviso = `${radice}-avviso-scadenza`

  const scadenza = useWatch({ control, name: ID_SCADENZA })
  const scadenzaISO = typeof scadenza === 'string' ? scadenza : ''
  const avvisoInPagina = avvisoScadenzaDaDire(statoScadenza(scadenzaISO, oggi))

  /*
   * La SCADENZA è resa a mano (vedi la testata), quindi la sua traduzione non la
   * fa `FieldRenderer`: la mappatura costante → catalogo è una sola e sta in
   * `messaggio-campo.ts`. Senza questa riga, su una pagina inglese comparirebbe
   * «Campo obbligatorio» — è il difetto misurato il 25/08 sul codice fiscale di
   * `/anagrafica-personale`.
   */
  const erroreScadenza = messaggioCampo(errori[ID_SCADENZA])

  return (
    <div className="space-y-6">
      {/* Tipo e numero: campi ordinari, resi dal componente di sempre — che porta
          con sé etichetta associata, `aria-invalid`, il messaggio d'errore e le
          classi del campo. Ribattere qui una `<select>` significherebbe ricopiare
          quattro cose per non guadagnarne nessuna. */}
      <FieldRenderer
        field={CAMPO_TIPO}
        modelId={modelId}
        register={register}
        control={control}
        error={errori[ID_TIPO]}
      />
      <FieldRenderer
        field={CAMPO_NUMERO}
        modelId={modelId}
        register={register}
        control={control}
        error={errori[ID_NUMERO]}
      />

      {/* La SCADENZA — l'unica che non passa da `FieldRenderer`: vedi la testata. */}
      <div className="space-y-2">
        <label
          htmlFor={idScadenza}
          className="flex items-center gap-1.5 text-sm font-medium text-kidville-green/80"
        >
          {CAMPO_SCADENZA.label}
          {CAMPO_SCADENZA.required && <span className="text-kidville-green">*</span>}
        </label>
        <Controller
          name={ID_SCADENZA}
          control={control}
          defaultValue=""
          rules={{ validate: (v: unknown) => validateField(CAMPO_SCADENZA, v) ?? true }}
          render={({ field: rhf }) => (
            <CampoData
              id={idScadenza}
              name={rhf.name}
              ref={rhf.ref}
              value={typeof rhf.value === 'string' ? rhf.value : ''}
              onChange={rhf.onChange}
              className={erroreScadenza ? FIELD_BASE_ERRORE : FIELD_BASE}
              /* Il formato vive FUORI dal segnaposto: il segnaposto sparisce al
                 primo carattere digitato, e chi sbaglia non ha più modo di sapere
                 qual era. L'avviso di scadenza si aggancia solo quando c'è
                 davvero: un `aria-describedby` che punta al vuoto è un
                 riferimento rotto. */
              aria-describedby={descrittori(
                idAiutoScadenza,
                erroreScadenza ? idErroreScadenza : undefined,
                avvisoInPagina ? idAvviso : undefined,
              )}
              aria-invalid={erroreScadenza ? true : undefined}
              /* ⚠️ L'OBBLIGO ANCHE A CHI ASCOLTA. `FieldRenderer` dal 25/08 lo
                 emette per ogni campo `required` che rende; questo è l'unico dei
                 cinque che non passa di lì (vedi il debito dichiarato in testa),
                 quindi la riga va scritta a mano — ed è il motivo per cui il passo
                 «Documento» aveva CINQUE asterischi e QUATTRO dichiarazioni.
                 `|| undefined` e non `|| false`, per la stessa ragione scritta in
                 `FieldRenderer`: `aria-required="false"` sui facoltativi è rumore.
                 `DateField` spande i props sull'`<input>` vero, quindi l'attributo
                 arriva sul nodo, non sul contenitore. */
              aria-required={CAMPO_SCADENZA.required || undefined}
            />
          )}
        />
        <p id={idAiutoScadenza} className="text-xs text-kidville-sub">
          {t('persDocScadenzaAiuto')}
        </p>
        {erroreScadenza && (
          <p
            id={idErroreScadenza}
            role="alert"
            className="flex items-center gap-1.5 text-xs font-bold text-kidville-error-strong"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {erroreScadenza}
          </p>
        )}
        <AvvisoScadenzaDocumento scadenzaISO={scadenzaISO} oggi={oggi} id={idAvviso} />
      </div>

      {/* LE DUE SCANSIONI. `uploadEndpoint` le manda alla rotta del personale,
          che scrive nel bucket privato `documenti_personale` — separato da
          `form_attachments`, che custodisce i documenti dei minori. `accept` e
          tetto arrivano dal TEMPLATE attraverso `FieldRenderer`: scriverli qui
          sarebbe la seconda lista da tenere allineata al bucket.

          ⚠️ LA NOTA STA SOPRA LA COPPIA, E UNA VOLTA SOLA. Vale identica per le
          due facce (è la stessa `accept`, lo stesso tetto, lo stesso bucket):
          ripeterla sotto ciascuna raddoppierebbe novantadue caratteri di prosa
          senza aggiungere un'informazione, e su un passo che si compila col
          telefono in mano la seconda copia non si legge — si scavalca, e con lei
          si scavalca la prima. Ciò che invece CAMBIA fra fronte e retro è che
          cosa si deve vedere nella foto, e quello sta sotto il campo giusto. */}
      <div className="space-y-6">
        <p className="max-w-[26rem] text-xs text-kidville-sub">{t('persDocAllegatoNota')}</p>

        <div className="space-y-2">
          <FieldRenderer
            field={CAMPO_ALLEGATO_FRONTE}
            modelId={modelId}
            register={register}
            control={control}
            error={errori[ID_ALLEGATO_FRONTE]}
            uploadEndpoint={uploadEndpoint}
          />
          {/* ⚠️ IL TETTO DI LARGHEZZA — MISURATO, non stimato (12/08/2026).
              Senza, «Va bene un PDF oppure una foto…» stava su **92 caratteri
              per riga, costanti da 640 a 1440 px** (`Range` sui nodi di testo,
              carattere per carattere). È la riga che dice cosa caricare a chi ha
              in mano un telefono e un documento, e a 12 px una riga da 92
              caratteri è oltre il punto in cui l'occhio ritrova il capo della
              successiva. 26rem = 416 px = 75 caratteri, la stessa misura già
              fatta su questa pagina per il banner del documento — e in rem,
              perché `ch` è la larghezza dello ZERO e prometterebbe un numero
              diverso da quello che rende. Le righe di aiuto per lato sono più
              corte, e portano lo stesso tetto per non introdurre una seconda
              colonna di testo accanto alla prima. */}
          <p className="max-w-[26rem] text-xs text-kidville-sub">{t('persDocFronteAiuto')}</p>
        </div>

        <div className="space-y-2">
          <FieldRenderer
            field={CAMPO_ALLEGATO_RETRO}
            modelId={modelId}
            register={register}
            control={control}
            error={errori[ID_ALLEGATO_RETRO]}
            uploadEndpoint={uploadEndpoint}
          />
          {/* Il retro è obbligatorio anche sul passaporto, e chi ha in mano un
              passaporto è la persona che ha più motivo di credere il contrario:
              questa riga dice quale pagina fotografare invece di lasciarglielo
              indovinare davanti a un campo che non passa. */}
          <p className="max-w-[26rem] text-xs text-kidville-sub">{t('persDocRetroAiuto')}</p>
        </div>
      </div>
    </div>
  )
}
