'use client'

import { AlertCircle, AlertTriangle, Calculator } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { btnClass } from '@/components/ui/Btn'
import type { CampoNonVerificabile, EsitoCoerenza, MotivoIncoerenza } from '@/lib/fiscale/coerenza'
import { SCARTO_FEMMINA } from '@/lib/fiscale/tabelle'
import { validaCodiceFiscale } from '@/lib/fiscale/validazione'
import { cx } from '@/lib/ui/cx'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * BADGE DI COERENZA DEL CODICE FISCALE — la segnalazione CHE NON BLOCCA.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─── LA DECISIONE, PRIMA DEL CODICE ─────────────────────────────────────────
 * Che questo componente **non blocchi il salvataggio** è una decisione del
 * titolare, non un ripiego tecnico. Perciò: lo schema zod dei form non cambia,
 * l'esito non entra mai in `setErrors`, e da qui non esce mai un `disabled` verso
 * il bottone Salva. Non è una promessa scritta in un commento — è DIMOSTRATA da
 * `__tests__/components/BadgeCoerenzaCf.test.tsx`, che monta un form finto col
 * badge rosso e misura che il Salva sia abilitato e che la fetch di salvataggio
 * parta davvero.
 *
 * ─── I TRE STATI, E PERCHÉ NON POSSONO DIVENTARE DUE ────────────────────────
 * Misurato in produzione l'11 agosto: su 33 alunni **18 non hanno il codice
 * fiscale**, 18 non hanno il comune di nascita, 17 non hanno il sesso; su 50
 * genitori **27 non hanno il codice fiscale**. Se «manca un dato» e «i dati si
 * contraddicono» finissero nello stesso rosso, metà archivio diventerebbe rosso
 * il primo giorno — e da quel momento il pannello smetterebbe di essere guardato,
 * comprese le poche righe in cui c'è davvero un errore.
 *
 *   · 🔴 **INCOERENTE** (`motivi` non vuoto) — c'è una contraddizione DIMOSTRATA
 *     fra il codice e l'anagrafica, oppure il codice è scritto male. Azionabile.
 *   · 🟡 **NON VERIFICABILE** (solo `nonVerificabili`, col codice presente) —
 *     quello che si poteva confrontare torna, il resto non c'era. È uno stato
 *     legittimo, non un allarme.
 *   · ⚪️ **DA COMPILARE** (`codiceEsaminato === ''`) — non c'è niente da
 *     verificare. Qui il componente **non dipinge niente**: al massimo, se
 *     l'anagrafica basta a calcolare il codice, offre la riga «Codice calcolato
 *     dai dati» e il bottone. Sono i 18 bambini su 33: un giallo su ciascuno di
 *     loro sarebbe esattamente il pannello che nessuno guarda più.
 *
 * ─── LA VARIANTE «COMPATTA» NON C'È PIÙ, ED È UNA MISURA, NON UN GUSTO ──────
 * Questo componente ha avuto per un giorno un ramo `compatto`: una pillola da
 * tabella, con le ragioni in `sr-only`. Aveva due test, entrambi verdi, e nessun
 * chiamante: `grep -rn 'compatto' src/` trova solo il `SedeSelector` di
 * `cockpit.tsx`, che è un'altra cosa. La tabella per cui era stato pensato è stata
 * scritta davvero — `CodiciFiscaliDaVerificare.tsx` — e NON monta questo
 * componente: dipinge la propria pillola, con i propri cataloghi (`MOTIVO`,
 * `MANCANTE`) e il proprio aspetto. Cioè il consumatore previsto esiste e ha
 * scelto un'altra strada.
 *
 * Un ramo di prodotto che nessuno rende è verde nella suite e assente sullo
 * schermo: la copertura dice «misurato» di una cosa che l'utente non incassa. È
 * stato tolto insieme ai suoi test e alle sue due chiavi di catalogo. Se un giorno
 * la tabella vorrà questo badge, il ramo si riscrive in dieci righe — e allora i
 * tre stati si misureranno DENTRO la tabella, che è il posto dove rischiano
 * davvero di collassare in una pillola colorata e muta.
 *
 * ─── PERCHÉ `role="status"` E NON `role="alert"` ────────────────────────────
 * Non è un errore di compilazione — il modulo si può inviare così com'è. È
 * un'osservazione sui dati, e `alert` interromperebbe uno screen reader nel mezzo
 * di ciò che l'utente sta scrivendo per dirgli qualcosa che non gli impedisce
 * niente. Il colore, per la stessa ragione, non è mai l'unica differenza: ogni
 * stato porta la propria ICONA e il proprio TESTO.
 *
 * ─── ⚠️ IL `role="status"` QUI NON PROMETTE UN ANNUNCIO ─────────────────────
 * Va detto, perché il contrario è la cosa che si dà per scontata: questo riquadro
 * **nasce insieme al proprio contenuto** (quando non c'è niente da dire il
 * componente restituisce `null`), e una regione `aria-live` creata insieme al
 * testo che dovrebbe annunciare, di norma, non annuncia niente — va osservata
 * PRIMA. È la stessa ragione per cui in `Combobox` la regione del conteggio esiste
 * da subito e resta vuota.
 *
 * Qui la scelta è DELIBERATAMENTE l'opposta, e non per svista. `esito` lo
 * ricalcola il chiamante a ogni battuta sul campo del codice fiscale (`useMemo`
 * sul valore del campo, in tutti e sei i punti di montaggio). Una regione
 * persistente parlerebbe a OGNI carattere digitato — «non è lungo sedici
 * caratteri», «la checksum non torna», «il codice dice femmina» — cioè sopra
 * l'eco di ciò che l'utente sta scrivendo. Che il contenuto cambi davvero a ogni
 * battuta è MISURATO in §4, non supposto.
 *
 * **La via dichiarata per sentire questo testo è `aria-describedby`**: il campo
 * del codice fiscale punta all'`id` del badge (per questo l'`id` esiste ed è
 * stabile), e chi legge con uno screen reader riceve la descrizione quando arriva
 * sul campo o quando ci torna — al momento giusto, una volta sola. Quel
 * collegamento è misurato in §5, ed è l'unica promessa d'accessibilità che questo
 * file fa. `role="status"` resta perché è il ruolo semanticamente esatto per
 * un'osservazione non bloccante, non perché garantisca un annuncio.
 *
 * ⚠️ E QUEL COLLEGAMENTO È CONDIZIONALE, perché questo componente può restituire
 * `null`. Fino all'11 agosto i chiamanti scrivevano `aria-describedby` sempre: sui
 * record in cui il badge non compare — la maggioranza, vedi `badgeHaQualcosaDaDire`
 * qui sotto — il campo rimandava a un elemento che non esiste. Chi monta il badge
 * chiede al predicato se c'è, invece di darlo per scontato.
 *
 * ─── ⚠️ «NON VERIFICABILE» DEVE NOMINARE IL DATO CHE MANCA DAVVERO ─────────
 * Il giallo del luogo di nascita ha detto il falso, e vale la pena scrivere come.
 * `coerenza.ts` mette `luogo-nascita` fra i `nonVerificabili` quando manca il
 * CODICE CATASTALE (`normalizzaCodiceBelfiore(anagrafica.codiceBelfiore)` è
 * `null`) — non quando manca il comune, che quella funzione non legge nemmeno. La
 * frase però diceva «manca il comune di nascita», e in produzione il comune c'era:
 * 36 record su 83 (14 alunni + 22 genitori, MISURATO l'11 agosto) hanno il codice
 * fiscale, hanno il comune scritto e hanno `codice_belfiore_nascita` NULL, perché
 * la migrazione che ha creato la colonna non fa backfill. Su quei record
 * `LuogoNascitaFields` risolve il comune per nome e lo mostra scelto, senza
 * avvisi: due sezioni dello stesso pannello dicevano due cose opposte sulla stessa
 * persona, e quella sbagliata era questa.
 *
 * Adesso `cfMancaLuogoNascita` nomina il codice catastale — l'unica cosa che si è
 * davvero misurata — e dice l'azione che lo spegne: riscegliere il comune
 * dall'elenco, che è l'`onChange` in cui il Belfiore viene scritto. Vale identica
 * anche sui 18 alunni senza alcun comune: là manca pure quello, ma ciò che
 * impedisce il confronto resta il codice, e l'azione è la stessa.
 *
 * La regola generale, per chi aggiungerà un `CampoNonVerificabile`: **la frase
 * nomina il campo che il confronto ha cercato**, non quello che gli somiglia sullo
 * schermo. Una frase che nomina il campo sbagliato non è un dettaglio di stile: è
 * un utente che cerca per dieci minuti un dato che c'è già.
 *
 * ─── L'OMOCODIA NON È UN ERRORE, E NON SI «CORREGGE» ────────────────────────
 * Un codice omocodico (lettere al posto di alcune cifre) l'ha assegnato l'Agenzia
 * quando due persone sono collise: è legittimo, ed è DIVERSO dal codice calcolato
 * dai dati. Per questo la proposta «Usa questo» compare **solo** quando c'è
 * un'incoerenza o quando il campo è vuoto — mai su un codice che risulta coerente.
 * Senza questa condizione, ogni omocodico si vedrebbe proporre la sostituzione
 * del proprio codice vero con uno che l'Agenzia non gli ha mai dato.
 */

interface BadgeCoerenzaCfProps {
  esito: EsitoCoerenza
  /**
   * Chiamato dal bottone «Usa questo». Il contratto è: **compila il campo e nulla
   * più**. Se un chiamante ci mettesse dentro un salvataggio, romperebbe la
   * decisione scritta in cima a questo file.
   */
  onUsaCalcolato?: (codice: string) => void
  /**
   * ⚠️ AGGIUNTA alla firma concordata, e la ragione è l'accessibilità: il campo
   * del codice fiscale deve poter puntare qui con `aria-describedby`, e senza un
   * `id` stabile non ha niente a cui puntare. È opzionale, quindi chi monta il
   * componente senza conoscerla ottiene comunque un id valido.
   */
  id?: string
}

/** L'id di default: stabile, così `aria-describedby` funziona anche senza passare `id`. */
export const ID_BADGE_COERENZA_CF = 'badge-coerenza-cf'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * QUANDO IL BADGE C'È — la regola in UN POSTO SOLO, perché la terza copia diverge.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Questo componente restituisce `null` quando non ha niente da dire, ed è la
 * risposta giusta (vedi lo stato ⚪️ DA COMPILARE in cima). Ma i sei chiamanti
 * puntano al suo `id` con `aria-describedby` dal campo del codice fiscale, e un
 * `aria-describedby` che punta a un elemento INESISTENTE non è una sfumatura: lo
 * screen reader annuncia un campo che rimanda a una descrizione che non c'è.
 *
 * ⚠️ E NON È IL CASO RARO, È QUELLO COMUNE. Misurato in produzione l'11 agosto: su
 * 33 alunni **18 non hanno il codice fiscale** e **17 non hanno il sesso**, e
 * `codice_belfiore_nascita` è NULL su **83 record su 83**. Senza sesso e senza
 * codice catastale `codiceAtteso` è `null`, quindi non c'è nemmeno la proposta: il
 * badge non compare. Cioè lo stato in cui il collegamento pendeva nel vuoto era lo
 * stato ORDINARIO dell'archivio, non l'eccezione.
 *
 * La condizione vive qui e SOLO qui: `statoBadge` la calcola, il render la consuma,
 * e i chiamanti chiedono `badgeHaQualcosaDaDire()` invece di riscriverla. Tre copie
 * della stessa regola sono tre occasioni di divergere, e la terza è sempre quella
 * che resta indietro.
 */
interface StatoBadge {
  /** Contraddizione dimostrata, o codice scritto male. */
  rosso: boolean
  /** C'è un codice, torna quello che si poteva confrontare, il resto non c'era. */
  giallo: boolean
  /** Il codice che l'anagrafica implica, quando ha senso proporlo. */
  codiceProposto: string | null
  /** C'è una proposta da mostrare, e differisce da ciò che è già scritto. */
  proposta: boolean
}

function statoBadge(esito: EsitoCoerenza): StatoBadge {
  const rosso = esito.motivi.length > 0
  const daCompilare = esito.codiceEsaminato === ''
  const giallo = !rosso && !daCompilare && esito.nonVerificabili.length > 0

  /**
   * La proposta si mostra SOLO dove è sensata: c'è una contraddizione da sanare,
   * oppure il campo è vuoto. Vedi il blocco sull'omocodia in cima.
   */
  const codiceProposto = rosso || daCompilare ? esito.codiceAtteso : null
  const proposta = codiceProposto !== null && codiceProposto !== esito.codiceEsaminato

  return { rosso, giallo, codiceProposto, proposta }
}

/**
 * `true` quando `<BadgeCoerenzaCf esito={…} />` renderà davvero un elemento.
 *
 * Serve ai chiamanti per decidere se il campo del codice fiscale può puntare al
 * badge: `aria-describedby={badgeHaQualcosaDaDire(esito) ? idBadgeCf : undefined}`.
 * È una funzione pura sull'esito — nessuno stato, nessun DOM da interrogare — così
 * la decisione si prende PRIMA del render, non dopo averlo guardato.
 */
export function badgeHaQualcosaDaDire(esito: EsitoCoerenza): boolean {
  const { rosso, giallo, proposta } = statoBadge(esito)
  return rosso || giallo || proposta
}

/**
 * Il sesso che il CODICE dichiara, o `null` se non si riesce a leggerlo.
 *
 * Si passa da `validaCodiceFiscale` invece di leggere direttamente le posizioni
 * 10-11: su un codice omocodico quelle due posizioni possono portare LETTERE, e
 * `Number('L1')` è `NaN`. `baseSenzaOmocodia` le riporta a cifra.
 *
 * Serve a una cosa sola: trasformare «il sesso non corrisponde» — che non dice
 * quale sia il problema — in «il codice dice femmina, l'anagrafica dice maschio».
 * La direzione è deducibile senza avere l'anagrafica sotto mano proprio perché
 * `motivi` contiene `sesso`: se il codice dice F, l'anagrafica dice M.
 */
function sessoScrittoNelCodice(codice: string): 'M' | 'F' | null {
  const base = validaCodiceFiscale(codice).baseSenzaOmocodia
  if (base === null) return null
  const giorno = Number(base.slice(9, 11))
  if (!Number.isFinite(giorno)) return null
  return giorno > SCARTO_FEMMINA ? 'F' : 'M'
}

export function BadgeCoerenzaCf({
  esito,
  onUsaCalcolato,
  id = ID_BADGE_COERENZA_CF,
}: BadgeCoerenzaCfProps): React.ReactElement | null {
  const t = useTranslations('shared')

  /**
   * ⚠️ RECORD COMPLETO, NON `Partial`. Con un `Partial` un motivo nuovo di
   * `coerenza.ts` scivolerebbe fuori in silenzio e l'elenco puntato mostrerebbe
   * un punto in meno di quelli che ci sono: un rosso che nasconde una delle
   * proprie ragioni. Così invece il compilatore pretende una riga per ognuno.
   */
  const testoMotivo: Record<MotivoIncoerenza, string> = {
    // Non lo emette nessuno (`coerenza.ts` lo dichiara e non lo usa mai: un codice
    // assente è un'anagrafica incompleta, non una contraddizione). Resta qui
    // perché fa parte del contratto del tipo, e un contratto senza testo è un
    // punto elenco vuoto il giorno in cui qualcuno lo emette.
    'cf-assente': t('cfMotivoAssente'),
    'cf-lunghezza': t('cfMotivoLunghezza'),
    'cf-forma': t('cfMotivoForma'),
    'cf-giorno': t('cfMotivoGiorno'),
    'cf-data-inesistente': t('cfMotivoDataInesistente'),
    'cf-checksum': t('cfMotivoChecksum'),
    cognome: t('cfMotivoCognome'),
    nome: t('cfMotivoNome'),
    'data-nascita': t('cfMotivoDataNascita'),
    sesso: (() => {
      const dalCodice = sessoScrittoNelCodice(esito.codiceEsaminato)
      if (dalCodice === 'F') return t('cfMotivoSessoFemminaMaschio')
      if (dalCodice === 'M') return t('cfMotivoSessoMaschioFemmina')
      return t('cfMotivoSesso')
    })(),
    'luogo-nascita': t('cfMotivoLuogoNascita'),
  }

  const testoMancante: Record<CampoNonVerificabile, string> = {
    cognome: t('cfMancaCognome'),
    nome: t('cfMancaNome'),
    'data-nascita': t('cfMancaDataNascita'),
    sesso: t('cfMancaSesso'),
    // ⚠️ Questa frase parla del CODICE CATASTALE, non del comune: `coerenza.ts`
    // guarda `codiceBelfiore` e il comune non lo legge. Vedi il blocco in cima —
    // dire «manca il comune» qui contraddiceva il campo del luogo di nascita su
    // 36 record veri, dove il comune c'era ed era pure mostrato scelto.
    'luogo-nascita': t('cfMancaLuogoNascita'),
  }

  const { rosso, giallo, codiceProposto, proposta } = statoBadge(esito)

  // Coerente, tutto verificato, niente da proporre: il campo non ha bisogno di
  // nessuna decorazione. «Niente» è una risposta, ed è quella giusta.
  //
  // Si passa dal predicato ESPORTATO, non da una copia locale della condizione: è
  // lo stesso che i chiamanti interrogano per decidere l'`aria-describedby`, e se
  // le due risposte potessero differire il collegamento tornerebbe a pendere nel
  // vuoto esattamente nei casi in cui nessuno guarda.
  if (!badgeHaQualcosaDaDire(esito)) return null

  const voci = rosso
    ? esito.motivi.map((m) => testoMotivo[m])
    : giallo
      ? esito.nonVerificabili.map((c) => testoMancante[c])
      : []

  const titolo = rosso ? t('cfIncoerenteTitolo') : giallo ? t('cfNonVerificabileTitolo') : t('cfCalcolatoEtichetta')

  const Icona = rosso ? AlertCircle : giallo ? AlertTriangle : Calculator

  const cornice = rosso
    ? 'border-kidville-error bg-kidville-error-soft text-kidville-error-strong'
    : giallo
      ? 'border-kidville-warn bg-kidville-warn-soft text-kidville-warn-strong'
      : 'border-kidville-line bg-kidville-neutral-soft text-kidville-ink'

  return (
    <div
      id={id}
      role="status"
      className={cx('rounded-card border px-3.5 py-3 font-maven text-[13.5px]', cornice)}
    >
      <p className="flex items-start gap-2 font-semibold">
        <Icona size={17} strokeWidth={2.3} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{titolo}</span>
      </p>

      {voci.length > 0 && (
        <ul className="mt-1.5 list-disc pl-[30px]">
          {voci.map((v) => (
            <li key={v} className="mt-0.5">
              {v}
            </li>
          ))}
        </ul>
      )}

      {proposta && codiceProposto !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span>
            {t('cfCalcolatoEtichetta')}{' '}
            <code className="font-barlow font-bold tracking-[0.08em]">{codiceProposto}</code>
          </span>
          {onUsaCalcolato !== undefined && (
            <button
              type="button"
              onClick={() => onUsaCalcolato(codiceProposto)}
              className={btnClass('secondary', 'sm')}
            >
              {t('cfUsaQuesto')}
            </button>
          )}
          {onUsaCalcolato !== undefined && (
            <span className="basis-full font-maven text-[12.5px] text-kidville-sub">{t('cfUsaQuestoNota')}</span>
          )}
        </div>
      )}
    </div>
  )
}
