function multiply4(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] = a[row] * b[column * 4]
        + a[4 + row] * b[column * 4 + 1]
        + a[8 + row] * b[column * 4 + 2]
        + a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'WebGL 셰이더를 준비하지 못했습니다.';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createRenderer(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec3 aPosition;
    uniform mat4 uMvp;
    void main() { gl_Position = uMvp * vec4(aPosition, 1.0); }
  `);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform vec4 uColor;
    void main() { gl_FragColor = uColor; }
  `);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'AR 표시를 준비하지 못했습니다.');
  }

  const segments = 48;
  const vertices = new Float32Array(segments * 3);
  for (let index = 0; index < segments; index++) {
    const angle = index / segments * Math.PI * 2;
    vertices[index * 3] = Math.cos(angle);
    vertices[index * 3 + 1] = 0;
    vertices[index * 3 + 2] = Math.sin(angle);
  }
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  return {
    program, buffer, segments,
    position: gl.getAttribLocation(program, 'aPosition'),
    mvp: gl.getUniformLocation(program, 'uMvp'),
    color: gl.getUniformLocation(program, 'uColor'),
  };
}

export class ArAnchorPreview {
  constructor({ canvas, overlay, message, exitButton, onEnd = () => {} }) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.message = message;
    this.exitButton = exitButton;
    this.onEnd = onEnd;
    this.session = null;
    this.referenceSpace = null;
    this.hitSource = null;
    this.lastHit = null;
    this.lastHitMatrix = null;
    this.anchor = null;
    this.anchorMatrix = null;
    this.gl = null;
    this.renderer = null;
    this.ending = false;
    this.hudTimer = null;
    this.placementId = 0;
    this.handleSelect = (event) => {
      if (!this.session || this.ending) return;
      this.showHud(2400);
      let hit = this.lastHit;
      let matrix = this.lastHitMatrix;
      if (event.frame && this.hitSource) {
        const currentHit = event.frame.getHitTestResults(this.hitSource)[0];
        const pose = currentHit?.getPose(this.referenceSpace);
        if (currentHit && pose) { hit = currentHit; matrix = pose.transform.matrix; }
      }
      void this.placeAnchor(hit, matrix);
    };
    this.handleSessionEnd = () => { void this.cleanup(); };
    this.exitButton.addEventListener('click', () => this.end());
  }

  async start() {
    if (!navigator.xr?.requestSession) throw new Error('이 브라우저는 WebXR AR을 지원하지 않습니다.');
    this.overlay.hidden = false;
    this.overlay.classList.remove('hud-quiet');
    this.message.textContent = '책상 면을 비춰 이동 목표를 둘 위치를 탭하세요. 정리 배치안과는 아직 연결되지 않았어요.';
    try {
      this.session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test', 'dom-overlay'],
        optionalFeatures: ['anchors'],
        domOverlay: { root: this.overlay },
      });
    } catch (error) {
      this.overlay.hidden = true;
      throw error;
    }
    this.session.addEventListener('end', this.handleSessionEnd, { once: true });
    try {
      this.gl = this.canvas.getContext('webgl', { alpha: true, antialias: true, xrCompatible: true });
      if (!this.gl) throw new Error('이 기기에서 AR 그래픽을 시작하지 못했습니다.');
      await this.gl.makeXRCompatible();
      this.renderer = createRenderer(this.gl);
      this.session.updateRenderState({
        baseLayer: new XRWebGLLayer(this.session, this.gl, { alpha: true, antialias: true, depth: true }),
      });
      this.referenceSpace = await this.session.requestReferenceSpace('local');
      const viewerSpace = await this.session.requestReferenceSpace('viewer');
      this.hitSource = await this.session.requestHitTestSource({ space: viewerSpace });
      this.session.addEventListener('select', this.handleSelect);
      this.message.textContent = '책상 면에서 목표 지점을 탭하세요. 이 테스트는 현재 정리 배치안과 미연동입니다.';
      this.showHud(4000);
      this.session.requestAnimationFrame((time, frame) => this.render(time, frame));
    } catch (error) {
      await this.session.end().catch(() => {});
      await this.cleanup();
      throw error;
    }
  }

  async placeAnchor(hit = this.lastHit, matrix = this.lastHitMatrix) {
    const session = this.session;
    if (!session || this.ending) return;
    const placementId = ++this.placementId;
    if (!hit || !matrix) {
      this.message.textContent = '표면을 찾지 못했어요. 책상 면을 천천히 비춘 뒤 다시 탭해 주세요.';
      this.showHud(2800);
      return;
    }
    let nextAnchor = null;
    if (hit.createAnchor && session.enabledFeatures?.includes('anchors')) {
      try {
        nextAnchor = await hit.createAnchor();
      } catch {
        // Use the hit-test pose in the session-local reference space if native anchors fail.
      }
    }
    if (this.session !== session || this.ending || placementId !== this.placementId) {
      nextAnchor?.delete?.();
      return;
    }
    this.anchor?.delete?.();
    this.anchor = nextAnchor;
    this.anchorMatrix = nextAnchor ? null : new Float32Array(matrix);
    this.message.textContent = '위치 고정됨 · 카메라를 움직여 확인한 뒤 종료하세요. 종료 후 카메라를 원래 방향으로 돌려주세요.';
    this.showHud(2600);
  }

  showHud(duration) {
    this.overlay.classList.remove('hud-quiet');
    clearTimeout(this.hudTimer);
    this.hudTimer = setTimeout(() => this.overlay.classList.add('hud-quiet'), duration);
  }

  render(_time, frame) {
    if (!this.session || this.ending) return;
    this.session.requestAnimationFrame((time, nextFrame) => this.render(time, nextFrame));
    const pose = frame.getViewerPose(this.referenceSpace);
    if (!pose) return;
    const gl = this.gl;
    const layer = this.session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.lastHit = null;
    this.lastHitMatrix = null;
    if (this.hitSource) {
      const hits = frame.getHitTestResults(this.hitSource);
      if (hits.length) {
        const hitPose = hits[0].getPose(this.referenceSpace);
        if (hitPose) {
          this.lastHit = hits[0];
          this.lastHitMatrix = new Float32Array(hitPose.transform.matrix);
        }
      }
    }

    for (const view of pose.views) {
      const viewport = layer.getViewport(view);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);

      const viewMatrix = view.transform.inverse.matrix;
      if (this.lastHitMatrix && !this.anchor && !this.anchorMatrix) {
        this.drawRing(view.projectionMatrix, viewMatrix, this.lastHitMatrix, .055, [1, .78, .28, .95]);
      }
      let placedMatrix = this.anchorMatrix;
      if (this.anchor) placedMatrix = frame.getPose(this.anchor.anchorSpace, this.referenceSpace)?.transform.matrix || null;
      if (placedMatrix) this.drawRing(view.projectionMatrix, viewMatrix, placedMatrix, .095, [.54, .84, .56, .98]);
    }
  }

  drawRing(projection, view, model, radius, color) {
    const gl = this.gl;
    const renderer = this.renderer;
    gl.useProgram(renderer.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.buffer);
    gl.enableVertexAttribArray(renderer.position);
    gl.vertexAttribPointer(renderer.position, 3, gl.FLOAT, false, 0, 0);
    const scaledModel = new Float32Array(model);
    // Keep the marker parallel to the detected surface and give it a tiny normal offset.
    scaledModel[0] *= radius; scaledModel[1] *= radius; scaledModel[2] *= radius;
    scaledModel[4] *= radius; scaledModel[5] *= radius; scaledModel[6] *= radius;
    scaledModel[8] *= radius; scaledModel[9] *= radius; scaledModel[10] *= radius;
    scaledModel[13] += .008;
    gl.uniformMatrix4fv(renderer.mvp, false, multiply4(projection, multiply4(view, scaledModel)));
    gl.uniform4fv(renderer.color, color);
    gl.lineWidth(4);
    gl.drawArrays(gl.LINE_LOOP, 0, renderer.segments);
  }

  async end() {
    if (!this.session || this.ending) return;
    this.ending = true;
    await this.session.end();
  }

  async cleanup() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.ending = false;
    this.placementId++;
    session.removeEventListener('select', this.handleSelect);
    this.hitSource?.cancel?.();
    this.anchor?.delete?.();
    this.hitSource = null;
    this.anchor = null;
    this.anchorMatrix = null;
    this.lastHit = null;
    this.lastHitMatrix = null;
    clearTimeout(this.hudTimer);
    this.hudTimer = null;
    this.overlay.hidden = true;
    this.onEnd();
  }
}
