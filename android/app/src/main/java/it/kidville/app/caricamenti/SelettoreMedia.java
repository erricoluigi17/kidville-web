package it.kidville.app.caricamenti;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.StatFs;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Log;

import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import it.kidville.app.caricamenti.CodaCaricamenti.Origine;
import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.ElaborazioneFoto.FotoRifiutata;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.CodiceRifiuto;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.RichiestaAccodamento;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.RifiutoAccodamento;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.RisultatoAccodamento;
import it.kidville.app.caricamenti.RegistroNativo.ClasseErrore;
import it.kidville.app.caricamenti.RegistroNativo.MotivoPreparazione;
import it.kidville.app.caricamenti.RegistroNativo.TipoMedia;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/**
 * IL SELETTORE DEI MEDIA: l'insegnante sceglie foto e video, e il nativo li prepara PRIMA di rispondere al JavaScript.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.2-§4.3 `scegliMedia`/`leggiFoto`/`scartaScelti`/`accodaVideo`,
 *  §6.3, §9; compito A3)
 *
 * ─── CHE COSA FA ─────────────────────────────────────────────────────────────────────────────
 *  1. APRE il selettore di sistema: il Photo Picker (galleria: foto e video, nessun permesso) o l'`ACTION_OPEN_DOCUMENT` di SAF
 *     («Scegli da File»). Nessun permesso sui media, in nessun caso: è il vantaggio da proteggere (`docs/submission/C2-build-aab.md`).
 *  2. PREPARA ogni elemento scelto, uno dopo l'altro, su un thread suo: i VIDEO sono copiati in `scelti/<id>.<ext>` con lo SHA-256
 *     calcolato durante la copia e una miniatura; le FOTO sono ridotte a JPEG ≤ 1920 px senza metadati (`ElaborazioneFoto`); gli
 *     elementi che non entrano tornano come `rifiutato` col motivo. I rifiuti costano zero byte copiati (peso e durata si leggono
 *     PRIMA, lo spazio si controlla prima di scrivere).
 *  3. TIENE IL REGISTRO dei preparati ({@link Preparati}): `leggiFoto` consegna una foto UNA volta e la cancella, `scartaScelti`
 *     cancella ciò che non serve più, e {@link #accodaPreparato} consegna un video al motore (`accodaVideo`).
 *
 * ─── COME È FATTO ────────────────────────────────────────────────────────────────────────────
 *  · LA LOGICA È PURA, IL MONDO È UN'INTERFACCIA. Tutto ciò che si decide — il tipo di un elemento dal MIME e dal nome, i rifiuti, lo
 *    spazio, la copia con impronta, l'annullamento, l'avanzamento, la forma del JSON — sta in funzioni e classi senza `android.*`,
 *    provate in JUnit con file veri su una cartella temporanea. Ciò che tocca Android sta in due piccole classi: {@link ElementoDaUri}
 *    (nome, peso, tipo, durata e flusso di un indirizzo di contenuto) e {@link StrumentiAndroid} (spazio libero, riduzione delle foto,
 *    miniatura, segnalazione dei guasti), dietro le interfacce {@link ElementoSorgente} e {@link Strumenti}.
 *  · I PREPARATI VIVONO IN `scelti/` (cartella privata, fuori dal backup) e si cancellano a ogni passo: dopo `leggiFoto`, dopo
 *    `scartaScelti`, dopo l'accodamento (il file si SPOSTA in `file/`), se la scelta è annullata, e comunque dopo 24 ore (la pulizia
 *    del motore). Il registro in memoria ricorda per ogni id peso, `sha256`, MIME, nome e dimensioni; è del processo, non del plugin:
 *    un'Activity ricreata non perde i preparati.
 *  · L'IDENTITÀ DI UN ELEMENTO È UN GETTONE `g-<uuid>` (galleria) o `f-<uuid>` (file), senza separatori né punti (`schemaIdElemento`):
 *    dà il nome ai file, e dal prefisso si ricava l'origine.
 *  · NIENTE NOMI NÉ INDIRIZZI NEI LOG: il nome di un file è solo per lo schermo (può contenere il nome di un bambino) e non entra mai
 *    in una riga di log; i guasti «nostri» passano da `Strumenti.segnalaFallimento`, che scrive `media-nativo-preparazione-fallita`
 *    con il TIPO e la CLASSE dell'errore, mai un messaggio. Qui dentro, `android.util.Log` lo usano solo le due classi Android.
 *  · I FALLIMENTI SONO VALORI: un elemento che non si prepara diventa un `rifiutato` col suo motivo, mai un'eccezione che butti via gli
 *    altri 49 della scelta.
 *
 * ─── COSA SI PROVA IN JUNIT, E COSA NO ───────────────────────────────────────────────────────
 * Si prova tutto tranne le chiamate ad Android: gli intent e il Photo Picker, `ContentResolver`, `StatFs`, `MediaMetadataRetriever` e i
 * decodificatori di immagini. Lì il compilatore (`assembleDebug`) controlla le firme e il collaudo (C1, E1) le esegue su telefono.
 */
public final class SelettoreMedia {

    private SelettoreMedia() {
    }

    private static final String TAG = "KidvilleCaricamenti";

    /* ────────────────────────────────────────────────────────────────────────────
     * COSTANTI
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Prima di copiare un video lo spazio libero deve superare il suo peso di almeno 200 MB (spec §6.3). */
    public static final long MARGINE_SPAZIO_BYTE = 200L * 1024L * 1024L;
    /** Dopo un errore di scrittura, sotto questo spazio libero il disco è considerato pieno (e il rifiuto è `spazio-insufficiente`). */
    public static final long SOGLIA_DISCO_PIENO_BYTE = 16L * 1024L * 1024L;
    /** La copia procede a blocchi da 256 KB, e a ogni blocco controlla l'annullamento. */
    public static final int BLOCCO_COPIA_BYTE = 256 * 1024;
    /** Al più un evento `preparazione` ogni 250 ms durante una copia (gli eventi di fine elemento partono sempre). */
    public static final long INTERVALLO_EVENTI_MS = 250L;
    /** Quanti elementi per scelta si accettano al massimo: il JavaScript ne passa 50, un numero più alto è un errore di chi chiama. */
    public static final int MASSIMO_ELEMENTI_ACCETTATO = 1000;
    /** I tetti del contratto (`caricamenti-nativi-tipi.ts`, `limiti.ts`): un test li confronta con i file TypeScript. */
    public static final int LATO_MASSIMO_FOTO = 1920;
    public static final int DURATA_MASSIMA_VIDEO_SECONDI = 300;

    public static final String NOME_FOTO_DI_RIPIEGO = "Foto";
    public static final String NOME_FILE_DI_RIPIEGO = "File";
    public static final String MIME_VIDEO_DI_RIPIEGO = "video/mp4";
    public static final String ESTENSIONE_VIDEO_DI_RIPIEGO = "mp4";
    public static final String MIME_FOTO_RIDOTTA = "image/jpeg";

    /** I tipi che «Scegli da File» chiede al selettore di documenti. */
    static final String[] MIME_DEL_SELETTORE_FILE = {"video/*", "image/*"};

    /** Un gettone da 1 a 64 caratteri senza separatori né punti: la forma di `schemaIdElemento`. */
    static final Pattern FORMA_ID = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
    private static final Pattern FORMA_SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern FORMA_ESTENSIONE = Pattern.compile("^[a-z0-9]{1,5}$");

    /** Il thread su cui si prepara: uno solo, perché due copie insieme si contenderebbero il disco e lo spazio che si è appena controllato. */
    private static final ExecutorService ESECUTORE = Executors.newSingleThreadExecutor(lavoro -> {
        Thread filo = new Thread(lavoro, "kv-preparazione-media");
        filo.setDaemon(true);
        return filo;
    });

    /** Dove si prepara: l'unico esecutore dei lavori lunghi del selettore (preparazione e creazione dell'elemento di prova). */
    static ExecutorService esecutore() {
        return ESECUTORE;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * I VOCABOLARI
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Da dove si sceglie (`SORGENTI_SCELTA` di `caricamenti-nativi-tipi.ts`): il prefisso dà il nome agli id, l'origine va in coda. */
    public enum Sorgente {
        GALLERIA("galleria", "g", Origine.GALLERIA),
        FILE("file", "f", Origine.FILE);

        public final String valore;
        public final String prefissoId;
        public final Origine origine;

        Sorgente(String valore, String prefissoId, Origine origine) {
            this.valore = valore;
            this.prefissoId = prefissoId;
            this.origine = origine;
        }

        public static Sorgente daValore(String valore) {
            for (Sorgente s : values()) {
                if (s.valore.equals(valore)) return s;
            }
            return null;
        }
    }

    /** Che cosa è un elemento scelto (`origine` di un `rifiutato`: `foto`, `video` o `altro`). */
    public enum TipoElemento {
        FOTO("foto"),
        VIDEO("video"),
        ALTRO("altro");

        public final String valore;

        TipoElemento(String valore) {
            this.valore = valore;
        }
    }

    /**
     * Perché un elemento non entra (`MOTIVI_RIFIUTO` di `caricamenti-nativi-tipi.ts`). `icloud-non-disponibile` è di iOS: su Android un
     * contenuto che non si riesce a scaricare dal cloud è «non si riesce a leggere».
     */
    public enum MotivoRifiuto {
        TROPPO_GRANDE("troppo-grande"),
        TROPPO_LUNGO("troppo-lungo"),
        FORMATO_NON_SUPPORTATO("formato-non-supportato"),
        ILLEGGIBILE("illeggibile"),
        SPAZIO_INSUFFICIENTE("spazio-insufficiente");

        public final String valore;

        MotivoRifiuto(String valore) {
            this.valore = valore;
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE OPZIONI DI `scegliMedia`
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Le opzioni di `scegliMedia` fuori dai limiti del contratto: il ponte risponde `PARAMETRI_NON_VALIDI` (messaggio costante). */
    public static final class OpzioniNonValide extends Exception {
        OpzioniNonValide() {
            super("PARAMETRI_NON_VALIDI");
        }
    }

    /**
     * Le opzioni di una scelta. I limiti li passa il JavaScript (`opzioniScegliMedia`) e il nativo non li riscrive: qui si controlla solo
     * che siano dentro i tetti del contratto, così un numero sbagliato non allarga la scelta né, con uno zero, la spalanca.
     */
    public static final class Opzioni {
        public final Sorgente sorgente;
        public final int massimoElementi;
        public final int latoMassimoFoto;
        public final double qualitaFoto;
        public final long byteMassimiVideo;
        public final int durataMassimaVideoSecondi;

        public Opzioni(Sorgente sorgente, int massimoElementi, int latoMassimoFoto, double qualitaFoto, long byteMassimiVideo,
                       int durataMassimaVideoSecondi) {
            this.sorgente = sorgente;
            this.massimoElementi = massimoElementi;
            this.latoMassimoFoto = latoMassimoFoto;
            this.qualitaFoto = qualitaFoto;
            this.byteMassimiVideo = byteMassimiVideo;
            this.durataMassimaVideoSecondi = durataMassimaVideoSecondi;
        }

        /**
         * Rilegge `dati` (la chiamata del ponte). Ogni campo deve esserci, essere un numero (o la stringa `sorgente`) e stare nel suo
         * intervallo: sorgente `galleria`/`file`; elementi 1-1000; lato 1-1920; qualità in (0, 1]; peso 1-2 GB; durata 1-300 s.
         */
        public static Opzioni da(JSONObject dati) throws OpzioniNonValide {
            if (dati == null) throw new OpzioniNonValide();
            Object testoSorgente = dati.opt("sorgente");
            Sorgente sorgente = testoSorgente instanceof String ? Sorgente.daValore((String) testoSorgente) : null;
            if (sorgente == null) throw new OpzioniNonValide();
            long massimoElementi = intero(dati, "massimoElementi", 1L, MASSIMO_ELEMENTI_ACCETTATO);
            long lato = intero(dati, "latoMassimoFoto", 1L, LATO_MASSIMO_FOTO);
            Object grezzaQualita = dati.opt("qualitaFoto");
            if (!(grezzaQualita instanceof Number)) throw new OpzioniNonValide();
            double qualita = ((Number) grezzaQualita).doubleValue();
            if (Double.isNaN(qualita) || Double.isInfinite(qualita) || qualita <= 0.0 || qualita > 1.0) throw new OpzioniNonValide();
            long byteMassimi = intero(dati, "byteMassimiVideo", 1L, CodaCaricamenti.MAX_VIDEO_INPUT_BYTES);
            long durata = intero(dati, "durataMassimaVideoSecondi", 1L, DURATA_MASSIMA_VIDEO_SECONDI);
            return new Opzioni(sorgente, (int) massimoElementi, (int) lato, qualita, byteMassimi, (int) durata);
        }
    }

    /** Un intero fra `minimo` e `massimo` (inclusi): un numero con la virgola, una stringa o un valore mancante sono un rifiuto. */
    static long intero(JSONObject dati, String chiave, long minimo, long massimo) throws OpzioniNonValide {
        Object grezzo = dati.opt(chiave);
        if (!(grezzo instanceof Number)) throw new OpzioniNonValide();
        double d = ((Number) grezzo).doubleValue();
        if (Double.isNaN(d) || Double.isInfinite(d) || d != Math.rint(d) || d < minimo || d > massimo) throw new OpzioniNonValide();
        return ((Number) grezzo).longValue();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL SELETTORE DI SISTEMA (Android: non si prova sulla JVM)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Il tetto del Photo Picker prima di API 33, dove `MediaStore.getPickImagesMaxLimit()` non c'è: quello che arriva con l'estensione dei
     * servizi del telefono ha lo stesso limite di 100. Senza un tetto, una richiesta per più elementi farebbe lanciare il contratto di androidx
     * (che rifiuta un massimo sopra il limite) su quei telefoni.
     */
    static final int LIMITE_SELETTORE_PRIMA_DI_API_33 = 100;

    /**
     * Quanti elementi chiedere al Photo Picker: quelli voluti, ma non oltre il limite del sistema (`MediaStore.getPickImagesMaxLimit()` da
     * API 33, {@link #LIMITE_SELETTORE_PRIMA_DI_API_33} sotto), passato da chi chiama. Il contratto di androidx rifiuta un massimo sopra il limite.
     */
    static int tettoDelSelettore(int massimoElementi, int limiteDelSistema) {
        return Math.min(massimoElementi, limiteDelSistema);
    }

    /**
     * L'intent da lanciare. GALLERIA: il Photo Picker di sistema con foto e video (da API 33, o con l'estensione dei servizi del telefono;
     * dove manca androidx ripiega su `ACTION_OPEN_DOCUMENT`): nessun permesso. FILE: SAF, `ACTION_OPEN_DOCUMENT` per video e immagini,
     * con la scelta multipla se c'è più di un posto. Con un solo posto il Photo Picker è quello a scelta singola.
     */
    public static Intent creaIntent(Context contesto, Sorgente sorgente, int massimoElementi) {
        if (sorgente == Sorgente.FILE) {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, MIME_DEL_SELETTORE_FILE);
            if (massimoElementi > 1) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            return intent;
        }
        int limite = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? MediaStore.getPickImagesMaxLimit() : LIMITE_SELETTORE_PRIMA_DI_API_33;
        int tetto = tettoDelSelettore(massimoElementi, limite);
        PickVisualMediaRequest richiesta = new PickVisualMediaRequest.Builder()
                .setMediaType(ActivityResultContracts.PickVisualMedia.ImageAndVideo.INSTANCE).build();
        if (tetto > 1) return new ActivityResultContracts.PickMultipleVisualMedia(tetto).createIntent(contesto, richiesta);
        return new ActivityResultContracts.PickVisualMedia().createIntent(contesto, richiesta);
    }

    /**
     * Gli indirizzi scelti, nell'ordine in cui il selettore li ha consegnati, senza doppioni e tagliati a `massimoElementi` (SAF non sa
     * limitare la scelta). Vuoto se l'intent non ne porta (selettore chiuso senza scelta).
     */
    public static List<Uri> estraiUri(Intent dati, int massimoElementi) {
        LinkedHashSet<Uri> scelti = new LinkedHashSet<>();
        if (dati != null) {
            if (dati.getData() != null) scelti.add(dati.getData());
            ClipData clip = dati.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri uri = clip.getItemAt(i).getUri();
                    if (uri != null) scelti.add(uri);
                }
            }
        }
        List<Uri> risultato = new ArrayList<>(scelti);
        if (risultato.size() > massimoElementi) return new ArrayList<>(risultato.subList(0, Math.max(massimoElementi, 0)));
        return risultato;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * UN ELEMENTO SCELTO, E IL MONDO
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Un elemento scelto, com'è prima di prepararlo. In produzione {@link ElementoDaUri}; nei test uno finto, con byte veri. */
    public interface ElementoSorgente {
        /** Il nome da mostrare (può essere `null`: si ripiega su «Video», «Foto» o «File»). Mai in un log. */
        String nome();

        /** Il peso dichiarato dal fornitore del contenuto; `-1` se non lo dice. */
        long byteDichiarati();

        /** Il tipo MIME dichiarato; `null` se non lo dice. */
        String mimeDichiarato();

        /** La durata del video in ms, quando il telefono la sa dire senza copiare niente; `-1` se non la sa. Best effort. */
        long durataMs();

        /** Apre il contenuto. Si chiama una volta per elemento. */
        InputStream apri() throws IOException;
    }

    /** Ciò che serve al selettore dal telefono: spazio, orologio, riduzione delle foto, analisi dei video e segnalazione dei guasti. */
    public interface Strumenti {
        /** Lo spazio libero, in byte, sul volume della cartella dei preparati. */
        long spazioDisponibile(File cartella);

        /** Un orologio monotono in millisecondi (per diradare gli eventi di avanzamento). */
        long adesso();

        /** Durata e miniatura della COPIA di un video. Non lancia mai. */
        MiniaturaVideo.Analisi analizzaVideo(File copia);

        /** Riduce una foto (vedi {@link ElaborazioneFoto#riduci}). */
        ElaborazioneFoto.Riduzione riduciFoto(File originale, File destinazione, int latoMassimo, int qualita) throws FotoRifiutata;

        /** Scrive `media-nativo-preparazione-fallita`: un guasto NOSTRO (non un rifiuto atteso), con tipo, motivo e classe dell'errore. */
        void segnalaFallimento(TipoMedia tipo, MotivoPreparazione motivo, ClasseErrore classe);
    }

    /**
     * Un indirizzo di contenuto (`content://`) scelto dall'insegnante. Android: `ContentResolver` per nome, peso, tipo e flusso,
     * `MediaMetadataRetriever` per la durata. Un'interrogazione che fallisce non ferma la scelta: il dato vale «non lo so».
     */
    public static final class ElementoDaUri implements ElementoSorgente {
        private final Context contesto;
        private final Uri uri;
        private boolean interrogato;
        private String nomeLetto;
        private long pesoLetto = -1L;

        public ElementoDaUri(Context contesto, Uri uri) {
            this.contesto = contesto.getApplicationContext();
            this.uri = uri;
        }

        /** Nome e peso con UNA interrogazione: `OpenableColumns` è la sola via che non chiede permessi e che i provider sanno tutti. */
        private synchronized void interroga() {
            if (interrogato) return;
            interrogato = true;
            try (Cursor cursore = contesto.getContentResolver().query(uri,
                    new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (cursore != null && cursore.moveToFirst()) {
                    int colonnaNome = cursore.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (colonnaNome >= 0 && !cursore.isNull(colonnaNome)) nomeLetto = cursore.getString(colonnaNome);
                    int colonnaPeso = cursore.getColumnIndex(OpenableColumns.SIZE);
                    if (colonnaPeso >= 0 && !cursore.isNull(colonnaPeso)) {
                        long peso = cursore.getLong(colonnaPeso);
                        pesoLetto = peso >= 0L ? peso : -1L;
                    }
                }
            } catch (RuntimeException nonLetto) {
                Log.w(TAG, "interrogazione del contenuto non riuscita (" + nonLetto.getClass().getSimpleName() + ")");
            }
        }

        @Override
        public String nome() {
            interroga();
            return nomeLetto;
        }

        @Override
        public long byteDichiarati() {
            interroga();
            return pesoLetto;
        }

        @Override
        public String mimeDichiarato() {
            try {
                return contesto.getContentResolver().getType(uri);
            } catch (RuntimeException nonLetto) {
                Log.w(TAG, "tipo del contenuto non leggibile (" + nonLetto.getClass().getSimpleName() + ")");
                return null;
            }
        }

        @Override
        public long durataMs() {
            MediaMetadataRetriever lettore = new MediaMetadataRetriever();
            try {
                lettore.setDataSource(contesto, uri);
                String durata = lettore.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                return durata == null ? -1L : Long.parseLong(durata.trim());
            } catch (RuntimeException nonLetta) {
                // Un fornitore che non permette l'accesso casuale (un flusso) o un formato che il telefono non apre: la durata si
                // misura sulla copia, dopo.
                return -1L;
            } finally {
                MiniaturaVideo.rilascia(lettore);
            }
        }

        @Override
        public InputStream apri() throws IOException {
            ContentResolver resolver = contesto.getContentResolver();
            InputStream flusso = resolver.openInputStream(uri);
            if (flusso == null) throw new FileNotFoundException("contenuto non apribile");
            return flusso;
        }
    }

    /** Il telefono vero: `StatFs`, il motore (per il registro dei guasti), il decodificatore di immagini e il lettore dei video. */
    public static final class StrumentiAndroid implements Strumenti {
        private final Context contesto;

        public StrumentiAndroid(Context contesto) {
            this.contesto = contesto.getApplicationContext();
        }

        @Override
        public long spazioDisponibile(File cartella) {
            try {
                return new StatFs(cartella.getPath()).getAvailableBytes();
            } catch (RuntimeException nonLeggibile) {
                // Se non si sa quanto spazio c'è non si rifiuta: il disco pieno lo dirà la copia (`IOException`).
                Log.w(TAG, "spazio libero non leggibile (" + nonLeggibile.getClass().getSimpleName() + ")");
                return Long.MAX_VALUE;
            }
        }

        @Override
        public long adesso() {
            return SystemClock.elapsedRealtime();
        }

        @Override
        public MiniaturaVideo.Analisi analizzaVideo(File copia) {
            return MiniaturaVideo.analizza(copia);
        }

        @Override
        public ElaborazioneFoto.Riduzione riduciFoto(File originale, File destinazione, int latoMassimo, int qualita) throws FotoRifiutata {
            int sdk = Build.VERSION.SDK_INT;
            return ElaborazioneFoto.riduci(originale, destinazione, latoMassimo, qualita, sdk, new ElaborazioneFoto.CodecAndroid(sdk));
        }

        @Override
        public void segnalaFallimento(TipoMedia tipo, MotivoPreparazione motivo, ClasseErrore classe) {
            try {
                PianificatoreCaricamenti motore = PianificatoreCaricamenti.condiviso(contesto);
                motore.registro().preparazioneFallita(utenteDiRiferimento(), tipo, motivo, classe);
                motore.svuotaIlRegistro();
            } catch (RuntimeException guasto) {
                Log.e(TAG, "segnalazione del guasto non riuscita (" + guasto.getClass().getSimpleName() + ")");
            }
        }
    }

    /**
     * L'ultimo utente che il JavaScript ha nominato (`elenco`, `accodaVideo`): serve solo a dare un `x-user-id` alle righe di log di una
     * scelta, che altrimenti non ne avrebbe. È un uuid, mai un nome. `null` finché nessuno è stato nominato.
     */
    private static volatile String ultimoUtente;

    public static void ricordaUtente(String utenteId) {
        if (eUuidMinuscolo(utenteId)) ultimoUtente = utenteId;
    }

    /** Un uuid in minuscolo (8-4-4-4-12): la forma di `schemaUuid` e di ogni identificativo che il ponte porta. */
    static boolean eUuidMinuscolo(String testo) {
        return testo != null && FORMA_UUID.matcher(testo).matches();
    }

    /**
     * Quanto si aspetta il selettore di sistema prima di considerare una scelta abbandonata (15 minuti). Se il risultato di un selettore
     * non arrivasse mai (un'Activity ricreata che non ritrova la chiamata) la scelta resterebbe «in corso» e nessuna nuova potrebbe partire
     * fino al riavvio del processo.
     */
    public static final long ATTESA_MASSIMA_SELETTORE_MS = 15L * 60L * 1000L;

    /**
     * Vero se una scelta in corso va considerata abbandonata: ancora al selettore (la preparazione non è mai partita) da più di
     * {@link #ATTESA_MASSIMA_SELETTORE_MS}. Una scelta in preparazione non è mai abbandonata: una copia da 2 GB può durare minuti.
     */
    public static boolean sceltaAbbandonata(boolean inPreparazione, long etaMs) {
        return !inPreparazione && etaMs > ATTESA_MASSIMA_SELETTORE_MS;
    }

    static UUID utenteDiRiferimento() {
        String utente = ultimoUtente;
        return utente == null ? null : UUID.fromString(utente);
    }

    private static final Pattern FORMA_UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");

    /* ────────────────────────────────────────────────────────────────────────────
     * LE SCELTE PURE: tipo, nome, estensione, spazio
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Estensione → MIME, per i formati che il selettore può consegnare con un tipo generico. Fatta a mano: `MimeTypeMap` non esiste sulla JVM. */
    private static final String[][] ESTENSIONI_E_MIME = {
            {"jpg", "image/jpeg"}, {"jpeg", "image/jpeg"}, {"png", "image/png"}, {"gif", "image/gif"}, {"webp", "image/webp"},
            {"bmp", "image/bmp"}, {"heic", "image/heic"}, {"heif", "image/heif"}, {"avif", "image/avif"},
            {"mp4", "video/mp4"}, {"m4v", "video/x-m4v"}, {"mov", "video/quicktime"}, {"3gp", "video/3gpp"}, {"3g2", "video/3gpp2"},
            {"webm", "video/webm"}, {"mkv", "video/x-matroska"}, {"avi", "video/x-msvideo"}, {"mpg", "video/mpeg"},
            {"mpeg", "video/mpeg"}, {"ts", "video/mp2t"}, {"mts", "video/mp2t"}, {"m2ts", "video/mp2t"}, {"wmv", "video/x-ms-wmv"},
            {"flv", "video/x-flv"}, {"ogv", "video/ogg"}
    };

    /** MIME video → estensione della copia (la prima voce con quel MIME della tabella sopra, tranne dove diversamente scritto). */
    private static final String[][] MIME_VIDEO_E_ESTENSIONE = {
            {"video/mp4", "mp4"}, {"video/x-m4v", "m4v"}, {"video/quicktime", "mov"}, {"video/3gpp", "3gp"}, {"video/3gpp2", "3g2"},
            {"video/webm", "webm"}, {"video/x-matroska", "mkv"}, {"video/x-msvideo", "avi"}, {"video/mpeg", "mpg"},
            {"video/mp2t", "ts"}, {"video/x-ms-wmv", "wmv"}, {"video/x-flv", "flv"}, {"video/ogg", "ogv"}
    };

    /** Il tipo in minuscolo, senza parametri; `null` se vuoto o senza barra. */
    static String normalizzaMime(String mime) {
        if (mime == null) return null;
        String pulito = mime;
        int parametri = pulito.indexOf(';');
        if (parametri >= 0) pulito = pulito.substring(0, parametri);
        pulito = pulito.trim().toLowerCase(Locale.ROOT);
        return pulito.indexOf('/') > 0 ? pulito : null;
    }

    private static boolean eGenerico(String mime) {
        return mime.equals("application/octet-stream") || mime.equals("binary/octet-stream") || mime.equals("application/x-unknown")
                || mime.equals("*/*");
    }

    /** L'estensione di un nome in minuscolo (1-5 caratteri alfanumerici), o `null`. */
    static String estensioneDi(String nome) {
        if (nome == null) return null;
        int punto = nome.lastIndexOf('.');
        if (punto < 0 || punto == nome.length() - 1) return null;
        String estensione = nome.substring(punto + 1).trim().toLowerCase(Locale.ROOT);
        return FORMA_ESTENSIONE.matcher(estensione).matches() ? estensione : null;
    }

    static String mimeDaEstensione(String estensione) {
        if (estensione == null) return null;
        for (String[] voce : ESTENSIONI_E_MIME) {
            if (voce[0].equals(estensione)) return voce[1];
        }
        return null;
    }

    /**
     * Foto, video o altro. Un tipo MIME preciso decide da solo (`image/*` foto, `video/*` video, ogni altro tipo — pdf, audio, testo —
     * è `ALTRO`); un tipo mancante o generico (`application/octet-stream`: certi fornitori di file lo dicono anche per un MP4) si
     * decide dall'estensione del nome, e se anche quella non dice nulla l'elemento è `ALTRO`.
     */
    public static TipoElemento classifica(String mimeDichiarato, String nome) {
        String mime = normalizzaMime(mimeDichiarato);
        if (mime != null && !eGenerico(mime)) {
            if (mime.startsWith("image/")) return TipoElemento.FOTO;
            if (mime.startsWith("video/")) return TipoElemento.VIDEO;
            return TipoElemento.ALTRO;
        }
        String daEstensione = mimeDaEstensione(estensioneDi(nome));
        if (daEstensione == null) return TipoElemento.ALTRO;
        return daEstensione.startsWith("image/") ? TipoElemento.FOTO : TipoElemento.VIDEO;
    }

    /** Il MIME che il video porta al server: quello dichiarato se è un `video/*` ben formato, altrimenti quello dell'estensione, altrimenti MP4. */
    public static String mimeDelVideo(String mimeDichiarato, String nome) {
        String mime = normalizzaMime(mimeDichiarato);
        if (mime != null && mime.startsWith("video/") && PoliticaCaricamento.mimeValido(mime)) return mime;
        String daEstensione = mimeDaEstensione(estensioneDi(nome));
        if (daEstensione != null && daEstensione.startsWith("video/")) return daEstensione;
        return MIME_VIDEO_DI_RIPIEGO;
    }

    /**
     * L'estensione della copia di un video: quella del suo MIME se la conosciamo, altrimenti quella del nome (se è di 1-5 caratteri
     * alfanumerici), altrimenti `mp4`. Il nome di un bambino non entra mai nel nome del file: solo questa estensione, ripulita.
     */
    public static String estensioneDelVideo(String mime, String nome) {
        String normalizzato = normalizzaMime(mime);
        if (normalizzato != null) {
            for (String[] voce : MIME_VIDEO_E_ESTENSIONE) {
                if (voce[0].equals(normalizzato)) return voce[1];
            }
        }
        String daNome = estensioneDi(nome);
        return daNome != null ? daNome : ESTENSIONE_VIDEO_DI_RIPIEGO;
    }

    /** Il nome da mostrare: da 1 a 255 caratteri (come `schemaNome`), con `ripiego` quando il fornitore non ne dà uno. */
    public static String nomeDaMostrare(String grezzo, String ripiego) {
        if (grezzo == null || grezzo.trim().isEmpty()) return ripiego;
        return CodaCaricamenti.nomeValido(grezzo);
    }

    /** Il nome senza l'ultima estensione (1-5 caratteri), se resta qualcosa: «IMG_1.HEIC» → «IMG_1», «.jpg» resta com'è. */
    public static String senzaEstensione(String nome) {
        if (nome == null) return null;
        int punto = nome.lastIndexOf('.');
        if (punto <= 0 || estensioneDi(nome) == null) return nome;
        return nome.substring(0, punto);
    }

    /**
     * Vero se lo spazio libero basta a copiare `peso` byte lasciandone almeno 200 MB. Un peso ignoto (`-1`) conta zero: il margine vale
     * comunque, e se poi il disco si riempie la copia lo dice.
     */
    public static boolean spazioSufficiente(long disponibile, long peso) {
        long necessario = Math.max(peso, 0L);
        if (necessario > Long.MAX_VALUE - MARGINE_SPAZIO_BYTE) return false;
        return disponibile >= necessario + MARGINE_SPAZIO_BYTE;
    }

    /** Il gettone di un nuovo elemento: `g-<uuid>` per la galleria, `f-<uuid>` per i file (`p-<uuid>` per la prova). */
    static String nuovoId(String prefisso) {
        return prefisso + "-" + UUID.randomUUID();
    }

    /** L'origine di un video dall'id del suo elemento (`f-` file, `p-` prova, altrimenti galleria): serve quando il registro non lo ricorda più. */
    static Origine origineDaId(String id) {
        if (id != null && id.startsWith("f-")) return Origine.FILE;
        if (id != null && id.startsWith("p-")) return Origine.PROVA;
        return Origine.GALLERIA;
    }

    /** Il testo esadecimale minuscolo di `dati`. */
    static String esadecimale(byte[] dati) {
        final char[] cifre = "0123456789abcdef".toCharArray();
        char[] testo = new char[dati.length * 2];
        for (int i = 0; i < dati.length; i++) {
            testo[2 * i] = cifre[(dati[i] >> 4) & 0xF];
            testo[2 * i + 1] = cifre[dati[i] & 0xF];
        }
        return new String(testo);
    }

    private static MessageDigest nuovaImpronta() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossibile) {
            // SHA-256 c'è su ogni telefono: se mancasse non c'è niente da inviare in sicurezza.
            throw new IllegalStateException("SHA-256 non disponibile", impossibile);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL JSON DEL PONTE (le forme che `caricamenti-nativi-tipi.ts` rilegge con zod)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * ⚠️ `JSONObject.put(chiave, null)` TOGLIE la chiave: un campo `null` del contratto si scrive con `JSONObject.NULL`, e un campo che
     * manca è un rifiuto di zod. Per questo ogni forma si costruisce qui, in un posto solo.
     */
    static JSONObject jsonFoto(String id, String nome, int larghezza, int altezza, long byteTotali) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("tipo", "foto");
            json.put("nome", nome);
            json.put("larghezza", larghezza);
            json.put("altezza", altezza);
            json.put("byte", byteTotali);
            return json;
        } catch (JSONException impossibile) {
            throw new IllegalStateException("elemento non convertibile per il ponte", impossibile);
        }
    }

    /** `durataMs` ≤ 0 vale «ignota» (`durataSecondi: null`); `miniatura` e `null` valgono «nessuna miniatura». */
    static JSONObject jsonVideo(String id, String nome, long byteTotali, String mime, long durataMs, String miniatura, String sha256) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("tipo", "video");
            json.put("nome", nome);
            json.put("byte", byteTotali);
            json.put("mime", mime);
            json.put("durataSecondi", durataMs > 0L ? (Object) Double.valueOf(durataMs / 1000.0) : JSONObject.NULL);
            json.put("miniatura", miniatura == null ? JSONObject.NULL : miniatura);
            json.put("sha256", sha256);
            return json;
        } catch (JSONException impossibile) {
            throw new IllegalStateException("elemento non convertibile per il ponte", impossibile);
        }
    }

    static JSONObject jsonRifiutato(String id, String nome, TipoElemento origine, MotivoRifiuto motivo) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("tipo", "rifiutato");
            json.put("nome", nome);
            json.put("origine", origine.valore);
            json.put("motivo", motivo.valore);
            return json;
        } catch (JSONException impossibile) {
            throw new IllegalStateException("elemento non convertibile per il ponte", impossibile);
        }
    }

    /** L'evento `preparazione`: `byteTotali` ignoto (`< 0`) è `null`. */
    static JSONObject jsonPreparazione(int fatti, int totali, long byteCopiati, long byteTotali) {
        try {
            JSONObject json = new JSONObject();
            json.put("fatti", fatti);
            json.put("totali", totali);
            json.put("byteCopiati", byteCopiati);
            json.put("byteTotali", byteTotali >= 0L ? (Object) Long.valueOf(byteTotali) : JSONObject.NULL);
            return json;
        } catch (JSONException impossibile) {
            throw new IllegalStateException("evento non convertibile per il ponte", impossibile);
        }
    }

    static JSONObject jsonFotoLetta(String base64, long byteTotali, int larghezza, int altezza) {
        try {
            JSONObject json = new JSONObject();
            json.put("base64", base64);
            json.put("mime", MIME_FOTO_RIDOTTA);
            json.put("byte", byteTotali);
            json.put("larghezza", larghezza);
            json.put("altezza", altezza);
            return json;
        } catch (JSONException impossibile) {
            throw new IllegalStateException("foto non convertibile per il ponte", impossibile);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL REGISTRO DEI PREPARATI
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Un elemento preparato e non ancora consegnato: il file in `scelti/` e ciò che si sa di lui. */
    static final class Preparato {
        final String id;
        final TipoElemento tipo;
        final File file;
        final long byteTotali;
        /** Solo per i video: `sha256` dei byte della copia, esadecimale minuscolo. */
        final String sha256;
        final String mime;
        /** Solo per lo schermo: mai in un log. */
        final String nome;
        /** Solo per le foto. */
        final int larghezza;
        final int altezza;
        final Origine origine;

        Preparato(String id, TipoElemento tipo, File file, long byteTotali, String sha256, String mime, String nome, int larghezza,
                  int altezza, Origine origine) {
            this.id = id;
            this.tipo = tipo;
            this.file = file;
            this.byteTotali = byteTotali;
            this.sha256 = sha256;
            this.mime = mime;
            this.nome = nome;
            this.larghezza = larghezza;
            this.altezza = altezza;
            this.origine = origine;
        }
    }

    /** I preparati del processo, per id. Un'istanza per processo ({@link #PROCESSO}); i test ne fanno di proprie. */
    static final class Preparati {
        static final Preparati PROCESSO = new Preparati();

        private final ConcurrentHashMap<String, Preparato> mappa = new ConcurrentHashMap<>();

        void aggiungi(Preparato preparato) {
            mappa.put(preparato.id, preparato);
        }

        Preparato trova(String id) {
            return id == null ? null : mappa.get(id);
        }

        Preparato rimuovi(String id) {
            return id == null ? null : mappa.remove(id);
        }

        int numero() {
            return mappa.size();
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA PREPARAZIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Chi vuole sapere dell'avanzamento: il ponte, che lo manda al JavaScript come evento `preparazione`. */
    public interface Ascoltatore {
        void preparazione(JSONObject evento);
    }

    /** L'annullamento di una scelta: si alza da un altro thread (`annullaScelta`) e la copia lo vede a ogni blocco. */
    public static final class Cancellazione {
        private volatile boolean annullata;

        public void annulla() {
            annullata = true;
        }

        public boolean annullata() {
            return annullata;
        }
    }

    /** L'esito di una scelta: gli elementi nell'ordine della scelta, oppure `annullato` — e allora MAI con elementi (copie già cancellate). */
    public static final class Esito {
        public final boolean annullato;
        public final List<JSONObject> elementi;

        Esito(boolean annullato, List<JSONObject> elementi) {
            this.annullato = annullato;
            this.elementi = annullato ? Collections.<JSONObject>emptyList() : elementi;
        }

        static Esito annullato() {
            return new Esito(true, Collections.<JSONObject>emptyList());
        }

        public JSONObject aJson() {
            try {
                JSONObject json = new JSONObject();
                JSONArray elenco = new JSONArray();
                for (JSONObject elemento : elementi) elenco.put(elemento);
                json.put("annullato", annullato);
                json.put("elementi", elenco);
                return json;
            } catch (JSONException impossibile) {
                throw new IllegalStateException("esito non convertibile per il ponte", impossibile);
            }
        }
    }

    /** La scelta è stata annullata: si interrompe tutto e si cancella ciò che si era già preparato. */
    private static final class Annullata extends Exception {
        Annullata() {
            super("annullata", null, false, false);
        }
    }

    /** Un contenuto che supera il peso massimo mentre lo si copia (il fornitore non aveva dichiarato il peso, o ne ha dichiarato uno falso). */
    private static final class TroppoGrande extends Exception {
        TroppoGrande() {
            super("troppo grande", null, false, false);
        }
    }

    /** L'avanzamento: quanti elementi sono pronti, quanti byte sono passati, con gli eventi diradati. Un guasto del listener non ferma la copia. */
    static final class Avanzamento {
        private final int totali;
        private final long byteTotali;
        private final Ascoltatore ascoltatore;
        private final LongSupplier orologio;
        private int fatti;
        private long byteCopiati;
        private long ultimoEventoMs;
        private boolean primoEvento = true;
        private int eventiPersi;

        Avanzamento(int totali, long byteTotali, Ascoltatore ascoltatore, LongSupplier orologio) {
            this.totali = totali;
            this.byteTotali = byteTotali;
            this.ascoltatore = ascoltatore;
            this.orologio = orologio;
        }

        void emetti(boolean forza) {
            long adesso = orologio.getAsLong();
            if (!forza && !primoEvento && adesso - ultimoEventoMs < INTERVALLO_EVENTI_MS) return;
            primoEvento = false;
            ultimoEventoMs = adesso;
            long visti = byteTotali >= 0L ? Math.min(byteCopiati, byteTotali) : byteCopiati;
            try {
                ascoltatore.preparazione(jsonPreparazione(fatti, totali, visti, byteTotali));
            } catch (RuntimeException guasto) {
                // L'avanzamento è un'informazione per lo schermo: se il ponte non lo prende, la preparazione va avanti.
                eventiPersi++;
            }
        }

        void copiati(long byteNuovi) {
            byteCopiati += byteNuovi;
            emetti(false);
        }

        /** Byte che non si copieranno (un rifiuto): contano come passati, così la barra arriva in fondo. */
        void saltati(long byteSaltati) {
            if (byteSaltati > 0L) byteCopiati += byteSaltati;
        }

        void elementoFinito() {
            fatti++;
            emetti(true);
        }

        int eventiPersi() {
            return eventiPersi;
        }
    }

    /** Un elemento finito: il suo JSON, e l'id se ha lasciato file in `scelti/` (serve a cancellarli se la scelta viene annullata). */
    private static final class Prodotto {
        final JSONObject json;
        final String idPreparato;

        Prodotto(JSONObject json, String idPreparato) {
            this.json = json;
            this.idPreparato = idPreparato;
        }
    }

    /** L'esito di una copia: byte e impronta, oppure il motivo per cui non è riuscita (e allora non resta niente sul disco). */
    private static final class EsitoCopia {
        final long byteCopiati;
        final String sha256;
        final MotivoRifiuto rifiuto;

        EsitoCopia(long byteCopiati, String sha256, MotivoRifiuto rifiuto) {
            this.byteCopiati = byteCopiati;
            this.sha256 = sha256;
            this.rifiuto = rifiuto;
        }
    }

    /**
     * Una scelta da preparare. {@link #esegui} prende gli elementi nell'ordine, li prepara uno alla volta e restituisce l'{@link Esito}.
     * Non lancia per un elemento che non entra (diventa `rifiutato`) né per un guasto di un singolo elemento; si ferma solo se la scelta
     * è annullata.
     */
    public static final class Preparazione {
        private final File cartellaScelti;
        private final Preparati registro;
        private final Strumenti mondo;
        private final Opzioni opzioni;
        private final Cancellazione cancellazione;
        private final Ascoltatore ascoltatore;

        Preparazione(File cartellaScelti, Preparati registro, Strumenti mondo, Opzioni opzioni, Cancellazione cancellazione,
                     Ascoltatore ascoltatore) {
            this.cartellaScelti = cartellaScelti;
            this.registro = registro;
            this.mondo = mondo;
            this.opzioni = opzioni;
            this.cancellazione = cancellazione;
            this.ascoltatore = ascoltatore;
        }

        public Esito esegui(List<ElementoSorgente> sorgenti) {
            cartellaScelti.mkdirs();
            long totaleDichiarato = 0L;
            boolean ignoto = false;
            for (ElementoSorgente s : sorgenti) {
                long dichiarati = s.byteDichiarati();
                if (dichiarati < 0L) {
                    ignoto = true;
                } else {
                    totaleDichiarato += dichiarati;
                }
            }
            Avanzamento avanzamento = new Avanzamento(sorgenti.size(), ignoto ? -1L : totaleDichiarato, ascoltatore, mondo::adesso);
            avanzamento.emetti(true);

            List<String> creati = new ArrayList<>();
            List<JSONObject> elementi = new ArrayList<>();
            try {
                for (ElementoSorgente s : sorgenti) {
                    controllaAnnullamento();
                    String nomeGrezzo = s.nome();
                    String mimeDichiarato = s.mimeDichiarato();
                    TipoElemento tipo = classifica(mimeDichiarato, nomeGrezzo);
                    String id = nuovoId(opzioni.sorgente.prefissoId);
                    Prodotto prodotto;
                    try {
                        prodotto = preparaUno(s, id, tipo, nomeGrezzo, mimeDichiarato, avanzamento);
                    } catch (RuntimeException guasto) {
                        // Un elemento che va storto non butta via gli altri della scelta: diventa un `rifiutato`, e il guasto si segnala.
                        mondo.segnalaFallimento(tipo == TipoElemento.FOTO ? TipoMedia.FOTO : TipoMedia.VIDEO, MotivoPreparazione.INTERNO,
                                ClasseErrore.di(guasto));
                        scartaUno(registro, cartellaScelti, id);
                        prodotto = rifiutato(id, nomeDaMostrare(nomeGrezzo, ripiegoDelNome(tipo)), tipo, MotivoRifiuto.ILLEGGIBILE, 0L,
                                avanzamento);
                    }
                    if (prodotto.idPreparato != null) creati.add(prodotto.idPreparato);
                    elementi.add(prodotto.json);
                    avanzamento.elementoFinito();
                }
            } catch (Annullata annullata) {
                for (String id : creati) scartaUno(registro, cartellaScelti, id);
                return Esito.annullato();
            }
            return new Esito(false, elementi);
        }

        private void controllaAnnullamento() throws Annullata {
            if (cancellazione.annullata() || Thread.currentThread().isInterrupted()) throw new Annullata();
        }

        private static String ripiegoDelNome(TipoElemento tipo) {
            switch (tipo) {
                case FOTO:
                    return NOME_FOTO_DI_RIPIEGO;
                case VIDEO:
                    return CodaCaricamenti.NOME_DI_RIPIEGO;
                default:
                    return NOME_FILE_DI_RIPIEGO;
            }
        }

        private Prodotto preparaUno(ElementoSorgente s, String id, TipoElemento tipo, String nomeGrezzo, String mimeDichiarato,
                                    Avanzamento avanzamento) throws Annullata {
            if (tipo == TipoElemento.ALTRO) {
                return rifiutato(id, nomeDaMostrare(nomeGrezzo, NOME_FILE_DI_RIPIEGO), tipo, MotivoRifiuto.FORMATO_NON_SUPPORTATO,
                        s.byteDichiarati(), avanzamento);
            }
            return tipo == TipoElemento.VIDEO ? preparaVideo(s, id, nomeGrezzo, mimeDichiarato, avanzamento)
                    : preparaFoto(s, id, nomeGrezzo, avanzamento);
        }

        private Prodotto rifiutato(String id, String nome, TipoElemento origine, MotivoRifiuto motivo, long byteDichiarati,
                                   Avanzamento avanzamento) {
            avanzamento.saltati(byteDichiarati);
            return new Prodotto(jsonRifiutato(id, nome, origine, motivo), null);
        }

        /* ── i video ── */

        private Prodotto preparaVideo(ElementoSorgente s, String id, String nomeGrezzo, String mimeDichiarato, Avanzamento avanzamento)
                throws Annullata {
            String nome = nomeDaMostrare(nomeGrezzo, CodaCaricamenti.NOME_DI_RIPIEGO);
            long dichiarati = s.byteDichiarati();
            // I tre rifiuti che non costano un byte copiato, nell'ordine in cui si possono sapere: peso, durata, spazio.
            if (dichiarati == 0L) return rifiutato(id, nome, TipoElemento.VIDEO, MotivoRifiuto.ILLEGGIBILE, dichiarati, avanzamento);
            if (dichiarati > opzioni.byteMassimiVideo) {
                return rifiutato(id, nome, TipoElemento.VIDEO, MotivoRifiuto.TROPPO_GRANDE, dichiarati, avanzamento);
            }
            long limiteDurataMs = (long) opzioni.durataMassimaVideoSecondi * 1000L;
            long durataMs = s.durataMs();
            if (durataMs > limiteDurataMs) return rifiutato(id, nome, TipoElemento.VIDEO, MotivoRifiuto.TROPPO_LUNGO, dichiarati, avanzamento);
            if (!spazioSufficiente(mondo.spazioDisponibile(cartellaScelti), dichiarati)) {
                return rifiutato(id, nome, TipoElemento.VIDEO, MotivoRifiuto.SPAZIO_INSUFFICIENTE, dichiarati, avanzamento);
            }

            String mime = mimeDelVideo(mimeDichiarato, nomeGrezzo);
            File copia = new File(cartellaScelti, id + "." + estensioneDelVideo(mime, nomeGrezzo));
            EsitoCopia copiato = copia(s, copia, true, TipoMedia.VIDEO, avanzamento);
            if (copiato.rifiuto != null) return rifiutato(id, nome, TipoElemento.VIDEO, copiato.rifiuto, 0L, avanzamento);

            MiniaturaVideo.Analisi analisi = analizza(copia);
            // Se prima non si sapeva quanto dura, ora lo si sa dalla copia: un video troppo lungo si rifiuta anche se costa la copia.
            if (durataMs <= 0L && analisi.durataMs > limiteDurataMs) {
                cancella(copia);
                return rifiutato(id, nome, TipoElemento.VIDEO, MotivoRifiuto.TROPPO_LUNGO, 0L, avanzamento);
            }
            long durataFinale = durataMs > 0L ? durataMs : analisi.durataMs;
            registro.aggiungi(new Preparato(id, TipoElemento.VIDEO, copia, copiato.byteCopiati, copiato.sha256, mime, nome, 0, 0,
                    opzioni.sorgente.origine));
            return new Prodotto(jsonVideo(id, nome, copiato.byteCopiati, mime, durataFinale, analisi.miniatura, copiato.sha256), id);
        }

        private MiniaturaVideo.Analisi analizza(File copia) {
            try {
                MiniaturaVideo.Analisi analisi = mondo.analizzaVideo(copia);
                return analisi != null ? analisi : MiniaturaVideo.Analisi.SCONOSCIUTA;
            } catch (RuntimeException guasto) {
                // La miniatura è un di più: senza, il video si invia lo stesso. Il guasto resta contato fra i «nostri».
                mondo.segnalaFallimento(TipoMedia.VIDEO, MotivoPreparazione.INTERNO, ClasseErrore.di(guasto));
                return MiniaturaVideo.Analisi.SCONOSCIUTA;
            }
        }

        /* ── le foto ── */

        private Prodotto preparaFoto(ElementoSorgente s, String id, String nomeGrezzo, Avanzamento avanzamento) throws Annullata {
            String nome = nomeDaMostrare(senzaEstensione(nomeGrezzo), NOME_FOTO_DI_RIPIEGO);
            long dichiarati = s.byteDichiarati();
            if (dichiarati == 0L) return rifiutato(id, nome, TipoElemento.FOTO, MotivoRifiuto.ILLEGGIBILE, dichiarati, avanzamento);
            if (dichiarati > opzioni.byteMassimiVideo) {
                return rifiutato(id, nome, TipoElemento.FOTO, MotivoRifiuto.TROPPO_GRANDE, dichiarati, avanzamento);
            }
            File originale = new File(cartellaScelti, id + ".orig");
            File ridotta = new File(cartellaScelti, id + ".jpg");
            try {
                // Si copia l'originale in un file nostro: i decodificatori lavorano su un file, lo riaprono più volte (firma, EXIF,
                // pixel) e il permesso sull'indirizzo del selettore non è per sempre.
                EsitoCopia copiato = copia(s, originale, false, TipoMedia.FOTO, avanzamento);
                if (copiato.rifiuto != null) return rifiutato(id, nome, TipoElemento.FOTO, copiato.rifiuto, 0L, avanzamento);
                ElaborazioneFoto.Riduzione riduzione = mondo.riduciFoto(originale, ridotta, opzioni.latoMassimoFoto,
                        ElaborazioneFoto.qualitaJpeg(opzioni.qualitaFoto));
                registro.aggiungi(new Preparato(id, TipoElemento.FOTO, ridotta, riduzione.byteTotali, null, MIME_FOTO_RIDOTTA, nome,
                        riduzione.larghezza, riduzione.altezza, opzioni.sorgente.origine));
                return new Prodotto(jsonFoto(id, nome, riduzione.larghezza, riduzione.altezza, riduzione.byteTotali), id);
            } catch (FotoRifiutata rifiuto) {
                if (rifiuto.daSegnalare != null) {
                    mondo.segnalaFallimento(TipoMedia.FOTO, MotivoPreparazione.RIDUZIONE, rifiuto.daSegnalare);
                }
                MotivoRifiuto motivo = rifiuto.rifiuto == ElaborazioneFoto.Rifiuto.FORMATO_NON_SUPPORTATO
                        ? MotivoRifiuto.FORMATO_NON_SUPPORTATO : MotivoRifiuto.ILLEGGIBILE;
                return rifiutato(id, nome, TipoElemento.FOTO, motivo, 0L, avanzamento);
            } finally {
                cancella(originale);
            }
        }

        /* ── la copia ── */

        /**
         * Copia l'elemento in `destinazione`, a blocchi, con l'impronta SHA-256 se richiesta. Se non riesce non lascia niente sul disco
         * e dice il perché come motivo di rifiuto; se la scelta è annullata lancia {@link Annullata} (dopo aver cancellato la copia
         * parziale). I rifiuti attesi (contenuto che non c'è più, troppo grande, disco pieno) non si segnalano; quelli «nostri» sì.
         *
         * La sorgente si apre PRIMA e a parte: un `FileNotFoundException` dell'apertura dice «questo contenuto non c'è» (un video solo
         * nel cloud, cancellato nel frattempo: rifiuto atteso), mentre lo stesso errore nel creare il file di destinazione è un guasto del
         * nostro disco e si tratta come tale.
         */
        private EsitoCopia copia(ElementoSorgente s, File destinazione, boolean conImpronta, TipoMedia tipo, Avanzamento avanzamento)
                throws Annullata {
            InputStream aperto;
            try {
                aperto = s.apri();
            } catch (FileNotFoundException assente) {
                return new EsitoCopia(0L, null, MotivoRifiuto.ILLEGGIBILE);
            } catch (IOException | RuntimeException guasto) {
                return dopoUnGuasto(guasto, tipo, destinazione);
            }
            MessageDigest impronta = conImpronta ? nuovaImpronta() : null;
            try (InputStream ingresso = aperto; OutputStream uscita = new FileOutputStream(destinazione)) {
                long copiati = copiaFlusso(ingresso, uscita, impronta, opzioni.byteMassimiVideo, cancellazione, avanzamento);
                if (copiati == 0L) {
                    cancella(destinazione);
                    return new EsitoCopia(0L, null, MotivoRifiuto.ILLEGGIBILE);
                }
                return new EsitoCopia(copiati, impronta != null ? esadecimale(impronta.digest()) : null, null);
            } catch (Annullata annullata) {
                cancella(destinazione);
                throw annullata;
            } catch (TroppoGrande troppoGrande) {
                cancella(destinazione);
                return new EsitoCopia(0L, null, MotivoRifiuto.TROPPO_GRANDE);
            } catch (IOException | RuntimeException guasto) {
                return dopoUnGuasto(guasto, tipo, destinazione);
            }
        }

        /**
         * Una copia fallita per un guasto: cancella ciò che è stato scritto e decide. Disco quasi pieno → `spazio-insufficiente` (atteso);
         * permesso negato, errore di lettura o eccezione inattesa → `illeggibile`, e il guasto si segnala (tipo, motivo e CLASSE
         * dell'errore, mai il messaggio).
         */
        private EsitoCopia dopoUnGuasto(Throwable guasto, TipoMedia tipo, File destinazione) {
            cancella(destinazione);
            if (guasto instanceof SecurityException) {
                mondo.segnalaFallimento(tipo, MotivoPreparazione.COPIA, ClasseErrore.SICUREZZA);
            } else if (guasto instanceof IOException) {
                if (mondo.spazioDisponibile(cartellaScelti) < SOGLIA_DISCO_PIENO_BYTE) {
                    return new EsitoCopia(0L, null, MotivoRifiuto.SPAZIO_INSUFFICIENTE);
                }
                mondo.segnalaFallimento(tipo, MotivoPreparazione.COPIA, ClasseErrore.di(guasto));
            } else {
                mondo.segnalaFallimento(tipo, MotivoPreparazione.INTERNO, ClasseErrore.di(guasto));
            }
            return new EsitoCopia(0L, null, MotivoRifiuto.ILLEGGIBILE);
        }
    }

    /**
     * Copia `ingresso` in `uscita` a blocchi da 256 KB e restituisce i byte passati. A ogni blocco guarda l'annullamento e il tetto
     * di peso (il fornitore può non aver dichiarato il peso, o averlo dichiarato falso), aggiorna l'impronta e l'avanzamento.
     */
    private static long copiaFlusso(InputStream ingresso, OutputStream uscita, MessageDigest impronta, long limite,
                                    Cancellazione cancellazione, Avanzamento avanzamento) throws IOException, Annullata, TroppoGrande {
        byte[] blocco = new byte[BLOCCO_COPIA_BYTE];
        long totale = 0L;
        int letti;
        while ((letti = ingresso.read(blocco)) != -1) {
            if (cancellazione.annullata() || Thread.currentThread().isInterrupted()) throw new Annullata();
            totale += letti;
            if (totale > limite) throw new TroppoGrande();
            if (impronta != null) impronta.update(blocco, 0, letti);
            uscita.write(blocco, 0, letti);
            avanzamento.copiati(letti);
        }
        return totale;
    }

    /**
     * Toglie un file. Se non ci riesce il file resta in `scelti/` e lo toglie la pulizia del motore (24 ore: nessun file di `scelti/` è
     * nominato da una voce, quindi non c'è modo che qualcuno lo rilegga): non è un errore da dire a nessuno, e non si registra niente
     * per l'uscita del processo, che su Android non ha un momento in cui arriva.
     */
    private static void cancella(File file) {
        if (file.exists()) file.delete();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LETTURA E SCARTO DEI PREPARATI
     * ──────────────────────────────────────────────────────────────────────────── */

    /** `leggiFoto`: l'elemento non c'è (mai preparato, già letto, già scartato, o il suo file è sparito). */
    public static final class ElementoAssente extends Exception {
        ElementoAssente() {
            super("ELEMENTO_ASSENTE");
        }
    }

    /**
     * `leggiFoto`: la foto preparata in base64 e UNA volta sola (il file e il registro si cancellano dopo la lettura): il JavaScript ne fa
     * un `File`. Un id fuori forma o di un video è «assente».
     *
     * @throws IOException se il file c'è ma non si legge: il file resta, e chi chiama risponde `INTERNO`
     */
    static JSONObject leggiFoto(Preparati registro, String id) throws ElementoAssente, IOException {
        if (id == null || !FORMA_ID.matcher(id).matches()) throw new ElementoAssente();
        Preparato preparato = registro.trova(id);
        if (preparato == null || preparato.tipo != TipoElemento.FOTO) throw new ElementoAssente();
        if (!preparato.file.isFile()) {
            registro.rimuovi(id);
            throw new ElementoAssente();
        }
        ByteArrayOutputStream contenuto = new ByteArrayOutputStream((int) Math.max(Math.min(preparato.byteTotali, 8L * 1024L * 1024L), 1024L));
        try (InputStream ingresso = new FileInputStream(preparato.file)) {
            byte[] blocco = new byte[64 * 1024];
            int letti;
            while ((letti = ingresso.read(blocco)) != -1) contenuto.write(blocco, 0, letti);
        }
        byte[] dati = contenuto.toByteArray();
        JSONObject json = jsonFotoLetta(ElaborazioneFoto.base64(dati), dati.length, preparato.larghezza, preparato.altezza);
        registro.rimuovi(id);
        cancella(preparato.file);
        return json;
    }

    /**
     * `scartaScelti`: cancella i preparati indicati (foto e video, e l'eventuale originale di una foto) e li toglie dal registro. Un id fuori
     * forma si ignora (e non può mai uscire dalla cartella: niente separatori né punti). Restituisce quanti elementi c'erano da togliere.
     */
    static int scarta(Preparati registro, File cartellaScelti, Collection<String> ids) {
        if (ids == null) return 0;
        int eliminati = 0;
        for (String id : ids) {
            if (scartaUno(registro, cartellaScelti, id)) eliminati++;
        }
        return eliminati;
    }

    private static boolean scartaUno(Preparati registro, File cartellaScelti, String id) {
        if (id == null || !FORMA_ID.matcher(id).matches()) return false;
        boolean tolto = registro.rimuovi(id) != null;
        File[] file = cartellaScelti.listFiles();
        if (file != null) {
            String prefisso = id + ".";
            for (File f : file) {
                if (f.isFile() && f.getName().startsWith(prefisso) && f.delete()) tolto = true;
            }
        }
        return tolto;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * `accodaVideo`: dal preparato al motore
     * ──────────────────────────────────────────────────────────────────────────── */

    private static String testo(JSONObject dati, String chiave) throws RifiutoAccodamento {
        Object grezzo = dati.opt(chiave);
        if (!(grezzo instanceof String) || ((String) grezzo).isEmpty()) throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
        return (String) grezzo;
    }

    private static JSONObject oggetto(JSONObject dati, String chiave) throws RifiutoAccodamento {
        Object grezzo = dati.opt(chiave);
        if (!(grezzo instanceof JSONObject)) throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
        return (JSONObject) grezzo;
    }

    /** Un testo che può essere `null`/assente (`JSONObject.NULL`), ma se c'è dev'essere una stringa. */
    private static String testoFacoltativo(JSONObject dati, String chiave) throws RifiutoAccodamento {
        Object grezzo = dati.opt(chiave);
        if (grezzo == null || grezzo == JSONObject.NULL) return null;
        if (!(grezzo instanceof String)) throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
        return (String) grezzo;
    }

    /**
     * `accodaVideo`: rilegge la richiesta, la confronta con l'elemento preparato, e la consegna al motore (`PianificatoreCaricamenti.accoda`).
     *
     *  · PARAMETRI: forma di ogni campo, `sha256` esadecimale minuscolo, peso 1-2 GB. Ciò che il motore sa controllare meglio (uuid, token,
     *    date, host) lo controlla lui.
     *  · L'ELEMENTO: se il registro lo conosce, `sha256` e peso devono essere ESATTAMENTE quelli dichiarati (altrimenti
     *    `ELEMENTO_DIVERSO`: il JavaScript non può far partire un file diverso da quello scelto). Se non lo conosce e il motore non ha già
     *    una voce VIVA per quel job, il motore risponde `ELEMENTO_ASSENTE`.
     *  · L'APERTURA RIPETUTA (stesso job, token ruotato): il motore sostituisce i segreti e restituisce la voce com'è, SENZA spostare
     *    niente. La copia che l'insegnante ha nel frattempo ripreparato (stesso video, stessa impronta) non serve più: si cancella,
     *    altrimenti resterebbe in `scelti/` fino a 24 ore, con 2 GB di spazio.
     *  · Dopo un accodamento nuovo il file è già in `file/<job>.<ext>` (il motore lo ha SPOSTATO): l'elemento esce dal registro.
     */
    static JSONObject accodaPreparato(PianificatoreCaricamenti motore, Preparati registro, JSONObject dati) throws RifiutoAccodamento {
        if (dati == null) throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
        String idElemento = testo(dati, "idElemento");
        String sha256 = testo(dati, "sha256");
        if (!FORMA_ID.matcher(idElemento).matches() || !FORMA_SHA256.matcher(sha256).matches()) {
            throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
        }
        Object grezzoPeso = dati.opt("byteAttesi");
        if (!(grezzoPeso instanceof Number)) throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
        double peso = ((Number) grezzoPeso).doubleValue();
        if (Double.isNaN(peso) || peso != Math.rint(peso) || peso < 1.0 || peso > CodaCaricamenti.MAX_VIDEO_INPUT_BYTES) {
            throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
        }
        long byteAttesi = ((Number) grezzoPeso).longValue();
        String jobId = testo(dati, "jobId");
        String intentId = testo(dati, "intentId");
        String utenteId = testo(dati, "utenteId");
        String scuolaId = testo(dati, "scuolaId");
        JSONObject caricamento = oggetto(dati, "caricamento");
        JSONObject rinnovo = oggetto(dati, "rinnovo");
        JSONObject registroLog = oggetto(dati, "registro");
        String urlPut = testo(caricamento, "url");
        String contentType = testo(caricamento, "contentType");
        String urlPutScadeIl = testoFacoltativo(caricamento, "scadeIl");
        String urlRinnovo = testo(rinnovo, "url");
        String token = testo(rinnovo, "token");
        String tokenScadeIl = testo(rinnovo, "scadeIl");
        String urlRegistro = testo(registroLog, "url");
        Object grezzoTesti = dati.opt("testi");
        Testi testi = null;
        if (grezzoTesti instanceof JSONObject) {
            JSONObject t = (JSONObject) grezzoTesti;
            testi = new Testi(testoFacoltativo(t, "titolo"), testoFacoltativo(t, "invio"), testoFacoltativo(t, "attesaRete"),
                    testoFacoltativo(t, "pausa"));
        } else if (grezzoTesti != null && grezzoTesti != JSONObject.NULL) {
            throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
        }

        Preparato preparato = registro.trova(idElemento);
        if (preparato != null) {
            if (preparato.tipo != TipoElemento.VIDEO || preparato.sha256 == null || !preparato.sha256.equals(sha256)
                    || preparato.byteTotali != byteAttesi) {
                throw new RifiutoAccodamento(CodiceRifiuto.ELEMENTO_DIVERSO);
            }
            if (!preparato.file.isFile()) {
                registro.rimuovi(idElemento);
                preparato = null;
            }
        }

        File file = preparato != null ? preparato.file : null;
        String nome = preparato != null ? preparato.nome : CodaCaricamenti.NOME_DI_RIPIEGO;
        String mime = preparato != null ? preparato.mime : contentType;
        Origine origine = preparato != null ? preparato.origine : origineDaId(idElemento);
        ricordaUtente(utenteId);

        RisultatoAccodamento risultato = motore.accoda(new RichiestaAccodamento(jobId, intentId, utenteId, scuolaId, nome, mime, byteAttesi,
                origine, file, urlPut, contentType, urlPutScadeIl, urlRinnovo, token, tokenScadeIl, urlRegistro, testi));

        if (preparato != null) {
            registro.rimuovi(idElemento);
            if (risultato.giaPresente && risultato.voce.optLong("byteTotali", -1L) == preparato.byteTotali) {
                // Il motore non ha toccato il file: è la copia di un video che ha già (apertura ripetuta). Non serve più.
                cancella(preparato.file);
            }
        }
        return risultato.voce;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'ELEMENTO DI PROVA (solo build Debug: lo chiama la pagina di collaudo)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Un video di byte casuali del peso chiesto, già preparato in `scelti/p-<uuid>.mp4`, con lo `sha256` dei byte scritti. Serve al
     * collaudo del motore (C1) senza un video vero. Non è un video: il server lo respingerebbe al probe, ma al motore non importa.
     *
     * @throws IllegalArgumentException se il peso non sta fra 1 byte e 2 GB
     * @throws IOException              se non si riesce a scriverlo (e allora non resta niente)
     */
    static JSONObject creaProva(Preparati registro, File cartellaScelti, long byteDaCreare) throws IOException {
        if (byteDaCreare < 1L || byteDaCreare > CodaCaricamenti.MAX_VIDEO_INPUT_BYTES) throw new IllegalArgumentException("peso non valido");
        cartellaScelti.mkdirs();
        String id = nuovoId("p");
        File file = new File(cartellaScelti, id + "." + ESTENSIONE_VIDEO_DI_RIPIEGO);
        MessageDigest impronta = nuovaImpronta();
        Random caso = new Random();
        byte[] blocco = new byte[BLOCCO_COPIA_BYTE];
        boolean riuscito = false;
        try (OutputStream uscita = new FileOutputStream(file)) {
            long restanti = byteDaCreare;
            while (restanti > 0L) {
                int n = (int) Math.min(restanti, blocco.length);
                caso.nextBytes(blocco);
                impronta.update(blocco, 0, n);
                uscita.write(blocco, 0, n);
                restanti -= n;
            }
            riuscito = true;
        } finally {
            if (!riuscito) cancella(file);
        }
        String sha256 = esadecimale(impronta.digest());
        String nome = "Video di prova";
        registro.aggiungi(new Preparato(id, TipoElemento.VIDEO, file, byteDaCreare, sha256, MIME_VIDEO_DI_RIPIEGO, nome, 0, 0, Origine.PROVA));
        return jsonVideo(id, nome, byteDaCreare, MIME_VIDEO_DI_RIPIEGO, -1L, null, sha256);
    }
}
