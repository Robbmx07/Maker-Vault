// 3D model viewer: a small WebGL2 renderer with orbit / pan / zoom. No libraries.
// Z is "up", as in slicers. Shading uses the model's own surface angles, so it needs no normals in the file.

import { bounds } from './mesh.js';

const MESH_VS = `#version 300 es
in vec3 p; uniform mat4 view, proj; out vec3 vp;
void main() { vec4 v = view * vec4(p, 1.0); vp = v.xyz; gl_Position = proj * v; }`;
const MESH_FS = `#version 300 es
precision highp float; in vec3 vp; uniform vec3 base; out vec4 o;
void main() {
  vec3 n = normalize(cross(dFdx(vp), dFdy(vp)));
  if (!gl_FrontFacing) n = -n;
  float key = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.6, -0.2, 0.4))), 0.0) * 0.35;
  float amb = 0.30 + 0.12 * n.y;
  o = vec4(base * (amb + 0.75 * key + fill), 1.0);
}`;
const LINE_VS = `#version 300 es
in vec3 p; uniform mat4 view, proj; void main() { gl_Position = proj * view * vec4(p, 1.0); }`;
const LINE_FS = `#version 300 es
precision mediump float; uniform vec4 col; out vec4 o; void main() { o = col; }`;

// --- tiny 4x4 matrix helpers (column-major, like WebGL expects)
const perspective = (fov, aspect, near, far) => { const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far); return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function lookAt(eye, target, up) {
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

export function createViewer(canvas, positions) {
  const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
  if (!gl) throw new Error('This browser cannot show 3D previews (WebGL 2 is not available).');
  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const program = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };
  const meshProg = program(MESH_VS, MESH_FS), lineProg = program(LINE_VS, LINE_FS);

  const b = bounds(positions);
  const center = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
  const radius = Math.max(Math.hypot(...b.size) / 2, 1e-6);
  const buffer = (data, prog) => {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    return { vao, buf };
  };
  const mesh = buffer(positions, meshProg);

  // ground grid on the bed under the model
  const step = 10 ** Math.floor(Math.log10(radius)) ; // 1, 10, 100... mm, whichever suits the size
  const gridLines = [];
  const g0 = [Math.floor((center[0] - radius * 1.6) / step) * step, Math.floor((center[1] - radius * 1.6) / step) * step];
  const g1 = [Math.ceil((center[0] + radius * 1.6) / step) * step, Math.ceil((center[1] + radius * 1.6) / step) * step];
  const z = b.min[2];
  for (let x = g0[0]; x <= g1[0] + 1e-9; x += step) gridLines.push(x, g0[1], z, x, g1[1], z);
  for (let y = g0[1]; y <= g1[1] + 1e-9; y += step) gridLines.push(g0[0], y, z, g1[0], y, z);
  const grid = buffer(new Float32Array(gridLines), lineProg);
  const gridCount = gridLines.length / 3;

  let yaw = -0.7, pitch = 0.5, dist = radius * 2.6;
  let target = center.slice();
  const home = () => { yaw = -0.7; pitch = 0.5; dist = radius * 2.6; target = center.slice(); };
  const setView = (name) => { target = center.slice(); dist = radius * 2.6; if (name === 'top') { yaw = 0; pitch = Math.PI / 2 - 0.001; } else if (name === 'front') { yaw = 0; pitch = 0.001; } else if (name === 'side') { yaw = Math.PI / 2; pitch = 0.001; } else home(); draw(); };

  function matrices() {
    const eye = [target[0] + dist * Math.cos(pitch) * Math.sin(yaw), target[1] - dist * Math.cos(pitch) * Math.cos(yaw), target[2] + dist * Math.sin(pitch)];
    return { view: lookAt(eye, target, [0, 0, 1]), proj: perspective(Math.PI / 4, canvas.width / canvas.height, radius * 0.01, radius * 40) };
  }
  let raf = 0;
  function draw() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0.13, 0.13, 0.14, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      const { view, proj } = matrices();
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'view'), false, view); gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'proj'), false, proj);
      gl.uniform4f(gl.getUniformLocation(lineProg, 'col'), 1, 1, 1, 0.16);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(grid.vao); gl.drawArrays(gl.LINES, 0, gridCount);
      gl.disable(gl.BLEND);
      gl.useProgram(meshProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(meshProg, 'view'), false, view); gl.uniformMatrix4fv(gl.getUniformLocation(meshProg, 'proj'), false, proj);
      gl.uniform3f(gl.getUniformLocation(meshProg, 'base'), 0.93, 0.45, 0.16);
      gl.bindVertexArray(mesh.vao); gl.drawArrays(gl.TRIANGLES, 0, positions.length / 3);
    });
  }

  // --- input: mouse, wheel, touch
  const pointers = new Map();
  let lastPinch = 0, lastMid = null;
  const pan = (dx, dy) => {
    const s = (dist * Math.tan(Math.PI / 8) * 2) / canvas.clientHeight;
    const right = [Math.cos(yaw), Math.sin(yaw), 0];
    const up = [-Math.sin(pitch) * Math.sin(yaw), Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch)];
    for (let k = 0; k < 3; k++) target[k] += (-dx * right[k] + dy * up[k]) * s;
  };
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey }); lastPinch = 0; lastMid = null; });
  canvas.addEventListener('pointerup', (e) => { pointers.delete(e.pointerId); lastPinch = 0; lastMid = null; });
  canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (pointers.size === 1) {
      if (p.button === 2 || p.button === 1 || p.shift) pan(dx, dy);
      else { yaw -= dx * 0.008; pitch = Math.max(-1.55, Math.min(1.55, pitch + dy * 0.008)); }
      p.x = e.clientX; p.y = e.clientY;
    } else if (pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY;
      const [a, c] = [...pointers.values()];
      const d = Math.hypot(a.x - c.x, a.y - c.y), mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
      if (lastPinch) dist = Math.max(radius * 0.2, Math.min(radius * 30, dist * (lastPinch / d)));
      if (lastMid) pan(mid.x - lastMid.x, mid.y - lastMid.y);
      lastPinch = d; lastMid = mid;
    }
    draw();
  });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.max(radius * 0.2, Math.min(radius * 30, dist * Math.exp(e.deltaY * 0.0012))); draw(); }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  draw();

  return {
    size: b.size, triangles: positions.length / 9, setView,
    destroy() { window.removeEventListener('resize', onResize); cancelAnimationFrame(raf); gl.getExtension('WEBGL_lose_context')?.loseContext(); },
  };
}
