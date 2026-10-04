const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** A chosen destination is written sequentially, through a temporary file, never a whole-file Blob. */
class NativeSaves {
  jobs = new Map();
  protectedSources = new Set();
  key(filename) { return process.platform === 'win32' ? filename.toLowerCase() : filename; }
  async protect(filename) {
    if (!path.isAbsolute(filename)) throw new Error('Invalid source path');
    this.protectedSources.add(this.key(await fs.realpath(filename)));
  }
  async ensureNotSource(filename) {
    const resolved = await fs.realpath(filename).catch(error => {
      if (error.code === 'ENOENT') return path.resolve(filename);
      throw error;
    });
    if (this.protectedSources.has(this.key(resolved))) throw new Error('Choose a different destination. The original recording cannot be overwritten.');
  }
  async create(filename) {
    if (this.jobs.size) throw new Error('Finish or cancel the current save before starting another.');
    await this.ensureNotSource(filename);
    const id = randomUUID();
    const temporary = `${filename}.field-restore-${id}.partial`;
    const handle = await fs.open(temporary, 'wx');
    this.jobs.set(id, { filename, temporary, handle, busy: false });
    return id;
  }
  job(id) {
    const job = this.jobs.get(id);
    if (!job || job.busy) throw new Error('Invalid or busy save destination.');
    return job;
  }
  async write(id, data) {
    if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > 8 * 1024 * 1024) throw new Error('Invalid save chunk.');
    const job = this.job(id);
    job.busy = true;
    try {
      const buffer = Buffer.from(data);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await job.handle.write(buffer, offset, buffer.length - offset);
        if (!bytesWritten) throw new Error('Unable to write output file.');
        offset += bytesWritten;
      }
    } finally { job.busy = false; }
  }
  async close(id) {
    const job = this.job(id);
    job.busy = true;
    try {
      await job.handle.sync();
      await job.handle.close();
      await this.ensureNotSource(job.filename);
      await fs.rename(job.temporary, job.filename);
      this.jobs.delete(id);
    } catch (error) {
      await job.handle.close().catch(() => {});
      await fs.unlink(job.temporary).catch(() => {});
      this.jobs.delete(id);
      throw error;
    }
  }
  async abort(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    await job.handle.close().catch(() => {});
    await fs.unlink(job.temporary).catch(() => {});
  }
  async abortAll() { await Promise.all([...this.jobs.keys()].map(id => this.abort(id))); }
}
module.exports = { NativeSaves };