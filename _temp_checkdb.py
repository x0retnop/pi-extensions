import json
with open('permission-gate/commanddb.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

for cmd in ['git', 'npm', 'rm', 'docker', 'python', 'node', 'cargo', 'ssh', 'curl', 'sudo', 'pip', 'pnpm', 'yarn']:
    if cmd not in data:
        print(f'MISSING: {cmd}')
        continue
    meta = data[cmd]
    print(f'{cmd}: risk={meta.get("defaultRisk")}, cats={meta.get("defaultCategories")}, subs={len(meta.get("subcommands", {}))}, aliases={meta.get("aliases", [])}')

print()
# Check some important subcommand structures
for cmd in ['git', 'npm']:
    print(f'\n--- {cmd} subcommands ---')
    for sc, scm in list(data[cmd]['subcommands'].items())[:8]:
        flags = list(scm.get('flags', {}).keys())
        print(f'  {sc}: risk={scm.get("risk")}, autoAllow={scm.get("autoAllowModes")}, flags={flags[:4]}')

# Check rm/delete commands
print('\n--- destructive commands ---')
for cmd in ['rm', 'del', 'erase', 'rmdir', 'format', 'diskpart']:
    if cmd in data:
        print(f'{cmd}: {data[cmd].get("defaultRisk")}, aliases={data[cmd].get("aliases")}')

# Check install commands
print('\n--- install commands ---')
for cmd in ['npm', 'pip', 'apt', 'brew', 'cargo', 'gem', 'composer']:
    if cmd in data and 'install' in data[cmd].get('subcommands', {}):
        print(f'{cmd} install: {data[cmd]["subcommands"]["install"].get("risk")}')
