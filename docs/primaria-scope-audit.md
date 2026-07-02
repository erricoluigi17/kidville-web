# Audit scoping — 25 route `/api/primaria/**` (M1.6)

Ricognizione per lo step M1.6 del piano `docs/piano-app-100.md`. Metodo: lettura per-handler
di ogni `route.ts`, tracciando identità → gate → parametri request-derived → query.

Legenda:
- **Gate**: controllo di RUOLO all'ingresso (`requireDocente`, `requireStaff([...])`, RBAC dedicata).
  `getRequestUserId` da solo NON è un gate (verifica solo la presenza di un id, spoofabile).
- **Scope**: ogni identificatore dati preso dalla request (sectionId, alunnoId, scrutinioId, …)
  è verificato con `assertSezioneInScope`/`assertAlunnoInScope`/check transitivo equivalente.
  `parziale` = alcuni parametri verificati, altri no. `N.A.` = l'handler non tocca dati keyed
  per sezione/alunno/plesso.
- **Fix**: batch del piano in cui si chiude (M1.7 = batch 1, M1.8 = batch 2, `—` = nulla da fare).

| Route | Handler | Gate | Scope | Buco principale | Fix |
|---|---|---|---|---|---|
| `me` | GET | resolveIdentity (M1.5) | N.A. | — (restituisce solo il contesto del chiamante) | — |
| `registro` | GET | requireDocente | presente | — | — |
| `registro` | POST | requireDocente | **parziale** | `destinatariIds[]` non verificati (insert `registro_destinatari` + notifiche ad alunni arbitrari) | M1.7 |
| `valutazioni` | GET | requireDocente | presente | — | — |
| `valutazioni` | POST | requireDocente | **parziale** | `alunnoId` non verificato vs sezione; `materiaId` non confrontato con sezione/plesso | M1.7 |
| `note` | GET | requireDocente | presente | — | — |
| `note` | POST | requireDocente | **parziale** | `alunnoIds[]` non verificati (note+richiesta firma su alunni di altre sezioni) | M1.7 |
| `ore-assenza` | GET | **nessuno** (presence-only) | **mancante** | `sectionId`/`alunnoId` mai asseriti; leggibile da chiunque con un userId | M1.7 |
| `obiettivi` | GET | **nessuno** (presence-only) | **mancante** | `materiaId`/`sectionId` mai asseriti; `scalaValori` (numeri privati) leggibile dal genitore | M1.7 |
| `appello` | GET | requireDocente | presente | — | — |
| `appello` | POST | requireDocente | **parziale** | `records[].alunnoId` non verificati (upsert presenze su alunni di altre sezioni) | M1.7 |
| `scrutinio` | GET | requireDocente | **parziale** | `periodoId` non validato vs scuola della sezione (il GET crea anche la riga scrutini) | M1.8 |
| `scrutinio` | POST | requireDocente | **parziale** | `giudizi[].alunnoId`/`materiaId` non verificati vs sezione dello scrutinio | M1.8 |
| `scrutinio` | PATCH | requireDocente | **parziale** | `comportamento[].alunnoId` non verificato vs sezione dello scrutinio | M1.8 |
| `scrutinio/chiudi` | POST | requireStaff(admin,coordinator) | **mancante** | `scrutinioId`→`section_id` risolto ma mai asserito (chiusura cross-plesso) | M1.8 |
| `scrutinio/pubblica` | POST | requireStaff(admin,coordinator) | **mancante** | idem: pubblicazione cross-plesso possibile | M1.8 |
| `scrutinio/import` | POST | **nessuno** + fallback `DEV_TEACHER` | **mancante** | nessun gate, demo-ID, `scrutinio.section_id` mai asserito | M1.8 |
| `pagella` | GET | branch locale staff/genitore (presence-only) | **parziale** | ramo staff: `scrutinioId` mai asserito né confrontato con l'alunno; ramo genitore vincolato da `pagella_ricezioni` (ok) | M1.8 |
| `pagella/batch` | POST | requireStaff(admin,coordinator) | **mancante** | `scrutinio.section_id` disponibile ma mai asserito (batch cross-plesso) | M1.8 |
| `fascicolo` | GET/POST | RBAC `puoAccedereFascicolo` | presente | identità header-only spoofabile (getRequestUserId) → passare a resolveIdentity | M1.8 |
| `fascicolo/pagelle` | GET | RBAC `puoAccedereFascicolo` | presente | identità header-only spoofabile → resolveIdentity | M1.8 |
| `fascicolo/file` | GET | RBAC `puoAccedereFascicolo` | presente | identità header-only spoofabile → resolveIdentity | M1.8 |
| `prospetto` | GET | requireDocente | presente | — | — |
| `orario` | GET | requireDocente | presente | — | — |
| `allegati` | GET | **nessuno** (presence-only) | **mancante** | `registroId` mai risolto→asserito; enumerazione allegati di qualsiasi registro | M1.8 |
| `allegati` | POST | **nessuno** | **mancante** | idem + `userId` preso dal formData (impersonificazione) | M1.8 |
| `giustifiche-didattiche` | GET | **nessuno** (presence-only) | **mancante** | `sectionId` mai asserito (nomi alunni leggibili da chiunque) | M1.8 |
| `giustifiche-didattiche` | POST | **nessuno** + fallback `DEV_TEACHER` | **mancante** | nessun gate, demo-ID, `sectionId`/`alunnoId` mai asseriti | M1.8 |
| `sblocca` | POST | requireStaff(admin,coordinator) | **mancante** | `entitaId` mai risolto→asserito (sblocco cross-plesso, audit su id inesistenti) | M1.8 |
| `classi` | GET | requireDocente (+grado) | presente | scoping per costruzione dall'identità | — |
| `sezioni` | GET | requireDocente | presente | scoping per costruzione dall'identità | — |
| `classe/[sectionId]` | GET | requireDocente (+grado) | presente | — | — |
| `presenze/giust-vista` | POST | **nessuno** (presence-only) | **mancante** | `presenzaId` mai risolto→asserito; `giust_vista_da` impersonabile | M1.8 |

## Route correlate (fuori dalle 25, toccate dal batch 1 per il flusso note)

| Route | Handler | Stato | Fix |
|---|---|---|---|
| `parent/primaria/note/firma` | POST | manca il check legame genitore↔alunno: qualunque utente autenticato può firmare qualsiasi nota (`notaId` arbitrario) | M1.7 |
| `parent/primaria/note/firma/otp` | POST | invia l'OTP solo all'email del chiamante: nessun dato altrui raggiungibile | — |

## Pattern ricorrenti (guida per i fix)

1. **Array di alunni non verificati dentro una sezione asserita** (appello POST, note POST,
   registro POST `destinatariIds`, valutazioni POST, scrutinio POST/PATCH): la sezione è
   asserita ma gli `alunno_id` del body no → scritture/notifiche cross-sezione. Fix comune:
   verifica batched che ogni id appartenga alla sezione (`alunni.section_id === sectionId`).
2. **Id risolto ma mai asserito** (scrutinio chiudi/pubblica/import, pagella/batch, sblocca,
   allegati, presenze/giust-vista): l'handler fa già il fetch della riga che contiene
   `section_id`/`alunno_id` ma non chiama mai l'assert → aggiungere l'assert sul valore risolto.
3. **Presence-only al posto del gate** (ore-assenza, obiettivi, allegati, giustifiche,
   giust-vista, scrutinio/import): `getRequestUserId` sostituito da `requireDocente` (o RBAC
   esistente su identità `resolveIdentity`).
4. **Demo-ID**: `DEV_TEACHER` in `scrutinio/import` e `giustifiche-didattiche` → rimozione (M1.8).

Nota: la chiusura dell'identità header-legacy in tutta l'app (`ALLOW_HEADER_IDENTITY=false`,
rimozione fallback client) è fuori scope M1 — è la milestone M4.
