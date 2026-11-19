// config.js — where the guest page connects.
//
// This is the PUBLIC anon key, the same one already shipped inside the iOS/Mac app
// (SecondBrain/Services/SupabaseClient.swift). It only allows what RLS allows; the
// guest page uses it for Realtime *broadcast* channels and nothing else.
export const SUPABASE_URL = 'https://epfwxriaryitupusxdpl.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVwZnd4cmlhcnlpdHVwdXN4ZHBsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MDMxNzUsImV4cCI6MjA5MjA3OTE3NX0.tQqS4pK1rvckQu5W-mm5H635fsap-mOwT1wt6kFNJ-g';
