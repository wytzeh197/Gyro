type ParsedVersion = {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
};

const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/;

function parseVersion(version: string): ParsedVersion | undefined {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) {
    return undefined;
  }

  return {
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareNumericIdentifiers(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, "") || "0";
  const normalizedRight = right.replace(/^0+/, "") || "0";
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  return normalizedLeft === normalizedRight
    ? 0
    : normalizedLeft > normalizedRight
      ? 1
      : -1;
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const part of ["major", "minor", "patch"] as const) {
    const comparison = compareNumericIdentifiers(left[part], right[part]);
    if (comparison !== 0) {
      return comparison;
    }
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const sharedLength = Math.min(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < sharedLength; index += 1) {
    const leftIdentifier = left.prerelease[index]!;
    const rightIdentifier = right.prerelease[index]!;
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(leftIdentifier);
    const rightIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(rightIdentifier);
    if (leftIsNumeric && rightIsNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftIsNumeric !== rightIsNumeric) {
      return leftIsNumeric ? -1 : 1;
    }
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }

  if (left.prerelease.length === right.prerelease.length) {
    return 0;
  }
  return left.prerelease.length > right.prerelease.length ? 1 : -1;
}

/**
 * Returns false only when both versions are valid SemVer and the candidate is
 * the same release or older. An unexpected version format stays visible so a
 * malformed manifest cannot silently hide a potentially valid update.
 */
export function isUpdateVersionNewer(
  candidateVersion: string,
  currentVersion: string,
): boolean {
  const candidate = parseVersion(candidateVersion);
  const current = parseVersion(currentVersion);
  return !candidate || !current || compareVersions(candidate, current) > 0;
}
