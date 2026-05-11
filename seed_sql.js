const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await supabase.rpc('exec_sql', { sql: "ALTER TABLE parents ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'parent', ADD COLUMN IF NOT EXISTS section_name VARCHAR(100);" });
  console.log(error || "Success");
}
run();
