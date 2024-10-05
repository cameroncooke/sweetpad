import path from "node:path";
import * as vscode from "vscode";
import { showQuickPick } from "../common/quick-pick";

import { type XcodeBuildSettings, getBuildConfigurations, getSchemes } from "../common/cli/scripts";
import type { ExtensionContext } from "../common/commands";
import { getWorkspaceConfig } from "../common/config";
import { ExtensionError } from "../common/errors";
import { createDirectory, findFilesRecursive, isFileExists, removeDirectory } from "../common/files";
import { commonLogger } from "../common/logger";
import type { Destination } from "../destination/types";
import type { SimulatorDestination } from "../simulators/types";

const DEFAULT_CONFIGURATION = "Debug";

export type SelectedDestination = {
  type: "simulator" | "device";
  udid: string;
  name?: string;
};

/**
 * Ask user to select one of the Booted/Shutdown simulators
 */
export async function askSimulator(
  context: ExtensionContext,
  options: {
    title: string;
    state: "Booted" | "Shutdown";
    error: string;
  },
): Promise<SimulatorDestination> {
  let simulators = await context.destinationsManager.getSimulators({
    sort: true,
  });

  if (options?.state) {
    simulators = simulators.filter((simulator) => simulator.state === options.state);
  }

  if (simulators.length === 0) {
    throw new ExtensionError(options.error);
  }
  if (simulators.length === 1) {
    return simulators[0];
  }

  const selected = await showQuickPick({
    title: options.title,
    items: simulators.map((simulator) => {
      return {
        label: simulator.label,
        context: {
          simulator: simulator,
        },
      };
    }),
  });

  return selected.context.simulator;
}

/**
 * Ask user to select simulator or device to run on
 */
export async function askDestinationToRunOn(
  context: ExtensionContext,
  buildSettings: XcodeBuildSettings,
): Promise<Destination> {
  // We can remove platforms that are not supported by the project
  const supportedPlatforms = buildSettings.supportedPlatforms;

  const destinations = await context.destinationsManager.getDestinations({
    platformFilter: supportedPlatforms,
    mostUsedSort: true,
  });

  // If we have cached desination, use it
  const cachedDestination = context.destinationsManager.getSelectedXcodeDestination();
  if (cachedDestination) {
    const destination = destinations.find(
      (destination) => destination.id === cachedDestination.id && destination.type === cachedDestination.type,
    );
    if (destination) {
      return destination;
    }
  }

  return selectDestination(context, {
    destinations: destinations,
  });
}

export async function selectDestination(
  context: ExtensionContext,
  options?: {
    destinations?: Destination[];
  },
): Promise<Destination> {
  const destinations = options?.destinations?.length
    ? options.destinations
    : await context.destinationsManager.getDestinations({
        mostUsedSort: true,
      });

  const selected = await showQuickPick<Destination>({
    title: "Select destination to run on",
    items: [
      ...destinations.map((destination) => {
        return {
          label: destination.name,
          iconPath: new vscode.ThemeIcon(destination.icon),
          detail: destination.quickPickDetails,
          context: destination,
        };
      }),
    ],
  });

  const destination = selected.context;

  context.destinationsManager.setWorkspaceDestination(destination);
  return destination;
}

export async function getDestinationById(
  context: ExtensionContext,
  options: { destinationId: string },
): Promise<Destination> {
  const desinations = await context.destinationsManager.getDestinations();
  const destination = desinations.find((destination) => destination.id === options.destinationId);

  if (destination) {
    return destination;
  }

  throw new ExtensionError("Destination not found", {
    context: {
      destinationId: options.destinationId,
    },
  });
}

/**
 * Ask user to select scheme to build
 */
export async function askScheme(
  context: ExtensionContext,
  options: {
    title?: string;
    xcworkspace: string;
    ignoreCache?: boolean;
  },
): Promise<string> {
  const cachedScheme = context.buildManager.getDefaultScheme();
  if (cachedScheme && !options.ignoreCache) {
    return cachedScheme;
  }

  const schemes = await getSchemes({
    xcworkspace: options.xcworkspace,
  });

  const scheme = await showQuickPick({
    title: options?.title ?? "Select scheme to build",
    items: schemes.map((scheme) => {
      return {
        label: scheme.name,
        context: {
          scheme: scheme,
        },
      };
    }),
  });

  const schemeName = scheme.context.scheme.name;
  context.buildManager.setDefaultScheme(schemeName);
  return schemeName;
}

/**
 * It's absolute path to current opened workspace
 */
export function getWorkspacePath(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceFolder) {
    throw new ExtensionError("No workspace folder found");
  }
  return workspaceFolder;
}

/**
 * Prepare storage path for the extension. It's a folder where we store all intermediate files
 */
export async function prepareStoragePath(context: ExtensionContext): Promise<string> {
  const storagePath = context.storageUri?.fsPath;
  if (!storagePath) {
    throw new ExtensionError("No storage path found");
  }
  // Creatre folder at storagePath, because vscode doesn't create it automatically
  await createDirectory(storagePath);
  return storagePath;
}

/**
 * Prepare bundle directory for the given schema in the storage path
 */
export async function prepareBundleDir(context: ExtensionContext, schema: string): Promise<string> {
  const storagePath = await prepareStoragePath(context);

  const bundleDir = path.join(storagePath, "bundle", schema);

  // Remove old bundle if exists
  await removeDirectory(bundleDir);

  // Remove old .xcresult if exists
  const xcresult = path.join(storagePath, "bundle", `${schema}.xcresult`);
  await removeDirectory(xcresult);

  return bundleDir;
}

export function prepareDerivedDataPath(): string | null {
  const configPath = getWorkspaceConfig("build.derivedDataPath");

  // No config -> path will be provided by xcodebuild
  if (!configPath) {
    return null;
  }

  // Expand relative path to absolute
  let derivedDataPath: string = configPath;
  if (!path.isAbsolute(configPath)) {
    // Example: .biuld/ -> /Users/username/Projects/project/.build
    derivedDataPath = path.join(getWorkspacePath(), configPath);
  }

  return derivedDataPath;
}

export function getCurrentXcodeWorkspacePath(context: ExtensionContext): string | undefined {
  const configPath = getWorkspaceConfig("build.xcodeWorkspacePath");
  if (configPath) {
    context.updateWorkspaceState("build.xcodeWorkspacePath", undefined);
    if (path.isAbsolute(configPath)) {
      return configPath;
    }
    return path.join(getWorkspacePath(), configPath);
  }

  const cachedPath = context.getWorkspaceState("build.xcodeWorkspacePath");
  if (cachedPath) {
    return cachedPath;
  }

  return undefined;
}

export async function askXcodeWorkspacePath(context: ExtensionContext): Promise<string> {
  const current = getCurrentXcodeWorkspacePath(context);
  if (current) {
    return current;
  }

  const selectedPath = await selectXcodeWorkspace({
    autoselect: true,
  });

  context.updateWorkspaceState("build.xcodeWorkspacePath", selectedPath);
  context.buildManager.refresh();
  return selectedPath;
}

export async function askConfiguration(
  context: ExtensionContext,
  options: {
    xcworkspace: string;
  },
): Promise<string> {
  return await context.withCache("build.xcodeConfiguration", async () => {
    // Fetch all configurations
    const configurations = await getBuildConfigurations({
      xcworkspace: options.xcworkspace,
    });

    // Use default configuration if no configurations found
    if (configurations.length === 0) {
      return DEFAULT_CONFIGURATION;
    }

    // Use default configuration if it exists
    if (configurations.some((configuration) => configuration.name === DEFAULT_CONFIGURATION)) {
      return DEFAULT_CONFIGURATION;
    }

    // Give user a choice to select configuration if we don't know wich one to use
    const selected = await showQuickPick({
      title: "Select configuration",
      items: configurations.map((configuration) => {
        return {
          label: configuration.name,
          context: {
            configuration,
          },
        };
      }),
    });
    return selected.context.configuration.name;
  });
}

/**
 * Detect xcode workspace in the given directory
 */
async function detectXcodeWorkspacesPaths(): Promise<string[]> {
  const workspace = getWorkspacePath();

  // Get all files that end with .xcworkspace (4 depth)
  const paths = await findFilesRecursive({
    directory: workspace,
    depth: 4,
    matcher: (file) => {
      return file.name.endsWith(".xcworkspace");
    },
  });
  return paths;
}

/**
 * Find xcode workspace in the given directory and ask user to select it
 */
export async function selectXcodeWorkspace(options: { autoselect: boolean }): Promise<string> {
  const workspacePath = getWorkspacePath();

  // Get all files that end with .xcworkspace (4 depth)
  const paths = await detectXcodeWorkspacesPaths();

  // No files, nothing to do
  if (paths.length === 0) {
    throw new ExtensionError("No xcode workspaces found", {
      context: {
        cwd: workspacePath,
      },
    });
  }

  // One file, use it and save it to the cache
  if (paths.length === 1 && options.autoselect) {
    const path = paths[0];
    commonLogger.log("Xcode workspace was detected", {
      workspace: workspacePath,
      path: path,
    });
    return path;
  }

  const podfilePath = path.join(workspacePath, "Podfile");
  const isCocoaProject = await isFileExists(podfilePath);

  // More then one, ask user to select
  const selected = await showQuickPick({
    title: "Select xcode workspace",
    items: paths
      .sort((a, b) => {
        // Sort by depth to show less nested paths first
        const aDepth = a.split(path.sep).length;
        const bDepth = b.split(path.sep).length;
        return aDepth - bDepth;
      })
      .map((xwPath) => {
        // show only relative path, to make it more readable
        const relativePath = path.relative(workspacePath, xwPath);
        const parentDir = path.dirname(relativePath);

        const isInRootDir = parentDir === ".";
        const isCocoaPods = isInRootDir && isCocoaProject;

        let detail: string | undefined;
        if (isCocoaPods && isInRootDir) {
          detail = "CocoaPods (recommended)";
        } else if (!isInRootDir && parentDir.endsWith(".xcodeproj")) {
          detail = "Xcode";
        }
        // todo: add workspace with multiple projects

        return {
          label: relativePath,
          detail: detail,
          context: {
            path: xwPath,
          },
        };
      }),
  });
  return selected.context.path;
}

export async function restartSwiftLSP() {
  // Restart SourceKit Language Server
  try {
    await vscode.commands.executeCommand("swift.restartLSPServer");
  } catch (error) {
    commonLogger.warn("Error restarting SourceKit Language Server", {
      error: error,
    });
  }
}

export async function findEntitlementsFile(context: ExtensionContext, buildSettings: XcodeBuildSettings): Promise<string | undefined> {
  const intermediatesPath = buildSettings.intermediatesDir;
  if (!intermediatesPath) {
    commonLogger.warn("Intermediates path not found", { intermediatesPath });
    return undefined;
  }

  const entitlementsFileName = `${buildSettings.appName}.xcent`;

  try {
    const files = await findFilesRecursive({
      directory: intermediatesPath,
      matcher: (file) => file.name === entitlementsFileName,
      depth: 4,
    });

    if (files.length > 0) {
      const entitlementsPath = files[0];
      commonLogger.debug("Entitlements file found", { path: entitlementsPath });
      return entitlementsPath;
    }
  } catch (error) {
    commonLogger.warn("Error searching for entitlements file", { error });
  }

  commonLogger.warn("Entitlements file not found", { entitlementsFileName });
  return undefined;
}