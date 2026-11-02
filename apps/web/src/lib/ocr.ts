/**
 * Reads the text of an uploaded document in the browser.
 *
 *  - Digital PDFs (most GST/Udyam/FSSAI certificates): the embedded text layer is read
 *    directly with pdf.js. Exact and instant.
 *  - Photos, scans and scanned PDFs: OCR with Tesseract (WebAssembly). The engine and the
 *    English model are self-hosted under /ocr, so nothing is sent to a third party.
 *
 * Loaded lazily (dynamic import) so the OCR code only downloads when someone picks a file.
 */
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createWorker, type Worker } from 'tesseract.js';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ReadResult {
  text: string;
  method: 'pdf-text' | 'ocr';
  /** 0–100. 100 for a PDF text layer; Tesseract's mean word confidence for OCR. */
  confidence: number;
  ms: number;
}

let workerPromise: Promise<Worker> | null = null;
function ocrWorker() {
  if (!workerPromise) {
    const base = new URL('ocr/', document.baseURI).href;
    workerPromise = createWorker('eng', 1, {
      workerPath: `${base}worker.min.js`,
      corePath: base,
      langPath: base,
      workerBlobURL: false,
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function ocr(image: HTMLCanvasElement | File | Blob) {
  const worker = await ocrWorker();
  const { data } = await worker.recognize(image);
  return { text: data.text, confidence: Math.round(data.confidence) };
}

/** Renders page 1 of a PDF to a canvas at ~200 dpi for OCR. */
async function renderPage(doc: pdfjs.PDFDocumentProxy) {
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2.5 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas;
}

/** Up-scales small photos so Tesseract sees characters at a readable size. */
async function prepareImage(file: File): Promise<HTMLCanvasElement | File> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = bmp.width < 1400 ? Math.min(2.5, 1400 / bmp.width) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function readDocument(file: File): Promise<ReadResult> {
  const started = performance.now();
  const done = (r: Omit<ReadResult, 'ms'>): ReadResult => ({ ...r, ms: Math.round(performance.now() - started) });

  if (file.type === 'application/pdf') {
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const doc = await task.promise;
    try {
      let text = '';
      for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
        const content = await (await doc.getPage(i)).getTextContent();
        // Rebuild lines from the text items' vertical positions.
        let lastY: number | null = null;
        for (const item of content.items) {
          if (!('str' in item)) continue;
          const y = Math.round(item.transform[5]);
          text += lastY !== null && Math.abs(y - lastY) > 2 ? '\n' : ' ';
          text += item.str;
          lastY = y;
        }
        text += '\n';
      }
      if (text.replace(/\s/g, '').length >= 40) return done({ text, method: 'pdf-text', confidence: 100 });
      // No usable text layer: it's a scan inside a PDF.
      const r = await ocr(await renderPage(doc));
      return done({ ...r, method: 'ocr' });
    } finally {
      void task.destroy();
    }
  }

  const r = await ocr(await prepareImage(file));
  return done({ ...r, method: 'ocr' });
}
