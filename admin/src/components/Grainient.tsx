"use client";

import { useEffect, useRef } from "react";

type GrainientProps = {
  color1?: string;
  color2?: string;
  color3?: string;
  timeSpeed?: number;
  blendSoftness?: number;
  grainAmount?: number;
  grainAnimated?: boolean;
  saturation?: number;
  contrast?: number;
  className?: string;
};

export default function Grainient({
  color1 = "#121212",
  color2 = "#0f2040",
  color3 = "#000000",
  timeSpeed = 0.25,
  blendSoftness = 0.05,
  grainAmount = 0.12,
  grainAnimated = true,
  saturation = 1,
  contrast = 1.1,
  className,
}: GrainientProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const clamp255 = (value: number) => Math.max(0, Math.min(255, value));
    const parseHex = (hex: string) => {
      const normalized = hex.replace("#", "");
      const source = normalized.length === 3
        ? normalized.split("").map((c) => `${c}${c}`).join("")
        : normalized;
      return {
        r: Number.parseInt(source.slice(0, 2), 16),
        g: Number.parseInt(source.slice(2, 4), 16),
        b: Number.parseInt(source.slice(4, 6), 16),
      };
    };

    const c1 = parseHex(color1);
    const c2 = parseHex(color2);
    const c3 = parseHex(color3);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let time = 0;

    const resize = () => {
      const bounds = container.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(bounds.width * dpr));
      canvas.height = Math.max(1, Math.floor(bounds.height * dpr));
      canvas.style.width = `${bounds.width}px`;
      canvas.style.height = `${bounds.height}px`;
    };

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      const angle = time * 0.2;
      const cx = w * 0.5;
      const cy = h * 0.5;
      const radius = Math.hypot(w, h) * (0.45 + blendSoftness);

      const x1 = cx + Math.cos(angle) * radius;
      const y1 = cy + Math.sin(angle) * radius;
      const x2 = cx + Math.cos(angle + Math.PI * 0.75) * radius;
      const y2 = cy + Math.sin(angle + Math.PI * 0.75) * radius;
      const x3 = cx + Math.cos(angle + Math.PI * 1.5) * radius;
      const y3 = cy + Math.sin(angle + Math.PI * 1.5) * radius;

      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(w, h));
      g.addColorStop(0, `rgba(${c1.r}, ${c1.g}, ${c1.b}, 1)`);
      g.addColorStop(0.45, `rgba(${c2.r}, ${c2.g}, ${c2.b}, 0.92)`);
      g.addColorStop(1, `rgba(${c3.r}, ${c3.g}, ${c3.b}, 1)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      const spots = [
        { x: x1, y: y1, c: c1 },
        { x: x2, y: y2, c: c2 },
        { x: x3, y: y3, c: c3 },
      ];
      for (const spot of spots) {
        const glow = ctx.createRadialGradient(spot.x, spot.y, 0, spot.x, spot.y, radius * 0.9);
        glow.addColorStop(0, `rgba(${spot.c.r}, ${spot.c.g}, ${spot.c.b}, 0.45)`);
        glow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
      }

      const image = ctx.getImageData(0, 0, w, h);
      const data = image.data;
      for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * 255 * grainAmount;
        data[i] = clamp255((data[i] - 128) * contrast + 128 + noise);
        data[i + 1] = clamp255((data[i + 1] - 128) * contrast + 128 + noise);
        data[i + 2] = clamp255((data[i + 2] - 128) * contrast + 128 + noise);

        const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
        data[i] = clamp255(gray + (data[i] - gray) * saturation);
        data[i + 1] = clamp255(gray + (data[i + 1] - gray) * saturation);
        data[i + 2] = clamp255(gray + (data[i + 2] - gray) * saturation);
      }
      ctx.putImageData(image, 0, 0);
    };

    const render = () => {
      time += timeSpeed * 0.01;
      draw();
      if (grainAnimated) {
        raf = window.requestAnimationFrame(render);
      }
    };

    resize();
    draw();
    if (grainAnimated) {
      raf = window.requestAnimationFrame(render);
    }

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    window.addEventListener("resize", resize);

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [blendSoftness, color1, color2, color3, contrast, grainAmount, grainAnimated, saturation, timeSpeed]);

  return (
    <div ref={containerRef} className={className}>
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}

