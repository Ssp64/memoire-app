// events.js v2.0 — Event/media CRUD + backend face indexing
import { supabase }              from './supabase.js';
import { authState }             from './auth.js';
import { toast, setLoading }     from './ui.js';
import { batchIndexViaBackend }  from './face.js';

export async function createEvent() {
  const name     = document.getElementById('new-event-name').value.trim();
  const date     = document.getElementById('new-event-date').value;
  const location = document.getElementById('new-event-loc').value.trim();
  const errEl    = document.getElementById('create-event-error');
  errEl.style.display = 'none';
  if (!name) { errEl.textContent = 'Event name is required.'; errEl.style.display='block'; return null; }
  setLoading('create-event-btn', true, 'Creating...');
  const { data, error } = await supabase.from('events')
    .insert([{ name, date: date||null, location: location||null, user_id: authState.user.id }])
    .select().single();
  setLoading('create-event-btn', false, 'Create Event');
  if (error) { errEl.textContent = error.message; errEl.style.display='block'; return null; }
  document.getElementById('new-event-name').value = '';
  document.getElementById('new-event-date').value = '';
  document.getElementById('new-event-loc').value  = '';
  toast('Event created: ' + name, 'success');
  return data;
}

export async function loadEvents() {
  const { data, error } = await supabase
    .from('events').select('*, media(count)')
    .eq('user_id', authState.user.id)
    .order('created_at', { ascending: false });
  if (error) { toast('Could not load events.', 'error'); return []; }
  return (data||[]).map(ev => ({ ...ev, photo_count: ev.media?.[0]?.count ?? 0 }));
}

export async function loadEvent(id) {
  const { data } = await supabase.from('events').select('*').eq('id', id).single();
  return data;
}

export async function deleteEvent(id) {
  const { data: rows } = await supabase.from('media').select('storage_path').eq('event_id', id);
  if (rows?.length) {
    const paths = rows.map(r => r.storage_path).filter(Boolean);
    if (paths.length) await supabase.storage.from('event-media').remove(paths);
  }
  await supabase.from('media').delete().eq('event_id', id);
  const { error } = await supabase.from('events').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message, 'error'); return false; }
  toast('Event deleted.');
  return true;
}

export async function loadMedia(eventId) {
  const { data } = await supabase.from('media').select('*')
    .eq('event_id', eventId).order('created_at', { ascending: false });
  return data || [];
}

export async function uploadFiles(eventId, files) {
  if (!files.length) { toast('No files selected.', 'error'); return false; }
  const progressLabel = document.getElementById('upload-progress-label');
  const progressFill  = document.getElementById('upload-progress-fill');
  const progressWrap  = document.getElementById('upload-progress-container');
  const submitBtn     = document.getElementById('upload-submit-btn');
  submitBtn.style.display    = 'none';
  progressWrap.style.display = 'block';
  const total = files.length;
  let done = 0;
  const uploadedRows = [];
  for (const file of files) {
    progressLabel.textContent = `Uploading ${done+1} of ${total} — ${file.name}`;
    progressFill.style.width  = `${(done/total)*100}%`;
    const ext  = file.name.split('.').pop().toLowerCase();
    const path = `${eventId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const isVideo = file.type.startsWith('video/');
    const { error: upErr } = await supabase.storage.from('event-media')
      .upload(path, file, { cacheControl: '3600', upsert: false });
    if (upErr) { toast(`Failed: ${file.name}`, 'error'); done++; continue; }
    const { data: urlData } = supabase.storage.from('event-media').getPublicUrl(path);
    const { data: row } = await supabase.from('media').insert([{
      event_id: eventId, file_name: file.name, storage_path: path,
      url: urlData.publicUrl, mime_type: file.type, file_type: isVideo ? 'video' : 'image',
    }]).select().single();
    if (row) uploadedRows.push(row);
    done++;
  }
  progressFill.style.width  = '100%';
  progressLabel.textContent = `Done — ${done} of ${total} uploaded`;
  setTimeout(() => { progressWrap.style.display='none'; submitBtn.style.display='flex'; }, 1400);
  toast(`${done} file${done!==1?'s':''} uploaded.`, 'success');
  const images = uploadedRows.filter(r => r.file_type === 'image');
  if (images.length) indexFacesBackground(images, eventId);
  return true;
}

export async function indexFacesBackground(mediaRows, eventId) {
  const images = mediaRows.filter(r => r.file_type === 'image');
  if (!images.length) return;
  toast(`Indexing faces in ${images.length} photo${images.length!==1?'s':''}…`, 'info');
  const items  = images.map(r => ({ media_id: r.id, url: r.url, event_id: eventId || r.event_id }));
  const result = await batchIndexViaBackend(items);
  const totalFaces = (result.results||[]).reduce((a,r)=>a+(r.faces_found||0),0);
  toast(`Face indexing complete — ${result.succeeded} photos, ${totalFaces} face${totalFaces!==1?'s':''} found.`, 'success');
}

export async function reindexEvent(eventId) {
  const { data } = await supabase.from('media').select('id,url,file_type').eq('event_id', eventId);
  if (!data?.length) return;
  const images = data.filter(r => r.file_type === 'image');
  toast(`Re-indexing ${images.length} photos via AI backend…`, 'info');
  const items  = images.map(r => ({ media_id: r.id, url: r.url, event_id: eventId }));
  const result = await batchIndexViaBackend(items);
  const totalFaces = (result.results||[]).reduce((a,r)=>a+(r.faces_found||0),0);
  toast(`Re-indexing complete — ${result.succeeded} photos, ${totalFaces} faces.`, 'success');
}
