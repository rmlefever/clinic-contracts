const params = new URLSearchParams(location.search);
const token = params.get('token');
const message = document.getElementById('message');
const signer = document.getElementById('signer');
const form = document.getElementById('signForm');
const pdfFrame = document.getElementById('pdfFrame');
const otpStep = document.getElementById('otpStep');
const otpIntro = document.getElementById('otpIntro');
const otpSendControls = document.getElementById('otpSendControls');
const otpVerifyControls = document.getElementById('otpVerifyControls');
const otpCodeInput = document.getElementById('otpCode');
const otpSend = document.getElementById('otpSend');
const otpVerify = document.getElementById('otpVerify');
const otpResend = document.getElementById('otpResend');

const state = { payload: null, values: {}, viewedPinged: false };

async function load() {
  const res = await fetch(`/api/sign/${token}`);
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.message || payload.error || 'Contract not found');
  state.payload = payload;
  state.values = payload.values || {};
  if (payload.identity.required && !payload.identity.verified) return renderOtpStep();
  renderSigningForm();
}

// --- Email verification step -------------------------------------------------

function renderOtpStep() {
  message.classList.add('hidden');
  signer.classList.add('hidden');
  otpStep.classList.remove('hidden');
  otpIntro.textContent = `For security, we email a verification code to ${state.payload.identity.emailMasked} before you can sign.`;
  otpSendControls.classList.remove('hidden');
  otpVerifyControls.classList.add('hidden');
}

async function requestOtp() {
  otpSend.disabled = true;
  otpResend.disabled = true;
  try {
    const res = await fetch(`/api/sign/${token}/otp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json();
    if (!res.ok) return alert(body.message || body.error || 'Unable to send code');
    if (body.sent === false) return alert(`Could not send the email: ${body.reason || 'email provider not configured'}. Please contact the clinic.`);
    otpSendControls.classList.add('hidden');
    otpVerifyControls.classList.remove('hidden');
    otpCodeInput.focus();
  } finally {
    otpSend.disabled = false;
    otpResend.disabled = false;
  }
}

async function verifyOtp() {
  const code = otpCodeInput.value.trim();
  if (!/^\d{6}$/.test(code)) return alert('Enter the 6-digit code from your email.');
  otpVerify.disabled = true;
  try {
    const res = await fetch(`/api/sign/${token}/otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const body = await res.json();
    if (!res.ok) {
      alert(body.message || body.error || 'Verification failed');
      if (String(body.message || '').includes('expired') || String(body.message || '').includes('attempts')) {
        otpCodeInput.value = '';
        otpSendControls.classList.remove('hidden');
        otpVerifyControls.classList.add('hidden');
      }
      return;
    }
    otpStep.classList.add('hidden');
    renderSigningForm();
  } finally {
    otpVerify.disabled = false;
  }
}

otpSend.addEventListener('click', requestOtp);
otpResend.addEventListener('click', requestOtp);
otpVerify.addEventListener('click', verifyOtp);
otpCodeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') verifyOtp(); });

// --- Signing form ------------------------------------------------------------

function renderSigningForm() {
  message.classList.add('hidden');
  otpStep.classList.add('hidden');
  signer.classList.remove('hidden');
  renderForm();
  // Evidence: record that the signer actually viewed the document (once).
  pdfFrame.onload = () => {
    if (state.viewedPinged) return;
    state.viewedPinged = true;
    fetch(`/api/sign/${token}/viewed`, { method: 'POST' }).catch(() => {});
  };
  pdfFrame.src = `/uploads/${state.payload.template.pdf_path.split('/').pop()}`;
}

function renderForm() {
  const fields = state.payload.template.fields;
  form.innerHTML = `
    <h2>${state.payload.contract.patient_name}</h2>
    ${fields.map((field) => fieldHtml(field)).join('')}
    <label class="consent"><input type="checkbox" id="consentCheck" required> ${state.payload.consent.text}</label>
    <button type="submit">Complete Signing</button>
  `;
  fields.filter((field) => field.type === 'signature').forEach(setupSignature);
}

function fieldHtml(field) {
  const value = state.values[field.id] || '';
  if (field.type === 'signature') {
    return `<label>${field.label}<canvas class="sig-pad" data-signature="${field.id}"></canvas><button type="button" class="secondary" data-clear="${field.id}">Clear</button></label>`;
  }
  if (field.type === 'checkbox') {
    return `<label><input type="checkbox" name="${field.id}" ${value ? 'checked' : ''}>${field.label}</label>`;
  }
  return `<label>${field.label}<input name="${field.id}" type="${field.type === 'date' ? 'date' : 'text'}" value="${escapeAttr(value)}" ${field.required ? 'required' : ''}></label>`;
}

function setupSignature(field) {
  const canvas = document.querySelector(`[data-signature="${field.id}"]`);
  const ctx = canvas.getContext('2d');
  const width = canvas.clientWidth || canvas.getBoundingClientRect().width || 300;
  const height = canvas.clientHeight || canvas.getBoundingClientRect().height || 120;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#17201b';
  let drawing = false;
  let wrote = false;
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drawing = true;
    wrote = true;
    const p = point(event);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    event.preventDefault();
    const p = point(event);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  const stopDrawing = (event) => {
    event.preventDefault();
    drawing = false;
    if (wrote) state.values[field.id] = canvas.toDataURL('image/png');
  };
  canvas.addEventListener('pointerup', stopDrawing);
  canvas.addEventListener('pointercancel', stopDrawing);
  document.querySelector(`[data-clear="${field.id}"]`).addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    delete state.values[field.id];
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = { ...state.values };
  for (const [key, value] of new FormData(form).entries()) values[key] = value.toString();
  form.querySelectorAll('input[type="checkbox"]').forEach((input) => { values[input.name] = input.checked ? 'true' : ''; });
  const res = await fetch(`/api/sign/${token}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values, consentAccepted: document.getElementById('consentCheck').checked })
  });
  const body = await res.json();
  if (!res.ok) {
    if (res.status === 403) { renderOtpStep(); return; }
    return alert(body.message || body.error || 'Unable to complete signing');
  }
  signer.classList.add('hidden');
  otpStep.classList.add('hidden');
  message.classList.remove('hidden');
  message.innerHTML = `<strong>Signed.</strong><br>The completed PDF has been stored.${body.copySent ? '<br>A copy has been emailed to you for your records.' : ''}`;
});

function escapeAttr(value) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char] || char);
}

load().catch((error) => {
  message.textContent = error.message;
  message.classList.add('error');
});
