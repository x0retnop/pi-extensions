import subprocess, json

code = """
const jiti = require('jiti')();
const { decide } = jiti('./engine.ts');
const cmd = 'cd "C:/10x001/pi extensions/tests" && echo "yolo-write" > test-yolo-dir/write-test.txt';
console.log(JSON.stringify(decide(cmd, 'yolo', new Set())));
"""
r = subprocess.run(['node', '-e', code], capture_output=True, text=True, cwd='permission-gate')
print('Our gate decision:', r.stdout.strip())
