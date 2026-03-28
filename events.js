// events.js — Event/media CRUD + backend face indexing
import { supabase }             from './supabase.js';
import { authState }            from './auth.js';
import { toast, setLoading }    from './ui.js';
import { batchIndexViaBackend } from './face.js';

// ─── Events ───────────────────────────────────────────────────────────────────

export async function createEvent() {
  const name     = document.getElementById('new-event-name')?.value.trim();
  const date     = document.getElementById('new-event-date')?.value;
  const location = document.getElementById('new-event-loc')?.value.trim();
  const errEl    = document.getElementById('create-event-error');

  if (errEl) errEl.style.display = 'none';
  if (!name) {
    if (errEl) { errEl.textContent = 'Event name is required.'; errEl.style.display = 'block'; }
    return null;
  }

  setLoading('create-event-btn', true, 'Creating...');
  const { data, error } = await supabase
    .from('events')
    .insert([{ name, date: date || null, location: location || null, user_id: authState.user.id }])
    .select()
    .single();
  setLoading('create-event-btn', false, 'Create Event');

  if (error) {
    if (errEl) { errEl.textContent = error.message; errEl.style.display = 'block'; }
    return null;
  }

  if (document.getElementById('new-event-name')) document.getElementById('new-event-name').value = '';
  if (document.getElementById('new-event-date')) document.getElementById('new-event-date').value = '';
  if (document.getElementById('new-event-loc'))  document.getElementById('new-event-loc').value  = '';
  toast('Event created: ' + name, 'success');
  return data;
}

export async function loadEvents() {
  if (!authState.user) return [];
  const { data, error } = await supabase
    .from('events')
    .select('*, media(count)')
    .eq('user_id', authState.user.id)
    .order('created_at', { ascending: false });
  if (error) { toast('Could not load events.', 'error'); return []; }
  return (data || []).map(ev => ({ ...ev, photo_count: ev.media?.[0]?.count ?? 0 }));
}

export async function loadEvent(id) {
  const { data } = await supabase.from('events').select('*').eq('id', id).single();
  return data || null;
}

export async function deleteEvent(id) {
  // Remove storage files first
  const { data: rows } = await supabase.from('media').select('storage_path').eq('event_id', id);
  if (rows?.length) {
    const paths = rows.map(r => r.storage_path).filter(Boolean);
    if (paths.length) await supabase.storage.from('event-media').remove(paths);
  }
  await supabase.from('media').delete().eq('event_id', id);
  // Remove any saved merges
  await supabase.from('person_merges').delete().eq('event_id', id).maybeSingle();
  const { error } = await supabase.from('events').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message, 'error'); return false; }
  toast('Event deleted.');
  return true;
}

// ─── Media ────────────────────────────────────────────────────────────────────

export async function loadMedia(eventId) {
  const { data, error } = await supabase
    .from('media')
    .select('*')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false });
  if (error) { console.error('loadMedia failed:', error); return []; }
  return data || [];
}

export async function uploadFiles(eventId, files) {
  if (!files.length) { toast('No files selected.', 'error'); return false; }

  const progressLabel = document.getElementById('upload-progress-label');
  const progressFill  = document.getElementById('upload-progress-fill');
  const progressWrap  = document.getElementById('upload-progress-container');
  const submitBtn     = document.getElementById('upload-submit-btn');

  if (submitBtn)     submitBtn.style.display    = 'none';
  if (progressWrap)  progressWrap.style.display = 'block';

  const total = files.length;
  let done = 0;
  const uploadedRows = [];

  for (const file of files) {
    if (progressLabel) progressLabel.textContent = `Uploading ${done + 1} of ${total} — ${file.name}`;
    if (progressFill)  progressFill.style.width  = `${(done / total) * 100}%`;

    const ext  = file.name.split('.').pop().toLowerCase();
    const path = `${eventId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const isVideo = file.type.startsWith('video/');

    const { error: upErr } = await supabase.storage
      .from('event-media')
      .upload(path, file, { cacheControl: '3600', upsert: false });

    if (upErr) { toast(`Upload failed: ${file.name}`, 'error'); done++; continue; }

    const { data: urlData } = supabase.storage.from('event-media').getPublicUrl(path);
    const { data: row } = await supabase.from('media').insert([{
      event_id: eventId,
      file_name: file.name,
      storage_path: path,
      url: urlData.publicUrl,
      mime_type: file.type,
      file_type: isVideo ? 'video' : 'image',
    }]).select().single();

    if (row) uploadedRows.push(row);
    done++;
  }

  if (progressFill)  progressFill.style.width  = '100%';
  if (progressLabel) progressLabel.textContent = `Done — ${done} of ${total} uploaded`;
  setTimeout(() => {
    if (progressWrap) progressWrap.style.display = 'none';
    if (submitBtn)    submitBtn.style.display     = 'flex';
  }, 1400);

  toast(`${done} file${done !== 1 ? 's' : ''} uploaded.`, 'success');

  // Kick off face indexing in background for images only
  const images = uploadedRows.filter(r => r.file_type === 'image');
  if (images.length) indexFacesBackground(images, eventId);

  return true;
}

export async function indexFacesBackground(mediaRows, eventId) {
  const images = mediaRows.filter(r => r.file_type === 'image');
  if (!images.length) return;
  toast(`Indexing faces in ${images.length} photo${images.length !== 1 ? 's' : ''}…`, 'info');
  const items  = images.map(r => ({ media_id: r.id, url: r.url, event_id: eventId || r.event_id }));
  const result = await batchIndexViaBackend(items);
  const totalFaces = (result.results || []).reduce((a, r) => a + (r.faces_found || 0), 0);
  toast(`Face indexing complete — ${result.succeeded} photos, ${totalFaces} face${totalFaces !== 1 ? 's' : ''} found.`, 'success');
}

export async function reindexEvent(eventId) {
  const { data } = await supabase
    .from('media')
    .select('id,url,file_type')
    .eq('event_id', eventId);

  if (!data?.length) { toast('No media found for this event.', 'warning'); return null; }

  const images = data.filter(r => r.file_type === 'image');
  if (!images.length) { toast('No images to re-index.', 'info'); return null; }

  toast(`Re-indexing ${images.length} photo${images.length !== 1 ? 's' : ''}…`, 'info');

  // Clear stale embeddings first so partial old data never mixes with fresh data
  await supabase
    .from('media')
    .update({ face_embeddings: null, face_count: 0, face_metadata: null })
    .in('id', images.map(r => r.id));

  const items  = images.map(r => ({ media_id: r.id, url: r.url, event_id: eventId }));
  const result = await batchIndexViaBackend(items);
  const totalFaces = (result.results || []).reduce((a, r) => a + (r.faces_found || 0), 0);

  if ((result.failed || 0) > 0) {
    toast(`Re-indexed ${result.succeeded} photos, ${totalFaces} faces found. ${result.failed} failed.`, 'warning');
  } else {
    toast(`Re-indexing done — ${result.succeeded} photos, ${totalFaces} face${totalFaces !== 1 ? 's' : ''} found.`, 'success');
  }

  return result;
}
