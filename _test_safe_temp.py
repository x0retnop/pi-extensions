import subprocess, json

code = """
const jiti = require('jiti')();
const { decideBash } = jiti('./engine.ts');
const cases = [
  'rm _temp.py',
  'cd "C:/proj" && rm _temp.py',
  'cd "C:/10x001/pi extensions/tests" && rm _temp.py',
  'rm ./subdir/_temp.py',
];
for (const cmd of cases) {
  const d = decideBash(cmd, 'relaxed', new Set(), 'C:/10x001/pi extensions/tests');
  console.log(JSON.stringify({cmd, action: d.action}));
}
"""
r = subprocess.run(['node', '-e', code], capture_output=True, text=True, cwd='permission-gate')
for line in r.stdout.strip().split('\n'):
    if line.strip():
        d = json.loads(line)
        print(f"{d['cmd']:<55} => {d['action']}")
