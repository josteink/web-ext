/* @flow */
import nodeFs from 'fs';
import path from 'path';
import {default as defaultFxRunner} from 'fx-runner';
import FirefoxProfile, {copyFromUserProfile as defaultUserProfileCopier}
  from 'firefox-profile';
import streamToPromise from 'stream-to-promise';
import {fs} from 'mz';
import promisify from 'es6-promisify';

import isDirectory from '../util/is-directory';
import {isErrorWithCode, UsageError, WebExtError} from '../errors';
import {getPrefs as defaultPrefGetter} from './preferences';
import {getManifestId} from '../util/manifest';
import {createLogger} from '../util/logger';
import {default as defaultFirefoxConnector, REMOTE_PORT} from './remote';


const log = createLogger(__filename);

export const defaultFirefoxEnv = {
  XPCOM_DEBUG_BREAK: 'stack',
  NS_TRACE_MALLOC_DISABLE_STACKS: '1',
};


// Import flow types.

import type {FirefoxConnectorFn} from './remote';
import type {ChildProcess} from 'child_process';
import type {
  PreferencesAppName,
  PreferencesGetterFn,
} from './preferences';

import type {ExtensionManifest} from '../util/manifest';


// defaultRemotePortFinder types and implementation.

export type RemotePortFinderParams = {
  portToTry?: number,
  retriesLeft?: number,
  connectToFirefox?: FirefoxConnectorFn,
};

export type RemotePortFinderFn =
  (params?: RemotePortFinderParams) => Promise<number>;

export async function defaultRemotePortFinder(
  {
    portToTry = REMOTE_PORT,
    retriesLeft = 10,
    connectToFirefox = defaultFirefoxConnector,
  }: RemotePortFinderParams = {}
): Promise<number> {
  log.debug(`Checking if remote Firefox port ${portToTry} is available`);

  let client;

  while (retriesLeft >= 0) {
    try {
      client = await connectToFirefox(portToTry);
      log.debug(`Remote Firefox port ${portToTry} is in use ` +
                `(retries remaining: ${retriesLeft})`);
    } catch (error) {
      if (isErrorWithCode('ECONNREFUSED', error)) {
        // The connection was refused so this port is good to use.
        return portToTry;
      }

      throw error;
    }

    client.disconnect();
    portToTry++;
    retriesLeft--;
  }

  throw new WebExtError('Too many retries on port search');
}


// Declare the needed 'fx-runner' module flow types.

export type FirefoxRunnerParams = {
  binary: ?string,
  profile?: string,
  'new-instance'?: boolean,
  'no-remote'?: boolean,
  'foreground'?: boolean,
  'listen': number,
  'binary-args'?: Array<string> | string,
  'env'?: {
    [key: string]: string
  },
  'verbose'?: boolean,
};

// NOTE: alias FirefoxProcess to a node ChildProcess type
export type FirefoxProcess = ChildProcess;

export type FirefoxRunnerResults = {
  process: FirefoxProcess,
  binary: string,
  args: Array<string>,
};

export type FirefoxRunnerFn =
  (params: FirefoxRunnerParams) => Promise<FirefoxRunnerResults>;


// Run command types and implementaion.

export type FirefoxRunOptions = {
  fxRunner?: FirefoxRunnerFn,
  findRemotePort?: RemotePortFinderFn,
  firefoxBinary: ?string,
  binaryArgs?: Array<string>,
};

/*
 * Runs Firefox with the given profile object and resolves a promise on exit.
 */
export async function run(
  profile: FirefoxProfile,
  {
    fxRunner = defaultFxRunner,
    findRemotePort = defaultRemotePortFinder,
    firefoxBinary, binaryArgs,
  }: FirefoxRunOptions = {}
): Promise<FirefoxProcess> {

  log.info(`Running Firefox with profile at ${profile.path()}`);

  const remotePort = await findRemotePort();

  const results = await fxRunner({
    // if this is falsey, fxRunner tries to find the default one.
    'binary': firefoxBinary,
    'binary-args': binaryArgs,
    // This ensures a new instance of Firefox is created. It has nothing
    // to do with the devtools remote debugger.
    'no-remote': true,
    'listen': remotePort,
    'foreground': true,
    'profile': profile.path(),
    'env': {
      ...process.env,
      ...defaultFirefoxEnv,
    },
    'verbose': true,
  });

  const firefox = results.process;

  log.debug(`Executing Firefox binary: ${results.binary}`);
  log.debug(`Firefox args: ${results.args.join(' ')}`);

  firefox.on('error', (error) => {
    // TODO: show a nice error when it can't find Firefox.
    // if (/No such file/.test(err) || err.code === 'ENOENT') {
    log.error(`Firefox error: ${error}`);
    throw error;
  });

  log.info(
    'Use --verbose or open Tools > Web Developer > Browser Console ' +
    'to see logging');

  firefox.stderr.on('data', (data) => {
    log.debug(`Firefox stderr: ${data.toString().trim()}`);
  });

  firefox.stdout.on('data', (data) => {
    log.debug(`Firefox stdout: ${data.toString().trim()}`);
  });

  firefox.on('close', () => {
    log.debug('Firefox closed');
  });

  return firefox;
}


// configureProfile types and implementation.

export type ConfigureProfileOptions = {
  app?: PreferencesAppName,
  getPrefs?: PreferencesGetterFn,
};

export type ConfigureProfileFn = (
  profile: FirefoxProfile,
  options?: ConfigureProfileOptions
) => Promise<FirefoxProfile>;

/*
 * Configures a profile with common preferences that are required to
 * activate extension development.
 *
 * Returns a promise that resolves with the original profile object.
 */
export function configureProfile(
  profile: FirefoxProfile,
  {
    app = 'firefox',
    getPrefs = defaultPrefGetter,
  }: ConfigureProfileOptions = {}
): Promise<FirefoxProfile> {
  // Set default preferences. Some of these are required for the add-on to
  // operate, such as disabling signatures.
  // TODO: support custom preferences.
  // https://github.com/mozilla/web-ext/issues/88
  let prefs = getPrefs(app);
  Object.keys(prefs).forEach((pref) => {
    profile.setPreference(pref, prefs[pref]);
  });
  profile.updatePreferences();
  return Promise.resolve(profile);
}


// createProfile types and implementation.

export type CreateProfileParams = {
  app?: PreferencesAppName,
  configureThisProfile?: ConfigureProfileFn,
};

/*
 * Creates a new temporary profile and resolves with the profile object.
 *
 * The profile will be deleted when the system process exits.
 */
export async function createProfile(
  {app, configureThisProfile = configureProfile}: CreateProfileParams = {}
): Promise<FirefoxProfile> {
  const profile = new FirefoxProfile();
  return await configureThisProfile(profile, {app});
}


// copyProfile types and implementation.

export type CopyProfileOptions = {
  app?: PreferencesAppName,
  copyFromUserProfile?: Function,
  configureThisProfile?: ConfigureProfileFn,
};

/*
 * Copies an existing Firefox profile and creates a new temporary profile.
 * The new profile will be configured with some preferences required to
 * activate extension development.
 *
 * It resolves with the new profile object.
 *
 * The temporary profile will be deleted when the system process exits.
 *
 * The existing profile can be specified as a directory path or a name of
 * one that exists in the current user's Firefox directory.
 */
export async function copyProfile(
  profileDirectory: string,
  {
    copyFromUserProfile = defaultUserProfileCopier,
    configureThisProfile = configureProfile,
    app,
  }: CopyProfileOptions = {}
): Promise<FirefoxProfile> {

  let copy = promisify(FirefoxProfile.copy);
  let copyByName = promisify(copyFromUserProfile);

  try {
    const dirExists = await isDirectory(profileDirectory);

    let profile;

    if (dirExists) {
      log.debug(`Copying profile directory from "${profileDirectory}"`);
      profile = await copy({profileDirectory});
    } else {
      log.debug(`Assuming ${profileDirectory} is a named profile`);
      profile = await copyByName({name: profileDirectory});
    }

    return configureThisProfile(profile, {app});
  } catch (error) {
    throw new WebExtError(
      `Could not copy Firefox profile from ${profileDirectory}: ${error}`);
  }
}


// installExtension types and implementation.

export type InstallExtensionParams = {
  asProxy?: boolean,
  manifestData: ExtensionManifest,
  profile: FirefoxProfile,
  extensionPath: string,
};

/*
 * Installs an extension into the given Firefox profile object.
 * Resolves when complete.
 *
 * The extension is copied into a special location and you need to turn
 * on some preferences to allow this. See extensions.autoDisableScopes in
 * ./preferences.js.
 *
 * When asProxy is true, a special proxy file will be installed. This is a
 * text file that contains the path to the extension source.
 */
export async function installExtension(
  {
    asProxy = false,
    manifestData,
    profile,
    extensionPath,
  }: InstallExtensionParams): Promise<any> {
  // This more or less follows
  // https://github.com/saadtazi/firefox-profile-js/blob/master/lib/firefox_profile.js#L531
  // (which is broken for web extensions).
  // TODO: maybe uplift a patch that supports web extensions instead?

  if (!profile.extensionsDir) {
    throw new WebExtError('profile.extensionsDir was unexpectedly empty');
  }

  try {
    await fs.stat(profile.extensionsDir);
  } catch (error) {
    if (isErrorWithCode('ENOENT', error)) {
      log.debug(`Creating extensions directory: ${profile.extensionsDir}`);
      await fs.mkdir(profile.extensionsDir);
    } else {
      throw error;
    }
  }

  const id = getManifestId(manifestData);
  if (!id) {
    throw new UsageError(
      'An explicit extension ID is required when installing to ' +
      'a profile (applications.gecko.id not found in manifest.json)');
  }

  if (asProxy) {
    log.debug(`Installing as an extension proxy; source: ${extensionPath}`);

    const isDir = await isDirectory(extensionPath);
    if (!isDir) {
      throw new WebExtError(
        'proxy install: extensionPath must be the extension source ' +
        `directory; got: ${extensionPath}`);
    }

    // Write a special extension proxy file containing the source
    // directory. See:
    // https://developer.mozilla.org/en-US/Add-ons/Setting_up_extension_development_environment#Firefox_extension_proxy_file
    const destPath = path.join(profile.extensionsDir, `${id}`);
    const writeStream = nodeFs.createWriteStream(destPath);
    writeStream.write(extensionPath);
    writeStream.end();
    await streamToPromise(writeStream);
  } else {
    // Write the XPI file to the profile.
    const readStream = nodeFs.createReadStream(extensionPath);
    const destPath = path.join(profile.extensionsDir, `${id}.xpi`);
    const writeStream = nodeFs.createWriteStream(destPath);

    log.debug(`Installing extension from ${extensionPath} to ${destPath}`);
    readStream.pipe(writeStream);

    return await Promise.all([
      streamToPromise(readStream),
      streamToPromise(writeStream),
    ]);
  }
}
