// app.js — Memoire frontend application
import { supabase } from './supabase.js';
import {
  authState, initAuth,
  doLogin as authLogin, doRegister as authRegister, doLogout as authLogout,
  getUserName, getUserInitials,
} from './auth.js';
import {
  createEvent, loadEvents, loadEvent, deleteEvent,
  loadMedia, uploadFiles, reindexEvent,
} from './events.js';
import {
  loadModels, drawCameraOverlay, matchViaBackend,
  clusterViaBackend, checkBackendHealth, parseFaceEmbeddings,
} from './face.js';
import {
  toast, showScanning, hideScanning, openModal, closeModal,
  switchAuthTab as _switchAuthTab, openLightbox, closeLightbox,
  setStep, staggerIn, countUp, transitionTo, setLoading,
} from './ui.js';

// ─── App state ────────────────────────────────────────────────────────────────
const state = {
  events:        [],
  currentEventId: null,
  currentMedia:  [],
  currentPeople: [],
  mergeMode:     false,
  mergeSelected: [],
  // mergeLog: array of {groupA:[photoIds], groupB:[photoIds]}
  // Each entry = one explicit user merge. Loaded from DB on people tab open.
  mergeLog:      [],
  selectedFiles: [],
  cameraStream:  null,
  detectLoop:    null,
  scanMode:      'upload',
  guestAllMedia: [],
  guestPeople:   [],
};

// ─── Expose functions to inline HTML handlers ─────────────────────────────────
Object.assign(window, {
  navigate, openModal, closeModal,
  switchAuthTab: _switchAuthTab,
  doLogin: handleLogin,
  doRegister: handleRegister,
  doLogout: handleLogout,
  doCreateEvent: handleCreateEvent,
  deleteCurrentEvent: handleDeleteEvent,
  copyShareLink, showSection, goToUploadForEvent,
  handleDragOver, handleDragLeave, handleDrop, handleFileInput,
  clearUpload, doUploadFiles: handleUploadFiles,
  switchScanMode, captureAndMatch, handleFaceFileSelect, runPhotoMatch,
  resetFaceUpload, resetGuestView, closeLightbox, openEventDetail,
  openLightbox, reindexCurrentEvent, switchDetailTab, closePerson, openPerson,
  removeMediaItem, showFindMyPhotos, downloadAllMatchedPhotos,
  toggleMergeMode, selectPersonForMerge, executeMerge, cancelMerge,
  applyFaceZoom,
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  document.body.style.opacity = '0';
  loadModels().catch(() => {});

  const params     = new URLSearchParams(location.search);
  const eventParam = params.get('event');
  const user       = await initAuth(onAuthStateChanged);

  document.body.style.transition = 'opacity 0.3s ease';
  document.body.style.opacity    = '1';

  if (eventParam) {
    state.currentEventId = eventParam;
    navigate('guest');
    return;
  }

  if (user) navigate('dashboard');
  else      navigate('landing');
}

function onAuthStateChanged(event, user) {
  const params = new URLSearchParams(location.search);
  if (params.get('event')) return; // guest view — ignore auth changes
  if (event === 'SIGNED_IN')  navigate('dashboard');
  if (event === 'SIGNED_OUT') navigate('landing');
}

// Refresh session every 10 min
setInterval(() => {
  if (authState.user) supabase.auth.refreshSession().catch(() => {});
}, 10 * 60 * 1000);

boot();

// ─── Navigation ───────────────────────────────────────────────────────────────
let currentView = 'landing';

function navigate(view) {
  stopCamera();
  if (view === 'dashboard' && !authState.user) { openModal('auth-modal'); return; }
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const viewMap = { landing: 'view-landing', dashboard: 'view-dashboard', guest: 'view-guest' };
  const el = document.getElementById(viewMap[view]);
  if (el) el.classList.add('active');
  currentView = view;
  if (view === 'dashboard') initDashboard();
  else if (view === 'guest') initGuestView();
  else if (view === 'landing') initLanding();
}

function initLanding() {
  const hero = document.querySelector('.hero-left');
  if (!hero) return;
  ['.hero-eyebrow', '.hero-title', '.hero-sub', '.hero-ctas'].forEach((s, i) => {
    const el = hero.querySelector(s);
    if (!el) return;
    el.style.opacity   = '0';
    el.style.transform = 'translateY(18px)';
    setTimeout(() => {
      el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
      el.style.opacity    = '1';
      el.style.transform  = 'translateY(0)';
    }, 80 + i * 100);
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function handleLogin() {
  const user = await authLogin();
  if (!user) return;
  closeModal('auth-modal');
  toast('Welcome back, ' + getUserName(), 'success');
  navigate('dashboard');
}

async function handleRegister() {
  const result = await authRegister();
  if (!result) return;
  if (result === 'confirm-email') {
    document.getElementById('auth-register').style.display = 'none';
    document.getElementById('auth-login').style.display    = 'block';
    document.getElementById('auth-login').innerHTML = `
      <div class="confirm-email-message">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"
          style="color:var(--accent);margin-bottom:1rem">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
          <polyline points="22,6 12,13 2,6"/>
        </svg>
        <div style="font-size:0.95rem;font-weight:600;color:var(--c4);margin-bottom:0.5rem">Check your email</div>
        <div style="font-family:var(--font-mono);font-size:0.65rem;color:var(--text-dim);line-height:1.7">
          We sent a confirmation link. Click it to activate your account, then sign in.
        </div>
        <button class="btn btn-outline" style="margin-top:1.5rem;width:100%"
          onclick="switchAuthTab('login');location.reload()">Go to Sign In</button>
      </div>`;
    return;
  }
  closeModal('auth-modal');
  toast('Account created. Welcome, ' + getUserName() + '!', 'success');
  navigate('dashboard');
}

async function handleLogout() {
  await authLogout();
  toast('Signed out.');
  navigate('landing');
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function initDashboard() {
  updateUserUI();
  await loadDashboard();
}

function updateUserUI() {
  const name     = getUserName();
  const initials = getUserInitials();
  const nameEl   = document.getElementById('nav-user-name');
  const avEl     = document.getElementById('user-avatar');
  const wlEl     = document.getElementById('dash-welcome');
  if (nameEl) nameEl.textContent = name;
  if (avEl)   avEl.textContent   = initials;
  if (wlEl)   wlEl.textContent   = 'Welcome, ' + name;
}

async function loadDashboard() {
  const events   = await loadEvents();
  state.events   = events;
  countUp(document.getElementById('stat-events'), events.length);
  countUp(document.getElementById('stat-photos'), events.reduce((a, e) => a + (e.photo_count || 0), 0));
  const countEl = document.getElementById('events-count');
  if (countEl) countEl.textContent = events.length;

  // Populate event select for upload
  const sel = document.getElementById('upload-event-select');
  if (sel) {
    sel.innerHTML = '<option value="">Choose an event...</option>';
    events.forEach(e => {
      const opt = document.createElement('option');
      opt.value       = e.id;
      opt.textContent = e.name;
      sel.appendChild(opt);
    });
  }

  renderEventCards(events);
}

function renderEventCards(events) {
  const grid = document.getElementById('events-grid');
  if (!grid) return;

  let html = `<div class="event-card event-card-new" onclick="openModal('create-event-modal')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="16"/>
      <line x1="8" y1="12" x2="16" y2="12"/>
    </svg>
    <span>New Event</span>
  </div>`;

  events.forEach(ev => {
    html += `<div class="event-card" onclick="openEventDetail('${ev.id}')">
      <div class="event-thumb">
        <div class="event-thumb-pattern"></div>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
          stroke="rgba(211,218,217,0.2)" stroke-width="1.2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <div class="event-photo-pill">${ev.photo_count ?? 0} photos</div>
      </div>
      <div class="event-body">
        <div class="event-name">${escapeHtml(ev.name)}</div>
        <div class="event-meta-row">
          <span>${ev.date || 'No date'}</span>
          ${ev.location ? `<span>${escapeHtml(ev.location)}</span>` : ''}
        </div>
        <div class="event-card-actions">
          <button class="btn btn-secondary"
            onclick="event.stopPropagation();openEventDetail('${ev.id}')">Manage</button>
          <button class="btn btn-outline"
            onclick="event.stopPropagation();copyEventLink('${ev.id}')">Share Link</button>
        </div>
      </div>
    </div>`;
  });

  grid.innerHTML = html;
  staggerIn(grid, '.event-card', 50);
}

// ─── Event detail ─────────────────────────────────────────────────────────────
async function openEventDetail(id) {
  // Only reset people state when switching to a different event.
  // This prevents the back-from-person-view triggering a re-cluster.
  if (state.currentEventId !== id) {
    state.currentPeople = [];
    state.mergeLog      = [];
  }
  state.currentEventId = id;

  const ev = state.events.find(e => e.id === id) || await loadEvent(id);
  if (!ev) return;

  document.getElementById('detail-name').textContent = ev.name;
  document.getElementById('detail-meta').textContent =
    [ev.date, ev.location].filter(Boolean).join(' — ');
  document.getElementById('detail-share-link').textContent = buildShareLink(id);
  document.getElementById('detail-chips').innerHTML = `
    <span class="chip chip-green">Active</span>
    <span class="chip chip-amber">${ev.photo_count ?? 0} photos</span>
    ${ev.date ? `<span class="chip chip-purple">${ev.date}</span>` : ''}`;

  await refreshMediaGrid(id);
  switchDetailTab('photos');
  showSection('detail', null);
}

async function refreshMediaGrid(id) {
  const media = await loadMedia(id);
  state.currentMedia = media;

  const countEl = document.getElementById('detail-photo-count');
  if (countEl) countEl.textContent = `(${media.length})`;

  const grid  = document.getElementById('detail-media-grid');
  const empty = document.getElementById('detail-empty');
  if (!grid) return;

  if (!media.length) {
    grid.style.display  = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }

  if (empty) empty.style.display = 'none';
  grid.style.display = 'grid';
  grid.innerHTML = media.map(m => `
    <div class="media-item" data-id="${m.id}">
      <img src="${m.url}" alt="${escapeHtml(m.file_name)}" loading="lazy"
        onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')">
      ${m.file_type === 'video' ? '<div class="video-tag">VIDEO</div>' : ''}
      ${!hasIndexedFaces(m) ? '<div class="no-face-tag" title="No face detected"></div>' : ''}
      <button class="media-delete-btn"
        onclick="removeMediaItem('${m.id}','${m.storage_path}')" title="Remove">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="3">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
      <div class="media-item-overlay"
        onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="white" stroke-width="1.5">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </div>
    </div>`).join('');
  staggerIn(grid, '.media-item', 25);
}

async function removeMediaItem(mediaId, storagePath) {
  if (!confirm('Remove this photo? This cannot be undone.')) return;
  if (storagePath) await supabase.storage.from('event-media').remove([storagePath]);
  await supabase.from('media').delete().eq('id', mediaId);
  state.currentMedia = state.currentMedia.filter(m => m.id !== mediaId);
  const el = document.querySelector(`.media-item[data-id="${mediaId}"]`);
  if (el) {
    el.style.opacity   = '0';
    el.style.transform = 'scale(0.8)';
    setTimeout(() => el.remove(), 200);
  }
  toast('Photo removed.', 'success');
  const countEl = document.getElementById('detail-photo-count');
  if (countEl) countEl.textContent = `(${state.currentMedia.length})`;
}

// ─── People tab ───────────────────────────────────────────────────────────────
function switchDetailTab(tab) {
  ['photos', 'people', 'person'].forEach(t => {
    const panel = document.getElementById('detail-panel-' + t);
    if (panel) panel.style.display = (t === tab) ? 'block' : 'none';
  });
  document.getElementById('detail-tab-photos')
    ?.classList.toggle('active', tab === 'photos');
  document.getElementById('detail-tab-people')
    ?.classList.toggle('active', tab === 'people');

  if (tab === 'people') loadPeoplePanel();
}

// ─── Persistent merge helpers ─────────────────────────────────────────────────
// Requires this table in Supabase (run once):
//
//   create table if not exists person_merges (
//     event_id      text primary key,
//     merged_groups jsonb not null default '[]'::jsonb,
//     updated_at    timestamptz default now()
//   );
//   alter table person_merges enable row level security;
//   create policy "auth users" on person_merges
//     for all using (auth.uid() is not null);

async function saveMerges(eventId, mergeLog) {
  if (!eventId) return;
  try {
    await supabase.from('person_merges').upsert(
      { event_id: eventId, merged_groups: mergeLog, updated_at: new Date().toISOString() },
      { onConflict: 'event_id' }
    );
  } catch (err) {
    console.warn('[merge] saveMerges failed:', err);
  }
}

async function loadSavedMerges(eventId) {
  if (!eventId) return null;
  try {
    const { data, error } = await supabase
      .from('person_merges')
      .select('merged_groups')
      .eq('event_id', eventId)
      .maybeSingle();
    if (error || !data) return null;
    return data.merged_groups;
  } catch (err) {
    console.warn('[merge] loadSavedMerges failed:', err);
    return null;
  }
}

// Re-apply saved merges onto freshly-clustered people.
// Strategy: for each saved merge entry {groupA, groupB}, find the cluster
// with the MOST overlap with groupA and the cluster with the MOST overlap
// with groupB. If they are different clusters, merge them.
// This is purely best-match — no threshold — so even 1 photo is enough
// to identify which cluster a saved group maps to. But we ONLY merge the
// two best-matching clusters (one per side), so unrelated clusters are
// never pulled in.
function applySavedMerges(people, mergeLog) {
  if (!mergeLog || !mergeLog.length) return people;
  let result = [...people];

  function bestClusterIdx(clusters, group) {
    if (!group || !group.length) return -1;
    const set = new Set(group);
    let bestIdx = -1, bestCount = 0;
    clusters.forEach((p, i) => {
      const count = (p.photo_ids || []).filter(id => set.has(id)).length;
      if (count > bestCount) { bestCount = count; bestIdx = i; }
    });
    return bestIdx; // -1 = no overlap at all
  }

  for (const entry of mergeLog) {
    // Support both {groupA, groupB} format and legacy {photoIds} format
    const groupA = entry.groupA || entry.photoIds || [];
    const groupB = entry.groupB || [];
    if (!groupA.length && !groupB.length) continue;

    const idxA = bestClusterIdx(result, groupA);
    const idxB = bestClusterIdx(result, groupB);

    // If both map to the same cluster → already merged, nothing to do
    if (idxA === idxB) continue;

    // Collect indices that are valid and distinct
    const toMerge = [...new Set([idxA, idxB].filter(i => i !== -1))];
    if (toMerge.length < 2) continue;

    // Merge all into the one with the lowest index
    const minIdx = Math.min(...toMerge);
    const base   = result[minIdx];
    const others = toMerge.filter(i => i !== minIdx).map(i => result[i]);

    const allPhotoIds = [...new Set([
      ...base.photo_ids,
      ...others.flatMap(p => p.photo_ids),
    ])];

    const merged = {
      ...base,
      photo_ids:   allPhotoIds,
      photo_count: allPhotoIds.length,
      face_count:  base.face_count + others.reduce((s, p) => s + p.face_count, 0),
    };

    result = result.filter((_, i) => !toMerge.includes(i));
    result.splice(minIdx, 0, merged);
  }

  // Re-number
  return result.map((p, i) => ({ ...p, person_index: i, label: `Person ${i + 1}` }));
}

// ─── Load & render people panel ───────────────────────────────────────────────
async function loadPeoplePanel() {
  const loadingEl = document.getElementById('people-loading');
  const gridEl    = document.getElementById('people-grid');
  const emptyEl   = document.getElementById('people-empty');

  // If we already have people in memory, just re-render — no re-cluster.
  // This is what makes "back" from a person view instant and stable.
  if (state.currentPeople.length > 0) {
    renderPeopleGrid(state.currentPeople);
    return;
  }

  const indexed = (state.currentMedia || []).filter(hasIndexedFaces);

  if (!indexed.length) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (gridEl)    gridEl.style.display    = 'none';
    if (emptyEl)   emptyEl.style.display   = 'block';
    return;
  }

  if (loadingEl) loadingEl.style.display = 'block';
  if (gridEl)    gridEl.style.display    = 'none';
  if (emptyEl)   emptyEl.style.display   = 'none';

  // Cluster
  const clusterRes = await clusterViaBackend(indexed);
  let people = clusterRes.people || [];

  // Load and apply saved merges
  if (state.currentEventId && people.length) {
    const saved = await loadSavedMerges(state.currentEventId);
    if (saved && saved.length) {
      state.mergeLog = saved;
      people = applySavedMerges(people, saved);
    }
  }

  state.currentPeople = people;

  if (loadingEl) loadingEl.style.display = 'none';

  if (!people.length) {
    if (emptyEl) emptyEl.style.display = 'block';
  } else {
    const countEl = document.getElementById('detail-people-count');
    if (countEl) countEl.textContent = `(${people.length})`;
    renderPeopleGrid(people);
  }
}

// Compute face-zoom CSS for a person-thumb image.
// Given a face bbox [x1,y1,x2,y2] in the stored image's pixel space,
// we use object-position to shift the img so the face center is centered
// inside the circular thumb, and scale it up so the face fills the circle.
//
// person (optional) — pass the cluster object so we can pick the right face
// when the representative photo contains multiple people. When provided and
// the photo has multiple faces, we find the face whose embedding is most
// similar to the centroid of the person's OTHER photos.  Falls back to the
// highest-det_score face if we can't build a reference.
function faceZoomStyle(repPhoto, person) {
  if (!repPhoto) return null;

  // Parse face_metadata — it may be a JSON string or already an array
  let meta = repPhoto.face_metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { return null; }
  }
  if (!Array.isArray(meta) || !meta.length) return null;

  // ── Pick which face in the photo belongs to this person ──────────────────
  let chosenIdx = -1;

  // Only attempt embedding-based selection when there are multiple faces AND
  // we were given a person object to build a reference from.
  if (meta.length > 1 && person) {
    try {
      // Parse face_embeddings on the rep photo (one embedding per face, same
      // order as face_metadata).
      let repEmbs = repPhoto.face_embeddings;
      if (typeof repEmbs === 'string') repEmbs = JSON.parse(repEmbs);
      // Normalise flat single-embedding → array-of-arrays
      if (Array.isArray(repEmbs) && repEmbs.length && typeof repEmbs[0] === 'number') {
        repEmbs = [repEmbs];
      }

      if (Array.isArray(repEmbs) && repEmbs.length >= meta.length) {
        // Build a reference centroid from the OTHER photos in this cluster.
        const photoMap = {};
        for (const m of state.currentMedia) photoMap[m.id] = m;

        const refs = [];
        for (const pid of (person.photo_ids || [])) {
          if (pid === repPhoto.id) continue;       // skip the shared photo itself
          const m = photoMap[pid];
          if (!m) continue;
          let embs = m.face_embeddings;
          if (typeof embs === 'string') embs = JSON.parse(embs);
          if (Array.isArray(embs) && embs.length) {
            if (typeof embs[0] === 'number') embs = [embs];
            for (const e of embs) {
              if (Array.isArray(e) && e.length >= 128) refs.push(e);
            }
          }
        }

        if (refs.length) {
          // Average into centroid
          const dim      = refs[0].length;
          const centroid = new Array(dim).fill(0);
          for (const e of refs) for (let d = 0; d < dim; d++) centroid[d] += e[d];
          for (let d = 0; d < dim; d++) centroid[d] /= refs.length;

          // Cosine similarity — pick the most similar face in the rep photo
          let bestSim = -Infinity;
          for (let i = 0; i < meta.length; i++) {
            const emb = repEmbs[i];
            if (!Array.isArray(emb) || emb.length < 128) continue;
            let dot = 0, nA = 0, nB = 0;
            for (let d = 0; d < dim; d++) {
              dot += emb[d] * centroid[d];
              nA  += emb[d] * emb[d];
              nB  += centroid[d] * centroid[d];
            }
            const sim = (nA && nB) ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
            if (sim > bestSim) { bestSim = sim; chosenIdx = i; }
          }
        }
      }
    } catch (_) {
      // Any parse error → fall through to det_score fallback below
    }
  }

  // Fallback: highest detection confidence (original behaviour)
  if (chosenIdx === -1) {
    chosenIdx = meta.reduce(
      (best, f, i) => (f.det_score > meta[best].det_score ? i : best), 0
    );
  }

  const bbox = meta[chosenIdx].bbox; // [x1, y1, x2, y2]
  if (!Array.isArray(bbox) || bbox.length < 4) return null;

  const [x1, y1, x2, y2] = bbox;
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;

  return { bbox: [x1, y1, x2, y2] };
}

// After an img loads, apply face-zoom based on its natural dimensions + bbox.
function applyFaceZoom(img, bbox) {
  const [x1, y1, x2, y2] = bbox;
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (!W || !H) return;

  const faceCX = (x1 + x2) / 2;
  const faceCY = (y1 + y2) / 2;
  const faceW  = x2 - x1;
  const faceH  = y2 - y1;

  // How large is the face relative to the image?
  // We want the face to fill ~80% of the circular thumb (leaving a little padding).
  // scale = thumbSize / (faceSize_in_px * (thumbSize/imageSize))
  // Simplified: the img inside the circle has object-fit:cover.
  // With object-fit:cover the img fills the container at its aspect ratio.
  // We instead use a wrapper approach: no object-fit, manual transform.

  // Percentage position: shift the image so face center aligns with thumb center.
  // object-position X% Y% means: the X% point of the image aligns with
  // the X% point of the container. So we want:
  //   posX = faceCX / W * 100
  //   posY = faceCY / H * 100
  const posX = (faceCX / W) * 100;
  const posY = (faceCY / H) * 100;

  // Scale: we want the face to appear at ~70% of the thumb diameter.
  // The thumb is square (CSS makes it a circle). The img has object-fit:cover
  // which already fills the container. On top of that we need an extra scale
  // so the face (faceH pixels tall) maps to thumbHeight * 0.7.
  // The img rendered height (with object-fit:cover) = containerH if landscape,
  // or containerH * (imgAR / containerAR) if portrait. We approximate:
  // rendered face height in container = (faceH / H) * containerH_in_img_space
  // where img_space_height = containerH when H/W <= containerH/containerW.
  // Since thumb is square: containerAR = 1.
  // img covers the square: rendered img H = max(containerH, containerH * H/W ... )
  // Actually with object-fit:cover on a square:
  //   renderedW = containerH * (W/H)  if W/H > 1 (landscape)
  //   renderedH = containerH          always (the shorter side fills)
  // So face height in rendered px = (faceH / H) * containerH
  // We want that to be 0.70 * containerH → scale = 0.70 / (faceH/H)
  // Cap scale so we don't zoom in absurdly on tiny faces.
  const faceRatio = Math.min(faceW / W, faceH / H);
  const targetRatio = 0.68; // face should fill 68% of the thumb
  let scale = targetRatio / faceRatio;
  scale = Math.min(Math.max(scale, 1.0), 6.0); // clamp 1× – 6×

  img.style.objectFit      = 'cover';
  img.style.objectPosition = `${posX.toFixed(1)}% ${posY.toFixed(1)}%`;
  img.style.transform      = `scale(${scale.toFixed(2)})`;
  img.style.transformOrigin = `${posX.toFixed(1)}% ${posY.toFixed(1)}%`;
}

function renderPeopleGrid(people) {
  const gridEl = document.getElementById('people-grid');
  if (!gridEl) return;
  gridEl.style.display = 'grid';

  const photoMap = {};
  for (const m of state.currentMedia) photoMap[m.id] = m;

  // Merge toolbar
  const mergeBar = document.getElementById('people-merge-bar');
  if (mergeBar) {
    if (state.mergeMode) {
      const n = state.mergeSelected.length;
      mergeBar.innerHTML = `
        <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">
          <span style="font-family:var(--font-mono);font-size:0.62rem;color:var(--accent)">
            SELECT 2 FOLDERS TO MERGE${n > 0 ? ' — ' + n + ' selected' : ''}
          </span>
          ${n === 2 ? `<button class="btn btn-primary"
              style="font-size:0.65rem;padding:0.35rem 1rem" onclick="executeMerge()">
              Merge Folders
            </button>` : ''}
          <button class="btn btn-ghost"
            style="font-size:0.65rem;padding:0.35rem 0.75rem" onclick="cancelMerge()">
            Cancel
          </button>
        </div>`;
      mergeBar.style.display = 'block';
    } else {
      mergeBar.style.display = 'none';
    }
  }

  gridEl.innerHTML = people.map((p, i) => {
    const repPhoto   = photoMap[p.representative_photo_id] || photoMap[p.photo_ids?.[0]];
    const thumbUrl   = repPhoto?.url || p.representative_url || '';
    const zoomData   = repPhoto ? faceZoomStyle(repPhoto, p) : null;
    const isSelected = state.mergeSelected.includes(i);
    const clickFn    = state.mergeMode
      ? `selectPersonForMerge(${i})`
      : `openPerson(${i})`;

    // Encode bbox as a data attribute so the onload handler can apply zoom
    const bboxAttr = zoomData
      ? `data-bbox="${zoomData.bbox.join('_')}"`
      : '';

    return `<div class="person-card${isSelected ? ' person-card-selected' : ''}"
        onclick="${clickFn}">
      <div class="person-thumb">
        ${thumbUrl
          ? `<img src="${thumbUrl}" alt="Person ${p.person_index + 1}" loading="lazy"
              ${bboxAttr}
              onload="this.dataset.bbox && applyFaceZoom(this, this.dataset.bbox.split('_').map(Number))">`
          : `<div class="person-thumb-fallback">P${p.person_index + 1}</div>`}
        <div class="person-face-ring"></div>
        ${isSelected ? `<div style="position:absolute;inset:0;background:rgba(168,144,128,0.45);
            border-radius:50%;display:flex;align-items:center;justify-content:center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
              stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
          </div>` : ''}
      </div>
      <div class="person-label">Person ${p.person_index + 1}</div>
      <div class="person-count">${p.photo_count} photo${p.photo_count !== 1 ? 's' : ''}</div>
    </div>`;
  }).join('');

  staggerIn(gridEl, '.person-card', 40);
}

// ─── Merge UI ─────────────────────────────────────────────────────────────────
function toggleMergeMode() {
  state.mergeMode     = !state.mergeMode;
  state.mergeSelected = [];
  document.getElementById('merge-mode-btn')
    ?.classList.toggle('active', state.mergeMode);
  renderPeopleGrid(state.currentPeople);
}

function selectPersonForMerge(index) {
  if (!state.mergeMode) return;
  const pos = state.mergeSelected.indexOf(index);
  if (pos > -1) {
    state.mergeSelected.splice(pos, 1);
  } else if (state.mergeSelected.length < 2) {
    state.mergeSelected.push(index);
  } else {
    toast('Select only 2 folders to merge.', 'error');
    return;
  }
  renderPeopleGrid(state.currentPeople);
}

function executeMerge() {
  if (state.mergeSelected.length !== 2) return;
  const [ia, ib] = state.mergeSelected;
  const pa = state.currentPeople[ia];
  const pb = state.currentPeople[ib];
  if (!pa || !pb) return;

  // Record the two ORIGINAL photo_id sets before merging.
  // We save these separately so applySavedMerges can find each side
  // independently after a re-cluster, without pulling in unrelated clusters.
  const savedEntry = { groupA: [...pa.photo_ids], groupB: [...pb.photo_ids] };

  const mergedPhotoIds = [...new Set([...pa.photo_ids, ...pb.photo_ids])];
  const mergedPerson = {
    ...pa,
    photo_ids:   mergedPhotoIds,
    photo_count: mergedPhotoIds.length,
    face_count:  pa.face_count + pb.face_count,
  };

  const minIdx   = Math.min(ia, ib);
  const newPeople = state.currentPeople.filter((_, i) => i !== ia && i !== ib);
  newPeople.splice(minIdx, 0, mergedPerson);
  state.currentPeople = newPeople.map((p, i) => ({ ...p, person_index: i, label: `Person ${i + 1}` }));

  // Exit merge mode
  state.mergeMode     = false;
  state.mergeSelected = [];
  document.getElementById('merge-mode-btn')?.classList.remove('active');

  const countEl = document.getElementById('detail-people-count');
  if (countEl) countEl.textContent = `(${state.currentPeople.length})`;

  toast(`Merged — ${mergedPhotoIds.length} photo${mergedPhotoIds.length !== 1 ? 's' : ''} in this folder.`, 'success');
  renderPeopleGrid(state.currentPeople);

  // Persist: append this merge to the log and save
  state.mergeLog.push(savedEntry);
  if (state.currentEventId) {
    saveMerges(state.currentEventId, state.mergeLog);
  }
}

function cancelMerge() {
  state.mergeMode     = false;
  state.mergeSelected = [];
  document.getElementById('merge-mode-btn')?.classList.remove('active');
  renderPeopleGrid(state.currentPeople);
}

// ─── Person detail view ───────────────────────────────────────────────────────
function openPerson(personIndex) {
  const person = state.currentPeople[personIndex];
  if (!person) return;

  const photoMap = {};
  for (const m of state.currentMedia) photoMap[m.id] = m;
  const photos = (person.photo_ids || []).map(id => photoMap[id]).filter(Boolean);

  document.getElementById('person-detail-name').textContent =
    `Person ${person.person_index + 1}`;
  document.getElementById('person-detail-meta').textContent =
    `${person.photo_count} photo${person.photo_count !== 1 ? 's' : ''} · ${person.face_count} face detection${person.face_count !== 1 ? 's' : ''}`;

  const avatarEl = document.getElementById('person-detail-avatar');
  const rep = photoMap[person.representative_photo_id] || photos[0];
  if (rep) {
    const zoomData = faceZoomStyle(rep, person);
    const bboxAttr = zoomData ? `data-bbox="${zoomData.bbox.join('_')}"` : '';
    avatarEl.innerHTML = `<img src="${rep.url}" alt="Person"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%"
        ${bboxAttr}
        onload="this.dataset.bbox && applyFaceZoom(this, this.dataset.bbox.split('_').map(Number))">`;
  } else {
    avatarEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;
        height:100%;font-family:var(--font-mono);font-size:1.2rem;
        color:var(--accent)">P${person.person_index + 1}</div>`;
  }

  const grid = document.getElementById('person-media-grid');
  grid.innerHTML = photos.map(m => `
    <div class="media-item"
      onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')">
      <img src="${m.url}" alt="${escapeHtml(m.file_name)}" loading="lazy">
      <div class="media-item-overlay">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="white" stroke-width="1.5">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </div>
    </div>`).join('');
  staggerIn(grid, '.media-item', 25);

  switchDetailTab('person');
  document.getElementById('detail-tab-people')?.classList.add('active');
  document.getElementById('detail-tab-photos')?.classList.remove('active');
}

function closePerson() {
  switchDetailTab('people');
}

// ─── Reindex ──────────────────────────────────────────────────────────────────
async function reindexCurrentEvent() {
  if (!state.currentEventId) return;

  // Clear in-memory people — we're rebuilding from scratch
  state.currentPeople = [];
  state.mergeLog      = [];

  // 1. Re-run face detection on all photos (reindexEvent clears stale embeddings first)
  await reindexEvent(state.currentEventId);

  // 2. Re-fetch fresh media (with new embeddings) into state.currentMedia
  await refreshMediaGrid(state.currentEventId);

  // 3. Filter to only photos with valid embeddings
  const indexed = (state.currentMedia || []).filter(hasIndexedFaces);
  if (!indexed.length) {
    toast('No faces detected. Check your photos or backend connection.', 'warning');
    return;
  }

  // 4. Cluster fresh embeddings
  const clusterRes = await clusterViaBackend(indexed);
  state.currentPeople = clusterRes.people || [];

  // 5. Re-apply any saved merges on top of the new clusters
  const saved = await loadSavedMerges(state.currentEventId);
  if (saved && saved.length && state.currentPeople.length) {
    state.mergeLog      = saved;
    state.currentPeople = applySavedMerges(state.currentPeople, saved);
  }

  const n = state.currentPeople.length;
  toast(`Done — ${n} person${n !== 1 ? 's' : ''} found across ${indexed.length} photos.`, 'success');

  // 6. If the people tab is currently visible, refresh the grid
  const peoplePanel = document.getElementById('detail-panel-people');
  if (peoplePanel && peoplePanel.style.display !== 'none') {
    const countEl = document.getElementById('detail-people-count');
    if (countEl) countEl.textContent = `(${n})`;
    renderPeopleGrid(state.currentPeople);
  }
}

// ─── Sections / navigation helpers ────────────────────────────────────────────
function showSection(name, sidebarEl) {
  ['events', 'upload', 'detail'].forEach(s => {
    const el = document.getElementById('section-' + s);
    if (el) el.style.display = (s === name) ? 'block' : 'none';
  });
  if (sidebarEl) {
    document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    sidebarEl.classList.add('active');
  }
}

function goToUploadForEvent() {
  const sel = document.getElementById('upload-event-select');
  if (state.currentEventId && sel) sel.value = state.currentEventId;
  showSection('upload', document.getElementById('nav-upload'));
}

async function handleCreateEvent() {
  const ev = await createEvent();
  if (!ev) return;
  closeModal('create-event-modal');
  await loadDashboard();
}

async function handleDeleteEvent() {
  if (!state.currentEventId) return;
  if (!confirm('Delete this event and all its photos? This cannot be undone.')) return;
  const ok = await deleteEvent(state.currentEventId);
  if (ok) {
    state.currentEventId = null;
    showSection('events', document.getElementById('nav-events'));
    await loadDashboard();
  }
}

function buildShareLink(id) {
  return `${location.origin}${location.pathname}?event=${id}`;
}
function copyShareLink() {
  const text = document.getElementById('detail-share-link')?.textContent;
  if (text) navigator.clipboard.writeText(text).then(() => toast('Link copied.', 'success'));
}
window.copyEventLink = id =>
  navigator.clipboard.writeText(buildShareLink(id)).then(() => toast('Link copied.', 'success'));

// ─── Upload ───────────────────────────────────────────────────────────────────
function handleDragOver(e)  { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function handleDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function handleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  addFiles(Array.from(e.dataTransfer.files));
}
function handleFileInput(e) { addFiles(Array.from(e.target.files)); }

function addFiles(files) {
  const allowed = files.filter(f =>
    f.type.startsWith('image/') || f.type.startsWith('video/'));
  state.selectedFiles.push(...allowed);
  renderUploadPreview();
  const btn = document.getElementById('upload-submit-btn');
  if (btn) btn.style.display = state.selectedFiles.length ? 'flex' : 'none';
}

function renderUploadPreview() {
  const grid = document.getElementById('upload-preview');
  if (!grid) return;
  grid.innerHTML = '';

  state.selectedFiles.forEach((file, i) => {
    const item = document.createElement('div');
    item.className      = 'upload-preview-item';
    item.style.opacity  = '0';
    item.style.transform = 'scale(0.85)';

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = ev => {
        const img = document.createElement('img');
        img.src   = ev.target.result;
        item.prepend(img);
      };
      reader.readAsDataURL(file);
    } else {
      item.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;
          justify-content:center;height:100%;gap:4px;padding:6px">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="var(--accent)" stroke-width="1.5">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2"/>
          </svg>
          <span style="font-family:var(--font-mono);font-size:0.48rem;
            color:var(--text-dim);overflow:hidden;max-width:80px;
            white-space:nowrap;text-overflow:ellipsis">${file.name}</span>
        </div>
        <div class="video-tag">VIDEO</div>`;
    }

    const rmBtn = document.createElement('button');
    rmBtn.className = 'remove-btn';
    rmBtn.innerHTML = `<svg width="7" height="7" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="3">
      <path d="M18 6L6 18M6 6l12 12"/>
    </svg>`;
    rmBtn.onclick = () => {
      state.selectedFiles.splice(i, 1);
      renderUploadPreview();
      const btn = document.getElementById('upload-submit-btn');
      if (btn) btn.style.display = state.selectedFiles.length ? 'flex' : 'none';
    };
    item.appendChild(rmBtn);
    grid.appendChild(item);

    setTimeout(() => {
      item.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      item.style.opacity    = '1';
      item.style.transform  = 'scale(1)';
    }, i * 30 + 20);
  });
}

function clearUpload() {
  state.selectedFiles = [];
  renderUploadPreview();
  const btn  = document.getElementById('upload-submit-btn');
  const prog = document.getElementById('upload-progress-container');
  if (btn)  btn.style.display  = 'none';
  if (prog) prog.style.display = 'none';
}

async function handleUploadFiles() {
  const eventId = document.getElementById('upload-event-select')?.value;
  if (!eventId) { toast('Please select an event first.', 'error'); return; }
  if (!state.selectedFiles.length) { toast('No files selected.', 'error'); return; }
  const ok = await uploadFiles(eventId, state.selectedFiles);
  if (ok) { state.selectedFiles = []; renderUploadPreview(); }
}

// ─── Guest view ───────────────────────────────────────────────────────────────
async function initGuestView() {
  state.guestAllMedia = [];
  state.guestPeople   = [];

  const id = state.currentEventId || new URLSearchParams(location.search).get('event');
  state.currentEventId = id;

  const container = document.getElementById('guest-main-container');
  if (container) container.innerHTML = guestLoadingHTML();

  let evName = 'Event', evMeta = '';
  if (id) {
    const ev = state.events.find(e => e.id === id) || await loadEvent(id);
    if (ev) {
      evName = ev.name;
      evMeta = [ev.date, ev.location].filter(Boolean).join(' — ');
    }
  }

  const nameEl = document.getElementById('guest-event-name');
  const metaEl = document.getElementById('guest-event-meta');
  if (nameEl) nameEl.textContent = evName;
  if (metaEl) metaEl.textContent = evMeta;

  if (!id) {
    if (container) container.innerHTML =
      `<div style="text-align:center;padding:4rem;color:var(--text-dim)">
        No event found. Ask for a valid share link.
      </div>`;
    return;
  }

  const { data: media } = await supabase
    .from('media')
    .select('*')
    .eq('event_id', id)
    .eq('file_type', 'image')
    .order('created_at', { ascending: false });

  state.guestAllMedia = media || [];

  // Pre-cluster in background so matching is faster
  const indexed = state.guestAllMedia.filter(hasIndexedFaces);
  if (indexed.length) {
    clusterViaBackend(indexed).then(res => { state.guestPeople = res.people || []; });
  }

  if (container) container.innerHTML = guestAllPhotosHTML(state.guestAllMedia);
}

function guestLoadingHTML() {
  return `<div style="text-align:center;padding:4rem;color:var(--text-dim)">
    <div class="scan-dot" style="margin:0 auto 1rem"></div>
    Loading photos...
  </div>`;
}

function guestAllPhotosHTML(media) {
  const photoGrid = media.length
    ? media.map(m => `
        <div class="media-item"
          onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')">
          <img src="${m.url}" alt="${escapeHtml(m.file_name)}" loading="lazy">
          <div class="media-item-overlay">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="white" stroke-width="1.5">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </div>
        </div>`).join('')
    : `<div style="text-align:center;padding:3rem;color:var(--text-dim);grid-column:1/-1">
        No photos uploaded yet.
      </div>`;

  return `
    <div style="margin-bottom:2rem;display:flex;align-items:center;
      justify-content:space-between;flex-wrap:wrap;gap:1rem">
      <div style="font-family:var(--font-mono);font-size:0.65rem;
        color:var(--text-dim);letter-spacing:0.08em">
        ${media.length} PHOTO${media.length !== 1 ? 'S' : ''}
      </div>
      <button class="btn btn-primary" onclick="showFindMyPhotos()"
        style="gap:0.5rem">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        Find My Photos
      </button>
    </div>
    <div class="media-grid" id="guest-photos-grid"
      style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">
      ${photoGrid}
    </div>`;
}

function showFindMyPhotos() {
  const container = document.getElementById('guest-main-container');
  if (!container) return;
  container.innerHTML = `
    <div style="max-width:480px;margin:0 auto;padding:2rem 0">
      <button class="btn btn-ghost" onclick="initGuestView()"
        style="font-size:0.65rem;margin-bottom:1.5rem">
        ← Back to all photos
      </button>
      <div style="font-family:var(--font-serif);font-size:1.6rem;
        font-weight:300;color:var(--c4);margin-bottom:0.4rem">Find My Photos</div>
      <div style="font-family:var(--font-mono);font-size:0.62rem;
        color:var(--text-dim);margin-bottom:2rem">
        Upload a clear photo of your face. We'll find every photo you appear in.
      </div>

      <div class="tab-switcher" style="margin-bottom:1.5rem">
        <button class="tab-btn active" id="tab-upload-face"
          onclick="switchScanMode('upload',this)">Upload Photo</button>
        <button class="tab-btn" id="tab-camera"
          onclick="switchScanMode('camera',this)">Live Camera</button>
      </div>

      <!-- Upload mode -->
      <div id="mode-upload" style="display:flex;flex-direction:column;align-items:center;gap:1.2rem">
        <div class="upload-zone" id="face-drop-zone" style="max-width:320px;width:100%">
          <input type="file" id="face-file-input" accept="image/*"
            onchange="handleFaceFileSelect(event)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"
            style="width:36px;height:36px;color:var(--text-dim);margin-bottom:0.8rem">
            <circle cx="12" cy="8" r="4"/>
            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
          </svg>
          <div class="upload-zone-title">Upload a clear photo of your face</div>
          <div class="upload-zone-sub">Any quality — we'll enhance and detect</div>
        </div>
        <div id="face-preview-wrap"
          style="display:none;flex-direction:column;align-items:center;gap:1rem">
          <div style="position:relative;display:inline-block">
            <img id="face-preview"
              style="width:150px;height:150px;object-fit:cover;border-radius:50%;
                border:2px solid var(--accent);display:block">
            <div id="face-detect-indicator"
              style="display:none;position:absolute;bottom:4px;right:4px;
                background:var(--accent);border-radius:50%;width:24px;height:24px;
                align-items:center;justify-content:center">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
          </div>
          <div id="face-detect-status" class="scan-status">
            <div class="scan-dot"></div>
            <span>Ready — click Find My Photos to search</span>
          </div>
          <button class="btn btn-primary" id="match-btn" onclick="runPhotoMatch()"
            style="padding:0.75rem 2.5rem;display:none">Find My Photos</button>
          <button class="btn btn-ghost" style="font-size:0.65rem"
            onclick="resetFaceUpload()">Choose a different photo</button>
        </div>
      </div>

      <!-- Camera mode -->
      <div id="mode-camera" style="display:none;flex-direction:column;align-items:center;gap:1rem">
        <div class="camera-wrapper">
          <video id="camera-feed" autoplay muted playsinline></video>
          <canvas id="face-canvas"></canvas>
          <div class="camera-corners">
            <span class="corner tl"></span><span class="corner tr"></span>
            <span class="corner bl"></span><span class="corner br"></span>
          </div>
        </div>
        <div class="scan-status">
          <div class="scan-dot"></div>
          <span id="camera-status-text">Starting camera...</span>
        </div>
        <button class="btn btn-primary" id="capture-btn" onclick="captureAndMatch()"
          style="padding:0.75rem 2.5rem">Capture and Find My Photos</button>
      </div>

      <!-- Scanning overlay (inline) -->
      <div id="guest-scanning" style="display:none;text-align:center;padding:2rem">
        <div class="scan-dot" style="margin:0 auto 1rem;width:24px;height:24px"></div>
        <div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--accent)">
          Scanning with ArcFace AI...
        </div>
      </div>
    </div>`;

  state.scanMode = 'upload';
}

function resetGuestView() { initGuestView(); }

async function startCamera() {
  const video    = document.getElementById('camera-feed');
  const statusEl = document.getElementById('camera-status-text');
  const captBtn  = document.getElementById('capture-btn');
  if (!video) return;
  if (statusEl) statusEl.textContent = 'Requesting camera...';
  if (captBtn)  captBtn.disabled     = true;
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = state.cameraStream;
    await video.play();
    if (statusEl) statusEl.textContent = 'Position your face — press Capture when ready';
    if (captBtn)  captBtn.disabled     = false;
    startDetectLoop(video);
  } catch {
    if (statusEl) statusEl.textContent = 'Camera unavailable — use Upload Photo instead.';
    if (captBtn)  { captBtn.disabled = true; captBtn.style.opacity = '0.4'; }
  }
}

function startDetectLoop(video) {
  const canvas = document.getElementById('face-canvas');
  clearInterval(state.detectLoop);
  state.detectLoop = setInterval(async () => {
    if (!video || video.readyState < 2) return;
    try { await drawCameraOverlay(video, canvas); } catch {}
  }, 400);
}

function stopCamera() {
  clearInterval(state.detectLoop);
  state.detectLoop = null;
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(t => t.stop());
    state.cameraStream = null;
  }
  const canvas = document.getElementById('face-canvas');
  if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

function switchScanMode(mode, btn) {
  state.scanMode = mode;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');

  const camEl = document.getElementById('mode-camera');
  const upEl  = document.getElementById('mode-upload');
  if (!camEl || !upEl) return;

  if (mode === 'camera') {
    upEl.style.display  = 'none';
    camEl.style.display = 'flex';
    startCamera();
  } else {
    camEl.style.display = 'none';
    upEl.style.display  = 'flex';
    stopCamera();
  }
}

async function captureAndMatch() {
  const video = document.getElementById('camera-feed');
  if (!state.cameraStream || !video) { toast('Camera not available.', 'error'); return; }
  const canvas  = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext('2d').drawImage(video, 0, 0);
  await performFaceMatch(canvas.toDataURL('image/jpeg', 0.92));
}

async function handleFaceFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const dataURL    = ev.target.result;
    const preview    = document.getElementById('face-preview');
    const dropZone   = document.getElementById('face-drop-zone');
    const previewWrap = document.getElementById('face-preview-wrap');
    const matchBtn   = document.getElementById('match-btn');
    const indicator  = document.getElementById('face-detect-indicator');
    if (preview)     preview.src              = dataURL;
    if (dropZone)    dropZone.style.display   = 'none';
    if (previewWrap) previewWrap.style.display = 'flex';
    if (indicator)   indicator.style.display  = 'flex';
    if (matchBtn)    matchBtn.style.display   = 'flex';
    window._pendingSelfieDataURL = dataURL;
  };
  reader.readAsDataURL(file);
}

function resetFaceUpload() {
  window._pendingSelfieDataURL = null;
  const input = document.getElementById('face-file-input');
  if (input) input.value = '';
  const dz   = document.getElementById('face-drop-zone');
  const wrap = document.getElementById('face-preview-wrap');
  if (dz)   dz.style.display   = 'block';
  if (wrap) wrap.style.display = 'none';
}

async function runPhotoMatch() {
  if (!window._pendingSelfieDataURL) { toast('No photo selected.', 'error'); return; }
  await performFaceMatch(window._pendingSelfieDataURL);
}

// ─── Core face matching ───────────────────────────────────────────────────────
async function performFaceMatch(dataURL) {
  const scanningEl = document.getElementById('guest-scanning');
  const modeUpload = document.getElementById('mode-upload');
  const modeCamera = document.getElementById('mode-camera');
  if (scanningEl) scanningEl.style.display = 'block';
  if (modeUpload) modeUpload.style.display = 'none';
  if (modeCamera) modeCamera.style.display = 'none';

  if (!state.currentEventId) {
    toast('No event selected.', 'error');
    if (scanningEl) scanningEl.style.display = 'none';
    return;
  }

  // Fetch gallery with embeddings
  const { data: allMedia } = await supabase
    .from('media')
    .select('*')
    .eq('event_id', state.currentEventId)
    .eq('file_type', 'image')
    .not('face_embeddings', 'is', null);

  const gallery = allMedia || [];
  const indexed = gallery.filter(hasIndexedFaces);

  if (!indexed.length) {
    if (scanningEl) scanningEl.style.display = 'none';
    toast('Photos not yet indexed. Ask the event organizer to index faces.', 'error');
    return;
  }

  const result = await matchViaBackend(dataURL, indexed);
  if (scanningEl) scanningEl.style.display = 'none';

  if (!result.probe_found) {
    toast('No face detected in your photo — try a clearer, well-lit image.', 'error');
    if (modeUpload) modeUpload.style.display = 'flex';
    return;
  }

  const matches = result.matches || [];
  if (!matches.length) {
    renderGuestNoMatch();
    return;
  }

  const matchedIds = new Set(matches.map(m => m.media_id));

  // Use cached clusters or compute now
  let people = state.guestPeople;
  if (!people.length) {
    const res = await clusterViaBackend(indexed);
    people = res.people || [];
    state.guestPeople = people;
  }

  // Find the people folder with the most matched photos
  let bestFolder = null, bestOverlap = 0;
  for (const person of people) {
    const overlap = (person.photo_ids || []).filter(id => matchedIds.has(id)).length;
    if (overlap > bestOverlap) { bestOverlap = overlap; bestFolder = person; }
  }

  renderGuestResults(matches, bestFolder, gallery);
}

function renderGuestNoMatch() {
  const container = document.getElementById('guest-main-container');
  if (!container) return;
  container.innerHTML = `
    <div style="text-align:center;padding:4rem 1rem">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"
        style="width:48px;height:48px;color:var(--text-dim);margin-bottom:1rem">
        <circle cx="12" cy="8" r="4"/>
        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
      </svg>
      <div style="font-family:var(--font-serif);font-size:1.4rem;
        font-weight:300;color:var(--c4);margin-bottom:0.5rem">No matches found</div>
      <div style="font-family:var(--font-mono);font-size:0.62rem;
        color:var(--text-dim);margin-bottom:2rem">
        Try a clearer, well-lit photo facing the camera.
      </div>
      <button class="btn btn-outline" onclick="showFindMyPhotos()">Try Again</button>
      <button class="btn btn-ghost" onclick="initGuestView()"
        style="margin-left:0.5rem">See All Photos</button>
    </div>`;
}

function renderGuestResults(matches, folder, allMedia) {
  const container = document.getElementById('guest-main-container');
  if (!container) return;

  const photoMap = {};
  for (const m of allMedia) photoMap[m.id] = m;

  const folderPhotos = folder
    ? (folder.photo_ids || []).map(id => photoMap[id]).filter(Boolean)
    : matches.map(m => allMedia.find(med => med.id === m.media_id)).filter(Boolean);

  const matchedIds  = new Set(matches.map(m => m.media_id));
  const folderLabel = folder
    ? `Your Photos — ${folder.photo_count} photo${folder.photo_count !== 1 ? 's' : ''}`
    : `${matches.length} Matching Photo${matches.length !== 1 ? 's' : ''}`;

  container.innerHTML = `
    <div style="margin-bottom:1.5rem;display:flex;align-items:center;
      justify-content:space-between;flex-wrap:wrap;gap:1rem">
      <div>
        <div style="font-family:var(--font-serif);font-size:1.5rem;
          font-weight:300;color:var(--c4)">${folderLabel}</div>
        <div style="font-family:var(--font-mono);font-size:0.6rem;
          color:var(--text-dim);margin-top:0.2rem">
          Photos you appear in from this event
        </div>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="downloadAllMatchedPhotos()"
          style="gap:0.4rem;font-size:0.7rem">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Save All
        </button>
        <button class="btn btn-ghost" onclick="showFindMyPhotos()"
          style="font-size:0.7rem">Search Again</button>
        <button class="btn btn-ghost" onclick="initGuestView()"
          style="font-size:0.7rem">All Photos</button>
      </div>
    </div>
    <div class="media-grid"
      style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px">
      ${folderPhotos.map(m => `
        <div class="guest-result-card"
          style="position:relative;border-radius:8px;overflow:hidden;
            aspect-ratio:1;background:var(--c1)">
          <img src="${m.url}" alt="${escapeHtml(m.file_name)}" loading="lazy"
            style="width:100%;height:100%;object-fit:cover;cursor:pointer"
            onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')">
          ${matchedIds.has(m.id)
            ? `<div style="position:absolute;top:6px;left:6px;background:var(--accent);
                border-radius:4px;padding:2px 6px;font-family:var(--font-mono);
                font-size:0.5rem;color:var(--c1)">MATCH</div>`
            : ''}
          <div style="position:absolute;bottom:0;left:0;right:0;
            background:linear-gradient(transparent,rgba(0,0,0,0.7));
            padding:0.5rem;display:flex;justify-content:flex-end">
            <a href="${m.url}" download="${m.file_name}" target="_blank"
              title="Save photo" style="color:white;display:flex;align-items:center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </a>
          </div>
        </div>`).join('')}
    </div>`;

  window._guestFolderPhotos = folderPhotos;
}

async function downloadAllMatchedPhotos() {
  const photos = window._guestFolderPhotos || [];
  if (!photos.length) return;
  toast(`Saving ${photos.length} photos...`, 'info');
  for (const photo of photos) {
    const a   = document.createElement('a');
    a.href    = photo.url;
    a.download = photo.file_name;
    a.target  = '_blank';
    a.click();
    await new Promise(r => setTimeout(r, 400));
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function hasIndexedFaces(m) {
  try {
    let p = m.face_embeddings;
    if (p == null) return false;
    if (typeof p === 'string') p = JSON.parse(p);
    if (typeof p === 'string') p = JSON.parse(p);
    return Array.isArray(p) && p.length > 0;
  } catch { return false; }
}

function escapeHtml(s) {
  if (!s) return '';
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

window.copyImageLink = url =>
  navigator.clipboard.writeText(url).then(() => toast('Link copied.', 'success'));
