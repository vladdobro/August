import fs from 'node:fs/promises';
import path from 'node:path';

import { LLAMA_CPP_VERSION, llamaServerBinName, type LlmModelSpec, type LlmVariantDir } from '../config.js';

/// Pure path/argument helpers for the opt-in local language model (AUG-162). Layout: <llmRoot>/bin/<variant>/ and
/// <llmRoot>/models/. Kept apart from whisper's bin folders: llama.cpp ships ggml*.dll under the same names but in a
/// different version than whisper's, so the two must never share a directory.
export function llmBinDir(llmRoot: string, variant: LlmVariantDir): string {
  return path.join(llmRoot, 'bin', variant);
}

export function llmModelsDir(llmRoot: string): string {
  return path.join(llmRoot, 'models');
}

export function llmModelPath(llmRoot: string, model: LlmModelSpec): string {
  return path.join(llmModelsDir(llmRoot), model.fileName);
}

export function llamaServerPath(llmRoot: string, variant: LlmVariantDir, platform: NodeJS.Platform = process.platform): string {
  return path.join(llmBinDir(llmRoot, variant), llamaServerBinName(platform));
}

export const LLAMA_VERSION_MARKER = '.llama-version';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/// Installed = server binary exists and the marker holds LLAMA_CPP_VERSION (an interrupted/old install counts as missing).
export async function llamaBuildInstalled(llmRoot: string, variant: LlmVariantDir): Promise<boolean> {
  if (!(await pathExists(llamaServerPath(llmRoot, variant)))) return false;
  try {
    const marker = await fs.readFile(path.join(llmBinDir(llmRoot, variant), LLAMA_VERSION_MARKER), 'utf-8');
    return marker.trim() === LLAMA_CPP_VERSION;
  } catch {
    return false;
  }
}

/// GPU offload layers: override wins; LLAMA_SERVER_PATH custom binary → 99; darwin-arm64 → 99 (Metal); win-x64-cuda → 99; else 0.
export function llmGpuLayers(input: { variant: LlmVariantDir | null; override: number | null; customBinary: boolean }): number {
  if (input.override !== null) return input.override;
  if (input.customBinary) return 99;
  if (input.variant === 'darwin-arm64' || input.variant === 'win-x64-cuda') return 99;
  return 0;
}

/// argv for llama-server (no shell). modelPath must already be toSafePath'd on Windows.
export function buildLlamaServerArgs(input: { modelPath: string; port: number; gpuLayers: number; contextSize: number; alias: string }): string[] {
  return [
    '-m', input.modelPath,
    '--host', '127.0.0.1',
    '--port', String(input.port),
    '-ngl', String(input.gpuLayers),
    '-c', String(input.contextSize),
    '-np', '1',
    '--no-webui',
    '--alias', input.alias,
  ];
}
