/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Config, Fixtures, Project, ReporterDescription } from '../../types/test';
import type { Location } from '../../types/testReporter';
import type { TestRunnerPluginRegistration } from '../plugins';
import { getPackageJsonPath, mergeObjects } from '../util';
import type { Matcher } from '../util';
import type { ConfigCLIOverrides } from './ipc';
import type { FullConfig, FullProject } from '../../types/test';

export type FixturesWithLocation = {
  fixtures: Fixtures;
  location: Location;
};
export type Annotation = { type: string, description?: string };

export const defaultTimeout = 30000;

export class FullConfigInternal {
  readonly config: FullConfig;
  readonly globalOutputDir: string;
  readonly configDir: string;
  readonly configCLIOverrides: ConfigCLIOverrides;
  readonly storeDir: string;
  readonly ignoreSnapshots: boolean;
  readonly webServers: Exclude<FullConfig['webServer'], null>[];
  readonly plugins: TestRunnerPluginRegistration[];
  readonly projects: FullProjectInternal[] = [];
  cliArgs: string[] = [];
  cliGrep: string | undefined;
  cliGrepInvert: string | undefined;
  cliProjectFilter?: string[];
  cliListOnly = false;
  cliPassWithNoTests?: boolean;
  testIdMatcher?: Matcher;
  defineConfigWasUsed = false;

  static from(config: FullConfig): FullConfigInternal {
    return (config as any)[configInternalSymbol];
  }

  constructor(configDir: string, configFile: string | undefined, config: Config, configCLIOverrides: ConfigCLIOverrides) {
    if (configCLIOverrides.projects && config.projects)
      throw new Error(`Cannot use --browser option when configuration file defines projects. Specify browserName in the projects instead.`);

    const packageJsonPath = getPackageJsonPath(configDir);
    const packageJsonDir = packageJsonPath ? path.dirname(packageJsonPath) : undefined;
    const throwawayArtifactsPath = packageJsonDir || process.cwd();

    this.configDir = configDir;
    this.configCLIOverrides = configCLIOverrides;
    this.storeDir = path.resolve(configDir, (config as any)._storeDir || 'playwright');
    this.globalOutputDir = takeFirst(configCLIOverrides.outputDir, pathResolve(configDir, config.outputDir), throwawayArtifactsPath, path.resolve(process.cwd()));
    this.ignoreSnapshots = takeFirst(configCLIOverrides.ignoreSnapshots, config.ignoreSnapshots, false);
    this.plugins = ((config as any)._plugins || []).map((p: any) => ({ factory: p }));

    this.config = {
      configFile,
      rootDir: pathResolve(configDir, config.testDir) || configDir,
      forbidOnly: takeFirst(configCLIOverrides.forbidOnly, config.forbidOnly, false),
      fullyParallel: takeFirst(configCLIOverrides.fullyParallel, config.fullyParallel, false),
      globalSetup: takeFirst(resolveScript(config.globalSetup, configDir), null),
      globalTeardown: takeFirst(resolveScript(config.globalTeardown, configDir), null),
      globalTimeout: takeFirst(configCLIOverrides.globalTimeout, config.globalTimeout, 0),
      grep: takeFirst(config.grep, defaultGrep),
      grepInvert: takeFirst(config.grepInvert, null),
      maxFailures: takeFirst(configCLIOverrides.maxFailures, config.maxFailures, 0),
      metadata: takeFirst(config.metadata, {}),
      preserveOutput: takeFirst(config.preserveOutput, 'always'),
      reporter: takeFirst(configCLIOverrides.reporter, resolveReporters(config.reporter, configDir), [[defaultReporter]]),
      reportSlowTests: takeFirst(config.reportSlowTests, { max: 5, threshold: 15000 }),
      quiet: takeFirst(configCLIOverrides.quiet, config.quiet, false),
      projects: [],
      shard: takeFirst(configCLIOverrides.shard, config.shard, null),
      updateSnapshots: takeFirst(configCLIOverrides.updateSnapshots, config.updateSnapshots, 'missing'),
      version: require('../../package.json').version,
      workers: 0,
      webServer: null,
    };
    (this.config as any)[configInternalSymbol] = this;

    const workers = takeFirst(configCLIOverrides.workers, config.workers, '50%');
    if (typeof workers === 'string') {
      if (workers.endsWith('%')) {
        const cpus = os.cpus().length;
        this.config.workers = Math.max(1, Math.floor(cpus * (parseInt(workers, 10) / 100)));
      } else {
        this.config.workers = parseInt(workers, 10);
      }
    } else {
      this.config.workers = workers;
    }

    const webServers = takeFirst(config.webServer, null);
    if (Array.isArray(webServers)) { // multiple web server mode
      // Due to previous choices, this value shows up to the user in globalSetup as part of FullConfig. Arrays are not supported by the old type.
      this.config.webServer = null;
      this.webServers = webServers;
    } else if (webServers) { // legacy singleton mode
      this.config.webServer = webServers;
      this.webServers = [webServers];
    } else {
      this.webServers = [];
    }

    const projectConfigs = configCLIOverrides.projects || config.projects || [config];
    this.projects = projectConfigs.map(p => new FullProjectInternal(configDir, config, this, p, this.configCLIOverrides, throwawayArtifactsPath));
    resolveProjectDependencies(this.projects);
    this._assignUniqueProjectIds(this.projects);
    this.config.projects = this.projects.map(p => p.project);
  }

  private _assignUniqueProjectIds(projects: FullProjectInternal[]) {
    const usedNames = new Set();
    for (const p of projects) {
      const name = p.project.name || '';
      for (let i = 0; i < projects.length; ++i) {
        const candidate = name + (i ? i : '');
        if (usedNames.has(candidate))
          continue;
        p.id = candidate;
        usedNames.add(candidate);
        break;
      }
    }
  }
}

export class FullProjectInternal {
  readonly project: FullProject;
  readonly fullConfig: FullConfigInternal;
  readonly fullyParallel: boolean;
  readonly expect: Project['expect'];
  readonly respectGitIgnore: boolean;
  readonly snapshotPathTemplate: string;
  id = '';
  deps: FullProjectInternal[] = [];
  teardown: FullProjectInternal | undefined;

  constructor(configDir: string, config: Config, fullConfig: FullConfigInternal, projectConfig: Project, configCLIOverrides: ConfigCLIOverrides, throwawayArtifactsPath: string) {
    this.fullConfig = fullConfig;
    const testDir = takeFirst(pathResolve(configDir, projectConfig.testDir), pathResolve(configDir, config.testDir), fullConfig.configDir);
    const defaultSnapshotPathTemplate = '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}';
    this.snapshotPathTemplate = takeFirst(projectConfig.snapshotPathTemplate, config.snapshotPathTemplate, defaultSnapshotPathTemplate);

    this.project = {
      grep: takeFirst(projectConfig.grep, config.grep, defaultGrep),
      grepInvert: takeFirst(projectConfig.grepInvert, config.grepInvert, null),
      outputDir: takeFirst(configCLIOverrides.outputDir, pathResolve(configDir, projectConfig.outputDir), pathResolve(configDir, config.outputDir), path.join(throwawayArtifactsPath, 'test-results')),
      // Note: we either apply the cli override for repeatEach or not, depending on whether the
      // project is top-level vs dependency. See collectProjectsAndTestFiles in loadUtils.
      repeatEach: takeFirst(projectConfig.repeatEach, config.repeatEach, 1),
      retries: takeFirst(configCLIOverrides.retries, projectConfig.retries, config.retries, 0),
      metadata: takeFirst(projectConfig.metadata, config.metadata, undefined),
      name: takeFirst(projectConfig.name, config.name, ''),
      testDir,
      snapshotDir: takeFirst(pathResolve(configDir, projectConfig.snapshotDir), pathResolve(configDir, config.snapshotDir), testDir),
      testIgnore: takeFirst(projectConfig.testIgnore, config.testIgnore, []),
      testMatch: takeFirst(projectConfig.testMatch, config.testMatch, '**/*.@(spec|test).?(m)[jt]s?(x)'),
      timeout: takeFirst(configCLIOverrides.timeout, projectConfig.timeout, config.timeout, defaultTimeout),
      use: mergeObjects(config.use, projectConfig.use, configCLIOverrides.use),
      dependencies: projectConfig.dependencies || [],
      teardown: projectConfig.teardown,
    };
    (this.project as any)[projectInternalSymbol] = this;
    this.fullyParallel = takeFirst(configCLIOverrides.fullyParallel, projectConfig.fullyParallel, config.fullyParallel, undefined);
    this.expect = takeFirst(projectConfig.expect, config.expect, {});
    this.respectGitIgnore = !projectConfig.testDir && !config.testDir;
  }
}

export function takeFirst<T>(...args: (T | undefined)[]): T {
  for (const arg of args) {
    if (arg !== undefined)
      return arg;
  }
  return undefined as any as T;
}

function pathResolve(baseDir: string, relative: string | undefined): string | undefined {
  if (!relative)
    return undefined;
  return path.resolve(baseDir, relative);
}

function resolveReporters(reporters: Config['reporter'], rootDir: string): ReporterDescription[] | undefined {
  return toReporters(reporters as any)?.map(([id, arg]) => {
    if (builtInReporters.includes(id as any))
      return [id, arg];
    return [require.resolve(id, { paths: [rootDir] }), arg];
  });
}

function resolveProjectDependencies(projects: FullProjectInternal[]) {
  const teardownToSetup = new Map<FullProjectInternal, FullProjectInternal>();
  for (const project of projects) {
    for (const dependencyName of project.project.dependencies) {
      const dependencies = projects.filter(p => p.project.name === dependencyName);
      if (!dependencies.length)
        throw new Error(`Project '${project.project.name}' depends on unknown project '${dependencyName}'`);
      if (dependencies.length > 1)
        throw new Error(`Project dependencies should have unique names, reading ${dependencyName}`);
      project.deps.push(...dependencies);
    }
    if (project.project.teardown) {
      const teardowns = projects.filter(p => p.project.name === project.project.teardown);
      if (!teardowns.length)
        throw new Error(`Project '${project.project.name}' has unknown teardown project '${project.project.teardown}'`);
      if (teardowns.length > 1)
        throw new Error(`Project teardowns should have unique names, reading ${project.project.teardown}`);
      const teardown = teardowns[0];
      project.teardown = teardown;
      if (teardownToSetup.has(teardown))
        throw new Error(`Project ${teardown.project.name} can not be designated as teardown to multiple projects (${teardownToSetup.get(teardown)!.project.name} and ${project.project.name})`);
      teardownToSetup.set(teardown, project);
    }
  }
  for (const teardown of teardownToSetup.keys()) {
    if (teardown.deps.length)
      throw new Error(`Teardown project ${teardown.project.name} must not have dependencies`);
  }
  for (const project of projects) {
    for (const dep of project.deps) {
      if (teardownToSetup.has(dep))
        throw new Error(`Project ${project.project.name} must not depend on a teardown project ${dep.project.name}`);
    }
  }
}

export function toReporters(reporters: BuiltInReporter | ReporterDescription[] | undefined): ReporterDescription[] | undefined {
  if (!reporters)
    return;
  if (typeof reporters === 'string')
    return [[reporters]];
  return reporters;
}

export const builtInReporters = ['list', 'line', 'dot', 'json', 'junit', 'null', 'github', 'html', 'blob'] as const;
export type BuiltInReporter = typeof builtInReporters[number];

export type ContextReuseMode = 'none' | 'force' | 'when-possible';

function resolveScript(id: string | undefined, rootDir: string): string | undefined {
  if (!id)
    return undefined;
  const localPath = path.resolve(rootDir, id);
  if (fs.existsSync(localPath))
    return localPath;
  return require.resolve(id, { paths: [rootDir] });
}

export const defaultGrep = /.*/;
export const defaultReporter = process.env.CI ? 'dot' : 'list';

const configInternalSymbol = Symbol('configInternalSymbol');
const projectInternalSymbol = Symbol('projectInternalSymbol');
