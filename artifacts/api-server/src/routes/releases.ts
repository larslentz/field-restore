import { Router, type IRouter } from "express";
import { open, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DownloadReleaseFileParams } from "@workspace/api-zod";

// Both dev and production run the bundled artifacts/api-server/dist/index.mjs.
// Resolve against that entry, not the process working directory.
const releaseDirectory = fileURLToPath(new URL(
  process.env.NODE_ENV === "production"
    ? "../../field-restore/dist/public/releases/"
    : "../../field-restore/public/releases/",
  import.meta.url,
));
const safeFilename = DownloadReleaseFileParams.shape.filename
  .refine(value => !value.includes(".."));
const router: IRouter = Router();

router.get("/:filename", async (req, res): Promise<void> => {
  const parsed = safeFilename.safeParse(req.params.filename);
  if (!parsed.success) { res.sendStatus(404); return; }
  const filename = parsed.data;
  let allowedInstaller: string;
  try {
    allowedInstaller = safeFilename.parse(JSON.parse(
      await readFile(join(releaseDirectory, "windows-release.json"), "utf8"),
    ).filename);
  } catch (error) {
    req.log.error({ err: error }, "Release manifest unavailable");
    res.status(503).send("Release download unavailable.");
    return;
  }
  if (![allowedInstaller, "windows-release.json", "SHA256SUMS.txt"].includes(filename)) {
    res.sendStatus(404); return;
  }
  let file;
  try { file = await open(join(releaseDirectory, filename), "r"); }
  catch (error) {
    req.log.error({ err: error }, "Release file unavailable");
    res.status(503).send("Release download unavailable.");
    return;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) { res.sendStatus(404); return; }
    if (filename.endsWith(".exe")) res.attachment(filename);
    res.setHeader("Content-Type", filename.endsWith(".json")
      ? "application/json" : filename.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");
    if (req.method === "HEAD") {
      res.setHeader("Content-Length", stat.size);
      res.end(); return;
    }
    let start = 0, end = stat.size - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      const suffix = range?.[1] === "" ? Number(range[2]) : null;
      start = suffix !== null ? Math.max(0, stat.size - suffix) : Number(range?.[1]);
      end = range?.[1] === "" || range?.[2] === "" ? end : Number(range?.[2]);
      if (!range || (!range[1] && !range[2]) || suffix === 0 ||
          !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || start >= stat.size || end < start) {
        res.setHeader("Content-Range", `bytes */${stat.size}`);
        res.sendStatus(416); return;
      }
      end = Math.min(end, stat.size - 1);
      res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    }
    // Do not set Content-Length on GET: force actual chunked streaming through
    // the publishing proxy instead of its failing large static-file response.
    res.flushHeaders();
    await pipeline(file.createReadStream({ start, end, highWaterMark: 64 * 1024, autoClose: false }), res);
  } catch (error) {
    if (!res.destroyed) {
      req.log.error({ err: error }, "Release stream failed");
      if (!res.headersSent) res.sendStatus(503);
      else res.destroy(error instanceof Error ? error : undefined);
    }
  } finally { await file.close(); }
});

export default router;