import { NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveIdentity, loadAppUser, type AppRole } from '@/lib/auth/require-staff'
import { getSessionProfili } from '@/lib/auth/profili'
import { ACTIVE_ROLE_COOKIE, areaForRole, RUOLI_APP } from '@/lib/auth/active-role'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'

// POST /api/auth/active-role — setta SERVER-SIDE il cookie `kv-active-role`
// (M4B.2): il ruolo attivo di chi ha più profili. Il valore è validato contro
// i profili REALI dell'utente (sessione → utenti + ponte parents), quindi il
// cookie non è mai un'escalation: al massimo seleziona uno dei propri ruoli.
// Lo leggono le guardie d'area nei layout (M4B.4).

const postSchema = z.object({
  ruolo: z.enum(RUOLI_APP as [AppRole, ...AppRole[]]),
})

/**
 * Lo scope di sede del cockpit. Stesso nome che usano `SedeProvider` (client),
 * `sediDalCookie` (`lib/auth/scope.ts`) e `POST /api/auth/logout`: sono quattro
 * punti che devono nominare la stessa cosa, e finché il nome è una stringa il
 * modo di sbagliarla è scriverla diversa. Qui è cancellato — vedi sotto il perché.
 */
const COOKIE_SEDI = 'sedi_attive'

export const POST = withRoute('auth/active-role:POST', async (request: Request) => {
  const { userId } = await resolveIdentity(request)
  if (!userId) {
    return NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 })
  }

  const body = await parseBody(request, postSchema)
  if ('response' in body) return body.response
  const { ruolo } = body.data

  // Il ruolo richiesto deve appartenere all'utente: dalla sessione (profili
  // reali); sul percorso legacy senza sessione, dal ruolo della riga `utenti`.
  const sessione = await getSessionProfili()
  let ammesso: boolean
  if (sessione) {
    ammesso = sessione.profili.some((p) => p.ruolo === ruolo)
  } else {
    const user = await loadAppUser(userId)
    ammesso = user?.role === ruolo
  }
  if (!ammesso) {
    // `warn`, quindi PERSISTITO. Questo è l'unico punto del sistema che possa vedere un
    // tentativo di cambio ruolo non autorizzato, ed era CIECO: rispondeva 403 e non
    // lasciava traccia da nessuna parte. È la stessa forma di difetto già pagata altrove
    // in questo repo — «dodici 403 corretti, e in `app_log` non c'era una sola riga»: un
    // gate che funziona ma non parla non si distingue da un gate che non è mai stato
    // raggiunto. `withRoute` sa che la route ha risposto 403, non sa CHI ha chiesto COSA.
    //
    // Le chiavi non sono a caso: `tipo` e `ruolo` sono in lista bianca di `redact()` ed
    // escono in chiaro; `utente` non lo è, ma il valore è un uuid — auto-descrittivo per
    // FORMA — e passa comunque. Sul percorso legacy, dove l'id può non essere un uuid,
    // uscirà redatto, ed è il verso giusto in cui sbagliare.
    logEvento('auth', 'warn', { tipo: 'ruolo-attivo-non-disponibile', utente: userId, ruolo })
    return NextResponse.json({ error: 'Ruolo non disponibile per questo utente' }, { status: 403 })
  }

  // Anche il SUCCESSO parla (AGENTS.md, Logging obbligatorio, regola 5): senza questa
  // riga «nessun log di cambio ruolo» significherebbe insieme «nessuno cambia veste» e
  // «il cambio veste non funziona più» — e il secondo caso nessuno lo segnala, perché
  // l'utente vede semplicemente l'area sbagliata e conclude che l'app è fatta così.
  // `info`: l'evento `auth` non è persistito per `info`, ed è la deroga già motivata in
  // `eventi-log.test.ts`. La riga vive sui Runtime Logs, che è dove si guarda un «perché
  // mi ha portato su /teacher»; il segnale che deve durare — il tentativo negato — è il
  // `warn` qui sopra.
  logEvento('auth', 'info', { tipo: 'ruolo-attivo-cambiato', utente: userId, ruolo })

  const area = areaForRole(ruolo)
  const res = NextResponse.json({ ok: true, ruolo, area })

  /*
   * ─── LA SELEZIONE DI SEDE NON SEGUE LA VESTE ────────────────────────────────
   *
   * `sedi_attive` è una preferenza del COCKPIT: «di quali plessi voglio vedere i
   * dati». La scrive il client (`SedeProvider`) e dura un anno. Chi passa alla veste
   * di FAMIGLIA se la porta dietro, e `resolveScuoleAttive` (`lib/auth/scope.ts`)
   * interseca le sedi accessibili in quella veste — quella del figlio — con quelle
   * selezionate nel cockpit: due insiemi disgiunti, `[]`, e `[]` in quel modulo
   * **nega** di proposito. Il risultato è un'app che funziona e non mostra niente
   * (diario, galleria, mensa vuoti) più un `warn` `sedi-attive-non-accessibili` a
   * nome di una persona che non ha fatto nulla di male. Nessun errore, nessuna
   * schermata rotta: solo il vuoto, che somiglia a «non c'è ancora niente».
   *
   * PERCHÉ QUI E NON NEL CLIENT: il cookie non è httpOnly, quindi il client
   * potrebbe cancellarlo — ma solo DOPO che questa risposta è tornata, e fra il 200
   * e quella riga c'è una finestra in cui una richiesta già in volo porta il cookie
   * vecchio insieme alla veste nuova. Nella stessa risposta la finestra non esiste.
   *
   * ⚠️ E PERCHÉ **SOLO** QUANDO L'AREA DI CASA NON È IL COCKPIT. Questa route è
   * anche quella che il LOGIN chiama a ogni accesso, per tutti. Azzerare sempre
   * vorrebbe dire rimettere la Direzione multi-sede davanti a «Seleziona una sede»
   * ogni mattina — e a un 400 di `resolveScuolaScrittura` su ogni scrittura: è il
   * difetto raccontato nella testata di `AdminMenuSheet`, e sarebbe un rimedio
   * peggiore del male. La condizione non è «il ruolo è cambiato» ma «la veste nuova
   * non è di cockpit», e regge anche quando il cookie di veste precedente manca
   * del tutto — lo stato in cui le cinque persone vere si sono trovate finché uno
   * switch dentro l'app non è esistito.
   *
   * Nessun `httpOnly` e nessun `secure`: si sta CANCELLANDO un cookie scritto dal
   * browser, e per farlo bastano (e devono combaciare) nome e `path`.
   */
  if (area !== 'admin') {
    res.cookies.set(COOKIE_SEDI, '', { path: '/', maxAge: 0 })
  }

  res.cookies.set(ACTIVE_ROLE_COOKIE, ruolo, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    // Persistente oltre la singola tab: alla login successiva viene comunque
    // ri-settato (o ri-scelto, per chi ha più profili).
    maxAge: 60 * 60 * 24 * 180,
  })
  return res
})
