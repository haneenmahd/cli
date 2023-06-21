const t = require('tap')
const { spawnSync } = require('child_process')
const { resolve, join, extname, basename, sep } = require('path')
const { readFileSync, chmodSync, readdirSync } = require('fs')
const Diff = require('diff')
const { sync: which } = require('which')
const { version } = require('../../package.json')

const ROOT = resolve(__dirname, '../..')
const BIN = join(ROOT, 'bin')
const SHIMS = readdirSync(BIN).reduce((acc, shim) => {
  if (extname(shim) !== '.js') {
    acc[shim] = readFileSync(join(BIN, shim), 'utf-8')
  }
  return acc
}, {})

// windows requires each segment of a command path to be quoted when using shell: true
const quotePath = (cmd) => cmd
  .split(sep)
  .map(p => p.includes(' ') ? `"${p}"` : p)
  .join(sep)

t.test('shim contents', t => {
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

  t.plan(3)

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

  t.test('pwsh', t => {
    const { diff, letters } = diffFiles(SHIMS['npm.ps1'], SHIMS['npx.ps1'])
    t.equal(diff.length, 0)
    t.strictSame([...letters], ['M', 'X'], 'all other changes are m->x')
    t.end()
  })
})

t.test('run shims', t => {
  const path = t.testdir({
    ...SHIMS,
    'node.exe': readFileSync(process.execPath),
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
            const args = process.argv.slice(2)
            assert.equal(args[0], 'prefix')
            assert.equal(args[1], '-g')
            const { resolve } = require('path')
            console.log(resolve(__dirname, '../../../global-prefix'))
          `,
        },
      },
    },
  })

  for (const shim of Object.keys(SHIMS)) {
    chmodSync(join(path, shim), 0o755)
  }

  const { ProgramFiles = '/', SystemRoot = '/', NYC_CONFIG, WINDOWS_SHIMS_TEST } = process.env
  const skipDefault = WINDOWS_SHIMS_TEST || process.platform === 'win32'
    ? null : 'test not relevant on platform'

  const shells = Object.entries({
    cmd: 'cmd',
    pwsh: 'pwsh',
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
          if (spawnSync(cmd, ['-l', '-c', 'exit 0']).status !== 0) {
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
      case 'pwsh.exe':
        cmd = quotePath(cmd)
        args.push(`${bin}.ps1`)
        opts.shell = true
        break
      case 'bash.exe':
        // only cygwin *requires* the -l, but the others are ok with it
        args.push('-l', bin)
        break
      default:
        throw new Error('unknown shell')
    }

    const isNpm = bin === 'npm'
    const result = spawnSync(cmd, [...args, isNpm ? 'help' : '--version'], {
      // don't hit the registry for the update check
      env: { PATH: path, npm_config_update_notifier: 'false' },
      cwd: path,
      windowsHide: true,
      ...opts,
    })
    result.stdout = result.stdout?.toString()?.trim()
    result.stderr = result.stderr?.toString()?.trim()

    t.match(result, {
      status: 0,
      signal: null,
      stderr: '',
      stdout: isNpm ? `npm@${version} ${ROOT}` : version,
    }, 'command result')
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
