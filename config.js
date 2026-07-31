/* VIG configuration
   -----------------------------------------------------------------
   Fill these in after creating your Supabase project:
     Supabase dashboard -> Settings -> API
       Project URL  ->  SUPABASE_URL
       anon public  ->  SUPABASE_ANON_KEY

   Leave them blank and the app runs exactly as it does today: local
   only, no accounts, nothing gated. Nothing breaks before you set up.

   The anon key is PUBLIC by design and safe to commit. Row Level
   Security in supabase/schema.sql is what protects the data.
   Never put the service_role key here.
----------------------------------------------------------------- */
window.VIG_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: ''
};
