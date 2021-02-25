import { ObservableStore } from '@metamask/obs-store';
import EventEmitter from '@metamask/safe-event-emitter';
import { ethErrors, serializeError } from 'eth-rpc-errors';
import { IOcapLdCapability } from 'rpc-cap/dist/src/@types/ocap-ld';
import { IRequestedPermissions } from 'rpc-cap/dist/src/@types';
import { WorkerController, SetupWorkerConnection } from '../workers/WorkerController';
import { CommandResponse } from '../workers/CommandEngine';
import { INLINE_PLUGINS } from './inlinePlugins';

export const PLUGIN_PREFIX = 'wallet_plugin_';
export const PLUGIN_PREFIX_REGEX = new RegExp(`^${PLUGIN_PREFIX}`, 'u');

const SERIALIZABLE_PLUGIN_PROPERTIES = new Set([
  'initialPermissions',
  'name',
  'permissionName',
]);

export interface SerializablePlugin {
  initialPermissions: { [permission: string]: Record<string, unknown> };
  name: string;
  permissionName: string;
}

export interface Plugin extends SerializablePlugin {
  isActive: boolean;
  sourceCode: string;
}

// The plugin is the callee
export type PluginRpcHook = (origin: string, request: Record<string, unknown>) => Promise<CommandResponse>;

export type ProcessPluginReturnType = SerializablePlugin | { error: ReturnType<typeof serializeError> };
export interface InstalledPlugins {
  [pluginName: string]: ProcessPluginReturnType;
}

// Types that probably should be defined elsewhere in prod
type RemoveAllPermissionsFunction = (pluginIds: string[]) => void;
type CloseAllConnectionsFunction = (domain: string) => void;
type RequestPermissionsFunction = (domain: string, requestedPermissions: IRequestedPermissions) => IOcapLdCapability[];
type HasPermissionFunction = (domain: string, permissionName: string) => boolean;
type GetPermissionsFunction = (domain: string) => IOcapLdCapability[];

interface StoredPlugins {
  [pluginId: string]: Plugin;
}

export interface PluginControllerState {
  plugins: StoredPlugins;
  pluginStates: Record<string, unknown>;
}

export interface PluginControllerMemState {
  inlinePluginIsRunning: boolean;
  plugins: { [pluginId: string]: SerializablePlugin };
  pluginStates: Record<string, unknown>;
}

interface PluginControllerArgs {
  initState: Partial<PluginControllerState>;
  removeAllPermissionsFor: RemoveAllPermissionsFunction;
  setupWorkerPluginProvider: SetupWorkerConnection;
  closeAllConnections: CloseAllConnectionsFunction;
  requestPermissions: RequestPermissionsFunction;
  getPermissions: GetPermissionsFunction;
  hasPermission: HasPermissionFunction;
  workerUrl: URL;
}

/*
 * A plugin is initialized in three phases:
 * - Add: Loads the plugin from a remote source and parses it.
 * - Authorize: Requests the plugin's required permissions from the user.
 * - Start: Initializes the plugin in its SES realm with the authorized permissions.
 */

export class PluginController extends EventEmitter {

  public store: ObservableStore<PluginControllerState>;

  public memStore: ObservableStore<PluginControllerMemState>;

  private workerController: WorkerController;

  private _removeAllPermissionsFor: RemoveAllPermissionsFunction;

  private _pluginRpcHooks: Map<string, PluginRpcHook>;

  private _closeAllConnections: CloseAllConnectionsFunction;

  private _requestPermissions: RequestPermissionsFunction;

  private _getPermissions: GetPermissionsFunction;

  private _hasPermission: HasPermissionFunction;

  private _pluginsBeingAdded: Map<string, Promise<Plugin>>;

  constructor({
    initState,
    setupWorkerPluginProvider,
    removeAllPermissionsFor,
    closeAllConnections,
    requestPermissions,
    getPermissions,
    hasPermission,
    workerUrl,
  }: PluginControllerArgs) {
    super();
    const _initState: PluginControllerState = {
      plugins: {},
      pluginStates: {},
      ...initState,
    };

    this.store = new ObservableStore({
      plugins: {},
      pluginStates: {},
    });

    this.memStore = new ObservableStore({
      inlinePluginIsRunning: false,
      plugins: {},
      pluginStates: {},
    });
    this.updateState(_initState);

    this.workerController = new WorkerController({
      setupWorkerConnection: setupWorkerPluginProvider,
      workerUrl,
    });

    this._removeAllPermissionsFor = removeAllPermissionsFor;
    this._closeAllConnections = closeAllConnections;
    this._requestPermissions = requestPermissions;
    this._getPermissions = getPermissions;
    this._hasPermission = hasPermission;

    this._pluginRpcHooks = new Map();
    this._pluginsBeingAdded = new Map();
  }

  updateState(newState: Partial<PluginControllerState>) {
    this.store.updateState(newState);
    this.memStore.updateState(this._filterMemStoreState(newState));
  }

  _filterMemStoreState(newState: Partial<PluginControllerState>): Partial<PluginControllerMemState> {
    const memState: Partial<PluginControllerMemState> = {
      ...newState,
      plugins: {},
    };

    // remove sourceCode from memState plugin objects
    if (newState.plugins) {
      Object.keys(newState.plugins).forEach((name) => {
        const plugin = { ...(newState as PluginControllerState).plugins[name] };
        delete (plugin as Partial<Plugin>).sourceCode;
        (memState as PluginControllerMemState).plugins[name] = plugin;
      });
    }

    return memState;
  }

  /**
   * Runs existing (installed) plugins.
   */
  runExistingPlugins(): void {

    const { plugins } = this.store.getState();

    if (Object.keys(plugins).length > 0) {
      console.log('running existing plugins', plugins);
    } else {
      console.log('no existing plugins to run');
      return;
    }

    Object.values(plugins).forEach(({ name: pluginName, sourceCode }) => {

      console.log(`running: ${pluginName}`);

      try {
        this._startPluginInWorker(pluginName, sourceCode);
      } catch (err) {

        console.warn(`failed to start '${pluginName}', deleting it`);
        // Clean up failed plugins:
        this.removePlugin(pluginName);
      }
    });
  }

  /**
   * Gets the plugin with the given name if it exists, including all data.
   * This should not be used if the plugin is to be serializable, as e.g.
   * the plugin sourceCode may be quite large.
   *
   * @param pluginName - The name of the plugin to get.
   */
  get(pluginName: string) {
    return this.store.getState().plugins[pluginName];
  }

  /**
   * Gets the plugin with the given name if it exists, excluding any
   * non-serializable or expensive-to-serialize data.
   *
   * @param pluginName - The name of the plugin to get.
   */
  getSerializable(pluginName: string): SerializablePlugin | null {
    const plugin = this.get(pluginName);

    return plugin
      // The cast to "any" of the accumulator object is due to a TypeScript bug
      ? Object.keys(plugin).reduce((serialized, key) => {
        if (SERIALIZABLE_PLUGIN_PROPERTIES.has(key as keyof Plugin)) {
          serialized[key] = plugin[key as keyof SerializablePlugin];
        }

        return serialized;
      }, {} as any) as SerializablePlugin
      : null;
  }

  /**
   * Updates the own state of the plugin with the given name.
   * This is distinct from the state MetaMask uses to manage plugins.
   *
   * @param pluginName - The name of the plugin whose state should be updated.
   * @param newPluginState - The new state of the plugin.
   */
  async updatePluginState(
    pluginName: string,
    newPluginState: unknown,
  ): Promise<void> {
    const state = this.store.getState();
    const newPluginStates = { ...state.pluginStates, [pluginName]: newPluginState };

    this.updateState({
      pluginStates: newPluginStates,
    });
  }

  /**
   * Gets the own state of the plugin with the given name.
   * This is distinct from the state MetaMask uses to manage plugins.
   *
   * @param pluginName - The name of the plugin whose state to get.
   */
  async getPluginState(pluginName: string): Promise<unknown> {
    return this.store.getState().pluginStates[pluginName];
  }

  /**
   * Completely clear the controller's state: delete all associated data,
   * handlers, event listeners, and permissions; tear down all plugin providers.
   */
  clearState() {
    this._pluginRpcHooks.clear();
    const pluginNames = Object.keys((this.store.getState()).plugins);
    this.updateState({
      plugins: {},
      pluginStates: {},
    });
    pluginNames.forEach((name) => {
      this._closeAllConnections(name);
    });
    this.workerController.terminateAll();
    this._removeAllPermissionsFor(pluginNames);
    this.memStore.updateState({
      inlinePluginIsRunning: false,
    });
  }

  /**
   * Removes the given plugin from state, and clears all associated handlers
   * and listeners.
   *
   * @param pluginName - The name of the plugin.
   */
  removePlugin(pluginName: string): void {
    this.removePlugins([pluginName]);
  }

  /**
   * Removes the given plugins from state, and clears all associated handlers
   * and listeners.
   *
   * @param {Array<string>} pluginName - The name of the plugins.
   */
  removePlugins(pluginNames: string[]): void {
    if (!Array.isArray(pluginNames)) {
      throw new Error('Expected array of plugin names.');
    }

    const state = this.store.getState();
    const newPlugins = { ...state.plugins };
    const newPluginStates = { ...state.pluginStates };

    pluginNames.forEach((name) => {
      // this._removeMetaMaskEventListeners(name)
      // this.rpcMessageHandlers.delete(name)
      // this.accountMessageHandlers.delete(name)
      this._removePluginHooks(name);
      this._closeAllConnections(name);
      this.workerController.terminateWorkerOf(name);
      delete newPlugins[name];
      delete newPluginStates[name];
    });
    this._removeAllPermissionsFor(pluginNames);

    this.updateState({
      plugins: newPlugins,
      pluginStates: newPluginStates,
    });
  }

  getPermittedPlugins(origin: string): InstalledPlugins {
    return this._getPermissions(origin).reduce(
      (permittedPlugins, perm) => {
        if (perm.parentCapability.startsWith(PLUGIN_PREFIX)) {

          const pluginName = perm.parentCapability.replace(PLUGIN_PREFIX_REGEX, '');
          const plugin = this.getSerializable(pluginName);

          permittedPlugins[pluginName] = plugin || {
            error: serializeError(new Error('Plugin permitted but not installed.')),
          };
        }
        return permittedPlugins;
      },
      {} as InstalledPlugins,
    );
  }

  async installPlugins(origin: string, requestedPlugins: IRequestedPermissions): Promise<InstalledPlugins> {
    const result: InstalledPlugins = {};

    // use a for-loop so that we can return an object and await the resolution
    // of each call to processRequestedPlugin
    await Promise.all(Object.keys(requestedPlugins).map(async (pluginName) => {
      const permissionName = PLUGIN_PREFIX + pluginName;

      if (this._hasPermission(origin, permissionName)) {
        // attempt to install and run the plugin, storing any errors that
        // occur during the process
        result[pluginName] = {
          ...(await this.processRequestedPlugin(pluginName)),
        };
      } else {
        // only allow the installation of permitted plugins
        result[pluginName] = {
          error: ethErrors.provider.unauthorized(
            `Not authorized to install plugin '${pluginName}'. Request the permission for the plugin before attempting to install it.`,
          ),
        };
      }
    }));
    return result;
  }

  /**
   * Adds, authorizes, and runs the given plugin with a plugin provider.
   * Results from this method should be efficiently serializable.
   *
   * @param - pluginName - The name of the plugin.
   */
  async processRequestedPlugin(pluginName: string): Promise<ProcessPluginReturnType> {
    // if the plugin is already installed and active, just return it
    const plugin = this.get(pluginName);
    if (plugin?.isActive) {
      return this.getSerializable(pluginName) as SerializablePlugin;
    }

    try {
      const { sourceCode } = await this.add(pluginName);

      await this.authorize(pluginName);

      await this._startPluginInWorker(pluginName, sourceCode);

      return this.getSerializable(pluginName) as SerializablePlugin;
    } catch (err) {
      console.error(`Error when adding plugin.`, err);
      return { error: serializeError(err) };
    }
  }

  /**
   * Returns a promise representing the complete installation of the requested plugin.
   * If the plugin is already being installed, the previously pending promise will be returned.
   *
   * @param pluginName - The name of the plugin.
   * @param sourceUrl - The URL of the source code.
   */
  add(pluginName: string, sourceUrl?: string): Promise<Plugin> {
    console.log(`Adding ${sourceUrl || pluginName}`);

    // Deduplicate multiple add requests:
    if (!this._pluginsBeingAdded.has(pluginName)) {
      this._pluginsBeingAdded.set(pluginName, this._add(pluginName));
    }

    return this._pluginsBeingAdded.get(pluginName) as Promise<Plugin>;
  }

  /**
   * Internal method. See the add method.
   *
   * @param pluginName - The name of the plugin.
   * @param [sourceUrl] - The URL of the source code.
   */
  async _add(pluginName: string, sourceUrl?: string): Promise<Plugin> {
    const _sourceUrl = sourceUrl || pluginName;

    if (!pluginName || typeof pluginName !== 'string') {
      throw new Error(`Invalid plugin name: ${pluginName}`);
    }

    let plugin: Plugin;
    try {
      console.log(`Fetching ${_sourceUrl}`);
      const pluginSource = await fetch(_sourceUrl);
      const pluginJson = await pluginSource.json();

      console.log(`Destructuring`, pluginJson);
      const { web3Wallet: { bundle, initialPermissions } } = pluginJson;

      console.log(`Fetching bundle ${bundle.url}`);
      const pluginBundle = await fetch(bundle.url);
      const sourceCode = await pluginBundle.text();

      console.log(`Constructing plugin`);
      plugin = {
        // manifest: {}, // relevant manifest metadata
        name: pluginName,
        initialPermissions,
        permissionName: PLUGIN_PREFIX + pluginName, // so we can easily correlate them
        sourceCode,
        isActive: false,
      };
    } catch (err) {
      throw new Error(`Problem loading plugin ${pluginName}: ${err.message}`);
    }

    const pluginsState = this.store.getState().plugins;

    // restore relevant plugin state if it exists
    if (pluginsState[pluginName]) {
      plugin = { ...pluginsState[pluginName], ...plugin };
    }

    // store the plugin back in state
    this.updateState({
      plugins: {
        ...pluginsState,
        [pluginName]: plugin,
      },
    });

    return plugin;
  }

  /**
   * Initiates a request for the given plugin's initial permissions.
   * Must be called in order. See processRequestedPlugin.
   *
   * @param pluginName - The name of the plugin.
   * @returns - Resolves to the plugin's approvedPermissions, or rejects on error.
   */
  async authorize(pluginName: string): Promise<string[]> {
    console.log(`authorizing ${pluginName}`);
    const pluginsState = this.store.getState().plugins;
    const plugin = pluginsState[pluginName];
    const { initialPermissions } = plugin;

    // Don't prompt if there are no permissions requested:
    if (Object.keys(initialPermissions).length === 0) {
      return [];
    }

    try {
      const approvedPermissions = await this._requestPermissions(
        pluginName, initialPermissions,
      );
      return approvedPermissions.map((perm) => perm.parentCapability);
    } finally {
      this._pluginsBeingAdded.delete(pluginName);
    }
  }

  // _registerAccountMessageHandler (pluginName, handler) {
  //   this.accountMessageHandlers.set(pluginName, handler)
  // }

  runInlinePlugin(inlinePluginName: keyof typeof INLINE_PLUGINS = 'IDLE') {
    this._startPluginInWorker(
      'inlinePlugin',
      INLINE_PLUGINS[inlinePluginName],
    );
    this.memStore.updateState({
      inlinePluginIsRunning: true,
    });
  }

  removeInlinePlugin() {
    this.memStore.updateState({
      inlinePluginIsRunning: false,
    });
    this.removePlugin('inlinePlugin');
  }

  private async _startPluginInWorker(pluginName: string, sourceCode: string) {
    const workerId = await this.workerController.createPluginWorker(
      { hostname: pluginName },
    );
    this._createPluginHooks(pluginName, workerId);
    await this.workerController.startPlugin(workerId, {
      pluginName,
      sourceCode,
    });
    this._setPluginToActive(pluginName);
  }

  getRpcMessageHandler(pluginName: string): PluginRpcHook | undefined {
    return this._pluginRpcHooks.get(pluginName);
  }

  private _createPluginHooks(pluginName: string, workerId: string) {
    const rpcHook = async (origin: string, request: Record<string, unknown>) => {
      return await this.workerController.command(workerId, {
        command: 'pluginRpc',
        data: {
          origin,
          request,
          target: pluginName,
        },
      });
    };

    this._pluginRpcHooks.set(pluginName, rpcHook);
  }

  _removePluginHooks(pluginName: string) {
    this._pluginRpcHooks.delete(pluginName);
  }

  _setPluginToActive(pluginName: string): void {
    this._updatePlugin(pluginName, 'isActive', true);
  }

  _setPluginToInActive(pluginName: string): void {
    this._updatePlugin(pluginName, 'isActive', false);
  }

  _updatePlugin(pluginName: string, property: keyof Plugin, value: unknown) {
    const { plugins } = this.store.getState();
    const plugin = plugins[pluginName];
    const newPlugin = { ...plugin, [property]: value };
    const newPlugins = { ...plugins, [pluginName]: newPlugin };
    this.updateState({
      plugins: newPlugins,
    });
  }
}