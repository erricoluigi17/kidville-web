# Pop-up «Aggiorna l'app» — design (2026-09-29)

## Obiettivo

Chi usa ancora un binario nativo vecchio vede un pop-up che lo porta ad App Store o Google Play. **Solo** chi non ha aggiornato lo vede: mai sul web, mai sulla versione corrente.

## Fatti verificati il 29/09

**La 1.1 è pubblicata:**
- iOS: `itunes.apple.com/lookup?id=6794883055&country=it` risponde `version 1.1`, rilascio 2026-09-25T19:51Z;
- Android: la scheda Google Play di `it.kidville.app` risponde `1.1`.

**Sistema minimo invariato** fra 1.0 e 1.1 (`IPHONEOS_DEPLOYMENT_TARGET 15.0`, `minSdkVersion 24`): nessuno resta senza aggiornamento possibile.

**`@capacitor/app` era già nel binario 1.0** (`fd5e7dd0`, 2026-07-04), quindi `App.getInfo()` funziona anche lì. In `app_log` compaiono già `versione_app` `1.0+4` su iOS e `1.0+1` su Android.

**Utenti visti SOLO con la 1.0** negli ultimi 2 giorni (da `app_log`, limite inferiore):

| | utenti |
|---|---|
| iOS | 58 |
| Android | 33 |

## Decisioni del titolare

- Finestra **al centro**, **a ogni apertura**, con «Aggiorna ora» e «Più tardi».
- **Non bloccante.**

## Design

**Decisione: `src/lib/native/aggiornamento-app.ts`.**
- `VERSIONE_MINIMA_STORE`: `{ ios: '1.1', android: '1.1' }`, congelata.
  - Si alza solo dopo aver visto la versione sullo store; `null` spegne la piattaforma.
- `confrontaVersioni`: confronto numerico per segmento, `null` se il formato è illeggibile.
- `appDaAggiornare()` fa, in ordine:
  1. controlla la shell nativa;
  2. controlla la piattaforma (ios o android) e che la sua minima non sia `null`;
  3. controlla `isPluginAvailable('App')`;
  4. chiama `getInfo()` con un timeout di 3 s.
  - Se un passo fallisce: `null` e una riga `warn` (`avviso-aggiorna-app-versione-illeggibile: <motivo>`).
  - Restituisce il risultato di `getInfo`, mai il plugin (lock `plugin-capacitor-mai-risolto-da-promise`).
- Contiene anche `urlSchedaStore` e `apriSchedaStore`, spostati qui da `avvisi-settimanali.ts`. Navigano con `window.location.assign`, così la shell consegna l'URL allo store di sistema.

**Finestra: `src/components/providers/AvvisoAggiornamentoApp.tsx`.**
- La decisione è presa una volta per sessione, a livello di modulo, come per `AvvisiSettimanaliApp`: StrictMode e rimontaggi non rileggono la versione e non raddoppiano il log.
- Usa `Modal` con `closeOnBackdrop={false}`.
- «Più tardi», Esc e Indietro su Android chiudono. «Aggiorna ora» apre lo store e chiude.
- **Riapertura:** quando `visibilitychange` torna `visible` dopo ≥ `RIPROPONI_DOPO_MS` (30 minuti) in `hidden`, la finestra ricompare, se ancora da aggiornare.

**Montaggio: `RootProviders`, fra i figli di `BiometricGate`.**
- La `Modal` rende `inert` i fratelli risalendo fino al `body`. Aperta sopra l'overlay di sblocco già presente, lo renderebbe intoccabile.
- Per questo `BiometricGate` espone `useBloccoBiometrico()` e la finestra si apre con `open={aperto && !bloccato}`.
- Lock: `__tests__/architecture/gate-shell-nativa.test.ts`.

**Riquadro settimanale (`avvisi-settimanali.ts`).**
- Resta solo per «notifiche disattivate».
- Su un binario da aggiornare `avvisoDaMostrare` restituisce `null` senza consumare la settimana (uno alla volta, prima l'aggiornamento).
- Tolti `APP_1_1_PUBBLICATA` e `binarioDaAggiornare()`.

**Log** (client, `warn`, evento `avvio`): `avviso-aggiorna-app-mostrato`, `-rimandato`, `-tocco-store` (esito), `-versione-illeggibile: <motivo>`; più `-decisione-fallita` (error).

## Verifica

**Test (TDD, visti rossi prima del codice).** Mutanti rossi verificati per tre difetti:
- il plugin restituito da una promise;
- la finestra aperta sopra il gate bloccato;
- la soglia dei 30 minuti tolta.

**Dopo il deploy, la prova sui telefoni veri**, con una query di sola lettura su `app_log`:
- le righe `avviso-aggiorna-app-%` devono avere solo `versione_app` `1.0+*`, mai `1.1+*`;
- gli utenti visti solo con la 1.0 devono calare nei giorni successivi.

## Per la prossima release

Si pubblica la versione nuova su entrambi gli store e la si **vede** pubblicata. Poi si alza `VERSIONE_MINIMA_STORE` della piattaforma, si aggiorna il test che la fotografa e si fa il deploy web.
