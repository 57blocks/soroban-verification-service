import { useEffect, useRef } from "react";

const ACCENT_RGB = "245, 211, 90";

interface Tone {
  spacing: number;
  radius: number;
  alpha: number;
  reach: number;
  push: number;
  surge: number;
  spread: number;
}

const DARK: Tone = { spacing: 13, radius: 2.2, alpha: 0.28, reach: 200, push: 18, surge: 55, spread: 300 };
const LIGHT: Tone = { spacing: 13, radius: 2.6, alpha: 0.42, reach: 200, push: 18, surge: 55, spread: 300 };

const ALPHA_LEVELS = 50;
const SPRING = 0.08;
const DAMPING = 0.82;
const SETTLED = 0.05;
const SPREAD_FLOOR = Math.exp(-3);
const ENERGY_PER_PX = 1 / 140;
const ENERGY_DECAY = 0.96;

export interface DotLatticeProps {
  fadeStart?: number;
  fadeEnd?: number;
}

const DotLattice = ({ tone, fadeStart = 0, fadeEnd = 0 }: DotLatticeProps & { tone: Tone }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!container || !canvas || !ctx) return;

    const still =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let homeX = new Float32Array(0);
    let homeY = new Float32Array(0);
    let offX = new Float32Array(0);
    let offY = new Float32Array(0);
    let velX = new Float32Array(0);
    let velY = new Float32Array(0);
    let pointer: { x: number; y: number } | null = null;
    let energy = 0;
    let visible = true;
    let frame = 0;

    const fadeAt = (y: number) =>
      fadeEnd > fadeStart ? Math.min(1, Math.max(0, (fadeEnd - y) / (fadeEnd - fadeStart))) : 1;

    const layout = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const lastRow = fadeEnd > 0 ? Math.min(height, fadeEnd) : height;
      const cols = Math.max(0, Math.floor(width / tone.spacing));
      const rows = Math.max(0, Math.floor(lastRow / tone.spacing));
      const left = (width - (cols - 1) * tone.spacing) / 2;
      const top = fadeEnd > 0 ? tone.spacing / 2 : (height - (rows - 1) * tone.spacing) / 2;

      const count = cols * rows;
      homeX = new Float32Array(count);
      homeY = new Float32Array(count);
      offX = new Float32Array(count);
      offY = new Float32Array(count);
      velX = new Float32Array(count);
      velY = new Float32Array(count);
      for (let row = 0, i = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++, i++) {
          homeX[i] = left + col * tone.spacing;
          homeY[i] = top + row * tone.spacing;
        }
      }
    };

    const step = () => {
      energy = pointer && energy * ENERGY_DECAY > 0.005 ? energy * ENERGY_DECAY : 0;
      let moving = energy > 0;
      for (let i = 0; i < homeX.length; i++) {
        let targetX = 0;
        let targetY = 0;
        if (pointer) {
          const dx = homeX[i] - pointer.x;
          const dy = homeY[i] - pointer.y;
          const distance = Math.hypot(dx, dy);
          if (distance > 0.001) {
            const rest = distance < tone.reach ? (1 - distance / tone.reach) ** 2 * tone.push : 0;
            const surge = Math.max(0, Math.exp(-distance / tone.spread) - SPREAD_FLOOR) * tone.surge * energy;
            targetX = (dx / distance) * (rest + surge);
            targetY = (dy / distance) * (rest + surge);
          }
        }
        velX[i] = (velX[i] + (targetX - offX[i]) * SPRING) * DAMPING;
        velY[i] = (velY[i] + (targetY - offY[i]) * SPRING) * DAMPING;
        offX[i] += velX[i];
        offY[i] += velY[i];
        if (
          Math.abs(velX[i]) > SETTLED ||
          Math.abs(velY[i]) > SETTLED ||
          Math.abs(offX[i] - targetX) > SETTLED ||
          Math.abs(offY[i] - targetY) > SETTLED
        ) {
          moving = true;
        }
      }
      return moving;
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const buckets: number[][] = Array.from({ length: ALPHA_LEVELS + 1 }, () => []);
      for (let i = 0; i < homeX.length; i++) {
        const x = homeX[i] + offX[i];
        const y = homeY[i] + offY[i];
        const level = Math.round(tone.alpha * fadeAt(homeY[i]) * ALPHA_LEVELS);
        if (level > 0) buckets[level].push(x, y);
      }
      buckets.forEach((points, level) => {
        if (!points.length) return;
        ctx.fillStyle = `rgba(${ACCENT_RGB}, ${level / ALPHA_LEVELS})`;
        ctx.beginPath();
        for (let p = 0; p < points.length; p += 2) {
          ctx.moveTo(points[p] + tone.radius, points[p + 1]);
          ctx.arc(points[p], points[p + 1], tone.radius, 0, Math.PI * 2);
        }
        ctx.fill();
      });
    };

    const tick = () => {
      frame = 0;
      const moving = step();
      draw();
      if (moving && visible) frame = requestAnimationFrame(tick);
    };

    const wake = () => {
      if (!frame && visible && !still) frame = requestAnimationFrame(tick);
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const inside = x > -tone.reach && y > -tone.reach && x < width + tone.reach && y < height + tone.reach;
      if (!inside && !pointer) return;
      if (inside && pointer) energy = Math.min(1, energy + Math.hypot(x - pointer.x, y - pointer.y) * ENERGY_PER_PX);
      pointer = inside ? { x, y } : null;
      wake();
    };

    const onPointerLeave = () => {
      pointer = null;
      energy = 0;
      wake();
    };

    const resizeObserver = new ResizeObserver(() => {
      layout();
      draw();
    });
    resizeObserver.observe(container);

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting && document.visibilityState === "visible";
      if (visible) wake();
    });
    intersectionObserver.observe(container);

    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      if (visible) wake();
    };

    layout();
    draw();

    if (!still) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      document.documentElement.addEventListener("pointerleave", onPointerLeave);
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tone, fadeStart, fadeEnd]);

  return (
    <div ref={containerRef} className="dot-lattice" aria-hidden="true">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
};

export const DotLatticeDark = (props: DotLatticeProps) => <DotLattice tone={DARK} {...props} />;

export const DotLatticeLight = (props: DotLatticeProps) => <DotLattice tone={LIGHT} {...props} />;
