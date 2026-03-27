// supabase.js — single shared client instance
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = 'https://ogbrblkfqroxlnulgyvg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nYnJibGtmcXJveGxudWxneXZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1MzY2MTUsImV4cCI6MjA5MDExMjYxNX0.8ewXwBwz1871Mvaau3KykfoZc52GPpLukCRre5LjGyI';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);