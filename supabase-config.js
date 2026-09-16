// supabase-config.js
// Paste your project's values here:
//   Project URL: Supabase Dashboard → ⚙ Project Settings → Data API → "Project URL"
//   Key: Supabase Dashboard → ⚙ Project Settings → API Keys tab →
//        the "Publishable key" (starts with sb_publishable_...).
//
// ⚠️ NEVER put your "secret key" (sb_secret_...) here or in any file that
// gets deployed to a browser. The secret key bypasses Row Level Security
// entirely and has no legitimate use in this project — every mutation
// already goes through the SECURITY DEFINER functions in
// supabase-schema.sql using the publishable key below.
//
// The publishable key IS safe to expose in client code — it's meant to be
// public; all real protection comes from Row Level Security and those
// functions, not from hiding this key.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://fmroaebtupqbdwmqqulf.supabase.co"; // e.g. https://abcxyz.supabase.co — NOT a key
const SUPABASE_ANON_KEY = "sb_publishable_PYjTuMd9JwnUdbWSpRTvSw_93_A3F16"; // sb_publishable_... — never sb_secret_...

// persistSession: false — these devices are shared kiosks/counter terminals,
// so a login must not survive a page reload or carry over to the next
// person who uses the browser. Staff still stay signed in for the rest of
// the current page session (autoRefreshToken keeps their token alive).
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});