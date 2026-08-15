const RELEASE_NPM_RESOLUTION_ENVIRONMENT = Object.freeze({
  npm_config_offline: "false",
  npm_config_prefer_offline: "true",
});

const RELEASE_NPM_RESOLUTION_ARGUMENTS = Object.freeze([
  "--offline=false",
  "--prefer-offline",
]);

export function releaseNpmResolutionEnvironment() {
  return { ...RELEASE_NPM_RESOLUTION_ENVIRONMENT };
}

export function releaseNpmResolutionArguments() {
  return [...RELEASE_NPM_RESOLUTION_ARGUMENTS];
}
