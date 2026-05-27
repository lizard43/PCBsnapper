const snapBtn = document.getElementById("snapBtn");
const statusEl = document.getElementById("status");
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const viewerWrap = document.getElementById("viewerWrap");
const gridBtn = document.getElementById("gridBtn");
const gridOverlay = document.getElementById("gridOverlay");
const comLogPane = document.getElementById("comLogPane");
const comLog = document.getElementById("comLog");
const logResizeHandle = document.getElementById("logResizeHandle");

const connectPrinterBtn = document.getElementById("connectPrinterBtn");
const homeAllBtn = document.getElementById("homeAllBtn");
const homeSafeBtn = document.getElementById("homeSafeBtn");
const printerStatus = document.getElementById("printerStatus");
const xyzStatus = document.getElementById("xyzStatus");
const jogStepSelect = document.getElementById("jogStepSelect");

const settingsBtn = document.getElementById("settingsBtn");
const settingsOverlay = document.getElementById("settingsOverlay");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsCancelBtn = document.getElementById("settingsCancelBtn");
const settingsResetBtn = document.getElementById("settingsResetBtn");
const settingsForm = document.getElementById("settingsForm");

let stream = null;
let cameraDeviceId = null;
let settings = null;
let printerConnected = false;
let printerOpening = false;
let cameraStatusText = "cam: disconnected";

const STORAGE_KEY_SETTINGS = "pcbsnapper.settings";
const STORAGE_KEY_LOG_HEIGHT = "pcbsnapper.comLogHeight";
const STORAGE_KEY_GRID_VISIBLE = "pcbsnapper.gridVisible";
const DEFAULT_LOG_LINES = 4;
const LOG_POLL_MS = 500;

let lastLogSeq = 0;
let logPollTimer = null;
let logDragging = false;
let gridVisible = localStorage.getItem(STORAGE_KEY_GRID_VISIBLE) === "1";

const VIDEO_MODES = [
  { label: "3840 × 2160 / 4K", width: 3840, height: 2160 },
  { label: "2560 × 1440 / 2K", width: 2560, height: 1440 },
  { label: "1920 × 1080 / 1080p", width: 1920, height: 1080 },
  { label: "1280 × 720 / 720p", width: 1280, height: 720 },
  { label: "640 × 480 / VGA", width: 640, height: 480 }
];

const DEFAULT_SETTINGS = {
  camera: {
    nameContains: "HY-6110",
    defaultResolution: "3840x2160",
    jpegQuality: 0.95,
    snapshotFolder: "",
    snapshotPrefix: "snap"
  },
  printer: {
    comPort: "COM3",
    baudRate: 115200,
    lineEnding: "\\n",
    units: "mm",
    safeZ: 100.0,
    safeX: 0.0,
    safeY: 0.0,
    feedrateXY: 3000,
    feedrateZ: 300,
    settleDelayMs: 2000
  },
  raster: {
    tileStepX: 50.8,
    tileStepY: 50.8,
    tilesX: 3,
    tilesY: 3,
    snakeRaster: true,
    filenamePattern: "tile_x{X}_y{Y}.jpg"
  },
  debug: {
    logSerialTraffic: true,
    dryRun: true
  }
};

function updateToolbarStatus() {
  if (!printerStatus) return;

  const printerText = printerStatus.dataset.baseText || "printer: disconnected";
  printerStatus.textContent = `${printerText} · ${cameraStatusText}`;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function mergeSettings(defaults, saved) {
  const out = clone(defaults);

  if (!saved || typeof saved !== "object") return out;

  for (const section of Object.keys(out)) {
    if (!saved[section] || typeof saved[section] !== "object") continue;
    out[section] = { ...out[section], ...saved[section] };
  }

  return out;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
    const saved = raw ? JSON.parse(raw) : null;
    settings = mergeSettings(DEFAULT_SETTINGS, saved);
  } catch {
    settings = clone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings, null, 2));
}

function setStatus(msg) {
  statusEl.textContent = msg;
  console.log(msg);
}

function numberValue(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function intValue(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safePrinterZ() {
  return clampNumber(settings?.printer?.safeZ, 0, 1000, DEFAULT_SETTINGS.printer.safeZ);
}

function populateSettingsResolutionDropdown() {
  const sel = document.getElementById("setDefaultResolution");
  sel.innerHTML = "";

  for (const mode of VIDEO_MODES) {
    const opt = document.createElement("option");
    opt.value = `${mode.width}x${mode.height}`;
    opt.textContent = mode.label;
    sel.appendChild(opt);
  }
}

function loadSettingsForm() {
  populateSettingsResolutionDropdown();

  document.getElementById("setCameraName").value = settings.camera.nameContains;
  document.getElementById("setDefaultResolution").value = settings.camera.defaultResolution;
  document.getElementById("setJpegQuality").value = settings.camera.jpegQuality;
  document.getElementById("setSnapshotFolder").value = settings.camera.snapshotFolder;
  document.getElementById("setSnapshotPrefix").value = settings.camera.snapshotPrefix;

  document.getElementById("setComPort").value = settings.printer.comPort;
  document.getElementById("setBaudRate").value = settings.printer.baudRate;
  document.getElementById("setLineEnding").value = settings.printer.lineEnding;
  document.getElementById("setUnits").value = settings.printer.units;
  document.getElementById("setSafeZ").value = settings.printer.safeZ;
  document.getElementById("setSafeX").value = settings.printer.safeX;
  document.getElementById("setSafeY").value = settings.printer.safeY;
  document.getElementById("setFeedXY").value = settings.printer.feedrateXY;
  document.getElementById("setFeedZ").value = settings.printer.feedrateZ;
  document.getElementById("setSettleDelay").value = settings.printer.settleDelayMs;

  document.getElementById("setTileStepX").value = settings.raster.tileStepX;
  document.getElementById("setTileStepY").value = settings.raster.tileStepY;
  document.getElementById("setTilesX").value = settings.raster.tilesX;
  document.getElementById("setTilesY").value = settings.raster.tilesY;
  document.getElementById("setSnakeRaster").checked = settings.raster.snakeRaster;
  document.getElementById("setFilenamePattern").value = settings.raster.filenamePattern;

  document.getElementById("setLogSerial").checked = settings.debug.logSerialTraffic;
  document.getElementById("setDryRun").checked = settings.debug.dryRun;
}

function readSettingsForm() {
  settings.camera.nameContains =
    document.getElementById("setCameraName").value.trim() || "HY-6110";
  settings.camera.defaultResolution =
    document.getElementById("setDefaultResolution").value;
  settings.camera.jpegQuality =
    clampNumber(document.getElementById("setJpegQuality").value, 0.1, 1, 0.95);
  settings.camera.snapshotFolder =
    document.getElementById("setSnapshotFolder").value.trim();
  settings.camera.snapshotPrefix =
    document.getElementById("setSnapshotPrefix").value.trim() || "snap";

  settings.printer.comPort =
    document.getElementById("setComPort").value.trim() || "COM3";
  settings.printer.baudRate =
    intValue(document.getElementById("setBaudRate").value, 115200);
  settings.printer.lineEnding =
    document.getElementById("setLineEnding").value;
  settings.printer.units =
    document.getElementById("setUnits").value;
  settings.printer.safeZ =
    clampNumber(document.getElementById("setSafeZ").value, 0, 1000, DEFAULT_SETTINGS.printer.safeZ);
  settings.printer.safeX =
    clampNumber(document.getElementById("setSafeX").value, 0, 1000, DEFAULT_SETTINGS.printer.safeX);
  settings.printer.safeY =
    clampNumber(document.getElementById("setSafeY").value, 0, 1000, DEFAULT_SETTINGS.printer.safeY);
  settings.printer.feedrateXY =
    intValue(document.getElementById("setFeedXY").value, 3000);
  settings.printer.feedrateZ =
    intValue(document.getElementById("setFeedZ").value, 300);
  settings.printer.settleDelayMs =
    intValue(document.getElementById("setSettleDelay").value, 2000);

  settings.raster.tileStepX =
    numberValue(document.getElementById("setTileStepX").value, 50.8);
  settings.raster.tileStepY =
    numberValue(document.getElementById("setTileStepY").value, 50.8);
  settings.raster.tilesX =
    intValue(document.getElementById("setTilesX").value, 3);
  settings.raster.tilesY =
    intValue(document.getElementById("setTilesY").value, 3);
  settings.raster.snakeRaster =
    document.getElementById("setSnakeRaster").checked;
  settings.raster.filenamePattern =
    document.getElementById("setFilenamePattern").value.trim() || "tile_x{X}_y{Y}.jpg";

  settings.debug.logSerialTraffic =
    document.getElementById("setLogSerial").checked;
  settings.debug.dryRun =
    document.getElementById("setDryRun").checked;
}

function openSettings() {
  loadSettingsForm();
  settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  settingsOverlay.classList.add("hidden");
}

function setGridVisible(visible, persist = true) {
  gridVisible = !!visible;

  if (gridOverlay) {
    gridOverlay.classList.toggle("hidden", !gridVisible);
  }

  if (gridBtn) {
    gridBtn.classList.toggle("active", gridVisible);
    gridBtn.setAttribute("aria-pressed", gridVisible ? "true" : "false");
    gridBtn.title = gridVisible ? "Hide UI grid overlay" : "Show UI grid overlay";
  }

  if (persist) {
    localStorage.setItem(STORAGE_KEY_GRID_VISIBLE, gridVisible ? "1" : "0");
  }

  updateGridOverlayRect();
}

function updateGridOverlayRect() {
  if (!gridOverlay || !video || !viewerWrap) return;

  const stage = video.parentElement;
  if (!stage) return;

  const stageRect = stage.getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();
  const naturalW = video.videoWidth || 0;
  const naturalH = video.videoHeight || 0;

  if (!naturalW || !naturalH || !videoRect.width || !videoRect.height) {
    gridOverlay.style.left = "0px";
    gridOverlay.style.top = "0px";
    gridOverlay.style.width = "100%";
    gridOverlay.style.height = "100%";
    return;
  }

  const naturalRatio = naturalW / naturalH;
  const boxRatio = videoRect.width / videoRect.height;

  let renderedW;
  let renderedH;

  if (boxRatio > naturalRatio) {
    renderedH = videoRect.height;
    renderedW = renderedH * naturalRatio;
  } else {
    renderedW = videoRect.width;
    renderedH = renderedW / naturalRatio;
  }

  const left = (videoRect.left - stageRect.left) + ((videoRect.width - renderedW) / 2);
  const top = (videoRect.top - stageRect.top) + ((videoRect.height - renderedH) / 2);

  gridOverlay.style.left = `${left}px`;
  gridOverlay.style.top = `${top}px`;
  gridOverlay.style.width = `${renderedW}px`;
  gridOverlay.style.height = `${renderedH}px`;
}

function setupGridOverlay() {
  if (!gridBtn || !gridOverlay) return;

  gridBtn.addEventListener("click", () => {
    setGridVisible(!gridVisible);
  });

  window.addEventListener("resize", updateGridOverlayRect);
  video.addEventListener("loadedmetadata", updateGridOverlayRect);
  video.addEventListener("playing", updateGridOverlayRect);

  setGridVisible(gridVisible, false);
}

function lineHeightPx(element) {
  const value = Number.parseFloat(getComputedStyle(element).lineHeight);
  return Number.isFinite(value) ? value : 16;
}

function defaultLogHeightPx() {
  const lineHeight = lineHeightPx(comLog || document.body);
  const paneStyle = getComputedStyle(comLogPane);
  const padTop = Number.parseFloat(paneStyle.paddingTop) || 0;
  const padBottom = Number.parseFloat(paneStyle.paddingBottom) || 0;

  return Math.ceil((lineHeight * DEFAULT_LOG_LINES) + padTop + padBottom + 2);
}

function setLogPaneHeight(height, persist = false) {
  if (!comLogPane || !viewerWrap) return;

  const toolbarHeight = document.querySelector(".toolbar")?.offsetHeight || 0;
  const handleHeight = logResizeHandle?.offsetHeight || 0;
  const available = Math.max(0, window.innerHeight - toolbarHeight - handleHeight);
  const clamped = Math.max(0, Math.min(available, Math.round(height)));

  document.documentElement.style.setProperty("--com-log-height", `${clamped}px`);

  if (persist) {
    localStorage.setItem(STORAGE_KEY_LOG_HEIGHT, String(clamped));
  }
}

function restoreLogPaneHeight() {
  const saved = Number(localStorage.getItem(STORAGE_KEY_LOG_HEIGHT));
  setLogPaneHeight(Number.isFinite(saved) ? saved : defaultLogHeightPx(), false);
}

function setupLogResizer() {
  if (!logResizeHandle || !comLogPane) return;

  logResizeHandle.addEventListener("pointerdown", event => {
    logDragging = true;
    document.body.classList.add("resizing-log");
    logResizeHandle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  logResizeHandle.addEventListener("pointermove", event => {
    if (!logDragging) return;

    setLogPaneHeight(window.innerHeight - event.clientY, true);
    event.preventDefault();
  });

  const stopDrag = event => {
    if (!logDragging) return;

    logDragging = false;
    document.body.classList.remove("resizing-log");

    try {
      logResizeHandle.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
  };

  logResizeHandle.addEventListener("pointerup", stopDrag);
  logResizeHandle.addEventListener("pointercancel", stopDrag);

  window.addEventListener("resize", () => {
    const current = Number.parseFloat(getComputedStyle(comLogPane).height);
    setLogPaneHeight(Number.isFinite(current) ? current : defaultLogHeightPx(), true);
  });
}

function appendLogLines(lines) {
  if (!comLog || !Array.isArray(lines) || !lines.length) return;

  const wasAtBottom =
    comLogPane.scrollTop + comLogPane.clientHeight >= comLogPane.scrollHeight - 4;

  const text = lines.map(line => line.text).join("\n");
  comLog.textContent += comLog.textContent ? `\n${text}` : text;

  const allLines = comLog.textContent.split("\n");
  if (allLines.length > 2000) {
    comLog.textContent = allLines.slice(-2000).join("\n");
  }

  if (wasAtBottom) {
    comLogPane.scrollTop = comLogPane.scrollHeight;
  }
}

async function pollComLog() {
  try {
    const res = await fetch(`/api/logs?since=${lastLogSeq}`, { cache: "no-store" });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();

    if (!json.ok) {
      throw new Error(json.error || "log endpoint returned ok:false");
    }

    appendLogLines(json.lines);
    lastLogSeq = Number(json.nextSeq || lastLogSeq);
  } catch (err) {
    appendLogLines([{ text: `[UI LOG ERROR] /api/logs failed: ${err.message}` }]);
  }
}

function startComLogPolling() {
  restoreLogPaneHeight();
  setupLogResizer();
  pollComLog();

  if (logPollTimer) {
    clearInterval(logPollTimer);
  }

  logPollTimer = setInterval(pollComLog, LOG_POLL_MS);
}

function setupTabs() {
  const tabButtons = [...document.querySelectorAll(".tab-btn")];
  const panels = [...document.querySelectorAll(".tab-panel")];

  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;

      tabButtons.forEach(b => b.classList.toggle("active", b === btn));
      panels.forEach(p => p.classList.toggle("active", p.dataset.panel === tab));
    });
  }
}

async function findPreferredCamera() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  let cams = devices.filter(d => d.kind === "videoinput");

  const preferred = settings.camera.nameContains.toLowerCase();

  let match = cams.find(d =>
    (d.label || "").toLowerCase().includes(preferred)
  );

  if (!match && cams.length > 0 && cams.every(d => !d.label)) {
    setStatus("requesting camera permission...");

    const tempStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });

    tempStream.getTracks().forEach(t => t.stop());

    devices = await navigator.mediaDevices.enumerateDevices();
    cams = devices.filter(d => d.kind === "videoinput");

    match = cams.find(d =>
      (d.label || "").toLowerCase().includes(preferred)
    );
  }

  if (!match) {
    throw new Error(`Camera containing "${settings.camera.nameContains}" not found`);
  }

  cameraDeviceId = match.deviceId;
  setStatus(`found ${match.label}`);
}

function stopCameraStream() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  video.srcObject = null;
}

function waitForVideoMetadata() {
  return new Promise((resolve, reject) => {
    if (video.videoWidth && video.videoHeight) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Camera opened, but no video frame metadata arrived"));
    }, 5000);

    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };

    const onLoaded = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Video element reported an error while opening camera"));
    };

    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function makeCameraConstraints(width, height, exactDevice = true) {
  const videoConstraints = {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: 30 }
  };

  if (cameraDeviceId) {
    videoConstraints.deviceId = exactDevice
      ? { exact: cameraDeviceId }
      : { ideal: cameraDeviceId };
  }

  return {
    video: videoConstraints,
    audio: false
  };
}

async function openCameraWithFallbacks(modeW, modeH) {
  const attempts = [
    { width: modeW, height: modeH, exactDevice: true, label: "requested" },
    { width: 1920, height: 1080, exactDevice: true, label: "1080p fallback" },
    { width: 1280, height: 720, exactDevice: true, label: "720p fallback" },
    { width: modeW, height: modeH, exactDevice: false, label: "loose device fallback" }
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      setStatus(
        `opening ${settings.camera.nameContains} ` +
        `${attempt.width}x${attempt.height} (${attempt.label})...`
      );

      return await navigator.mediaDevices.getUserMedia(
        makeCameraConstraints(attempt.width, attempt.height, attempt.exactDevice)
      );
    } catch (err) {
      lastError = err;
      console.warn(
        "[CAMERA OPEN FAILED]",
        `${attempt.width}x${attempt.height}`,
        attempt.label,
        err.name || "",
        err.message || err
      );
    }
  }

  throw lastError || new Error("Camera open failed");
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Browser camera API is not available. Use http://localhost or https.");
    }

    snapBtn.disabled = true;
    stopCameraStream();

    cameraDeviceId = null;
    await findPreferredCamera();

    const [modeW, modeH] = settings.camera.defaultResolution.split("x").map(Number);
    stream = await openCameraWithFallbacks(modeW, modeH);

    video.srcObject = stream;
    await waitForVideoMetadata();
    await video.play();

    const track = stream.getVideoTracks()[0];
    const actual = track.getSettings();

    cameraStatusText =
      `cam: ${settings.camera.nameContains} ` +
      `${actual.width || video.videoWidth}x${actual.height || video.videoHeight}` +
      `@${Math.round(actual.frameRate || 0)}`;

    updateToolbarStatus();

    setStatus(
      `live: ${actual.width || video.videoWidth}x${actual.height || video.videoHeight} ` +
      `@ ${actual.frameRate || "?"} fps`
    );

    updateGridOverlayRect();
    snapBtn.disabled = false;
  } catch (err) {
    console.error("[CAMERA ERROR]", err);
    snapBtn.disabled = true;
    stopCameraStream();

    cameraStatusText = "cam: offline";
    updateToolbarStatus();
    setStatus(err.name ? `${err.name}: ${err.message}` : err.message);
  }
}

function makeSnapshotName(width, height) {
  return `${settings.camera.snapshotPrefix}-${Date.now()}-${width}x${height}.jpg`;
}

async function takeSnapshot() {
  if (!stream) return;

  const w = video.videoWidth;
  const h = video.videoHeight;

  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);

  const quality = clampNumber(settings.camera.jpegQuality, 0.1, 1, 0.95);
  const imageData = canvas.toDataURL("image/jpeg", quality);
  const name = makeSnapshotName(w, h);

  setStatus("saving snapshot...");

  try {
    const res = await fetch("/api/snapshot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        imageData,
        name,
        folder: settings.camera.snapshotFolder
      })
    });

    const json = await res.json();

    if (json.ok) {
      setStatus(`saved ${json.file}`);
    } else {
      setStatus(`snapshot failed: ${json.error}`);
    }
  } catch (err) {
    console.error(err);
    setStatus("snapshot error: " + err.message);
  }
}

function setMotionButtonsEnabled(enabled) {
  if (homeAllBtn) homeAllBtn.disabled = !enabled;
  if (homeSafeBtn) homeSafeBtn.disabled = !enabled;
  if (jogStepSelect) jogStepSelect.disabled = !enabled;

  document.querySelectorAll(".jog-btn").forEach(btn => {
    btn.disabled = !enabled;
  });
}

function updateXYZDisplay(pos) {
  if (!pos) {
    xyzStatus.textContent = "X?.?? Y?.?? Z?.??";
    return;
  }

  xyzStatus.textContent =
    `X${Number(pos.x || 0).toFixed(2)} ` +
    `Y${Number(pos.y || 0).toFixed(2)} ` +
    `Z${Number(pos.z || 0).toFixed(2)}`;
}

function setPrinterUi(state) {
  printerConnected = !!state.connected;
  printerOpening = !!state.opening;

  const dry = !!state.dryRun;
  const needsHome = !!state.needsHome;
  const info = state.printerInfo || {};
  const portLabel = info.comPort || settings.printer.comPort;

  if (printerOpening) {
    printerStatus.dataset.baseText = "printer: connecting...";
    updateToolbarStatus();
    connectPrinterBtn.textContent = "Connecting";
    connectPrinterBtn.disabled = true;
    setMotionButtonsEnabled(false);
  } else if (printerConnected) {
    printerStatus.dataset.baseText = dry
      ? "printer: dry run"
      : needsHome
        ? `printer: ${portLabel} — needs Safe`
        : `printer: ${portLabel}`;
    updateToolbarStatus();
    connectPrinterBtn.textContent = "Disconnect";
    connectPrinterBtn.disabled = false;
    setMotionButtonsEnabled(true);
  } else {
    printerStatus.dataset.baseText = "printer: disconnected";
    updateToolbarStatus();
    connectPrinterBtn.textContent = "Connect";
    connectPrinterBtn.disabled = false;
    setMotionButtonsEnabled(false);
  }

  updateXYZDisplay(state.xyz);
}

async function refreshPrinterStatus() {
  try {
    const params = new URLSearchParams({
      lineEnding: settings?.printer?.lineEnding || "\\n"
    });

    const res = await fetch(`/api/printer/status?${params.toString()}`);
    const json = await res.json();

    if (!json.ok) return;

    setPrinterUi(json);
  } catch {
    printerStatus.dataset.baseText = "printer: unknown";
    updateToolbarStatus();
    connectPrinterBtn.textContent = "Connect";
    connectPrinterBtn.disabled = false;
    setMotionButtonsEnabled(false);
  }
}

async function connectPrinter() {
  try {
    setPrinterUi({
      connected: false,
      opening: true,
      dryRun: settings.debug.dryRun,
      xyz: null,
      printerInfo: {
        comPort: settings.printer.comPort,
        baudRate: settings.printer.baudRate
      }
    });

    const res = await fetch("/api/printer/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        comPort: settings.printer.comPort,
        baudRate: settings.printer.baudRate,
        lineEnding: settings.printer.lineEnding,
        dryRunMode: settings.debug.dryRun
      })
    });

    const json = await res.json();

    if (!json.ok) {
      throw new Error(json.error || "Connect failed");
    }

    setPrinterUi(json);
    setStatus(json.warning || "printer connected");
  } catch (err) {
    console.error(err);
    setPrinterUi({
      connected: false,
      opening: false,
      dryRun: false,
      xyz: null,
      printerInfo: {}
    });
    setStatus(err.message);
  }
}

async function disconnectPrinter() {
  try {
    connectPrinterBtn.disabled = true;
    if (homeAllBtn) homeAllBtn.disabled = true;
    if (homeSafeBtn) homeSafeBtn.disabled = true;
    if (jogStepSelect) jogStepSelect.disabled = true;
    printerStatus.dataset.baseText = "printer: disconnecting...";
    updateToolbarStatus();

    const res = await fetch("/api/printer/disconnect", {
      method: "POST"
    });

    const json = await res.json();

    setPrinterUi(json);
    setStatus("printer disconnected");
  } catch (err) {
    console.error(err);
    setStatus("disconnect failed: " + err.message);
    await refreshPrinterStatus();
  }
}

async function togglePrinterConnection() {
  await refreshPrinterStatus();

  if (printerConnected) {
    await disconnectPrinter();
  } else if (!printerOpening) {
    await connectPrinter();
  }
}

async function homeAllPrinter() {
  try {
    await refreshPrinterStatus();

    if (!printerConnected) {
      throw new Error("Printer is not connected");
    }

    setStatus("sending full G28 XYZ home...");

    const res = await fetch("/api/printer/home-all", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        lineEnding: settings.printer.lineEnding
      })
    });

    const json = await res.json();

    if (!json.ok) throw new Error(json.error);

    setPrinterUi(json);

    const p = json.xyz || {};
    setStatus(
      `G28 complete: X${Number(p.x || 0).toFixed(2)} ` +
      `Y${Number(p.y || 0).toFixed(2)} ` +
      `Z${Number(p.z || 0).toFixed(2)}`
    );
  } catch (err) {
    console.error(err);
    setStatus("G28 failed: " + err.message);
    await refreshPrinterStatus();
  }
}

async function homeSafePrinter() {
  try {
    await refreshPrinterStatus();

    if (!printerConnected) {
      throw new Error("Printer is not connected");
    }

    const safeZ = safePrinterZ();

    setStatus(`Safe: set current Z as ${safeZ.toFixed(2)}, then home X/Y...`);

    const res = await fetch("/api/printer/home-safe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        safeX: settings.printer.safeX,
        safeY: settings.printer.safeY,
        safeZ,
        feedrateXY: settings.printer.feedrateXY,
        feedrateZ: settings.printer.feedrateZ,
        lineEnding: settings.printer.lineEnding
      })
    });

    const json = await res.json();

    if (!json.ok) throw new Error(json.error);

    setPrinterUi(json);

    const p = json.xyz || {};
    setStatus(
      `Safe complete: X${Number(p.x || 0).toFixed(2)} ` +
      `Y${Number(p.y || 0).toFixed(2)} ` +
      `Z${Number(p.z || 0).toFixed(2)}`
    );
  } catch (err) {
    console.error(err);
    setStatus("Safe failed: " + err.message);
    await refreshPrinterStatus();
  }
}

async function jog(axis, direction) {
  try {
    await refreshPrinterStatus();

    if (!printerConnected) {
      throw new Error("Printer is not connected");
    }

    const step = Number(jogStepSelect.value);
    const distance = step * Number(direction);

    const res = await fetch("/api/printer/jog", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        axis,
        distance,
        safeZ: safePrinterZ(),
        feedrateXY: settings.printer.feedrateXY,
        feedrateZ: settings.printer.feedrateZ,
        lineEnding: settings.printer.lineEnding
      })
    });

    const json = await res.json();

    if (!json.ok) throw new Error(json.error);

    setPrinterUi(json);

    const p = json.xyz || {};
    setStatus(
      `jogged ${axis}${distance}; printer reports ` +
      `X${Number(p.x || 0).toFixed(2)} ` +
      `Y${Number(p.y || 0).toFixed(2)} ` +
      `Z${Number(p.z || 0).toFixed(2)}`
    );
  } catch (err) {
    console.error(err);
    setStatus("jog failed: " + err.message);
    await refreshPrinterStatus();
  }
}

snapBtn.addEventListener("click", takeSnapshot);
connectPrinterBtn.addEventListener("click", togglePrinterConnection);
homeAllBtn.addEventListener("click", homeAllPrinter);
homeSafeBtn.addEventListener("click", homeSafePrinter);

document.querySelectorAll(".jog-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    jog(btn.dataset.axis, btn.dataset.dir);
  });
});

settingsBtn.addEventListener("click", openSettings);
settingsCloseBtn.addEventListener("click", closeSettings);
settingsCancelBtn.addEventListener("click", closeSettings);

settingsResetBtn.addEventListener("click", () => {
  settings = clone(DEFAULT_SETTINGS);
  saveSettings();
  loadSettingsForm();
  cameraDeviceId = null;
  startCamera();
  refreshPrinterStatus();
});

settingsOverlay.addEventListener("click", event => {
  if (event.target === settingsOverlay) {
    closeSettings();
  }
});

settingsForm.addEventListener("submit", event => {
  event.preventDefault();

  const oldCameraName = settings.camera.nameContains;
  const oldResolution = settings.camera.defaultResolution;

  readSettingsForm();
  saveSettings();

  closeSettings();

  if (settings.camera.nameContains !== oldCameraName) {
    cameraDeviceId = null;
  }

  if (
    settings.camera.nameContains !== oldCameraName ||
    settings.camera.defaultResolution !== oldResolution
  ) {
    startCamera();
  }

  refreshPrinterStatus();
});

window.addEventListener("focus", refreshPrinterStatus);

setupTabs();
setupGridOverlay();
loadSettings();
setMotionButtonsEnabled(false);
startComLogPolling();
startCamera();
refreshPrinterStatus();
