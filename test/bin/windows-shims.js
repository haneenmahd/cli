const t = require('tap')
const { spawnSync } = require('child_process')
const { resolve, join, extname, basename } = require('path')
const { readFileSync, chmodSync, readdirSync } = require('fs')
const Diff = require('diff')
const { sync: which } = require('which')
const { version } = require('../../package.json')

const ROOT = resolve(__dirname, '../..')
const BIN = join(ROOT, 'bin')
const NODE = readFileSync(process.execPath)
const SHIMS = readdirSync(BIN).reduce((acc, shim) => {
  if (extname(shim) !== '.js') {
    acc[shim] = readFileSync(join(BIN, shim), 'utf-8')
  }
  return acc
}, {})

const SHIM_EXTS = [...new Set(Object.keys(SHIMS).map(p => extname(p)))]

t.skip('shim contents', t => {
  // these scripts should be kept in sync so this tests the contents of each
  // and does a diff to ensure the only differences between them are necessary
  const diffFiles = (npm, npx) => Diff.diffChars(npm, npx)
    .filter(v => v.added || v.removed)
    .reduce((acc, v) => {
      if (v.value.length === 1) {
        acc.letters.add(v.value.toUpperCase())
      } else {
        acc.diff.push(v.value)
      }
      return acc
    }, { diff: [], letters: new Set() })

  t.plan(SHIM_EXTS.length)

  t.test('bash', t => {
    const { diff, letters } = diffFiles(SHIMS.npm, SHIMS.npx)
    t.match(diff[0].split('\n').reverse().join(''), /^NPX_CLI_JS=/, 'has NPX_CLI')
    t.equal(diff.length, 1)
    t.strictSame([...letters], ['M', 'X'], 'all other changes are m->x')
    t.end()
  })

  t.test('cmd', t => {
    const { diff, letters } = diffFiles(SHIMS['npm.cmd'], SHIMS['npx.cmd'])
    t.match(diff[0], /^SET "NPX_CLI_JS=/, 'has NPX_CLI')
    t.equal(diff.length, 1)
    t.strictSame([...letters], ['M', 'X'], 'all other changes are m->x')
    t.end()
  })
})

t.test('run shims', t => {
  const path = t.testdir({
    ...SHIMS,
    node: NODE,
    'node.exe': NODE,
    // simulate the state where one version of npm is installed
    // with node, but we should load the globally installed one
    'global-prefix': {
      node_modules: {
        npm: t.fixture('symlink', ROOT),
      },
    },
    // put in a shim that ONLY prints the intended global prefix,
    // and should not be used for anything else.
    node_modules: {
      npm: {
        bin: {
          'npx-cli.js': `throw new Error('this should not be called')`,
          'npm-cli.js': `
            const assert = require('assert')
            const { resolve } = require('path')
            assert.equal(process.argv.slice(2).join(' '), 'prefix -g')
            console.log(resolve(__dirname, '../../../global-prefix'))
          `,
        },
      },
    },
  })

  const spawnPath = (cmd, args, {log, ...opts} = {}) => {
    if (cmd.endsWith('bash.exe')) {
      // only cygwin *requires* the -l, but the others are ok with it
      args.unshift('-l')
    }
    if (log) {
      console.error(args[args.length - 1])
    }
    const result = spawnSync(cmd, args, {
      // don't hit the registry for the update check
      env: { PATH: path, npm_config_update_notifier: 'false' },
      cwd: path,
      windowsHide: true,
      ...opts,
    })
    if (log) {
      console.error(result.status)
      console.error(result.stdout?.toString()?.trim())
      console.error('----------------------------')
    }
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout?.toString()?.trim(),
      stderr: result.stderr?.toString()?.trim(),
    }
  }

  for (const shim of Object.keys(SHIMS)) {
    chmodSync(join(path, shim), 0o755)
  }

  const { ProgramFiles = '/', SystemRoot = '/', NYC_CONFIG, WINDOWS_SHIMS_TEST } = process.env
  const skipDefault = WINDOWS_SHIMS_TEST || process.platform === 'win32'
    ? null : 'test not relevant on platform'

  const shells = Object.entries({
    cmd: 'cmd',
    git: join(ProgramFiles, 'Git', 'bin', 'bash.exe'),
    'user git': join(ProgramFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    wsl: join(SystemRoot, 'System32', 'bash.exe'),
    cygwin: resolve(SystemRoot, '/', 'cygwin64', 'bin', 'bash.exe'),
  }).map(([name, cmd]) => {
    let skip = skipDefault
    const isBash = cmd.endsWith('bash.exe')
    const testName = `${name} ${isBash ? 'bash' : ''}`.trim()

    if (!skip) {
      if (isBash) {
        try {
          // If WSL is installed, it *has* a bash.exe, but it fails if
          // there is no distro installed, so we need to detect that.
          if (spawnPath(cmd, ['-c', 'exit 0']).status !== 0) {
            throw new Error('not installed')
          }
          if (cmd.includes('cygwin') && NYC_CONFIG) {
            throw new Error('does not play nicely with nyc')
          }
        } catch (err) {
          skip = err.message
        }
      } else {
        try {
          cmd = which(cmd)
        } catch {
          skip = 'not installed'
        }
      }
    }

    return {
      cmd,
      name: testName,
      skip: skip ? `${testName} - ${skip}` : null,
    }
  })

  const matchCmd = (t, cmd, bin) => {
    const args = []
    const opts = {}

    switch (basename(cmd).toLowerCase()) {
      case 'cmd.exe':
        cmd = `${bin}.cmd`
        break
      case 'bash.exe':
        args.push(bin)
        break
      default:
        throw new Error('unknown shell')
    }

    const isNpm = bin === 'npm'
    const result = spawnPath(cmd, [...args, isNpm ? 'help' : '--version'], opts)

    if (cmd.includes('bash.exe') && isNpm) {
      console.error({ cmd, args })
      spawnPath(cmd, ['-c', 'which node'], {log: true})
      spawnPath(cmd, ['-c', 'which npm'], {log: true})
      spawnPath(cmd, ['-c', 'echo $PATH'], {log: true})
      spawnPath(cmd, ['-c', 'pwd'], {log: true})
      console.error(result.stderr)
      console.error(result.stdout)
    }

    t.match(result, {
      status: 0,
      signal: null,
      stderr: '',
      stdout: isNpm ? `npm@${version} ${ROOT}` : version,
    }, `${cmd} ${bin}`)
  }

  // ensure that all tests are either run or skipped
  t.plan(shells.length)

  for (const { cmd, skip, name } of shells) {
    t.test(name, t => {
      if (skip) {
        if (WINDOWS_SHIMS_TEST) {
          t.fail(skip)
        } else {
          t.skip(skip)
        }
        return t.end()
      }
      t.plan(2)
      matchCmd(t, cmd, 'npm')
      matchCmd(t, cmd, 'npx')
    })
  }
})
