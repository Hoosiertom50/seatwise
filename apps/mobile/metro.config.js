// Metro config for a pnpm monorepo (see https://docs.expo.dev/guides/monorepos/).
//
// This app imports @seatwise/shared directly from its TypeScript source (that package has no
// build step -- see packages/shared/package.json's "main": "./src/index.ts") and pnpm links it
// into node_modules as a symlink rather than copying it. By default Metro doesn't watch outside
// this app's own folder and doesn't follow symlinks, so without the settings below it would fail
// to resolve "@seatwise/shared" (or silently bundle a stale copy). None of this is needed if/when
// @seatwise/shared ever gains a real build step -- it's purely a consequence of importing raw
// workspace source.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo (so edits to packages/shared trigger a rebuild), not just this app.
config.watchFolders = [workspaceRoot];

// Resolve node_modules from both this app and the workspace root, since pnpm hoists shared
// dependencies (react, etc.) to the root while app-specific ones stay local.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// pnpm's node_modules are (mostly) symlinks into its content-addressable store -- Metro needs
// this to actually follow them instead of treating them as missing.
config.resolver.unstable_enableSymlinks = true;

// Don't let Metro walk up past this app's own node_modules looking for a package before trying
// the workspace root explicitly above -- avoids resolving the wrong hoisted copy of a dependency
// in a pnpm workspace.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
