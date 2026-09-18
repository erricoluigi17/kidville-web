/**
 * L'INTERRUTTORE — uno solo, e oggi è SPENTO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COSA ACCENDE. Il rifiuto **409 `CLIENT_UPDATE_REQUIRED`** sul percorso vecchio
 * dei video: le tre porte storiche che ricevono un filmato già compresso dal
 * browser e lo archiviano come un file qualsiasi —
 *   · `POST /api/gallery/upload`      (multipart: le shell native col bundle in cache)
 *   · `POST /api/gallery/upload-url`  (firma + `PUT`: il web e la coda offline Dexie)
 *   · `POST /api/news/upload`         (multipart: l'editor delle comunicazioni)
 *
 * PERCHÉ IL CODICE ENTRA PRIMA E SI ACCENDE DOPO. Le app native già installate
 * sui telefoni non sanno parlare con la pipeline nuova: continueranno a spedire
 * su queste porte, e quel file nessuno lo convertirà mai. Ma accendere il blocco
 * PRIMA che la pipeline nuova funzioni lascerebbe maestre e genitori senza
 * nessun modo di caricare un video — il percorso vecchio chiuso e quello nuovo
 * non ancora aperto. Quindi si scrive presto e si accende tardi.
 *
 * ─── COME SI ACCENDE, IL GIORNO DEL RILASCIO ────────────────────────────────
 * Si cambia `false` in `true` QUI, e basta. Non c'è un secondo posto, e non deve
 * nascerne uno: il giorno in cui gli interruttori diventano due, uno dei due
 * resta spento e il blocco copre metà delle porte senza che nessuno se ne
 * accorga. Che sia davvero uno solo non è affidato a questo commento —
 * `__tests__/architecture/interruttore-legacy-video.test.ts` lo misura, e
 * `__tests__/api/video-legacy-blocco.test.ts` dimostra che un unico valore
 * ribalta tutte e tre le porte insieme.
 *
 * ⚠️ PERCHÉ UNA COSTANTE E NON UNA VARIABILE D'AMBIENTE. Una env sarebbe due
 * posti — il codice che la legge e il pannello che la imposta — e la si può
 * dimenticare su un ambiente e non su un altro, che è esattamente la situazione
 * che questo file esiste per rendere impossibile. Il rilascio del blocco è un
 * rilascio di codice: si vede nel diff, passa dalla CI, si annulla con un revert.
 *
 * ⚠️ PERCHÉ UN FILE SUO, che contiene una riga sola. Perché il valore si possa
 * SOSTITUIRE nei test senza toccare la logica che lo usa: `videoLegacyDaFermare`
 * sta in `./blocco-legacy-video`, e in ESM una funzione che chiamasse il proprio
 * export dallo stesso modulo non vedrebbe mai il sostituto. Separandoli, «acceso»
 * e «spento» si misurano davvero — e «da spento non cambia niente» smette di
 * essere una promessa.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * `true` il giorno in cui la pipeline video nuova è in aria e il percorso vecchio
 * deve chiudersi. Il tipo è annotato `boolean` di proposito: senza, TypeScript
 * fisserebbe il tipo letterale `false` e ogni controllo a valle diventerebbe
 * «sempre falso» per il compilatore — cioè codice che nessuno può più leggere
 * come vivo.
 */
export const BLOCCO_LEGACY_VIDEO_ATTIVO: boolean = false
