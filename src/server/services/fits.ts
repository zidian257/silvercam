import fs from 'node:fs';
import path from 'node:path';
import { BadRequest, Unprocessable } from '@feathersjs/errors';
import type { Params } from '@feathersjs/feathers';
import { paths } from '../../lib/paths.ts';
import { uniquePath } from '../../lib/util.ts';
import { listFits } from '../../modules/fitlib.ts';
import type { ConfigRef } from './config.ts';

// /api/fits FIT 库资源：清单（find）+ 上传入库（create）。
// 上传 body 是原始 .fit 字节（?name= 原始文件名）：app.js 在该路径挂 express.raw，
// create 收到的 data 即 Buffer；入库后立即解析起止时间，解析失败不入库。
export class FitsService {
  configRef: ConfigRef;

  constructor({ configRef }: { configRef: ConfigRef }) {
    this.configRef = configRef;
  }

  async find() {
    return listFits(this.configRef.current);
  }

  async create(data: any, params: Params) {
    const name = path.basename(params.query?.name ?? 'upload.fit');
    if (!name.toLowerCase().endsWith('.fit')) throw new BadRequest('仅接受 .fit 文件');
    const buf = Buffer.isBuffer(data) ? data : Buffer.alloc(0);
    if (!buf.length) throw new BadRequest('空文件');
    const dir = this.configRef.current.fit_library_dir ?? paths.fits;
    fs.mkdirSync(dir, { recursive: true });
    const out = uniquePath(path.join(dir, name));
    fs.writeFileSync(out, buf);
    const fit = listFits(this.configRef.current).find((f) => f.path === out);
    if (!fit) {
      fs.rmSync(out, { force: true });
      throw new Unprocessable('FIT 解析失败（不是有效的 .fit？），未入库');
    }
    return fit;
  }
}
