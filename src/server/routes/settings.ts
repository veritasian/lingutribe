import express from "express";
import fs from "fs";
import { getLibraryPath, typeDir, ttsDir } from "../db.js";

interface SettingsCtx {
  readSettings: () => any;
  writeSettings: (s: any) => any;
  dirSize: (dir: string) => number;
}

export function registerSettingsRoutes(app: express.Express, ctx: SettingsCtx) {
  const { readSettings, writeSettings, dirSize } = ctx;
app.get("/api/settings", (_req, res) => res.json(readSettings()));
app.put("/api/settings", (req, res) => {
  const cur = readSettings();
  const next = { ...cur, ...req.body };
  res.json(writeSettings(next));
});

app.get("/api/disk", (_req, res) => {
  const lib = getLibraryPath();
  const stat = fs.statfsSync(lib);
  const totalBytes = stat.blocks * stat.bsize;
  const freeBytes = stat.bavail * stat.bsize;
  const usedBytes = totalBytes - freeBytes;
  const resourcesBytes =
    dirSize(typeDir("audio")) + dirSize(typeDir("video")) + dirSize(typeDir("read")) + dirSize(ttsDir());
  res.json({
    libraryPath: lib,
    totalBytes,
    usedBytes,
    freeBytes,
    resourcesBytes,
  });
});
}
