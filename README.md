# PCBsnapper

> Turning a consumer 3D printer into a precision PCB imaging and raster scanning platform.

---

# Overview

PCBsnapper is a Node.js-based PCB imaging and raster capture system that transforms a standard Cartesian FDM 3D printer into a high-resolution automated XY scanning platform.

The system combines:

- A USB microscope camera
- A 3D printer motion system
- A browser-based control UI
- A Node.js backend motion server
- Automated raster image capture
- Tile stitching workflows using Fiji / ImageJ

The goal is to create ultra-high-resolution stitched images of PCBs, arcade boards, electronics assemblies, and other flat objects.

Unlike traditional flatbed scanners, PCBsnapper can:

- Capture extremely large boards
- Use adjustable optics and working distance
- Scale to arbitrary image sizes
- Capture at microscope-level detail
- Operate with configurable overlap and raster patterns
- Work with consumer-grade hardware

---

# Placeholder Images

Create an `images/` folder in the repository and add screenshots/photos using filenames like:

```text
/images/pcbsnapper-main-ui.png
/images/pcbsnapper-grid-overlay.png
/images/pcbsnapper-raster-dialog.png
/images/pcbsnapper-camera-mount.jpg
/images/pcbsnapper-printer.jpg
/images/pcbsnapper-hy6110.jpg
/images/pcbsnapper-snake-raster.png
/images/pcbsnapper-fiji-stitch.png
/images/pcbsnapper-example-board.jpg
```

---

# Hardware Platform

## 3D Printer Motion System

Current development targets the:

- Sovol SV01 Pro
- Marlin firmware
- USB serial G-code control

The printer acts as a programmable XY camera positioning system rather than an extrusion platform.

---

# Camera System

## HAYEAR HY-6110

Features include:

- Sony IMX334 sensor
- 4K HDMI output
- USB Type-C interface
- 3840×2160 @ 30 FPS
- Simultaneous HDMI + USB output
- Long working distance microscope optics

---

# Raster Capture

Raster capture works like this:

1. Move camera to X/Y position
2. Wait for vibration settling
3. Capture image
4. Move to next tile
5. Repeat until complete

This produces overlapping image tiles which can later be stitched together.

---

# Snake Raster

PCBsnapper supports snake raster scanning.

Example:

```text
→ → →
← ← ←
→ → →
```

This reduces unnecessary long-axis travel.

---

# Fiji / ImageJ Stitching

Download Fiji:

https://imagej.net/software/fiji/downloads

## Stitching Steps

1. Open:
   Plugins → Stitching → Grid/Collection stitching

2. Select:
   Grid: snake by rows

3. Configure:
   - Grid size X/Y
   - Tile overlap
   - Tile directory
   - Filename pattern

4. Enable:
   Compute overlap

5. Generate stitched mosaic

---

# Development Stack

Frontend:
- HTML5
- CSS3
- Vanilla JavaScript

Backend:
- Node.js
- Express
- serialport

Motion:
- Marlin G-code

Camera:
- Browser MediaDevices API
