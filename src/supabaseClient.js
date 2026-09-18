import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fails loudly in the browser console rather than silently no-op-ing every
  // storage call, which would otherwise look like "nothing saves, no errors."
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
    'These should already be set in Vercel (Project → Settings → Environment Variables); ' +
    'for local `npm run dev`, set them in a local .env file too.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
