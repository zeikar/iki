import type { IkiModel, IkiParameter, IkiPart, IkiWarp } from "@iki/format";
import { ParameterStore } from "./parameter-store";
import { multiply, rotate, scale, toMat3, translate } from "./affine";
import { evaluateTransform, resolveDeformerWorlds } from "./deform";
import { applyWarps } from "./warp";

/**
 * Outcome of {@link IkiPlayer.load}: the indices into `model.textures` that
 * failed to decode or upload (empty = every declared texture loaded). The model
 * is still swapped in and rendered; parts using a failed texture are skipped.
 * A host can inspect this to detect and report a partial load.
 */
export interface IkiLoadResult {
  failedTextures: number[];
}

/**
 * Engine-internal runtime representation of an uploaded mesh.
 *
 * `rest` is a copy of the authored vertices (Float32Array for direct GL upload);
 * `scratch` is a same-length preallocated buffer for per-frame warp output
 * (Task 4 — this task only sets up the static render path).
 *
 * Index winding convention for an implicit-quad fixture: [0,1,2, 2,1,3]
 * (counter-clockwise from bottom-left). CULL_FACE is disabled, so winding
 * direction is not enforced, but the Task-5 generator must match this.
 */
interface PartMesh {
  position: WebGLBuffer;
  uv: WebGLBuffer;
  index: WebGLBuffer;
  indexCount: number;
  rest: Float32Array;
  /** Preallocated warp output buffer; only present when `warps` is non-empty. */
  scratch?: Float32Array;
  warps?: IkiWarp[];
}

/**
 * Drives a single `.iki` model on a WebGL2 canvas.
 *
 * v1 scope: parts are solid-color or atlas-sampled textured quads or meshes,
 * transformed each frame by their base transform plus the sum of their parameter
 * bindings. `load()` is async — it decodes and uploads textures before swapping
 * the model in. Mesh parts additionally carry per-vertex UV and optional warp
 * keyforms, interpolated each frame on the CPU into a dynamic vertex buffer.
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
  private readonly uUseMeshUv: WebGLUniformLocation;
  private readonly aPos: number;
  private readonly aUv: number;

  private model?: IkiModel;
  private parts: IkiPart[] = [];
  private params = new ParameterStore([]);
  private rafId?: number;
  /** Uploaded textures, index-aligned with `model.textures`; `null` = unusable. */
  private textures: (WebGLTexture | null)[] = [];
  /** Bumped by every `load` and by `destroy`; lets a stale async load bail. */
  private loadGeneration = 0;
  private destroyed = false;
  /**
   * Engine-internal mesh buffers, keyed by the part's INDEX in `this.parts`
   * (NOT by part id — duplicate ids must not swap buffers).
   */
  private partMeshes = new Map<number, PartMesh>();

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
    this.uUseMeshUv = getUniform(gl, this.program, "u_useMeshUv");
    // Fetch attribute locations here so renderFrame can set them explicitly
    // per draw path (mesh vs quad), rather than hiding the wiring in createUnitQuad.
    this.aPos = gl.getAttribLocation(this.program, "a_pos");
    this.aUv = gl.getAttribLocation(this.program, "a_uv");

    this.quad = createUnitQuad(gl);

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
   * resolves — the returned {@link IkiLoadResult} lists the indices of any
   * textures that failed, so a host can detect and report a partial load. The
   * model is assumed already validated by `@iki/format`.
   *
   * Mesh buffer allocation failure IS fatal (unlike per-texture skip) because
   * textures have an `IkiLoadResult.failedTextures` reporting surface and mesh
   * buffers have none — there is no partial-mesh concept in the format.
   */
  async load(model: IkiModel): Promise<IkiLoadResult> {
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
      return { failedTextures: [] };
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

    // Build the new model's render state into LOCAL variables BEFORE adopting
    // anything. Do NOT read this.parts here — it still points at the PREVIOUS
    // model until the adoption swap below; reading it would build buffers for
    // old parts keyed by the new loop's indices.
    const nextParts = [...model.parts].sort((a, b) => a.order - b.order);
    const nextPartMeshes = new Map<number, PartMesh>();

    for (let i = 0; i < nextParts.length; i++) {
      const part = nextParts[i];
      if (!part.mesh) continue;

      const { mesh } = part;
      // Collect buffers as they are created so we can clean up on partial failure.
      const currentPartBuffers: WebGLBuffer[] = [];

      const positionBuf = gl.createBuffer();
      if (!positionBuf) {
        // Nothing created yet for this part — clean up prior parts + textures.
        deletePartMeshBuffers(gl, nextPartMeshes);
        deleteUploadedTextures(gl, uploaded);
        throw new Error("Iki: failed to allocate mesh buffer");
      }
      currentPartBuffers.push(positionBuf);

      const uvBuf = gl.createBuffer();
      if (!uvBuf) {
        // position VBO created but uv VBO failed — delete position to avoid leak.
        for (const b of currentPartBuffers) gl.deleteBuffer(b);
        deletePartMeshBuffers(gl, nextPartMeshes);
        deleteUploadedTextures(gl, uploaded);
        throw new Error("Iki: failed to allocate mesh buffer");
      }
      currentPartBuffers.push(uvBuf);

      const indexBuf = gl.createBuffer();
      if (!indexBuf) {
        // position + uv created but index failed — delete both.
        for (const b of currentPartBuffers) gl.deleteBuffer(b);
        deletePartMeshBuffers(gl, nextPartMeshes);
        deleteUploadedTextures(gl, uploaded);
        throw new Error("Iki: failed to allocate mesh buffer");
      }

      // All three buffers allocated — upload data.
      const rest = new Float32Array(mesh.vertices);
      // Only allocate scratch and use DYNAMIC_DRAW when this part has warps;
      // warp-less static meshes never morph and don't need per-frame re-upload.
      const hasWarps = (part.warps?.length ?? 0) > 0;
      const scratch = hasWarps
        ? new Float32Array(mesh.vertices.length)
        : undefined;

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        rest,
        hasWarps ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW,
      );

      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array(mesh.uvs),
        gl.STATIC_DRAW,
      );

      // Vertex count is validator-capped at 65536, so Uint16 cannot wrap.
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
      gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        new Uint16Array(mesh.indices),
        gl.STATIC_DRAW,
      );

      nextPartMeshes.set(i, {
        position: positionBuf,
        uv: uvBuf,
        index: indexBuf,
        indexCount: mesh.indices.length,
        rest,
        scratch,
        warps: part.warps,
      });
    }

    // Atomic adoption: release the previous model's part-mesh buffers and textures,
    // then adopt the new model's state in a single block so the render loop
    // never sees a half-adopted model.
    deletePartMeshBuffers(gl, this.partMeshes);
    for (const texture of this.textures) {
      if (texture) gl.deleteTexture(texture);
    }

    this.model = model;
    this.params = new ParameterStore(model.parameters);
    this.parts = nextParts;
    this.partMeshes = nextPartMeshes;
    this.textures = uploaded;

    return {
      failedTextures: uploaded.flatMap((t, i) => (t === null ? [i] : [])),
    };
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
    deletePartMeshBuffers(gl, this.partMeshes);
    this.partMeshes = new Map();
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

    const deformerWorlds =
      this.model.deformers && this.model.deformers.length > 0
        ? resolveDeformerWorlds(this.model.deformers, this.params)
        : undefined;

    for (let index = 0; index < this.parts.length; index++) {
      const part = this.parts[index];
      const texture = part.texture
        ? this.textures[part.texture.index]
        : undefined;
      // A textured part whose slot is null (skipped/failed) draws nothing.
      if (part.texture && !texture) continue;

      const t = this.evaluate(part);
      // clip <- project <- [deformer?] <- translate <- rotate <- scale(size)
      let m: ReturnType<typeof multiply>;
      if (part.deformer !== undefined) {
        const dWorld = deformerWorlds!.get(part.deformer);
        if (!dWorld) {
          throw new Error(
            `part "${part.id}" references unknown deformer "${part.deformer}"`,
          );
        }
        m = multiply(
          multiply(scale(clipX, clipY), dWorld),
          translate(t.x, t.y),
        );
      } else {
        m = multiply(scale(clipX, clipY), translate(t.x, t.y));
      }
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

      if (part.mesh) {
        // --- Mesh draw path ---
        const pm = this.partMeshes.get(index);
        if (!pm) {
          // Impossible after the fatal-allocation rule in load(); throwing rather
          // than skipping matches the existing unknown-deformer-parent throw in
          // deform.ts and ensures engine bugs are never silently hidden.
          throw new Error(`Iki: mesh buffers missing for part "${part.id}"`);
        }

        gl.uniform1i(this.uUseMeshUv, 1);

        // For warped meshes, compute morphed positions and upload to the
        // DYNAMIC_DRAW VBO. Warp-less meshes skip this — their VBO already
        // holds `rest` from load().
        if (pm.warps && pm.warps.length > 0) {
          // scratch is always allocated when warps is non-empty (see load())
          applyWarps(pm.rest, pm.warps, this.params, pm.scratch!);
          gl.bindBuffer(gl.ARRAY_BUFFER, pm.position);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, pm.scratch!);
        }

        // Position VBO (DYNAMIC_DRAW — morphed for warped parts, rest otherwise).
        gl.bindBuffer(gl.ARRAY_BUFFER, pm.position);
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

        // UV VBO (STATIC_DRAW — mesh UVs are passed straight through, no flip).
        gl.bindBuffer(gl.ARRAY_BUFFER, pm.uv);
        gl.enableVertexAttribArray(this.aUv);
        gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pm.index);
        gl.drawElements(gl.TRIANGLES, pm.indexCount, gl.UNSIGNED_SHORT, 0);
      } else {
        // --- Implicit-quad draw path ---
        // Disable a_uv so no stale mesh UV buffer from a preceding mesh part is
        // sourced. The quad shader branch derives UV from a_pos, not a_uv.
        gl.uniform1i(this.uUseMeshUv, 0);
        gl.disableVertexAttribArray(this.aUv);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
  }

  /** Resolve a part's effective transform from its base plus active bindings. */
  private evaluate(part: IkiPart): ReturnType<typeof evaluateTransform> {
    return evaluateTransform(part.transform, part.bindings, this.params);
  }
}

// --- WebGL plumbing ---------------------------------------------------------
const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform mat3 u_matrix;
uniform vec2 u_uvOffset;
uniform vec2 u_uvScale;
uniform bool u_useMeshUv;
out vec2 v_uv;
void main() {
  if (u_useMeshUv) {
    // Mesh path: UVs are already top-left atlas-space; pass straight through,
    // no flip (the only flip in the pipeline lives in the quad branch below).
    v_uv = a_uv;
  } else {
    // Quad path: a_pos corners are +/-0.5; lift to 0..1 (y-up), then map into
    // the atlas sub-rect with a single V flip so the result is top-left UVs.
    vec2 uvLocal = a_pos + 0.5;
    v_uv = vec2(
      u_uvOffset.x + uvLocal.x * u_uvScale.x,
      u_uvOffset.y + (1.0 - uvLocal.y) * u_uvScale.y
    );
  }
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

/** Create the shared unit-quad position VBO (centered, triangle-strip). */
function createUnitQuad(gl: WebGL2RenderingContext): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("failed to allocate quad buffer");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // Unit square centered on the origin, as a triangle strip.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    gl.STATIC_DRAW,
  );
  // Attribute pointers are set explicitly in renderFrame per draw path;
  // createUnitQuad only owns buffer allocation and data upload.
  return buffer;
}

/** Delete all position/uv/index buffers stored in a PartMesh map. */
function deletePartMeshBuffers(
  gl: WebGL2RenderingContext,
  meshes: Map<number, PartMesh>,
): void {
  for (const pm of meshes.values()) {
    gl.deleteBuffer(pm.position);
    gl.deleteBuffer(pm.uv);
    gl.deleteBuffer(pm.index);
  }
}

/** Delete all non-null textures from an uploaded texture array. */
function deleteUploadedTextures(
  gl: WebGL2RenderingContext,
  textures: (WebGLTexture | null)[],
): void {
  for (const texture of textures) {
    if (texture) gl.deleteTexture(texture);
  }
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
