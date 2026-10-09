import { useEffect, useRef } from "react";

const SOURCES = 6;

const VERTEX = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uTexel;
`;

const ADVECT = `${HEADER}
uniform sampler2D uVelocity;
uniform vec2 uGrid;
uniform float uDt;
uniform float uKeep;
uniform vec4 uSources[${SOURCES}];
uniform float uRadii[${SOURCES}];
void main() {
  vec2 from = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  vec2 velocity = texture(uVelocity, from).xy * uKeep;
  vec2 cell = vUv * uGrid;
  for (int i = 0; i < ${SOURCES}; i++) {
    vec2 d = cell - uSources[i].xy;
    velocity += uSources[i].zw * exp(-dot(d, d) / (uRadii[i] * uRadii[i]));
  }
  outColor = vec4(velocity, 0.0, 1.0);
}`;

const CURL = `${HEADER}
uniform sampler2D uVelocity;
void main() {
  float left = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float right = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float below = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float above = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  outColor = vec4(0.5 * (right - left - above + below), 0.0, 0.0, 1.0);
}`;

const SWIRL = `${HEADER}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uStrength;
uniform float uDt;
void main() {
  float left = abs(texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x);
  float right = abs(texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x);
  float below = abs(texture(uCurl, vUv - vec2(0.0, uTexel.y)).x);
  float above = abs(texture(uCurl, vUv + vec2(0.0, uTexel.y)).x);
  vec2 toward = vec2(right - left, above - below);
  toward /= length(toward) + 1e-5;
  vec2 force = vec2(toward.y, -toward.x) * texture(uCurl, vUv).x * uStrength;
  outColor = vec4(texture(uVelocity, vUv).xy + force * uDt, 0.0, 1.0);
}`;

const DIVERGENCE = `${HEADER}
uniform sampler2D uVelocity;
void main() {
  float left = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float right = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float below = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float above = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  outColor = vec4(0.5 * (right - left + above - below), 0.0, 0.0, 1.0);
}`;

const PRESSURE = `${HEADER}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  float left = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float right = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float below = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float above = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  outColor = vec4(0.25 * (left + right + below + above - texture(uDivergence, vUv).x), 0.0, 0.0, 1.0);
}`;

const PROJECT = `${HEADER}
uniform sampler2D uVelocity;
uniform sampler2D uPressure;
void main() {
  float left = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float right = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float below = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float above = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  vec2 velocity = texture(uVelocity, vUv).xy - 0.5 * vec2(right - left, above - below);
  outColor = vec4(velocity, 0.0, 1.0);
}`;

const DISPLAY = `${HEADER}
uniform sampler2D uVelocity;
uniform vec3 uInk[3];
uniform float uGain;
uniform float uOpacity;
void main() {
  float speed = length(texture(uVelocity, vUv).xy) * uGain;
  float level = 1.0 - exp(-speed * speed);
  vec3 color = mix(uInk[0], uInk[1], smoothstep(0.0, 0.55, level));
  color = mix(color, uInk[2], smoothstep(0.45, 1.0, level));
  float alpha = level * uOpacity;
  outColor = vec4(color * alpha, alpha);
}`;

const RENDER_SCALE = 0.5;
const SIM_SCALE = 0.25;
const PRESSURE_ITERATIONS = 20;
const MAX_DT = 1 / 30;
const FADE_S = 1.6;
const SWIRL_STRENGTH = 4;
const INK_GAIN = 0.014;
const INK_OPACITY = 0.8;
const POINTER_RADIUS = 50;
const POINTER_FORCE = 10;
const GHOST_RADIUS = 90;
const GHOST_FORCE = 5.5;
const GHOSTS = 4;
const TAKEOVER_S = 0.25;
const IDLE_BEFORE_GHOSTS_S = 2;
const GHOST_RAMP_S = 1.2;

const toRgb = (hex: string): [number, number, number] => {
  const value = parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
};

const compile = (gl: WebGL2RenderingContext, type: number, source: string) => {
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

interface Pass {
  program: WebGLProgram;
  at: (name: string) => WebGLUniformLocation | null;
}

const link = (gl: WebGL2RenderingContext, vertex: WebGLShader, source: string): Pass | null => {
  const fragment = compile(gl, gl.FRAGMENT_SHADER, source);
  const program = gl.createProgram();
  if (!fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.linkProgram(program);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  const locations = new Map<string, WebGLUniformLocation | null>();
  const at = (name: string) => {
    if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
    return locations.get(name) ?? null;
  };
  return { program, at };
};

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

const createTarget = (gl: WebGL2RenderingContext, width: number, height: number): Target | null => {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }
  return { texture, framebuffer };
};

export interface HeroFlowProps {
  colors: [string, string, string];
}

export const HeroFlow = ({ colors }: HeroFlowProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!canvas || !gl) return;
    if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return;

    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    if (!vertex) return;
    const advect = link(gl, vertex, ADVECT);
    const curl = link(gl, vertex, CURL);
    const swirl = link(gl, vertex, SWIRL);
    const divergence = link(gl, vertex, DIVERGENCE);
    const pressure = link(gl, vertex, PRESSURE);
    const project = link(gl, vertex, PROJECT);
    const display = link(gl, vertex, DISPLAY);
    const passes = [advect, curl, swirl, divergence, pressure, project, display];
    const release = () => {
      for (const pass of passes) if (pass) gl.deleteProgram(pass.program);
      gl.deleteShader(vertex);
    };
    if (!advect || !curl || !swirl || !divergence || !pressure || !project || !display) {
      release();
      return;
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(display.program);
    gl.uniform3fv(display.at("uInk"), new Float32Array(colors.flatMap(toRgb)));
    gl.uniform1f(display.at("uGain"), INK_GAIN);
    gl.uniform1f(display.at("uOpacity"), INK_OPACITY);
    gl.uniform1i(display.at("uVelocity"), 0);

    let targets: Target[] = [];
    let velocity: [Target, Target] | null = null;
    let pressureField: [Target, Target] | null = null;
    let divergenceField: Target | null = null;
    let curlField: Target | null = null;
    let gridWidth = 0;
    let gridHeight = 0;

    const freeTargets = () => {
      for (const target of targets) {
        gl.deleteFramebuffer(target.framebuffer);
        gl.deleteTexture(target.texture);
      }
      targets = [];
      velocity = null;
      pressureField = null;
      divergenceField = null;
      curlField = null;
    };

    const buildTargets = (width: number, height: number) => {
      freeTargets();
      const made = Array.from({ length: 6 }, () => createTarget(gl, width, height));
      targets = made.filter((target): target is Target => target !== null);
      if (targets.length < made.length) return freeTargets();
      velocity = [targets[0], targets[1]];
      pressureField = [targets[2], targets[3]];
      divergenceField = targets[4];
      curlField = targets[5];
    };

    let cssWidth = 0;
    let cssHeight = 0;
    let ghostsPlaced = false;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      cssWidth = rect.width;
      cssHeight = rect.height;
      const scale = Math.min(window.devicePixelRatio || 1, 2) * RENDER_SCALE;
      canvas.width = Math.max(1, Math.round(cssWidth * scale));
      canvas.height = Math.max(1, Math.round(cssHeight * scale));
      const width = Math.max(1, Math.round(cssWidth * SIM_SCALE));
      const height = Math.max(1, Math.round(cssHeight * SIM_SCALE));
      if (width !== gridWidth || height !== gridHeight || !velocity) {
        gridWidth = width;
        gridHeight = height;
        buildTargets(width, height);
      }
      ghostsPlaced = false;
    };

    const pointer = { x: 0, y: 0, drawnX: 0, drawnY: 0, tracked: false, lastMove: -Infinity };
    let ghostLevel = 0;
    const ghostX = new Float32Array(GHOSTS);
    const ghostY = new Float32Array(GHOSTS);

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        pointer.tracked = false;
        return;
      }
      if (!pointer.tracked) {
        pointer.drawnX = x;
        pointer.drawnY = y;
        pointer.tracked = true;
      }
      pointer.x = x;
      pointer.y = y;
      pointer.lastMove = performance.now() / 1000;
    };

    const sources = new Float32Array(SOURCES * 4);
    const radii = new Float32Array(SOURCES).fill(1);
    const place = (slot: number, x: number, y: number, forceX: number, forceY: number, radius: number) => {
      sources.set(
        [x * SIM_SCALE, (cssHeight - y) * SIM_SCALE, forceX * SIM_SCALE, -forceY * SIM_SCALE],
        slot * 4,
      );
      radii[slot] = radius * SIM_SCALE;
    };

    const draw = (pass: Pass, target: Target | null) => {
      gl.useProgram(pass.program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
      if (target) {
        gl.viewport(0, 0, gridWidth, gridHeight);
        gl.uniform2f(pass.at("uTexel"), 1 / gridWidth, 1 / gridHeight);
      } else {
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
    };

    const bind = (unit: number, target: Target) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
    };

    const step = (dt: number) => {
      if (!velocity || !pressureField || !divergenceField || !curlField) return;

      draw(advect, velocity[1]);
      bind(0, velocity[0]);
      gl.uniform1i(advect.at("uVelocity"), 0);
      gl.uniform2f(advect.at("uGrid"), gridWidth, gridHeight);
      gl.uniform1f(advect.at("uDt"), dt);
      gl.uniform1f(advect.at("uKeep"), Math.exp(-dt / FADE_S));
      gl.uniform4fv(advect.at("uSources"), sources);
      gl.uniform1fv(advect.at("uRadii"), radii);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      velocity.reverse();

      draw(curl, curlField);
      bind(0, velocity[0]);
      gl.uniform1i(curl.at("uVelocity"), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      draw(swirl, velocity[1]);
      bind(0, velocity[0]);
      bind(1, curlField);
      gl.uniform1i(swirl.at("uVelocity"), 0);
      gl.uniform1i(swirl.at("uCurl"), 1);
      gl.uniform1f(swirl.at("uStrength"), SWIRL_STRENGTH);
      gl.uniform1f(swirl.at("uDt"), dt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      velocity.reverse();

      draw(divergence, divergenceField);
      bind(0, velocity[0]);
      gl.uniform1i(divergence.at("uVelocity"), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      bind(1, divergenceField);
      for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
        draw(pressure, pressureField[1]);
        bind(0, pressureField[0]);
        gl.uniform1i(pressure.at("uPressure"), 0);
        gl.uniform1i(pressure.at("uDivergence"), 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        pressureField.reverse();
      }

      draw(project, velocity[1]);
      bind(0, velocity[0]);
      bind(1, pressureField[0]);
      gl.uniform1i(project.at("uVelocity"), 0);
      gl.uniform1i(project.at("uPressure"), 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      velocity.reverse();

      draw(display, null);
      bind(0, velocity[0]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    let visible = true;
    let frame = 0;
    let previous = performance.now() / 1000;

    const render = () => {
      frame = 0;
      const now = performance.now() / 1000;
      const dt = Math.min(MAX_DT, now - previous);
      previous = now;

      const active = now - pointer.lastMove < IDLE_BEFORE_GHOSTS_S;
      ghostLevel = active
        ? Math.max(0, ghostLevel - dt / TAKEOVER_S)
        : Math.min(1, ghostLevel + dt / GHOST_RAMP_S);

      const moveX = pointer.x - pointer.drawnX;
      const moveY = pointer.y - pointer.drawnY;
      const force = POINTER_FORCE / 2;
      place(0, pointer.x - moveX / 2, pointer.y - moveY / 2, moveX * force, moveY * force, POINTER_RADIUS);
      place(1, pointer.x, pointer.y, moveX * force, moveY * force, POINTER_RADIUS);
      pointer.drawnX = pointer.x;
      pointer.drawnY = pointer.y;

      for (let g = 0; g < GHOSTS; g++) {
        const phase = now * 0.16 + g * 1.7;
        const x = cssWidth * (0.5 + 0.44 * Math.sin(phase * (1 + g * 0.23)));
        const y = cssHeight * (0.5 + 0.4 * Math.cos(phase * (0.8 + g * 0.17) + g));
        const strength = ghostsPlaced ? GHOST_FORCE * ghostLevel : 0;
        place(2 + g, x, y, (x - ghostX[g]) * strength, (y - ghostY[g]) * strength, GHOST_RADIUS);
        ghostX[g] = x;
        ghostY[g] = y;
      }
      ghostsPlaced = true;

      step(dt);

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
      freeTargets();
      gl.deleteBuffer(buffer);
      release();
    };
  }, [colors]);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none block h-full w-full" />;
};
