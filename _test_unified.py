import subprocess, json

cases = [
    ['echo hello > file.txt', 'C:/10x001/pi extensions/tests'],
    ['echo hello > C:/Windows/file.txt', 'C:/10x001/pi extensions/tests'],
    ['rm -rf /', 'C:/10x001/pi extensions/tests'],
    ['git status', 'C:/10x001/pi extensions/tests'],
    ['cp file ..\\..\\other', 'C:/10x001/pi extensions/tests'],
    ['cd "C:/10x001/pi extensions/tests" && echo hello > test.txt', 'C:/10x001/pi extensions/tests'],
]

code = """
const jiti = require('jiti')();
const { decideBash } = jiti('./engine.ts');
const cases = %s;
for (const [cmd, cwd] of cases) {
  const d = decideBash(cmd, 'relaxed', new Set(), cwd);
  console.log(JSON.stringify({cmd, action: d.action, reason: d.reason}));
}
""" % json.dumps(cases)

r = subprocess.run(['node', '-e', code], capture_output=True, text=True, cwd='permission-gate')
for line in r.stdout.strip().split('\n'):
    if line.strip():
        d = json.loads(line)
        print(f"{d['cmd']:<60} => {d['action']:<6} {d.get('reason','')[:60]}")
if r.stderr:
    print('STDERR:', r.stderr)
