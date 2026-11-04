// Public build pins only. No credentials, remote calls or production enablement.
export function stagingBuildPins(staging, production) {
  const fields = [
    "environment",
    "apiOrigin",
    "shareOrigin",
    "authProject",
    "authPublishableKey",
  ];
  if (
    !staging ||
    Object.keys(staging).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(staging, key)) ||
    staging.environment !== "staging" ||
    typeof staging.authProject !== "string" ||
    !/^[a-z]{20}$/.test(staging.authProject) ||
    typeof staging.authPublishableKey !== "string" ||
    !/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(staging.authPublishableKey)
  )
    throw new Error("Complete public staging build configuration is required.");
  const origin = (value) => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.origin === value &&
        !url.username &&
        !url.password &&
        !url.port &&
        /^[a-z0-9.-]+$/.test(url.hostname) &&
        url.hostname.includes(".") &&
        !/^[0-9.]+$/.test(url.hostname) &&
        !/\.(invalid|localhost|local)$/.test(url.hostname)
      );
    } catch {
      return false;
    }
  };
  if (
    !origin(staging.apiOrigin) ||
    !origin(staging.shareOrigin) ||
    staging.apiOrigin === staging.shareOrigin
  )
    throw new Error("Separate public HTTPS staging origins are required.");
  if (
    !production ||
    production.environment !== "production" ||
    typeof production.environmentIsolationVerified !== "boolean"
  )
    throw new Error(
      "The production isolation configuration must be reviewed before a staging build.",
    );
  if (
    [staging.apiOrigin, staging.shareOrigin].some((value) =>
      [production.apiOrigin, production.shareOrigin].includes(value),
    )
  )
    throw new Error("Staging cannot use production API or share origins.");
  if (
    (production.stagingAuthProject != null &&
      production.stagingAuthProject !== staging.authProject) ||
    (production.environmentIsolationVerified &&
      (production.stagingAuthProject !== staging.authProject ||
        production.authProject === staging.authProject))
  )
    throw new Error(
      "Staging pins must match the isolated replacement project and cannot reuse production Auth.",
    );
  return Object.freeze({
    GYRO_CLOUD_V2_STAGING_API_ORIGIN: staging.apiOrigin,
    GYRO_CLOUD_V2_STAGING_AUTH_PROJECT: staging.authProject,
    GYRO_CLOUD_V2_STAGING_AUTH_PUBLISHABLE_KEY: staging.authPublishableKey,
    GYRO_CLOUD_V2_STAGING_SHARE_ORIGIN: staging.shareOrigin,
  });
}

// Finder identity and local data stay separate for every validated staging project.
export function stagingAppIsolation(authProject) {
  if (typeof authProject !== "string" || !/^[a-z]{20}$/.test(authProject))
    throw new Error(
      "A canonical staging Auth project is required for app isolation.",
    );
  const relativeDataDirectory = `Gyro Cloud Staging/${authProject}`;
  return Object.freeze({
    authProject,
    productName: `Gyro Cloud Staging ${authProject.slice(0, 8)}`,
    identifier: `dev.gyro.desktop.cloudstaging.${authProject}`,
    relativeDataDirectory,
    assetProtocolScope: Object.freeze([
      `$DATA/${relativeDataDirectory}/sessions/attachments/**`,
      `$DATA/${relativeDataDirectory}/browser-captures/**`,
    ]),
    launcherDefine: `-DGYRO_STAGING_PROJECT="${authProject}"`,
  });
}
