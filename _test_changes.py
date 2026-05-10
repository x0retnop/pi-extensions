import subprocess, json

cases = [
    ['python -c "print(1)"', 'C:/10x001/pi extensions/tests'],
    ['python -c "open(\\"C:/temp/x.txt\\",\\"w\\").write(\\"y\\")"', 'C:/10x001/pi extensions/tests'],
    ['node -e "require(\\"fs\\").writeFileSync(\\"C:/temp/x.txt\\",\\"y\\")"', 'C:/10x001/pi extensions/tests'],
    ['echo hello > file.txt', 'C:/10x001/pi extensions/tests'],
    ['echo hello > C:/temp/file.txt', 'C:/10x001/pi extensions/tests'],
    ['python -c "import os; os.remove(\\"C:/temp/x.txt\\")"', 'C:/10x001/pi extensions/tests'],
]

code = """
const jiti = require('jiti')();
const { decideBash } = jiti('./engine.ts');
const cases = %s;
for (const [cmd, cwd] of cases) {
  const d = decideBash(cmd, 'yolo', new Set(), cwd);
  console.log(JSON.stringify({cmd: cmd.substring(0,55), action: d.action, reason: d.reason}));
}
""" % json.dumps(cases)

r = subprocess.run(['node', '-e', code], capture_output=True, text=True, cwd='permission-gate')
for line in r.stdout.strip().split('\n'):
    if line.strip():
        d = json.loads(line)
        print(f"{d['cmd']:<58} => {d['action']:<6} {d.get('reason','')[:60]}")
if r.stderr:
    print('STDERR:', r.stderr)
