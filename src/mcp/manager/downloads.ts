import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DownloadCandidate = {
  name: string;
  path: string;
  mtime: number;
};

export function scanDownloads(downloadsDir?: string, limit = 5): DownloadCandidate[] {
  const dir = downloadsDir ?? join(homedir(), "Downloads");
  if (!existsSync(dir)) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const candidates: DownloadCandidate[] = [];
  for (const entry of entries) {
    if (entry.toLowerCase().endsWith(".capsule")) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          candidates.push({
            name: entry,
            path: fullPath,
            mtime: stat.mtimeMs,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.slice(0, limit);
}
