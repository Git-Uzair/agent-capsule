import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DownloadCandidate = {
  name: string;
  path: string;
  mtime: number;
};

/**
 * The user's Downloads folder, or the override the manager was started with (`--downloads`). One
 * folder for capsule traffic in both directions: `capsule_install { from_downloads }` scans it for
 * arriving capsules, and authoring drops the shareable `.mcpb` into it — because a bundle written
 * under `~/.agent-capsule/` is a bundle the user has to be talked into finding, and "it's in your
 * Downloads folder" is a sentence anyone can act on.
 */
export function resolveDownloadsDir(downloadsDir?: string): string {
  return downloadsDir ?? join(homedir(), "Downloads");
}

export function scanDownloads(downloadsDir?: string, limit = 5): DownloadCandidate[] {
  const dir = resolveDownloadsDir(downloadsDir);
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
