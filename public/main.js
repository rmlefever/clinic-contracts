import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

const state = { clinics: [], templates: [], selected: null, pdf: null, page: 1, fields: [], scale: 1.2 };
const $ = (id) => document.getElementById(id);

$('adminToken').value = localStorage.getItem('cardinalAdminToken') || '';
function saveAdminToken() {
  localStorage.setItem('cardinalAdminToken', $('adminToken').value);
}

$('adminToken').addEventListener('input', saveAdminToken);
$('adminToken').addEventListener('change', async () => {
  saveAdminToken();
  await loadClinics();
  if ($('adminToken').value) await loadTemplates();
});

function headers() {
  return { Authorization: `Bearer ${$('adminToken').value}`, 'Content-Type': 'application/json' };
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await readResponseBody(res);
  if (!res.ok) throw new Error(errorMessage(body, res));
  return body;
}

async function readResponseBody(res) {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json().catch(() => ({}));
  return { message: await res.text().catch(() => '') };
}

function errorMessage(body, res) {
  if (res.status === 401) return 'Admin token is missing or incorrect. Paste the admin token, then try again.';
  return body.message || body.error || res.statusText;
}

function requireAdminToken() {
  saveAdminToken();
  if (!$('adminToken').value.trim()) {
    $('adminToken').focus();
    throw new Error('Paste the admin token before uploading or changing contracts.');
  }
}

document.querySelectorAll('.nav button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    ['templates', 'send', 'contracts', 'clinics'].forEach((id) => $(id).classList.toggle('hidden', id !== button.dataset.tab));
    if (button.dataset.tab === 'contracts') loadContracts();
    if (button.dataset.tab === 'send') loadTemplates();
    if (button.dataset.tab === 'clinics') loadClinicList();
  });
});

async function loadClinics() {
  state.clinics = await api('/api/clinics');
  const options = state.clinics.map((clinic) => `<option value="${clinic.id}">${clinic.name}</option>`).join('');
  $('clinicFilter').innerHTML = options;
  $('uploadClinic').innerHTML = options;
  $('sendClinic').innerHTML = options;
  if (state.clinics.some((clinic) => clinic.id === 'clinic_cardinal')) {
    $('clinicFilter').value = 'clinic_cardinal';
  }
  $('uploadClinic').value = $('clinicFilter').value;
  $('sendClinic').value = $('clinicFilter').value;
  loadClinicList();
}

function selectedClinicId() {
  return $('clinicFilter').value || state.clinics[0]?.id || '';
}

async function loadTemplates() {
  if (!$('adminToken').value) {
    $('templateList').innerHTML = '<p class="muted">Paste the admin token to load templates.</p>';
    $('templateSelect').innerHTML = '';
    return;
  }
  const clinicId = selectedClinicId();
  state.templates = await api(`/api/templates?clinicId=${encodeURIComponent(clinicId)}`, { headers: headers() });
  $('templateList').innerHTML = state.templates.map((t) => `
    <div class="row">
      <div><strong>${t.name}</strong><br><span class="muted">${t.fields.length} fields</span></div>
      <div><span class="status">${t.status}</span> <button class="secondary" data-edit="${t.id}">Edit</button></div>
    </div>
  `).join('') || '<p class="muted">No templates yet.</p>';

  $('templateSelect').innerHTML = state.templates.filter((t) => t.status === 'active')
    .map((t) => `<option value="${t.id}">${t.name}</option>`).join('');

  document.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => openDesigner(button.dataset.edit)));
}

function loadClinicList() {
  $('clinicList').innerHTML = state.clinics.map((clinic) => `
    <div class="row">
      <div><strong>${clinic.name}</strong><br><span class="muted">${clinic.email_from || 'No custom sender'} · ${clinic.id}</span></div>
      <button class="secondary" data-delete-clinic="${clinic.id}">Remove</button>
    </div>
  `).join('') || '<p class="muted">No clinics yet.</p>';

  document.querySelectorAll('[data-delete-clinic]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Remove this clinic? It can only be removed if it has no templates or contracts.')) return;
    await api(`/api/clinics/${button.dataset.deleteClinic}`, { method: 'DELETE', headers: headers() });
    await loadClinics();
  }));
}

$('clinicForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  await api('/api/clinics', { method: 'POST', headers: headers(), body: JSON.stringify(values) });
  event.currentTarget.reset();
  await loadClinics();
});

$('clinicFilter').addEventListener('change', async () => {
  $('uploadClinic').value = selectedClinicId();
  $('sendClinic').value = selectedClinicId();
  await loadTemplates();
  await loadContracts();
});

$('sendClinic').addEventListener('change', async () => {
  $('clinicFilter').value = $('sendClinic').value;
  await loadTemplates();
});

$('uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    requireAdminToken();
    const form = new FormData(event.currentTarget);
    const res = await fetch('/api/templates/upload', { method: 'POST', headers: { Authorization: `Bearer ${$('adminToken').value}` }, body: form });
    const body = await readResponseBody(res);
    if (!res.ok) throw new Error(errorMessage(body, res));
    await loadTemplates();
    openDesigner(body.id);
  } catch (error) {
    alert(error.message);
  }
});

async function openDesigner(id) {
  state.selected = state.templates.find((t) => t.id === id);
  state.fields = structuredClone(state.selected.fields);
  state.page = Math.max(1, state.fields[0]?.page || 1);
  $('designer').classList.remove('hidden');
  $('designerTitle').textContent = state.selected.name;
  state.pdf = await pdfjsLib.getDocument(`/uploads/${state.selected.pdf_path.split('/').pop()}`).promise;
  renderPage();
}

async function renderPage() {
  const page = await state.pdf.getPage(state.page);
  const viewport = page.getViewport({ scale: state.scale });
  const canvas = $('pdfCanvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  renderFields();
}

function renderFields() {
  document.querySelectorAll('.field-box').forEach((node) => node.remove());
  const stage = $('pdfStage');
  const canvas = $('pdfCanvas');
  for (const field of state.fields.filter((f) => f.page === state.page)) {
    const box = document.createElement('div');
    box.className = `field-box ${field.type}`;
    box.style.left = `${field.x * canvas.width}px`;
    box.style.top = `${field.y * canvas.height}px`;
    box.style.width = `${field.w * canvas.width}px`;
    box.style.height = `${field.h * canvas.height}px`;
    box.innerHTML = `<span class="field-label">${field.label}</span>`;
    box.addEventListener('pointerdown', (event) => dragField(event, field));
    stage.appendChild(box);
  }
  $('fieldList').innerHTML = state.fields.map((field) => `
    <div class="row">
      <div><strong>${field.label}</strong><br><span class="muted">Page ${field.page} · ${field.type}</span></div>
      <button class="secondary" data-delete="${field.id}">Remove</button>
    </div>
  `).join('');
  document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => {
    state.fields = state.fields.filter((field) => field.id !== button.dataset.delete);
    renderFields();
  }));
}

function dragField(event, field) {
  const canvas = $('pdfCanvas');
  const startX = event.clientX;
  const startY = event.clientY;
  const initial = { x: field.x, y: field.y };
  event.currentTarget.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    field.x = Math.max(0, Math.min(0.98, initial.x + (moveEvent.clientX - startX) / canvas.width));
    field.y = Math.max(0, Math.min(0.98, initial.y + (moveEvent.clientY - startY) / canvas.height));
    renderFields();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

$('addField').addEventListener('click', (event) => {
  event.preventDefault();
  const type = $('fieldType').value;
  state.fields.push({
    id: `fld_${crypto.randomUUID().slice(0, 8)}`,
    label: $('fieldLabel').value,
    type,
    required: true,
    source: $('fieldSource').value,
    page: state.page,
    x: 0.28,
    y: 0.72,
    w: type === 'signature' ? 0.34 : 0.28,
    h: type === 'signature' ? 0.06 : 0.032
  });
  renderFields();
});

$('prevPage').addEventListener('click', (event) => {
  event.preventDefault();
  state.page = Math.max(1, state.page - 1);
  renderPage();
});

$('nextPage').addEventListener('click', (event) => {
  event.preventDefault();
  state.page = Math.min(state.pdf.numPages, state.page + 1);
  renderPage();
});

$('saveFields').addEventListener('click', async (event) => {
  event.preventDefault();
  await api(`/api/templates/${state.selected.id}/fields`, { method: 'PUT', headers: headers(), body: JSON.stringify({ fields: state.fields, status: 'active' }) });
  await loadTemplates();
  alert('Template activated.');
});

$('sendForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  const result = await api('/api/contracts', { method: 'POST', headers: headers(), body: JSON.stringify(values) });
  $('sendResult').classList.remove('hidden');
  $('sendResult').innerHTML = `<strong>Contract created.</strong><br><a href="${result.signingUrl}" target="_blank">${result.signingUrl}</a><br><span class="muted">Email sent: ${result.email.sent ? 'yes' : 'no'}</span>`;
});

$('showArchivedContracts').addEventListener('change', loadContracts);

async function loadContracts() {
  const archived = $('showArchivedContracts').checked;
  const rows = await api(`/api/contracts?clinicId=${encodeURIComponent(selectedClinicId())}&archived=${archived}`, { headers: headers() });
  $('contractList').innerHTML = rows.map((row) => {
    const subtitle = `${row.payer_email} · ${row.patient_record_id || 'No patient ID'}`
      + (row.archived_at ? ` · Archived ${row.archived_at}` : '')
      + (row.status === 'pending' && row.expires_at ? ` · Expires ${row.expires_at.slice(0, 10)}` : '');
    const pending = row.status === 'pending' && !row.archived_at;
    return `
    <div class="row">
      <div><strong>${row.patient_name}</strong><br><span class="muted">${subtitle}</span></div>
      <div class="row-actions">
        <span class="status">${row.status}</span>
        ${row.signed_pdf_path ? ` <a href="/storage/${row.signed_pdf_path.split('/').pop()}" target="_blank">PDF</a>` : ''}
        ${pending ? `<button class="secondary" data-resend-contract="${row.id}">Resend</button><button class="secondary" data-extend-contract="${row.id}">+30d</button>` : ''}
        ${row.status === 'completed' ? `<button class="secondary" data-verify-contract="${row.id}">Verify</button>` : ''}
        <button class="secondary" data-audit-contract="${row.id}">Audit</button>
        ${row.archived_at
          ? `<button class="secondary" data-restore-contract="${row.id}">Restore</button><button class="secondary danger" data-delete-contract="${row.id}">Remove</button>`
          : `<button class="secondary" data-archive-contract="${row.id}">Archive</button>`}
      </div>
    </div>
  `;
  }).join('') || '<p class="muted">No contracts yet.</p>';

  document.querySelectorAll('[data-archive-contract]').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/contracts/${button.dataset.archiveContract}/archive`, { method: 'POST', headers: headers() });
    await loadContracts();
  }));

  document.querySelectorAll('[data-restore-contract]').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/contracts/${button.dataset.restoreContract}/restore`, { method: 'POST', headers: headers() });
    await loadContracts();
  }));

  document.querySelectorAll('[data-delete-contract]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Permanently remove this archived contract and signed PDF? Its audit trail is retained in the archive.')) return;
    await api(`/api/contracts/${button.dataset.deleteContract}`, { method: 'DELETE', headers: headers() });
    await loadContracts();
  }));

  document.querySelectorAll('[data-resend-contract]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const result = await api(`/api/contracts/${button.dataset.resendContract}/resend`, { method: 'POST', headers: headers() });
      alert(result.email.sent ? 'Signing email sent.' : `Email not sent: ${result.email.reason || 'unknown reason'}`);
    } catch (error) { alert(error.message); }
  }));

  document.querySelectorAll('[data-extend-contract]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const row = await api(`/api/contracts/${button.dataset.extendContract}/extend`, { method: 'POST', headers: headers(), body: JSON.stringify({ days: 30 }) });
      alert(`Link extended. New expiry: ${row.expires_at.slice(0, 10)}`);
      await loadContracts();
    } catch (error) { alert(error.message); }
  }));

  document.querySelectorAll('[data-verify-contract]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const result = await api(`/api/contracts/${button.dataset.verifyContract}/verify`, { headers: headers() });
      if (!result.checked) return alert(result.reason || 'Nothing to verify yet.');
      alert(result.ok
        ? `Integrity OK — stored PDF matches the SHA-256 sealed at signing.\n${result.actual}`
        : `INTEGRITY FAILURE — the stored PDF no longer matches the sealed hash.\nStored: ${result.stored}\nActual: ${result.actual}${result.error ? `\n${result.error}` : ''}`);
    } catch (error) { alert(error.message); }
  }));

  document.querySelectorAll('[data-audit-contract]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const events = await api(`/api/contracts/${button.dataset.auditContract}/audit`, { headers: headers() });
      const out = $('auditOutput');
      out.classList.remove('hidden');
      out.textContent = events.map((e) =>
        `${e.created_at}  ${e.event_type.padEnd(22)} ${e.actor.padEnd(7)} ${e.ip || ''} ${e.data_json && e.data_json !== '{}' ? '\n    ' + e.data_json : ''}`
      ).join('\n');
    } catch (error) { alert(error.message); }
  }));
}

loadClinics().then(loadTemplates).catch((error) => {
  $('templateList').innerHTML = `<p class="error">${error.message}</p>`;
});
