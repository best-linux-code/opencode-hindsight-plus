/**
 * Bank ID derivation and mission management.
 *
 * Port of Claude Code plugin's bank.py, adapted for OpenCode's context model.
 *
 * Dimensions for dynamic bank IDs:
 *   - agent      → configured name or "opencode"
 *   - project    → derived from the working directory basename
 *   - gitProject → derived from the main worktree's basename when inside a
 *                  git repository (so all linked worktrees of the same repo
 *                  share a single memory bank). Falls back to the working
 *                  directory basename when git is unavailable or the
 *                  directory is not a repo.
 */

import { basename, dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { HindsightConfig } from "./config.js";
import { Logger } from "./logger.js";
import type { HindsightClient } from "@vectorize-io/hindsight-client";

const DEFAULT_BANK_NAME = "opencode";
const VALID_FIELDS = new Set(["agent", "project", "gitProject", "channel", "user"]);

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Main worktree root via git-common-dir, or null. */
function getProjectRootFromGit(directory: string): string | null {
  if (!directory) return null;
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: directory,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }
    ).trim();
    if (!commonDir) return null;
    if (basename(commonDir) === ".git") {
      return dirname(commonDir);
    }
    return commonDir;
  } catch {
    return null;
  }
}

function deriveGitProjectName(directory: string, resolveWorktrees: boolean): string {
  if (resolveWorktrees) {
    const projectRoot = getProjectRootFromGit(directory);
    if (projectRoot) return basename(projectRoot);
  }
  return directory ? basename(directory) : "unknown";
}

/** Claude directoryBankMap: exact realpath match on cwd (or main worktree root). */
function bankFromDirectoryMap(
  directory: string,
  dirMap: Record<string, string>,
  resolveWorktrees: boolean
): string | null {
  if (!directory || !dirMap || !Object.keys(dirMap).length) return null;

  const candidates = new Set<string>([safeRealpath(directory)]);
  if (resolveWorktrees) {
    const root = getProjectRootFromGit(directory);
    if (root) candidates.add(safeRealpath(root));
  }

  for (const [dirPath, bankId] of Object.entries(dirMap)) {
    if (!dirPath || !bankId) continue;
    const mapped = safeRealpath(dirPath);
    if (candidates.has(mapped)) return bankId;
  }
  return null;
}

/**
 * Derive a bank ID from context and config.
 *
 * Order (Claude bank.py): directoryBankMap → static bankId → dynamic fields.
 */
export function deriveBankId(config: HindsightConfig, directory: string): string {
  const prefix = config.bankIdPrefix;
  const resolveWorktrees = config.resolveWorktrees !== false;

  const mapped = bankFromDirectoryMap(directory, config.directoryBankMap, resolveWorktrees);
  if (mapped) {
    return prefix ? `${prefix}-${mapped}` : mapped;
  }

  if (!config.dynamicBankId) {
    const base = config.bankId || DEFAULT_BANK_NAME;
    return prefix ? `${prefix}-${base}` : base;
  }

  const fields = config.dynamicBankGranularity?.length
    ? config.dynamicBankGranularity
    : ["gitProject"];

  for (const f of fields) {
    if (!VALID_FIELDS.has(f)) {
      console.error(
        `[Hindsight] Unknown dynamicBankGranularity field "${f}" — ` +
          `valid: ${[...VALID_FIELDS].sort().join(", ")}`
      );
    }
  }

  const channelId = process.env.HINDSIGHT_CHANNEL_ID || "";
  const userId = process.env.HINDSIGHT_USER_ID || "";

  const fieldResolvers: Record<string, () => string> = {
    agent: () => config.agentName || "opencode",
    project: () => (directory ? basename(directory) : "unknown"),
    gitProject: () => deriveGitProjectName(directory, resolveWorktrees),
    channel: () => channelId || "default",
    user: () => userId || "anonymous",
  };

  const segments = fields.map((f) => fieldResolvers[f]?.() || "unknown");
  const baseBankId = segments.join("::");

  return prefix ? `${prefix}-${baseBankId}` : baseBankId;
}

/**
 * Set bank mission on first use, skip if already set.
 * Uses an in-memory Set (plugin is long-lived, unlike Claude Code's ephemeral hooks).
 */
export async function ensureBankMission(
  client: HindsightClient,
  bankId: string,
  config: HindsightConfig,
  missionsSet: Set<string>,
  logger: Logger = new Logger({ silent: true })
): Promise<void> {
  const mission = config.bankMission;
  if (!mission?.trim()) return;
  if (missionsSet.has(bankId)) return;

  try {
    await client.createBank(bankId, {
      reflectMission: mission,
      retainMission: config.retainMission || undefined,
    });
    missionsSet.add(bankId);
    // Cap tracked banks
    if (missionsSet.size > 10000) {
      const keys = [...missionsSet].sort();
      for (const k of keys.slice(0, keys.length >> 1)) {
        missionsSet.delete(k);
      }
    }
    logger.debug(`Set mission for bank: ${bankId}`);
  } catch (e) {
    // Don't fail if mission set fails — bank may not exist yet
    logger.debug(`Could not set bank mission for ${bankId}`, { error: String(e) });
  }
}
