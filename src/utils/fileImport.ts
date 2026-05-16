import * as pdfjsLib from 'pdfjs-dist';
import JSZip from 'jszip';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

const TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.csv', '.json', '.xml', '.html', '.htm',
  '.js', '.ts', '.jsx', '.tsx', '.css', '.scss', '.less',
  '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.rb', '.sh',
  '.yaml', '.yml', '.toml', '.ini', '.env', '.log',
];

export const ACCEPT_TYPES = ['.pdf', '.pptx', ...TEXT_EXTENSIONS].join(',');

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve((e.target?.result as string) ?? '');
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file, 'utf-8');
  });
}

async function readPdfFile(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    parts.push(pageText);
  }
  return parts.join('\n');
}

/**
 * 在 XML 字符串中查找指定标签的匹配闭合位置（支持嵌套同名标签）
 */
function findMatchingClose(xml: string, tag: string, startIdx: number): number {
  const openTag = `<${tag}`;
  const closeTag = `</${tag}>`;
  let depth = 1;
  let pos = startIdx + openTag.length;
  while (depth > 0 && pos < xml.length) {
    const nextOpen = xml.indexOf(openTag, pos);
    const nextClose = xml.indexOf(closeTag, pos);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + openTag.length;
    } else {
      depth--;
      if (depth === 0) return nextClose;
      pos = nextClose + closeTag.length;
    }
  }
  return -1;
}

/**
 * 读取 .pptx 文件：
 *   PPTX 是 ZIP 包，内含 ppt/slides/slide*.xml，
 *   提取所有 <a:t> 标签文本，按幻灯片编号排序拼接。
 *   不支持旧版 .ppt（二进制 OLE 格式），可提示用户另存为 .pptx。
 */
async function readPptxFile(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // 收集所有 slide XML 文件，按编号排序
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/i)![1], 10);
      const nb = parseInt(b.match(/slide(\d+)/i)![1], 10);
      return na - nb;
    });

  // 获取幻灯片总尺寸（用于判断居中、宽元素等）
  let slideW = 0;
  let slideH = 0;
  try {
    const presXml = await zip.files['ppt/presentation.xml'].async('string');
    const szMatch = presXml.match(/<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/);
    if (szMatch) {
      slideW = parseInt(szMatch[1], 10);
      slideH = parseInt(szMatch[2], 10);
    }
  } catch { /* 尺寸获取失败则降级 */ }

  // ── 阈值（EMU 单位，1 inch = 914400）──────────────
  const BAND_GAP = 914400;      // Y 差 > 1 inch → 不同区域
  const COL_GAP = 457200;       // X 差 > 0.5 inch → 不同列
  const WIDE_RATIO = 0.55;      // 宽度 > 55% 幻灯片宽 → 宽元素
  const CENTER_TOL = 0.18;      // 偏离中心 < 18% 幻灯片宽 → 居中

  const parts: string[] = [];
  for (const slideName of slideFiles) {
    const xmlText = await zip.files[slideName].async('string');
    const slideNum = slideFiles.indexOf(slideName) + 1;

    // ── 收集元素（每形状一个元素，内部段落用换行连接）──
    interface Elem {
      text: string; type: 'text' | 'image';
      x: number; y: number; cx: number; cy: number;
    }
    const elements: Elem[] = [];
    const shapeRegex = /<(p:sp|p:pic|p:grpSp)\b/g;
    let m;
    while ((m = shapeRegex.exec(xmlText)) !== null) {
      const tag = m[1];
      const startIdx = m.index;
      const endIdx =
        tag === 'p:sp' ? xmlText.indexOf('</p:sp>', startIdx) :
        tag === 'p:pic' ? xmlText.indexOf('</p:pic>', startIdx) :
        findMatchingClose(xmlText, 'p:grpSp', startIdx);
      if (endIdx === -1) continue;

      const block = xmlText.slice(
        startIdx,
        endIdx + (tag === 'p:sp' ? 7 : tag === 'p:pic' ? 8 : 10),
      );
      const offMatch = block.match(/<a:off\s+x="(\d+)"\s+y="(\d+)"/);
      const extMatch = block.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
      const x = offMatch ? parseInt(offMatch[1], 10) : 0;
      const y = offMatch ? parseInt(offMatch[2], 10) : 0;
      const cx = extMatch ? parseInt(extMatch[1], 10) : 0;
      const cy = extMatch ? parseInt(extMatch[2], 10) : 0;

      if (tag === 'p:pic') {
        elements.push({ text: '[图片]', type: 'image', x, y, cx, cy });
        continue;
      }

      // 按段落 <a:p> 提取文本，段间用换行连接
      // 段内遇到 <a:br/> 也插入换行
      const pRegex = /<a:p\b[\s\S]*?<\/a:p>/g;
      const paras: string[] = [];
      let pm;
      while ((pm = pRegex.exec(block)) !== null) {
        const segments = pm[0].split(/<a:br\b[^>]*\/?>/);
        const lines: string[] = [];
        for (const seg of segments) {
          const tRegex = /<a:t[^>]*>([^<]*)<\/a:t>/g;
          const runs: string[] = [];
          let tm;
          while ((tm = tRegex.exec(seg)) !== null) {
            const t = tm[1].trim();
            if (t) runs.push(t);
          }
          if (runs.length > 0) lines.push(runs.join(''));
        }
        if (lines.length > 0) paras.push(lines.join('\n'));
      }
      if (paras.length > 0) {
        elements.push({ text: paras.join('\n'), type: 'text', x, y, cx, cy });
      }
    }
    if (elements.length === 0) continue;

    // ── Y 轴两级聚类 ─────────────────────────────
    // 第一级：大间隙（1 inch）分大区
    elements.sort((a, b) => a.y - b.y);
    const majorBands: Elem[][] = [];
    let curMajor: Elem[] = [elements[0]];
    for (let i = 1; i < elements.length; i++) {
      if (elements[i].y - curMajor[0].y > BAND_GAP) {
        majorBands.push(curMajor);
        curMajor = [elements[i]];
      } else {
        curMajor.push(elements[i]);
      }
    }
    majorBands.push(curMajor);

    // 第二级：小间隙（0.3 inch）在大区内再拆分
    const SUB_GAP = 274320;
    const bands: Elem[][] = [];
    for (const mBand of majorBands) {
      if (mBand.length <= 1) { bands.push(mBand); continue; }
      let curSub: Elem[] = [mBand[0]];
      for (let i = 1; i < mBand.length; i++) {
        if (mBand[i].y - curSub[0].y > SUB_GAP) {
          bands.push(curSub);
          curSub = [mBand[i]];
        } else {
          curSub.push(mBand[i]);
        }
      }
      bands.push(curSub);
    }

    // ── 区域描述 ─────────────────────────────────────
    const lines: string[] = [];
    let titleCount = 0; // 顶层宽居中元素计数：第1个→标题，后续→副标题
    for (const band of bands) {
      const topY = band[0].y;
      const posLabel =
        topY < slideH * 0.25 ? '顶部' :
        topY > slideH * 0.70 ? '底部' : '中部';

      // X 轴聚类：同一行内分栏
      band.sort((a, b) => a.x - b.x);
      const cols: Elem[][] = [];
      let curCol: Elem[] = [band[0]];
      for (let i = 1; i < band.length; i++) {
        if (band[i].x - curCol[0].x > COL_GAP) {
          cols.push(curCol);
          curCol = [band[i]];
        } else {
          curCol.push(band[i]);
        }
      }
      cols.push(curCol);

      const colTexts = cols.map((col) =>
        col.map((e) => e.text).join(' '),
      );

      // ── 模式识别 ─────────────────────────────────
      const isWide = (e: Elem) => slideW > 0 && e.cx > slideW * WIDE_RATIO;
      const isCentered = (e: Elem) =>
        slideW > 0 && Math.abs((e.x + e.cx / 2) - slideW / 2) < slideW * CENTER_TOL;
      const hasImage = band.some((e) => e.type === 'image');
      const allText = colTexts.filter((t) => t && !t.startsWith('[图片]'));

      // 标题模式：单宽元素居中 且 位于幻灯片顶部 20% 以内
      if (cols.length === 1 && band.length === 1 && isWide(band[0]) && isCentered(band[0])
          && band[0].y < slideH * 0.2) {
        titleCount++;
        const prefix = titleCount === 1 ? '标题' : '副标题';
        lines.push(`[${prefix}] ${colTexts[0]}`);
        continue;
      }

      // 左右模式：两栏，恰好一图
      if (cols.length === 2 && hasImage && allText.length === 1) {
        const leftIsImg = cols[0].some((e) => e.type === 'image');
        const label = leftIsImg ? '左图右文' : '左文右图';
        lines.push(`[${posLabel}·${label}] ${allText[0]}`);
        continue;
      }

      // 多列模式：≥3 列，每列短文本
      if (cols.length >= 3 && colTexts.every((t) => t.length < 30)) {
        lines.push(`[${posLabel}·${cols.length}列并排] ${colTexts.join(' ┃ ')}`);
        continue;
      }

      // 双列模式
      if (cols.length === 2 && colTexts.every((t) => t.length < 60)) {
        lines.push(`[${posLabel}·双栏] ${colTexts.join(' │ ')}`);
        continue;
      }

      // 列表模式：多个独立元素（非同一形状的段落）、无图、短文本
      if (band.length >= 3 && !hasImage && band.every((e) => e.type === 'text' && e.text.length < 50 && !e.text.includes('\n'))) {
        const sorted = [...band].sort((a, b) => a.y - b.y);
        const listItems = sorted.map((e) => e.text);
        lines.push(`[${posLabel}·列表] · ${listItems.join(' · ')}`);
        continue;
      }

      // 兜底
      if (colTexts.length === 1) {
        lines.push(`[${posLabel}] ${colTexts[0]}`);
      } else {
        lines.push(`[${posLabel}] ${colTexts.join(' │ ')}`);
      }
    }

    if (lines.length > 0) {
      parts.push(`[幻灯片 ${slideNum}]\n${lines.join('\n')}`);
    }
  }

  return parts.join('\n\n');
}

/** 读取文件并返回带标签包裹的消息内容 */
export async function importFile(file: File): Promise<string> {
  const ext = '.' + file.name.split('.').pop()!.toLowerCase();
  let content: string;
  if (ext === '.pdf') {
    content = await readPdfFile(file);
  } else if (ext === '.pptx') {
    content = await readPptxFile(file);
  } else {
    content = await readTextFile(file);
  }
  return `<${file.name}>\n${content}\n</${file.name}>`;
}

/** 检测消息是否为文件消息，返回文件名；否则返回 null */
export function detectFileMessage(content: string): string | null {
  const match = content.match(/^<([^>\n]+)>\n[\s\S]*\n<\/\1>$/);
  return match ? match[1] : null;
}

/** 批量读取多个文件，按输入顺序返回内容数组 */
export async function importFiles(files: File[]): Promise<string[]> {
  const results: string[] = [];
  for (const file of files) {
    results.push(await importFile(file));
  }
  return results;
}
