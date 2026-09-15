// WebGL LUT 实时预览：视频帧经 3D LUT（可两环链式）画到 canvas。
// 为什么视频要走 canvas 而不是直接 <video>：仪表盘 iframe 直接盖在 <video> 上会触发
// Chrome 硬件视频层合成失败（画面全白），盖在 canvas 上则正常。
import type { CubeLut } from './studio.ts';

const VERT = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv = vec2(a_pos.x*.5+.5, .5-a_pos.y*.5); gl_Position = vec4(a_pos,0.,1.); }`;
const FRAG = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 v_uv; out vec4 frag;
uniform sampler2D u_video; uniform sampler3D u_lut0; uniform sampler3D u_lut1;
uniform int u_nluts; uniform vec3 u_s0; uniform vec3 u_o0; uniform vec3 u_s1; uniform vec3 u_o1;
void main(){
  vec3 c = clamp(texture(u_video, v_uv).rgb, 0.0, 1.0);
  if (u_nluts > 0) c = clamp(texture(u_lut0, c * u_s0 + u_o0).rgb, 0.0, 1.0);
  if (u_nluts > 1) c = clamp(texture(u_lut1, c * u_s1 + u_o1).rgb, 0.0, 1.0);
  frag = vec4(c, 1.0);
}`;

export class LutPreviewer {
  declare canvas: HTMLCanvasElement;
  declare gl: WebGL2RenderingContext | null;
  declare prog: WebGLProgram;
  declare videoTex: WebGLTexture | null;
  declare lastT: number;
  declare lutTex: (WebGLTexture | null)[];

  // canvas 不存在或浏览器无 WebGL2 → gl=null，调用方回退到裸 <video>
  constructor(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas!;
    this.gl = null;
    this.lastT = -1;
    this.lutTex = [null, null];
    if (!canvas) return;
    const gl = canvas.getContext('webgl2');
    if (!gl) return;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)!);
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog)!);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const videoTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_video'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_lut0'), 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_lut1'), 2);
    this.gl = gl;
    this.prog = prog;
    this.videoTex = videoTex;
  }

  get available(): boolean {
    return !!this.gl;
  }

  // cubes: parseCube 的结果数组（0/1/2 环，按叠加顺序）
  setLuts(cubes: CubeLut[]): void {
    if (!this.gl) return;
    const { gl, prog } = this;
    for (let slot = 0; slot < Math.min(2, cubes.length); slot++) {
      const cube = cubes[slot];
      const tex = this.lutTex[slot] ?? gl.createTexture();
      this.lutTex[slot] = tex;
      gl.activeTexture(gl.TEXTURE1 + slot);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      const filter = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, cube.size, cube.size, cube.size, 0, gl.RGB, gl.FLOAT, cube.data);
      const sc = cube.dmin.map((d, i) => 1 / (cube.dmax[i] - d)) as [number, number, number];
      const of = cube.dmin.map((d, i) => -d / (cube.dmax[i] - d)) as [number, number, number];
      gl.uniform3f(gl.getUniformLocation(prog, `u_s${slot}`), ...sc);
      gl.uniform3f(gl.getUniformLocation(prog, `u_o${slot}`), ...of);
    }
    gl.uniform1i(gl.getUniformLocation(prog, 'u_nluts'), Math.min(2, cubes.length));
    this.lastT = -1;
  }

  // 每帧调用；内部按 currentTime 去重，seek 途中不画（没解码完的视频帧上传后是空白）
  draw(video: HTMLVideoElement | null | undefined): void {
    if (!this.gl || !video) return;
    if (video.readyState < 2 || video.seeking) return;
    if (Math.abs(video.currentTime - this.lastT) < 0.001) return;
    this.lastT = video.currentTime;
    const { gl } = this;
    const w = Math.min(1920, video.videoWidth || 1920);
    const h = Math.round((w * (video.videoHeight || 1080)) / (video.videoWidth || 1920));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch {
      this.lastT = -1; // 上传失败允许下一帧重试
      return;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
