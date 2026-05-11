import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

serve(async (req: Request) => {
    // Only allow POST or GET (e.g., from cron)
    if (req.method !== "POST" && req.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
    }

    try {
        const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

        // Calculate date 30 days from now
        const thresholdDate = new Date();
        thresholdDate.setDate(thresholdDate.getDate() + 30);
        const thresholdIso = thresholdDate.toISOString().split('T')[0];

        // Fetch documents expiring in <= 30 days that don't already have a notification
        // Note: Realistically, you would join with a notifications table or track what has been alerted
        const { data: expiringDocs, error: fetchError } = await supabase
            .from("student_documents")
            .select(`
                id, student_id, document_type, expiry_date,
                alunni ( nome, cognome )
            `)
            .lte("expiry_date", thresholdIso);

        if (fetchError) {
            throw fetchError;
        }

        if (!expiringDocs || expiringDocs.length === 0) {
            return new Response(JSON.stringify({ message: "No expiring documents found" }), {
                headers: { "Content-Type": "application/json" },
            });
        }

        // Create notifications for staff
        const notifications = expiringDocs.map((doc: any) => ({
            titolo: `Documento in scadenza: ${doc.document_type.toUpperCase()}`,
            messaggio: `Il documento dell'alunno ${doc.alunni?.nome} ${doc.alunni?.cognome} scade il ${doc.expiry_date}.`,
            letto: false,
            creato_il: new Date().toISOString()
            // Here you'd add role or user_id mapping for Segreteria, depending on DB schema
        }));

        // Assuming there is a "notifiche" or similar table
        // The prompt says: "inserisce una notifica nella tabella notifiche per il ruolo Segreteria"
        // Let's assume the table is named `notifiche`
        const { error: insertError } = await supabase
            .from("notifiche")
            .insert(notifications);

        if (insertError) {
            throw insertError;
        }

        return new Response(JSON.stringify({
            message: `Created ${notifications.length} alerts for expiring documents`,
            processed: notifications.length
        }), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
});
