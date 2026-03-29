// face.js — Face Intelligence Client
// All heavy AI is delegated to the Python/InsightFace backend.
//
// Config: set on window before this module loads.
//   window.MEMOIRE_API_URL = 'https://your-backend.railway.app'
//   window.MEMOIRE_API_KEY = 'your-api-key'

const BACKEND_URL = (window.MEMOIRE_API_URL || 'http://localhost:8000').replace(/\/$/, '');

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': window.MEMOIRE_API_KEY || '',
  };
}

// ─── Parse face embeddings from Supabase ─────────────────────────────────────
// Handles: null, JSON string, double-encoded string, flat array, array of arrays
export function parseFaceEmbeddings(raw) {
  if (raw == null) return null;
  try {
    let p = raw;
    if (typeof p === 'string') p = JSON.parse(p);
    if (typeof p === 'string') p = JSON.parse(p); // double-encoded
    if (!Array.isArray(p) || !p.length) return null;
    if (typeof p[0] === 'number') return [p]; // flat single embedding
    // Keep any sub-array that looks like an embedding (at least 128-d)
    const valid = p.filter(e => Array.isArray(e) && e.length >= 128);
    return valid.length ? valid : null;
  } catch {
    return null;
  }
}

// ─── 1. Index a single image ──────────────────────────────────────────────────
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

// ─── 2. Batch index images ────────────────────────────────────────────────────
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

// ─── 3. Match selfie against gallery ─────────────────────────────────────────
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
    return {
      matches: [],
      total_gallery: galleryItems.length,
      indexed_gallery: 0,
      probe_found: false,
      threshold_used: threshold || 0.50,
    };
  }
}

// ─── 4. Cluster faces into people ────────────────────────────────────────────
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
    ...(options.epsilon     != null ? { epsilon: options.epsilon }         : {}),
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
    return { people: [], total_faces: 0, total_people: 0, epsilon_used: 0.60 };
  }
}

// ─── 5. Health check ─────────────────────────────────────────────────────────
export async function checkBackendHealth() {
  try {
    const res  = await fetch(`${BACKEND_URL}/health/`);
    const data = await res.json();
    return { online: true, engineReady: data.engine_ready, uptime: data.uptime_seconds };
  } catch {
    return { online: false, engineReady: false, uptime: 0 };
  }
}

// ─── 6. Camera overlay ───────────────────────────────────────────────────────
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

  [[x, y, 1, 1], [x + size, y, -1, 1], [x, y + size, 1, -1], [x + size, y + size, -1, -1]]
    .forEach(([bx, by, dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(bx, by + dy * cs);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx + dx * cs, by);
      ctx.stroke();
    });

  ctx.fillStyle = 'rgba(168,144,128,0.5)';
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();

  return true;
}

// ─── Legacy shims ─────────────────────────────────────────────────────────────
export async function loadModels()             { return true; }
export async function descriptorFromDataURL()  { return null; }
export async function allDescriptorsFromURL()  { return [];   }
export function      matchDescriptor()         { return [];   }
export function      clusterFaces()            { return [];   }
