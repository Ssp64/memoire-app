// app.js v2.0 — Main application controller (backend-powered face intelligence)
import { supabase }                    from './supabase.js';
import { authState, initAuth, doLogin as authLogin, doRegister as authRegister, doLogout as authLogout, getUserName, getUserInitials } from './auth.js';
import { createEvent, loadEvents, loadEvent, deleteEvent, loadMedia, uploadFiles, reindexEvent } from './events.js';
import { loadModels, drawCameraOverlay, matchViaBackend, clusterViaBackend, checkBackendHealth } from './face.js';
import { toast, showScanning, hideScanning, openModal, closeModal, switchAuthTab as _switchAuthTab, openLightbox, closeLightbox, setStep, staggerIn, countUp, transitionTo, setLoading } from './ui.js';

const state = {
  events: [], currentEventId: null, currentMedia: [], currentPeople: [],
  selectedFiles: [], cameraStream: null, detectLoop: null, scanMode: 'camera',
};

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
});

async function boot() {
  document.body.style.opacity = '0';
  loadModels().catch(() => {}); // No-op in v2, kept for safety
  const user = await initAuth(onAuthStateChanged);
  document.body.style.transition = 'opacity 0.3s ease';
  document.body.style.opacity    = '1';
  const params = new URLSearchParams(location.search);
  if (params.get('event')) { state.currentEventId = params.get('event'); navigate('guest'); return; }
  if (user) navigate('dashboard'); else navigate('landing');
}

function onAuthStateChanged(event, user, prevUser) {
  if (event === 'SIGNED_IN' && !prevUser) navigate('dashboard');
  else if (event === 'SIGNED_OUT') navigate('landing');
}

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
          <button class="btn btn-outline" onclick="event.stopPropagation();copyEventLink('${ev.id}')">Copy Link</button>
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
  const media = await loadMedia(id);
  state.currentMedia = media;
  document.getElementById('detail-photo-count').textContent = `(${media.length})`;
  const grid  = document.getElementById('detail-media-grid');
  const empty = document.getElementById('detail-empty');
  if (!media.length) { grid.style.display='none'; empty.style.display='block'; }
  else {
    empty.style.display='none'; grid.style.display='grid';
    grid.innerHTML = media.map(m=>`
      <div class="media-item" onclick="openLightbox('${m.url}','${escapeHtml(m.file_name)}')">
        <img src="${m.url}" alt="${escapeHtml(m.file_name)}" loading="lazy">
        ${m.file_type==='video'?'<div class="video-tag">VIDEO</div>':''}
        ${!m.face_embeddings||m.face_embeddings==='[]'?'<div class="no-face-tag" title="No face detected"></div>':''}
        <div class="media-item-overlay"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></div>
      </div>`).join('');
    staggerIn(grid, '.media-item', 25);
  }
  switchDetailTab('photos');
  showSection('detail', null);
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
    try { const p = typeof m.face_embeddings==='string' ? JSON.parse(m.face_embeddings) : m.face_embeddings; return Array.isArray(p) && p.length > 0; } catch { return false; }
  });

  if (!indexed.length) { loadingEl.style.display='none'; gridEl.style.display='none'; emptyEl.style.display='block'; return; }

  loadingEl.style.display = 'block';
  gridEl.style.display    = 'none';
  emptyEl.style.display   = 'none';

  // Call backend DBSCAN clustering
  const clusterRes = await clusterViaBackend(indexed);
  const people = clusterRes.people || [];
  state.currentPeople = people;

  loadingEl.style.display = 'none';
  if (!people.length) { emptyEl.style.display = 'block'; }
  else {
    document.getElementById('detail-people-count').textContent = `(${people.length})`;
    renderPeopleGrid(people);
  }
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
  openEventDetail(state.currentEventId);
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

// ─── GUEST VIEW ───────────────────────────────────────────────────────────────
async function initGuestView() {
  resetGuestView();
  const id = state.currentEventId || new URLSearchParams(location.search).get('event') || state.events[0]?.id;
  state.currentEventId = id;
  if (id) {
    const ev = state.events.find(e=>e.id===id) || await loadEvent(id);
    if (ev) {
      document.getElementById('guest-event-name').textContent = ev.name;
      document.getElementById('guest-event-meta').textContent = [ev.date,ev.location].filter(Boolean).join(' — ');
    }
  } else {
    document.getElementById('guest-event-name').textContent = 'Demo Event';
    document.getElementById('guest-event-meta').textContent = 'Connect an event to search photos';
  }
  switchScanMode('camera', document.getElementById('tab-camera'));
}

function resetGuestView() {
  setStep(1);
  document.getElementById('results-container').style.display = 'none';
  document.getElementById('scan-panel').style.display        = 'flex';
  resetFaceUpload();
}

async function startCamera() {
  const video=document.getElementById('camera-feed'), statusEl=document.getElementById('camera-status-text'), captBtn=document.getElementById('capture-btn');
  statusEl.textContent='Requesting camera...'; captBtn.disabled=true;
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'user', width:{ideal:1280}, height:{ideal:720} } });
    video.srcObject = state.cameraStream;
    await video.play();
    statusEl.textContent = 'Position your face in the frame — press Capture when ready';
    captBtn.disabled = false;
    startDetectLoop(video);
  } catch {
    statusEl.textContent = 'Camera unavailable — use Upload Photo instead.';
    captBtn.disabled=true; captBtn.style.opacity='0.4';
  }
}

function startDetectLoop(video) {
  const canvas=document.getElementById('face-canvas'), statusEl=document.getElementById('camera-status-text');
  clearInterval(state.detectLoop);
  state.detectLoop = setInterval(async () => {
    if (video.readyState < 2) return;
    try { await drawCameraOverlay(video, canvas); statusEl.textContent='Position your face — press Capture when ready'; } catch {}
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
  if (mode==='camera') { camEl.style.display='flex'; upEl.style.display='none'; startCamera(); }
  else { camEl.style.display='none'; upEl.style.display='flex'; stopCamera(); }
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
    document.getElementById('face-preview').src=dataURL;
    document.getElementById('face-drop-zone').style.display='none';
    document.getElementById('face-preview-wrap').style.display='flex';
    document.getElementById('match-btn').style.display='none';
    const statusEl=document.getElementById('face-detect-status');
    statusEl.querySelector('span').textContent='Ready — click Find My Photos to search';
    document.getElementById('face-detect-indicator').style.display='flex';
    document.getElementById('match-btn').style.display='flex';
    // Store the dataURL for later matching
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

// ─── CORE MATCHING — uses backend ArcFace ─────────────────────────────────────
async function performFaceMatch(dataURL) {
  setStep(2);
  showScanning('Scanning with ArcFace AI…');

  if (!state.currentEventId) { hideScanning(); toast('No event selected.','error'); return; }

  // Fetch full gallery with embeddings from Supabase
  const { data: allMedia } = await supabase.from('media')
    .select('*').eq('event_id', state.currentEventId).eq('file_type', 'image')
    .not('face_embeddings', 'is', null);

  const gallery    = allMedia || [];
  const indexed    = gallery.filter(m => { try { const p=typeof m.face_embeddings==='string'?JSON.parse(m.face_embeddings):m.face_embeddings; return Array.isArray(p)&&p.length>0; } catch { return false; } });
  const unindexed  = gallery.length - indexed.length;

  if (!gallery.length) {
    hideScanning(); setStep(1);
    toast('No photos found in this event.', 'error');
    return;
  }

  if (!indexed.length) {
    // Nothing indexed yet — show all as fallback
    hideScanning(); setStep(3);
    renderResults(gallery.map(m=>({url:m.url,file_name:m.file_name,file_type:m.file_type,mime_type:m.mime_type,storage_path:m.storage_path,media_id:m.id,score:0,distance:0})), true, 0, unindexed);
    return;
  }

  // Call backend for matching
  const result = await matchViaBackend(dataURL, indexed);

  hideScanning();
  setStep(3);
  renderResults(result.matches || [], false, indexed.length, unindexed, result.probe_found);
}

function renderResults(matches, isFallback, indexedCount, unindexedCount, probeFound=true) {
  const container  = document.getElementById('results-container');
  const grid       = document.getElementById('results-grid');
  const countLabel = document.getElementById('results-count-label');

  container.style.display = 'block';
  document.getElementById('scan-panel').style.display = 'none';

  let labelText = '';
  if (!probeFound) labelText = 'No face detected in your photo — please try a clearer image';
  else if (isFallback) labelText = 'Faces not yet indexed — showing all event photos';
  else if (!matches.length) labelText = 'No matching photos found';
  else {
    labelText = `${matches.length} photo${matches.length!==1?'s':''} found with your face`;
    if (unindexedCount>0) labelText += ` (${unindexedCount} still indexing)`;
  }
  countLabel.textContent = labelText;

  if (!matches.length) {
    grid.innerHTML = `<div class="no-results-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg><div class="empty-state-title">No matches found</div><div class="empty-state-sub">Try a clearer, well-lit photo facing the camera.</div></div>`;
    return;
  }

  grid.innerHTML = matches.map(({ url, file_name, file_type, mime_type, score }, i) => `
    <div class="result-card" style="animation-delay:${i*0.04}s">
      <div class="result-thumb">
        <img src="${url}" alt="${escapeHtml(file_name)}" loading="lazy">
        ${score>0?`<div class="match-badge">${score}%</div>`:''}
      </div>
      <div class="result-body">
        <div class="result-name">${escapeHtml(file_name)}</div>
        <div class="result-actions">
          <a class="btn btn-primary" href="${url}" download="${file_name}" target="_blank" style="text-decoration:none;justify-content:center;flex:1">Download</a>
          <button class="btn btn-secondary" onclick="copyImageLink('${url}')" style="flex:1">Copy Link</button>
        </div>
      </div>
    </div>`).join('');

  staggerIn(grid, '.result-card', 45);
  container.scrollIntoView({ behavior:'smooth', block:'start' });
}

window.copyImageLink = url => navigator.clipboard.writeText(url).then(()=>toast('Link copied.','success'));
function escapeHtml(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
