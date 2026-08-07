import { describe, it, expect } from 'vitest';
import { redact, CHIAVI_IN_CHIARO } from '@/lib/logging/redact';

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
});
