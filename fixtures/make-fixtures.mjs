// 生成端到端验证用合成素材：
//   fixtures/out/activity.fit  —— 10 分钟骑行，1Hz，GPS 圆轨迹 + 心率/功率/踏频/速度/海拔（不含 grade，走重算路径）
//   fixtures/out/DJI_YYYYMMDDHHMMSS.MP4 —— 15s 1080p30，creation_time = FIT 起点 + 60s（本地文件名与 UTC 互证）
//   fixtures/out/identity.cube —— 3D 单位 LUT（验证 lut3d 滤镜链）
//   fixtures/out/fakevol/DCIM/DJI 001/ —— 假相机卷（watch --simulate 用）
import { Encoder, Profile } from '@garmin/fitsdk';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(OUT, { recursive: true });

const FIT_T0_LOCAL = new Date(2026, 8, 6, 10, 0, 0); // 本地时间 2026-09-06 10:00:00
const VIDEO_OFFSET_S = 60;
const FIT_LEN_S = 600;

function makeFit() {
  const enc = new Encoder();
  enc.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: 'activity',
    manufacturer: 'garmin',
    product: 0,
    timeCreated: FIT_T0_LOCAL,
  });
  const R = 0.002; // 圆形轨迹半径（度）
  for (let i = 0; i <= FIT_LEN_S; i++) {
    const t = new Date(FIT_T0_LOCAL.getTime() + i * 1000);
    const a = (i / FIT_LEN_S) * 2 * Math.PI * 2; // 两圈
    const speed = 8 + 4 * Math.sin(i / 20);
    enc.writeMesg({
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: t,
      positionLat: Math.round((31.23 + R * Math.sin(a)) * (2 ** 31 / 180)),
      positionLong: Math.round((121.47 + R * Math.cos(a)) * (2 ** 31 / 180)),
      altitude: 50 + 30 * Math.sin(i / 60),
      heartRate: Math.round(130 + 25 * Math.sin(i / 30)),
      cadence: Math.round(85 + 5 * Math.sin(i / 10)),
      distance: i * 9,
      speed,
      power: Math.round(220 + 60 * Math.sin(i / 15)),
      temperature: 28,
    });
  }
  enc.writeMesg({
    mesgNum: Profile.MesgNum.SESSION,
    timestamp: new Date(FIT_T0_LOCAL.getTime() + FIT_LEN_S * 1000),
    startTime: FIT_T0_LOCAL,
    sport: 'cycling',
    totalElapsedTime: FIT_LEN_S,
  });
  enc.writeMesg({
    mesgNum: Profile.MesgNum.ACTIVITY,
    timestamp: new Date(FIT_T0_LOCAL.getTime() + (FIT_LEN_S + 2) * 1000),
    totalTimerTime: FIT_LEN_S,
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
  });
  const file = path.join(OUT, 'activity.fit');
  fs.writeFileSync(file, enc.close());
  return file;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function makeVideo() {
  const startLocal = new Date(FIT_T0_LOCAL.getTime() + VIDEO_OFFSET_S * 1000);
  const creationUtc = startLocal.toISOString(); // 规范 UTC（QuickTime 口径）
  const name = `DJI_${startLocal.getFullYear()}${pad(startLocal.getMonth() + 1)}${pad(startLocal.getDate())}${pad(startLocal.getHours())}${pad(startLocal.getMinutes())}${pad(startLocal.getSeconds())}.MP4`;
  const file = path.join(OUT, name);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    '-metadata', `creation_time=${creationUtc}`,
    file,
  ]);
  return file;
}

function makeLut() {
  const lines = ['LUT_3D_SIZE 2'];
  for (const b of [0, 1]) for (const g of [0, 1]) for (const r of [0, 1]) lines.push(`${r} ${g} ${b}`);
  const file = path.join(OUT, 'identity.cube');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function makeFakeVol(videoFile) {
  const dir = path.join(OUT, 'fakevol', 'DCIM', 'DJI 001');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(videoFile));
  if (!fs.existsSync(dest)) fs.copyFileSync(videoFile, dest);
  return path.join(OUT, 'fakevol');
}

const fit = makeFit();
const video = makeVideo();
const lut = makeLut();
const fakevol = makeFakeVol(video);
console.log(JSON.stringify({ fit, video, lut, fakevol, video_offset_s: VIDEO_OFFSET_S }, null, 2));
