# La Segreteria rigenera le credenziali anche allo staff — design

**Data**: 2026-09-03
**Stato**: approvato dal titolare
**Richiesta**: «anche chi ha l'account segreteria deve poter rigenerare le credenziali sia ai genitori
che allo staff»

---

## 1. Cosa c'è oggi, misurato prima di scrivere una riga

### 1.1 Sui genitori funziona già

`POST /api/admin/regenerate-credentials` passa da `requireStaff`, il cui elenco predefinito è
`['admin', 'coordinator', 'segreteria']`. Il ramo `targetKind === 'parent'` non ha nessun controllo
di ruolo aggiuntivo.

**Prova dal vivo, non dal codice** — `app_log`, 2026-09-03 ore 06:31 UTC:

| `utente_ruolo` | `evento` | `stato_http` | esito |
|---|---|---|---|
| `segreteria` | `email` / `sendEmail` | 200 | credenziali consegnate da Resend |

Il `targetKind` è redatto ma la redazione ne conserva la **lunghezza**: `str/6` = `parent`,
`str/5` = `staff`. Quella riga è `str/6`. Quindi: la metà «genitori» della richiesta **è già viva in
produzione** e non richiede codice. Richiede una prova di non regressione.

### 1.2 Sullo staff il blocco è esplicito

`src/app/api/admin/regenerate-credentials/route.ts:57`

```ts
if (targetKind === 'staff' && auth.user.role !== 'admin' && auth.user.role !== 'coordinator') {
  return NextResponse.json({ error: 'Credenziali staff: operazione riservata alla Direzione' }, { status: 403 })
}
```

E l'interfaccia nasconde il pulsante con la stessa condizione, scritta due volte:
`src/components/features/admin/StaffDetailPanel.tsx:522` e
`src/components/features/admin/settings/StaffPanel.tsx:22`, entrambe
`const canEdit = role === 'admin' || role === 'coordinator'`.

### 1.3 Perché la richiesta nasce: Cesa non ha Direzione

Query sui dati veri, 2026-09-03:

| Sede | admin | coordinator | segreteria |
|---|---|---|---|
| Kidville Giugliano | 1 | — | 1 |
| Kidville Aversa | 1 | — | 1 |
| **Kidville Cesa** | **0** | **0** | **2** |
| Kidville Demo | 1 | 1 | 3 |
| Kidville E2E | 1 | — | — |

Le due segreterie di Cesa non hanno nessuna Direzione nel proprio plesso: oggi, per una maestra che
ha perso la password, devono chiamare il titolare.

### 1.4 Il vincolo che impone l'eccezione: il PDF contiene la password in chiaro

Dopo il reset, `regenerate-credentials` costruisce un PDF con la **password in chiaro** e lo
notifica a **chi ha premuto il pulsante** (`enqueueNotifiche` → `utenteIds: [auth.user.id]`), con un
collegamento a `GET /api/admin/credentials-pdf?key=…`. Quella route è aperta a **tutto lo staff in
scope di sede** (`requireStaff` + `assertUtenteInScope`).

Conseguenza diretta: se la Segreteria potesse resettare un account di Direzione del proprio plesso,
ne leggerebbe la nuova password e vi accederebbe. Ad Aversa e a Giugliano l'admin è **nello stesso
plesso** della segreteria. **Non è un rischio teorico: è il percorso di consegna già in esercizio.**

### 1.5 Il rinvio in blocco ha un filtro di sede che non ha mai funzionato

`POST /api/admin/iscrizioni/rinvia-credenziali` accetta uno `scuola_id` opzionale e lo risolve così
(`route.ts:111`):

```ts
await admin.from('parents').select('id').eq('scuola_id', b.data.scuola_id)
```

**`parents` non ha la colonna `scuola_id`.** Verificato sullo schema di produzione: 27 colonne,
nessuna è `scuola_id`. La sede di un genitore si deduce dai **figli**, e lo dice pure un commento in
`regenerate-credentials` («`parents` non ha sede»). PostgREST risponde `42703`, il codice lo
intercetta come `erroreSede` e restituisce **500 `RINVIO_SEDE_NON_RISOLTA`**.

Il difetto è invisibile perché l'unico che può chiamare quella route è l'admin, che è multi-sede e
non passa mai `scuola_id`. **Aprire la route alla Segreteria lo rende immediatamente visibile e
dannoso.** Il perimetro senza filtro, misurato:

| Sede | famiglie candidate (`stato='inviata'`, `rigenerazioni < 3`) |
|---|---|
| Giugliano | 275 |
| Cesa | 156 |
| Aversa | 97 |
| **totale** | **528** |

Una segreteria di Cesa che preme «rinvia» riscriverebbe **528** password, non 156.

---

## 2. Decisioni del titolare

1. **Staff**: la Segreteria rigenera le credenziali di chiunque nello staff **tranne** `admin` e
   `coordinator`. (Su sé stessa è ammessa: opzione «e nemmeno sé stessa» esplicitamente non scelta.)
2. **Rinvio in blocco**: aperto anche alla Segreteria, **confinato al proprio plesso**.

---

## 3. Il design

### 3.1 La regola vive in un posto solo

Modulo nuovo `src/lib/auth/credenziali-staff.ts`, un predicato **puro**, senza I/O:

```ts
export function puoRigenerareCredenzialiStaff(
  attore: AppRole,
  ruoloBersaglio: string | null,
): boolean
```

| attore | bersaglio | esito |
|---|---|---|
| `admin`, `coordinator` | qualunque | `true` |
| `segreteria` | `admin`, `coordinator` | `false` |
| `segreteria` | ogni altro ruolo noto | `true` |
| `educator`, `cuoca`, `genitore`, altro | qualunque | `false` |
| qualunque | `null` / ruolo non riconosciuto | `false` |

L'ultima riga è la regola che conta: **si nega ciò che non si è riusciti a leggere.** Un
`maybeSingle()` che torna `null` per un guasto di lettura non deve diventare un permesso.

Il modulo è puro perché **296 file di test sostituiscono `require-staff` per intero**: i predicati
puri stanno in `predicati-ruolo.ts` proprio per sopravvivere a quel mock (testata di
`predicati-ruolo.ts`). Un predicato con I/O dentro `require-staff` sarebbe stato mockato via
insieme al resto.

Quattro chiamanti: la route di rigenerazione, la route del PDF, e i due pannelli.

### 3.2 `regenerate-credentials` — il controllo si sposta dopo la lettura del bersaglio

Oggi il controllo è **prima** di conoscere il bersaglio, e può esserlo perché non gli serve saperne
il ruolo. La regola nuova ne ha bisogno, quindi:

1. resta il gate di ruolo grossolano: se l'attore non è staff di gestione, 403 subito (non cambia);
2. resta `assertUtenteInScope` — **prima** del nuovo controllo: chi è fuori sede riceve «fuori dal
   tuo plesso», non un messaggio sui ruoli. Non si rivela il ruolo di un utente di un altro plesso;
3. il `select` del ramo staff aggiunge `ruolo` alle colonne già lette;
4. `puoRigenerareCredenzialiStaff(auth.user.role, ruoloBersaglio)` → se `false`, **403** con
   `codice: 'CREDENZIALI_STAFF_RISERVATE'` e la frase: *«Le credenziali di un account di Direzione
   si rigenerano dalla Direzione.»*

Un errore di lettura di `utenti` (PostgREST ritorna `{ error }`, non lancia — regola 7) diventa
**500**, mai un 403 muto e mai un permesso.

### 3.3 `credentials-pdf` — la stessa regola, o si chiude la porta lasciando la finestra

La route conosce già il bersaglio (lo decompone dalla chiave) e distingue già staff da genitore.
Sul ramo staff aggiunge `ruolo` al `select` e applica lo **stesso** predicato. Senza questa parte,
una segreteria che venisse a conoscenza della chiave del PDF di un admin lo scaricherebbe: la
protezione del §3.2 sarebbe aggirabile.

Sul ramo genitore: nessun cambiamento.

### 3.4 `rinvia-credenziali` — il perimetro non arriva più dal client

Il gate diventa `admin` / `coordinator` / `segreteria`, e il filtro di sede viene **riparato e reso
obbligatorio per costruzione**:

1. `plessi = await scuoleDiUtente(admin, auth.user)` — admin: i propri plessi via `utenti_scuole`;
   segreteria: solo `utenti.scuola_id`;
2. `plessi.length === 0` → **403 `NESSUN_PLESSO`** (nessuna sede, nessun rinvio);
3. `scope = restringiSedi(plessi, b.data.scuola_id)` — lo `scuola_id` del body può solo
   **restringere**; `null` → **403 `SEDE_NON_ACCESSIBILE`**. `restringiSedi` confronta in forma
   canonica, quindi non ripete il difetto del 2026-07-31 (una segreteria che scriveva la **propria**
   sede in maiuscolo riceveva 403);
4. i genitori del perimetro si risolvono **dai figli**, con la stessa join di `assertParentInScope`:
   `student_parents → alunni!inner(scuola_id)`, `.in('alunni.scuola_id', scope)`;
5. la query sul registro filtra su quei `parent_id`. **Sempre**, non solo quando il body porta una
   sede.

Cambia il comportamento anche per l'admin: oggi «nessuna sede» significa *tutte le famiglie
esistenti*, dopo significa *tutte le famiglie dei plessi a cui ha diritto*. Per l'admin reale i due
insiemi coincidono (i 528 candidati stanno tutti in Giugliano, Cesa e Aversa) — ma la coincidenza è
un fatto di oggi, non una garanzia, e la seconda formulazione è quella corretta.

Errore di lettura in uno qualunque di questi passi → **500**, mai un perimetro parziale: un rinvio
su metà delle famiglie è peggio di un rinvio fallito, perché nessuno se ne accorge.

### 3.5 Interfaccia — due poteri oggi confusi in un interruttore solo

In entrambi i pannelli `canEdit` governa **due cose diverse**: modificare ruolo/sede/classi, e
rigenerare le credenziali. Si separano:

| potere | chi |
|---|---|
| modifica di ruolo, sede, classi | `admin` / `coordinator` — **invariato** |
| rigenerazione credenziali | `puoRigenerareCredenzialiStaff(role, bersaglio.ruolo)` |

Il secondo dipende dal **bersaglio**, quindi in `settings/StaffPanel.tsx` si valuta per riga, e in
`StaffDetailPanel.tsx` sul `member` aperto. Il footer di `StaffDetailPanel`, oggi
`tab === 'incarico' && (canEdit ? … )`, si ristruttura perché «Modifica» e «Rigenera» non hanno più
la stessa condizione.

Nascondere un pulsante è una **cortesia** (nessun comando che finisce sempre in un alert 403), non
una difesa: il controllo che conta è quello del §3.2.

### 3.6 Perché la modifica del ruolo NON si apre

Se la Segreteria potesse cambiare il ruolo di un collega, promuoverebbe qualcuno ad `admin` e
otterrebbe per via indiretta ciò che il §3.2 le nega. La riserva su ruolo/sede/classi non è un
residuo: è ciò che rende la regola del §3.2 non aggirabile.

---

## 4. Logging (AGENTS.md §Logging obbligatorio)

- Il diniego del §3.2 e del §3.3 scrive `logEvento('auth', 'warn', { tipo:
  'credenziali-staff-riservate', azione, utente, ruolo })`. `warn` è persistito: un tentativo di
  reset su un account di Direzione è un segnale di sicurezza e deve lasciare traccia.
  **Mai il ruolo del bersaglio né il suo uuid**: basta sapere che è successo, e a chi.
- Il 403 `SEDE_NON_ACCESSIBILE` del §3.4 riusa il `warn` già emesso dalle primitive di scope.
- Il successo continua a passare da `logScrittura` (entità `credenziali`), invariato.
- Nessun `console.*`: le route usano `@/lib/logging/logger`, i componenti `logClient`.

---

## 5. Come si verifica

Prove da scrivere **prima** del codice, e da vedere **rosse** prima di vederle verdi — la memoria del
progetto registra un difetto passato con 13.254 test verdi perché il mock rispondeva uguale a ogni
tabella.

**Unità** — `__tests__/lib/auth/credenziali-staff.test.ts`: la tabella del §3.1 riga per riga,
compresa `null` → `false`.

**Route `regenerate-credentials`**:
- segreteria → `educator`: **200**
- segreteria → `cuoca`: **200**
- segreteria → altra `segreteria`: **200**
- segreteria → `admin`: **403** `CREDENZIALI_STAFF_RISERVATE`
- segreteria → `coordinator`: **403**
- segreteria → staff di un **altro plesso**: **403 fuori sede**, e il messaggio non deve nominare i
  ruoli (l'ordine del §3.2)
- admin → `admin`: **200** (non regredisce)
- segreteria → **genitore**: **200** (§1.1, non regredisce)
- lettura di `utenti` in errore: **500**, non 403 e non 200

**Route `credentials-pdf`**: segreteria che chiede la chiave di un bersaglio `admin` → **403**;
la chiave di un `educator` del proprio plesso → **200**; una chiave di genitore → invariata.

**Route `rinvia-credenziali`**:
- segreteria del plesso X: tocca **solo** i genitori con figli in X
- segreteria che chiede il plesso Y: **403 `SEDE_NON_ACCESSIBILE`**
- segreteria che chiede il **proprio** plesso in MAIUSCOLO: **200** (controprova di `formaConfronto`)
- admin multi-sede senza `scuola_id`: l'unione dei suoi plessi
- utente senza `scuola_id`: **403 `NESSUN_PLESSO`**, nessuna password riscritta
- `dry_run` continua a non scrivere niente

**Componenti**: `StaffDetailPanel` e `StaffPanel` come `segreteria` — il pulsante «Rigenera» è
presente su un `educator` e **assente** su un `admin`; «Modifica» è assente in entrambi i casi.

**Controprova obbligatoria**: invertire il predicato (`return true` fisso) e verificare che le prove
di diniego diventino **rosse**. Un test mai visto fallire non è un test.

**Gate**: `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run` (baseline nota:
13.327 verdi), `npm run build`. E2E in CI.

---

## 6. Fuori perimetro

- La modifica di ruolo/sede/classi resta della Direzione (§3.6).
- Il canale di consegna (email + PDF) non cambia.
- L'auto-riparazione dell'identità genitore (`ensureParentIdentity`) non cambia.
- Nessuna migrazione: nessuna colonna nuova, e in particolare **nessun `scuola_id` su `parents`** —
  un genitore non ha una sede, ce l'hanno i suoi figli, e possono averne due diverse.
- Non si tocca l'isolamento fra plessi se non per **restringerlo** (§3.4).
