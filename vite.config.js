import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Vite only exposes env vars to the client that match one of these
  // prefixes. Included NEXT_PUBLIC_ here (in addition to Vite's own default
  // VITE_) so the app can read the Supabase vars as already named in Vercel,
  // without needing to rename anything there.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
});
