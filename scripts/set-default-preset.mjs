#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

const args = parseArgs(process.argv.slice(2))
const dshHome = resolve(args.dshHome || process.env.DSH_HOME || resolve(process.env.USERPROFILE || homedir(), '.dsh'))
const settingsPath = resolve(args.settings || resolve(dshHome, 'settings.yaml'))
const dryRun = args.dryRun === true

if (existsSync(settingsPath)) {
  const original = readFileSync(settingsPath, 'utf8')
  const updated = setDefaultPreset(original)

  if (updated === original) {
    console.log(`[set-default-preset] unchanged: ${settingsPath}`)
  } else if (dryRun) {
    console.log(`[set-default-preset] dry-run: would set agent-presets.default=sagitta in ${settingsPath}`)
  } else {
    const backupPath = createBackup(settingsPath)
    atomicWrite(settingsPath, updated)
    console.log(`[set-default-preset] updated: ${settingsPath}`)
    console.log(`[set-default-preset] backup: ${backupPath}`)
  }
} else if (dryRun) {
  console.log(`[set-default-preset] dry-run: would create ${settingsPath} with agent-presets.default=sagitta`)
} else {
  mkdirSync(dirname(settingsPath), { recursive: true })
  atomicWrite(settingsPath, 'agent-presets:\n  default: sagitta\n')
  console.log(`[set-default-preset] created: ${settingsPath}`)
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--dry-run') {
      result.dryRun = true
      continue
    }
    if (token === '--dsh-home' || token === '--settings') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a path`)
      result[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
      index += 1
      continue
    }
    if (token.startsWith('--dsh-home=') || token.startsWith('--settings=')) {
      const separator = token.indexOf('=')
      const key = token.slice(2, separator).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      const value = token.slice(separator + 1)
      if (!value) throw new Error(`${token.slice(0, separator)} requires a path`)
      result[key] = value
      continue
    }
    throw new Error(`Unknown argument: ${token}`)
  }
  return result
}

function setDefaultPreset(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const hadFinalNewline = source.endsWith('\n')
  const lines = source.split(/\r?\n/)
  if (hadFinalNewline) lines.pop()

  const sectionIndexes = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^agent-presets\s*:\s*(.*)$/)
    if (match && !isCommentOnly(lines[index])) sectionIndexes.push({ index, tail: match[1] })
  }
  if (sectionIndexes.length > 1) throw new Error(`settings.yaml contains duplicate top-level agent-presets sections: ${settingsPath}`)

  if (sectionIndexes.length === 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    if (lines.length > 0) lines.push('')
    lines.push('agent-presets:', '  default: sagitta')
    return lines.join(eol) + eol
  }

  const section = sectionIndexes[0]
  const inlineTail = section.tail.trim()
  if (inlineTail && inlineTail !== '{}' && !inlineTail.startsWith('#')) {
    throw new Error(`agent-presets must be a block mapping; refusing to rewrite inline YAML in ${settingsPath}`)
  }
  if (section.tail.trim() === '{}') lines[section.index] = 'agent-presets:'

  let end = lines.length
  for (let index = section.index + 1; index < lines.length; index += 1) {
    if (isTopLevelContent(lines[index])) {
      end = index
      break
    }
  }

  let childIndent = null
  for (let index = section.index + 1; index < end; index += 1) {
    if (isCommentOnly(lines[index]) || lines[index].trim() === '') continue
    const indent = leadingWhitespace(lines[index]).length
    if (indent > 0) {
      childIndent ??= indent
      break
    }
  }
  childIndent ??= 2

  for (let index = section.index + 1; index < end; index += 1) {
    const line = lines[index]
    if (isCommentOnly(line) || line.trim() === '') continue
    const indent = leadingWhitespace(line).length
    const match = line.match(/^(\s*)default\s*:\s*(.*)$/)
    if (match && indent === childIndent) {
      const comment = extractInlineComment(match[2])
      lines[index] = `${match[1]}default: sagitta${comment}`
      return lines.join(eol) + (hadFinalNewline ? eol : '')
    }
  }

  lines.splice(section.index + 1, 0, `${' '.repeat(childIndent)}default: sagitta`)
  return lines.join(eol) + (hadFinalNewline ? eol : '')
}

function isCommentOnly(line) {
  return /^\s*#/.test(line)
}

function isTopLevelContent(line) {
  return line.trim() !== '' && !isCommentOnly(line) && !/^\s/.test(line)
}

function leadingWhitespace(line) {
  return line.match(/^\s*/)?.[0] || ''
}

function extractInlineComment(value) {
  const match = value.match(/(\s+#.*)$/)
  return match ? match[1] : ''
}

function createBackup(filePath) {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
  let backupPath = `${filePath}.bak.${timestamp}`
  let suffix = 1
  while (existsSync(backupPath)) backupPath = `${filePath}.bak.${timestamp}.${suffix++}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

function atomicWrite(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(temporaryPath, content, 'utf8')
  renameSync(temporaryPath, filePath)
}
