// ============================================================
// Python 沙箱执行引擎
// 在隔离的临时目录中执行 Python 代码，自动检测 Conda 环境
//
// 说明：
//   - 不依赖 conda activate（直接调用指定环境的 python 可执行文件）
//   - 4 层降级策略定位 Conda 环境路径
//   - 每次执行在独立 uuid 目录中完成，执行后自动清理
//   - stdout 限制 50000 词，防止 LLM 上下文溢出
// ============================================================

const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');

// ── 常量 ──────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_SEC = 30;      // 默认超时 30 秒
const MAX_TIMEOUT_SEC = 120;         // 最大超时 120 秒
const SANDBOX_DIR_NAME = '.python-sandbox';
const MAX_OUTPUT_WORDS = 50000;      // stdout 最大词数，超出截断

// ── 辅助：检查文件是否存在 ──────────────────────────────────
async function fileExists(filePath) {
  try {
    await fs.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ── 辅助：单词计数（兼容 CJK） ──────────────────────────────
function countWords(text) {
  const SAFE_LIMIT = 200_000;
  const limit = Math.min(text.length, SAFE_LIMIT);
  let count = 0;
  let inWord = false;
  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5A) ||
        (code >= 0x61 && code <= 0x7A) ||
        code === 0x5F) {
      if (!inWord) { count++; inWord = true; }
    } else {
      inWord = false;
      if ((code >= 0x4E00 && code <= 0x9FFF) ||
          (code >= 0x3040 && code <= 0x309F) ||
          (code >= 0x30A0 && code <= 0x30FF) ||
          (code >= 0xAC00 && code <= 0xD7AF)) {
        count++;
      }
    }
  }
  return count;
}

// ── 辅助：按词数截断文本 ────────────────────────────────────
function truncateByWords(text, maxWords) {
  if (text.length === 0) return { text: '', words: 0, truncated: false };
  const totalWords = countWords(text);
  if (totalWords <= maxWords) return { text, words: totalWords, truncated: false };

  // 按比例估算截断位置
  const estimatedPos = Math.floor((maxWords / totalWords) * text.length);
  let cutPos = Math.min(estimatedPos, text.length);

  // 向前找最近的换行
  while (cutPos > 0 && text[cutPos] !== '\n' && cutPos > estimatedPos - 100) cutPos--;
  if (cutPos <= 0 || cutPos <= estimatedPos - 100) {
    cutPos = estimatedPos;
  }

  const result = text.slice(0, cutPos);
  return { text: result, words: countWords(result), truncated: true };
}

// ── 辅助：执行命令并捕获输出 ────────────────────────────────
function execCommand(command, args = [], timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `exit code ${code}`));
    });
    child.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════
// Conda 环境检测引擎（4 层降级策略）
// ══════════════════════════════════════════════════════════════

/**
 * 解析 Python 解释器的绝对路径
 *
 * 4 层降级策略：
 *   1. CONDA_PREFIX 环境变量（当前激活的环境）
 *   2. CONDA_HOME 环境变量
 *   3. conda info --json 命令输出
 *   4. 常见安装路径遍历
 *
 * @param {string|null} envName - Conda 环境名称，null 表示使用系统 Python
 * @returns {Promise<{ pythonPath: string, envType: 'conda'|'system' }>}
 */
async function resolvePythonPath(envName) {
  const pyExe = process.platform === 'win32' ? 'python.exe' : 'python';
  const binDir = process.platform === 'win32' ? '' : 'bin';

  if (!envName || envName.trim() === '') {
    // ── 不指定环境 → 使用系统 PATH 中的 python ──
    return { pythonPath: pyExe, envType: 'system' };
  }

  // ── 第 1 层：CONDA_PREFIX（当前激活的环境）──
  if (process.env.CONDA_PREFIX) {
    // CONDA_PREFIX 指向当前激活的环境（如 ~/anaconda3/envs/py310），
    // 上一级目录即为 conda 的 envs 目录
    const condaRoot = path.dirname(process.env.CONDA_PREFIX);
    const candidate = path.join(condaRoot, envName, binDir, pyExe);
    if (await fileExists(candidate)) {
      return { pythonPath: candidate, envType: 'conda' };
    }
  }

  // ── 第 2 层：CONDA_HOME ──
  if (process.env.CONDA_HOME) {
    const candidate = path.join(process.env.CONDA_HOME, 'envs', envName, binDir, pyExe);
    if (await fileExists(candidate)) {
      return { pythonPath: candidate, envType: 'conda' };
    }
  }

  // ── 第 3 层：conda info --json ──
  try {
    // 注意：这里用系统 PATH 中的 conda（不是特定环境的），
    // conda info 不依赖激活状态
    const raw = await execCommand('conda', ['info', '--json'], 8_000);
    const info = JSON.parse(raw);
    if (info.conda_prefix) {
      const candidate = path.join(info.conda_prefix, 'envs', envName, binDir, pyExe);
      if (await fileExists(candidate)) {
        return { pythonPath: candidate, envType: 'conda' };
      }
    }
  } catch (_e) {
    // conda 命令不可用，静默继续下一层
  }

  // ── 第 4 层：常见安装路径遍历 ──
  const home = os.homedir();
  const commonRoots = [
    path.join(home, 'anaconda3'),
    path.join(home, 'miniconda3'),
    path.join(home, 'micromamba'),
    path.join(home, 'mambaforge'),
    path.join(home, '.conda'),
  ];

  if (process.platform === 'win32') {
    commonRoots.push(
      path.join('C:', 'ProgramData', 'anaconda3'),
      path.join('C:', 'Anaconda3'),
      path.join('C:', 'ProgramData', 'miniconda3'),
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'anaconda3'),
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'miniconda3'),
    );
  }

  // 去重
  const uniqueRoots = [...new Set(commonRoots)];
  for (const root of uniqueRoots) {
    const candidate = path.join(root, 'envs', envName, binDir, pyExe);
    if (await fileExists(candidate)) {
      return { pythonPath: candidate, envType: 'conda' };
    }
  }

  // ── 全部失败 → 给出清晰错误提示 ──
  const tried = [];
  if (process.env.CONDA_PREFIX) {
    tried.push(`  - CONDA_PREFIX → ${path.dirname(process.env.CONDA_PREFIX)}/envs/${envName}/`);
  }
  if (process.env.CONDA_HOME) {
    tried.push(`  - CONDA_HOME → ${process.env.CONDA_HOME}/envs/${envName}/`);
  }
  tried.push(`  - conda info --json（自动扫描）`);
  tried.push(`  - 常见路径（~/anaconda3、~/miniconda3 等）`);

  throw new Error(
    `找不到 Conda 环境 "${envName}"。\n\n` +
    `已尝试以下来源：\n${tried.join('\n')}\n\n` +
    `请排查：\n` +
    `  1. 环境名是否正确？运行 "conda env list" 查看所有环境\n` +
    `  2. Conda 是否已安装？运行 "conda --version"\n` +
    `  3. 如果不使用 Conda，请清空 env_name 以使用系统默认 Python`
  );
}

// ══════════════════════════════════════════════════════════════
// Python 代码执行
// ══════════════════════════════════════════════════════════════

/**
 * 在隔离沙箱中执行 Python 代码
 *
 * @param {Object} options
 * @param {string} options.code - Python 源代码（强制要求）
 * @param {string|null} [options.envName] - Conda 环境名称，null/空字符串 = 系统 Python
 * @param {number} [options.timeout] - 超时秒数（1–120，默认 30）
 * @param {string} options.dataDir - 数据目录绝对路径（沙箱放在 dataDir/.python-sandbox/ 下）
 * @returns {Promise<{
 *   stdout: string,
 *   stderr: string,
 *   exitCode: number,
 *   pythonPath: string,
 *   envType: 'conda'|'system',
 *   elapsed: string,
 *   stdoutTruncated: boolean
 * }>}
 */
async function executePython({ code, envName = null, timeout = DEFAULT_TIMEOUT_SEC, dataDir }) {
  // ── 参数校验 ──
  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    throw new Error(
      'run_python 缺少必要参数: code（要执行的 Python 源代码）。请提供 code 参数后重试。'
    );
  }
  if (!dataDir) {
    throw new Error(
      'pythonSandbox.executePython 缺少 dataDir 参数（数据目录路径）。请联系开发者修复。'
    );
  }

  const safeTimeout = Math.max(1, Math.min(Math.floor(timeout ?? DEFAULT_TIMEOUT_SEC), MAX_TIMEOUT_SEC));

  // ── 安全扫描：拒绝危险系统级调用 ──
  const DANGEROUS_PATTERNS = [
    { pattern: /\bsubprocess\b/, name: 'subprocess' },
    { pattern: /\bos\.system\s*\(/, name: 'os.system()' },
    { pattern: /\bos\.popen\s*\(/i, name: 'os.popen()' },
    { pattern: /\bexec\s*\(/, name: 'exec()' },
    { pattern: /\beval\s*\(/, name: 'eval()' },
    { pattern: /\b__import__\s*\(/, name: '__import__()' },
    { pattern: /\bcompile\s*\(/, name: 'compile()' },
  ];
  for (const { pattern, name } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(
        `安全限制：代码中包含被禁止的调用 "${name}"。` +
        `Python 沙箱不支持 subprocess / os.system / exec / eval / compile / __import__ 等系统级操作。` +
        `请使用纯计算与数据处理代码（如 numpy、pandas、math、statistics 等标准库和科学计算库）。`
      );
    }
  }

  // ── 解析 Python 路径 ──
  const { pythonPath, envType } = await resolvePythonPath(envName);

  // ── 创建沙箱目录 ──
  const sandboxRoot = path.join(dataDir, SANDBOX_DIR_NAME);
  await fs.mkdir(sandboxRoot, { recursive: true });
  const sandboxName = crypto.randomUUID();
  const sandboxDir = path.join(sandboxRoot, sandboxName);
  await fs.mkdir(sandboxDir, { recursive: true });

  // ── 写入 Python 源文件 ──
  const scriptPath = path.join(sandboxDir, 'main.py');
  await fs.writeFile(scriptPath, code, 'utf-8');

  // ── 执行 ──
  const startTime = Date.now();
  const MAX_STDOUT_BYTES = 1024 * 1024; // 1MB 硬上限，防止 OOM

  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let killed = false;
  let spawnError = null;

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(pythonPath, [scriptPath], {
        cwd: sandboxDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: safeTimeout * 1000,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',  // 抑制 .pyc 文件
          PYTHONIOENCODING: 'utf-8',       // 强制 UTF-8 输出（Windows 兼容）
          PYTHONUNBUFFERED: '1',           // 立即输出，便于超时时仍能捕获
        },
      });

      let stdoutSize = 0;
      let stderrSize = 0;

      child.stdout.on('data', (d) => {
        stdoutSize += d.length;
        if (stdoutSize <= MAX_STDOUT_BYTES) {
          stdout += d.toString('utf-8');
        }
      });

      child.stderr.on('data', (d) => {
        stderrSize += d.length;
        if (stderrSize <= 64 * 1024) {  // stderr 64KB 上限
          stderr += d.toString('utf-8');
        }
      });

      child.on('close', (code, signal) => {
        exitCode = code;
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          killed = true;
          stderr = (stderr ? stderr + '\n\n' : '') +
            `⏱ 进程被 ${signal} 信号终止（超时 ${safeTimeout}s 或用户中断）。`;
        }
        resolve();
      });

      child.on('error', (err) => {
        spawnError = err;
        reject(err);
      });
    });
  } catch (err) {
    spawnError = err;
  }

  // ── 清理沙箱目录（不等待，不阻塞返回值） ──
  await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});

  // ── spawn 本身失败（Python 不存在、权限不足等） ──
  if (spawnError) {
    throw new Error(
      `无法启动 Python 解释器:\n` +
      `  路径: ${pythonPath}\n` +
      `  类型: ${envType === 'conda' ? 'Conda 环境' : '系统默认'}\n` +
      `  错误: ${spawnError.message}\n\n` +
      `请确认：\n` +
      `  1. Python 是否已安装并可用\n` +
      `  2. 如果使用 Conda，环境 "${envName}" 的 Python 是否可执行\n` +
      `  3. 终端中运行 "${pythonPath} --version" 测试`
    );
  }

  // ── 输出词数截断 ──
  const { text: truncatedStdout, truncated: stdoutTruncated } = truncateByWords(stdout, MAX_OUTPUT_WORDS);

  // ── 构建结果 ──
  const elapsedMs = Date.now() - startTime;
  const elapsed = (elapsedMs >= 1000)
    ? `${(elapsedMs / 1000).toFixed(2)}s`
    : `${elapsedMs}ms`;

  return {
    stdout: truncatedStdout,
    stderr: stderr.trimEnd(),
    exitCode: killed || exitCode === null ? -1 : exitCode,
    pythonPath,
    envType,
    elapsed,
    stdoutTruncated,
    sandboxDir: sandboxDir, // 保留路径用于提示（沙箱已清理）
  };
}

// ══════════════════════════════════════════════════════════════
// Conda 环境列表扫描
// ══════════════════════════════════════════════════════════════

/**
 * 扫描所有可用的 Conda 环境
 *
 * 策略：
 *   1. 通过 conda env list --json 获取（最快，含 base）
 *   2. 如果 conda 命令不可用，遍历常见路径的 envs/ 目录
 *
 * @returns {Promise<string[]>} 排序后的环境名列表
 */
async function listCondaEnvs() {
  const envNames = new Set();
  const pyExe = process.platform === 'win32' ? 'python.exe' : 'python';
  const binDir = process.platform === 'win32' ? '' : 'bin';

  // ── 方法 1：conda env list --json ──
  try {
    const raw = await execCommand('conda', ['env', 'list', '--json'], 8_000);
    const data = JSON.parse(raw);
    if (data && data.envs && Array.isArray(data.envs)) {
      for (const envPath of data.envs) {
        const name = path.basename(envPath);
        // 验证该环境确实有 python
        const pythonCandidate = path.join(envPath, binDir, pyExe);
        if (await fileExists(pythonCandidate)) {
          envNames.add(name);
        }
      }
    }
  } catch (_e) {
    // conda 不可用，继续备用策略
  }

  // ── 方法 2：遍历常见 conda roots 的 envs 目录 ──
  const home = os.homedir();
  const commonRoots = [
    path.join(home, 'anaconda3'),
    path.join(home, 'miniconda3'),
    path.join(home, 'micromamba'),
    path.join(home, 'mambaforge'),
    path.join(home, '.conda'),
  ];

  if (process.platform === 'win32') {
    commonRoots.push(
      path.join('C:', 'ProgramData', 'anaconda3'),
      path.join('C:', 'Anaconda3'),
      path.join('C:', 'ProgramData', 'miniconda3'),
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'anaconda3'),
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'miniconda3'),
    );
  }

  // 也尝试从 CONDA_PREFIX / CONDA_HOME 推断 conda root
  if (process.env.CONDA_PREFIX) {
    // CONDA_PREFIX 可能是 root（base）或 envs/something
    // 取父目录作为候选 root
    const parent = path.dirname(process.env.CONDA_PREFIX);
    commonRoots.push(parent);
    // 如果是 envs/xxx，再往上取 conda root
    const grandParent = path.dirname(parent);
    commonRoots.push(grandParent);
  }
  if (process.env.CONDA_HOME) {
    commonRoots.push(process.env.CONDA_HOME);
  }

  for (const root of [...new Set(commonRoots)]) {
    const envsDir = path.join(root, 'envs');
    try {
      const entries = await fs.readdir(envsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const pythonCandidate = path.join(envsDir, entry.name, binDir, pyExe);
          if (await fileExists(pythonCandidate)) {
            envNames.add(entry.name);
          }
        }
      }
    } catch {
      // envs/ 不存在或无法读取，跳过
    }

    // 也检查 root 本身是否为一个 conda 环境（base）
    try {
      const rootPy = path.join(root, binDir, pyExe);
      if (await fileExists(rootPy) && !envNames.has('base')) {
        envNames.add('base');
      }
    } catch {
      // 跳过
    }
  }

  // http://localhost:5173 中 envNames 可能为空，此时添加一个占位提示
  const sorted = [...envNames].sort();

  return sorted;
}

// ══════════════════════════════════════════════════════════════
// 导出
// ══════════════════════════════════════════════════════════════

module.exports = {
  executePython,
  resolvePythonPath,
  listCondaEnvs,
};
