import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface JevRouteReceipt {
  route_nonce: string;
  complexity: 'quick' | 'standard' | 'full' | 'specialist';
  category: 'quick' | 'deep' | 'ultrabrain' | 'visual-engineering';
  should_ultrawork: boolean;
  load_skills: string[];
  formatted_trace?: string;
}

export interface RouteReceiptReader {
  read(sessionID: string): Promise<JevRouteReceipt | undefined>;
}

export function routeFromUserText(text: string): JevRouteReceipt | undefined {
  const marker = 'CODEX_HUB_JEV_RECEIPT_V1 ';
  if (!text.startsWith(marker)) return undefined;
  try {
    const raw: unknown = JSON.parse(text.slice(marker.length).split('\n', 1)[0]);
    if (!raw || typeof raw !== 'object') return undefined;
    const receipt = raw as Partial<JevRouteReceipt>;
    if (typeof receipt.route_nonce !== 'string' || !['quick', 'standard', 'full', 'specialist'].includes(receipt.complexity ?? '') ||
        !['quick', 'deep', 'ultrabrain', 'visual-engineering'].includes(receipt.category ?? '') ||
        typeof receipt.should_ultrawork !== 'boolean' || !Array.isArray(receipt.load_skills) || !receipt.load_skills.every(item => typeof item === 'string') ||
        (receipt.formatted_trace !== undefined && (typeof receipt.formatted_trace !== 'string' || receipt.formatted_trace.length > 4096))) return undefined;
    return receipt as JevRouteReceipt;
  } catch { return undefined; }
}

export class FileRouteReceiptReader implements RouteReceiptReader {
  constructor(private readonly directory: string) {}

  async read(sessionID: string): Promise<JevRouteReceipt | undefined> {
    if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionID)) throw new Error('Invalid OpenCode session ID');
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.directory, `${sessionID}.json`), 'utf8'));
      if (!raw || typeof raw !== 'object') return undefined;
      const receipt = raw as Partial<JevRouteReceipt>;
      if (typeof receipt.route_nonce !== 'string' || !['quick', 'standard', 'full', 'specialist'].includes(receipt.complexity ?? '') ||
          !['quick', 'deep', 'ultrabrain', 'visual-engineering'].includes(receipt.category ?? '') ||
          typeof receipt.should_ultrawork !== 'boolean' || !Array.isArray(receipt.load_skills) ||
          (receipt.formatted_trace !== undefined && (typeof receipt.formatted_trace !== 'string' || receipt.formatted_trace.length > 4096))) return undefined;
      return receipt as JevRouteReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
