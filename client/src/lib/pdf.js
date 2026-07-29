const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 3_500_000;
const MAX_PDF_PAGES = 2000;
let pdfModulePromise;

async function loadPdfModule() {
  if (!pdfModulePromise) {
    pdfModulePromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfModule, workerModule]) => {
      pdfModule.GlobalWorkerOptions.workerSrc = workerModule.default;
      return pdfModule;
    });
  }
  return pdfModulePromise;
}

export async function loadPdfDocument(source) {
  const { getDocument } = await loadPdfModule();
  return getDocument(source).promise;
}

function pageText(items) {
  const lines = [];
  let current = "";
  for (const item of items) {
    const value = String(item.str || "").trim();
    if (value) current += `${current ? " " : ""}${value}`;
    if (item.hasEOL && current) {
      lines.push(current);
      current = "";
    }
  }
  if (current) lines.push(current);
  return lines.join("\n").replace(/[ \t]+\n/g, "\n").trim();
}

export async function extractPdfSections(file) {
  if (!(file instanceof File)) throw new Error("PDF 파일을 선택해 주세요.");
  if (file.size > MAX_PDF_BYTES) throw new Error("PDF는 25MB 이하만 업로드할 수 있습니다.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = new TextDecoder("ascii").decode(bytes.slice(0, 5));
  if (signature !== "%PDF-") throw new Error("올바른 PDF 파일이 아닙니다.");

  const { getDocument } = await loadPdfModule();
  const task = getDocument({ data: bytes });
  try {
    const document = await task.promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF는 ${MAX_PDF_PAGES.toLocaleString()}페이지 이하만 분석할 수 있습니다.`);
    }
    const sections = [];
    let extractedChars = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = pageText(content.items);
      if (text) {
        extractedChars += text.length;
        if (extractedChars > MAX_EXTRACTED_CHARS) {
          throw new Error("PDF에서 추출된 텍스트가 너무 큽니다. 더 작은 PDF로 나눠서 올려주세요.");
        }
        sections.push({ section: `페이지 ${pageNumber}`, text });
      }
      page.cleanup();
    }
    if (!sections.length) {
      throw new Error("텍스트를 추출할 수 없는 PDF입니다. 스캔 문서는 현재 분석할 수 없습니다.");
    }
    return { pageCount: document.numPages, sections };
  } finally {
    await task.destroy();
  }
}
