import subprocess, json, sys

def test(cmds):
    code = """
const jiti = require('jiti')();
const { analyze, decide } = jiti('./engine.ts');
const cases = %s;
for (const cmd of cases) {
  const a = analyze(cmd);
  const d = decide(cmd, 'relaxed', new Set());
  console.log(JSON.stringify({cmd, risk: a.risk, cats: a.categories, action: d.action}));
}
""" % json.dumps(cmds)
    result = subprocess.run(['node', '-e', code], capture_output=True, text=True, cwd='permission-gate')
    for line in result.stdout.strip().split('\n'):
        if line.strip():
            print(line)
    if result.stderr:
        print('STDERR:', result.stderr, file=sys.stderr)

test([
    'echo $(rm -rf /)',
    'echo "normal"',
    'echo `ls`',
    'python -c "print(1)"',
    'npm run build',
])
