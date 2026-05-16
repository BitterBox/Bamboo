// ============================================================
// MCP 代码工具 — 纯函数集合
// 从 main.js 提取，供 IPC handler 调用
// ============================================================

const path = require('path');
const fs = require('fs').promises;

// ── TypeScript AST ──────────────────────────────────────────

/** 延迟加载 TypeScript 编译器 API（避免影响启动时间） */
let _ts = null;
function getTS() {
  if (_ts) return _ts;
  try {
    _ts = require('typescript');
    return _ts;
  } catch {
    return null;
  }
}

/** 使用 TypeScript AST 分析代码文件 */
function analyzeCodeWithAST(filePath, content) {
  const ts = getTS();
  if (!ts) {
    return { result: null, error: 'TypeScript 编译器不可用。请将 "typescript" 添加到生产构建的 dependencies 中。' };
  }

  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

  const imports = [];
  const functions = [];
  const classes = [];
  const interfaces = [];
  const typeAliases = [];

  function getLine(node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  }

  function hasModifier(node, kind) {
    return !!(node.modifiers && node.modifiers.some(m => m.kind === kind));
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const mod = node.moduleSpecifier.getText().slice(1, -1);
      const specifiers = [];
      if (node.importClause) {
        if (node.importClause.name) specifiers.push(node.importClause.name.getText());
        if (node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            node.importClause.namedBindings.elements.forEach(el => specifiers.push(el.name.getText()));
          } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            specifiers.push('* as ' + node.importClause.namedBindings.name.getText());
          }
        }
      }
      imports.push({ module: mod, specifiers });

    } else if (ts.isFunctionDeclaration(node) && node.name) {
      const params = node.parameters.map(p =>
        p.name.getText() + (p.type ? ': ' + p.type.getText() : '') + (p.questionToken ? '?' : '')
      );
      functions.push({
        name: node.name.getText(),
        params,
        returnType: node.type ? node.type.getText() : undefined,
        isExported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
        isAsync: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        line: getLine(node),
      });

    } else if (ts.isVariableStatement(node)) {
      const isExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      node.declarationList.declarations.forEach(decl => {
        if (decl.initializer && ts.isArrowFunction(decl.initializer) && decl.name) {
          const fn = decl.initializer;
          const params = fn.parameters.map(p =>
            p.name.getText() + (p.type ? ': ' + p.type.getText() : '') + (p.questionToken ? '?' : '')
          );
          functions.push({
            name: decl.name.getText(),
            params,
            returnType: fn.type ? fn.type.getText() : undefined,
            isExported,
            isAsync: hasModifier(fn, ts.SyntaxKind.AsyncKeyword),
            line: getLine(decl),
          });
        }
      });

    } else if (ts.isClassDeclaration(node) && node.name) {
      const methods = [];
      node.members.forEach(m => {
        if (ts.isMethodDeclaration(m) && m.name) methods.push(m.name.getText());
      });
      classes.push({
        name: node.name.getText(),
        isExported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
        methods,
        line: getLine(node),
      });

    } else if (ts.isInterfaceDeclaration(node)) {
      const members = [];
      node.members.forEach(m => { if (m.name) members.push(m.name.getText()); });
      interfaces.push({
        name: node.name.getText(),
        isExported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
        members,
        line: getLine(node),
      });

    } else if (ts.isTypeAliasDeclaration(node)) {
      typeAliases.push({
        name: node.name.getText(),
        isExported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
        line: getLine(node),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // 圈复杂度
  let cyclomatic = 1;
  function visitComplexity(node) {
    if (
      ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) ||
      ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ||
      ts.isCaseClause(node) || ts.isCatchClause(node) || ts.isConditionalExpression(node)
    ) {
      cyclomatic++;
    }
    if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind;
      if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) {
        cyclomatic++;
      }
    }
    ts.forEachChild(node, visitComplexity);
  }
  visitComplexity(sourceFile);

  const lineCount = content.split('\n').length;
  const out = [];
  out.push(`# 代码分析: ${filePath}`);
  out.push(`总行数: ${lineCount}  |  圈复杂度: ${cyclomatic}`);
  out.push('');

  if (imports.length > 0) {
    out.push('## 导入模块');
    imports.forEach(imp => {
      out.push(`- ${imp.module}${imp.specifiers.length > 0 ? ': ' + imp.specifiers.join(', ') : ''}`);
    });
    out.push('');
  }

  if (functions.length > 0) {
    out.push('## 函数');
    functions.forEach(fn => {
      const mods = [fn.isExported ? 'export' : '', fn.isAsync ? 'async' : ''].filter(Boolean).join(' ');
      out.push(`- ${mods ? mods + ' ' : ''}${fn.name}(${fn.params.join(', ')})${fn.returnType ? ': ' + fn.returnType : ''}  [第${fn.line}行]`);
    });
    out.push('');
  }

  if (classes.length > 0) {
    out.push('## 类');
    classes.forEach(cls => {
      out.push(`- ${cls.isExported ? 'export ' : ''}${cls.name}  [第${cls.line}行]`);
      if (cls.methods.length > 0) out.push(`  方法: ${cls.methods.join(', ')}`);
    });
    out.push('');
  }

  if (interfaces.length > 0) {
    out.push('## 接口');
    interfaces.forEach(iface => {
      out.push(`- ${iface.isExported ? 'export ' : ''}${iface.name}  [第${iface.line}行]`);
      if (iface.members.length > 0) out.push(`  成员: ${iface.members.join(', ')}`);
    });
    out.push('');
  }

  if (typeAliases.length > 0) {
    out.push('## 类型别名');
    typeAliases.forEach(ta => {
      out.push(`- ${ta.isExported ? 'export ' : ''}${ta.name}  [第${ta.line}行]`);
    });
    out.push('');
  }

  return { result: out.join('\n'), error: null };
}

// ── 搜索 ────────────────────────────────────────────────────

/**
 * 将搜索文本转换为正则表达式
 *
 * 支持三种模式（按优先级）：
 * 1. 正则表达式模式：/pattern/flags  例如 /getUser\d+/ 搜索 getUser 后跟数字的内容
 * 2. 通配符模式：支持 *（匹配任意字符序列）和 |（OR 逻辑），例如 "getUser*"、"error|warning"
 * 3. 普通字符串匹配：不含以上特殊符号时，返回 null（使用 indexOf 精确匹配）
 *
 * @param {string} text - 搜索文本
 * @returns {RegExp|null} 正则对象，或 null 表示使用普通字符串匹配
 */
function searchTextToRegex(text) {
  // ── 模式 1：检测 /pattern/flags 正则表达式语法 ──
  const regexSyntaxMatch = text.match(/^\/(.+)\/([dgimsuy]*)$/);
  if (regexSyntaxMatch) {
    try {
      return new RegExp(regexSyntaxMatch[1], regexSyntaxMatch[2]);
    } catch {
      return null; // 正则无效时返回 null，后续回退到普通匹配
    }
  }

  // ── 模式 2：通配符模式（* 和 |）──
  if (!text.includes('*') && !text.includes('|')) {
    return null; // 无需正则，使用普通匹配
  }
  // 转义除 * 和 | 之外的正则特殊字符
  let escaped = text.replace(/[.+?^${}()\[\]\\]/g, '\\$&');
  // 将 * 转换为 .*
  escaped = escaped.replace(/\*/g, '.*');
  // | 保持为 OR 操作符
  try {
    return new RegExp(escaped, '');
  } catch {
    return null;
  }
}

/**
 * 检查文本是否匹配搜索模式（支持正则 /pattern/flags、通配符 * |、以及普通字符串）
 * @param {string} text - 要检查的文本
 * @param {string} searchText - 搜索文本（可含正则 /pattern/flags、通配符 * |、或普通字符串）
 * @returns {{ matched: boolean, matchStr?: string, matchIndex?: number }}
 */
function searchMatch(text, searchText) {
  const regex = searchTextToRegex(searchText);
  if (regex) {
    const match = text.match(regex);
    if (match) {
      return { matched: true, matchStr: match[0], matchIndex: match.index };
    }
    return { matched: false };
  }
  // 普通字符串匹配（不含 * 和 |）
  const idx = text.indexOf(searchText);
  if (idx !== -1) {
    return { matched: true, matchStr: searchText, matchIndex: idx };
  }
  return { matched: false };
}

/**
 * 格式化搜索结果行：普通行直接显示，超长行截取匹配位置前后上下文
 * 兼容 * 和 | 匹配模式
 */
function formatSearchResult(lineNum, line, searchText) {
  const MAX_LINE = 200;
  const CONTEXT = 80;
  const trimmed = line.trimEnd();
  if (trimmed.length <= MAX_LINE) {
    return `第${lineNum}行: ${trimmed}`;
  }
  // 使用 searchMatch 定位匹配位置（兼容正则、* 和 |）
  const matchInfo = searchMatch(trimmed, searchText);
  const matchIdx = matchInfo.matched ? matchInfo.matchIndex : -1;
  if (matchIdx === -1) {
    return `第${lineNum}行: ${trimmed.slice(0, MAX_LINE)}…（行过长，已截断）`;
  }
  const matchLen = (matchInfo.matchStr || searchText).length;
  const start = Math.max(0, matchIdx - CONTEXT);
  const end = Math.min(trimmed.length, matchIdx + matchLen + CONTEXT);
  let preview = '';
  if (start > 0) preview += '…';
  preview += trimmed.slice(start, end);
  if (end < trimmed.length) preview += '…';
  return `第${lineNum}行: ${preview}`;
}

/** 递归收集目录下所有文本文件（同级子目录并行扫描） */
async function collectCodeFiles(dirPath) {
  const SKIP_DIRS = new Set(['node_modules', '.git', '.data', 'dist', '.backups', '.temp', '.vite', 'build', 'coverage', '__pycache__', '.venv', 'venv']);
  // 跳过已知二进制/媒体文件（其余全部视为文本，包括无扩展名文件如 LICENSE、Makefile）
  const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
    '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    '.pyc', '.pyo', '.class', '.o', '.obj',
    '.db', '.sqlite', '.sqlite3', '.mdb',
    '.wasm', '.map']);

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  const subDirPromises = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // 跳过隐藏目录（.开头）
      if (entry.name.startsWith('.')) continue;
      subDirPromises.push(collectCodeFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!BINARY_EXTS.has(ext)) files.push(fullPath);
    }
  }

  // 并行扫描所有同级子目录
  if (subDirPromises.length > 0) {
    const subResults = await Promise.all(subDirPromises);
    for (const sub of subResults) files.push(...sub);
  }

  return files;
}

// ── 重构建议 ────────────────────────────────────────────────

/** 检查函数长度（使用 TypeScript AST） */
function checkFunctionLength(sourceFile, content, ts) {
  const suggestions = [];
  function visit(node) {
    const isFunc = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
    if (isFunc && node.body && ts.isBlock(node.body)) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.body.getStart()).line;
      const end = sourceFile.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      const len = end - start;
      if (len > 40) {
        const name = (node.name && node.name.getText()) || '(匿名)';
        suggestions.push(`- 函数 \`${name}\` 过长（${len} 行，第 ${start + 1} 行），建议拆分`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return suggestions;
}

// ── 模糊匹配 ────────────────────────────────────────────────

/**
 * 计算两个字符串的编辑距离（Levenshtein distance）
 */
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * 在文件中搜索与 oldString 最相似的片段
 */
function findSimilarLines(content, oldString, maxCandidates = 5, maxDistance = 80) {
  const lines = content.split('\n');
  const oldLines = oldString.split('\n');
  const candidates = [];

  if (oldLines.length <= 1) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      if (line.length === 0) continue;
      if (Math.abs(line.length - oldString.length) > maxDistance * 2) continue;
      const dist = levenshteinDistance(line, oldString);
      if (dist <= maxDistance) {
        candidates.push({ line: i + 1, content: lines[i], distance: dist });
      }
    }
  } else {
    const firstLine = oldLines[0];
    const windowSize = oldLines.length;
    const firstLineCandidates = [];
    for (let i = 0; i <= lines.length - windowSize; i++) {
      const line = lines[i].trimEnd();
      if (line.length === 0) continue;
      const dist = levenshteinDistance(line, firstLine);
      const firstLineThreshold = Math.min(20, Math.max(3, Math.floor(firstLine.length * 0.3)));
      if (dist <= firstLineThreshold) {
        firstLineCandidates.push({ line: i + 1, index: i, distance: dist });
      }
    }
    firstLineCandidates.sort((a, b) => a.distance - b.distance);
    const topFirst = firstLineCandidates.slice(0, maxCandidates * 2);

    for (const candidate of topFirst) {
      const startIdx = candidate.index;
      const endIdx = Math.min(startIdx + windowSize, lines.length);
      const windowText = lines.slice(startIdx, endIdx).join('\n');
      const dist = levenshteinDistance(windowText, oldString);
      if (dist <= maxDistance) {
        const preview = windowText.length > 200
          ? windowText.slice(0, 200) + '…'
          : windowText;
        candidates.push({ line: candidate.line, content: preview, distance: dist });
      }
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, maxCandidates);
}

module.exports = {
  getTS,
  analyzeCodeWithAST,
  formatSearchResult,
  searchTextToRegex,
  searchMatch,
  collectCodeFiles,
  checkFunctionLength,
  levenshteinDistance,
  findSimilarLines,
};
