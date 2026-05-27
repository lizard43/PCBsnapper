import express from "express";
import fs from "fs";
import path from "path";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";

const app = express();
const PORT = 3000;

const BASE_SNAPSHOT_DIR = path.resolve("snapshots");
fs.mkdirSync(BASE_SNAPSHOT_DIR, { recursive: true });

let printerPort = null;
let printerParser = null;
let printerConnected = false;
let dryRun = false;
let printerInfo = null;
let needsHome = false;
let commandQueue = Promise.resolve();


// =========================
// UI COM log buffer
// =========================

const MAX_LOG_LINES = 2000;

let logSeq = 0;
const logLines = [];

const rawConsoleLog = console.log.bind(console);
const rawConsoleWarn = console.warn.bind(console);
const rawConsoleError = console.error.bind(console);

function formatLogArg(value) {
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pushUiLog(text) {
  const line = {
    seq: ++logSeq,
    text: String(text)
  };

  logLines.push(line);

  if (logLines.length > MAX_LOG_LINES) {
    logLines.splice(0, logLines.length - MAX_LOG_LINES);
  }
}

function addLog(...args) {
  const text = args.map(formatLogArg).join(" ");
  pushUiLog(text);
  rawConsoleLog(text);
}

console.log = (...args) => {
  const text = args.map(formatLogArg).join(" ");
  pushUiLog(text);
  rawConsoleLog(...args);
};

console.warn = (...args) => {
  const text = args.map(formatLogArg).join(" ");
  pushUiLog(`[WARN] ${text}`);
  rawConsoleWarn(...args);
};

console.error = (...args) => {
  const text = args.map(formatLogArg).join(" ");
  pushUiLog(`[ERROR] ${text}`);
  rawConsoleError(...args);
};

app.get("/api/logs", (req, res) => {
  const since = Number(req.query.since || 0);
  const lines = logLines.filter(line => line.seq > since);

  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    lines,
    nextSeq: logSeq
  });
});

// This is only the last position reported by the printer via M114.
// Do not update this from browser math or from commanded target positions.
let xyz = { x: 0, y: 0, z: 0 };

app.use(express.json({ limit: "100mb" }));
app.use(express.static("public"));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizePathPart(value, fallback = "") {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .map(part => part.replace(/[^\w.-]/g, "_"))
    .filter(Boolean)
    .join("/") || fallback;
}

function decodeLineEnding(value) {
  if (value === "\\r\\n") return "\r\n";
  return "\n";
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeZOr(value, fallback = 100) {
  return Math.max(0, numberOr(value, fallback));
}

function parseM114(text) {
  const match = String(text || "").match(/X:([-\d.]+)\s+Y:([-\d.]+)\s+Z:([-\d.]+)/i);
  if (!match) return null;

  return {
    x: Number(match[1]),
    y: Number(match[2]),
    z: Number(match[3])
  };
}

function updateXYZFromText(text) {
  const pos = parseM114(text);

  if (pos) {
    xyz = pos;
  }

  return pos;
}

async function runQueued(fn) {
  const run = commandQueue.then(fn, fn);
  commandQueue = run.catch(() => { });
  return run;
}

function sendLineRaw(line, lineEnding = "\n", timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (dryRun) {
      addLog(`[DRY RUN] ${line}`);
      return resolve("ok");
    }

    if (!printerPort || !printerConnected) {
      return reject(new Error("Printer is not connected"));
    }

    const lines = [];
    let done = false;

    const cleanup = () => {
      printerParser?.off("data", onData);
      clearTimeout(timer);
    };

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(lines.join("\n"));
    };

    const fail = err => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Timeout waiting for ok: ${line}`));
    }, timeoutMs);

    const onData = data => {
      const text = String(data).trim();
      if (!text) return;

      addLog(`[PRINTER] ${text}`);
      lines.push(text);
      updateXYZFromText(text);

      // Wait for command-complete ok. For M114 this collects both the X/Y/Z line
      // and the following ok instead of resolving early.
      if (text.toLowerCase().startsWith("ok")) {
        finish();
      }
    };

    printerParser.on("data", onData);

    addLog(`[SEND] ${line}`);

    printerPort.write(line + decodeLineEnding(lineEnding), err => {
      if (err) fail(err);
    });
  });
}

function sendLine(line, lineEnding = "\n", timeoutMs = 15000) {
  return runQueued(() => sendLineRaw(line, lineEnding, timeoutMs));
}

async function waitForMoves(lineEnding = "\n") {
  await sendLine("M400", lineEnding, 120000);
}

async function queryPosition(lineEnding = "\n", timeoutMs = 15000) {
  if (dryRun) {
    return xyz;
  }

  const text = await sendLine("M114", lineEnding, timeoutMs);
  const pos = updateXYZFromText(text);

  if (!pos) {
    throw new Error("M114 did not return a usable X/Y/Z position");
  }

  return pos;
}

async function moveAbsolute(target, lineEnding = "\n") {
  const parts = ["G1"];

  if (target.x !== undefined) parts.push(`X${Number(target.x).toFixed(3)}`);
  if (target.y !== undefined) parts.push(`Y${Number(target.y).toFixed(3)}`);
  if (target.z !== undefined) parts.push(`Z${Number(target.z).toFixed(3)}`);
  if (target.feed !== undefined) parts.push(`F${Number(target.feed)}`);

  await sendLine("G90", lineEnding);
  await sendLine(parts.join(" "), lineEnding);

  if (dryRun) {
    if (target.x !== undefined) xyz.x = Number(target.x);
    if (target.y !== undefined) xyz.y = Number(target.y);
    if (target.z !== undefined) xyz.z = Number(target.z);
    return xyz;
  }

  return await queryPosition(lineEnding);
}

async function raiseToSafeZ(safeZ, feedrateZ, lineEnding = "\n") {
  const current = await queryPosition(lineEnding);
  const z = safeZOr(safeZ);

  if (current.z >= z) {
    return current;
  }

  return await moveAbsolute({
    z,
    feed: numberOr(feedrateZ, 300)
  }, lineEnding);
}

async function moveRelative(axis, distance, feed, lineEnding = "\n") {
  await sendLine("G91", lineEnding);
  await sendLine(`G1 ${axis}${Number(distance).toFixed(3)} F${Number(feed)}`, lineEnding);
  await sendLine("G90", lineEnding);

  if (dryRun) {
    xyz[axis.toLowerCase()] += Number(distance);
    return xyz;
  }

  return await queryPosition(lineEnding);
}

function makePrinterState(extra = {}) {
  return {
    ok: true,
    connected: printerConnected,
    dryRun,
    xyz,
    needsHome,
    printerInfo,
    ...extra
  };
}

app.post("/api/printer/connect", async (req, res) => {
  try {
    const { comPort, baudRate, lineEnding, dryRunMode } = req.body;

    dryRun = !!dryRunMode;

    if (dryRun) {
      printerConnected = true;
      printerInfo = {
        comPort: comPort || "dry-run",
        baudRate: Number(baudRate || 115200)
      };
      needsHome = false;

      return res.json(makePrinterState());
    }

    if (printerPort?.isOpen) {
      await new Promise(resolve => printerPort.close(() => resolve()));
    }

    printerPort = null;
    printerParser = null;
    printerConnected = false;
    printerInfo = null;
    needsHome = false;
    commandQueue = Promise.resolve();

    printerPort = new SerialPort({
      path: comPort,
      baudRate: Number(baudRate || 115200),
      autoOpen: false
    });

    await new Promise((resolve, reject) => {
      printerPort.open(err => err ? reject(err) : resolve());
    });

    printerParser = printerPort.pipe(
      new ReadlineParser({ delimiter: "\n" })
    );

    printerParser.on("data", data => {
      const text = String(data).trim();

      if (text.length) {
        addLog(`[PRINTER RAW] ${text}`);
      }
    });

    printerConnected = true;
    printerInfo = {
      comPort,
      baudRate: Number(baudRate || 115200)
    };

    addLog("[INFO] Serial opened");
    addLog("[INFO] Waiting for printer boot/reset...");

    // Most Marlin USB serial boards reset on port open.
    needsHome = true;
    await sleep(5000);

    addLog("[INFO] Sending initialization commands");

    await sendLine("G90", lineEnding);

    const pos = await queryPosition(lineEnding)
      .catch(err => {
        addLog(`[WARN] M114 failed: ${err.message}`);
        return null;
      });

    addLog("[INFO] Printer ready");

    res.json(makePrinterState({
      position: pos,
      warning: needsHome
        ? "Printer reset on serial open. Use Safe before X/Y motion if a camera/lens is installed."
        : null
    }));

  } catch (err) {
    console.error("[CONNECT ERROR]", err);

    printerConnected = false;
    printerInfo = null;
    needsHome = false;

    res.status(500).json({
      ok: false,
      error: err.message,
      connected: false,
      dryRun,
      xyz,
      needsHome,
      printerInfo
    });
  }
});

app.post("/api/printer/disconnect", async (req, res) => {
  try {
    if (printerPort?.isOpen) {
      await new Promise(resolve => printerPort.close(() => resolve()));
    }

    printerPort = null;
    printerParser = null;
    printerConnected = false;
    dryRun = false;
    printerInfo = null;
    needsHome = false;
    commandQueue = Promise.resolve();

    res.json(makePrinterState());

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
      connected: printerConnected,
      dryRun,
      xyz,
      needsHome,
      printerInfo
    });
  }
});

app.get("/api/printer/status", async (req, res) => {
  try {
    if (printerConnected && !dryRun) {
      await queryPosition(req.query.lineEnding || "\n").catch(err => {
        addLog(`[WARN] status M114 failed: ${err.message}`);
      });
    }

    res.json(makePrinterState());
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
      connected: printerConnected,
      dryRun,
      xyz,
      needsHome,
      printerInfo
    });
  }
});

app.post("/api/printer/jog", async (req, res) => {
  try {
    const {
      axis,
      distance,
      safeZ,
      feedrateXY,
      feedrateZ,
      lineEnding
    } = req.body;

    const ax = String(axis || "").toUpperCase();
    const dist = Number(distance || 0);

    if (!["X", "Y", "Z"].includes(ax)) {
      return res.status(400).json({
        ...makePrinterState(),
        ok: false,
        error: "Bad axis"
      });
    }

    if (!Number.isFinite(dist) || dist === 0) {
      return res.status(400).json({
        ...makePrinterState(),
        ok: false,
        error: "Bad distance"
      });
    }

    const current = await queryPosition(lineEnding);

    if ((ax === "X" || ax === "Y") && current[ax.toLowerCase()] + dist < 0) {
      return res.status(400).json({
        ...makePrinterState(),
        ok: false,
        error: `${ax} move blocked: printer reports it would go below 0`
      });
    }

    const feed =
      ax === "Z"
        ? numberOr(feedrateZ, 300)
        : numberOr(feedrateXY, 3000);

    if ((ax === "X" || ax === "Y") && needsHome) {
      return res.status(409).json({
        ...makePrinterState(),
        ok: false,
        error: "Printer reset since last Safe/Home. Press Safe before X/Y jogging."
      });
    }

    if (ax === "X" || ax === "Y") {
      await raiseToSafeZ(safeZ, feedrateZ, lineEnding);
    }

    const pos = await moveRelative(ax, dist, feed, lineEnding);

    res.json(makePrinterState({ xyz: pos }));

  } catch (err) {
    res.status(500).json({
      ...makePrinterState(),
      ok: false,
      error: err.message
    });
  }
});

// Full printer home. This sends real G28 with no axis arguments.
// WARNING: with a long camera/lens installed, this can drive Z toward bed/home.
app.post("/api/printer/home-all", async (req, res) => {
  try {
    const { lineEnding } = req.body;

    await sendLine("G90", lineEnding);
    await sendLine("G28", lineEnding, 120000);

    if (dryRun) {
      xyz = { x: 0, y: 0, z: 0 };
    }

    const pos = await queryPosition(lineEnding, 30000);
    needsHome = false;

    res.json(makePrinterState({ xyz: pos }));

  } catch (err) {
    res.status(500).json({
      ...makePrinterState(),
      ok: false,
      error: err.message
    });
  }
});

// Camera-safe home. This never homes Z and never commands Z downward.
// It declares the current physical Z as settings.safeZ, then homes X/Y only.
app.post("/api/printer/home-safe", async (req, res) => {
  try {
    const {
      safeX,
      safeY,
      safeZ,
      feedrateXY,
      feedrateZ,
      lineEnding
    } = req.body;

    const z = safeZOr(safeZ);
    const feedZ = numberOr(feedrateZ, 300);
    const feedXY = numberOr(feedrateXY, 3000);

    await sendLine("G90", lineEnding);

    await sendLine(`G1 Z${z.toFixed(3)} F${feedZ}`, lineEnding, 120000);
    await waitForMoves(lineEnding);

    await sendLine(
      `G1 X${Number(safeX || 0).toFixed(3)} ` +
      `Y${Number(safeY || 0).toFixed(3)} ` +
      `F${feedXY}`,
      lineEnding,
      120000
    );

    await waitForMoves(lineEnding);

    const pos = await queryPosition(lineEnding, 30000);
    needsHome = false;

    res.json(makePrinterState({ xyz: pos }));

  } catch (err) {
    res.status(500).json({
      ...makePrinterState(),
      ok: false,
      error: err.message
    });
  }
});

// Backward compatible route for older app.js versions. Same behavior as Safe.
app.post("/api/printer/home", async (req, res) => {
  try {
    const {
      safeZ,
      lineEnding
    } = req.body;

    const z = safeZOr(safeZ);

    await sendLine("G90", lineEnding);
    await sendLine(`G92 Z${z.toFixed(3)}`, lineEnding);
    await sendLine("G28 X Y", lineEnding, 120000);

    if (dryRun) {
      xyz = { x: 0, y: 0, z };
    }

    const pos = await queryPosition(lineEnding, 30000);
    needsHome = false;

    res.json(makePrinterState({ xyz: pos }));

  } catch (err) {
    res.status(500).json({
      ...makePrinterState(),
      ok: false,
      error: err.message
    });
  }
});

app.post("/api/snapshot", (req, res) => {
  try {
    const { imageData, name, folder } = req.body;

    if (
      !imageData ||
      !imageData.startsWith("data:image/jpeg;base64,")
    ) {
      return res.status(400).json({
        ok: false,
        error: "Expected JPEG data URL"
      });
    }

    const fallbackName =
      `snap-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;

    const safeFolder = sanitizePathPart(folder, "");
    const safeName = sanitizePathPart(name || fallbackName, fallbackName);

    const targetDir = path.join(BASE_SNAPSHOT_DIR, safeFolder);

    fs.mkdirSync(targetDir, { recursive: true });

    const filepath = path.join(targetDir, safeName);

    const base64 = imageData.replace(
      /^data:image\/jpeg;base64,/,
      ""
    );

    fs.writeFileSync(
      filepath,
      Buffer.from(base64, "base64")
    );

    addLog(`[SNAPSHOT] ${filepath}`);

    res.json({
      ok: true,
      file: safeFolder
        ? `${safeFolder}/${safeName}`
        : safeName
    });

  } catch (err) {
    console.error("[SNAPSHOT ERROR]", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  addLog(`PCBsnapper running at http://localhost:${PORT}`);
});
