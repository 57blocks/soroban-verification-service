import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * A flowing fluid background: a WebGL Eulerian solve (advect → mouse force → viscosity → divergence →
 * Poisson → pressure projection) whose velocity field is read back as colour. Adapted from React Bits'
 * LiquidEther.
 *
 * The canvas carries no background of its own — it writes premultiplied colour at an alpha taken from
 * the flow speed, so a still region is fully transparent and whatever sits under the component shows
 * through. That is what lets it sit on the hero's white wash and stay a wash itself.
 *
 * Three departures from upstream, each for a reason this app cares about:
 *
 * - `backgroundColor` is not accepted. Upstream takes the prop and then hard-codes a transparent clear
 *   and a transparent `bgColor` uniform, so the only thing it could do here is mislead the next reader.
 * - The effect does not mount at all under `prefers-reduced-motion: reduce`. `index.css` gives those
 *   users the fade-up transition switched off rather than shortened, and a background that is nothing
 *   but motion gets the same answer: the hero's own static wash is the design, and this is an
 *   enhancement on top of it, not the thing that carries it.
 * - The mount effect depends on the palette's *contents* rather than the array's identity, and on
 *   `lightMode`; every other prop is applied to the running simulation in place. Upstream lists all of
 *   them, so a caller passing an inline `colors={[...]}` — or nudging `mouseForce` — tears down the
 *   renderer and its render targets and builds them again on each render. Rebuilding on a real palette
 *   change is still correct and is all this needs.
 *
 * `lightMode` answers the same question for a light page: the palette stops are normalised to their own
 * chroma before they are drawn, so a near-white stop cannot wash out against white and the flow keeps a
 * readable hue at the low velocities that cover most of the canvas.
 *
 * One property of the simulation is worth knowing before tuning it: **speed and colour are the same
 * quantity.** The colour pass reads `length(vel)`, and the advection pass moves the pattern by `vel`, so
 * `mouseForce`, `autoIntensity` and `autoSpeed` all scale both at once. There is no prop that calms the
 * motion without also fading it, and a wash that covers the hero is by construction a wash that moves
 * quickly across it. Pick the speed first — it is the thing a visitor notices — and let the colour follow.
 */

/** A single uniform slot. Loose on purpose: three only ever reads `value`. */
type Uniforms = Record<string, { value: unknown }>;

interface ShaderSpec {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Uniforms;
}

interface ShaderPassProps {
  material?: ShaderSpec;
  output?: THREE.WebGLRenderTarget | null;
  output0?: THREE.WebGLRenderTarget;
  output1?: THREE.WebGLRenderTarget;
}

interface SimOptions {
  iterations_poisson: number;
  iterations_viscous: number;
  mouse_force: number;
  resolution: number;
  cursor_size: number;
  viscous: number;
  isBounce: boolean;
  dt: number;
  isViscous: boolean;
  BFECC: boolean;
}

/** What the prop-sync effect reaches through. Structural, because the classes that satisfy it are built
 *  inside the mount effect. */
interface SimulationHandle {
  options: SimOptions;
  resize: () => void;
}

interface AutoDriverHandle {
  enabled: boolean;
  speed: number;
  resumeDelay: number;
  rampDurationMs: number;
  mouse: { autoIntensity: number; takeoverDuration: number };
}

interface LiquidEtherHandle {
  simulation: SimulationHandle;
  autoDriver?: AutoDriverHandle;
  resize: () => void;
  start: () => void;
  pause: () => void;
  dispose: () => void;
}

export interface LiquidEtherProps {
  /** Hex stops, slowest flow first. Ignored unless the array's contents change. */
  colors?: string[];
  /** Strength multiplier on pointer movement. */
  mouseForce?: number;
  /** Radius of the force brush, in pixels at base resolution. */
  cursorSize?: number;
  /** Simulation texture scale against canvas size. Lower is cheaper and softer. */
  resolution?: number;
  /** Fixed simulation timestep. */
  dt?: number;
  /** Error-compensated advection: crisper flow, slightly more work. */
  BFECC?: boolean;
  isViscous?: boolean;
  viscous?: number;
  iterationsViscous?: number;
  iterationsPoisson?: number;
  /** Draws the velocity-clamped boundary. A debug view, off in normal use. */
  isBounce?: boolean;
  style?: React.CSSProperties;
  className?: string;
  /** Drives the pointer itself while nobody is interacting, so an unattended hero still moves. */
  autoDemo?: boolean;
  autoSpeed?: number;
  autoIntensity?: number;
  /** Seconds to hand control from the auto pointer to the real one, once the mouse moves. */
  takeoverDuration?: number;
  /** Idle milliseconds before auto mode resumes. */
  autoResumeDelay?: number;
  /** Seconds to ramp the auto pointer from standstill to full speed. */
  autoRampDuration?: number;
  /** Normalise palette stops to their own chroma. On for light pages. */
  lightMode?: boolean;
}

const defaultColors = ["#5227FF", "#FF9FFC", "#B497CF"];

/** The render targets the solver ping-pongs between, in creation order. */
const FBO_KEYS = [
  "vel_0",
  "vel_1",
  "vel_viscous0",
  "vel_viscous1",
  "div",
  "pressure_0",
  "pressure_1",
] as const;

type FboKey = (typeof FBO_KEYS)[number];

export const LiquidEther = ({
  mouseForce = 20,
  cursorSize = 100,
  isViscous = false,
  viscous = 30,
  iterationsViscous = 32,
  iterationsPoisson = 32,
  dt = 0.014,
  BFECC = true,
  resolution = 0.5,
  isBounce = false,
  colors = defaultColors,
  style,
  className,
  autoDemo = true,
  autoSpeed = 0.5,
  autoIntensity = 2.2,
  takeoverDuration = 0.25,
  autoResumeDelay = 1000,
  autoRampDuration = 0.6,
  lightMode = false,
}: LiquidEtherProps): React.ReactElement => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const webglRef = useRef<LiquidEtherHandle | null>(null);

  // The mount effect keys off this rather than the array, so a caller may pass `colors` inline without
  // rebuilding the renderer on every render.
  const paletteKey = colors.join(",");

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const stops = paletteKey.split(",");
    const palette = stops.length === 1 ? [stops[0], stops[0]] : stops;

    const makePaletteTexture = (entries: string[]): THREE.DataTexture => {
      const width = entries.length;
      const data = new Uint8Array(width * 4);
      for (let i = 0; i < width; i++) {
        const c = new THREE.Color(entries[i]);
        data[i * 4 + 0] = Math.round(c.r * 255);
        data[i * 4 + 1] = Math.round(c.g * 255);
        data[i * 4 + 2] = Math.round(c.b * 255);
        data[i * 4 + 3] = 255;
      }
      const tex = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      return tex;
    };

    const paletteTex = makePaletteTexture(palette);
    // Cleared to nothing: the shader mixes against this, so a zero vector here is what makes a still
    // region transparent instead of black.
    const bgVec4 = new THREE.Vector4(0, 0, 0, 0);

    class CommonClass {
      width = 0;
      height = 0;
      pixelRatio = 1;
      renderer: THREE.WebGLRenderer | null = null;
      clock: THREE.Clock | null = null;
      time = 0;
      init(target: HTMLElement) {
        const rect = target.getBoundingClientRect();
        this.width = Math.max(1, Math.floor(rect.width));
        this.height = Math.max(1, Math.floor(rect.height));
        this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.autoClear = false;
        this.renderer.setClearColor(new THREE.Color(0x000000), 0);
        this.renderer.setPixelRatio(this.pixelRatio);
        this.renderer.setSize(this.width, this.height);
        const el = this.renderer.domElement;
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.display = "block";
        this.clock = new THREE.Clock();
        this.clock.start();
      }
      resize(target: HTMLElement) {
        if (!this.renderer) return;
        const rect = target.getBoundingClientRect();
        this.width = Math.max(1, Math.floor(rect.width));
        this.height = Math.max(1, Math.floor(rect.height));
        this.renderer.setSize(this.width, this.height, false);
      }
      update() {
        if (!this.clock) return;
        this.time += this.clock.getDelta();
      }
    }
    const Common = new CommonClass();

    class MouseClass {
      mouseMoved = false;
      coords = new THREE.Vector2();
      coords_old = new THREE.Vector2();
      diff = new THREE.Vector2();
      timer: number | null = null;
      container: HTMLElement | null = null;
      docTarget: Document | null = null;
      listenerTarget: Window | null = null;
      isHoverInside = false;
      hasUserControl = false;
      isAutoActive = false;
      autoIntensity = 2.0;
      takeoverActive = false;
      takeoverStartTime = 0;
      takeoverDuration = 0.25;
      takeoverFrom = new THREE.Vector2();
      takeoverTo = new THREE.Vector2();
      onInteract: (() => void) | null = null;
      private _onMouseMove = this.onDocumentMouseMove.bind(this);
      private _onTouchStart = this.onDocumentTouchStart.bind(this);
      private _onTouchMove = this.onDocumentTouchMove.bind(this);
      private _onTouchEnd = this.onTouchEnd.bind(this);
      private _onDocumentLeave = this.onDocumentLeave.bind(this);

      init(target: HTMLElement) {
        this.container = target;
        this.docTarget = target.ownerDocument;
        const defaultView = this.docTarget.defaultView;
        if (!defaultView) return;
        this.listenerTarget = defaultView;
        // Listeners go on the window, not the canvas: the hero's CTA has to stay clickable, so the
        // canvas is `pointer-events-none` and every hit test happens against the container's rect.
        this.listenerTarget.addEventListener("mousemove", this._onMouseMove);
        this.listenerTarget.addEventListener("touchstart", this._onTouchStart, { passive: true });
        this.listenerTarget.addEventListener("touchmove", this._onTouchMove, { passive: true });
        this.listenerTarget.addEventListener("touchend", this._onTouchEnd);
        this.docTarget.addEventListener("mouseleave", this._onDocumentLeave);
      }
      dispose() {
        if (this.listenerTarget) {
          this.listenerTarget.removeEventListener("mousemove", this._onMouseMove);
          this.listenerTarget.removeEventListener("touchstart", this._onTouchStart);
          this.listenerTarget.removeEventListener("touchmove", this._onTouchMove);
          this.listenerTarget.removeEventListener("touchend", this._onTouchEnd);
        }
        if (this.docTarget) {
          this.docTarget.removeEventListener("mouseleave", this._onDocumentLeave);
        }
        this.listenerTarget = null;
        this.docTarget = null;
        this.container = null;
      }
      private isPointInside(clientX: number, clientY: number) {
        if (!this.container) return false;
        const rect = this.container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
      }
      private updateHoverState(clientX: number, clientY: number) {
        this.isHoverInside = this.isPointInside(clientX, clientY);
        return this.isHoverInside;
      }
      setCoords(x: number, y: number) {
        if (!this.container) return;
        if (this.timer) window.clearTimeout(this.timer);
        const rect = this.container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const nx = (x - rect.left) / rect.width;
        const ny = (y - rect.top) / rect.height;
        this.coords.set(nx * 2 - 1, -(ny * 2 - 1));
        this.mouseMoved = true;
        this.timer = window.setTimeout(() => {
          this.mouseMoved = false;
        }, 100);
      }
      setNormalized(nx: number, ny: number) {
        this.coords.set(nx, ny);
        this.mouseMoved = true;
      }
      onDocumentMouseMove(event: MouseEvent) {
        if (!this.updateHoverState(event.clientX, event.clientY)) return;
        if (this.onInteract) this.onInteract();
        if (this.isAutoActive && !this.hasUserControl && !this.takeoverActive) {
          if (!this.container) return;
          const rect = this.container.getBoundingClientRect();
          const nx = (event.clientX - rect.left) / rect.width;
          const ny = (event.clientY - rect.top) / rect.height;
          this.takeoverFrom.copy(this.coords);
          this.takeoverTo.set(nx * 2 - 1, -(ny * 2 - 1));
          this.takeoverStartTime = performance.now();
          this.takeoverActive = true;
          this.hasUserControl = true;
          this.isAutoActive = false;
          return;
        }
        this.setCoords(event.clientX, event.clientY);
        this.hasUserControl = true;
      }
      onDocumentTouchStart(event: TouchEvent) {
        if (event.touches.length !== 1) return;
        const t = event.touches[0];
        if (!this.updateHoverState(t.clientX, t.clientY)) return;
        if (this.onInteract) this.onInteract();
        this.setCoords(t.clientX, t.clientY);
        this.hasUserControl = true;
      }
      onDocumentTouchMove(event: TouchEvent) {
        if (event.touches.length !== 1) return;
        const t = event.touches[0];
        if (!this.updateHoverState(t.clientX, t.clientY)) return;
        if (this.onInteract) this.onInteract();
        this.setCoords(t.clientX, t.clientY);
      }
      onTouchEnd() {
        this.isHoverInside = false;
      }
      onDocumentLeave() {
        this.isHoverInside = false;
      }
      update() {
        if (this.takeoverActive) {
          const t = (performance.now() - this.takeoverStartTime) / (this.takeoverDuration * 1000);
          if (t >= 1) {
            this.takeoverActive = false;
            this.coords.copy(this.takeoverTo);
            this.coords_old.copy(this.coords);
            this.diff.set(0, 0);
          } else {
            const k = t * t * (3 - 2 * t);
            this.coords.copy(this.takeoverFrom).lerp(this.takeoverTo, k);
          }
        }
        this.diff.subVectors(this.coords, this.coords_old);
        this.coords_old.copy(this.coords);
        if (this.coords_old.x === 0 && this.coords_old.y === 0) this.diff.set(0, 0);
        if (this.isAutoActive && !this.takeoverActive) this.diff.multiplyScalar(this.autoIntensity);
      }
    }
    const Mouse = new MouseClass();

    /** What the auto driver reads off the manager: the clock that says when a person last touched it. */
    interface InteractionClock {
      lastUserInteraction: number;
    }

    class AutoDriver {
      mouse: MouseClass;
      manager: InteractionClock;
      enabled: boolean;
      speed: number;
      resumeDelay: number;
      rampDurationMs: number;
      active = false;
      current = new THREE.Vector2(0, 0);
      target = new THREE.Vector2();
      lastTime = performance.now();
      activationTime = 0;
      margin = 0.2;
      private _tmpDir = new THREE.Vector2();

      constructor(
        mouse: MouseClass,
        manager: InteractionClock,
        opts: { enabled: boolean; speed: number; resumeDelay: number; rampDuration: number },
      ) {
        this.mouse = mouse;
        this.manager = manager;
        this.enabled = opts.enabled;
        this.speed = opts.speed;
        this.resumeDelay = opts.resumeDelay || 3000;
        this.rampDurationMs = (opts.rampDuration || 0) * 1000;
        this.pickNewTarget();
      }
      pickNewTarget() {
        const r = Math.random;
        this.target.set((r() * 2 - 1) * (1 - this.margin), (r() * 2 - 1) * (1 - this.margin));
      }
      forceStop() {
        this.active = false;
        this.mouse.isAutoActive = false;
      }
      update() {
        if (!this.enabled) return;
        const now = performance.now();
        const idle = now - this.manager.lastUserInteraction;
        if (idle < this.resumeDelay) {
          if (this.active) this.forceStop();
          return;
        }
        if (this.mouse.isHoverInside) {
          if (this.active) this.forceStop();
          return;
        }
        if (!this.active) {
          this.active = true;
          this.current.copy(this.mouse.coords);
          this.lastTime = now;
          this.activationTime = now;
        }
        this.mouse.isAutoActive = true;
        let dtSec = (now - this.lastTime) / 1000;
        this.lastTime = now;
        if (dtSec > 0.2) dtSec = 0.016;
        const dir = this._tmpDir.subVectors(this.target, this.current);
        const dist = dir.length();
        if (dist < 0.01) {
          this.pickNewTarget();
          return;
        }
        dir.normalize();
        let ramp = 1;
        if (this.rampDurationMs > 0) {
          const t = Math.min(1, (now - this.activationTime) / this.rampDurationMs);
          ramp = t * t * (3 - 2 * t);
        }
        const step = this.speed * dtSec * ramp;
        const move = Math.min(step, dist);
        this.current.addScaledVector(dir, move);
        this.mouse.setNormalized(this.current.x, this.current.y);
      }
    }

    const face_vert = `
  attribute vec3 position;
  uniform vec2 px;
  uniform vec2 boundarySpace;
  varying vec2 uv;
  precision highp float;
  void main(){
  vec3 pos = position;
  vec2 scale = 1.0 - boundarySpace * 2.0;
  pos.xy = pos.xy * scale;
  uv = vec2(0.5)+(pos.xy)*0.5;
  gl_Position = vec4(pos, 1.0);
}
`;
    const line_vert = `
  attribute vec3 position;
  uniform vec2 px;
  precision highp float;
  varying vec2 uv;
  void main(){
  vec3 pos = position;
  uv = 0.5 + pos.xy * 0.5;
  vec2 n = sign(pos.xy);
  pos.xy = abs(pos.xy) - px * 1.0;
  pos.xy *= n;
  gl_Position = vec4(pos, 1.0);
}
`;
    const mouse_vert = `
    precision highp float;
    attribute vec3 position;
    attribute vec2 uv;
    uniform vec2 center;
    uniform vec2 scale;
    uniform vec2 px;
    varying vec2 vUv;
    void main(){
    vec2 pos = position.xy * scale * 2.0 * px + center;
    vUv = uv;
    gl_Position = vec4(pos, 0.0, 1.0);
}
`;
    const advection_frag = `
    precision highp float;
    uniform sampler2D velocity;
    uniform float dt;
    uniform bool isBFECC;
    uniform vec2 fboSize;
    uniform vec2 px;
    varying vec2 uv;
    void main(){
    vec2 ratio = max(fboSize.x, fboSize.y) / fboSize;
    if(isBFECC == false){
        vec2 vel = texture2D(velocity, uv).xy;
        vec2 uv2 = uv - vel * dt * ratio;
        vec2 newVel = texture2D(velocity, uv2).xy;
        gl_FragColor = vec4(newVel, 0.0, 0.0);
    } else {
        vec2 spot_new = uv;
        vec2 vel_old = texture2D(velocity, uv).xy;
        vec2 spot_old = spot_new - vel_old * dt * ratio;
        vec2 vel_new1 = texture2D(velocity, spot_old).xy;
        vec2 spot_new2 = spot_old + vel_new1 * dt * ratio;
        vec2 error = spot_new2 - spot_new;
        vec2 spot_new3 = spot_new - error / 2.0;
        vec2 vel_2 = texture2D(velocity, spot_new3).xy;
        vec2 spot_old2 = spot_new3 - vel_2 * dt * ratio;
        vec2 newVel2 = texture2D(velocity, spot_old2).xy; 
        gl_FragColor = vec4(newVel2, 0.0, 0.0);
    }
}
`;
    const color_frag = `
    precision highp float;
    uniform sampler2D velocity;
    uniform sampler2D palette;
    uniform vec4 bgColor;
    uniform bool lightMode;
    varying vec2 uv;
    void main(){
    vec2 vel = texture2D(velocity, uv).xy;
    float lenv = clamp(length(vel), 0.0, 1.0);
    vec3 c = texture2D(palette, vec2(lenv, 0.5)).rgb;
    float peak = max(c.r, max(c.g, c.b));
    vec3 chroma = clamp(c / max(peak, 0.0001), 0.0, 1.0);
    chroma = pow(chroma, vec3(1.25));
    vec3 ink = lightMode ? chroma : c;
    vec3 outRGB = mix(bgColor.rgb, ink, lenv);
    float outA = mix(bgColor.a, 1.0, lenv);
    gl_FragColor = vec4(outRGB, outA);
}
`;
    const divergence_frag = `
    precision highp float;
    uniform sampler2D velocity;
    uniform float dt;
    uniform vec2 px;
    varying vec2 uv;
    void main(){
    float x0 = texture2D(velocity, uv-vec2(px.x, 0.0)).x;
    float x1 = texture2D(velocity, uv+vec2(px.x, 0.0)).x;
    float y0 = texture2D(velocity, uv-vec2(0.0, px.y)).y;
    float y1 = texture2D(velocity, uv+vec2(0.0, px.y)).y;
    float divergence = (x1 - x0 + y1 - y0) / 2.0;
    gl_FragColor = vec4(divergence / dt);
}
`;
    const externalForce_frag = `
    precision highp float;
    uniform vec2 force;
    uniform vec2 center;
    uniform vec2 scale;
    uniform vec2 px;
    varying vec2 vUv;
    void main(){
    vec2 circle = (vUv - 0.5) * 2.0;
    float d = 1.0 - min(length(circle), 1.0);
    d *= d;
    gl_FragColor = vec4(force * d, 0.0, 1.0);
}
`;
    const poisson_frag = `
    precision highp float;
    uniform sampler2D pressure;
    uniform sampler2D divergence;
    uniform vec2 px;
    varying vec2 uv;
    void main(){
    float p0 = texture2D(pressure, uv + vec2(px.x * 2.0, 0.0)).r;
    float p1 = texture2D(pressure, uv - vec2(px.x * 2.0, 0.0)).r;
    float p2 = texture2D(pressure, uv + vec2(0.0, px.y * 2.0)).r;
    float p3 = texture2D(pressure, uv - vec2(0.0, px.y * 2.0)).r;
    float div = texture2D(divergence, uv).r;
    float newP = (p0 + p1 + p2 + p3) / 4.0 - div;
    gl_FragColor = vec4(newP);
}
`;
    const pressure_frag = `
    precision highp float;
    uniform sampler2D pressure;
    uniform sampler2D velocity;
    uniform vec2 px;
    uniform float dt;
    varying vec2 uv;
    void main(){
    float step = 1.0;
    float p0 = texture2D(pressure, uv + vec2(px.x * step, 0.0)).r;
    float p1 = texture2D(pressure, uv - vec2(px.x * step, 0.0)).r;
    float p2 = texture2D(pressure, uv + vec2(0.0, px.y * step)).r;
    float p3 = texture2D(pressure, uv - vec2(0.0, px.y * step)).r;
    vec2 v = texture2D(velocity, uv).xy;
    vec2 gradP = vec2(p0 - p1, p2 - p3) * 0.5;
    v = v - gradP * dt;
    gl_FragColor = vec4(v, 0.0, 1.0);
}
`;
    const viscous_frag = `
    precision highp float;
    uniform sampler2D velocity;
    uniform sampler2D velocity_new;
    uniform float v;
    uniform vec2 px;
    uniform float dt;
    varying vec2 uv;
    void main(){
    vec2 old = texture2D(velocity, uv).xy;
    vec2 new0 = texture2D(velocity_new, uv + vec2(px.x * 2.0, 0.0)).xy;
    vec2 new1 = texture2D(velocity_new, uv - vec2(px.x * 2.0, 0.0)).xy;
    vec2 new2 = texture2D(velocity_new, uv + vec2(0.0, px.y * 2.0)).xy;
    vec2 new3 = texture2D(velocity_new, uv - vec2(0.0, px.y * 2.0)).xy;
    vec2 newv = 4.0 * old + v * dt * (new0 + new1 + new2 + new3);
    newv /= 4.0 * (1.0 + v * dt);
    gl_FragColor = vec4(newv, 0.0, 0.0);
}
`;

    class ShaderPass {
      props: ShaderPassProps;
      uniforms?: Uniforms;
      scene = new THREE.Scene();
      camera = new THREE.Camera();
      material: THREE.RawShaderMaterial | null = null;
      geometry: THREE.BufferGeometry | null = null;
      plane: THREE.Mesh | null = null;

      constructor(props: ShaderPassProps) {
        this.props = props;
        this.uniforms = props.material?.uniforms;
      }
      init() {
        if (!this.uniforms || !this.props.material) return;
        this.material = new THREE.RawShaderMaterial({
          vertexShader: this.props.material.vertexShader,
          fragmentShader: this.props.material.fragmentShader,
          uniforms: this.uniforms,
        });
        this.geometry = new THREE.PlaneGeometry(2, 2);
        this.plane = new THREE.Mesh(this.geometry, this.material);
        this.scene.add(this.plane);
      }
      update() {
        if (!Common.renderer) return;
        Common.renderer.setRenderTarget(this.props.output ?? null);
        Common.renderer.render(this.scene, this.camera);
        Common.renderer.setRenderTarget(null);
      }
    }

    class Advection extends ShaderPass {
      line: THREE.LineSegments | null = null;
      constructor(props: {
        cellScale: THREE.Vector2;
        fboSize: THREE.Vector2;
        dt: number;
        src: THREE.WebGLRenderTarget;
        dst: THREE.WebGLRenderTarget;
      }) {
        super({
          material: {
            vertexShader: face_vert,
            fragmentShader: advection_frag,
            uniforms: {
              boundarySpace: { value: props.cellScale },
              px: { value: props.cellScale },
              fboSize: { value: props.fboSize },
              velocity: { value: props.src.texture },
              dt: { value: props.dt },
              isBFECC: { value: true },
            },
          },
          output: props.dst,
        });
        this.uniforms = this.props.material?.uniforms;
        this.init();
      }
      init() {
        super.init();
        if (!this.uniforms) return;
        const boundaryG = new THREE.BufferGeometry();
        const verticesBoundary = new Float32Array([
          -1, -1, 0, -1, 1, 0, -1, 1, 0, 1, 1, 0, 1, 1, 0, 1, -1, 0, 1, -1, 0, -1, -1, 0,
        ]);
        boundaryG.setAttribute("position", new THREE.BufferAttribute(verticesBoundary, 3));
        const boundaryM = new THREE.RawShaderMaterial({
          vertexShader: line_vert,
          fragmentShader: advection_frag,
          uniforms: this.uniforms,
        });
        this.line = new THREE.LineSegments(boundaryG, boundaryM);
        this.line.visible = false;
        this.scene.add(this.line);
      }
      update({ dt, isBounce, BFECC }: { dt?: number; isBounce?: boolean; BFECC?: boolean } = {}) {
        if (!this.uniforms) return;
        if (typeof dt === "number") this.uniforms.dt.value = dt;
        if (typeof isBounce === "boolean" && this.line) this.line.visible = isBounce;
        if (typeof BFECC === "boolean") this.uniforms.isBFECC.value = BFECC;
        super.update();
      }
    }

    class ExternalForce extends ShaderPass {
      mouse: THREE.Mesh | null = null;
      constructor(props: { cellScale: THREE.Vector2; cursor_size: number; dst: THREE.WebGLRenderTarget }) {
        super({ output: props.dst });
        const mouseG = new THREE.PlaneGeometry(1, 1);
        const mouseM = new THREE.RawShaderMaterial({
          vertexShader: mouse_vert,
          fragmentShader: externalForce_frag,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          uniforms: {
            px: { value: props.cellScale },
            force: { value: new THREE.Vector2(0, 0) },
            center: { value: new THREE.Vector2(0, 0) },
            scale: { value: new THREE.Vector2(props.cursor_size, props.cursor_size) },
          },
        });
        this.mouse = new THREE.Mesh(mouseG, mouseM);
        this.scene.add(this.mouse);
      }
      update({
        mouse_force,
        cellScale,
        cursor_size,
      }: { mouse_force?: number; cellScale?: THREE.Vector2; cursor_size?: number } = {}) {
        if (!this.mouse) return;
        const forceX = (Mouse.diff.x / 2) * (mouse_force || 0);
        const forceY = (Mouse.diff.y / 2) * (mouse_force || 0);
        const cell = cellScale ?? new THREE.Vector2(1, 1);
        const cursor = cursor_size || 0;
        const cursorSizeX = cursor * cell.x;
        const cursorSizeY = cursor * cell.y;
        const centerX = Math.min(Math.max(Mouse.coords.x, -1 + cursorSizeX + cell.x * 2), 1 - cursorSizeX - cell.x * 2);
        const centerY = Math.min(Math.max(Mouse.coords.y, -1 + cursorSizeY + cell.y * 2), 1 - cursorSizeY - cell.y * 2);
        const uniforms = (this.mouse.material as THREE.RawShaderMaterial).uniforms;
        uniforms.force.value.set(forceX, forceY);
        uniforms.center.value.set(centerX, centerY);
        uniforms.scale.value.set(cursor, cursor);
        super.update();
      }
    }

    class Viscous extends ShaderPass {
      constructor(props: {
        cellScale: THREE.Vector2;
        boundarySpace: THREE.Vector2;
        viscous: number;
        src: THREE.WebGLRenderTarget;
        dst: THREE.WebGLRenderTarget;
        dst_: THREE.WebGLRenderTarget;
        dt: number;
      }) {
        super({
          material: {
            vertexShader: face_vert,
            fragmentShader: viscous_frag,
            uniforms: {
              boundarySpace: { value: props.boundarySpace },
              velocity: { value: props.src.texture },
              velocity_new: { value: props.dst_.texture },
              v: { value: props.viscous },
              px: { value: props.cellScale },
              dt: { value: props.dt },
            },
          },
          output: props.dst,
          output0: props.dst_,
          output1: props.dst,
        });
        this.init();
      }
      update({ viscous, iterations, dt }: { viscous?: number; iterations?: number; dt?: number } = {}) {
        if (!this.uniforms) return;
        let fboIn: THREE.WebGLRenderTarget | undefined;
        let fboOut: THREE.WebGLRenderTarget | undefined;
        if (typeof viscous === "number") this.uniforms.v.value = viscous;
        for (let i = 0; i < (iterations ?? 0); i++) {
          if (i % 2 === 0) {
            fboIn = this.props.output0;
            fboOut = this.props.output1;
          } else {
            fboIn = this.props.output1;
            fboOut = this.props.output0;
          }
          if (!fboIn || !fboOut) continue;
          this.uniforms.velocity_new.value = fboIn.texture;
          this.props.output = fboOut;
          if (typeof dt === "number") this.uniforms.dt.value = dt;
          super.update();
        }
        return fboOut;
      }
    }

    class Divergence extends ShaderPass {
      constructor(props: {
        cellScale: THREE.Vector2;
        boundarySpace: THREE.Vector2;
        src: THREE.WebGLRenderTarget;
        dst: THREE.WebGLRenderTarget;
        dt: number;
      }) {
        super({
          material: {
            vertexShader: face_vert,
            fragmentShader: divergence_frag,
            uniforms: {
              boundarySpace: { value: props.boundarySpace },
              velocity: { value: props.src.texture },
              px: { value: props.cellScale },
              dt: { value: props.dt },
            },
          },
          output: props.dst,
        });
        this.init();
      }
      update({ vel }: { vel?: THREE.WebGLRenderTarget } = {}) {
        if (this.uniforms && vel) this.uniforms.velocity.value = vel.texture;
        super.update();
      }
    }

    class Poisson extends ShaderPass {
      constructor(props: {
        cellScale: THREE.Vector2;
        boundarySpace: THREE.Vector2;
        src: THREE.WebGLRenderTarget;
        dst: THREE.WebGLRenderTarget;
        dst_: THREE.WebGLRenderTarget;
      }) {
        super({
          material: {
            vertexShader: face_vert,
            fragmentShader: poisson_frag,
            uniforms: {
              boundarySpace: { value: props.boundarySpace },
              pressure: { value: props.dst_.texture },
              divergence: { value: props.src.texture },
              px: { value: props.cellScale },
            },
          },
          output: props.dst,
          output0: props.dst_,
          output1: props.dst,
        });
        this.init();
      }
      update({ iterations }: { iterations?: number } = {}) {
        let pIn: THREE.WebGLRenderTarget | undefined;
        let pOut: THREE.WebGLRenderTarget | undefined;
        for (let i = 0; i < (iterations ?? 0); i++) {
          if (i % 2 === 0) {
            pIn = this.props.output0;
            pOut = this.props.output1;
          } else {
            pIn = this.props.output1;
            pOut = this.props.output0;
          }
          if (!pIn || !pOut) continue;
          if (this.uniforms) this.uniforms.pressure.value = pIn.texture;
          this.props.output = pOut;
          super.update();
        }
        return pOut;
      }
    }

    class Pressure extends ShaderPass {
      constructor(props: {
        cellScale: THREE.Vector2;
        boundarySpace: THREE.Vector2;
        src_p: THREE.WebGLRenderTarget;
        src_v: THREE.WebGLRenderTarget;
        dst: THREE.WebGLRenderTarget;
        dt: number;
      }) {
        super({
          material: {
            vertexShader: face_vert,
            fragmentShader: pressure_frag,
            uniforms: {
              boundarySpace: { value: props.boundarySpace },
              pressure: { value: props.src_p.texture },
              velocity: { value: props.src_v.texture },
              px: { value: props.cellScale },
              dt: { value: props.dt },
            },
          },
          output: props.dst,
        });
        this.init();
      }
      update({ vel, pressure }: { vel?: THREE.WebGLRenderTarget; pressure?: THREE.WebGLRenderTarget } = {}) {
        if (this.uniforms && vel && pressure) {
          this.uniforms.velocity.value = vel.texture;
          this.uniforms.pressure.value = pressure.texture;
        }
        super.update();
      }
    }

    class Simulation {
      options: SimOptions;
      fbos = {} as Record<FboKey, THREE.WebGLRenderTarget>;
      fboSize = new THREE.Vector2();
      cellScale = new THREE.Vector2();
      boundarySpace = new THREE.Vector2();
      advection: Advection;
      externalForce: ExternalForce;
      viscous: Viscous;
      divergence: Divergence;
      poisson: Poisson;
      pressure: Pressure;

      constructor(options?: Partial<SimOptions>) {
        this.options = {
          iterations_poisson: 32,
          iterations_viscous: 32,
          mouse_force: 20,
          resolution: 0.5,
          cursor_size: 100,
          viscous: 30,
          isBounce: false,
          dt: 0.014,
          isViscous: false,
          BFECC: true,
          ...options,
        };
        this.calcSize();
        this.createAllFBO();
        this.advection = new Advection({
          cellScale: this.cellScale,
          fboSize: this.fboSize,
          dt: this.options.dt,
          src: this.fbos.vel_0,
          dst: this.fbos.vel_1,
        });
        this.externalForce = new ExternalForce({
          cellScale: this.cellScale,
          cursor_size: this.options.cursor_size,
          dst: this.fbos.vel_1,
        });
        this.viscous = new Viscous({
          cellScale: this.cellScale,
          boundarySpace: this.boundarySpace,
          viscous: this.options.viscous,
          src: this.fbos.vel_1,
          dst: this.fbos.vel_viscous1,
          dst_: this.fbos.vel_viscous0,
          dt: this.options.dt,
        });
        this.divergence = new Divergence({
          cellScale: this.cellScale,
          boundarySpace: this.boundarySpace,
          src: this.fbos.vel_viscous0,
          dst: this.fbos.div,
          dt: this.options.dt,
        });
        this.poisson = new Poisson({
          cellScale: this.cellScale,
          boundarySpace: this.boundarySpace,
          src: this.fbos.div,
          dst: this.fbos.pressure_1,
          dst_: this.fbos.pressure_0,
        });
        this.pressure = new Pressure({
          cellScale: this.cellScale,
          boundarySpace: this.boundarySpace,
          src_p: this.fbos.pressure_0,
          src_v: this.fbos.vel_viscous0,
          dst: this.fbos.vel_0,
          dt: this.options.dt,
        });
      }
      /** iOS caps render targets at half float; everything else takes full float. */
      static floatType() {
        const isIOS = /(iPad|iPhone|iPod)/i.test(navigator.userAgent);
        return isIOS ? THREE.HalfFloatType : THREE.FloatType;
      }
      createAllFBO() {
        const opts = {
          type: Simulation.floatType(),
          depthBuffer: false,
          stencilBuffer: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping,
        };
        for (const key of FBO_KEYS) {
          this.fbos[key] = new THREE.WebGLRenderTarget(this.fboSize.x, this.fboSize.y, opts);
        }
      }
      calcSize() {
        const width = Math.max(1, Math.round(this.options.resolution * Common.width));
        const height = Math.max(1, Math.round(this.options.resolution * Common.height));
        this.cellScale.set(1 / width, 1 / height);
        this.fboSize.set(width, height);
      }
      resize() {
        this.calcSize();
        for (const key of FBO_KEYS) this.fbos[key].setSize(this.fboSize.x, this.fboSize.y);
      }
      update() {
        if (this.options.isBounce) this.boundarySpace.set(0, 0);
        else this.boundarySpace.copy(this.cellScale);
        this.advection.update({
          dt: this.options.dt,
          isBounce: this.options.isBounce,
          BFECC: this.options.BFECC,
        });
        this.externalForce.update({
          cursor_size: this.options.cursor_size,
          mouse_force: this.options.mouse_force,
          cellScale: this.cellScale,
        });
        let vel: THREE.WebGLRenderTarget = this.fbos.vel_1;
        if (this.options.isViscous) {
          vel =
            this.viscous.update({
              viscous: this.options.viscous,
              iterations: this.options.iterations_viscous,
              dt: this.options.dt,
            }) ?? vel;
        }
        this.divergence.update({ vel });
        const pressure = this.poisson.update({ iterations: this.options.iterations_poisson });
        this.pressure.update({ vel, pressure });
      }
    }

    class Output {
      simulation = new Simulation();
      scene = new THREE.Scene();
      camera = new THREE.Camera();
      material: THREE.RawShaderMaterial;
      constructor() {
        this.material = new THREE.RawShaderMaterial({
          vertexShader: face_vert,
          fragmentShader: color_frag,
          transparent: true,
          depthWrite: false,
          // `color_frag` writes `mix(bgColor, ink, lenv)` against a zero `bgColor`, which is premultiplied
          // for the RGB and `lenv` for the alpha. three's default for a transparent material is
          // straight-alpha blending (`SrcAlpha, OneMinusSrcAlpha`), which would multiply the colour by
          // alpha a second time: the layer then darkens its backdrop almost without tinting it, reading as
          // grey smoke on a white page instead of ink. This pairs the blend equation with what the shader
          // actually wrote.
          premultipliedAlpha: true,
          uniforms: {
            velocity: { value: this.simulation.fbos.vel_0.texture },
            boundarySpace: { value: new THREE.Vector2() },
            palette: { value: paletteTex },
            bgColor: { value: bgVec4 },
            lightMode: { value: lightMode },
          },
        });
        this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
      }
      resize() {
        this.simulation.resize();
      }
      render() {
        if (!Common.renderer) return;
        Common.renderer.setRenderTarget(null);
        Common.renderer.render(this.scene, this.camera);
      }
      update() {
        this.simulation.update();
        this.render();
      }
    }

    class WebGLManager implements LiquidEtherHandle, InteractionClock {
      // Both are built in the constructor rather than as field initializers: a field initializer runs
      // before the constructor body, so `new Output()` there would size the whole solver to a 0x0
      // container and never be told otherwise.
      output: Output;
      autoDriver: AutoDriver;
      lastUserInteraction = performance.now();
      running = false;
      private rafId: number | null = null;
      private _loop = this.loop.bind(this);
      private _resize = this.resize.bind(this);
      private _onVisibility = this.onVisibility.bind(this);
      private wrapper: HTMLElement;

      constructor(props: {
        $wrapper: HTMLElement;
        autoDemo: boolean;
        autoSpeed: number;
        autoIntensity: number;
        takeoverDuration: number;
        autoResumeDelay: number;
        autoRampDuration: number;
      }) {
        this.wrapper = props.$wrapper;
        Common.init(this.wrapper);
        Mouse.init(this.wrapper);
        Mouse.autoIntensity = props.autoIntensity;
        Mouse.takeoverDuration = props.takeoverDuration;
        Mouse.onInteract = () => {
          this.lastUserInteraction = performance.now();
          if (this.autoDriver) this.autoDriver.forceStop();
        };
        this.output = new Output();
        this.autoDriver = new AutoDriver(Mouse, this, {
          enabled: props.autoDemo,
          speed: props.autoSpeed,
          resumeDelay: props.autoResumeDelay,
          rampDuration: props.autoRampDuration,
        });
        if (Common.renderer) this.wrapper.prepend(Common.renderer.domElement);
        window.addEventListener("resize", this._resize);
        document.addEventListener("visibilitychange", this._onVisibility);
      }
      get simulation(): SimulationHandle {
        return this.output.simulation;
      }
      resize() {
        Common.resize(this.wrapper);
        this.output.resize();
      }
      private onVisibility() {
        if (document.hidden) this.pause();
        else this.start();
      }
      render() {
        if (this.autoDriver) this.autoDriver.update();
        Mouse.update();
        Common.update();
        this.output.update();
      }
      loop() {
        if (!this.running) return;
        this.render();
        this.rafId = requestAnimationFrame(this._loop);
      }
      start() {
        if (this.running) return;
        this.running = true;
        this._loop();
      }
      pause() {
        this.running = false;
        if (this.rafId !== null) {
          cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
      }
      dispose() {
        window.removeEventListener("resize", this._resize);
        document.removeEventListener("visibilitychange", this._onVisibility);
        Mouse.dispose();
        if (Common.renderer) {
          const canvas = Common.renderer.domElement;
          canvas.parentNode?.removeChild(canvas);
          Common.renderer.dispose();
          Common.renderer.forceContextLoss();
        }
      }
    }

    container.style.position = container.style.position || "relative";
    container.style.overflow = container.style.overflow || "hidden";

    const webgl = new WebGLManager({
      $wrapper: container,
      autoDemo,
      autoSpeed,
      autoIntensity,
      takeoverDuration,
      autoResumeDelay,
      autoRampDuration,
    });
    webglRef.current = webgl;
    webgl.start();

    // Solving the fluid is wasted work while the hero is scrolled past or the tab is hidden, and a
    // background that only moves when it can be seen is also the cheaper one.
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!webglRef.current) return;
        if (entry.isIntersecting && entry.intersectionRatio > 0 && !document.hidden) {
          webglRef.current.start();
        } else {
          webglRef.current.pause();
        }
      },
      { threshold: [0, 0.01, 0.1] },
    );
    io.observe(container);

    let resizeRaf: number | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => webglRef.current?.resize());
    });
    ro.observe(container);

    return () => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
      io.disconnect();
      ro.disconnect();
      webglRef.current?.dispose();
      webglRef.current = null;
    };
    // The auto-driver props are read once here, to seed the driver, and the effect below owns keeping
    // them current. Listing them would mean a nudge to any of them tears down the renderer and its
    // render targets — which is the one thing this dependency array exists to prevent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteKey, lightMode]);

  // Props other than the palette and `lightMode` reach the simulation in place: the render targets and
  // the renderer survive a tuning change, which is the whole reason this is a second effect.
  useEffect(() => {
    const sim = webglRef.current?.simulation;
    if (!sim) return;
    const previousResolution = sim.options.resolution;
    Object.assign(sim.options, {
      mouse_force: mouseForce,
      cursor_size: cursorSize,
      isViscous,
      viscous,
      iterations_viscous: iterationsViscous,
      iterations_poisson: iterationsPoisson,
      dt,
      BFECC,
      resolution,
      isBounce,
    } satisfies Partial<SimOptions>);
    if (resolution !== previousResolution) sim.resize();

    const driver = webglRef.current?.autoDriver;
    if (driver) {
      driver.enabled = autoDemo;
      driver.speed = autoSpeed;
      driver.resumeDelay = autoResumeDelay;
      driver.rampDurationMs = autoRampDuration * 1000;
      driver.mouse.autoIntensity = autoIntensity;
      driver.mouse.takeoverDuration = takeoverDuration;
    }
  }, [
    mouseForce,
    cursorSize,
    isViscous,
    viscous,
    iterationsViscous,
    iterationsPoisson,
    dt,
    BFECC,
    resolution,
    isBounce,
    autoDemo,
    autoSpeed,
    autoIntensity,
    takeoverDuration,
    autoResumeDelay,
    autoRampDuration,
  ]);

  return (
    <div
      ref={mountRef}
      className={`relative h-full w-full overflow-hidden pointer-events-none touch-none ${className ?? ""}`}
      style={style}
    />
  );
};

export default LiquidEther;
