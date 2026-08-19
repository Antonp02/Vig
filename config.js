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
  /* Which board every visitor sees by default.
       'live' — real prices via the odds Edge Function, falling back to the
                simulated board automatically if the feed is unreachable
       'mock' — simulated board for everyone
     This is the production switch: change it, push, and every device follows on
     its next load. An admin can still override on their own device via
     ?admin=1 or ?data=live / ?data=mock. */
  DATA_SOURCE: 'live',

  SUPABASE_URL: 'https://jauikslookwsvktlzdbq.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_FzHJkfp3m9XFTbyvs56phg_pJaZtI8S'
};
