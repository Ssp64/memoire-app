// face.js v2.0 — Production Face Intelligence Client
// All heavy AI is now delegated to the Python/InsightFace backend.
//
// What changed vs v1 (face-api.js):
//   ✗ No more 40MB model downloads in the browser
//   ✗ No more unreliable browser-side WASM inference
//   ✓ ArcFace 512-d embeddings (vs 128-d FaceNet) — far better accuracy
//   ✓ RetinaFace detector — better at small/occluded/group faces
//   ✓ DBSCAN clustering — Google Photos quality grouping
//   ✓ Multi-augmentation probe — robust selfie matching
//
// Configuration: set these on window before loading this module.
//   window.MEMOIRE_API_URL = 'https://your-backend.railway.app'
//   window.MEMOIRE_API_KEY = 'your-api-key'

const BACKEND_URL = (window.MEMOIRE_API_URL || 'http://localhost:8000').replace(/\/$/, '');
const getHeaders  = () => ({
  'Content-Type': 'application/json',
  'X-API-Key': window.MEMOIRE_API_KEY || '',
});

// ─── 1. INDEX A SINGLE IMAGE (called after each upload) ───────────────────────
export async function indexImageViaBackend(mediaId, url, eventId) {
  try {
    const res = await fetch(`${BACKEND_URL}/api/v1/faces/index`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ media_id: mediaId, url, event_id: eventId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('[face] indexImage failed:', err);
    return { success: false, faces_found: 0, error: String(err) };
  }
}

// ─── 2. BATCH INDEX (called after bulk upload — much more efficient) ───────────
export async function batchIndexViaBackend(items) {
  try {
    const res = await fetch(`${BACKEND_URL}/api/v1/faces/index/batch`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ items }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('[face] batchIndex failed:', err);
    return { total: items.length, succeeded: 0, failed: items.length, results: [] };
  }
}

// ─── 3. MATCH SELFIE AGAINST GALLERY ──────────────────────────────────────────
// Gallery rows are passed from the client (already fetched from Supabase),
// so the backend doesn't need its own DB round-trip per match.
export async function matchViaBackend(imageBase64, galleryItems, threshold = null) {
  const payload = {
    image_base64: imageBase64,
    gallery: galleryItems.map(item => ({
      id: item.id,
      url: item.url,
      file_name: item.file_name,
      file_type: item.file_type || 'image',
      mime_type: item.mime_type || null,
      storage_path: item.storage_path || null,
      face_embeddings: parseFaceEmbeddings(item.face_embeddings),
    })),
    ...(threshold !== null ? { threshold } : {}),
  };

  try {
    const res = await fetch(`${BACKEND_URL}/api/v1/faces/match`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (err) {
    console.error('[face] match failed:', err);
    return { matches: [], total_gallery: galleryItems.length, indexed_gallery: 0, probe_found: false, threshold_used: threshold || 0.40 };
  }
}

// ─── 4. CLUSTER FACES INTO PEOPLE (Google Photos style) ───────────────────────
export async function clusterViaBackend(mediaItems, options = {}) {
  const payload = {
    media_items: mediaItems.map(item => ({
      id: item.id,
      url: item.url,
      file_name: item.file_name,
      file_type: item.file_type || 'image',
      mime_type: item.mime_type || null,
      storage_path: item.storage_path || null,
      face_embeddings: parseFaceEmbeddings(item.face_embeddings),
    })),
    ...(options.epsilon   != null ? { epsilon: options.epsilon }         : {}),
    ...(options.min_samples != null ? { min_samples: options.min_samples } : {}),
  };

  try {
    const res = await fetch(`${BACKEND_URL}/api/v1/faces/cluster`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('[face] cluster failed:', err);
    return { people: [], total_faces: 0, total_people: 0, epsilon_used: 0.45 };
  }
}

// ─── 5. HEALTH CHECK ──────────────────────────────────────────────────────────
export async function checkBackendHealth() {
  try {
    const res  = await fetch(`${BACKEND_URL}/health/`);
    const data = await res.json();
    return { online: true, engineReady: data.engine_ready, uptime: data.uptime_seconds };
  } catch {
    return { online: false, engineReady: false, uptime: 0 };
  }
}

// ─── 6. CAMERA OVERLAY (lightweight — no model download) ──────────────────────
// Just draws the UI reticle. Real detection happens server-side on capture.
export async function drawCameraOverlay(videoEl, canvasEl) {
  const ctx = canvasEl.getContext('2d');
  if (canvasEl.width !== videoEl.videoWidth) {
    canvasEl.width  = videoEl.videoWidth  || 640;
    canvasEl.height = videoEl.videoHeight || 480;
  }
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  const cx = canvasEl.width / 2, cy = canvasEl.height / 2;
  const size = Math.min(canvasEl.width, canvasEl.height) * 0.38;
  const cs   = size * 0.20;
  const x = cx - size / 2, y = cy - size / 2;

  ctx.strokeStyle = 'rgba(211,218,217,0.75)';
  ctx.lineWidth   = 2.5;

  [[x,y,1,1],[x+size,y,-1,1],[x,y+size,1,-1],[x+size,y+size,-1,-1]].forEach(([bx,by,dx,dy]) => {
    ctx.beginPath();
    ctx.moveTo(bx, by + dy * cs); ctx.lineTo(bx, by); ctx.lineTo(bx + dx * cs, by);
    ctx.stroke();
  });

  // Pulsing center dot
  ctx.fillStyle = 'rgba(168,144,128,0.5)';
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();

  return true;
}

// ─── 7. LEGACY SHIMS (keep app.js working without changes) ────────────────────
export async function loadModels()              { return true; } // No-op: backend handles
export async function descriptorFromDataURL()  { return null; } // Replaced by matchViaBackend
export async function allDescriptorsFromURL()  { return [];   } // Replaced by indexImageViaBackend
export function      matchDescriptor()         { return [];   } // Replaced by matchViaBackend
export function      clusterFaces()            { return [];   } // Replaced by clusterViaBackend

// ─── UTILITY ──────────────────────────────────────────────────────────────────
function parseFaceEmbeddings(raw) {
  if (raw == null) return null;
  try {
    // Handle double-serialized strings (legacy backend stored json.dumps() into jsonb)
    let p = raw;
    if (typeof p === 'string') p = JSON.parse(p);
    if (typeof p === 'string') p = JSON.parse(p); // second pass for double-encoded
    if (!Array.isArray(p) || !p.length) return null;
    // Flat array of numbers = single face embedding — wrap it
    if (typeof p[0] === 'number') return [p];
    // Array of arrays = multiple faces — filter out any malformed entries
    const valid = p.filter(e => Array.isArray(e) && e.length > 0);
    return valid.length ? valid : null;
  } catch { return null; }
}
