import type { IkiModel, IkiParameter, IkiPart } from "@iki/format";
import { ParameterStore } from "./parameter-store";
import { multiply, rotate, scale, toMat3, translate } from "./affine";

/**
 * Drives a single `.iki` model on a WebGL2 canvas.
 *
 * v1 scope: parts are solid-color or atlas-sampled textured quads, transformed
 * each frame by their base transform plus the sum of their parameter bindings.
 * `load()` is async — it decodes and uploads textures before swapping the model
 * in. Warp-mesh deformation is a later milestone.
 */
export class IkiPlayer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly quad: WebGLBuffer;
  private readonly uMatrix: WebGLUniformLocation;
  private readonly uColor: WebGLUniformLocation;
  private readonly uUseTexture: WebGLUniformLocation;
  private readonly uTex: WebGLUniformLocation;
  private readonly uUvOffset: WebGLUniformLocation;
  private readonly uUvScale: WebGLUniformLocation;

  private model?: IkiModel;
  private parts: IkiPart[] = [];
  private params = new ParameterStore([]);
  private rafId?: number;
  /** Uploaded textures, index-aligned with `model.textures`; `null` = unusable. */
  private textures: (WebGLTexture | null)[] = [];
  /** Bumped by every `load` and by `destroy`; lets a stale async load bail. */
  private loadGeneration = 0;
  private destroyed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;

    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.uMatrix = getUniform(gl, this.program, "u_matrix");
    this.uColor = getUniform(gl, this.program, "u_color");
    this.uUseTexture = getUniform(gl, this.program, "u_useTexture");
    this.uTex = getUniform(gl, this.program, "u_tex");
    this.uUvOffset = getUniform(gl, this.program, "u_uvOffset");
    this.uUvScale = getUniform(gl, this.program, "u_uvScale");
    this.quad = createUnitQuad(gl, this.program);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Load a model and reset parameters to their defaults. All textures are
   * decoded and uploaded before the model is swapped in — the swap is atomic,
   * so you never see a partially-textured frame. `start()` may be called any
   * time, but nothing renders until the first `load()` resolves. For an
   * embedded `data:` atlas this is near-instant.
   *
   * Individual texture decode/upload failures are non-fatal: they are logged
   * via `console.error`, the affected parts are skipped, and `load()` still
   * resolves. The model is assumed already validated by `@iki/format`.
   */
  async load(model: IkiModel): Promise<void> {
    const { gl } = this;
    const generation = ++this.loadGeneration;

    // v1 decodes `data:` URIs only; external sources are skipped (resolver TBD).
    const sources = model.textures ?? [];
    const decoded = await Promise.allSettled(
      sources.map((tex) => decodeTexture(tex.source)),
    );

    // A newer load() or destroy() superseded us while decoding — bail without
    // creating GL textures or swapping any state.
    if (generation !== this.loadGeneration || this.destroyed) {
      for (const result of decoded) {
        if (result.status === "fulfilled" && result.value) result.value.close();
      }
      return;
    }

    const uploaded: (WebGLTexture | null)[] = decoded.map((result, i) => {
      if (result.status === "rejected") {
        console.error(`Iki: failed to decode textures[${i}]`, result.reason);
        return null;
      }
      const bitmap = result.value;
      // External source was skipped during decode.
      if (!bitmap) return null;

      const texture = gl.createTexture();
      if (!texture) {
        bitmap.close();
        console.error(`Iki: failed to allocate GL texture for textures[${i}]`);
        return null;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bitmap,
      );
      bitmap.close();
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return texture;
    });

    // Release the previous model's textures before adopting the new set.
    for (const texture of this.textures) {
      if (texture) gl.deleteTexture(texture);
    }

    this.model = model;
    this.params = new ParameterStore(model.parameters);
    this.parts = [...model.parts].sort((a, b) => a.order - b.order);
    this.textures = uploaded;
  }

  /** Start the render loop. Safe to call more than once. */
  start(): void {
    if (this.rafId !== undefined) return;
    const loop = (): void => {
      this.renderFrame();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId === undefined) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = undefined;
  }

  /** Set a parameter value (clamped to its range). Unknown ids are ignored. */
  setParameter(id: string, value: number): void {
    this.params.set(id, value);
  }

  /** The model's parameter descriptors, for building UI or host wiring. */
  getParameters(): IkiParameter[] {
    return this.params.list();
  }

  destroy(): void {
    this.stop();
    // Invalidate any in-flight load so it bails before touching GL state.
    this.destroyed = true;
    ++this.loadGeneration;
    const { gl } = this;
    for (const texture of this.textures) {
      if (texture) gl.deleteTexture(texture);
    }
    this.textures = [];
    gl.deleteBuffer(this.quad);
    gl.deleteProgram(this.program);
  }

  private renderFrame(): void {
    const { gl, canvas } = this;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!this.model) return;

    // Fit the logical model canvas into the drawing buffer, preserving aspect,
    // and convert model units to clip space.
    const { width: modelW, height: modelH } = this.model.canvas;
    const fit = Math.min(width / modelW, height / modelH);
    const clipX = (fit * 2) / width;
    const clipY = (fit * 2) / height;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);

    for (const part of this.parts) {
      const texture = part.texture
        ? this.textures[part.texture.index]
        : undefined;
      // A textured part whose slot is null (skipped/failed) draws nothing.
      if (part.texture && !texture) continue;

      const t = this.evaluate(part);
      // clip <- project <- translate <- rotate <- scale(size)
      let m = multiply(scale(clipX, clipY), translate(t.x, t.y));
      m = multiply(m, rotate(t.rotation));
      m = multiply(m, scale(part.width * t.scaleX, part.height * t.scaleY));

      const [r, g, b, a] = part.color;
      gl.uniformMatrix3fv(this.uMatrix, false, toMat3(m));
      gl.uniform4f(this.uColor, r, g, b, a * t.opacity);

      if (part.texture && texture) {
        const { uv } = part.texture;
        gl.uniform1i(this.uUseTexture, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(this.uTex, 0);
        gl.uniform2f(this.uUvOffset, uv.x, uv.y);
        gl.uniform2f(this.uUvScale, uv.width, uv.height);
      } else {
        gl.uniform1i(this.uUseTexture, 0);
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  /** Resolve a part's effective transform from its base plus active bindings. */
  private evaluate(part: IkiPart): Required<
    Pick<IkiPart["transform"], "x" | "y">
  > & {
    rotation: number;
    scaleX: number;
    scaleY: number;
    opacity: number;
  } {
    const base = part.transform;
    const result = {
      x: base.x,
      y: base.y,
      rotation: base.rotation ?? 0,
      scaleX: base.scaleX ?? 1,
      scaleY: base.scaleY ?? 1,
      opacity: base.opacity ?? 1,
    };

    for (const binding of part.bindings ?? []) {
      const t = this.params.normalized(binding.parameter);
      const value = binding.from + (binding.to - binding.from) * t;
      switch (binding.channel) {
        case "translateX":
          result.x += value;
          break;
        case "translateY":
          result.y += value;
          break;
        case "rotate":
          result.rotation += value;
          break;
        case "scaleX":
          result.scaleX += value;
          break;
        case "scaleY":
          result.scaleY += value;
          break;
        case "opacity":
          result.opacity *= value;
          break;
      }
    }

    return result;
  }
}

// --- WebGL plumbing ---------------------------------------------------------
const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
uniform mat3 u_matrix;
uniform vec2 u_uvOffset;
uniform vec2 u_uvScale;
out vec2 v_uv;
void main() {
  // a_pos corners are +/-0.5; lift to 0..1 (y-up), then map into the atlas
  // sub-rect with a single V flip (the only flip in the pipeline).
  vec2 uvLocal = a_pos + 0.5;
  v_uv = vec2(
    u_uvOffset.x + uvLocal.x * u_uvScale.x,
    u_uvOffset.y + (1.0 - uvLocal.y) * u_uvScale.y
  );
  vec3 p = u_matrix * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform vec4 u_color;
uniform bool u_useTexture;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 base = u_useTexture ? texture(u_tex, v_uv) : vec4(1.0);
  outColor = base * u_color;
}`;

/**
 * Decode a texture source into an ImageBitmap, or `null` for an unsupported
 * (non-`data:`) source. v1 fetches `data:` URIs only — never arbitrary URLs.
 */
async function decodeTexture(source: string): Promise<ImageBitmap | null> {
  if (!source.startsWith("data:")) {
    console.warn(
      "Iki: external texture sources are unsupported in v1; skipping",
      source.slice(0, 32),
    );
    return null;
  }
  const blob = await (await fetch(source)).blob();
  return createImageBitmap(blob, {
    imageOrientation: "none",
    premultiplyAlpha: "none",
  });
}

function createUnitQuad(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("failed to allocate quad buffer");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // Unit square centered on the origin, as a triangle strip.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    gl.STATIC_DRAW,
  );
  const loc = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return buffer;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("failed to allocate WebGL program");
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSrc));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log}`);
  }
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("failed to allocate shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function getUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const loc = gl.getUniformLocation(program, name);
  if (!loc) throw new Error(`uniform not found: ${name}`);
  return loc;
}
