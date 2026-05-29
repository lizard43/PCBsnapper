const snapBtn = document.getElementById("snapBtn");
const statusEl = document.getElementById("status");
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const viewerWrap = document.getElementById("viewerWrap");
const gridBtn = document.getElementById("gridBtn");
const startCaptureBtn = document.getElementById("startCaptureBtn");
const pauseCaptureBtn = document.getElementById("pauseCaptureBtn");
const captureOverlay = document.getElementById("captureOverlay");
const captureCloseBtn = document.getElementById("captureCloseBtn");
const captureCancelBtn = document.getElementById("captureCancelBtn");
const captureForm = document.getElementById("captureForm");
const captureProjectName = document.getElementById("captureProjectName");
const captureTileStepX = document.getElementById("captureTileStepX");
const captureTileStepY = document.getElementById("captureTileStepY");
const captureTilesX = document.getElementById("captureTilesX");
const captureTilesY = document.getElementById("captureTilesY");
const captureFarX = document.getElementById("captureFarX");
const captureFarY = document.getElementById("captureFarY");
const captureTileCountPreview = document.getElementById("captureTileCountPreview");
const captureSnakeRaster = document.getElementById("captureSnakeRaster");
const capturePauseSeconds = document.getElementById("capturePauseSeconds");
const captureFilenamePattern = document.getElementById("captureFilenamePattern");
const captureImageFormat = document.getElementById("captureImageFormat");
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
let printerDryRun = false;
let cameraStatusText = "cam: disconnected";
let rasterRunning = false;
let rasterCancelRequested = false;
let rasterPaused = false;
let currentPrinterXyz = null;

const STORAGE_KEY_SETTINGS = "pcbsnapper.settings";
const STORAGE_KEY_LOG_HEIGHT = "pcbsnapper.comLogHeight";
const STORAGE_KEY_GRID_VISIBLE = "pcbsnapper.gridVisible";
const DEFAULT_LOG_LINES = 4;
const LOG_POLL_MS = 500;

let lastLogSeq = 0;
let logPollTimer = null;
let logDragging = false;
let logBackendDown = false;
let logPollDelayMs = LOG_POLL_MS;
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
    snapshotFormat: "jpg",
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
    capturePauseSeconds: 2,
    filenamePattern: "{project}_tile_x{X}_y{Y}.jpg"
  },
  debug: {
    logSerialTraffic: true,
    dryRun: true
  }
};

function updateToolbarStatus() {
  if (!printerStatus) return;

  const printerText =
    printerStatus.dataset.baseText || "printer: disconnected";

  printerStatus.textContent = printerText;
}

function updatePauseButtonState() {
  if (!pauseCaptureBtn) return;

  pauseCaptureBtn.disabled = !rasterRunning || rasterCancelRequested;
  pauseCaptureBtn.textContent = rasterPaused ? "Continue" : "Pause";
  pauseCaptureBtn.classList.toggle("capture-paused", rasterPaused);
  pauseCaptureBtn.title = rasterPaused
    ? "Continue raster capture"
    : "Pause raster capture before the next step move";
}

function updateCaptureButtonState() {
  if (startCaptureBtn) {
    if (rasterRunning) {
      startCaptureBtn.textContent = rasterCancelRequested ? "Stopping..." : "Stop Capture";
      startCaptureBtn.disabled = rasterCancelRequested;
      startCaptureBtn.classList.add("capture-running");
      startCaptureBtn.title = rasterCancelRequested
        ? "Stopping capture after the current command returns"
        : "Stop raster capture";
    } else {
      startCaptureBtn.textContent = "Start Capture";
      startCaptureBtn.disabled = !printerConnected;
      startCaptureBtn.classList.remove("capture-running");
      startCaptureBtn.title = "Start raster capture";
    }
  }

  updatePauseButtonState();
}

function requestStopRasterCapture() {
  if (!rasterRunning || rasterCancelRequested) return;

  rasterCancelRequested = true;
  rasterPaused = false;
  updateCaptureButtonState();
  setStatus("raster stop requested: no more move commands will be sent");
}

function toggleRasterPause() {
  if (!rasterRunning || rasterCancelRequested) return;

  rasterPaused = !rasterPaused;
  updateCaptureButtonState();
  setStatus(rasterPaused ? "raster paused" : "raster continuing");
}

function throwIfRasterStopped() {
  if (rasterCancelRequested) {
    throw new Error("Raster capture stopped");
  }
}

async function waitIfRasterPaused(context = "raster") {
  let announced = false;

  while (rasterPaused && !rasterCancelRequested) {
    if (!announced) {
      setStatus(`${context}: paused; press Continue to resume`);
      announced = true;
    }

    await delay(100);
  }

  throwIfRasterStopped();
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
  document.getElementById("setSnapshotFormat").value = normalizeImageFormat(settings.camera.snapshotFormat);
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
  document.getElementById("setCapturePauseSeconds").value =
    settings.raster.capturePauseSeconds ?? DEFAULT_SETTINGS.raster.capturePauseSeconds;
  document.getElementById("setFilenamePattern").value =
    normalizeRasterFilenamePattern(settings.raster.filenamePattern);

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
  settings.camera.snapshotFormat =
    normalizeImageFormat(document.getElementById("setSnapshotFormat").value);
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
  settings.raster.capturePauseSeconds =
    clampNumber(document.getElementById("setCapturePauseSeconds").value, 0, 3600, DEFAULT_SETTINGS.raster.capturePauseSeconds);
  settings.raster.filenamePattern =
    normalizeRasterFilenamePattern(document.getElementById("setFilenamePattern").value);

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

function normalizeImageFormat(value) {
  const fmt = String(value || "").trim().toLowerCase();

  if (fmt === "png") return "png";
  return "jpg";
}

function imageFormatExtension(format) {
  return normalizeImageFormat(format) === "png" ? "png" : "jpg";
}

function imageFormatMime(format) {
  return normalizeImageFormat(format) === "png" ? "image/png" : "image/jpeg";
}

function replaceImageExtension(name, format) {
  const ext = imageFormatExtension(format);
  const safeName = String(name || "").trim();
  const withoutKnownExt = safeName.replace(/\.(jpe?g|png)$/i, "");

  return `${withoutKnownExt}.${ext}`;
}

function setCaptureCountPreview(text) {
  if (captureTileCountPreview) {
    captureTileCountPreview.textContent = text;
  }
}

function captureOriginX() {
  return numberValue(currentPrinterXyz?.x, 0);
}

function captureOriginY() {
  return numberValue(currentPrinterXyz?.y, 0);
}

function wholeNumberText(value) {
  return String(Math.round(numberValue(value, 0)));
}

function axisPositionFromOrigin(originValue, farValue, index, stepValue) {
  const origin = numberValue(originValue, 0);
  const far = numberValue(farValue, origin);
  const step = Math.max(0.001, Math.abs(numberValue(stepValue, 0.001)));
  const delta = far - origin;
  const direction = delta < 0 ? -1 : 1;
  const distance = Math.abs(delta);
  const steppedDistance = Math.min(distance, index * step);

  return origin + (direction * steppedDistance);
}

function tileCountForDistance(originValue, farValue, stepValue) {
  const origin = numberValue(originValue, 0);
  const far = numberValue(farValue, origin);
  const step = Math.max(0.001, Math.abs(numberValue(stepValue, 0.001)));
  const distance = Math.abs(far - origin);

  return Math.max(1, Math.ceil(distance / step) + 1);
}

function updateCapturePreview() {
  const originX = captureOriginX();
  const originY = captureOriginY();

  const tilesX = Math.max(1, intValue(captureTilesX?.value, settings.raster.tilesX));
  const tilesY = Math.max(1, intValue(captureTilesY?.value, settings.raster.tilesY));

  const farX = numberValue(captureFarX?.value, originX);
  const farY = numberValue(captureFarY?.value, originY);
  const total = tilesX * tilesY;

  setCaptureCountPreview(
    `Origin X${wholeNumberText(originX)} Y${wholeNumberText(originY)} → ` +
    `far X${wholeNumberText(farX)} Y${wholeNumberText(farY)} · ` +
    `${tilesX} × ${tilesY} = ${total} tiles`
  );
}

function updateCaptureFarFromCounts() {
  if (!captureFarX || !captureFarY) {
    updateCapturePreview();
    return;
  }

  const originX = captureOriginX();
  const originY = captureOriginY();

  const stepX = Math.max(0.001, numberValue(captureTileStepX?.value, settings.raster.tileStepX));
  const stepY = Math.max(0.001, numberValue(captureTileStepY?.value, settings.raster.tileStepY));

  const tilesX = Math.max(1, intValue(captureTilesX?.value, settings.raster.tilesX));
  const tilesY = Math.max(1, intValue(captureTilesY?.value, settings.raster.tilesY));

  captureFarX.value = (originX + ((tilesX - 1) * stepX)).toFixed(0);
  captureFarY.value = (originY + ((tilesY - 1) * stepY)).toFixed(0);

  updateCapturePreview();
}

function updateCaptureCountsFromFar() {
  if (!captureFarX || !captureFarY) {
    updateCapturePreview();
    return;
  }

  const originX = captureOriginX();
  const originY = captureOriginY();

  const stepX = Math.max(0.001, numberValue(captureTileStepX?.value, settings.raster.tileStepX));
  const stepY = Math.max(0.001, numberValue(captureTileStepY?.value, settings.raster.tileStepY));

  const farX = numberValue(captureFarX.value, originX);
  const farY = numberValue(captureFarY.value, originY);

  const tilesX = tileCountForDistance(originX, farX, stepX);
  const tilesY = tileCountForDistance(originY, farY, stepY);

  if (captureTilesX) captureTilesX.value = tilesX;
  if (captureTilesY) captureTilesY.value = tilesY;

  updateCapturePreview();
}

async function openCaptureDialog() {
  if (!captureOverlay) return;

  await refreshPrinterStatus();

  const missing = [];
  const requireEl = (el, name) => {
    if (!el) missing.push(name);
    return !!el;
  };

  requireEl(captureProjectName, "captureProjectName");
  requireEl(captureTileStepX, "captureTileStepX");
  requireEl(captureTileStepY, "captureTileStepY");
  requireEl(captureTilesX, "captureTilesX");
  requireEl(captureTilesY, "captureTilesY");
  requireEl(captureSnakeRaster, "captureSnakeRaster");
  requireEl(capturePauseSeconds, "capturePauseSeconds");
  requireEl(captureFilenamePattern, "captureFilenamePattern");
  requireEl(captureImageFormat, "captureImageFormat");

  if (missing.length) {
    const msg = `capture dialog markup is missing: ${missing.join(", ")}`;
    console.error(msg);
    setStatus(msg);
    return;
  }

  captureProjectName.value = settings?.camera?.snapshotFolder || "pcb_project";
  captureTileStepX.value = settings?.raster?.tileStepX ?? DEFAULT_SETTINGS.raster.tileStepX;
  captureTileStepY.value = settings?.raster?.tileStepY ?? DEFAULT_SETTINGS.raster.tileStepY;
  captureTilesX.value = settings?.raster?.tilesX ?? DEFAULT_SETTINGS.raster.tilesX;
  captureTilesY.value = settings?.raster?.tilesY ?? DEFAULT_SETTINGS.raster.tilesY;
  captureSnakeRaster.checked = !!(settings?.raster?.snakeRaster ?? DEFAULT_SETTINGS.raster.snakeRaster);
  capturePauseSeconds.value =
    settings?.raster?.capturePauseSeconds ?? DEFAULT_SETTINGS.raster.capturePauseSeconds;
  captureImageFormat.value = normalizeImageFormat(settings?.camera?.snapshotFormat);
  captureFilenamePattern.value = replaceImageExtension(
    settings?.raster?.filenamePattern || "{project}_tile_x{X}_y{Y}.jpg",
    captureImageFormat.value
  );

  updateCaptureFarFromCounts();

  captureOverlay.classList.remove("hidden");
  captureProjectName.focus();
  captureProjectName.select();
}

function closeCaptureDialog() {
  if (captureOverlay) {
    captureOverlay.classList.add("hidden");
  }
}

function sanitizeToken(value, fallback = "project") {
  const safe = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return safe || fallback;
}

function normalizeRasterFilenamePattern(value) {
  const raw = String(value || "").trim();

  if (!raw || raw === "tile_x{X}_y{Y}.jpg") {
    return "{project}_tile_x{X}_y{Y}.jpg";
  }

  return raw;
}

function readCaptureForm() {
  const project = sanitizeToken(captureProjectName?.value, "project");

  return {
    project,
    tileStepX: numberValue(captureTileStepX?.value, settings?.raster?.tileStepX ?? DEFAULT_SETTINGS.raster.tileStepX),
    tileStepY: numberValue(captureTileStepY?.value, settings?.raster?.tileStepY ?? DEFAULT_SETTINGS.raster.tileStepY),
    farX: numberValue(captureFarX?.value, captureOriginX()),
    farY: numberValue(captureFarY?.value, captureOriginY()),
    tilesX: Math.max(1, intValue(captureTilesX?.value, settings?.raster?.tilesX ?? DEFAULT_SETTINGS.raster.tilesX)),
    tilesY: Math.max(1, intValue(captureTilesY?.value, settings?.raster?.tilesY ?? DEFAULT_SETTINGS.raster.tilesY)),
    snakeRaster: !!(captureSnakeRaster?.checked ?? settings?.raster?.snakeRaster ?? DEFAULT_SETTINGS.raster.snakeRaster),
    capturePauseSeconds: clampNumber(
      capturePauseSeconds?.value,
      0,
      3600,
      settings?.raster?.capturePauseSeconds ?? DEFAULT_SETTINGS.raster.capturePauseSeconds
    ),
    filenamePattern: normalizeRasterFilenamePattern(captureFilenamePattern?.value ?? settings?.raster?.filenamePattern),
    imageFormat: normalizeImageFormat(captureImageFormat?.value ?? settings?.camera?.snapshotFormat)
  };
}

function makeRasterFilename(pattern, project, tileX, tileY, imageIndex, imageFormat = "jpg") {
  const index = Math.max(0, intValue(imageIndex, 0));

  const replacements = {
    project,
    X: String(tileX),
    Y: String(tileY),
    x: String(tileX),
    y: String(tileY),
    col: String(tileX),
    row: String(tileY),
    n: String(index),
    index: String(index)
  };

  let name = normalizeRasterFilenamePattern(pattern).replace(
    /\{(project|X|Y|x|y|col|row|n|index)\}/g,
    (all, key) => replacements[key] ?? all
  );

  name = name.replace(/\{(n{2,})\}/g, (all, ns) => {
    return String(index).padStart(ns.length, "0");
  });

  name = sanitizeToken(name, `${project}_tile_x${tileX}_y${tileY}.${imageFormatExtension(imageFormat)}`);

  return replaceImageExtension(name, imageFormat);
}

function buildRasterPlan(captureSettings, origin) {
  const plan = [];

  for (let row = 0; row < captureSettings.tilesY; row++) {
    const cols = [];

    for (let col = 0; col < captureSettings.tilesX; col++) {
      cols.push(col);
    }

    if (captureSettings.snakeRaster && row % 2 === 1) {
      cols.reverse();
    }

    for (const col of cols) {
      plan.push({
        tileX: col,
        tileY: row,
        x: axisPositionFromOrigin(origin.x, captureSettings.farX, col, captureSettings.tileStepX),
        y: axisPositionFromOrigin(origin.y, captureSettings.farY, row, captureSettings.tileStepY)
      });
    }
  }

  return plan;
}

async function movePrinterAbsoluteXY(x, y) {
  const res = await fetch("/api/printer/move-absolute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      x,
      y,
      safeZ: safePrinterZ(),
      feedrateXY: settings.printer.feedrateXY,
      feedrateZ: settings.printer.feedrateZ,
      lineEnding: settings.printer.lineEnding
    })
  });

  const json = await res.json();

  if (!json.ok) {
    throw new Error(json.error || "Move failed");
  }

  setPrinterUi(json);
  return json.xyz;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cancellableDelay(ms) {
  const end = Date.now() + Math.max(0, Number(ms) || 0);

  while (Date.now() < end) {
    throwIfRasterStopped();
    await waitIfRasterPaused("raster delay");
    await delay(Math.min(100, end - Date.now()));
  }

  throwIfRasterStopped();
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

function clearComLogWindow() {
  if (comLog) {
    comLog.textContent = "";
  }

  if (comLogPane) {
    comLogPane.scrollTop = 0;
  }

  lastLogSeq = 0;
  logBackendDown = false;
  logPollDelayMs = LOG_POLL_MS;
}

async function clearBackendComLog() {
  clearComLogWindow();

  try {
    const res = await fetch("/api/logs/clear", {
      method: "POST",
      cache: "no-store"
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();

    if (!json.ok) {
      throw new Error(json.error || "log clear returned ok:false");
    }

    lastLogSeq = Number(json.nextSeq || 0);
  } catch (err) {
    clearComLogWindow();
    console.warn("[UI] Could not clear backend COM log buffer", err);
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

    if (logBackendDown) {
      logBackendDown = false;
      appendLogLines([{ text: "[UI] Backend log connection restored" }]);
    }

    appendLogLines(json.lines);
    lastLogSeq = Number(json.nextSeq || lastLogSeq);
    logPollDelayMs = LOG_POLL_MS;
  } catch (err) {
    if (!logBackendDown) {
      logBackendDown = true;
      appendLogLines([{
        text: `[UI] Backend log unavailable; polling slowed until server returns (${err.message})`
      }]);
    }

    logPollDelayMs = 10000;
  }
}

function scheduleNextComLogPoll() {
  if (logPollTimer) {
    clearTimeout(logPollTimer);
  }

  logPollTimer = setTimeout(async () => {
    await pollComLog();
    scheduleNextComLogPoll();
  }, logPollDelayMs);
}

function startComLogPolling() {
  restoreLogPaneHeight();
  setupLogResizer();

  if (logPollTimer) {
    clearTimeout(logPollTimer);
    logPollTimer = null;
  }

  pollComLog().finally(scheduleNextComLogPoll);
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
    snapBtn.disabled = !printerConnected;
  } catch (err) {
    console.error("[CAMERA ERROR]", err);
    snapBtn.disabled = true;
    stopCameraStream();

    cameraStatusText = "cam: offline";
    updateToolbarStatus();
    setStatus(err.name ? `${err.name}: ${err.message}` : err.message);
  }
}

function makeSnapshotName(width, height, imageFormat = settings.camera.snapshotFormat) {
  return `${settings.camera.snapshotPrefix}-${Date.now()}-${width}x${height}.${imageFormatExtension(imageFormat)}`;
}

function drawDryRunSnapshot(ctx, w, h) {
  const now = new Date().toLocaleString();
  const pos = currentPrinterXyz || { x: 0, y: 0, z: 0 };

  ctx.fillStyle = "#202020";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#505050";
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#c03030";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  ctx.fillStyle = "#f0f0f0";
  ctx.font = "28px Consolas, monospace";
  ctx.fillText("PCBsnapper DRY RUN", 32, 54);

  ctx.font = "20px Consolas, monospace";
  ctx.fillText(`simulated camera frame`, 32, 92);
  ctx.fillText(`X${Number(pos.x || 0).toFixed(0)} Y${Number(pos.y || 0).toFixed(0)} Z${Number(pos.z || 0).toFixed(0)}`, 32, 126);
  ctx.fillText(now, 32, 160);
}

function captureImageDataUrl(imageFormat = settings.camera.snapshotFormat) {
  const drySim = printerDryRun && !stream;

  if (!stream && !drySim) {
    throw new Error("Camera is not running");
  }

  const w = drySim ? 1280 : video.videoWidth;
  const h = drySim ? 720 : video.videoHeight;

  if (!w || !h) {
    throw new Error("Camera frame is not ready");
  }

  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");

  if (drySim) {
    drawDryRunSnapshot(ctx, w, h);
  } else {
    ctx.drawImage(video, 0, 0, w, h);
  }

  const format = normalizeImageFormat(imageFormat);
  const quality = clampNumber(settings.camera.jpegQuality, 0.1, 1, 0.95);
  const mimeType = imageFormatMime(format);
  const imageData = format === "jpg"
    ? canvas.toDataURL(mimeType, quality)
    : canvas.toDataURL(mimeType);

  return {
    imageData,
    width: w,
    height: h,
    format,
    simulated: drySim
  };
}

async function saveSnapshotImage(name, folder, imageFormat = settings.camera.snapshotFormat) {
  const format = normalizeImageFormat(imageFormat);
  const shot = captureImageDataUrl(format);

  const res = await fetch("/api/snapshot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      imageData: shot.imageData,
      name: replaceImageExtension(name, format),
      folder
    })
  });

  const json = await res.json();

  if (!json.ok) {
    throw new Error(json.error || "Snapshot save failed");
  }

  return json.file;
}

async function takeSnapshot() {
  if (!stream) return;

  try {
    const w = video.videoWidth;
    const h = video.videoHeight;
    const format = normalizeImageFormat(settings.camera.snapshotFormat);
    const name = makeSnapshotName(w, h, format);

    setStatus("saving snapshot...");

    const file = await saveSnapshotImage(name, settings.camera.snapshotFolder, format);
    setStatus(`saved ${file}`);
  } catch (err) {
    console.error(err);
    setStatus("snapshot error: " + err.message);
  }
}

async function startRasterCapture(event) {
  event.preventDefault();

  if (rasterRunning) return;

  try {
    await refreshPrinterStatus();

    if (!printerConnected) {
      throw new Error("Printer is not connected");
    }

    if (!stream && !printerDryRun) {
      throw new Error("Camera is not running");
    }

    const captureSettings = readCaptureForm();
    closeCaptureDialog();

    rasterRunning = true;
    rasterCancelRequested = false;
    rasterPaused = false;
    updateCaptureButtonState();
    if (snapBtn) snapBtn.disabled = true;

    const statusRes = await fetch(`/api/printer/status?${new URLSearchParams({
      lineEnding: settings.printer.lineEnding
    }).toString()}`);
    const statusJson = await statusRes.json();

    if (!statusJson.ok) {
      throw new Error(statusJson.error || "Could not read printer position");
    }

    const origin = statusJson.xyz || { x: 0, y: 0, z: safePrinterZ() };
    const plan = buildRasterPlan(captureSettings, origin);
    const total = plan.length;

    setStatus(
      `raster start: ${captureSettings.tilesX}x${captureSettings.tilesY}, ` +
      `${total} tiles, origin X${Number(origin.x || 0).toFixed(0)} ` +
      `Y${Number(origin.y || 0).toFixed(0)}`
    );

    const pauseMs = Math.max(0, Number(captureSettings.capturePauseSeconds || 0) * 1000);

    for (let i = 0; i < plan.length; i++) {
      throwIfRasterStopped();
      await waitIfRasterPaused("raster step");

      const tile = plan[i];
      const stepText = `${i + 1}/${total}`;

      if (i === 0) {
        setStatus(
          `tile ${stepText}: capturing start position ` +
          `X${tile.x.toFixed(0)} Y${tile.y.toFixed(0)}`
        );
      } else {
        setStatus(
          `tile ${stepText}: move to X${tile.x.toFixed(0)} ` +
          `Y${tile.y.toFixed(0)}`
        );

        throwIfRasterStopped();
        await waitIfRasterPaused(`tile ${stepText} before move`);
        await movePrinterAbsoluteXY(tile.x, tile.y);
        throwIfRasterStopped();

        if (pauseMs > 0) {
          setStatus(
            `tile ${stepText}: pause ${captureSettings.capturePauseSeconds}s before image...`
          );
          await cancellableDelay(pauseMs);
        }
      }

      throwIfRasterStopped();
      await waitIfRasterPaused(`tile ${stepText} before image`);

      const name = makeRasterFilename(
        captureSettings.filenamePattern,
        captureSettings.project,
        tile.tileX,
        tile.tileY,
        i,
        captureSettings.imageFormat
      );

      setStatus(`tile ${stepText}: saving ${name}...`);
      const file = await saveSnapshotImage(name, captureSettings.project, captureSettings.imageFormat);
      setStatus(`tile ${stepText}: saved ${file}`);
    }

    setStatus(`raster complete: saved ${total} tiles in ${captureSettings.project}`);
    await refreshPrinterStatus();
  } catch (err) {
    console.error(err);

    if (rasterCancelRequested || err.message === "Raster capture stopped") {
      setStatus("raster stopped by user");
    } else {
      setStatus("raster failed: " + err.message);
    }

    await refreshPrinterStatus();
  } finally {
    rasterRunning = false;
    rasterCancelRequested = false;
    rasterPaused = false;
    setToolbarControlsEnabled(printerConnected);
    updateCaptureButtonState();
  }
}

function setToolbarControlsEnabled(enabled) {
  if (homeAllBtn) homeAllBtn.disabled = !enabled;
  if (homeSafeBtn) homeSafeBtn.disabled = !enabled;
  if (jogStepSelect) jogStepSelect.disabled = !enabled;

  if (startCaptureBtn) {
    startCaptureBtn.disabled = rasterRunning
      ? rasterCancelRequested
      : !enabled;
  }

  updateCaptureButtonState();

  // Grid is a UI overlay only. It must remain available even when printer/camera are offline.
  if (gridBtn) {
    gridBtn.disabled = false;
  }

  document.querySelectorAll(".jog-btn").forEach(btn => {
    btn.disabled = !enabled;
  });

  if (snapBtn) {
    snapBtn.disabled = !enabled || (!stream && !printerDryRun);
  }
}

function setMotionButtonsEnabled(enabled) {
  setToolbarControlsEnabled(enabled);
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
  printerDryRun = dry;
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

  currentPrinterXyz = state.xyz || currentPrinterXyz;
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
    printerDryRun = false;
    printerStatus.dataset.baseText = "printer: unknown";
    updateToolbarStatus();
    connectPrinterBtn.textContent = "Connect";
    connectPrinterBtn.disabled = false;
    setMotionButtonsEnabled(false);
  }
}

async function connectPrinter() {
  try {
    await clearBackendComLog();

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
    await pollComLog();
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

    setStatus(`Safe: moving to X${Number(settings.printer.safeX || 0).toFixed(2)} Y${Number(settings.printer.safeY || 0).toFixed(2)} Z${safeZ.toFixed(2)}...`);

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
if (startCaptureBtn) {
  startCaptureBtn.addEventListener("click", () => {
    if (rasterRunning) {
      requestStopRasterCapture();
      return;
    }

    if (startCaptureBtn.disabled || !printerConnected) {
      return;
    }

    openCaptureDialog().catch(err => {
      console.error(err);
      setStatus("capture dialog failed: " + err.message);
    });
  });
}

if (pauseCaptureBtn) {
  pauseCaptureBtn.addEventListener("click", toggleRasterPause);
}
if (captureCloseBtn) captureCloseBtn.addEventListener("click", closeCaptureDialog);
if (captureCancelBtn) captureCancelBtn.addEventListener("click", closeCaptureDialog);
if (captureForm) captureForm.addEventListener("submit", startRasterCapture);
if (captureFarX) captureFarX.addEventListener("input", updateCaptureCountsFromFar);
if (captureFarY) captureFarY.addEventListener("input", updateCaptureCountsFromFar);
if (captureTilesX) captureTilesX.addEventListener("input", updateCaptureFarFromCounts);
if (captureTilesY) captureTilesY.addEventListener("input", updateCaptureFarFromCounts);
if (captureTileStepX) captureTileStepX.addEventListener("input", updateCaptureFarFromCounts);
if (captureTileStepY) captureTileStepY.addEventListener("input", updateCaptureFarFromCounts);
if (captureImageFormat) {
  captureImageFormat.addEventListener("change", () => {
    if (captureFilenamePattern) {
      captureFilenamePattern.value = replaceImageExtension(
        captureFilenamePattern.value || "{project}_tile_x{X}_y{Y}.jpg",
        captureImageFormat.value
      );
    }
  });
}

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

if (captureOverlay) {
  captureOverlay.addEventListener("click", event => {
    if (event.target === captureOverlay && !rasterRunning) {
      closeCaptureDialog();
    }
  });
}

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