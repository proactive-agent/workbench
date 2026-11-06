/**
 * The user's own `crossSessionInbound`
 * ====================================
 *
 * Claude Code's `crossSessionInbound` setting decides what a session does with messages from the
 * user's other sessions (accept, hold for approval, refuse). With Messages from your Claude
 * sessions on, task runs pass `--settings {"crossSessionInbound":"accept"}`, which would override a
 * refuse or hold the user set themselves; so the user's choice is read first and wins. The files
 * are the Claude config dir's `settings.json` and the project's `.claude/settings.json` /
 * `settings.local.json`. Managed (enterprise) settings already win over `--settings`.
 *
 * Files are read as editors write them (UTF-8 with or without a BOM, UTF-16 from Windows
 * PowerShell 5.1). A file that exists but can't be read or parsed counts as limiting: it may hold a
 * refuse or hold that a run must not override.
 */
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';

/** The settings files that can set `crossSessionInbound` for sessions in `projectDir` */
export function crossSessionInboundFiles(configDirs: string[], projectDir: string): string[] {
  return [
    ...configDirs.map((dir) => path.join(dir, 'settings.json')),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
  ];
}

/**
 * Text of a settings file: UTF-8 with or without a BOM, or UTF-16 (LE or BE), detected by the BOM
 * or by the zero bytes of ASCII text
 */
export function decodeSettingsText(raw: Buffer): string {
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.subarray(3).toString('utf-8');
  const le = raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe;
  const be = raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff;
  if (le || be || (raw.length >= 2 && (raw[0] === 0) !== (raw[1] === 0))) {
    const body = le || be ? raw.subarray(2) : raw;
    const even = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
    if (be || (!le && raw[0] === 0)) even.swap16();
    return even.toString('utf16le').replace(/^﻿/, '');
  }
  return raw.toString('utf-8').replace(/^﻿/, '');
}

/** Whether a settings file's content refuses or holds cross-session messages, or can't be parsed */
function contentLimits(raw: Buffer): boolean {
  let parsed: unknown;
  try {
    const text = decodeSettingsText(raw).trim();
    if (!text) return false;
    parsed = JSON.parse(text);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
  const value = (parsed as { crossSessionInbound?: unknown }).crossSessionInbound;
  return value !== undefined && value !== 'accept';
}

/** A missing file sets nothing; any other read failure counts as limiting */
function readFailureLimits(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return !(code === 'ENOENT' || code === 'ENOTDIR');
}

/** Whether any of the files sets `crossSessionInbound` to anything but `accept` (or can't be read) */
export async function userLimitsCrossSessionInbound(files: string[]): Promise<boolean> {
  const limits = await Promise.all(files.map(async (file) => {
    try {
      return contentLimits(await readFile(file));
    } catch (error) {
      return readFailureLimits(error);
    }
  }));
  return limits.some(Boolean);
}

/** `userLimitsCrossSessionInbound` for synchronous callers (a few small files) */
export function userLimitsCrossSessionInboundSync(files: string[]): boolean {
  return files.some((file) => {
    try {
      return contentLimits(readFileSync(file));
    } catch (error) {
      return readFailureLimits(error);
    }
  });
}
