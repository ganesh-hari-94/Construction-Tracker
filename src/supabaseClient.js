import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fails loudly in the browser console rather than silently no-op-ing every
  // storage call, which would otherwise look like "nothing saves, no errors."
  console.error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
    'Set them as environment variables in Vercel (and in a local .env file for `npm run dev`).'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
