// app.js v2.2 — Guest flow redesign: all photos → find my photos → people folder
import { supabase }                    from './supabase.js';
import { authState, initAuth, doLogin as authLogin, doRegister as authRegister, doLogout as authLogout, getUserName, getUserInitials } from './auth.js';
import { createEvent, loadEvents, loadEvent, deleteEvent, loadMedia, uploadFiles, reindexEvent } from './events.js';
import { loadModels, drawCameraOverlay, matchViaBackend, clusterViaBackend, checkBackendHealth } from './face.js';
import { toast, showScanning, hideScanning, openModal, closeModal, switchAuthTab as _switchAuthTab, openLightbox, closeLightbox, setStep, staggerIn, countUp, transitionTo, setLoading } from './ui.js';

const state = {
  events: [], currentEventId: null, currentMedia: [], currentPeople: [],
  selectedFiles: [], cameraStream: null, detectLoop: null, scanMode: 'upload',
  guestAllMedia: [], guestPeople: [],
};

// ─── SHARED HELPER — robust face_embeddings check ────────────────────────────
// Handles both native jsonb arrays and legacy double-serialized strings.
function hasIndexedFaces(m) {
  try {
    let p = m.face_embeddings;
    if (p == null) return false;
    if (typeof p === 'string') p = JSON.parse(p);
    if (typeof p === 'string') p = JSON.parse(p); // double-encoded legacy
    return Array.isArray(p) && p.length > 0;
  } catch { return false; }
}


Object.assign(window, {
  navigate, openModal, closeModal, switchAuthTab: _switchAuthTab,
  doLogin: handleLogin, doRegister: handleRegister, doLogout: handleLogout,
  doCreateEvent: handleCreateEvent, deleteCurrentEvent: handleDeleteEvent,
  copyShareLink, showSection, goToUploadForEvent,
  handleDragOver, handleDragLeave, handleDrop, handleFileInput,
  clearUpload, doUploadFiles: handleUploadFiles,
  switchScanMode, captureAndMatch, handleFaceFileSelect, runPhotoMatch,
  resetFaceUpload, resetGuestView, closeLightbox, openEventDetail,
  openLightbox, reindexCurrentEvent, switchDetailTab, closePerson, openPerson,
  removeMediaItem, showFindMyPhotos, downloadAllMatchedPhotos,
});

async function boot() {
  document.body.style.opacity = '0';
  loadModels().catch(() => {});

  const params = new URLSearchParams(location.search);
  const eventParam = params.get('event');

  const user = await initAuth(onAuthStateChanged);
  document.body.style.transition = 'opacity 0.3s ease';
  document.body.style.opacity    = '1';

  if (eventParam) {
    state.currentEventId = eventParam;
    navigate('guest');
    return;
  }

  if (user) navigate('dashboard'); else navigate('landing');
}

function onAuthStateChanged(event, user, prevUser) {
  if (event === 'SIGNED_IN' && !prevUser) {
    const params = new URLSearchParams(location.search);
    if (!params.get('event')) navigate('dashboard');
  } else if (event === 'SIGNED_OUT') {
    const params = new URLSearchParams(location.search);
    if (!params.get('event')) navigate('landing');
  }
}

setInterval(async () => {
  if (authState.user) await supabase.auth.refreshSession();
}, 10 * 60 * 1000);

boot();

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
let currentView = 'landing';

function navigate(view) {
  stopCamera();
  const viewIds = { landing: 'view-landing', dashboard: 'view-dashboard', guest: 'view-guest' };
  const targetId = viewIds[view];
  if (!targetId) return;
  if (view === 'dashboard' && !authState.user) { openModal('auth-modal'); return; }
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(targetId).classList.add('active');
  currentView = view;
  if (view === 'dashboard') initDashboard();
  else if (view === 'guest') initGuestView();
  else if (view === 'landing') initLanding();
}

function initLanding() {
  const hero = document.querySelector('.hero-left');
  if (!hero) return;
  ['.hero-eyebrow','.hero-title','.hero-sub','.hero-ctas'].forEach((s, i) => {
    const el = hero.querySelector(s);
    if (!el) return;
    el.style.opacity = '0'; el.style.transform = 'translateY(18px)';
    setTimeout(() => { el.style.transition='opacity 0.5s ease,transform 0.5s ease'; el.style.opacity='1'; el.style.transform='translateY(0)'; }, 80+i*100);
  });
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
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
    const loginSection = document.getElementById('auth-login');
    const regSection   = document.getElementById('auth-register');
    regSection.style.display  = 'none';
    loginSection.style.display = 'block';
    loginSection.innerHTML = `<div class="confirm-email-message">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40" style="color:var(--accent);margin-bottom:1rem"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
      <div style="font-size:0.95rem;font-weight:600;color:var(--c4);margin-bottom:0.5rem">Check your email</div>
      <div style="font-family:var(--font-mono);font-size:0.65rem;color:var(--text-dim);line-height:1.7">We sent a confirmation link to your inbox. Click it to activate your account, then sign in.</div>
      <button class="btn btn-outline" style="margin-top:1.5rem;width:100%" onclick="switchAuthTab('login');location.reload()">Go to Sign In</button>
    </div>`;
    return;
  }
  closeModal('auth-modal');
  toast('Account created. Welcome, ' + getUserName() + '!', 'success');
  navigate('dashboard');
}

async function handleLogout() {
  await authLogout();
  toast('Signed out successfully.');
  navigate('landing');
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
async function initDashboard() { updateUserUI(); await loadDashboard(); }

function updateUserUI() {
  const name = getUserName(), initials = getUserInitials();
  const el = document.getElementById('nav-user-name'); if (el) el.textContent = name;
  const av = document.getElementById('user-avatar');   if (av) av.textContent = initials;
  const wl = document.getElementById('dash-welcome');  if (wl) wl.textContent = 'Welcome, ' + name;
}

async function loadDashboard() {
  const events = await loadEvents();
  state.events = events;
  countUp(document.getElementById('stat-events'), events.length);
  countUp(document.getElementById('stat-photos'), events.reduce((a,e)=>a+(e.photo_count||0),0));
  document.getElementById('events-count').textContent = events.length;
  const sel = document.getElementById('upload-event-select');
  if (sel) {
    sel.innerHTML = '<option value="">Choose an event...</option>';
    events.forEach(e => sel.innerHTML += `<option value="${e.id}">${escapeHtml(e.name)}</option>`);
  }
  renderEventCards(events);
}

function renderEventCards(events) {
  const grid = document.getElementById('events-grid');
  if (!grid) return;
  let html = `<div class="event-card event-card-new" onclick="openModal('create-event-modal')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
    <span>New Event</span>
  </div>`;
  events.forEach(ev => {
    html += `<div class="event-card" onclick="openEventDetail('${ev.id}')">
      <div class="event-thumb">
        <div class="event-thumb-pattern"></div>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(211,218,217,0.2)" stroke-width="1.2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        <div class="event-photo-pill">${ev.photo_count??0} photos</div>
      </div>
      <div class="event-body">
        <div class="event-name">${escapeHtml(ev.name)}</div>
        <div class="event-meta-row">
          <span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${ev.date||'No date'}</span>
          ${ev.location?`<span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>${escapeHtml(ev.location)}</span>`:''}
        </div>
        <div class="event-card-actions">
          <button class="btn btn-secondary" onclick="event.stopPropagation();openEventDetail('${ev.id}')">Manage</button>
          <button class="btn btn-outline" onclick="event.stopPropagation();copyEventLink('${ev.id}')">Share Link</button>
        </div>
      </div>
    </div>`;
  });
  grid.innerHTML = html;
  staggerIn(grid, '.event-card', 50);
}

async function openEventDetail(id) {
  state.currentEventId = id;
  state.currentPeople  = [];
  const ev = state.events.find(e=>e.id===id) || await loadEvent(id);
  if (!ev) return;
  document.getElementById('detail-name').textContent = ev.name;
  document.getElementById('detail-meta').textContent = [ev.date, ev.location].filter(Boolean).join(' — ');
  document.getElementById('detail-share-link').textContent = buildShareLink(id);
  document.getElementById('detail-chips').innerHTML = `
    <span class="chip chip-green"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Active</span>
    <span class="chip chip-amber">${ev.photo_count??0} photos</span>
    ${ev.date?`<span class="chip chip-purple">${ev.date}</span>`:''}`;
  await refreshMediaGrid(id);
  switchDetailTab('photos');
  showSection('detail', null);
}

async function refreshMediaGrid(id) {
  const media = await loadMedia(id);
  state.currentMedia = media;
  document.getElementById('detail-photo-count').textContent = `(${media.length})`;
  const grid  = document.getElementById('detail-media-grid');
  const empty = document.getElementById('detail-empty');
  if (!media.length) { grid.style.display='none'; empty.style.display='block'; }
  else {
    empty.style.display='none'; grid.style.display='grid';
    grid.innerHTML = media.map(m=>`
      <div class="media-item" data-id="${m.id}">
        <img src="${m.url}" alt="${escapeHtml(m.file_name)}" loading="lazy" onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')">
        ${m.file_type==='video'?'<div class="video-tag">VIDEO</div>':''}
        ${!m.face_embeddings||m.face_embeddings==='[]'?'<div class="no-face-tag" title="No face detected"></div>':''}
        <button class="media-delete-btn" onclick="removeMediaItem('${m.id}','${m.storage_path}')" title="Remove photo">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <div class="media-item-overlay" onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></div>
      </div>`).join('');
    staggerIn(grid, '.media-item', 25);
  }
}

async function removeMediaItem(mediaId, storagePath) {
  if (!confirm('Remove this photo? This cannot be undone.')) return;
  if (storagePath) await supabase.storage.from('event-media').remove([storagePath]);
  await supabase.from('media').delete().eq('id', mediaId);
  state.currentMedia = state.currentMedia.filter(m => m.id !== mediaId);
  const el = document.querySelector(`.media-item[data-id="${mediaId}"]`);
  if (el) { el.style.opacity='0'; el.style.transform='scale(0.8)'; setTimeout(()=>el.remove(), 200); }
  toast('Photo removed.', 'success');
  document.getElementById('detail-photo-count').textContent = `(${state.currentMedia.length})`;
}

// ─── PEOPLE TAB ───────────────────────────────────────────────────────────────
function switchDetailTab(tab) {
  ['photos','people','person'].forEach(t => {
    const panel = document.getElementById('detail-panel-' + t);
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
  });
  document.getElementById('detail-tab-photos')?.classList.toggle('active', tab==='photos');
  document.getElementById('detail-tab-people')?.classList.toggle('active', tab==='people');
  if (tab === 'people') loadPeoplePanel();
}

async function loadPeoplePanel() {
  const loadingEl = document.getElementById('people-loading');
  const gridEl    = document.getElementById('people-grid');
  const emptyEl   = document.getElementById('people-empty');
  if (state.currentPeople.length > 0) { renderPeopleGrid(state.currentPeople); return; }
  const indexed = (state.currentMedia||[]).filter(m => {
    return hasIndexedFaces(m);
  });
  if (!indexed.length) { loadingEl.style.display='none'; gridEl.style.display='none'; emptyEl.style.display='block'; return; }
  loadingEl.style.display = 'block'; gridEl.style.display = 'none'; emptyEl.style.display = 'none';
  const clusterRes = await clusterViaBackend(indexed);
  const people = clusterRes.people || [];
  state.currentPeople = people;
  loadingEl.style.display = 'none';
  if (!people.length) { emptyEl.style.display = 'block'; }
  else { document.getElementById('detail-people-count').textContent = `(${people.length})`; renderPeopleGrid(people); }
}

function renderPeopleGrid(people) {
  const gridEl = document.getElementById('people-grid');
  gridEl.style.display = 'grid';
  const photoMap = {};
  for (const m of state.currentMedia) photoMap[m.id] = m;
  gridEl.innerHTML = people.map((p, i) => {
    const repPhoto = photoMap[p.photo_ids?.[0]] || { url: p.representative_url };
    const thumbUrl = repPhoto?.url || p.representative_url || '';
    return `<div class="person-card" onclick="openPerson(${i})">
      <div class="person-thumb">
        ${thumbUrl?`<img src="${thumbUrl}" alt="Person ${p.person_index+1}" loading="lazy">`:`<div class="person-thumb-fallback">P${p.person_index+1}</div>`}
        <div class="person-face-ring"></div>
      </div>
      <div class="person-label">Person ${p.person_index + 1}</div>
      <div class="person-count">${p.photo_count} photo${p.photo_count!==1?'s':''}</div>
    </div>`;
  }).join('');
  staggerIn(gridEl, '.person-card', 40);
}

function openPerson(personIndex) {
  const person = state.currentPeople[personIndex];
  if (!person) return;
  const photoMap = {};
  for (const m of state.currentMedia) photoMap[m.id] = m;
  const photos = (person.photo_ids||[]).map(id=>photoMap[id]).filter(Boolean);
  document.getElementById('person-detail-name').textContent = `Person ${person.person_index + 1}`;
  document.getElementById('person-detail-meta').textContent = `${person.photo_count} photo${person.photo_count!==1?'s':''} · ${person.face_count} face detection${person.face_count!==1?'s':''}`;
  const avatarEl = document.getElementById('person-detail-avatar');
  const rep = photos[0];
  avatarEl.innerHTML = rep
    ? `<img src="${rep.url}" alt="Person" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:var(--font-mono);font-size:1.2rem;color:var(--accent)">P${person.person_index+1}</div>`;
  const grid = document.getElementById('person-media-grid');
  grid.innerHTML = photos.map(m=>`
    <div class="media-item" onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')">
      <img src="${m.url}" alt="${escapeHtml(m.file_name)}" loading="lazy">
      <div class="media-item-overlay"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></div>
    </div>`).join('');
  staggerIn(grid, '.media-item', 25);
  switchDetailTab('person');
  document.getElementById('detail-tab-people')?.classList.add('active');
  document.getElementById('detail-tab-photos')?.classList.remove('active');
}

function closePerson() { switchDetailTab('people'); }

async function reindexCurrentEvent() {
  if (!state.currentEventId) return;
  state.currentPeople = [];
  await reindexEvent(state.currentEventId);
  await refreshMediaGrid(state.currentEventId);
  // Re-run clustering so People tab reflects fresh embeddings immediately
  const indexed = (state.currentMedia || []).filter(hasIndexedFaces);
  if (indexed.length) {
    const clusterRes = await clusterViaBackend(indexed);
    state.currentPeople = clusterRes.people || [];
    toast(`People updated — ${state.currentPeople.length} person${state.currentPeople.length !== 1 ? 's' : ''} found.`, 'success');
  }
}

function showSection(name, sidebarEl) {
  ['events','upload','detail'].forEach(s => {
    const el = document.getElementById('section-'+s);
    if (el) el.style.display = s===name ? 'block' : 'none';
  });
  if (sidebarEl) {
    document.querySelectorAll('.sidebar-item').forEach(i=>i.classList.remove('active'));
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
  if (ok) { state.currentEventId=null; showSection('events', document.getElementById('nav-events')); await loadDashboard(); }
}

function buildShareLink(id) { return `${location.origin}${location.pathname}?event=${id}`; }
function copyShareLink() {
  const text = document.getElementById('detail-share-link')?.textContent;
  if (text) navigator.clipboard.writeText(text).then(()=>toast('Link copied.','success'));
}
window.copyEventLink = id => navigator.clipboard.writeText(buildShareLink(id)).then(()=>toast('Link copied.','success'));

// ─── UPLOAD ───────────────────────────────────────────────────────────────────
function handleDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function handleDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function handleDrop(e) { e.preventDefault(); e.currentTarget.classList.remove('drag-over'); addFiles(Array.from(e.dataTransfer.files)); }
function handleFileInput(e) { addFiles(Array.from(e.target.files)); }

function addFiles(files) {
  const allowed = files.filter(f=>f.type.startsWith('image/')||f.type.startsWith('video/'));
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
    item.className = 'upload-preview-item';
    item.style.opacity='0'; item.style.transform='scale(0.85)';
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = e => { const img=document.createElement('img'); img.src=e.target.result; item.prepend(img); };
      reader.readAsDataURL(file);
    } else {
      item.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:4px;padding:6px">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
        <span style="font-family:var(--font-mono);font-size:0.48rem;color:var(--text-dim);overflow:hidden;max-width:80px;white-space:nowrap;text-overflow:ellipsis">${file.name}</span>
      </div><div class="video-tag">VIDEO</div>`;
    }
    const rmBtn = document.createElement('button');
    rmBtn.className = 'remove-btn';
    rmBtn.innerHTML = `<svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
    rmBtn.onclick = () => { state.selectedFiles.splice(i,1); renderUploadPreview(); if(!state.selectedFiles.length) document.getElementById('upload-submit-btn').style.display='none'; };
    item.appendChild(rmBtn);
    grid.appendChild(item);
    setTimeout(() => { item.style.transition='opacity 0.2s ease,transform 0.2s ease'; item.style.opacity='1'; item.style.transform='scale(1)'; }, i*30+20);
  });
}

function clearUpload() {
  state.selectedFiles = []; renderUploadPreview();
  const btn = document.getElementById('upload-submit-btn'); if (btn) btn.style.display='none';
  const prog = document.getElementById('upload-progress-container'); if (prog) prog.style.display='none';
}

async function handleUploadFiles() {
  const eventId = document.getElementById('upload-event-select')?.value;
  if (!eventId) { toast('Please select an event first.', 'error'); return; }
  if (!state.selectedFiles.length) { toast('No files selected.', 'error'); return; }
  const ok = await uploadFiles(eventId, state.selectedFiles);
  if (ok) { state.selectedFiles=[]; renderUploadPreview(); }
}

// ─── GUEST VIEW (NEW FLOW) ────────────────────────────────────────────────────
// Flow: All photos → Find My Photos button → scan face → show matched people folder

async function initGuestView() {
  state.guestAllMedia = [];
  state.guestPeople   = [];

  const id = state.currentEventId || new URLSearchParams(location.search).get('event');
  state.currentEventId = id;

  // Set event name
  const guestContainer = document.getElementById('guest-main-container');
  if (guestContainer) guestContainer.innerHTML = guestLoadingHTML();

  let evName = 'Event', evMeta = '';
  if (id) {
    const ev = state.events.find(e=>e.id===id) || await loadEvent(id);
    if (ev) {
      evName = ev.name;
      evMeta = [ev.date, ev.location].filter(Boolean).join(' — ');
    }
  }

  document.getElementById('guest-event-name').textContent = evName;
  document.getElementById('guest-event-meta').textContent = evMeta;

  if (!id) {
    if (guestContainer) guestContainer.innerHTML = `<div style="text-align:center;padding:4rem;color:var(--text-dim)">No event found. Ask for a valid share link.</div>`;
    return;
  }

  // Load all media for this event
  const { data: media } = await supabase.from('media')
    .select('*').eq('event_id', id).eq('file_type', 'image')
    .order('created_at', { ascending: false });

  state.guestAllMedia = media || [];

  // Also load people clusters in background
  const indexed = state.guestAllMedia.filter(m => {
    return hasIndexedFaces(m);
  });
  if (indexed.length) {
    clusterViaBackend(indexed).then(res => { state.guestPeople = res.people || []; });
  }

  // Render all photos + Find My Photos button
  if (guestContainer) guestContainer.innerHTML = guestAllPhotosHTML(state.guestAllMedia);
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
        <div class="media-item" onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')">
          <img src="${m.url}" alt="${escapeHtml(m.file_name)}" loading="lazy">
          <div class="media-item-overlay"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></div>
        </div>`).join('')
    : `<div style="text-align:center;padding:3rem;color:var(--text-dim);grid-column:1/-1">No photos uploaded yet.</div>`;

  return `
    <div style="margin-bottom:2rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem">
      <div style="font-family:var(--font-mono);font-size:0.65rem;color:var(--text-dim);letter-spacing:0.08em">${media.length} PHOTO${media.length!==1?'S':''}</div>
      <button class="btn btn-primary" onclick="showFindMyPhotos()" style="gap:0.5rem">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        Find My Photos
      </button>
    </div>
    <div class="media-grid" id="guest-photos-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">
      ${photoGrid}
    </div>`;
}

function showFindMyPhotos() {
  const container = document.getElementById('guest-main-container');
  if (!container) return;
  container.innerHTML = `
    <div style="max-width:480px;margin:0 auto;padding:2rem 0">
      <button class="btn btn-ghost" onclick="initGuestView()" style="font-size:0.65rem;margin-bottom:1.5rem">
        ← Back to all photos
      </button>
      <div style="font-family:var(--font-serif);font-size:1.6rem;font-weight:300;color:var(--c4);margin-bottom:0.4rem">Find My Photos</div>
      <div style="font-family:var(--font-mono);font-size:0.62rem;color:var(--text-dim);margin-bottom:2rem">Upload or take a clear photo of your face. We'll find every photo you appear in.</div>

      <div class="tab-switcher" style="margin-bottom:1.5rem">
        <button class="tab-btn active" id="tab-upload-face" onclick="switchScanMode('upload',this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Upload Photo
        </button>
        <button class="tab-btn" id="tab-camera" onclick="switchScanMode('camera',this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Live Camera
        </button>
      </div>

      <!-- UPLOAD MODE -->
      <div id="mode-upload" style="display:flex;flex-direction:column;align-items:center;gap:1.2rem">
        <div class="upload-zone" id="face-drop-zone" style="max-width:320px;width:100%">
          <input type="file" id="face-file-input" accept="image/*" onchange="handleFaceFileSelect(event)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="width:36px;height:36px;color:var(--text-dim);margin-bottom:0.8rem"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          <div class="upload-zone-title">Upload a clear photo of your face</div>
          <div class="upload-zone-sub">Any quality works — we'll enhance and detect</div>
        </div>
        <div id="face-preview-wrap" style="display:none;flex-direction:column;align-items:center;gap:1rem">
          <div style="position:relative;display:inline-block">
            <img id="face-preview" style="width:150px;height:150px;object-fit:cover;border-radius:50%;border:2px solid var(--accent);display:block">
            <div id="face-detect-indicator" style="display:none;position:absolute;bottom:4px;right:4px;background:var(--accent);border-radius:50%;width:24px;height:24px;align-items:center;justify-content:center">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
          </div>
          <div id="face-detect-status" class="scan-status"><div class="scan-dot"></div><span>Ready — click Find My Photos to search</span></div>
          <button class="btn btn-primary" id="match-btn" onclick="runPhotoMatch()" style="padding:0.75rem 2.5rem;display:none">Find My Photos</button>
          <button class="btn btn-ghost" style="font-size:0.65rem" onclick="resetFaceUpload()">Choose a different photo</button>
        </div>
      </div>

      <!-- CAMERA MODE -->
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
        <button class="btn btn-primary" id="capture-btn" onclick="captureAndMatch()" style="padding:0.75rem 2.5rem">
          Capture and Find My Photos
        </button>
      </div>

      <!-- SCANNING OVERLAY -->
      <div id="guest-scanning" style="display:none;text-align:center;padding:2rem">
        <div class="scan-dot" style="margin:0 auto 1rem;width:24px;height:24px"></div>
        <div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--accent)">Scanning with ArcFace AI...</div>
      </div>
    </div>`;

  // Default to upload mode
  state.scanMode = 'upload';
}

function resetGuestView() { initGuestView(); }

async function startCamera() {
  const video=document.getElementById('camera-feed');
  if (!video) return;
  const statusEl=document.getElementById('camera-status-text'), captBtn=document.getElementById('capture-btn');
  if (statusEl) statusEl.textContent='Requesting camera...';
  if (captBtn) captBtn.disabled=true;
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'user', width:{ideal:1280}, height:{ideal:720} } });
    video.srcObject = state.cameraStream;
    await video.play();
    if (statusEl) statusEl.textContent = 'Position your face — press Capture when ready';
    if (captBtn) captBtn.disabled = false;
    startDetectLoop(video);
  } catch {
    if (statusEl) statusEl.textContent = 'Camera unavailable — use Upload Photo instead.';
    if (captBtn) { captBtn.disabled=true; captBtn.style.opacity='0.4'; }
  }
}

function startDetectLoop(video) {
  const canvas=document.getElementById('face-canvas'), statusEl=document.getElementById('camera-status-text');
  clearInterval(state.detectLoop);
  state.detectLoop = setInterval(async () => {
    if (!video || video.readyState < 2) return;
    try { await drawCameraOverlay(video, canvas); } catch {}
  }, 400);
}

function stopCamera() {
  clearInterval(state.detectLoop); state.detectLoop=null;
  if (state.cameraStream) { state.cameraStream.getTracks().forEach(t=>t.stop()); state.cameraStream=null; }
  const canvas=document.getElementById('face-canvas');
  if (canvas) canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);
}

function switchScanMode(mode, btn) {
  state.scanMode = mode;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active')); btn?.classList.add('active');
  const camEl=document.getElementById('mode-camera'), upEl=document.getElementById('mode-upload');
  if (!camEl || !upEl) return;
  if (mode==='camera') { camEl.style.display='flex'; upEl.style.display='none'; startCamera(); }
  else { camEl.style.display='flex'; upEl.style.display='flex'; camEl.style.display='none'; stopCamera(); upEl.style.display='flex'; }
}

async function captureAndMatch() {
  const video=document.getElementById('camera-feed');
  if (!state.cameraStream) { toast('Camera not available.','error'); return; }
  const canvas=document.createElement('canvas');
  canvas.width=video.videoWidth||1280; canvas.height=video.videoHeight||720;
  canvas.getContext('2d').drawImage(video,0,0);
  await performFaceMatch(canvas.toDataURL('image/jpeg', 0.92));
}

async function handleFaceFileSelect(e) {
  const file=e.target.files[0]; if (!file) return;
  const reader=new FileReader();
  reader.onload = async ev => {
    const dataURL=ev.target.result;
    const preview = document.getElementById('face-preview');
    const dropZone = document.getElementById('face-drop-zone');
    const previewWrap = document.getElementById('face-preview-wrap');
    const matchBtn = document.getElementById('match-btn');
    const indicator = document.getElementById('face-detect-indicator');
    if (preview) preview.src=dataURL;
    if (dropZone) dropZone.style.display='none';
    if (previewWrap) previewWrap.style.display='flex';
    if (indicator) indicator.style.display='flex';
    if (matchBtn) matchBtn.style.display='flex';
    window._pendingSelfieDataURL = dataURL;
  };
  reader.readAsDataURL(file);
}

function resetFaceUpload() {
  window._pendingSelfieDataURL = null;
  const input=document.getElementById('face-file-input'); if (input) input.value='';
  const dz=document.getElementById('face-drop-zone'), wrap=document.getElementById('face-preview-wrap');
  if (dz) dz.style.display='block'; if (wrap) wrap.style.display='none';
}

async function runPhotoMatch() {
  if (!window._pendingSelfieDataURL) { toast('No photo selected.','error'); return; }
  await performFaceMatch(window._pendingSelfieDataURL);
}

// ─── CORE MATCHING — finds matched people folder ───────────────────────────────
async function performFaceMatch(dataURL) {
  // Show scanning state
  const scanningEl = document.getElementById('guest-scanning');
  const modeUpload = document.getElementById('mode-upload');
  const modeCamera = document.getElementById('mode-camera');
  if (scanningEl) scanningEl.style.display='block';
  if (modeUpload) modeUpload.style.display='none';
  if (modeCamera) modeCamera.style.display='none';

  if (!state.currentEventId) { toast('No event selected.','error'); return; }

  // Fetch gallery with embeddings
  const { data: allMedia } = await supabase.from('media')
    .select('*').eq('event_id', state.currentEventId).eq('file_type', 'image')
    .not('face_embeddings', 'is', null);

  const gallery = allMedia || [];
  const indexed = gallery.filter(m => {
    return hasIndexedFaces(m);
  });

  if (!indexed.length) {
    if (scanningEl) scanningEl.style.display='none';
    toast('Photos not yet indexed. Ask the event organizer to index faces.', 'error');
    return;
  }

  // Match probe against gallery
  const result = await matchViaBackend(dataURL, indexed);

  if (scanningEl) scanningEl.style.display='none';

  if (!result.probe_found) {
    toast('No face detected in your photo — try a clearer, well-lit image.', 'error');
    if (modeUpload) modeUpload.style.display='flex';
    return;
  }

  const matches = result.matches || [];
  if (!matches.length) {
    renderGuestNoMatch();
    return;
  }

  // Find which people folder contains any of the matched photos
  const matchedIds = new Set(matches.map(m => m.media_id));

  // Use already-computed clusters or compute now
  let people = state.guestPeople;
  if (!people.length) {
    const clusterRes = await clusterViaBackend(indexed);
    people = clusterRes.people || [];
    state.guestPeople = people;
  }

  // Find the people folder that contains the most matched photos
  let bestFolder = null, bestOverlap = 0;
  for (const person of people) {
    const overlap = (person.photo_ids || []).filter(id => matchedIds.has(id)).length;
    if (overlap > bestOverlap) { bestOverlap = overlap; bestFolder = person; }
  }

  if (!bestFolder) {
    // No cluster found — show matched photos directly
    renderGuestResults(matches, null, allMedia);
    return;
  }

  // Show the entire matched people folder
  renderGuestResults(matches, bestFolder, allMedia);
}

function renderGuestNoMatch() {
  const container = document.getElementById('guest-main-container');
  if (!container) return;
  container.innerHTML = `
    <div style="text-align:center;padding:4rem 1rem">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="width:48px;height:48px;color:var(--text-dim);margin-bottom:1rem"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
      <div style="font-family:var(--font-serif);font-size:1.4rem;font-weight:300;color:var(--c4);margin-bottom:0.5rem">No matches found</div>
      <div style="font-family:var(--font-mono);font-size:0.62rem;color:var(--text-dim);margin-bottom:2rem">Try a clearer, well-lit photo facing the camera.</div>
      <button class="btn btn-outline" onclick="showFindMyPhotos()">Try Again</button>
      <button class="btn btn-ghost" onclick="initGuestView()" style="margin-left:0.5rem">See All Photos</button>
    </div>`;
}

function renderGuestResults(matches, folder, allMedia) {
  const container = document.getElementById('guest-main-container');
  if (!container) return;

  const photoMap = {};
  for (const m of allMedia) photoMap[m.id] = m;

  // The photos to show = entire people folder (all photos of this person)
  const folderPhotos = folder
    ? (folder.photo_ids || []).map(id => photoMap[id]).filter(Boolean)
    : matches.map(m => allMedia.find(med => med.id === m.media_id)).filter(Boolean);

  const matchedIds = new Set(matches.map(m => m.media_id));
  const folderLabel = folder ? `Your Photos — ${folder.photo_count} photo${folder.photo_count!==1?'s':''}` : `${matches.length} Matching Photo${matches.length!==1?'s':''}`;

  container.innerHTML = `
    <div style="margin-bottom:1.5rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem">
      <div>
        <div style="font-family:var(--font-serif);font-size:1.5rem;font-weight:300;color:var(--c4)">${folderLabel}</div>
        <div style="font-family:var(--font-mono);font-size:0.6rem;color:var(--text-dim);margin-top:0.2rem">Photos you appear in from this event</div>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="downloadAllMatchedPhotos()" style="gap:0.4rem;font-size:0.7rem">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Save All
        </button>
        <button class="btn btn-ghost" onclick="showFindMyPhotos()" style="font-size:0.7rem">Search Again</button>
        <button class="btn btn-ghost" onclick="initGuestView()" style="font-size:0.7rem">All Photos</button>
      </div>
    </div>
    <div class="media-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px">
      ${folderPhotos.map(m => `
        <div class="guest-result-card" style="position:relative;border-radius:8px;overflow:hidden;aspect-ratio:1;background:var(--c1)">
          <img src="${m.url}" alt="${escapeHtml(m.file_name)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;cursor:pointer" onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')">
          ${matchedIds.has(m.id)?'<div style="position:absolute;top:6px;left:6px;background:var(--accent);border-radius:4px;padding:2px 6px;font-family:var(--font-mono);font-size:0.5rem;color:var(--c1)">MATCH</div>':''}
          <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.7));padding:0.5rem;display:flex;justify-content:flex-end">
            <a href="${m.url}" download="${m.file_name}" target="_blank" title="Save photo" style="color:white;display:flex;align-items:center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </a>
          </div>
        </div>`).join('')}
    </div>`;

  // Store for bulk download
  window._guestFolderPhotos = folderPhotos;
}

async function downloadAllMatchedPhotos() {
  const photos = window._guestFolderPhotos || [];
  if (!photos.length) return;
  toast(`Saving ${photos.length} photos...`, 'info');
  for (const photo of photos) {
    // Open each in new tab as download fallback (direct download blocked cross-origin)
    const a = document.createElement('a');
    a.href = photo.url;
    a.download = photo.file_name;
    a.target = '_blank';
    a.click();
    await new Promise(r => setTimeout(r, 400)); // small delay between downloads
  }
}

window.copyImageLink = url => navigator.clipboard.writeText(url).then(()=>toast('Link copied.','success'));
function escapeHtml(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
