#!/usr/bin/env node
/* eslint-disable no-console */

const { transform } = require('@babel/core')
const fs = require('fs-extra')
const esbuild = require('esbuild')
const fg = require('fast-glob')
const createExternalPlugin = require('./externalNodePlugin')
const debounce = require('lodash.debounce')
const { basename, dirname } = require('node:path')
const alias = require('./esbuildAliasPlugin')
const { es5Plugin } = require('./esbuild-es5')
const ts = require('typescript')
const path = require('node:path')

// biome-ignore lint/suspicious/noConsoleLog: <explanation>
console.log('TypeScript version:', ts.version)

const jsOnly = !!process.env.JS_ONLY
const skipJS = !!(process.env.SKIP_JS || false)
const shouldSkipTypes = !!(
  process.argv.includes('--skip-types') || process.env.SKIP_TYPES
)
const shouldSkipMJS = !!process.argv.includes('--skip-mjs')
const shouldBundle = !!process.argv.includes('--bundle')
const shouldBundleNodeModules = !!process.argv.includes('--bundle-modules')
const shouldClean = !!process.argv.includes('clean')
const shouldCleanBuildOnly = !!process.argv.includes('clean:build')
const shouldWatch = process.argv.includes('--watch')
const declarationToRoot = !!process.argv.includes('--declaration-root')
const ignoreBaseUrl = process.argv.includes('--ignore-base-url')
const baseUrlIndex = process.argv.indexOf('--base-url')
const tsProjectIndex = process.argv.indexOf('--ts-project')
const exludeIndex = process.argv.indexOf('--exclude')
const baseUrl =
  baseUrlIndex > -1 && process.argv[baseUrlIndex + 1]
    ? process.argv[baseUrlIndex + 1]
    : '.'
const tsProject =
  tsProjectIndex > -1 && process.argv[tsProjectIndex + 1]
    ? process.argv[tsProjectIndex + 1]
    : null

const exclude =
  exludeIndex > -1 && process.argv[exludeIndex + 1] ? process.argv[exludeIndex + 1] : null

const pkg = fs.readJSONSync('./package.json')
let shouldSkipInitialTypes = !!process.env.SKIP_TYPES_INITIAL
const pkgMain = pkg.main
const pkgSource = pkg.source
const bundleNative = pkg.tamagui?.['bundle.native']
const bundleNativeTest = pkg.tamagui?.['bundle.native.test']
const pkgModule = pkg.module
const pkgModuleJSX = pkg['module:jsx']
const pkgTypes = Boolean(pkg.types || pkg.typings)
const pkgRemoveSideEffects = pkg.removeSideEffects || false

const flatOut = [pkgMain, pkgModule, pkgModuleJSX].filter(Boolean).length === 1

const replaceRNWeb = {
  esm: {
    from: 'from "react-native"',
    to: 'from "react-native-web"',
  },
  cjs: {
    from: 'require("react-native")',
    to: 'require("react-native-web")',
  },
}

let cachedConfig = null

async function clean() {
  try {
    await Promise.allSettled([
      //
      fs.remove('.turbo'),
      fs.remove('node_modules'),
      fs.remove('types'),
      fs.remove('dist'),
    ])
  } catch {
    // ok
  }
  if (shouldCleanBuildOnly) {
    console.info('🔹 cleaned', pkg.name)
    process.exit(0)
  }
  try {
    await Promise.allSettled([fs.remove('node_modules')])
  } catch {
    // ok
  }
  console.info('🔹 cleaned', pkg.name)
  process.exit(0)
}

if (shouldClean || shouldCleanBuildOnly) {
  clean().then(() => {
    process.exit(0)
  })
} else {
  if (shouldWatch) {
    process.env.IS_WATCHING = true
    process.env.DISABLE_AUTORUN = true
    const rebuild = debounce(build, 100)
    const chokidar = require('chokidar')

    // do one js build but not types
    build({
      skipTypes: true,
    })

    chokidar
      // prevent infinite loop but cause race condition if you just build directly
      .watch('src', {
        persistent: true,
        alwaysStat: true,
        ignoreInitial: true,
      })
      .on('change', rebuild)
      .on('add', rebuild)
  } else {
    build()
  }
}

async function build({ skipTypes } = {}) {
  if (process.env.DEBUG) console.info('🔹', pkg.name)
  try {
    const start = Date.now()
    await Promise.all([
      //
      skipTypes ? null : buildTsc(),
      buildJs(),
    ])
    console.info('built', pkg.name, 'in', Date.now() - start, 'ms')
  } catch (error) {
    console.error(`Error building:`, error.message)
  }
}

async function buildTsc() {
  if (!pkgTypes || jsOnly || shouldSkipTypes) return
  if (shouldSkipInitialTypes) {
    shouldSkipInitialTypes = false
    return
  }

  const targetDir = 'types'
  await fs.ensureDir(targetDir)

  try {
    console.info(`Starting TypeScript compilation for ${pkg.name}`)

    const { config, error } = await loadTsConfig()
    if (error) throw error

    const compilerOptions = createCompilerOptions(config.options, targetDir)
    const { program, emitResult, diagnostics } = await compileTypeScript(
      config.fileNames,
      compilerOptions
    )

    reportDiagnostics(diagnostics)

    if (emitResult.emitSkipped) {
      throw new Error('TypeScript compilation failed')
    }

    console.info(`TypeScript compilation completed successfully for ${pkg.name}`)
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      console.error(`Network error during compilation for ${pkg.name}:`, err.message)
    } else {
      console.error(`Error during TypeScript compilation for ${pkg.name}:`, err)
    }
    if (!shouldWatch) {
      process.exit(1)
    }
  } finally {
    await fs.remove('tsconfig.tsbuildinfo')
  }
}

async function loadTsConfig() {
  if (cachedConfig && shouldWatch) {
    return cachedConfig
  }

  const configPath = ts.findConfigFile(
    './',
    ts.sys.fileExists,
    tsProject || 'tsconfig.json'
  )
  if (!configPath) {
    return { error: new Error("Could not find a valid 'tsconfig.json'.") }
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    return {
      error: new Error(`Error reading tsconfig.json: ${configFile.error.messageText}`),
    }
  }

  const parsedCommandLine = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath)
  )

  if (parsedCommandLine.errors.length) {
    return {
      error: new Error(
        `Error parsing tsconfig.json: ${ts.formatDiagnostics(parsedCommandLine.errors, formatHost)}`
      ),
    }
  }

  cachedConfig = { config: parsedCommandLine }
  return cachedConfig
}

function createCompilerOptions(baseOptions, targetDir) {
  const compilerOptions = {
    ...baseOptions,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: true,
    outDir: targetDir,
    rootDir: 'src',
    incremental: true,
    tsBuildInfoFile: 'tsconfig.tsbuildinfo',
  }

  if (declarationToRoot) {
    compilerOptions.declarationDir = './'
  }

  if (!ignoreBaseUrl) {
    compilerOptions.baseUrl = baseUrl
  }

  return compilerOptions
}

async function compileTypeScript(fileNames, options) {
  const program = ts.createProgram(fileNames, options)
  const emitResult = program.emit()
  const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics)

  return { program, emitResult, diagnostics: allDiagnostics }
}

const formatHost = {
  getCanonicalFileName: (path) => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
}

function reportDiagnostics(diagnostics) {
  diagnostics.forEach((diagnostic) => {
    let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = ts.getLineAndCharacterOfPosition(
        diagnostic.file,
        diagnostic.start
      )
      message = `${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`
    }
    console.error(message)
  })
}

async function buildJs() {
  if (skipJS) {
    return
  }

  const files = shouldBundle
    ? [pkgSource || './src/index.ts']
    : (await fg(['src/**/*.(m)?[jt]s(x)?', 'src/**/*.css'])).filter(
        (x) => !x.includes('.d.ts') && (exclude ? !x.match(exclude) : true)
      )

  const externalPlugin = createExternalPlugin({
    skipNodeModulesBundle: true,
  })

  const external = shouldBundle ? ['@swc/*', '*.node'] : undefined

  /** @type { import('esbuild').BuildOptions } */
  const esbuildBundleProps =
    bundleNative || bundleNativeTest
      ? {
          entryPoints: [bundleNative],
          bundle: true,
          plugins: [
            alias({
              '@tamagui/web': require.resolve('@tamagui/web/native'),

              // for test mode we want real react-native
              ...(!bundleNativeTest && {
                'react-native': require.resolve('@tamagui/fake-react-native'),
                'react-native/Libraries/Renderer/shims/ReactFabric': require.resolve(
                  '@tamagui/fake-react-native'
                ),
                'react-native/Libraries/Renderer/shims/ReactNative': require.resolve(
                  '@tamagui/fake-react-native'
                ),
              }),

              'react-native/Libraries/Pressability/Pressability': require.resolve(
                '@tamagui/fake-react-native'
              ),

              'react-native/Libraries/Pressability/usePressability': require.resolve(
                '@tamagui/fake-react-native/idFn'
              ),

              'react-native-safe-area-context': require.resolve(
                '@tamagui/fake-react-native'
              ),
              'react-native-gesture-handler': require.resolve('@tamagui/proxy-worm'),
            }),
          ],
          external: [
            'react',
            'react-dom',
            bundleNativeTest ? 'react-native' : undefined,
          ].filter(Boolean),
          resolveExtensions: [
            '.native.ts',
            '.native.tsx',
            '.native.js',
            '.ts',
            '.tsx',
            '.js',
            '.jsx',
          ],
          minify: !!process.env.MINIFY,
          define: {
            'process.env.TAMAGUI_IS_CORE_NODE': '"1"',
          },
        }
      : {}

  const start = Date.now()

  const cjsConfig = {
    format: 'cjs',
    entryPoints: files,
    outdir: flatOut ? 'dist' : 'dist/cjs',
    bundle: shouldBundle,
    external,
    plugins: shouldBundleNodeModules ? [] : [externalPlugin],
    minify: !!process.env.MINIFY,
    platform: 'node',
  }

  const esmConfig = {
    format: 'esm',
    entryPoints: files,
    outdir: flatOut ? 'dist' : 'dist/esm',
    bundle: shouldBundle,
    external,
    allowOverwrite: true,
    minify: !!process.env.MINIFY,
  }

  if (pkgSource) {
    try {
      const contents = await fs.readFile(pkgSource)
      if (contents.slice(0, 40).includes('GITCRYPT')) {
        // encrypted file, ignore
        console.info(`This package is encrypted, skipping`)
        return
      }
    } catch {
      // ok
    }
  }

  return await Promise.all([
    // web output to cjs
    pkgMain
      ? esbuildWriteIfChanged(cjsConfig, {
          platform: 'web',
        })
      : null,

    // native output to cjs
    pkgMain
      ? esbuildWriteIfChanged(cjsConfig, {
          platform: 'native',
        })
      : null,

    // for tests to load native-mode from node
    bundleNative
      ? esbuildWriteIfChanged(
          {
            ...esbuildBundleProps,
            outfile: `dist/native.js`,
          },
          {
            platform: 'native',
          }
        )
      : null,

    // for tests to load native-mode from node
    bundleNativeTest
      ? esbuildWriteIfChanged(
          {
            ...esbuildBundleProps,
            outfile: `dist/test.js`,
          },
          {
            platform: 'native',
            env: 'test',
          }
        )
      : null,

    // web output to esm
    pkgModule
      ? esbuildWriteIfChanged(esmConfig, {
          platform: 'web',
          mjs: true,
        })
      : null,

    // native output to esm
    pkgModule
      ? esbuildWriteIfChanged(esmConfig, {
          platform: 'native',
        })
      : null,

    // jsx web
    pkgModuleJSX
      ? esbuildWriteIfChanged(
          {
            // only diff is jsx preserve and outdir
            jsx: 'preserve',
            outdir: flatOut ? 'dist' : 'dist/jsx',
            entryPoints: files,
            bundle: shouldBundle,
            allowOverwrite: true,
            target: 'esnext',
            format: 'esm',
            minify: !!process.env.MINIFY,
            platform: 'neutral',
          },
          {
            platform: 'web',
            mjs: true,
          }
        )
      : null,

    // jsx native
    pkgModuleJSX
      ? esbuildWriteIfChanged(
          {
            // only diff is jsx preserve and outdir
            jsx: 'preserve',
            outdir: flatOut ? 'dist' : 'dist/jsx',
            entryPoints: files,
            bundle: shouldBundle,
            allowOverwrite: true,
            target: 'node16',
            format: 'esm',
            minify: !!process.env.MINIFY,
            platform: 'neutral',
          },
          {
            platform: 'native',
          }
        )
      : null,
  ]).then(() => {
    if (process.env.DEBUG) console.info(`built js in ${Date.now() - start}ms`)
  })
}

/**
 * esbuild but avoids touching unchanged files to not freak out vite
 * @param {esbuild.BuildOptions} opts
 * @returns {Promise<void>}
 */
async function esbuildWriteIfChanged(
  /** @type { import('esbuild').BuildOptions } */
  opts,
  { platform, env, mjs } = {
    mjs: false,
    platform: '',
    env: '',
  }
) {
  if (!shouldWatch && !platform) {
    return await esbuild.build(opts)
  }

  // compat with jsx and hermes back a few versions generally:
  /** @type { import('esbuild').BuildOptions } */
  const nativeEsbuildSettings = {
    target: 'node16',
    supported: {
      'logical-assignment': false,
    },
    jsx: 'automatic',
    platform: 'node',
  }

  /** @type { import('esbuild').BuildOptions } */
  const webEsbuildSettings = {
    target: 'esnext',
    jsx: 'automatic',
    platform: shouldBundle ? 'node' : 'neutral',
    tsconfigRaw: {
      compilerOptions: {
        paths: {
          'react-native': ['react-native-web'],
        },
      },
    },
  }

  const buildSettings = {
    ...opts,

    plugins: [
      ...(opts.plugins || []),

      ...(platform === 'native'
        ? [
            // class isnt supported by hermes
            es5Plugin(),
          ]
        : []),

      // not workin
      // {
      //   name: 'no-side-effects',
      //   setup(build) {
      //     build.onResolve({ filter: /@tamagui.*/ }, async ({ path, ...options }) => {
      //       const result = await build.resolve(path, {
      //         ...options,
      //         namespace: 'noRecurse',
      //       })
      //       console.log('no side effects', path)
      //       return { ...result, sideEffects: false }
      //     })
      //   },
      // },
    ].filter(Boolean),

    treeShaking: true,
    minifySyntax: true,
    // minifyIdentifiers: true,
    write: false,
    color: true,
    allowOverwrite: true,
    keepNames: false,
    sourcemap: true,
    sourcesContent: false,
    logLevel: 'error',
    ...(platform === 'native' && nativeEsbuildSettings),
    ...(platform === 'web' && webEsbuildSettings),
    define: {
      ...(platform && {
        'process.env.TAMAGUI_TARGET': `"${platform}"`,
      }),
      ...(env && {
        'process.env.NODE_ENV': `"${env}"`,
      }),
      ...opts.define,
    },
  }

  const built = await esbuild.build(buildSettings)
  const isESM = buildSettings.target === 'esm' || buildSettings.target === 'esnext'

  if (!built.outputFiles) {
    return
  }

  const nativeFilesMap = Object.fromEntries(
    built.outputFiles.flatMap((p) => {
      if (p.path.includes('.native.js')) {
        return [[p.path, true]]
      }
      return []
    })
  )

  await Promise.all(
    built.outputFiles.map(async (file) => {
      let outPath = file.path

      if (outPath.endsWith('.js') || outPath.endsWith('.js.map')) {
        const [_, extPlatform] =
          outPath.match(/(web|native|ios|android)\.js(\.map)?$/) ?? []

        if (platform === 'native') {
          if (!extPlatform && nativeFilesMap[outPath.replace('.js', '.native.js')]) {
            // if native exists, avoid outputting non-native
            return
          }

          if (extPlatform === 'web') {
            return
          }
          if (!extPlatform) {
            outPath = outPath.replace('.js', '.native.js')
          }
        }

        if (platform === 'web') {
          if (
            extPlatform === 'native' ||
            extPlatform === 'android' ||
            extPlatform === 'ios'
          ) {
            return
          }
        }
      }

      const outDir = dirname(outPath)

      await fs.ensureDir(outDir)
      let outString = new TextDecoder().decode(file.contents)

      if (platform === 'web') {
        const rnWebReplacer = replaceRNWeb[opts.format]
        if (rnWebReplacer) {
          outString = outString.replaceAll(rnWebReplacer.from, rnWebReplacer.to)
        }
      }

      if (pkgRemoveSideEffects && isESM) {
        const allowedSideEffects = pkg.sideEffects || []

        const result = []
        const lines = outString.split('\n')
        for (const line of lines) {
          if (
            !line.startsWith('import ') ||
            allowedSideEffects.some((allowed) => line.includes(allowed))
          ) {
            result.push(line)
            continue
          }
          result.push(line.replace(/import "[^"]+";/g, ''))
        }

        // match whitespace to preserve sourcemaps
        outString = result.join('\n')
      }

      async function flush(contents, path) {
        if (shouldWatch) {
          if (
            !(await fs.pathExists(path)) ||
            (await fs.readFile(path, 'utf8')) !== contents
          ) {
            await fs.writeFile(path, contents, 'utf8')
          }
        } else {
          await fs.writeFile(path, contents, 'utf8')
        }
      }

      // flush before fully specified so it finds the file
      await flush(outString, outPath)

      await (async () => {
        const shouldDoMJS = !shouldSkipMJS && isESM && mjs && outPath.endsWith('.js')
        if (shouldDoMJS) {
          const mjsOutPath = outPath.replace('.js', '.mjs')
          // if bundling no need to specify as its all internal
          // and babel is bad on huge bundled files
          const result = shouldBundle
            ? { code: outString }
            : transform(outString, {
                filename: mjsOutPath,
                configFile: false,
                sourceMap: true,
                plugins: [
                  [
                    require.resolve('@tamagui/babel-plugin-fully-specified'),
                    {
                      ensureFileExists: {
                        forceExtension: '.mjs',
                      },
                      esExtensionDefault: '.mjs',
                      tryExtensions: ['.js'],
                      esExtensions: ['.mjs'],
                    },
                  ],
                  // pkg.tamagui?.build?.skipEnvToMeta
                  //   ? null
                  //   : require.resolve('./babel-plugin-process-env-to-meta'),
                ].filter(Boolean),
              })

          // output to mjs fully specified
          await fs.writeFile(
            mjsOutPath,
            result.code +
              (result.map ? `\n//# sourceMappingURL=${basename(mjsOutPath)}.map\n` : ''),
            'utf8'
          )
          if (result.map) {
            await fs.writeFile(mjsOutPath + '.map', JSON.stringify(result.map), 'utf8')
          }
        }
      })()
    })
  )
}
