import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import Pitchfinder from "pitchfinder";
import { type Resource, type WordHit } from "../api";
import {
  IconPitch,
  IconRegions,
  IconAutoscroll,
  IconPlus,
  IconMinus,
} from "./Icon";

const { YIN } = Pitchfinder;

type PitchPoint = { t: number; f: number | null };

// Layout constants for the audio visualization panel.
const MIN_WAVE_H = 48;
const MAX_WAVE_H = 400;
const DEFAULT_WAVE_H = 120;
const MIN_PPS = 20; // minimum pixels-per-second (most zoomed out)
const MAX_PPS = 600; // maximum pixels-per-second (most zoomed in)
const DEFAULT_PPS = 180; // default zoom (px per second)

export default function WaveformPlayer({
  resource,
  mediaRef,
  onTimeUpdate,
  onReady,
  autoscroll,
  onToggleAutoscroll,
}: {
  resource: Resource;
  mediaRef: React.RefObject<HTMLMediaElement>;
  onTimeUpdate?: (currentTime: number, idx: number) => void;
  onReady?: (ws: WaveSurfer) => void;
  autoscroll: boolean;
  onToggleAutoscroll?: () => void;
}) {
  const waveMountRef = useRef<HTMLDivElement>(null);
  const pitchRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<any>(null);
  const dragCleanupRef = useRef<null | (() => void)>(null);
  const lastIdx = useRef(-1);

  const [ready, setReady] = useState(false);
  const [showPitch, setShowPitch] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [pitch, setPitch] = useState<PitchPoint[]>([]);
  const [pitchStatus, setPitchStatus] = useState("");
  const [pps, setPps] = useState(DEFAULT_PPS); // pixels per second (zoom)
  const [waveH, setWaveH] = useState(() => {
    const raw = localStorage.getItem("lingo-wave-h");
    const n = raw ? Number(raw) : DEFAULT_WAVE_H;
    return n >= MIN_WAVE_H && n <= MAX_WAVE_H ? n : DEFAULT_WAVE_H;
  });
  const [duration, setDuration] = useState(0);

  const words: WordHit[] =
    typeof resource.words === "string"
      ? JSON.parse(resource.words || "[]")
      : resource.words || [];

  const totalW = Math.max(1, Math.round((duration || 1) * pps));

  // Build the wavesurfer instance + decode the audio once per resource.
  useEffect(() => {
    if (!waveMountRef.current || !mediaRef.current) return;
    lastIdx.current = -1;
    setReady(false);
    setPitch([]);
    setPitchStatus("");

    const ws = WaveSurfer.create({
      container: waveMountRef.current,
      media: mediaRef.current,
      height: waveH,
      waveColor: "#9aa0a6",
      progressColor: "hsl(var(--primary))",
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      cursorWidth: 1,
      normalize: true,
      fillParent: true,
    });
    wsRef.current = ws;

    const regions = ws.registerPlugin(RegionsPlugin.create());
    regionsRef.current = regions;

    // Keep the horizontal playhead in view as the media plays.
    const followPlayhead = (t: number) => {
      const sc = scrollRef.current;
      const w = wsRef.current;
      if (!sc || !w) return;
      if (!w.isPlaying()) return;
      const dur = w.getDuration() || 1;
      const total = sc.scrollWidth || 1;
      const x = (t / dur) * total;
      const view = sc.clientWidth;
      if (total <= view) return;
      const margin = 60;
      let target = sc.scrollLeft;
      if (x < sc.scrollLeft + margin) target = Math.max(0, x - margin);
      else if (x > sc.scrollLeft + view - margin)
        target = Math.min(total - view, x - view + margin);
      if (target !== sc.scrollLeft) sc.scrollLeft = target;
    };

    ws.on("timeupdate", (t: number) => {
      const idx =
        words.length > 0
          ? words.findIndex((w) => t >= w.start && t < w.end)
          : -1;
      if (idx !== lastIdx.current) {
        lastIdx.current = idx;
        onTimeUpdate?.(t, idx);
      }
      followPlayhead(t);
    });

    // Higher-frequency tick for smoother follow.
    ws.on("audioprocess", (t: number) => followPlayhead(t));

    ws.on("ready", () => {
      setReady(true);
      setDuration(ws.getDuration() || 0);
      // Word-sync regions (read-only) for click-to-seek + highlight.
      words.forEach((w, i) =>
        regions.addRegion({
          id: "w" + i,
          start: w.start,
          end: w.end,
          color: "rgba(0,122,255,0.10)",
          drag: false,
          resize: false,
        })
      );
      setPitchStatus("Computing pitch…");
      // Defer the DSP so the UI can paint first.
      setTimeout(() => {
        computePitch(ws);
        setPitchStatus("");
        drawPitch();
      }, 0);
      onReady?.(ws);
    });

    ws.on("error", (e: any) => console.error("wavesurfer error", e));

    return () => {
      if (dragCleanupRef.current) {
        dragCleanupRef.current();
        dragCleanupRef.current = null;
      }
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id]);

  function computePitch(ws: WaveSurfer) {
    try {
      const buf = ws.getDecodedData();
      if (!buf) {
        setPitchStatus("Pitch unavailable");
        return;
      }
      const detect = YIN({ threshold: 0.12 });
      const data = buf.getChannelData(0);
      const sr = buf.sampleRate;
      const frame = 1024;
      const hop = 256;
      const out: PitchPoint[] = [];
      for (let i = 0; i + frame < data.length; i += hop) {
        const f = detect(data.subarray(i, i + frame));
        out.push({ t: i / sr, f: f && f >= 50 && f <= 2000 ? f : null });
      }
      setPitch(out);
    } catch (e: any) {
      setPitchStatus("Pitch failed: " + e.message);
    }
  }

  // Draw the F0 (pitch) contour directly ON the waveform, fused into the same
  // surface. Higher pitch sits higher; the line is drawn in red.
  function drawPitch() {
    const c = pitchRef.current;
    const ws = wsRef.current;
    if (!c) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!pitch.length || !showPitch) return;
    const dur = ws ? ws.getDuration() || 1 : 1;
    const minF = 70;
    const maxF = 1200;
    const yOf = (f: number) =>
      h - ((Math.log2(f) - Math.log2(minF)) / (Math.log2(maxF) - Math.log2(minF))) * h;
    ctx.beginPath();
    let started = false;
    for (const p of pitch) {
      const x = (p.t / dur) * w;
      if (p.f == null) {
        started = false;
        continue;
      }
      const y = yOf(p.f);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = "#ff3b30"; // red F0 contour
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 3;
    ctx.stroke();
  }

  // Redraw the pitch overlay when zoom / height / data / visibility changes,
  // and keep it crisp on container resize.
  useEffect(() => {
    drawPitch();
    const ro = new ResizeObserver(() => drawPitch());
    if (waveMountRef.current) ro.observe(waveMountRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pitch, showPitch, pps, waveH, ready]);

  // Toggle drag-to-create regions.
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions) return;
    if (editMode) {
      if (!dragCleanupRef.current) {
        dragCleanupRef.current = regions.enableDragSelection({
          color: "rgba(0,122,255,0.12)",
        });
      }
    } else if (dragCleanupRef.current) {
      dragCleanupRef.current();
      dragCleanupRef.current = null;
    }
  }, [editMode]);

  // Double-click a user region to delete it.
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions) return;
    const onDbl = (region: any) => {
      if (editMode && !String(region.id).startsWith("w")) region.remove();
    };
    regions.on("region-double-clicked", onDbl);
    return () => regions.un("region-double-clicked", onDbl);
  }, [editMode]);

  // Drag to resize the WAVEFORM height.
  function startHeightDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = waveH;
    function onMove(ev: MouseEvent) {
      const next = Math.max(
        MIN_WAVE_H,
        Math.min(MAX_WAVE_H, startH + (ev.clientY - startY))
      );
      setWaveH(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      localStorage.setItem("lingo-wave-h", String(waveH));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  useEffect(() => {
    localStorage.setItem("lingo-wave-h", String(waveH));
  }, [waveH]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        {/* Zoom controls (shared by waveform + pitch overlay) */}
        <div className="flex items-center gap-1 border rounded-md overflow-hidden">
          <button
            className="px-2 py-1 hover:bg-accent inline-flex items-center"
            onClick={() => setPps((z) => Math.max(MIN_PPS, z - 20))}
            title="Zoom out"
          >
            <IconMinus size={14} />
          </button>
          <span className="px-2 text-muted-foreground tabular-nums">{pps}px/s</span>
          <button
            className="px-2 py-1 hover:bg-accent inline-flex items-center"
            onClick={() => setPps((z) => Math.min(MAX_PPS, z + 20))}
            title="Zoom in"
          >
            <IconPlus size={14} />
          </button>
        </div>

        <button
          className={`btn ${autoscroll ? "btn-primary" : "btn-secondary"} px-2 py-1 inline-flex items-center gap-1`}
          onClick={onToggleAutoscroll}
          title="Auto-scroll transcript to the active word"
        >
          <IconAutoscroll size={14} /> Auto
        </button>

        <button
          className={`btn ${showPitch ? "btn-primary" : "btn-secondary"} px-2 py-1 inline-flex items-center gap-1`}
          onClick={() => setShowPitch((v) => !v)}
          title="Toggle the red F0 (pitch) contour fused on the waveform"
        >
          <IconPitch size={14} /> Pitch
        </button>

        <button
          className={`btn ${editMode ? "btn-primary" : "btn-secondary"} px-2 py-1 inline-flex items-center gap-1`}
          onClick={() => setEditMode((v) => !v)}
          title="Drag on waveform to create a region; double-click to delete"
        >
          <IconRegions size={14} /> Regions
        </button>

        <span className="text-muted-foreground tabular-nums ml-auto">
          {ready ? `${duration.toFixed(1)}s` : "loading…"}
        </span>
        {pitchStatus && <span className="text-muted-foreground">{pitchStatus}</span>}
      </div>

      {/* Audio visualization: the red F0 contour is fused directly onto the
          waveform. Both share the same px-per-second zoom and scroll together. */}
      <div className="rounded-lg border overflow-hidden bg-secondary">
        <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden">
          <div style={{ width: totalW, position: "relative" }}>
            <div
              ref={waveMountRef}
              style={{ width: totalW, height: waveH, background: "hsl(var(--secondary))" }}
            />
            <canvas
              ref={pitchRef}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: totalW,
                height: waveH,
                pointerEvents: "none",
              }}
            />
          </div>
        </div>
        {/* Drag handle to manually resize the waveform height */}
        <div
          className="resize-handle"
          onMouseDown={startHeightDrag}
          title="Drag to resize the waveform height"
        />
      </div>

      {!ready && <div className="text-xs text-muted-foreground">Loading waveform…</div>}
    </div>
  );
}
