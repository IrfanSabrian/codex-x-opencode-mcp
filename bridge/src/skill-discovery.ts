/**
 * Deterministic skill-discovery helpers for OpenCode user-global skills.
 *
 * General skills come from skills.sh, UI skills from ui-skills.com.
 * All functions here are pure: no fetch, no fs, no network, no side effects.
 * Untrusted skill content is treated as data for review, never executed.
 */

export type SkillCategory = 'general' | 'ui';

export type SkillSource = 'skills.sh' | 'ui-skills.com';

export type SkillCandidate = {
  slug: string;
  name: string;
  repoUrl: string;
  skillUrl: string;
  source: SkillSource;
  category: SkillCategory;
};

export type SkillIndexEntry = {
  slug: string;
  name: string;
  category: SkillCategory;
  source: SkillSource;
  repository: string;
  installedAt: string;
  validation: string;
};

export type SafetyVerdict = {
  safe: boolean;
  reasons: string[];
};

export type SkillFile = {
  path: string;
  content: string;
};

/**
 * Verified source metadata (checked 2026-09-26 against the live sources;
 * re-verify before documenting new commands).
 *
 * - skills.sh: https://skills.sh/ + docs https://skills.sh/docs/cli; CLI repo
 *   https://github.com/vercel-labs/skills. Verified install syntax:
 *   `npx skills add <owner/repo> [-s <skill>] [-a <agents>] [-g] [-y]`;
 *   discovery via `npx skills find [query]`, inventory via `npx skills list`.
 *   skills.sh runs routine security audits but gives no per-skill guarantee.
 * - ui-skills.com: https://www.ui-skills.com/skills; source repo
 *   https://github.com/ibelick/ui-skills (MIT). Verified CLI syntax from the
 *   repo README: `npx ui-skills categories`, `npx ui-skills list --category <cat>`,
 *   `npx ui-skills get <skill>`. Copy reviewed skill files into the global
 *   OpenCode skill directory manually; never use its MCP endpoint here
 *   (no new MCP installs without separate approval).
 * - OpenCode global skills (https://opencode.ai/docs/skills/):
 *   `~/.config/opencode/skills/<name>/SKILL.md` — one folder per skill name,
 *   frontmatter `name` must match the directory name. A fresh session may be
 *   required before a newly installed global skill is picked up.
 */
export const skillCatalogMetadata: Record<SkillSource, { catalogUrl: string; repoUrl: string }> = {
  'skills.sh': {
    catalogUrl: 'https://skills.sh/',
    repoUrl: 'https://github.com/vercel-labs/skills'
  },
  'ui-skills.com': {
    catalogUrl: 'https://www.ui-skills.com/skills',
    repoUrl: 'https://github.com/ibelick/ui-skills'
  }
};

export const skillCatalogInstallCommands: Record<SkillSource, string> = {
  'skills.sh': 'npx skills add <owner/repo> -s <skill> -a opencode -g -y',
  'ui-skills.com': 'npx ui-skills get <skill>'
};

/** Global OpenCode skill directory name and file (flat: `<dir>/<slug>/SKILL.md`). */
export const globalSkillDirName = 'skills';
export const globalSkillFileName = 'SKILL.md';
export const discoverySkillName = 'opencode-skill-discovery';
export const discoveryIndexFileName = 'skill-index.json';

/** UI skills resolve to ui-skills.com, everything else to skills.sh. */
export function decideSkillSource(isUi: boolean): SkillSource {
  return isUi ? 'ui-skills.com' : 'skills.sh';
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function slugMatchesTokens(slug: string, tokens: string[]): boolean {
  const normalized = slug.toLowerCase();
  return tokens.some((token) => normalized.includes(token));
}

/**
 * True when skill discovery is needed: the Jev load_skills list is
 * missing/empty, or no installed slug matches the query tokens.
 */
export function emptyOrNoMatch(
  jevLoadSkills: string[] | undefined,
  installedSlugs: string[],
  query: string
): boolean {
  if (!jevLoadSkills || jevLoadSkills.length === 0) return true;
  const tokens = tokenize(query);
  if (tokens.length === 0) return true;
  if (installedSlugs.length === 0) return true;
  return !installedSlugs.some((slug) => slugMatchesTokens(slug, tokens));
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /api[_-]?key/i, reason: 'secret disclosure: api key reference' },
  { pattern: /secret/i, reason: 'secret disclosure: secret reference' },
  { pattern: /bearer/i, reason: 'secret disclosure: bearer token reference' },
  { pattern: /exfil/i, reason: 'secret disclosure: exfiltration reference' }
];

const OVERRIDE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /ignore previous instructions/i, reason: 'instruction override: ignore previous instructions' },
  { pattern: /override system/i, reason: 'instruction override: override system' },
  { pattern: /disobey/i, reason: 'instruction override: disobey' }
];

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-rf/i, reason: 'destructive command: rm -rf' },
  { pattern: /\bformat\b/i, reason: 'destructive command: format' },
  { pattern: /delete\s+--all/i, reason: 'destructive command: delete --all' }
];

const INSTALL_HOOK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /curl[\s\S]*\|\s*(sudo\s+)?sh\b/i, reason: 'unreviewed install hook: curl piped to sh' },
  { pattern: /wget[\s\S]*\|\s*(sudo\s+)?sh\b/i, reason: 'unreviewed install hook: wget piped to sh' },
  { pattern: /\bsh\s+install\b/i, reason: 'unreviewed install hook: sh install' },
  { pattern: /\bpostinstall\b/i, reason: 'unreviewed install hook: postinstall' },
  { pattern: /download[\s\S]*executable/i, reason: 'unreviewed install hook: downloading executables' },
  { pattern: /download[\s\S]*\.exe\b/i, reason: 'unreviewed install hook: downloading executables' }
];

const GITHUB_HTTPS_PATTERN = /^https:\/\/github\.com\/.+/i;

/**
 * Review untrusted skill file contents without executing anything.
 * Safe only when no rule hits and the repository URL is an https github URL.
 */
export function reviewSkillCandidate(files: SkillFile[], repoUrl: string): SafetyVerdict {
  const reasons: string[] = [];

  if (!GITHUB_HTTPS_PATTERN.test(repoUrl.trim())) {
    reasons.push('untrusted repository: expected https://github.com/... URL');
  }

  const groups = [
    SECRET_PATTERNS,
    OVERRIDE_PATTERNS,
    DESTRUCTIVE_PATTERNS,
    INSTALL_HOOK_PATTERNS
  ];

  for (const file of files) {
    const content = file.content;
    for (const group of groups) {
      for (const entry of group) {
        if (entry.pattern.test(content) && !reasons.includes(`${entry.reason} in ${file.path}`)) {
          reasons.push(`${entry.reason} in ${file.path}`);
        }
      }
    }
  }

  reasons.sort();
  return { safe: reasons.length === 0, reasons };
}

/** Build a flat index entry for an approved skill candidate. */
export function buildIndexEntry(
  candidate: SkillCandidate,
  validation: string,
  nowIso: string
): SkillIndexEntry {
  return {
    slug: candidate.slug,
    name: candidate.name,
    category: candidate.category,
    source: candidate.source,
    repository: candidate.repoUrl,
    installedAt: nowIso,
    validation
  };
}

/** Find an indexed skill whose slug or name matches a query token. */
export function findReuse(
  query: string,
  index: SkillIndexEntry[]
): SkillIndexEntry | undefined {
  const tokens = tokenize(query);
  if (tokens.length === 0) return undefined;
  for (const entry of index) {
    const haystacks = [entry.slug.toLowerCase(), entry.name.toLowerCase()];
    if (tokens.some((token) => haystacks.some((hay) => hay.includes(token)))) {
      return entry;
    }
  }
  return undefined;
}
