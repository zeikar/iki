import type { IkiModel, IkiParameter, IkiPart } from "@iki/format";
import { ParameterStore } from "./parameter-store";
import { multiply, rotate, scale, toMat3, translate } from "./affine";

/**
 * Drives a single `.iki` model on a WebGL2 canvas.
 *
 * v1 scope: parts are solid-color quads, transformed each frame by their base
 * transform plus the sum of their parameter bindings. This proves the full
 * parameter -> transform -> pixels pipeline. Texture sampling and warp-mesh
 * deformation are the next milestones; the public surface here stays stable.
 */
export class IkiPlayer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly quad: WebGLBuffer;
  private readonly uMatrix: WebGLUniformLocation;
  private readonly uColor: WebGLUniformLocation;

  private model?: IkiModel;
  private parts: IkiPart[] = [];
  private params = new ParameterStore([]);
  private rafId?: number;

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
    this.quad = createUnitQuad(gl, this.program);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Load a model and reset parameters to their defaults. */
  load(model: IkiModel): void {
    this.model = model;
    this.params = new ParameterStore(model.parameters);
    this.parts = [...model.parts].sort((a, b) => a.order - b.order);
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
    const { gl } = this;
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
      const t = this.evaluate(part);
      // clip <- project <- translate <- rotate <- scale(size)
      let m = multiply(scale(clipX, clipY), translate(t.x, t.y));
      m = multiply(m, rotate(t.rotation));
      m = multiply(m, scale(part.width * t.scaleX, part.height * t.scaleY));

      const [r, g, b, a] = part.color;
      gl.uniformMatrix3fv(this.uMatrix, false, toMat3(m));
      gl.uniform4f(this.uColor, r, g, b, a * t.opacity);
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
void main() {
  vec3 p = u_matrix * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}`;

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
