/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, keep the profile patch layer
 * live, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 *
 * **为每个 dsh 运行界面共享初始化 Profile：
 * **解析 Profile，按顺序叠加它的各个补丁层
 *（dsh.profile.bundles 中定义的 bundle 层
 *→ Profile 自己的 cordis.patch.yml
 *→ --patch 指定的覆盖层
 *→ telemetry 开关），然后将这棵配置树挂载到 Profile 的空根配置之上；
 *保持 Profile 的补丁层处于持续生效状态，
 * 并接入“失败即报错（fail-loud）”机制以及有界的关闭流程。
 *
 * **应用程序的 flags 参数不属于 launcher 的职责范围：
 * **调用时传入的内部参数会通过 ctx.cmdlineArgs
 * 提供给这棵配置树，任何被注入的 app plugin 都可以读取同一个不可变的参数快照。
 *
 * @module @deepseek-ai/dsh/profile-boot
 */

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  watchUserPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Shipped agent-preset root: beside this app's own config, in both source and built layouts.
 * **已发布的 agent-preset 根目录：
 * 与这个 app 的 own config 并排，在源码和构建布局中都有。
*/
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 *
 * **机器本地的用户补丁层（$DSH_HOME/cordis.patch.yml），
 * 应用在每个 Profile 的补丁层之上。
 * 每次调用时解析，而不是在模块加载时解析：
 * `$DSH_HOME` 可能由测试或 launcher 在导入后设置。
 * @returns 返回绝对补丁文件路径。
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli).
 * **这个 dsh 安装的 package.json 的绝对路径（两个锚点：src/ 和 lib/ 都位于 apps/cli 下一级）。
*/
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets.
 * DSH_TELEMETRY_DISABLED 开关所针对的会话遥测（session-telemetry）行 id。
 */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list every profile tree patches over.
 * 每个 profile 配置树在其之上打补丁的空根 entry 列表。
 */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
# dsh profile 根配置 — 一个空的 entry 列表。这棵树由补丁组合而成：
# 依次是 package.json 中 dsh.profile.bundles 里的每个 bundle，然后是 cordis.patch.yml，然后是任何
# --patch 覆盖层。请编辑 cordis.patch.yml，而不是这个文件。
[]
`

/** Root config filename inside a profile directory.
 * profile 目录内的根配置文件名称。
 */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 *
 * **将 telemetry 开关解析为它的启动补丁。
 * 任何非空值（包括 `'0'`/`'false'`）都会禁用：一个隐私开关更倾向于关闭错误而不是打开错误。
 * 一个没有 telemetry 行的 composition 导出 nothing，所以这个开关被 trivially 满足并且不会生成补丁 — 自定义的 profile 不需要挂载 telemetry 来运行。
 * @param disabledEnv - 原始的 `DSH_TELEMETRY_DISABLED` 值（未设置时为 `undefined`）。
 * @param hasRow - 是否 composition 携带 telemetry 行。
 * @returns 禁用 patch，或者当不需要硬禁用 patch 时为 `undefined`。
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Load a resolved profile for `name`: heal the shared module fallback, then
 * (re)write the empty root config. The root is always rewritten: the whole
 * composition is patch layers, and the vendored Loader's tree write-back (a
 * plugin self-disposing persists the current tree) can bake composed rows
 * into this file — which would duplicate every bundle insert on the next
 * boot. The file exists on disk only because the Loader needs a real include
 * root to anchor `baseUrl` at the profile directory (the config dump anchors
 * on the same file, so both compose over the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @returns the loaded profile.
 *
 * 加载名为 `name` 的已解析 profile：
 * 修复共享模块回退，然后（重新）写入空根配置。
 * 根配置总是被重写：整个组合就是补丁层，vendored Loader 的树写回
 * （插件自销毁时会持久化当前树）可能把组合出的行烤进这个文件 —
 * 这会在下一次启动时把每个 bundle 的插入行重复一遍。
 * 这个文件存在于磁盘上，只是因为 Loader 需要一个真实的 include 根，
 * 以便把 `baseUrl` 锚定在 profile 目录上（配置 dump 也锚定在同一个文件上，
 * 所以两者都在相同的基础上组合）。
 * @param name - profile 名称。
 * @param userLayer - `false` 时跳过解析 `cordis.patch.yml`（默认 dump 场景）。
 * @returns 加载后的 profile。
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch layers (application order) and the row index of its pre-flag composition.
 * 一个 profile 的补丁层（按应用顺序），以及它组合结果（launcher 自身行检查之前）的 entry 行索引。
 */
interface ComposedProfile {
  profile: Profile
  /** Bundle layers concatenated — the part below the user layers on a live reload.
   * 拼接在一起的 bundle 层 — 实时重载时位于用户层之下的部分。
   */
  bundlePatches: PatchOptions[]
  /** The home-level user layer (`$DSH_HOME/cordis.patch.yml`), applied after the profile's own.
   * 机器本级的用户层（`$DSH_HOME/cordis.patch.yml`），应用在 profile 自己的层之后。
   */
  homePatches: PatchOptions[]
  /** Layers above the user layers on a live reload: `--patch` overlays and the telemetry switch.
   * 实时重载时位于用户层之上的层：`--patch` 覆盖层和 telemetry 开关。
   */
  overlays: PatchOptions[]
  /**
   * id → row of the composed tree (bundles + user layers + overlays), for the
   * launcher's own row checks.
   * 组合后的配置树中 id → entry 行的映射（bundle + 用户层 + 覆盖层），
   * 供 launcher 自己做行检查。
   */
  rows: ReadonlyMap<string, EntryOptions>
}

/** The full patch stack of one composed profile, in application order.
 * 一个已组合 profile 的完整补丁栈，按应用顺序排列。
 */
function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...composed.overlays,
  ]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (the base bundle gates the shell stacks by
 * platform on its own rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile, its patch layers, and the composed row index.
 *
 * 加载 `name` 并组合出它的有效补丁栈：按 `dsh.profile.bundles` 顺序的 bundle 层
 * （基础 bundle 在其自己的行上按平台把关 shell 栈）、profile 的用户层、机器本级用户
 * 层（`$DSH_HOME/cordis.patch.yml` — 适用于每个 profile 的机器本地偏好，
 * 因此它的优先级高于 profile 自己的层）、`--patch` 覆盖层，最后是 telemetry 开关。
 * @param name - profile 名称。
 * @param patchFiles - `--patch` 覆盖层路径，按 argv 顺序。
 * @returns profile、它的补丁层以及组合后的行索引。
 */
function composeProfile(
  name: string,
  patchFiles: readonly string[],
): ComposedProfile {
  const profile = prepareProfile(name)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const composedOverlays = [...overlays]
  // The SHIPPED root is the part of the roster only this app can resolve: it
  // sits beside this app's own config, in both the source and built layouts.
  // The writable root the roster appends is `dsh-agent-presets`' own, so a
  // launcher that never reaches this patch still finds a person's presets.
  // SHIPPED 根目录是 roster 中只有本 app 才能解析的部分：它位于本 app 自身配置的旁边，
  // 在源码和构建布局中都是如此。roster 追加的可写根目录属于 `dsh-agent-presets`
  // 自己，所以从未走到这个补丁的 launcher 也仍能找到用户的 presets。
  if (rows.has('agent-presets')) {
    composedOverlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    })
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
  return { profile, bundlePatches, homePatches, overlays: composedOverlays, rows }
}

/** Options for {@link runProfile}.
 * {@link runProfile} 的选项。
 */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts.
   * 本次运行的冻结环境快照，在任何 entry 挂载之前提供。
   */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot.
   * 要启动的 profile 名称。
   */
  profile: string
  /** `--patch` overlay paths, in argv order.
   * `--patch` 覆盖层路径，按 argv 顺序。
   */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`.
   * 本次调用的内部参数，通过 `ctx.cmdlineArgs` 交给配置树。
   */
  args: readonly string[]
}

/**
 * Re-throw a watcher-setup failure unless a shutdown already owns the tree:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @param error - the setup failure.
 *
 * 除非一次关闭流程已经接管了这棵树，否则重新抛出 watcher 安装失败：
 * 可能是一个信号中止了本次调用，或者某个 app 请求了退出（快速一次性 app 的
 * `ctx.appExit`），而根 fiber 的销毁拒绝了仍在进行中的安装 await。
 * 无论哪种情况，这个失败描述的都是一棵正在按用户要求退出的树，而不是 watch 坏了。
 * @param ctx - 已启动的根 context。
 * @param signal - 本次调用中“信号触发关闭”这一事实。
 * @param error - 安装失败本身。
 */
function suppressShutdownError(ctx: Context, signal: AbortSignal, error: unknown): void {
  if (signal.aborted) return
  if (ctx.fiber.state !== FiberState.ACTIVE || ctx.get('loader') === undefined) return
  throw error
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 *
 * 端到端地启动一次 profile 调用，并把进程生命周期留给挂载的插件
 * （或组合中挂载的一次性 runner）。
 * @param options - 环境快照、profile 名称、覆盖层，以及被启动 app 自己的参数。
 * @returns 已稳定下来的根 context 和关闭控制器。
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const composed = composeProfile(options.profile, options.patchFiles)
  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => { await app.current?.fiber.dispose() })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted provider can publish before sibling rows finish mounting.
  // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
  // surface — the launcher does not know whether the app considered its work
  // complete; SIGINT is a user interrupt and reports 130.
  // 信号在整个启动窗口期间都拥有清理权，而不仅仅是在 boot() 稳定之后：
  // 被插入的 provider 可能在兄弟行尚未完成挂载时就先发布服务。
  // SIGTERM 是监督者的常规停止请求，在所有界面下都以 0 退出 —
  // launcher 并不知道 app 是否认为自己的工作已完成；SIGINT 是用户中断，报告 130。
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  // Recomposition for the live user layers: bundle layers below, overlays
  // above, so a user edit can never displace them. Parsed app arguments are
  // not in here at all — they live in app-provided services that survive a
  // recomposition. BOTH
  // user files are re-read per generation (the HMR watcher hands us only the
  // changed file's patches, which one of the reads duplicates — fresh reads
  // keep the two watchers from stitching in each other's stale copy).
  // Fresh clones per generation: the include pushes `insert` rows into the
  // mounted tree BY REFERENCE and later id-targeted patches mutate those
  // objects in place. Reusing one parsed patch object across applications
  // would bake a user override into the bundle's in-memory insert row, so
  // removing the override could never revert the row to the bundle default.
  // 为实时用户层做重新组合：bundle 层在下、覆盖层在上，这样用户的编辑永远无法挤开它们。
  // 解析后的 app 参数完全不在这里 — 它们位于 app 提供的服务里，这些服务在重新组合后依然存在。
  // 两个用户文件在每一代都会重新读取（HMR watcher 只交给我们变更文件的那份补丁，
  // 其中一次读取会重复读到它 — 每次都新鲜读取可以让两个 watcher 不会拼进对方的过期副本）。
  // 每一代都使用全新的克隆：include 会把 `insert` 行以引用方式推进已挂载的树，
  // 之后的按 id 定位补丁会原地修改这些对象。如果跨多次应用复用同一个解析出的补丁对象，
  // 用户的覆盖就会永久烤进 bundle 的内存插入行，删掉覆盖后也无法把该行恢复成 bundle 默认值。
  const composeLive = (): PatchOptions[] => structuredClone([
    ...composed.bundlePatches,
    ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
    ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
    ...composed.overlays,
  ])
  // Cloned for the same insert-aliasing reason as composeLive: the boot
  // application must not mutate the objects later reloads recompose from.
  // 与 composeLive 出于同样的插入行别名原因进行克隆：启动时的应用
  // 绝不能修改之后重载时用来重新组合的那些对象。
  const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), (hostCtx) => {
    app.current = hostCtx
    // Before any config-tree entry mounts, so plugins resolve all launch-time
    // environment values from the same immutable provenance snapshot.
    // 在配置树的任何 entry 挂载之前注入，这样插件就能从同一个不可变的来源快照
    // 解析所有启动时的环境值。
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
    // The command line and bounded exit request are launcher facts available
    // to every app plugin that injects the argument snapshot.
    // 命令行和有界退出请求是 launcher 提供的事实，
    // 任何注入了参数快照的 app 插件都可以使用。
    provideCmdline(hostCtx, {
      args: options.args,
      exit: code => void shutdown.shutdown(code),
    })
  })
  app.current = ctx
  // A surface can dispose the whole tree while boot or this post-boot watcher
  // setup is still in flight — a signal, or a fast one-shot's appExit. Loader
  // presence and fiber state own liveness; the initial check skips a tree
  // that already exited, and the catch below re-checks for an exit that
  // landed mid-setup. Watching is unconditional: a one-shot surface exits
  // through its bounded shutdown, which disposes the watchers before the
  // loop drains.
  // 某个界面可能在 boot 或这个启动后的 watcher 安装仍在进行时销毁整棵树 —
  // 比如一个信号，或快速一次性 app 的 appExit。Loader 是否存在以及 fiber 状态
  // 决定树是否存活；这里的初始检查会跳过一棵已经退出的树，下面的 catch 会
  // 重新检查是否在安装中途发生了退出。watch 是无条件的：一次性界面通过它的
  // 有界关闭流程退出，该流程会在事件循环排空之前销毁 watchers。
  if (!signalShutdown.signal.aborted
    && ctx.fiber.state === FiberState.ACTIVE
    && ctx.get('loader') !== undefined) {
    try {
      // Config-only HMR for the live profile patch layer: the web bundle
      // disables the shared module-reload `hmr` row (its reload lifecycle is
      // untested), so when the composition leaves no HMR service, mount a
      // watch-only instance with no module roots — cordis.patch.yml edits stay
      // live on every long-lived surface. A silent skip would break the
      // documented hot-reload contract. HMR injects the timer service, which a
      // bare custom profile may not mount either.
      // 为实时生效的 profile 补丁层做仅配置的 HMR：web bundle 禁用了共享的模块重载
      // `hmr` 行（它的重载生命周期未经测试），所以当组合中没有 HMR 服务时，挂载一个
      // 不带模块根目录的仅监听实例 — 这样 cordis.patch.yml 的编辑在任何长生命周期
      // 界面上都能实时生效。静默跳过会破坏文档承诺的热重载契约。HMR 会注入 timer
      // 服务，而一个精简的自定义 profile 可能也没有挂载 timer。
      if (ctx.get('hmr') === undefined) {
        if (ctx.get('timer') === undefined) {
          await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
        }
        await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
      }
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: composed.profile.patchPath,
        compose: composeLive,
      })
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: homePatchPath(),
        compose: composeLive,
      })
    } catch (error) {
      suppressShutdownError(ctx, signalShutdown.signal, error)
    }
  }
  return { ctx, shutdown }
}
