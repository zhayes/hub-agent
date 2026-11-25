#!/usr/bin/env node
/**
 * 重新生成中文字体子集。
 *
 *   pnpm fonts          # 只检查，不写文件
 *   pnpm fonts --write  # 重写 cjk-chars.txt 与 noto-sans-sc-ui-subset.woff2
 *
 * 为什么需要它：控制台只自托管 UI 用到的汉字（整包 Noto Sans SC 有几 MB）。
 * 文案一变子集就得跟着变，否则新字会静默回退到系统字体，一行里出现两种字形。
 * 子集从 `packages/web/src` 里**实际出现**的汉字反推，所以只要改完文案跑一次，
 * 就不会漏字。
 *
 * 需要联网：字符集通过 Google Fonts 的 `text=` 接口取，返回的是单文件变量字体
 * （wght 400..700），与 fonts.css 里的 `font-weight: 400 700` 对应。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'packages/web/src')
const OUT_DIR = join(SRC, 'assets/fonts')
const CHARS_FILE = join(OUT_DIR, 'cjk-chars.txt')
const FONT_FILE = join(OUT_DIR, 'noto-sans-sc-ui-subset.woff2')

/* 中文标点不在 \p{Script=Han} 里，但 UI 文案会用；列在这里就一定会进子集。 */
const PUNCTUATION = '、。，：；！？（）《》【】「」『』…—·“”‘’￥'
const EXTENSIONS = ['.ts', '.tsx', '.css', '.html']

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (EXTENSIONS.some((extension) => name.endsWith(extension))) out.push(path)
  }
  return out
}

function collect() {
  const chars = new Set()
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8')
    /* 注释里的中文不渲染，跳过整行注释以免把无关字带进子集。 */
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      for (const char of line) {
        if (/\p{Script=Han}/u.test(char)) chars.add(char)
      }
    }
  }
  for (const char of PUNCTUATION) chars.add(char)
  return [...chars].sort((a, b) => a.codePointAt(0) - b.codePointAt(0))
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 用 curl 而不是 fetch：从 fonts.gstatic.com 读大响应时 Node 的 fetch 会
 * ECONNRESET（同一 URL 用 curl 稳定），所以这里直接调系统 curl 并带重试。
 */
function curl(url) {
  return execFileSync(
    'curl',
    ['-sS', '-L', '--retry', '3', '--retry-connrefused', '--max-time', '60', '-A', USER_AGENT, url],
    { maxBuffer: 64 * 1024 * 1024 },
  )
}

async function download(chars) {
  const text = encodeURIComponent(chars.join(''))
  const cssUrl = `https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400..700&text=${text}`
  const body = curl(cssUrl).toString('utf8')
  const match = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(body)
  if (match === null) throw new Error('没有在 Google Fonts 的响应里找到 woff2 地址')
  return new Uint8Array(curl(match[1]))
}

const chars = collect()
const write = process.argv.includes('--write')

const previous = (() => {
  try {
    return readFileSync(CHARS_FILE, 'utf8').trim()
  } catch {
    return ''
  }
})()
const next = chars.join('')
const added = [...next].filter((char) => !previous.includes(char))

process.stdout.write(
  `${JSON.stringify(
    {
      chars: chars.length,
      previousChars: [...previous].length,
      added: added.join(''),
      file: relative(ROOT, CHARS_FILE),
    },
    null,
    2,
  )}\n`,
)

if (!write) {
  process.stdout.write('dry run：加 --write 才会写文件与下载字体\n')
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(CHARS_FILE, `${next}\n`, 'utf8')
const font = await download(chars)
writeFileSync(FONT_FILE, font)
process.stdout.write(
  `已写入 ${relative(ROOT, FONT_FILE)}（${Math.round(font.byteLength / 1024)} KB）\n`,
)
