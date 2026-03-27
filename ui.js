// ui.js — UI helpers: toast, modals, scanning overlay, transitions, animations

// ─── Toast ────────────────────────────────────────────────────────────────────
const ICONS = {
  success:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
  error:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  info:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  warning:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
};

export function toast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${ICONS[type]??ICONS.info}<span>${message}</span>`;
  container.appendChild(el);

  // Auto-dismiss
  const timer = setTimeout(() => dismiss(el), duration);
  el.addEventListener('click', () => { clearTimeout(timer); dismiss(el); });
}

function dismiss(el) {
  el.style.animation = 'toast-out 0.25s ease forwards';
  setTimeout(() => el.remove(), 260);
}

// ─── Loading state on buttons ─────────────────────────────────────────────────
export function setLoading(btnId, loading, text) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) {
    btn._origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span>${text}`;
  } else {
    btn.disabled = false;
    btn.innerHTML = btn._origHTML || text;
  }
}

// ─── Modal helpers ────────────────────────────────────────────────────────────
export function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('open');
  el.querySelector('.modal')?.classList.remove('modal-out');
  document.body.classList.add('modal-open');
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('open')) return;
  const inner = el.querySelector('.modal, .lightbox-inner');
  if (inner) {
    inner.classList.add('modal-out');
    setTimeout(() => {
      el.classList.remove('open');
      inner.classList.remove('modal-out');
      document.body.classList.remove('modal-open');
    }, 220);
  } else {
    el.classList.remove('open');
    document.body.classList.remove('modal-open');
  }
}

// Close on backdrop click
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modal-overlay').forEach(el => {
    el.addEventListener('click', e => { if (e.target === el) closeModal(el.id); });
  });
  // Keyboard ESC
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const open = document.querySelector('.modal-overlay.open');
      if (open) closeModal(open.id);
    }
  });
});

// ─── Auth tab switcher ────────────────────────────────────────────────────────
export function switchAuthTab(tab) {
  document.getElementById('tab-login')?.classList.toggle('active', tab === 'login');
  document.getElementById('tab-register')?.classList.toggle('active', tab === 'register');
  const loginEl = document.getElementById('auth-login');
  const regEl   = document.getElementById('auth-register');
  if (tab === 'login') {
    fadeIn(loginEl); regEl.style.display='none';
  } else {
    fadeIn(regEl); loginEl.style.display='none';
  }
}

function fadeIn(el) {
  el.style.display = 'block';
  el.style.opacity = '0';
  el.style.transform = 'translateY(6px)';
  requestAnimationFrame(() => {
    el.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
}

// ─── Page/view transition ─────────────────────────────────────────────────────
let isTransitioning = false;

export async function transitionTo(fromId, toId, callback) {
  if (isTransitioning) return;
  isTransitioning = true;

  const from = document.getElementById(fromId);
  const to   = document.getElementById(toId);

  if (from && from.classList.contains('active')) {
    from.style.transition = 'opacity 0.18s ease';
    from.style.opacity = '0';
    await delay(180);
    from.classList.remove('active');
    from.style.opacity = '';
    from.style.transition = '';
  }

  if (callback) callback();

  if (to) {
    to.classList.add('active');
    to.style.opacity = '0';
    to.style.transform = 'translateY(10px)';
    requestAnimationFrame(() => {
      to.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      to.style.opacity = '1';
      to.style.transform = 'translateY(0)';
      setTimeout(() => {
        to.style.opacity = '';
        to.style.transform = '';
        to.style.transition = '';
        isTransitioning = false;
      }, 260);
    });
  } else {
    isTransitioning = false;
  }
}

// ─── Scanning overlay ─────────────────────────────────────────────────────────
let scanInterval = null;

export function showScanning(label = 'Processing...') {
  document.getElementById('scanning-label').textContent = label;
  const overlay = document.getElementById('scanning-overlay');
  overlay.classList.add('open');
  const bar = document.getElementById('scan-progress-bar');
  bar.style.transition = 'none';
  bar.style.width = '0%';
  let pct = 0;
  clearInterval(scanInterval);
  scanInterval = setInterval(() => {
    pct = Math.min(pct + Math.random() * 3 + 0.8, 88);
    bar.style.transition = 'width 0.2s ease';
    bar.style.width = pct + '%';
  }, 150);
}

export function hideScanning() {
  clearInterval(scanInterval);
  const bar = document.getElementById('scan-progress-bar');
  bar.style.transition = 'width 0.3s ease';
  bar.style.width = '100%';
  setTimeout(() => {
    document.getElementById('scanning-overlay').classList.remove('open');
    setTimeout(() => { bar.style.width = '0%'; }, 300);
  }, 350);
}

// ─── Step indicator ───────────────────────────────────────────────────────────
export function setStep(n) {
  for (let i=1;i<=3;i++) {
    const el = document.getElementById('step-'+i);
    if (!el) continue;
    el.classList.remove('active','done');
    if (i < n) el.classList.add('done');
    if (i === n) el.classList.add('active');
  }
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────
export function openLightbox(src, name) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox-meta').textContent = name || '';
  openModal('lightbox');
}

export function closeLightbox() { closeModal('lightbox'); }

// ─── Stagger animate children ────────────────────────────────────────────────
export function staggerIn(parentEl, selector = ':scope > *', baseDelay = 40) {
  const children = parentEl.querySelectorAll(selector);
  children.forEach((child, i) => {
    child.style.opacity = '0';
    child.style.transform = 'translateY(12px)';
    setTimeout(() => {
      child.style.transition = 'opacity 0.28s ease, transform 0.28s ease';
      child.style.opacity = '1';
      child.style.transform = 'translateY(0)';
    }, i * baseDelay + 20);
  });
}

// ─── Number count-up animation ────────────────────────────────────────────────
export function countUp(el, target, duration = 600) {
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  const step  = (target - start) / (duration / 16);
  let current = start;
  const tick = () => {
    current += step;
    if ((step > 0 && current >= target) || (step < 0 && current <= target)) {
      el.textContent = target;
      return;
    }
    el.textContent = Math.round(current);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }