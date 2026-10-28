"use strict";

/* ==========================================================
   EcoRA · página web
   - Cuentas con usuario y contraseña (guardadas en Google Sheets).
   - Lee códigos QR con la cámara (BarcodeDetector o jsQR).
   - El servidor (Apps Script) decide los puntos, evita registros
     repetidos y valida los canjes. La página solo muestra lo que responde.
   ========================================================== */

const CONFIG = {
  // URL de la aplicación web de Google Apps Script.
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbz28oW8ic4iomKXCYPQ2XBXL5c_rwYW8ZHi0iL6apFqsItBJlhXuBQ7_2RfuPZlo5Qt/exec",
  JSQR_URL: "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js",
  PUNTOS_POR_ACCION: 20,          // debe coincidir con Code.gs
  ESPERA_MS: 5 * 60 * 1000,       // mismo bote, cada 5 minutos
  TIMEOUT_MS: 25000,
  METAS: [100, 250, 500, 1000],
};

const REWARDS = [
  { name: "Beneficio básico", cost: 100, icon: "🎟️", desc: "Un premio sencillo para empezar a canjear." },
  { name: "Recompensa especial", cost: 250, icon: "🎁", desc: "Para quienes ya llevan varias acciones." },
];

const MESSAGES = [
  "Una buena acción cuenta, aunque parezca pequeña.",
  "Tu participación ayuda a mejorar los espacios de todos.",
  "Hoy puedes dejar un lugar mejor de como lo encontraste.",
  "Cada acción suma. Sigue participando.",
  "Los buenos hábitos comienzan con algo sencillo.",
  "Tu escuela también se construye con tus acciones.",
  "Un espacio limpio se disfruta más entre todos.",
  "Haz que tu próxima acción también cuente.",
  "Cuidar los espacios compartidos es responsabilidad de todos.",
  "Pequeños cambios pueden crear grandes hábitos.",
  "La constancia vale más que una sola acción.",
  "Cada registro representa una oportunidad para mejorar.",
  "Participar también puede ser divertido.",
  "Tus acciones pueden inspirar a otras personas.",
  "Hazlo por tu espacio y por quienes lo comparten.",
  "Un buen hábito puede comenzar hoy.",
  "Tu esfuerzo también merece reconocimiento.",
  "Mantener el orden es un trabajo en equipo.",
  "Una acción responsable puede marcar la diferencia.",
  "EcoRA convierte la participación en una experiencia.",
];

const STORAGE_KEY = "ecora.web.v3";
const BIN_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;
const USER_PATTERN = /^[\p{L}\p{N} .'-]{2,30}$/u;

const $ = (id) => document.getElementById(id);

/* ---------- Estado ---------- */
const emptyState = () => ({
  token: "", usuario: "", saldo: 0, ganados: 0, escaneos: 0, posicion: 0, cooldowns: {},
});

let state = loadState();
let ranking = [];
let rankingError = false;
let currentBin = "";
let pendingReward = null;
let inFlight = false;
let authMode = "login";
let scanner = { stream: null, timer: null, detector: null, busy: false };

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved && typeof saved === "object" ? { ...emptyState(), ...saved } : emptyState();
  } catch {
    return emptyState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Si el navegador bloquea el almacenamiento, la página sigue funcionando. */
  }
}

const isLoggedIn = () => Boolean(state.token);

function applyProfile(p) {
  if (!p) return;
  if (typeof p.saldo === "number") state.saldo = p.saldo;
  if (typeof p.ganados === "number") state.ganados = p.ganados;
  if (typeof p.escaneos === "number") state.escaneos = p.escaneos;
  if (typeof p.posicion === "number") state.posicion = p.posicion;
}

/* ---------- Comunicación con Apps Script ---------- */
async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const api = {
  get: (params) => request(CONFIG.SCRIPT_URL + "?" + new URLSearchParams(params).toString()),
  post: (body) => request(CONFIG.SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  }),
};

/** Si el servidor dice que la sesión ya no vale, se cierra aquí también. */
function sessionLost(res) {
  if (res && res.sesion === false) {
    endSession(res.error || "Tu sesión terminó. Vuelve a entrar.");
    return true;
  }
  return false;
}

async function refreshProfile() {
  if (!isLoggedIn()) return;
  try {
    const res = await api.post({ action: "perfil", token: state.token });
    if (sessionLost(res)) return;
    if (res.ok) {
      applyProfile(res);
      saveState();
    }
  } catch {
    /* Sin conexión: se muestran los últimos datos guardados. */
  }
}

async function refreshRanking() {
  try {
    const res = await api.get({ action: "ranking" });
    if (res.ok) {
      ranking = res.lista || [];
      rankingError = false;
    }
  } catch {
    rankingError = true;
  }
}

async function refreshFromServer() {
  await Promise.all([refreshProfile(), refreshRanking()]);
  renderAll();
}

/* ---------- Cuenta: entrar, crear, salir ---------- */
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("tabLogin").classList.toggle("active", !signup);
  $("tabSignup").classList.toggle("active", signup);
  $("tabLogin").setAttribute("aria-selected", String(!signup));
  $("tabSignup").setAttribute("aria-selected", String(signup));
  $("confirmWrap").hidden = !signup;
  $("authPass").setAttribute("autocomplete", signup ? "new-password" : "current-password");
  $("authSubmit").textContent = signup ? "Crear cuenta" : "Entrar";
  $("authNote").textContent = "";
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (inFlight) return;

  const usuario = $("authUser").value.trim().replace(/\s+/g, " ");
  const contrasena = $("authPass").value;
  const signup = authMode === "signup";
  const note = $("authNote");

  if (!USER_PATTERN.test(usuario)) {
    note.textContent = "El usuario debe tener entre 2 y 30 letras o números.";
    return;
  }
  if (contrasena.length < 6) {
    note.textContent = "La contraseña debe tener al menos 6 caracteres.";
    return;
  }
  if (signup && contrasena !== $("authPass2").value) {
    note.textContent = "Las contraseñas no coinciden.";
    return;
  }

  inFlight = true;
  note.textContent = "";
  const button = $("authSubmit");
  button.disabled = true;
  button.textContent = signup ? "Creando cuenta…" : "Entrando…";

  try {
    const res = await api.post({
      action: signup ? "crear_cuenta" : "iniciar_sesion",
      usuario,
      contrasena,
    });
    if (!res.ok) {
      note.textContent = res.error || "No se pudo entrar. Intenta de nuevo.";
      return;
    }

    state = { ...emptyState(), token: res.token, usuario: res.usuario };
    applyProfile(res.perfil);
    saveState();
    $("authPass").value = "";
    $("authPass2").value = "";
    toast(signup ? "¡Cuenta creada! Bienvenido, " + res.usuario : "¡Hola de nuevo, " + res.usuario + "!");
    refreshRanking().then(renderRanking);
    $("escanear").scrollIntoView({ behavior: "smooth" });
  } catch {
    note.textContent = "Sin conexión. Revisa tu internet e intenta de nuevo.";
  } finally {
    inFlight = false;
    button.disabled = false;
    button.textContent = signup ? "Crear cuenta" : "Entrar";
    renderAll();
  }
}

function endSession(message) {
  stopCamera();
  state = emptyState();
  currentBin = "";
  saveState();
  renderAll();
  if (message) toast(message);
}

async function logout() {
  const token = state.token;
  endSession("Cerraste tu sesión.");
  try {
    await api.post({ action: "cerrar_sesion", token });
  } catch {
    /* Aunque falle, en este dispositivo ya se cerró. */
  }
}

function requireLogin() {
  if (isLoggedIn()) return true;
  toast("Primero entra a tu cuenta.");
  $("cuenta").scrollIntoView({ behavior: "smooth" });
  $("authUser").focus({ preventScroll: true });
  return false;
}

/* ---------- Cámara y lectura de QR ---------- */
function setCamStatus(message) {
  $("camStatus").textContent = message;
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar " + url));
    document.head.appendChild(s);
  });
}

async function toggleCamera() {
  if (scanner.stream) stopCamera();
  else await startCamera();
}

async function startCamera() {
  if (!requireLogin()) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setCamStatus("Tu navegador no permite usar la cámara. Escribe el código del bote abajo.");
    return;
  }

  try {
    scanner.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch {
    setCamStatus("No pudimos abrir la cámara. Revisa que la hayas permitido en el navegador.");
    return;
  }

  const video = $("video");
  video.srcObject = scanner.stream;
  try { await video.play(); } catch { /* algunos navegadores lo inician solos */ }

  $("viewfinder").classList.add("on");
  $("camBtn").textContent = "Cerrar cámara";

  if ("BarcodeDetector" in window) {
    try {
      scanner.detector = new BarcodeDetector({ formats: ["qr_code"] });
    } catch {
      scanner.detector = null;
    }
  }

  if (!scanner.detector) {
    setCamStatus("Cargando lector de códigos…");
    try {
      await loadScript(CONFIG.JSQR_URL);
    } catch {
      setCamStatus("No se pudo cargar el lector. Escribe el código del bote abajo.");
      return;
    }
  }

  setCamStatus("Acércate al código. Lo leeremos solos.");
  startScanning();
}

function startScanning() {
  clearInterval(scanner.timer);
  scanner.timer = setInterval(async () => {
    if (scanner.busy || !scanner.stream) return;
    scanner.busy = true;
    try {
      const text = await readFrame();
      if (text) onCodeFound(text);
    } catch {
      /* Un cuadro que no se pudo leer no es un error: seguimos. */
    } finally {
      scanner.busy = false;
    }
  }, 250);
}

async function readFrame() {
  const video = $("video");
  if (video.readyState < 2) return null;

  if (scanner.detector) {
    const codes = await scanner.detector.detect(video);
    return codes.length ? codes[0].rawValue : null;
  }

  if (!window.jsQR) return null;
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = window.jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
  return code ? code.data : null;
}

function onCodeFound(text) {
  const bin = parseBinId(text);
  if (!bin) {
    setCamStatus("Ese código no es de un bote de EcoRA. Busca el QR de tu bote.");
    return;
  }
  stopCamera();
  if (navigator.vibrate) navigator.vibrate(80);
  identifyBin(bin);
}

function stopCamera() {
  clearInterval(scanner.timer);
  scanner.timer = null;
  if (scanner.stream) {
    scanner.stream.getTracks().forEach((track) => track.stop());
    scanner.stream = null;
  }
  const video = $("video");
  if (video) video.srcObject = null;
  $("viewfinder").classList.remove("on");
  $("camBtn").textContent = "Abrir cámara";
  setCamStatus("");
}

/* Acepta "ECORA-001" o un enlace como https://…/?bote=ECORA-001 */
function parseBinId(raw) {
  const text = String(raw || "").trim();
  let candidate = text;
  try {
    const url = new URL(text);
    candidate = url.searchParams.get("bote") || url.pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    /* no es un enlace: se usa el texto tal cual */
  }
  return BIN_PATTERN.test(candidate) ? candidate : "";
}

/* ---------- Identificar y registrar ---------- */
function identifyBin(raw) {
  if (!requireLogin()) return;
  const bin = parseBinId(raw);
  if (!bin) {
    toast("Escribe un código válido, por ejemplo ECORA-001.");
    return;
  }
  currentBin = bin;
  $("motive").hidden = true;
  renderResult();
  $("result").scrollIntoView({ behavior: "smooth", block: "center" });
}

function cooldownLeft(bin) {
  const last = state.cooldowns[bin] || 0;
  return Math.max(0, last + CONFIG.ESPERA_MS - Date.now());
}

async function registerAction() {
  if (!currentBin || inFlight) return;
  if (!requireLogin()) return;
  if (cooldownLeft(currentBin) > 0) {
    renderResult();
    return;
  }

  inFlight = true;
  const button = $("registerBtn");
  button.disabled = true;
  button.textContent = "Guardando…";

  try {
    const res = await api.post({ action: "registrar", token: state.token, bote: currentBin });
    if (sessionLost(res)) return;
    if (res.duplicado) {
      state.cooldowns[currentBin] = Date.now();
      saveState();
      toast(res.error);
      return;
    }
    if (!res.ok) {
      toast(res.error || "No se pudo registrar. Intenta de nuevo.");
      return;
    }

    applyProfile(res);
    state.cooldowns[currentBin] = Date.now();
    saveState();

    const motive = $("motive");
    motive.textContent = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
    motive.hidden = false;
    toast("¡Listo! +" + (res.puntos || CONFIG.PUNTOS_POR_ACCION) + " puntos");
    refreshRanking().then(renderRanking);
  } catch {
    toast("Sin conexión. Tu registro no se guardó; intenta de nuevo.");
  } finally {
    inFlight = false;
    button.textContent = "Ya tiré mi basura";
    renderAll();
  }
}

/* ---------- Recompensas ---------- */
function openRedeem(name) {
  if (!requireLogin()) return;
  const reward = REWARDS.find((r) => r.name === name);
  if (!reward) return;
  if (state.saldo < reward.cost) {
    toast("Todavía te faltan " + (reward.cost - state.saldo) + " puntos.");
    return;
  }
  pendingReward = reward;
  $("confirmTitle").textContent = "¿Canjear " + reward.name + "?";
  $("confirmText").textContent =
    "Se descontarán " + reward.cost + " puntos. Te quedarán " + (state.saldo - reward.cost) + ".";
  $("confirmDialog").showModal();
}

async function redeem(reward) {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await api.post({
      action: "canjear",
      token: state.token,
      nombre: reward.name,
      costo: reward.cost,
    });
    if (sessionLost(res)) return;
    if (!res.ok) {
      toast(res.error || "No se pudo canjear.");
      return;
    }
    state.saldo = res.saldo;
    saveState();
    toast("¡Canjeaste " + reward.name + "!");
  } catch {
    toast("Sin conexión. Intenta de nuevo en un momento.");
  } finally {
    inFlight = false;
    renderAll();
  }
}

/* ---------- Pintar la página ---------- */
function renderAll() {
  renderAccount();
  renderStats();
  renderResult();
  renderRewards();
  renderRanking();
}

function renderAccount() {
  const logged = isLoggedIn();
  $("authOut").hidden = logged;
  $("authIn").hidden = !logged;
  $("openAccount").textContent = logged ? "Mi cuenta" : "Entrar";
  if (logged) {
    $("helloTitle").textContent = "Hola, " + state.usuario;
    $("avatar").textContent = state.usuario.charAt(0).toUpperCase();
  }
}

function renderStats() {
  const logged = isLoggedIn();
  $("statPoints").textContent = logged ? state.saldo : "—";
  $("statScans").textContent = logged ? state.escaneos : "—";
  $("statRank").textContent = logged && state.posicion ? "#" + state.posicion : "—";

  if (!logged) {
    $("goalText").textContent = "Entra a tu cuenta para ver tu avance.";
    $("goalBar").style.width = "0%";
    return;
  }

  const ganados = state.ganados;
  const next = CONFIG.METAS.find((m) => ganados < m);
  const prev = [0, ...CONFIG.METAS].filter((m) => m <= ganados).pop() || 0;
  let percent = 100;

  if (next === undefined) {
    $("goalText").textContent = "¡Superaste todas las metas! Eres parte de la comunidad EcoRA.";
  } else {
    percent = ((ganados - prev) / (next - prev)) * 100;
    $("goalText").textContent = "Te faltan " + (next - ganados) + " puntos para tu meta de " + next + ".";
  }
  $("goalBar").style.width = Math.round(percent) + "%";
}

function renderResult() {
  const box = $("result");
  if (!currentBin || !isLoggedIn()) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $("resultTitle").textContent = "Bote " + currentBin;

  const wait = cooldownLeft(currentBin);
  const button = $("registerBtn");
  if (wait > 0) {
    $("resultText").textContent =
      "Ya registraste este bote hace poco. Podrás sumar otra vez en " + Math.ceil(wait / 60000) + " min.";
    button.disabled = true;
  } else {
    $("resultText").textContent = "Tira tu basura en este bote y luego pulsa el botón para sumar tus puntos.";
    button.disabled = inFlight;
  }
  $("resultNote").textContent =
    "Por ahora confiamos en tu palabra. La verificación con cámara llega en la siguiente etapa.";
}

function renderRewards() {
  const logged = isLoggedIn();
  $("rewardList").innerHTML = REWARDS.map((r) => {
    const missing = Math.max(0, r.cost - state.saldo);
    let label = "Canjear";
    if (!logged) label = "Entra para canjear";
    else if (missing) label = "Te faltan " + missing;
    const disabled = logged && missing > 0;
    return `
      <article class="reward">
        <span class="reward-icon" aria-hidden="true">${r.icon}</span>
        <div class="reward-body">
          <h3>${escapeHTML(r.name)}</h3>
          <p>${escapeHTML(r.desc)}</p>
          <p class="reward-cost">${r.cost} puntos</p>
        </div>
        <button class="btn small" type="button" data-reward="${escapeHTML(r.name)}" ${disabled ? "disabled" : ""}>
          ${label}
        </button>
      </article>`;
  }).join("");
}

function renderRanking() {
  const list = $("rankingList");
  const note = $("rankingNote");

  if (rankingError) {
    note.textContent = "No pudimos cargar el ranking. Revisa tu conexión y pulsa Actualizar.";
  } else if (!ranking.length) {
    note.textContent = "Todavía no hay participantes. ¡Sé el primero!";
  } else {
    note.textContent = "";
  }

  const me = state.usuario.toLowerCase();
  list.innerHTML = ranking.map((row, i) => {
    const mine = isLoggedIn() && String(row.usuario).toLowerCase() === me;
    return `
      <li class="rank-row${mine ? " me" : ""}">
        <span class="rank-pos">${i + 1}</span>
        <span class="rank-name">${escapeHTML(row.usuario)}${mine ? " (tú)" : ""}</span>
        <span class="rank-pts">${Number(row.ganados) || 0} pts</span>
      </li>`;
  }).join("");
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

let toastTimer = null;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

/* ---------- Arranque ---------- */
function init() {
  $("tabLogin").addEventListener("click", () => setAuthMode("login"));
  $("tabSignup").addEventListener("click", () => setAuthMode("signup"));
  $("authForm").addEventListener("submit", handleAuthSubmit);
  $("logoutBtn").addEventListener("click", logout);
  $("openAccount").addEventListener("click", () => {
    $("cuenta").scrollIntoView({ behavior: "smooth" });
    if (!isLoggedIn()) $("authUser").focus({ preventScroll: true });
  });

  $("camBtn").addEventListener("click", toggleCamera);
  $("manualForm").addEventListener("submit", (event) => {
    event.preventDefault();
    identifyBin($("binId").value);
  });
  $("registerBtn").addEventListener("click", registerAction);

  $("refreshRanking").addEventListener("click", async () => {
    await refreshRanking();
    renderRanking();
  });

  $("rewardList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reward]");
    if (button) openRedeem(button.dataset.reward);
  });

  $("confirmDialog").addEventListener("close", () => {
    const reward = pendingReward;
    pendingReward = null;
    if ($("confirmDialog").returnValue === "ok" && reward) redeem(reward);
  });

  window.addEventListener("pagehide", stopCamera);

  setAuthMode("login");
  renderAll();
  refreshFromServer();
}

document.addEventListener("DOMContentLoaded", init);
