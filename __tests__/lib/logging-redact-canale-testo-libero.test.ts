import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { redact, redactInput, CHIAVI_IN_CHIARO } from '@/lib/logging/redact';
import { parseBody } from '@/lib/validation/http';
import { conContesto, contesto } from '@/lib/logging/context';

/**
 * IL CANALE DI TESTO LIBERO VERSO `app_log`, chiuso dai due versi con cui era aperto.
 *
 * Il vettore è uno solo e vale per entrambi i rilievi: `parseBody` deposita il BODY GREZZO
 * della richiesta nel contesto PRIMA di zod (`impostaPayload('body', raw)`, `validation/http.ts`),
 * e da lì il body finisce in `app_log.contesto.payload` passando da `redact()`. `app_log`
 * conserva 30 giorni e si interroga in SQL.
 *
 * Su una rotta come `parent/presenze/comunica-assenza` basta un account genitore: un rifiuto
 * (`ASSENZA_DATA_PASSATA`) lascia una riga `warn`, e `warn` si persiste sempre. Su quella
 * rotta il testo libero non è un'ipotesi: è il MOTIVO dell'assenza, dato sanitario di un minore.
 *
 * Due buchi, misurati dal collaudo del 2026-08-07:
 *
 *  · M11 — LA LISTA BIANCA APRIVA SUL NOME DELLA CHIAVE E NON GUARDAVA IL VALORE.
 *    `{"stato": "<qualunque cosa>"}` usciva in chiaro, e con lui `tipo`, `esito`, `operazione`,
 *    `sezione`, `grado`, `error_code`, `entita_tipo`… ~20 chiavi. Il modulo aveva già scritto
 *    la difesa giusta per `digest` e per `url` («LA CHIAVE APRE, IL VALORE CONFERMA») e non
 *    l'aveva generalizzata.
 *
 *  · M15 — LE CHIAVI DEGLI OGGETTI NON PASSAVANO DA NESSUNA RIDUZIONE.
 *    `redactValore` riusava `kk` intatta, quindi il testo poteva viaggiare nel NOME invece che
 *    nel valore: `{"motivo": {"<testo arbitrario>": 1}}` usciva intero. Lo stesso dato in due
 *    forme, due trattamenti, decisi dal client.
 */
describe('redact — il canale di testo libero verso app_log', () => {
    describe('M11 · sotto una chiave in lista bianca, il VALORE deve confermare', () => {
        it('nessuna chiave di IN_CHIARO accetta un valore con spazi', () => {
            // Il lock è sull'ELENCO, non su un campione: una chiave aggiunta domani è coperta
            // il giorno in cui viene aggiunta, che è il solo momento in cui nessuno guarda.
            const testo = 'ARBITRARIO-DA-CLIENT <script>alert(1)</script> KV_ERR evt=cron';
            for (const chiave of CHIAVI_IN_CHIARO) {
                const out = redact({ [chiave]: testo }) as Record<string, unknown>;
                expect(out[chiave], `"${chiave}" ha lasciato passare testo libero`).toBe(
                    `[redatto:str/${testo.length}]`,
                );
            }
        });

        it('un a capo non passa: spezzerebbe la riga di log in due voci', () => {
            // Non è solo privacy: `\n` grezzo dentro un campo rompe la riga su Vercel, e il
            // pezzo dopo l'a capo si legge come una voce di log a sé — con dentro ciò che il
            // client ha scritto.
            const out = redact({ esito: 'ok\nKV_ERR msg=falso' }) as Record<string, unknown>;
            expect(out.esito).toBe('[redatto:str/19]');
        });

        it('un valore più lungo di 64 caratteri non è un enumerato', () => {
            const lungo = 'a'.repeat(65);
            const out = redact({ operazione: lungo }) as Record<string, unknown>;
            expect(out.operazione).toBe('[redatto:str/65]');
        });

        it('gli enumerati VERI del repo continuano a passare in chiaro', () => {
            // Misurati, non immaginati: sono i valori che il codice scrive davvero sotto queste
            // chiavi (1.261 letterali estratti da `src/`, il più lungo 45 caratteri). Se questo
            // test diventa rosso, la forma è troppo stretta e i log hanno perso la diagnosi.
            const out = redact({
                operazione: 'parent/presenze/comunica-assenza:POST',
                esito: 'body-json-malformato',
                stato: 'confermato',
                tipo: 'assenza_non_comunicata',
                azione: 'insert',
                periodo: '2026-07',
                mime: 'application/pdf',
                error_code: 'ASSENZA_DATA_PASSATA',
                entita_tipo: 'presenza',
                grado: 'primaria',
                ruolo: 'segreteria',
                canale: 'push',
                anno: '2026',
                formato: 'application/vnd.api+json',
            }) as Record<string, unknown>;
            expect(out.operazione).toBe('parent/presenze/comunica-assenza:POST');
            expect(out.esito).toBe('body-json-malformato');
            expect(out.stato).toBe('confermato');
            expect(out.tipo).toBe('assenza_non_comunicata');
            expect(out.azione).toBe('insert');
            expect(out.periodo).toBe('2026-07');
            expect(out.mime).toBe('application/pdf');
            expect(out.error_code).toBe('ASSENZA_DATA_PASSATA');
            expect(out.entita_tipo).toBe('presenza');
            expect(out.grado).toBe('primaria');
            expect(out.ruolo).toBe('segreteria');
            expect(out.canale).toBe('push');
            expect(out.anno).toBe('2026');
            expect(out.formato).toBe('application/vnd.api+json');
        });

        it('anche il nome di rotta con segmento dinamico passa: è un pattern, non un dato', () => {
            const out = redact({ operazione: 'admin/sections/[id]/teachers:DELETE' }) as Record<string, unknown>;
            expect(out.operazione).toBe('admin/sections/[id]/teachers:DELETE');
        });

        it('e il PATTERN DI PATH pure: sotto `operazione` ci arriva già ridotto', () => {
            // `instrumentation.ts` (onRequestError) scrive la rotta di render, `external.ts`
            // il pathname del provider passato da `redigiPath`. Senza lo slash iniziale nella
            // forma, l'unica colonna che dice DOVE è successo usciva `[redatto:str/10]`.
            const out = redact({ operazione: '/dashboard' }) as Record<string, unknown>;
            expect(out.operazione).toBe('/dashboard');
            const provider = redact({ operazione: '/v1/emails' }) as Record<string, unknown>;
            expect(provider.operazione).toBe('/v1/emails');
        });

        it('il motivo dell’assenza sotto una chiave in lista bianca non esce', () => {
            // Il caso concreto: un client che spedisce il dato sanitario sotto il nome di un
            // metadato. Prima usciva intero perché la chiave era `stato`.
            const out = redact({
                studentId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
                stato: 'ha la febbre da tre giorni, visita dal pediatra',
            }) as Record<string, unknown>;
            expect(JSON.stringify(out)).not.toContain('febbre');
            expect(out.studentId).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
        });
    });

    describe('M15 · le CHIAVI degli oggetti si trattano come i valori', () => {
        it('il testo nascosto nel NOME di una chiave non arriva in tabella', () => {
            // Il body reale della rotta: `motivo` è `z.unknown()`, quindi qualunque struttura
            // arriva fino a `redact`. Con `motivo` stringa il dato usciva `[redatto:str/N]`;
            // come CHIAVE usciva intero. Lo stesso dato, due trattamenti.
            const out = redact({
                studentId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
                data: '2026-01-15',
                motivo: { 'HA LA VARICELLA, RIENTRA IL 20': 1 },
            });
            expect(JSON.stringify(out)).not.toContain('VARICELLA');
        });

        it('e la riduzione della CHIAVE vale ovunque, non solo sotto `motivo`', () => {
            // Dal 2026-08-08 `motivo` è chiuso PRIMA, dalla politica per chiave di Q19: sotto
            // quel nome non si scende nemmeno, e il caso qui sopra non proverebbe più il
            // meccanismo delle chiavi. La proprietà va quindi verificata dove la riduzione del
            // NOME è ancora l'unica difesa che c'è — che è poi il caso generale: ogni chiave di
            // ogni oggetto del body grezzo, e i nomi dei query param, sono testo che arriva
            // dall'esterno.
            const out = redact({ dettaglio: { 'HA LA VARICELLA, RIENTRA IL 20': 1 } });
            const json = JSON.stringify(out);
            expect(json).not.toContain('VARICELLA');
            expect(json).toContain('[chiave-redatta:30]');
        });

        it('le chiavi normali restano intatte: il log deve restare leggibile', () => {
            const out = redact({
                alunno_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
                n_docenti: 3,
                riga_creata: true,
                dettaglio: { presenza_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302', n: 1 },
            }) as Record<string, unknown>;
            expect(Object.keys(out)).toEqual(['alunno_id', 'n_docenti', 'riga_creata', 'dettaglio']);
            expect(Object.keys(out.dettaglio as object)).toEqual(['presenza_id', 'n']);
        });

        it('due chiavi ostili non collassano in una: nessun campo sparisce', () => {
            // Se la chiave redatta fosse la stessa stringa per entrambe, la seconda
            // sovrascriverebbe la prima e il log direbbe che il campo era uno solo.
            const out = redact({ 'a b': 1, 'c d': 2 }) as Record<string, unknown>;
            expect(Object.keys(out)).toHaveLength(2);
            expect(Object.values(out).sort()).toEqual([1, 2]);
        });

        it('la chiave redatta non assolve il valore: la sensibilità si decide sul nome VERO', () => {
            // `password!` è fuori alfabeto (il `!`), quindi il NOME esce redatto — ma il valore
            // deve restare valutato per quello che la chiave dice: un segreto.
            const out = redact({ 'password!': 'hunter2', 'nome ': 'Mario' });
            const json = JSON.stringify(out);
            expect(json).not.toContain('hunter2');
            expect(json).not.toContain('Mario');
        });

        it('una chiave lunghissima non passa: è un canale come un altro', () => {
            const out = redact({ ['x'.repeat(65)]: 1 }) as Record<string, unknown>;
            expect(Object.keys(out)).toEqual(['[chiave-redatta:65]']);
        });
    });

    /**
     * Q19 · LA TERZA DIREZIONE: IL TIPO.
     *
     * Prima le chiavi (M15), poi il testo libero delle stringhe (M11), ora la FORMA del
     * valore. `redactValore` decideva `typeof v === 'number' || 'boolean'` PRIMA di guardare
     * la chiave, e il tipo lo sceglie chi manda la richiesta: `motivo` è dichiarato
     * `z.unknown()` nello schema della rotta, quindi `{"motivo": 40404}` usciva in chiaro
     * mentre `{"motivo":"40404"}` usciva `[redatto:str/5]`. Lo stesso dato, due trattamenti,
     * decisi dal client — che è la stessa frase scritta per M11 e per M15.
     *
     * Il caso non è ipotetico: misurato in produzione, `contesto->'payload'->'body'->>'motivo'`
     * = `40404` con `jsonb_typeof` = `number`, su 18 occorrenze, e una riga preesistente della
     * stessa forma con `stato_http=429`. Il valore non viene nemmeno archiviato in `presenze`
     * (`motivoNormalizzato` scarta i non-string): un dato che l'applicazione RIFIUTA di
     * scrivere nel registro sopravviveva 30 giorni in `app_log`.
     *
     * Il lock prova ENTRAMBE le direzioni, e la seconda conta quanto la prima: se si chiudesse
     * il canale spegnendo i numeri, i log smetterebbero di essere interrogabili — conteggi,
     * stati HTTP, durate e uuid sono l'unica cosa che rende `app_log` una tabella e non un
     * archivio di stringhe redatte.
     */
    describe('Q19 · la CHIAVE decide prima del TIPO', () => {
        it('il motivo dell’assenza non esce, qualunque forma gli dia il client', () => {
            // Le quattro forme che `z.unknown()` lascia arrivare fino a `redact`.
            const numero = redact({ motivo: 40404 }) as Record<string, unknown>;
            expect(numero.motivo, 'un motivo NUMERICO è uscito in chiaro').not.toBe(40404);
            expect(JSON.stringify(numero)).not.toContain('40404');

            const booleano = redact({ motivo: true }) as Record<string, unknown>;
            expect(booleano.motivo).not.toBe(true);

            const oggetto = redact({ motivo: { varicella: 1 } });
            expect(JSON.stringify(oggetto)).not.toContain('varicella');

            const lista = redact({ motivo: [39.5, 'febbre'] });
            expect(JSON.stringify(lista)).not.toContain('39.5');
        });

        it('e nemmeno le altre colonne di testo libero su un minore', () => {
            const out = redact({
                giustificazione_testo: 1234,
                note_appello: true,
                note_mediche: 7,
                diagnosi: 9,
                allergie: 3,
                descrizione: 42,
            }) as Record<string, unknown>;
            const json = JSON.stringify(out);
            for (const valore of ['1234', 'true', '7', '9', '3', '42']) {
                expect(json, `un valore di testo libero è uscito in chiaro: ${valore}`).not.toContain(valore);
            }
        });

        it('il campo però NON sparisce: il log deve poter dire «c’era»', () => {
            // Fail-closed non vuol dire cieco. `[redatto:num]` dice che il campo era presente e
            // di che forma era: metà della diagnosi di un 400 sta lì.
            const out = redact({ motivo: 40404 }) as Record<string, unknown>;
            expect(Object.keys(out)).toEqual(['motivo']);
            expect(String(out.motivo)).toMatch(/^\[redatto/);
        });

        it('DIREZIONE OPPOSTA · conteggi, stati, durate e uuid continuano a passare', () => {
            // Se questa cade, il canale è stato spento invece che chiuso: `app_log` non si
            // interroga più. Sono i campi che i logger di questo repo scrivono davvero.
            const out = redact({
                alunno_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
                stato: 403,
                ms: 120,
                n_righe: 42,
                occorrenze: 3,
                mesi: 12,
                letto: false,
                riga_creata: true,
                esito: 'ok',
                operazione: 'parent/presenze/comunica-assenza:POST',
                error_code: 'ASSENZA_DATA_PASSATA',
                creato_il: '2026-08-08T04:59:00.000Z',
            }) as Record<string, unknown>;
            expect(out).toMatchObject({
                alunno_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
                stato: 403,
                ms: 120,
                n_righe: 42,
                occorrenze: 3,
                mesi: 12,
                letto: false,
                riga_creata: true,
                esito: 'ok',
                operazione: 'parent/presenze/comunica-assenza:POST',
                error_code: 'ASSENZA_DATA_PASSATA',
                creato_il: '2026-08-08T04:59:00.000Z',
            });
        });

        it('DIREZIONE OPPOSTA · una chiave che CONTIENE una radice non è la radice', () => {
            // `notifiche`, `annotazioni_n`, `motivazionale` non sono canali di testo libero:
            // una radice troppo golosa spegnerebbe log innocui, ed è il modo in cui una difesa
            // viene disattivata sei mesi dopo perché «dà fastidio».
            const out = redact({ notifiche: 3, denominatore: 8, promotore: 1 }) as Record<string, unknown>;
            expect(out).toMatchObject({ notifiche: 3, denominatore: 8, promotore: 1 });
        });
    });

    /**
     * Q2 · NEL PAYLOAD GREZZO LA CHIAVE NON APRE, PERCHÉ LA CHIAVE LA SCRIVE IL CLIENT.
     *
     * `FORMA_ENUMERATO` ha chiuso il testo libero *con spazi*, e il modulo lo dichiarava
     * onestamente: «un token SENZA spazi e più corto di 64 caratteri passa ancora». Misurato
     * nel quarto collaudo, con la sola sessione di un genitore:
     *   `{"stato":"XXXXXX00X00X000X-SINTETICO","esito":"diagnosi-inventata-per-collaudo",
     *     "tipo":"AAABBB99C99D999E"}` → tutti e tre in chiaro in `app_log`, 30 giorni.
     * La prosa unita da trattini di spazi non ne ha, e un codice fiscale nemmeno.
     *
     * La difesa non poteva stare nella FORMA — `diagnosi-inventata-per-collaudo` e
     * `body-json-malformato` sono la stessa forma — quindi sta nella PROVENIENZA: sotto
     * `payload` c'è ciò che ha spedito il client (`parseBody` deposita il body grezzo prima
     * di zod), e lì nessuna chiave in lista bianca apre. Nei `campi` la lista bianca resta,
     * perché quei valori li sceglie il nostro codice.
     */
    describe('Q2 · il payload grezzo è input, non un log che scriviamo noi', () => {
        it('sotto le chiavi in lista bianca, nel payload, non passa nessun valore del client', () => {
            for (const chiave of CHIAVI_IN_CHIARO) {
                const out = redactInput({ [chiave]: 'diagnosi-inventata-per-collaudo' }) as Record<string, unknown>;
                expect(out[chiave], `"${chiave}" apre ancora nel payload grezzo`).toBe('[redatto:str/31]');
            }
        });

        it('DIREZIONE OPPOSTA · uuid, date e conteggi restano leggibili anche nel payload', () => {
            // Senza questi, un 400 diventa indiagnosticabile: sono i campi con cui si ritrova
            // la richiesta e il bambino a cui si riferiva.
            const out = redactInput({
                studentId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
                data: '2026-08-30',
                limit: 60,
                letto: true,
            }) as Record<string, unknown>;
            expect(out).toMatchObject({
                studentId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
                data: '2026-08-30',
                limit: 60,
                letto: true,
            });
        });

        it('e i CAMPI che scriviamo noi restano in chiaro: i log devono restare interrogabili', () => {
            const out = redact({ operazione: 'parent/presenze/comunica-assenza:POST', esito: 'ok' }) as Record<string, unknown>;
            expect(out.operazione).toBe('parent/presenze/comunica-assenza:POST');
            expect(out.esito).toBe('ok');
        });

        it('IL PERCORSO VERO · parseBody non deposita il valore del client in chiaro', async () => {
            const schema = z.object({ studentId: z.string(), data: z.string() });
            await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
                const req = new Request('http://localhost/api/x', {
                    method: 'POST',
                    body: JSON.stringify({
                        studentId: '00000000-0000-0000-0000-000000000000',
                        data: '1900-01-01',
                        stato: 'XXXXXX00X00X000X-SINTETICO',
                        esito: 'diagnosi-inventata-per-collaudo',
                        tipo: 'AAABBB99C99D999E',
                    }),
                    headers: { 'content-type': 'application/json' },
                });
                await parseBody(req, schema);
                const json = JSON.stringify(contesto()?.payload?.body);
                expect(json).not.toContain('SINTETICO');
                expect(json).not.toContain('diagnosi');
                expect(json).not.toContain('AAABBB99C99D999E');
                // Ma la richiesta resta ricostruibile: l'alunno e il giorno ci sono.
                expect(json).toContain('00000000-0000-0000-0000-000000000000');
                expect(json).toContain('1900-01-01');
            });
        });

        it('il MARCATORE che scriviamo noi sul body malformato resta leggibile', async () => {
            // `parseBody` deposita `esito: 'body-json-malformato'` quando non c'è un JSON da
            // depositare: non è input del client, è la nostra diagnosi. Se uscisse redatto,
            // «non ha loggato il corpo» e «un corpo non ce l'aveva» tornerebbero a leggersi
            // uguali — che è il motivo per cui quel marcatore esiste.
            const schema = z.object({ a: z.string() });
            await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
                const req = new Request('http://localhost/api/x', {
                    method: 'POST',
                    body: '{"a":',
                    headers: { 'content-type': 'application/json' },
                });
                await parseBody(req, schema);
                expect((contesto()?.payload?.body as Record<string, unknown>)?.esito)
                    .toBe('body-json-malformato');
            });
        });
    });

    /**
     * Q2 (seconda metà) · LA FORMA DI UN CODICE FISCALE NON È UN ENUMERATO, MAI.
     *
     * Misurata in tabella una riga non del collaudo, scritta da un `educator`:
     * `"sezione": "RSSMRA80A01H501U"` in chiaro dentro `campi` E dentro `payload.query`. Il
     * nome della classe arriva da un query param, il nostro codice lo rimette nei campi, e
     * sedici caratteri senza spazi sono un enumerato perfetto.
     *
     * Il codice fiscale è l'unico identificatore di questo dominio che si riconosce dalla
     * FORMA senza ambiguità, e in produzione ce ne sono centinaia — di minori. Nessuno dei
     * 1.261 valori letterali che `src/` scrive sotto le chiavi in lista bianca ha quella
     * forma: escluderla non costa un log e chiude il caso ovunque appaia, campi compresi.
     */
    describe('Q2 · un codice fiscale non passa da nessuna chiave', () => {
        it('nemmeno sotto una chiave in lista bianca, nemmeno nei campi', () => {
            for (const chiave of CHIAVI_IN_CHIARO) {
                const out = redact({ [chiave]: 'RSSMRA80A01H501U' }) as Record<string, unknown>;
                expect(out[chiave], `"${chiave}" ha lasciato passare un codice fiscale`).toBe('[redatto:str/16]');
            }
            // Minuscolo e con spazi attorno: è come arriva da un query param scritto a mano.
            const minuscolo = redact({ sezione: 'rssmra80a01h501u' }) as Record<string, unknown>;
            expect(minuscolo.sezione).toBe('[redatto:str/16]');
        });

        it('DIREZIONE OPPOSTA · i nomi di sezione veri continuano a passare', () => {
            // Se questa cade, la forma è troppo larga e si è spento un metadato di dominio.
            const out = redact({
                sezione: 'TEST-1A',
                classe_sezione: 'Primavera-A',
                operazione: 'admin/sections/[id]/teachers:DELETE',
                error_code: 'ASSENZA_DATA_PASSATA',
            }) as Record<string, unknown>;
            expect(out).toMatchObject({
                sezione: 'TEST-1A',
                classe_sezione: 'Primavera-A',
                operazione: 'admin/sections/[id]/teachers:DELETE',
                error_code: 'ASSENZA_DATA_PASSATA',
            });
        });
    });

    describe('Q19 · coda: le radici non sono golose', () => {
        it('una chiave che CONTIENE una radice non è la radice', () => {
            // `notifiche`, `annotazioni_n`, `motivazionale` non sono canali di testo libero:
            // una radice troppo golosa spegnerebbe log innocui, ed è il modo in cui una difesa
            // viene disattivata sei mesi dopo perché «dà fastidio».
            const out = redact({ notifiche: 3, denominatore: 8, promotore: 1 }) as Record<string, unknown>;
            expect(out).toMatchObject({ notifiche: 3, denominatore: 8, promotore: 1 });
        });
    });
});
