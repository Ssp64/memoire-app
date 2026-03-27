// auth.js — Supabase auth with persistent session + reactive state
import { supabase } from './supabase.js';
import { toast, setLoading } from './ui.js';

// Reactive user state — other modules import this and always get current value
export const authState = { user: null };

// ─── Init: restore session from localStorage (Supabase does this automatically)
// Returns the user if already signed in, null otherwise.
export async function initAuth(onAuthChange) {
  // Supabase stores the session in localStorage automatically.
  // getSession() returns it synchronously from there.
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) authState.user = session.user;

  // Listen for future auth events (login, logout, token refresh, tab sync)
  supabase.auth.onAuthStateChange((event, session) => {
    const prev = authState.user;
    authState.user = session?.user ?? null;

    // Only fire the callback on meaningful changes, not on INITIAL_SESSION
    // which fires on every page load
    if (event !== 'INITIAL_SESSION' && onAuthChange) {
      onAuthChange(event, session?.user ?? null, prev);
    }
  });

  return authState.user;
}

// ─── Sign In ─────────────────────────────────────────────────────────────────
export async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-pass').value;
  const errorEl  = document.getElementById('login-error');
  errorEl.style.display = 'none';

  if (!email || !password) {
    showError('login-error', 'Please enter your email and password.');
    return null;
  }

  setLoading('login-btn', true, 'Signing in...');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  setLoading('login-btn', false, 'Sign In');

  if (error) {
    showError('login-error', friendlyAuthError(error.message));
    return null;
  }

  authState.user = data.user;
  return data.user;
}

// ─── Register ─────────────────────────────────────────────────────────────────
export async function doRegister() {
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-pass').value;
  const confirm  = document.getElementById('reg-confirm').value;

  if (!name || !email || !password) {
    showError('reg-error', 'Please fill in all fields.');
    return null;
  }
  if (password.length < 6) {
    showError('reg-error', 'Password must be at least 6 characters.');
    return null;
  }
  if (password !== confirm) {
    showError('reg-error', 'Passwords do not match.');
    return null;
  }

  setLoading('reg-btn', true, 'Creating account...');
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: name } }
  });
  setLoading('reg-btn', false, 'Create Account');

  if (error) {
    showError('reg-error', friendlyAuthError(error.message));
    return null;
  }

  if (data.user && !data.session) {
    // Email confirmation required
    return 'confirm-email';
  }

  authState.user = data.user;
  return data.user;
}

// ─── Sign Out ─────────────────────────────────────────────────────────────────
export async function doLogout() {
  await supabase.auth.signOut();
  authState.user = null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function getUserName() {
  const u = authState.user;
  if (!u) return '';
  return u.user_metadata?.full_name || u.email?.split('@')[0] || 'User';
}

export function getUserInitials() {
  const name = getUserName();
  return name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2) || '?';
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  el.classList.remove('shake');
  requestAnimationFrame(() => el.classList.add('shake'));
}

function friendlyAuthError(msg) {
  if (msg.includes('Invalid login')) return 'Incorrect email or password.';
  if (msg.includes('Email not confirmed')) return 'Please check your email and confirm your account first.';
  if (msg.includes('User already registered')) return 'An account with this email already exists. Please sign in.';
  if (msg.includes('Password should be')) return 'Password must be at least 6 characters.';
  if (msg.includes('rate limit')) return 'Too many attempts. Please wait a moment and try again.';
  return msg;
}