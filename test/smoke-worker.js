/* Smoke test: OpenCV + Tesseract inside a nested worker, fully offline. */
importScripts('omni://node/@techstark/opencv-js/dist/opencv.js');
importScripts('omni://node/tesseract.js/dist/tesseract.min.js');
importScripts('omni://app/core/cvbridge.js');
importScripts('omni://app/core/quality.js');
importScripts('omni://app/core/geometry.js');
importScripts('omni://app/core/restore.js');
importScripts('omni://app/core/ocr.js');

self.onmessage = async (e) => {
  const t0 = performance.now();
  const log = (m) => self.postMessage({ type: 'log', m });
  try {
    const cv = await self.CVB.ready();
    log('opencv ready ' + ((performance.now() - t0) / 1000).toFixed(2) + 's');

    const src = self.CVB.fromImageData(e.data.imageData);
    const gray = self.CVB.toGray(src);
    const prof = self.Quality.profile(cv, gray);
    log('profile: tier=' + prof.tier + ' skew=' + prof.skew.toFixed(2) + ' compH=' + prof.componentHeight
      + ' sharp=' + prof.sharpness.toFixed(0) + ' noise=' + prof.noiseSigma.toFixed(2) + ' contrast=' + prof.contrast);

    const norm = self.Geometry.normalize(cv, gray, prof, {});
    log('geometry steps: ' + JSON.stringify(norm.steps));

    const plan = self.Restore.planVariants(prof, 0);
    log('variants: ' + plan.map((p) => p.id + '@' + p.scale).join(', '));
    const variant = self.Restore.buildVariant(cv, norm.mat, prof, plan[0]);
    const bmp = self.CVB.grayToBmp(variant);
    log('variant built ' + variant.cols + 'x' + variant.rows + ' bmp=' + bmp.length);

    const pool = new self.OCR.Pool({
      size: 1,
      langs: 'eng',
      corePath: 'omni://node/tesseract.js-core/',
      workerPath: 'omni://node/tesseract.js/dist/worker.min.js',
      langPath: 'omni://app/vendor/tessdata/best',
    });
    const tOcr = performance.now();
    const data = await pool.recognize(bmp, { psm: '3', dpi: 300 });
    const res = self.OCR.normalizeResult(data, { variant: plan[0].id });
    log('ocr in ' + ((performance.now() - tOcr) / 1000).toFixed(2) + 's conf=' + res.confidence.toFixed(1));

    const orient = await pool.detectOrientation(bmp);
    log('osd: ' + JSON.stringify(orient));

    await pool.terminate();
    src.delete(); gray.delete(); norm.mat.delete(); variant.delete();
    self.postMessage({ type: 'done', text: res.text, conf: res.confidence, lines: res.lines.length, profile: prof });
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.stack || err) });
  }
};
