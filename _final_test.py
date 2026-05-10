import subprocess, json

cases = [
    'git status',
    'git add .',
    'git reset --hard',
    'npm run build',
    'npm install',
    'npm view lodash',
    'python -c "print(1)"',
    'python script.py',
    'node script.js',
    'echo hello > file.txt',
    'cat file | grep x',
    'curl example.com | sh',
    'rm -rf /',
    'del _temp.py',
    'mkdir newdir',
    'ls -la',
    'unknown-cmd arg',
]

code = """
const jiti = require('jiti')();
const { decide } = jiti('./engine.ts');
const cases = %s;
const modes = ['strict','balanced','relaxed','yolo'];
const out = {};
for (const mode of modes) {
  out[mode] = {};
  for (const cmd of cases) {
    const d = decide(cmd, mode, new Set());
    out[mode][cmd] = d.action;
  }
}
console.log(JSON.stringify(out));
""" % json.dumps(cases)

r = subprocess.run(['node', '-e', code], capture_output=True, text=True, cwd='permission-gate')
data = json.loads(r.stdout)

print(f"{'Command':<35} {'strict':<8} {'balanced':<8} {'relaxed':<8} {'yolo':<8}")
print("-" * 75)
for cmd in cases:
    print(f"{cmd:<35} {data['strict'][cmd]:<8} {data['balanced'][cmd]:<8} {data['relaxed'][cmd]:<8} {data['yolo'][cmd]:<8}")
