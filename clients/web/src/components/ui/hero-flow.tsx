import { useEffect, useRef } from "react";

const VERTEX = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const SOURCES = 6;

const FRAGMENT = `
precision highp float;
uniform vec2 uSize;
uniform float uTime;
uniform vec3 uInk[3];
uniform vec4 uSources[${SOURCES}];
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float total = 0.0;
  float amplitude = 0.5;
  mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    total += amplitude * noise(p);
    p = turn * p * 2.02 + 0.13;
    amplitude *= 0.5;
  }
  return total;
}

void main() {
  vec2 pixel = vUv * uSize;
  float unit = 1.0 / min(uSize.x, uSize.y);
  vec2 p = pixel * unit * 1.6;

  vec2 swirl = vec2(0.0);
  float stir = 0.0;
  for (int i = 0; i < ${SOURCES}; i++) {
    vec4 source = uSources[i];
    vec2 d = pixel - source.xy;
    float falloff = exp(-dot(d, d) / (source.w * source.w)) * source.z;
    swirl += vec2(-d.y, d.x) * unit * falloff * 2.2;
    stir += falloff;
  }

  float t = uTime * 0.045;
  vec2 warpA = vec2(fbm(p + swirl + vec2(0.0, t)), fbm(p - swirl + vec2(5.2, 1.3) - t));
  vec2 warpB = vec2(fbm(p + 3.6 * warpA + vec2(1.7, 9.2) + 1.3 * t),
                    fbm(p + 3.6 * warpA + vec2(8.3, 2.8) - t));
  float field = fbm(p + 3.6 * warpB + swirl);

  float wisp = smoothstep(0.46, 0.78, field);
  float alpha = clamp(wisp * (0.6 + 0.4 * min(stir, 1.0)), 0.0, 0.8);

  vec3 color = mix(uInk[0], uInk[1], smoothstep(0.35, 0.75, length(warpA)));
  color = mix(color, uInk[2], smoothstep(0.55, 0.9, field));
  gl_FragColor = vec4(color * alpha, alpha);
}`;

const RENDER_SCALE = 0.5;
const POINTER_RADIUS = 150;
const GHOST_RADIUS = 220;
const GHOSTS = 4;
const TAKEOVER_S = 0.25;
const IDLE_BEFORE_GHOSTS_S = 2;
const GHOST_RAMP_S = 1.2;

const toRgb = (hex: string): [number, number, number] => {
  const value = parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
};

const compile = (gl: WebGLRenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

export interface HeroFlowProps {
  colors: [string, string, string];
}

export const HeroFlow = ({ colors }: HeroFlowProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl", { premultipliedAlpha: true, antialias: false });
    if (!canvas || !gl) return;

    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uSize = gl.getUniformLocation(program, "uSize");
    const uTime = gl.getUniformLocation(program, "uTime");
    const uInk = gl.getUniformLocation(program, "uInk");
    const uSources = gl.getUniformLocation(program, "uSources");
    gl.uniform3fv(uInk, new Float32Array(colors.flatMap(toRgb)));
    gl.clearColor(0, 0, 0, 0);

    let cssWidth = 0;
    let cssHeight = 0;
    let scale = 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      cssWidth = rect.width;
      cssHeight = rect.height;
      scale = Math.min(window.devicePixelRatio || 1, 2) * RENDER_SCALE;
      canvas.width = Math.max(1, Math.round(cssWidth * scale));
      canvas.height = Math.max(1, Math.round(cssHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uSize, canvas.width, canvas.height);
    };

    const pointer = { x: 0, y: 0, strength: 0, lastMove: -Infinity };
    const trail = { x: 0, y: 0 };
    let ghostLevel = 0;

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
      pointer.x = x;
      pointer.y = y;
      pointer.lastMove = performance.now() / 1000;
    };

    const sources = new Float32Array(SOURCES * 4);
    const place = (slot: number, x: number, y: number, strength: number, radius: number) => {
      sources.set([x * scale, (cssHeight - y) * scale, strength, radius * scale], slot * 4);
    };

    let visible = true;
    let frame = 0;
    let previous = performance.now() / 1000;

    const render = () => {
      frame = 0;
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, now - previous);
      previous = now;

      const idle = now - pointer.lastMove;
      const active = idle < IDLE_BEFORE_GHOSTS_S;
      pointer.strength += ((active ? 1 : 0) - pointer.strength) * Math.min(1, dt / TAKEOVER_S);
      ghostLevel = active
        ? Math.max(0, ghostLevel - dt / TAKEOVER_S)
        : Math.min(1, ghostLevel + dt / GHOST_RAMP_S);
      trail.x += (pointer.x - trail.x) * Math.min(1, dt * 4);
      trail.y += (pointer.y - trail.y) * Math.min(1, dt * 4);

      place(0, pointer.x, pointer.y, pointer.strength, POINTER_RADIUS);
      place(1, trail.x, trail.y, pointer.strength * 0.6, POINTER_RADIUS * 1.4);
      for (let g = 0; g < GHOSTS; g++) {
        const phase = now * 0.11 + g * 1.7;
        const x = cssWidth * (0.5 + 0.42 * Math.sin(phase * (1 + g * 0.23)));
        const y = cssHeight * (0.5 + 0.38 * Math.cos(phase * (0.8 + g * 0.17) + g));
        place(2 + g, x, y, ghostLevel * 0.7, GHOST_RADIUS);
      }

      gl.uniform1f(uTime, now);
      gl.uniform4fv(uSources, sources);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (visible) frame = requestAnimationFrame(render);
    };

    const resume = () => {
      if (!frame && visible) {
        previous = performance.now() / 1000;
        frame = requestAnimationFrame(render);
      }
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    let onScreen = true;
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      visible = onScreen && document.visibilityState === "visible";
      resume();
    });
    intersectionObserver.observe(canvas);

    const onVisibility = () => {
      visible = onScreen && document.visibilityState === "visible";
      resume();
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      visible = false;
      cancelAnimationFrame(frame);
    };

    resize();
    resume();
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", onContextLost);

    return () => {
      visible = false;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, [colors]);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none block h-full w-full" />;
};
