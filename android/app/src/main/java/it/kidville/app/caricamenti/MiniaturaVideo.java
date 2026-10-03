package it.kidville.app.caricamenti;

import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.os.Build;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;

/**
 * LA MINIATURA E LA DURATA DI UN VIDEO: un fotogramma di ≤ 320 px come data URL JPEG, e quanto dura.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.2 `miniatura`, §6.3 «Miniatura»; compito A3)
 *
 * ─── CHE COSA È ──────────────────────────────────────────────────────────────────────────────
 * Dopo aver copiato un video nella cartella privata l'app ne mostra l'anteprima: una miniatura per la scheda e la durata («1:23»).
 * Il contratto con il JavaScript (`schemaElementoVideo`) vuole una miniatura `data:image/jpeg;base64,…` o `null`, e una durata in
 * secondi positiva o `null`: «non lo so» non è un rifiuto, la misura vera la fa il probe del server.
 *
 * ─── COME È FATTA ────────────────────────────────────────────────────────────────────────────
 *  · SI LEGGE DALLA COPIA, non dall'indirizzo del selettore: il file è nostro, stabile, e il permesso sull'indirizzo morirebbe con
 *    l'Activity. Un solo `MediaMetadataRetriever` per durata e fotogramma.
 *  · LE SCELTE SONO PURE E STATICHE (provate in JUnit): a che istante prendere il fotogramma ({@link #istanteFotogrammaUs}: il secondo
 *    secondo se il video dura almeno due secondi, altrimenti il primo fotogramma, per saltare le dissolvenze di apertura), le
 *    dimensioni da chiedere al lettore ({@link #dimensioniVisualizzate}: con una rotazione di 90° o 270° larghezza e altezza si
 *    scambiano) e la forma del data URL ({@link #dataUrl}).
 *  · LA RIDUZIONE LA FA IL LETTORE da API 27 (`getScaledFrameAtTime`: un video 4K non diventa un `Bitmap` da 33 MB per farne una
 *    miniatura da 320 px); sotto, `getFrameAtTime` e un ridimensionamento. In ogni caso una guardia finale porta il lato lungo a 320.
 *  · NON LANCIA MAI e NON FA RUMORE: una miniatura che non si riesce a fare (un codec che il telefono non decodifica) è `null`, e il
 *    video si invia lo stesso. Una riga in logcat con la sola classe dell'eccezione, mai un percorso.
 */
public final class MiniaturaVideo {

    private MiniaturaVideo() {
    }

    private static final String TAG = "KidvilleCaricamenti";

    /** Il lato lungo massimo della miniatura (`LATO_MINIATURA_VIDEO` di `caricamenti-nativi-tipi.ts`: un test li confronta). */
    public static final int LATO_MASSIMO = 320;
    /** La qualità JPEG della miniatura: è un'anteprima, non una foto. */
    public static final int QUALITA_JPEG = 70;
    /** Da questa durata in su il fotogramma si prende dopo un secondo; sotto, al primo istante. */
    public static final long SOGLIA_SECONDO_FOTOGRAMMA_MS = 2_000L;
    /** L'inizio di ogni miniatura: la forma che `schemaMiniatura` riconosce. */
    public static final String PREFISSO_DATA_URL = "data:image/jpeg;base64,";

    /** Quanto dura un video (`-1` = ignoto) e la sua miniatura (`null` = non fatta). */
    public static final class Analisi {
        public static final Analisi SCONOSCIUTA = new Analisi(-1L, null);

        public final long durataMs;
        public final String miniatura;

        public Analisi(long durataMs, String miniatura) {
            this.durataMs = durataMs;
            this.miniatura = miniatura;
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE TRE SCELTE PURE
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * L'istante (microsecondi) del fotogramma da usare come miniatura: 1 s se il video dura almeno 2 s, altrimenti 0. Con la durata
     * ignota si parte dal primo fotogramma, che c'è sempre.
     */
    public static long istanteFotogrammaUs(long durataMs) {
        return durataMs >= SOGLIA_SECONDO_FOTOGRAMMA_MS ? 1_000_000L : 0L;
    }

    /**
     * Le dimensioni con cui il video si vede, date quelle codificate e la rotazione dichiarata (`METADATA_KEY_VIDEO_ROTATION`): con 90° o
     * 270° larghezza e altezza si scambiano. Un video girato in verticale è memorizzato per traverso con rotazione 90.
     */
    public static int[] dimensioniVisualizzate(int larghezza, int altezza, int rotazioneGradi) {
        int gradi = ((rotazioneGradi % 360) + 360) % 360;
        if (gradi == 90 || gradi == 270) return new int[]{altezza, larghezza};
        return new int[]{larghezza, altezza};
    }

    /** `data:image/jpeg;base64,…` con il JPEG dato, nella forma che `schemaMiniatura` accetta. */
    public static String dataUrl(byte[] jpeg) {
        return PREFISSO_DATA_URL + ElaborazioneFoto.base64(jpeg);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL LETTORE DI ANDROID (non si prova sulla JVM: lo coprono assembleDebug e il collaudo sull'emulatore)
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Il numero di una chiave dei metadati, o `-1` se manca o non è un numero. */
    private static long numero(MediaMetadataRetriever lettore, int chiave) {
        String valore = lettore.extractMetadata(chiave);
        if (valore == null) return -1L;
        try {
            return Long.parseLong(valore.trim());
        } catch (NumberFormatException nonNumerico) {
            return -1L;
        }
    }

    /**
     * Durata e miniatura della COPIA di un video. Non lancia mai: ogni guasto è `Analisi` incompleta (durata `-1`, miniatura `null`).
     */
    public static Analisi analizza(File video) {
        MediaMetadataRetriever lettore = new MediaMetadataRetriever();
        long durataMs = -1L;
        try {
            lettore.setDataSource(video.getPath());
            durataMs = numero(lettore, MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (durataMs <= 0L) durataMs = -1L;
            return new Analisi(durataMs, miniaturaDi(lettore, durataMs));
        } catch (RuntimeException guasto) {
            // `setDataSource` lancia per un file che il telefono non sa aprire: il video si invia lo stesso, senza anteprima.
            Log.w(TAG, "analisi del video non riuscita (" + guasto.getClass().getSimpleName() + ")");
            return new Analisi(durataMs, null);
        } finally {
            rilascia(lettore);
        }
    }

    /**
     * Rilascia un lettore. Dal livello 33 `release()` dichiara `IOException` (la lancia solo chiudendo un `MediaDataSource`, che qui non si
     * usa mai): si dice in logcat con la sola classe e si va avanti, il lettore è comunque chiuso.
     */
    static void rilascia(MediaMetadataRetriever lettore) {
        try {
            lettore.release();
        } catch (IOException nonRilasciato) {
            Log.w(TAG, "rilascio del lettore non riuscito (" + nonRilasciato.getClass().getSimpleName() + ")");
        }
    }

    private static String miniaturaDi(MediaMetadataRetriever lettore, long durataMs) {
        try {
            long istanteUs = istanteFotogrammaUs(durataMs);
            int larghezza = (int) numero(lettore, MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH);
            int altezza = (int) numero(lettore, MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT);
            int rotazione = (int) Math.max(0L, numero(lettore, MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION));

            Bitmap fotogramma = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1 && larghezza > 0 && altezza > 0) {
                int[] visto = dimensioniVisualizzate(larghezza, altezza, rotazione);
                int[] obiettivo = ElaborazioneFoto.dimensioniObiettivo(visto[0], visto[1], LATO_MASSIMO);
                fotogramma = lettore.getScaledFrameAtTime(istanteUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, obiettivo[0], obiettivo[1]);
            } else {
                fotogramma = lettore.getFrameAtTime(istanteUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            }
            if (fotogramma == null && istanteUs != 0L) {
                fotogramma = lettore.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            }
            if (fotogramma == null) return null;

            Bitmap pronta = fotogramma;
            try {
                int[] finale = ElaborazioneFoto.dimensioniObiettivo(fotogramma.getWidth(), fotogramma.getHeight(), LATO_MASSIMO);
                if (finale[0] != fotogramma.getWidth() || finale[1] != fotogramma.getHeight()) {
                    pronta = Bitmap.createScaledBitmap(fotogramma, finale[0], finale[1], true);
                }
                ByteArrayOutputStream uscita = new ByteArrayOutputStream(32 * 1024);
                if (!pronta.compress(Bitmap.CompressFormat.JPEG, QUALITA_JPEG, uscita)) return null;
                return dataUrl(uscita.toByteArray());
            } finally {
                if (pronta != fotogramma) pronta.recycle();
                fotogramma.recycle();
            }
        } catch (RuntimeException | OutOfMemoryError guasto) {
            Log.w(TAG, "miniatura del video non riuscita (" + guasto.getClass().getSimpleName() + ")");
            return null;
        }
    }
}
